// Edge cases of the rotation: the 5-hour window, accounts that can no longer carry the baton, outages, sessions stuck
// on the previous account, a state file that cannot be read.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { retryAfterOf } from '../src/api.mjs';
import { Rodizio } from '../src/core.mjs';
import { FIVE_HOUR_WAIT_S, MAX_SWITCHES_PER_HOUR, SWITCH_GAP_S, decide } from '../src/decide.mjs';
import { forecast } from '../src/insights.mjs';
import { MAIN_SERVICE, serviceForDir } from '../src/keychain.mjs';
import { DEFAULT_CONFIG, backupPath, emptyState } from '../src/state.mjs';
import { recordSample } from '../src/statusline.mjs';
import { A, B, C, HOUR, T0, connect, putMain, sessionWrite, setup } from './helpers.mjs';

const NOW = 1_800_000_000;
const cfg = (extra = {}) => ({ ...DEFAULT_CONFIG, order: [], ...extra });
const acc = (id, w, f, extra = {}) => ({
  id,
  addedAt: extra.addedAt ?? 0,
  plan: { multiplier: extra.mult ?? 5 },
  usage: { weekly: w === null ? null : { pct: w, resetsAt: extra.wReset ?? NOW + 3 * 24 * HOUR }, fiveHour: f === null ? null : { pct: f, resetsAt: extra.fReset ?? NOW + 2 * HOUR } },
  ...extra,
});
const state = (active, accounts, extra = {}) => ({ ...emptyState(), active, lastSwitchAt: NOW - 3600, accounts: Object.fromEntries(accounts.map((a) => [a.id, a])), ...extra });
const tokenOf = async (env, service) => (await env.kc.read(service))?.claudeAiOauth?.accessToken;

// ------------------------------------------------------------------------------------------- decide: 5 hours

test('the 5-hour zone hands the baton to an account with room in both windows', () => {
  const s = state('a', [acc('a', 40, 96, { mult: 20 }), acc('b', 10, 97, { addedAt: 1 }), acc('c', 20, 5, { addedAt: 2 })]);
  const d = decide(s, cfg(), NOW);
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'c', 'b has no room in its own 5-hour window');
  assert.equal(d.window, 'fiveHour');
  assert.match(d.reason, /faltavam 4% da janela de 5 h/);
});

test('a 5-hour window about to reset is waited out, unless it is already blocking', () => {
  const soon = NOW + FIVE_HOUR_WAIT_S - 30;
  assert.deepEqual(decide(state('a', [acc('a', 40, 97, { fReset: soon }), acc('b', 10, 0)]), cfg(), NOW), { kind: 'wait', until: soon });
  assert.equal(decide(state('a', [acc('a', 40, 100, { fReset: soon }), acc('b', 10, 0)]), cfg(), NOW).kind, 'switch');
});

test('the week decides first, and the 5-hour window can be left out or given its own margin', () => {
  assert.equal(decide(state('a', [acc('a', 96, 99), acc('b', 10, 0)]), cfg(), NOW).window, 'weekly');
  assert.equal(decide(state('a', [acc('a', 40, 99), acc('b', 10, 0)]), cfg({ fiveHourSwitch: false }), NOW).kind, 'none');
  assert.equal(decide(state('a', [acc('a', 40, 91), acc('b', 10, 0)]), cfg({ fiveHourRemainingPct: 10 }), NOW).window, 'fiveHour');
  assert.equal(decide(state('a', [acc('a', 40, 89), acc('b', 10, 0)]), cfg({ fiveHourRemainingPct: 10 }), NOW).kind, 'none');
});

test('going back to the preferred account needs room in its 5-hour window too', () => {
  const back = (f, fReset) => decide(state('b', [acc('a', 30, f, { mult: 20, fReset }), acc('b', 10, 20, { addedAt: 1 })], { lastSwitchAt: 0 }), cfg(), NOW);
  assert.equal(back(90).kind, 'none');
  assert.equal(back(90, NOW - 1).to, 'a', 'its 5-hour window reset');
});

test('an account in use that is taken out of the queue, or whose login was refused, passes the baton on', () => {
  assert.match(decide(state('a', [acc('a', 10, 0, { paused: true }), acc('b', 10, 0)]), cfg(), NOW).reason, /saiu da fila/);
  assert.match(decide(state('a', [acc('a', 10, 0, { needsLogin: true }), acc('b', 10, 0)]), cfg(), NOW).reason, /login dela foi recusado/);
});

test('too many automatic switches in an hour: hold, keeping what it would have done', () => {
  const autoSwitches = Array.from({ length: MAX_SWITCHES_PER_HOUR }, (_, i) => NOW - 3000 + i * 60);
  const d = decide(state('a', [acc('a', 96, 0), acc('b', 10, 0)], { autoSwitches, lastSwitchAt: NOW - SWITCH_GAP_S }), cfg(), NOW);
  assert.equal(d.kind, 'throttled');
  assert.equal(d.pending.to, 'b');
  // and nothing is held when nothing would happen
  assert.equal(decide(state('a', [acc('a', 10, 0), acc('b', 10, 0)], { autoSwitches }), cfg(), NOW).kind, 'none');
});

// ----------------------------------------------------------------------------------------- the agent: 5 hours

async function rotation(config) {
  const env = setup({ config });
  await putMain(env, 'ta-live', A);
  const a = await connect(env, A);
  const b = await connect(env, B);
  const c = await connect(env, C);
  await env.core.tick();
  return { env, a, b, c };
}

const rl = (w, wReset, f, fReset) => ({ seven_day: { used_percentage: w, resets_at: wReset }, five_hour: { used_percentage: f, resets_at: fReset } });

test('the 5-hour window of the 20x fills up: a 5x covers until it resets, then the baton comes back', async () => {
  const { env, a, b } = await rotation({ useApi: false });
  fs.mkdirSync(env.p.samples, { recursive: true });
  const wReset = T0 + 4 * 24 * HOUR;
  const fReset = T0 + 3 * HOUR;
  env.clock.t = T0 + 600;
  recordSample(env.p, { session_id: 's1', rate_limits: rl(40, wReset, 96, fReset) }, env.clock.t);
  await env.core.tick();
  assert.equal(env.core.state.active, b.id);
  assert.match(env.core.state.events[0].text, /janela de 5 h/);
  assert.equal(env.core.state.events[0].window, 'fiveHour');

  env.clock.t = fReset + 20 * 60; // the 20x's window has reset, and the return gap has passed
  await env.core.tick();
  assert.equal(env.core.state.active, a.id);
});

// ------------------------------------------------------------------------------------- the agent: connection

test('a refused login of the account in use passes the baton on, but only when the endpoint is proven to work', async () => {
  const { env, a, b } = await rotation();
  // nothing answered lately: a 401 could be the endpoint itself
  env.core.apiOkAt = {};
  env.api.failUsage.set(A.uuid, { status: 401 });
  env.api.failUsage.set(B.uuid, { status: 401 });
  env.api.failUsage.set(C.uuid, { status: 401 });
  env.clock.t += 600;
  await env.core.refresh();
  assert.equal(env.core.state.accounts[a.id].needsLogin, false);

  // another account answers: A's refusal is real
  env.api.failUsage.delete(B.uuid);
  env.api.failUsage.delete(C.uuid);
  env.clock.t += 600;
  await env.core.refresh();
  await env.core.refresh();
  assert.equal(env.core.state.accounts[a.id].needsLogin, true);
  await env.core.tick();
  assert.equal(env.core.state.active, b.id);
  assert.equal(await tokenOf(env, MAIN_SERVICE), B.token);
});

test('no answer from the API backs off, doubling; an answer resets it; a 429 waits what it was told', async () => {
  const { env, b } = await rotation();
  const accB = env.core.state.accounts[b.id];
  env.api.failUsage.set(B.uuid, { status: 0 });
  const waits = [];
  for (let i = 0; i < 3; i++) {
    await env.core.refresh();
    waits.push(accB.apiBackoffUntil - env.clock.t);
  }
  assert.deepEqual(waits, [60, 120, 240]);
  env.api.failUsage.delete(B.uuid);
  await env.core.refresh();
  assert.equal(accB.apiFailures, 0);
  env.api.failUsage.set(B.uuid, { status: 429, retryAfter: 1234 });
  await env.core.refresh();
  assert.equal(accB.apiBackoffUntil - env.clock.t, 1234);
  assert.equal(retryAfterOf('120'), 120);
  assert.equal(retryAfterOf(new Date(Date.UTC(2030, 0, 1, 0, 1)).toUTCString(), Date.UTC(2030, 0, 1)), 60);
  assert.equal(retryAfterOf(null), null);
});

test('switching works with the network down: it is all in the Keychain', async () => {
  const { env, b } = await rotation();
  env.api.profile = async () => ({ status: 0 });
  env.api.usage = async () => ({ status: 0 });
  await env.core.switchTo(b.id, 'teste');
  assert.equal(await tokenOf(env, MAIN_SERVICE), B.token);
});

// --------------------------------------------------------------------------------------- the agent: sessions

test('a session still answering from the previous account after a switch is reported once; the new account is confirmed', async () => {
  const { env, a, b } = await rotation({ useApi: false });
  const aReset = T0 + 2 * 24 * HOUR;
  const bReset = T0 + 5 * 24 * HOUR;
  env.core.state.accounts[a.id].usage = { weekly: { pct: 50, resetsAt: aReset }, fiveHour: null, at: T0, source: 'api' };
  env.core.state.accounts[b.id].usage = { weekly: { pct: 10, resetsAt: bReset }, fiveHour: null, at: T0, source: 'api' };
  await env.core.switchTo(b.id, 'teste');
  const at = env.clock.t;
  fs.mkdirSync(env.p.samples, { recursive: true });
  recordSample(env.p, { session_id: 'old', rate_limits: rl(51, aReset, 10, at + HOUR) }, at + 60);
  env.clock.t = at + 70;
  env.core.ingestSamples();
  assert.equal(env.core.state.events.filter((e) => /ainda responde/.test(e.text)).length, 0, 'not yet: give it a few minutes');
  recordSample(env.p, { session_id: 'old', rate_limits: rl(52, aReset, 11, at + HOUR) }, at + 240);
  env.clock.t = at + 250;
  env.core.ingestSamples();
  recordSample(env.p, { session_id: 'old', rate_limits: rl(53, aReset, 12, at + HOUR) }, at + 300);
  env.clock.t = at + 310;
  env.core.ingestSamples();
  assert.equal(env.core.state.events.filter((e) => /ainda responde/.test(e.text)).length, 1);
  assert.equal(env.core.view().handover.stuck, true);
  assert.equal(env.core.state.accounts[b.id].usage.weekly.pct, 10, 'the old account numbers are not credited to the new one');

  recordSample(env.p, { session_id: 'new', rate_limits: rl(11, bReset, 3, at + 4 * HOUR) }, at + 320);
  env.clock.t = at + 330;
  env.core.ingestSamples();
  assert.equal(env.core.view().handover.confirmed, true);
});

// ----------------------------------------------------------------------------------------- the agent: state

test('an unreadable state file never loses the accounts: backup first, then the account folders', async () => {
  const { env, a, b } = await rotation();
  env.core.backupAt = 0;
  env.core.state.events.push({ at: 1, kind: 'info', text: 'marca' });
  env.core.save();
  assert.ok(fs.existsSync(backupPath(env.p)));
  const make = () => new Rodizio({ paths: env.p, config: env.core.config, kc: env.kc, api: env.api, cli: env.cli, claudeJson: env.claudeJson, clock: () => env.clock.t, log: { info() {}, error() {} } });

  fs.writeFileSync(env.p.state, '{"accounts": {');
  let core = make();
  assert.deepEqual(Object.keys(core.state.accounts).sort(), Object.keys(env.core.state.accounts).sort());
  assert.match(core.state.events[0].text, /recuperei a cópia de segurança/);
  assert.ok(fs.readdirSync(env.p.home).some((f) => f.startsWith('state.json.ilegivel-')));

  fs.rmSync(backupPath(env.p));
  fs.writeFileSync(env.p.state, 'lixo');
  core = make();
  assert.equal(Object.keys(core.state.accounts).length, 3);
  assert.equal(core.state.accounts[a.id].email, A.email);
  assert.match(core.state.events[0].text, /remontei 3 conta/);
  // and it keeps working: who is in Claude Code is looked at again, and B still switches in
  await core.tick();
  assert.equal(core.state.active, a.id);
  await core.switchTo(b.id, 'teste');
  assert.equal(await tokenOf(env, MAIN_SERVICE), B.token);
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-live');
});

// ------------------------------------------------------------------------------------------- forecast: 5 hours

test('forecast: 5x stints cover the 20x while its 5-hour window resets, and a gap shows when they cannot', () => {
  const unstarted = { pct: 0, resetsAt: null, unstarted: true };
  const make = (n) => {
    const s = state('a', [acc('a', 30, 80, { mult: 20, fReset: NOW + 3 * HOUR }), ...['b', 'c'].slice(0, n).map((id, i) => acc(id, 10, 0, { addedAt: i + 1 }))]);
    for (const id of ['b', 'c'].slice(0, n)) s.accounts[id].usage.fiveHour = { ...unstarted };
    return s;
  };
  // The 20x spends 20% of its 5-hour window per hour (0.8 Max-5x units/h): it reaches 95% in 45 min, and its window
  // resets at +3 h. At that pace a 5x (a quarter of the 20x) fills its own window in 71.25 min.
  const two = forecast(make(2), cfg(), NOW, { week: 0.05, fiveHour: 0.8 }, NOW + 4 * HOUR);
  assert.deepEqual(two.segments.map((x) => x.id), ['a', 'b', 'c', 'a']);
  assert.equal(two.segments[0].to, NOW + 45 * 60);
  assert.equal(two.segments[1].to, NOW + 45 * 60 + 71.25 * 60);
  assert.equal(two.segments[2].to, NOW + 3 * HOUR, 'the 20x is back the moment its window resets');
  assert.equal(two.gapAt, null);

  const one = forecast(make(1), cfg(), NOW, { week: 0.05, fiveHour: 0.8 }, NOW + 4 * HOUR);
  assert.deepEqual(one.segments.map((x) => x.id), ['a', 'b', null, 'a']);
  assert.equal(one.gapAt, NOW + 45 * 60 + 71.25 * 60);
  assert.equal(one.gapUntil, NOW + 3 * HOUR);
});

test('a moment when the endpoint refuses everyone flags nobody, and readings resume after it', async () => {
  const { env, a, b, c } = await rotation();
  await env.core.refresh(); // everybody answered once
  for (const w of [A, B, C]) env.api.failUsage.set(w.uuid, { status: 401 });
  for (let i = 0; i < 4; i++) {
    env.clock.t += 130;
    await env.core.refresh();
  }
  for (const x of [a, b, c]) assert.equal(env.core.state.accounts[x.id].needsLogin, false, x.email);
  env.api.failUsage.clear();
  env.clock.t += 130;
  await env.core.refresh();
  assert.equal(env.core.state.accounts[b.id].apiStatus, 200);
});

test('a refused login switched away from is not put back by the return to the preferred account', async () => {
  const { env, a, b } = await rotation({ pollParked: false });
  env.api.failUsage.set(A.uuid, { status: 401 });
  await env.core.refresh();
  env.clock.t += 130;
  await env.core.refresh();
  assert.equal(env.core.state.accounts[a.id].needsLogin, true);
  await env.core.tick();
  assert.equal(env.core.state.active, b.id);
  for (let i = 0; i < 12; i++) {
    env.clock.t += 600;
    await env.core.tick();
  }
  assert.equal(env.core.state.active, b.id, 'the dead login stays out');
  assert.equal(env.core.state.accounts[a.id].needsLogin, true);
});

test('a profile endpoint that fails is asked again with backoff, honoring Retry-After', async () => {
  const { env } = await rotation();
  let calls = 0;
  env.api.profile = async () => (calls++, { status: 429, retryAfter: 600 });
  await sessionWrite(env, 'ta-unknown', A);
  for (let i = 0; i < 60; i++) {
    env.clock.t += 10;
    await env.core.tick();
  }
  assert.ok(calls <= 2, `${calls} calls in 10 minutes`);
});

// --------------------------------------------------------------------------------------- realtime scheduling

test('the agent wakes at the next moment that matters, and reads the account in use more often near a zone', async () => {
  const { env, a } = await rotation();
  const acc = env.core.state.accounts[a.id];
  acc.usage = { weekly: { pct: 50, resetsAt: env.clock.t + 3 * 24 * HOUR }, fiveHour: { pct: 40, resetsAt: env.clock.t + 1800 }, at: env.clock.t, source: 'api' };
  assert.equal(env.core.pollEvery(acc, true), 120);
  acc.usage.fiveHour.pct = 88; // within 10 points of the 5-hour zone
  assert.equal(env.core.pollEvery(acc, true), 45);
  assert.equal(env.core.pollEvery(acc, false), 900);
  const wake = env.core.nextWakeAt();
  assert.ok(wake > env.clock.t && wake <= env.clock.t + 1801, 'no later than the 5-hour reset');
});

test('the scheduler runs one pass at a time, folds bursts of nudges, and stops after the pass in progress', async () => {
  const { scheduler } = await import('../src/main.mjs');
  let passes = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const fake = {
    async tick() {
      passes++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
    },
    nextWakeAt: () => null,
  };
  const s = scheduler(fake, { tickMs: 10_000, nudgeMs: 10 });
  s.start();
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 20; i++) s.nudge();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(maxInFlight, 1);
  assert.ok(passes >= 2 && passes <= 3, `${passes} passes for 20 nudges`);
  s.nudge();
  await new Promise((r) => setTimeout(r, 15));
  await s.stop();
  assert.equal(inFlight, 0, 'stop waited for the pass in progress');
  const after = passes;
  s.nudge();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(passes, after, 'nothing runs after stop');
});

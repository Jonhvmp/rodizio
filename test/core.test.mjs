import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tokenHash } from '../src/blob.mjs';
import { SAMPLE_GRACE_S } from '../src/core.mjs';
import { MAIN_SERVICE, serviceForDir } from '../src/keychain.mjs';
import { recordSample } from '../src/statusline.mjs';
import { A, B, C, HOUR, T0, UNIX_MODES, connect, login, putMain, sessionWrite, setup, waitJob } from './helpers.mjs';

const tokenOf = async (env, service) => (await env.kc.read(service))?.claudeAiOauth?.accessToken;
const weekly = (pct, resetsAt = T0 + 3 * 24 * HOUR) => ({ weekly: { pct, resetsAt }, fiveHour: null });

/** A in Claude Code (and adopted), B and C connected and parked. */
async function rotation(config) {
  const env = setup({ config });
  await putMain(env, 'ta-live', A);
  const a = await connect(env, A);
  const b = await connect(env, B);
  const c = await connect(env, C);
  await env.core.tick();
  return { env, a, b, c };
}

test('adopts the login already in Claude Code once that account is connected', async () => {
  const env = setup();
  await putMain(env, 'ta-live', A);
  await env.core.tick();
  assert.equal(env.core.state.active, null);
  const a = await connect(env, A);
  await env.core.tick();
  assert.equal(env.core.state.active, a.id);
  // the live token is mirrored into the account's own item
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-live');
  assert.equal(a.plan.label, 'Max 20x');
});

test('switches at the threshold, keeps the MCP logins and updates ~/.claude.json', async () => {
  const { env, a, b } = await rotation();
  env.api.usageByUuid.set(A.uuid, weekly(96));
  env.api.usageByUuid.set(B.uuid, weekly(10));
  await env.core.refresh();
  env.clock.t += 600;
  await env.core.tick();

  assert.equal(env.core.state.active, b.id);
  assert.equal(env.core.state.pinned, false);
  const main = await env.kc.read(MAIN_SERVICE);
  assert.equal(main.claudeAiOauth.accessToken, B.token);
  assert.deepEqual(main.mcpOAuth, { github: { token: 'mcp-secret' } });
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-live');
  const cj = JSON.parse(fs.readFileSync(env.claudeJson, 'utf8'));
  assert.equal(cj.oauthAccount.emailAddress, B.email);
  assert.equal(cj.numStartups, 7);
  if (UNIX_MODES) assert.equal(fs.statSync(env.claudeJson).mode & 0o777, 0o600);
  assert.match(env.core.state.events[0].text, /Troquei de a@exemplo.com \(96%\) para b@exemplo.com \(10%\)/);
  assert.equal(env.notes.length, 1);
});

test('mirrors a token the sessions refreshed for the account in use', async () => {
  const { env, a } = await rotation();
  await putMain(env, 'ta-refreshed', A);
  await env.core.tick();
  assert.equal(env.core.state.active, a.id);
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-refreshed');
});

test('redoes the switch when a session writes the old login back right after it', async () => {
  const { env, a, b } = await rotation();
  await env.core.switchTo(b.id, 'teste');
  env.clock.t += 5;
  await sessionWrite(env, 'ta-refreshed-late', A); // a session refreshed A and wrote it over B
  await env.core.tick();
  assert.equal(await tokenOf(env, MAIN_SERVICE), 'ta-refreshed-late', 'confirmed on a second pass first');
  env.clock.t += 10;
  await env.core.tick();

  assert.equal(env.core.state.active, b.id);
  assert.equal(await tokenOf(env, MAIN_SERVICE), B.token);
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-refreshed-late');
  assert.match(env.core.state.events[0].text, /refiz a troca/);
});

test('two quick switches: a late write of the first account still gets undone', async () => {
  const { env, a, b, c } = await rotation();
  await env.core.switchTo(b.id, 'teste');
  env.clock.t += 20;
  await env.core.switchTo(c.id, 'teste');
  env.clock.t += 5;
  await sessionWrite(env, 'ta-very-late', A);
  await env.core.tick();
  env.clock.t += 10;
  await env.core.tick();
  assert.equal(env.core.state.active, c.id);
  assert.equal(await tokenOf(env, MAIN_SERVICE), C.token);
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-very-late');
  assert.equal(await tokenOf(env, serviceForDir(b.dir)), B.token);
});

test('accepts a manual /login into another connected account', async () => {
  const { env, c } = await rotation();
  env.clock.t += 600;
  await putMain(env, 'tc-manual', C);
  await env.core.tick();
  assert.equal(env.core.state.active, c.id);
  assert.equal(await tokenOf(env, serviceForDir(c.dir)), 'tc-manual');
  assert.match(env.core.state.events[0].text, /por fora do rodízio/);
});

test('never overwrites a login that is not in the rotation', async () => {
  const env = setup();
  await putMain(env, 'tx-live', { uuid: 'uuid-x', email: 'x@exemplo.com' });
  const b = await connect(env, B);
  await env.core.tick();
  assert.equal(env.core.state.active, null);
  await assert.rejects(env.core.switchTo(b.id, 'teste'), /x@exemplo.com, que não está no rodízio/);
  assert.equal(await tokenOf(env, MAIN_SERVICE), 'tx-live');
});

test('refuses to switch while the owner of the main login is uncertain', async () => {
  const { env, b, c } = await rotation({ useApi: false });
  await env.core.switchTo(b.id, 'teste');
  env.clock.t += 10;
  // Without the API and inside the stale window, a new token cannot be told apart from the old account's.
  await env.kc.write(MAIN_SERVICE, { ...(await env.kc.read(MAIN_SERVICE)), claudeAiOauth: { accessToken: 'new', refreshToken: 'r' } });
  await assert.rejects(env.core.switchTo(c.id, 'teste'), /Ainda não sei/);
  assert.equal(await tokenOf(env, MAIN_SERVICE), 'new');
});

test('status line samples: skips the grace period after a switch and repeated redraws', async () => {
  const { env, a } = await rotation({ useApi: false });
  env.core.state.activeSince = T0;
  const rl = (w) => ({ seven_day: { used_percentage: w, resets_at: T0 + 86_400 }, five_hour: { used_percentage: 12, resets_at: T0 + 3600 } });
  fs.mkdirSync(env.p.samples, { recursive: true });

  recordSample(env.p, { session_id: 's1', rate_limits: rl(40) }, T0 + 10);
  env.clock.t = T0 + 20;
  env.core.ingestSamples();
  assert.equal(env.core.state.accounts[a.id].usage, null, 'inside the grace period');

  recordSample(env.p, { session_id: 's1', rate_limits: rl(41) }, T0 + SAMPLE_GRACE_S + 5);
  env.core.ingestSamples();
  assert.equal(env.core.state.accounts[a.id].usage.weekly.pct, 41);
  assert.equal(env.core.state.accounts[a.id].usage.fiveHour.pct, 12);

  env.core.state.accounts[a.id].usage.weekly.pct = 50; // a newer reading from elsewhere
  recordSample(env.p, { session_id: 's1', rate_limits: rl(41) }, T0 + SAMPLE_GRACE_S + 60);
  env.core.ingestSamples();
  assert.equal(env.core.state.accounts[a.id].usage.weekly.pct, 50, 'a redraw with the same numbers is not a reading');
});

test('raises one alert when every account is at the limit', async () => {
  const { env, a } = await rotation();
  for (const w of [A, B, C]) env.api.usageByUuid.set(w.uuid, weekly(98));
  await env.core.refresh();
  env.clock.t += 600;
  await env.core.tick();
  await env.core.tick();
  assert.equal(env.core.state.active, a.id);
  assert.equal(env.core.state.events.filter((e) => e.kind === 'alerta').length, 1);
});

test('goes back to the 20x account after its week resets', async () => {
  const { env, a, b } = await rotation();
  env.api.usageByUuid.set(A.uuid, weekly(96, T0 + 2 * HOUR));
  env.api.usageByUuid.set(B.uuid, weekly(10));
  env.api.usageByUuid.set(C.uuid, weekly(10));
  await env.core.refresh();
  env.clock.t += 600;
  await env.core.tick();
  assert.equal(env.core.state.active, b.id);

  env.clock.t = T0 + 3 * HOUR; // A's week has reset
  await env.core.tick();
  assert.equal(env.core.state.active, a.id);
  assert.match(env.core.state.events[0].text, /folga de novo/);
});

test('removing: refuses the account in use, drops a parked one with its Keychain item', async () => {
  const { env, a, c } = await rotation();
  await assert.rejects(env.core.removeAccount(a.id), /em uso/);
  await env.core.removeAccount(c.id);
  assert.equal(env.core.state.accounts[c.id], undefined);
  assert.equal(await env.kc.read(serviceForDir(c.dir)), null);
  assert.equal(fs.existsSync(c.dir), false);
});

test('a duplicate login is rejected and its folder cleaned up', async () => {
  const { env } = await rotation();
  env.cli.next = { ...B, token: 'tb-again' };
  const job = await env.core.startLogin({});
  const v = await waitJob(env.core, job.id);
  assert.equal(v.status, 'erro');
  assert.match(v.error, /já está no rodízio/);
  const dir = path.join(env.p.accounts, job.id);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(await env.kc.read(serviceForDir(dir)), null);
});

test('reconnecting checks it is the same account', async () => {
  const { env, b } = await rotation();
  env.cli.next = { ...C, token: 'tc-wrong' };
  let v = await waitJob(env.core, (await env.core.startLogin({ reconnectOf: b.id })).id);
  assert.match(v.error, /mas a conta a reconectar é b@exemplo.com/);

  env.core.state.accounts[b.id].needsLogin = true;
  env.cli.next = { ...B, token: 'tb-new' };
  v = await waitJob(env.core, (await env.core.startLogin({ reconnectOf: b.id })).id);
  assert.equal(v.status, 'concluido');
  assert.equal(env.core.state.accounts[b.id].needsLogin, false);
  assert.equal(await tokenOf(env, serviceForDir(b.dir)), 'tb-new');
  assert.equal(fs.readdirSync(env.p.accounts).length, 3);
});

test('a login that lands on the account in use is moved to its folder and the previous one put back', async () => {
  const { env, a } = await rotation();
  env.cli.ignoreConfigDir = env.claudeJson;
  env.cli.next = { uuid: 'uuid-d', email: 'd@exemplo.com', token: 'td', tier: 'default_claude_max_5x' };
  const v = await waitJob(env.core, (await env.core.startLogin({})).id);
  assert.equal(v.status, 'concluido', v.error);
  const d = Object.values(env.core.state.accounts).find((x) => x.email === 'd@exemplo.com');
  assert.equal(await tokenOf(env, serviceForDir(d.dir)), 'td');
  const main = await env.kc.read(MAIN_SERVICE);
  assert.equal(main.claudeAiOauth.accessToken, 'ta-live');
  assert.deepEqual(main.mcpOAuth, { github: { token: 'mcp-secret' } });
  assert.equal(JSON.parse(fs.readFileSync(env.claudeJson, 'utf8')).oauthAccount.accountUuid, A.uuid);
  await env.core.tick();
  assert.equal(env.core.state.active, a.id);
});

test('a token the sessions refreshed during a login is never taken for a misplaced login', async () => {
  const { env } = await rotation();
  const job = await env.core.startLogin({});
  const j = env.core.job(job.id);
  await putMain(env, 'ta-refreshed-during-login', A);
  assert.equal(await env.core.recoverMisplacedLogin(j), null);
  assert.equal(await tokenOf(env, MAIN_SERVICE), 'ta-refreshed-during-login');
});

test('a parked token about to expire is renewed before it goes in', async () => {
  const { env, b } = await rotation();
  const item = await env.kc.read(serviceForDir(b.dir));
  item.claudeAiOauth.expiresAt = (env.clock.t + 60) * 1000;
  await env.kc.write(serviceForDir(b.dir), item);
  await env.core.switchTo(b.id, 'teste');
  assert.deepEqual(env.cli.renewed, [b.dir]);
  assert.equal(env.core.state.active, b.id);
});

test('never renews or polls with the parked copy of the account in use', async () => {
  const { env, a } = await rotation();
  env.clock.t += 2 * 3600;
  const before = env.api.calls.length;
  await env.core.refresh();
  assert.ok(!env.cli.renewed.includes(a.dir));
  const usedTokens = env.api.calls.slice(before).filter(([k]) => k === 'usage').map(([, t]) => t);
  assert.ok(usedTokens.includes('ta-live'));
  assert.ok(!usedTokens.includes(A.token));
  assert.equal(tokenHash(await env.kc.read(MAIN_SERVICE)), env.core.state.accounts[a.id].lastHash);
});

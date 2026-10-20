// Demonstration: the real agent and dashboard with a JSON file in place of the Keychain, a usage API that answers
// from a table and a simulated login, seeded with a believable week. Nothing here reads or writes the real Claude
// Code login.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { tokenHash } from './blob.mjs';
import { dayKey } from './insights.mjs';
import { consume, observe } from './learn.mjs';
import { FileKeychain, MAIN_SERVICE, serviceForDir } from './keychain.mjs';
import { emptyState } from './state.mjs';
import { nowS, readJson, writeJsonAtomic } from './util.mjs';

const H = 3600;
const D = 24 * H;

const login = (token, tier) => ({
  claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: (nowS() + 8 * H) * 1000, subscriptionType: 'max', rateLimitTier: tier },
  organizationUuid: 'org-demo',
});

/** Work hours, 09:00 to 23:00: when the baton holder's week grows. */
const working = (t) => {
  const h = new Date(t * 1000).getHours();
  return h >= 9 && h < 23;
};

function seed(p, kc, now) {
  const people = [
    { id: 'd3m0a1', email: 'voce@exemplo.com', tier: 'default_claude_max_20x', mult: 20, reset: now + D + 20 * H, added: now - 6 * D },
    { id: 'd3m0b2', email: 'trabalho@exemplo.com', tier: 'default_claude_max_5x', mult: 5, reset: now + 3 * D + 7 * H, added: now - 6 * D + 60 },
    { id: 'd3m0c3', email: 'reserva@exemplo.com', tier: 'default_claude_max_5x', mult: 5, reset: now + 4 * D + 2 * H, added: now - 6 * D + 120 },
  ];
  const switchAt = now - 15 * H; // the 20x reached the exchange zone last night
  const holder = (t) => (t < switchAt ? 'd3m0a1' : 'd3m0b2');
  const st = emptyState();
  const tokens = {};
  const pct = { d3m0a1: 18, d3m0b2: 12, d3m0c3: 34 };
  // Weekly %/h while holding the baton; the 20x's pace is set so it reaches the exchange zone right at the switch.
  let worked = 0;
  for (let t = now - 4 * D; t < switchAt; t += 600) if (working(t)) worked += 600 / H;
  const pace = { d3m0a1: (95.4 - pct.d3m0a1) / worked, d3m0b2: 3.1 };

  for (const x of people) {
    const dir = path.join(p.accounts, x.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(path.join(dir, '.claude.json'), { oauthAccount: { accountUuid: `uuid-${x.id}`, emailAddress: x.email, organizationName: 'Pessoal' } });
    const token = `t-${x.id}`;
    tokens[token] = x.id;
    void kc.write(serviceForDir(dir), login(token, x.tier));
    st.accounts[x.id] = {
      id: x.id,
      email: x.email,
      uuid: `uuid-${x.id}`,
      orgName: 'Pessoal',
      plan: { label: `Max ${x.mult}x`, multiplier: x.mult },
      dir,
      addedAt: x.added,
      lastHash: tokenHash(login(token, x.tier)),
      usage: null,
      needsLogin: false,
      paused: false,
    };
    st.history[x.id] = [];
    st.activity[x.id] = {};
  }

  // Four days of readings every 10 minutes: only the holder's week grows, during work hours.
  const win5 = {};
  for (let t = now - 4 * D; t <= now; t += 600) {
    const h = holder(t);
    if (working(t)) {
      pct[h] = Math.min(96.4, pct[h] + (pace[h] * 600) / H);
      const day = (st.activity[h][dayKey(t)] ??= { cost: 0, tokensIn: 0, tokensOut: 0, linesAdded: 0, linesRemoved: 0 });
      day.cost += 0.42;
      day.tokensIn += 21_000;
      day.tokensOut += 1_900;
      day.linesAdded += 7;
      day.linesRemoved += 2;
    }
    // 5-hour windows start with the first use and last five hours; the holder fills its own at ~16%/h of a 5x.
    for (const x of people) {
      const w5 = win5[x.id];
      if (w5 && t >= w5.reset) win5[x.id] = null;
      if (holder(t) === x.id && working(t)) {
        win5[x.id] ??= { reset: t + 5 * H, pct: 0 };
        win5[x.id].pct = Math.min(100, win5[x.id].pct + (16 * 600) / H / (x.mult / 5));
      }
      const cur = win5[x.id];
      st.history[x.id].push([t, Math.round(pct[x.id] * 10) / 10, cur ? Math.round(cur.pct) : 0, x.reset, cur?.reset ?? null]);
      // the demo learns its own week the way the agent learns a real one
      consume(st, x.id, x.mult / 5, {
        weekly: { pct: pct[x.id], resetsAt: x.reset },
        fiveHour: cur ? { pct: cur.pct, resetsAt: cur.reset } : { pct: 0, resetsAt: null },
        at: t,
      });
    }
    observe(st, t);
  }
  for (const x of people) {
    const last = st.history[x.id].at(-1);
    st.accounts[x.id].usage = {
      weekly: { pct: last[1], resetsAt: x.reset },
      fiveHour: last[4] ? { pct: last[2], resetsAt: last[4] } : { pct: 0, resetsAt: null, unstarted: true },
      at: now - 120,
      source: x.id === 'd3m0b2' ? 'linha de status' : 'api',
    };
  }

  st.timeline = [
    { id: 'd3m0a1', from: now - 4 * D, to: switchAt },
    { id: 'd3m0b2', from: switchAt, to: null },
  ];
  st.active = 'd3m0b2';
  st.activeSince = switchAt;
  st.lastSwitchAt = switchAt;
  const main = { ...login('t-d3m0b2', people[1].tier), mcpOAuth: {} };
  void kc.write(MAIN_SERVICE, main);
  st.mainHash = tokenHash(main);
  st.mainEmail = people[1].email;
  st.sessions = {
    'demo-s1': { at: now, sig: null, totals: null, model: 'Opus', ctx: 46 },
    'demo-s2': { at: now, sig: null, totals: null, model: 'Sonnet', ctx: 18 },
  };
  st.events = [
    { at: switchAt, kind: 'troca', text: 'Troquei de voce@exemplo.com (95%) para trabalho@exemplo.com (12%). Motivo: faltavam 5% da semana.' },
    { at: now - 6 * D + 300, kind: 'info', text: 'voce@exemplo.com está no Claude Code e passou a ser a conta em uso do rodízio.' },
    ...people.map((x) => ({ at: x.added, kind: 'conta', text: `${x.email} (Max ${x.mult}x) entrou no rodízio.` })).reverse(),
  ];
  writeJsonAtomic(p.state, st);
  writeJsonAtomic(path.join(p.home, 'demo-claude.json'), { oauthAccount: { accountUuid: 'uuid-d3m0b2', emailAddress: people[1].email } });

  const usage = {};
  for (const x of people) {
    const u = st.accounts[x.id].usage;
    usage[x.id] = { weekly: u.weekly.pct, fiveHour: u.fiveHour.pct, resetsAt: x.reset, fiveResetsAt: u.fiveHour.resetsAt };
  }
  return { tokens, usage, uuids: Object.fromEntries(people.map((x) => [x.id, { uuid: `uuid-${x.id}`, email: x.email }])) };
}

export function demoDeps(p) {
  const file = path.join(p.home, 'demo.json');
  const kc = new FileKeychain(path.join(p.home, 'demo-keychain.json'));
  const claudeJson = path.join(p.home, 'demo-claude.json');
  fs.mkdirSync(p.accounts, { recursive: true, mode: 0o700 });
  let demo = readJson(file, null);
  if (!demo) {
    demo = seed(p, kc, nowS());
    writeJsonAtomic(file, demo);
  }
  const save = () => writeJsonAtomic(file, demo);
  const person = (token) => demo.uuids[demo.tokens[token]];

  const api = {
    async profile(token) {
      const x = person(token);
      return x ? { status: 200, uuid: x.uuid, email: x.email, orgUuid: 'org-demo', orgName: 'Pessoal' } : { status: 401 };
    },
    async usage(token) {
      const id = demo.tokens[token];
      const u = demo.usage[id];
      if (!u) return { status: 401 };
      return { status: 200, weekly: { pct: u.weekly, resetsAt: u.resetsAt }, fiveHour: u.fiveResetsAt ? { pct: u.fiveHour, resetsAt: u.fiveResetsAt } : { pct: 0, resetsAt: null, unstarted: true } };
    },
  };

  const cli = {
    login(dir, { email }) {
      const c = new EventEmitter();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.stdin = new PassThrough();
      let done = false;
      c.kill = () => {
        if (!done) setImmediate(() => c.emit('close', null));
        done = true;
      };
      c.stdout.write("If the browser didn't open, visit: https://claude.ai/oauth/authorize?demo=1\n");
      setTimeout(async () => {
        if (done) return;
        done = true;
        const id = path.basename(dir);
        const token = `t-${id}`;
        demo.tokens[token] = id;
        demo.uuids[id] = { uuid: `uuid-${id}`, email: email || `nova-${id.slice(0, 4)}@exemplo.com` };
        demo.usage[id] = { weekly: 3, fiveHour: 0, resetsAt: nowS() + 6 * D };
        save();
        writeJsonAtomic(path.join(dir, '.claude.json'), { oauthAccount: { accountUuid: `uuid-${id}`, emailAddress: demo.uuids[id].email, organizationName: 'Pessoal' } });
        await kc.write(serviceForDir(dir), login(token, 'default_claude_max_5x'));
        c.emit('close', 0);
      }, 2500);
      return c;
    },
    async renew() {
      return { code: 0, out: '', err: '' };
    },
  };

  return { kc, api, cli, claudeJson, notify: (title, text) => console.log(`[notificação] ${title}: ${text}`) };
}

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Rodizio } from '../src/core.mjs';
import { MAIN_SERVICE, serviceForDir } from '../src/keychain.mjs';
import { paths } from '../src/paths.mjs';

export { MAIN_SERVICE };
import { DEFAULT_CONFIG } from '../src/state.mjs';

export const HOUR = 3600;
export const T0 = 1_800_000_000;

export class MemoryKeychain {
  constructor() {
    this.items = new Map();
  }
  async read(s) {
    return this.items.has(s) ? structuredClone(this.items.get(s)) : null;
  }
  async write(s, v) {
    this.items.set(s, structuredClone(v));
  }
  async remove(s) {
    this.items.delete(s);
  }
}

export const login = (token, tier = 'default_claude_max_5x', expiresAt = (T0 + 8 * HOUR) * 1000) => ({
  claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt, subscriptionType: 'max', rateLimitTier: tier },
  organizationUuid: `org-${token}`,
});

/** Tokens the fake API recognizes, mapped to the account that owns them. */
export class FakeApi {
  constructor() {
    this.owners = new Map();
    this.usageByUuid = new Map();
    /** uuid → forced answer for the usage endpoint ({status, retryAfter}), to play outages and refusals */
    this.failUsage = new Map();
    this.calls = [];
  }
  own(token, uuid, email) {
    this.owners.set(token, { uuid, email });
  }
  async profile(token) {
    this.calls.push(['profile', token]);
    const o = this.owners.get(token);
    return o ? { status: 200, uuid: o.uuid, email: o.email, orgUuid: null, orgName: null } : { status: 401 };
  }
  async usage(token) {
    this.calls.push(['usage', token]);
    const o = this.owners.get(token);
    if (!o) return { status: 401 };
    if (this.failUsage.has(o.uuid)) return { ...this.failUsage.get(o.uuid) };
    return { status: 200, ...(this.usageByUuid.get(o.uuid) ?? { weekly: null, fiveHour: null }) };
  }
}

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.kill = () => setImmediate(() => c.emit('close', null));
  return c;
}

/** `claude auth login` that logs into whatever `next` says, the way Claude Code leaves an account folder. */
export class FakeCli {
  constructor(kc, api) {
    Object.assign(this, { kc, api, next: null, logins: [], renewed: [], ignoreConfigDir: null });
  }
  login(dir, opts) {
    const c = fakeChild();
    const who = this.next;
    this.logins.push({ dir, ...opts });
    setImmediate(async () => {
      c.stdout.write("Opening browser...\nIf the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=x\n");
      if (!who) return c.emit('close', 1);
      const oauthAccount = { accountUuid: who.uuid, emailAddress: who.email, organizationUuid: `org-${who.uuid}`, organizationName: 'Pessoal' };
      if (this.ignoreConfigDir) {
        // a Claude Code that writes the login over the main item and ~/.claude.json
        const main = (await this.kc.read(MAIN_SERVICE)) ?? {};
        await this.kc.write(MAIN_SERVICE, { ...main, ...login(who.token, who.tier) });
        const cj = JSON.parse(fs.readFileSync(this.ignoreConfigDir, 'utf8'));
        fs.writeFileSync(this.ignoreConfigDir, JSON.stringify({ ...cj, oauthAccount }));
        this.api.own(who.token, who.uuid, who.email);
        return c.emit('close', 0);
      }
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount }));
      await this.kc.write(serviceForDir(dir), login(who.token, who.tier));
      this.api.own(who.token, who.uuid, who.email);
      c.emit('close', 0);
    });
    return c;
  }
  async renew(dir) {
    this.renewed.push(dir);
    return { code: 0, out: '', err: '' };
  }
}

export function setup({ config = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-test-'));
  const p = paths(home);
  const claudeJson = path.join(home, 'claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ numStartups: 7, projects: { '/x': {} } }), { mode: 0o600 });
  const kc = new MemoryKeychain();
  const api = new FakeApi();
  const cli = new FakeCli(kc, api);
  const clock = { t: T0 };
  const notes = [];
  const core = new Rodizio({
    paths: p,
    config: { ...DEFAULT_CONFIG, port: 45678, token: 't'.repeat(32), ...config, order: [...(config.order ?? [])] },
    kc,
    api,
    cli,
    claudeJson,
    clock: () => clock.t,
    notify: (title, text) => notes.push(text),
    log: { info() {}, error() {} },
  });
  return { home, p, claudeJson, kc, api, cli, clock, core, notes };
}

export async function waitJob(core, id) {
  for (let i = 0; i < 200; i++) {
    const j = core.job(id);
    if (!j.running) return j.view();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('login não terminou');
}

/** Connects an account through the (fake) official login. */
export async function connect(env, who) {
  env.cli.next = who;
  const job = await env.core.startLogin({ email: who.email });
  const v = await waitJob(env.core, job.id);
  if (v.status !== 'concluido') throw new Error(`login falhou: ${v.error}`);
  return Object.values(env.core.state.accounts).find((a) => a.uuid === who.uuid);
}

/** Puts a login in Claude Code's main item, as a /login or a token refresh by a session would. */
export async function putMain(env, token, who, extra = { mcpOAuth: { github: { token: 'mcp-secret' } } }) {
  const current = (await env.kc.read(MAIN_SERVICE)) ?? {};
  await env.kc.write(MAIN_SERVICE, { ...current, ...extra, ...login(token, who.tier) });
  if (who.uuid) env.api.own(token, who.uuid, who.email);
  const cj = JSON.parse(fs.readFileSync(env.claudeJson, 'utf8'));
  cj.oauthAccount = { accountUuid: who.uuid, emailAddress: who.email };
  fs.writeFileSync(env.claudeJson, JSON.stringify(cj));
}

/** A session refreshing `who` and writing the main item back, read-modify-write; it does not touch ~/.claude.json. */
export async function sessionWrite(env, token, who) {
  const current = (await env.kc.read(MAIN_SERVICE)) ?? {};
  await env.kc.write(MAIN_SERVICE, { ...current, claudeAiOauth: login(token, who.tier).claudeAiOauth });
  env.api.own(token, who.uuid, who.email);
}

export const A = { uuid: 'uuid-a', email: 'a@exemplo.com', token: 'ta-folder', tier: 'default_claude_max_20x' };
export const B = { uuid: 'uuid-b', email: 'b@exemplo.com', token: 'tb-folder', tier: 'default_claude_max_5x' };
export const C = { uuid: 'uuid-c', email: 'c@exemplo.com', token: 'tc-folder', tier: 'default_claude_max_5x' };

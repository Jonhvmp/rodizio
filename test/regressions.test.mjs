// Event sequences found by an adversarial review, each of which used to lose or misplace a login.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { MAIN_SERVICE, serviceForDir } from '../src/keychain.mjs';
import { recordSample } from '../src/statusline.mjs';
import { A, B, C, HOUR, T0, connect, login, putMain, sessionWrite, setup, waitJob } from './helpers.mjs';

const tokenOf = async (env, service) => (await env.kc.read(service))?.claudeAiOauth?.accessToken;
const allTokens = (env) => [...env.kc.items.values()].map((v) => v?.claudeAiOauth?.accessToken);

async function rotation(config) {
  const env = setup({ config });
  await putMain(env, 'ta-live', A);
  const a = await connect(env, A);
  const b = await connect(env, B);
  const c = await connect(env, C);
  await env.core.tick();
  return { env, a, b, c };
}

test('a failed mirror is retried: the login is not counted as seen until it is saved', async () => {
  const { env, a, b, c } = await rotation();
  env.clock.t += 600;
  await putMain(env, 'tc-manual', C);
  const write = env.kc.write.bind(env.kc);
  let fail = true;
  env.kc.write = async (s, v) => {
    if (fail && s === serviceForDir(c.dir)) {
      fail = false;
      throw new Error('Keychain ocupado');
    }
    return write(s, v);
  };
  await env.core.tick();
  assert.equal(env.core.state.active, a.id, 'nothing decided on a failed pass');
  await env.core.tick();
  assert.equal(env.core.state.active, c.id);
  await env.core.switchTo(b.id, 'teste');
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-live');
  assert.equal(await tokenOf(env, serviceForDir(c.dir)), 'tc-manual');
});

for (const useApi of [true, false]) {
  test(`with the profile endpoint down, a late write-back is left alone, then undone (useApi=${useApi})`, async () => {
    const { env, a, b } = await rotation({ useApi });
    await env.core.switchTo(b.id, 'teste');
    env.clock.t += 200; // well past any time window
    const profile = env.api.profile.bind(env.api);
    env.api.profile = async () => ({ status: 0 });
    await sessionWrite(env, 'ta-late', A);
    await env.core.tick();
    await env.core.tick();
    assert.equal(await tokenOf(env, serviceForDir(b.dir)), B.token, 'B kept its login');
    assert.equal(env.core.view().mainPending, true);

    env.api.profile = profile;
    env.clock.t += 700; // past the wait the failed profile calls set
    await env.core.tick();
    env.clock.t += 10;
    await env.core.tick();
    assert.equal(env.core.state.active, b.id);
    assert.equal(await tokenOf(env, MAIN_SERVICE), B.token);
    assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-late');
    assert.equal(await tokenOf(env, serviceForDir(b.dir)), B.token);
  });
}

test('a session refresh during the renewal of the target aborts the switch instead of being overwritten', async () => {
  const { env, a, b } = await rotation();
  const item = await env.kc.read(serviceForDir(b.dir));
  item.claudeAiOauth.expiresAt = (env.clock.t + 60) * 1000;
  await env.kc.write(serviceForDir(b.dir), item);
  env.cli.renew = async () => {
    const m = await env.kc.read(MAIN_SERVICE);
    await env.kc.write(MAIN_SERVICE, { ...m, claudeAiOauth: login('ta-next', A.tier).claudeAiOauth, mcpOAuth: { github: { token: 'mcp-rotated' } } });
    env.api.own('ta-next', A.uuid, A.email);
    return { code: 0, out: '', err: '' };
  };
  await assert.rejects(env.core.switchTo(b.id, 'teste'), /Ainda não sei/);
  assert.equal(await tokenOf(env, MAIN_SERVICE), 'ta-next');
  await env.core.tick();
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-next');
  await env.core.switchTo(b.id, 'teste');
  assert.equal((await env.kc.read(MAIN_SERVICE)).mcpOAuth.github.token, 'mcp-rotated');
  assert.ok(allTokens(env).includes('ta-next'));
});

test('reconnecting the account in use never overwrites a login that landed in Claude Code meanwhile', async () => {
  const { env, a } = await rotation();
  env.clock.t += 600;
  env.cli.next = { ...A, token: 'ta-reconn' };
  const job = await env.core.startLogin({ reconnectOf: a.id });
  await putMain(env, 'tx-foreign', { uuid: 'uuid-x', email: 'x@exemplo.com' });
  const v = await waitJob(env.core, job.id);
  assert.equal(v.status, 'concluido', v.error);
  assert.equal(await tokenOf(env, MAIN_SERVICE), 'tx-foreign');
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-reconn');
  assert.equal(env.core.state.active, null);
});

test("a misplaced login is undone from the account's current item, not from an old picture", async () => {
  const { env, a } = await rotation();
  env.clock.t += 600;
  env.cli.ignoreConfigDir = env.claudeJson;
  env.cli.next = { uuid: 'uuid-d', email: 'd@exemplo.com', token: 'td', tier: 'default_claude_max_5x' };
  const job = await env.core.startLogin({});
  await sessionWrite(env, 'ta-refreshed', A); // a session refreshes A while the login is open
  await env.core.tick();
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-refreshed');
  const v = await waitJob(env.core, job.id);
  assert.equal(v.status, 'concluido', v.error);
  assert.equal(await tokenOf(env, MAIN_SERVICE), 'ta-refreshed');
  await env.core.tick();
  assert.equal(await tokenOf(env, serviceForDir(a.dir)), 'ta-refreshed');
  assert.equal(env.core.state.active, a.id);
});

test("status line numbers with another account's reset time are not credited to the account in use", async () => {
  const { env, a, b } = await rotation({ useApi: false });
  const at = env.clock.t;
  env.core.state.accounts[a.id].usage = { weekly: { pct: 96, resetsAt: T0 + 3 * 24 * HOUR }, fiveHour: null, at, source: 'api' };
  env.core.state.accounts[b.id].usage = { weekly: { pct: 10, resetsAt: T0 + 5 * 24 * HOUR }, fiveHour: null, at, source: 'api' };
  env.clock.t += 600;
  await env.core.tick();
  assert.equal(env.core.state.active, b.id);
  fs.mkdirSync(env.p.samples, { recursive: true });
  recordSample(env.p, { session_id: 's1', rate_limits: { seven_day: { used_percentage: 96.2, resets_at: T0 + 3 * 24 * HOUR } } }, env.clock.t + 300);
  env.clock.t += 400;
  await env.core.tick();
  assert.equal(env.core.state.accounts[b.id].usage.weekly.pct, 10);
  assert.equal(env.core.state.active, b.id);
  // B's own numbers still count
  recordSample(env.p, { session_id: 's2', rate_limits: { seven_day: { used_percentage: 12, resets_at: T0 + 5 * 24 * HOUR + 30 } } }, env.clock.t);
  env.core.ingestSamples();
  assert.equal(env.core.state.accounts[b.id].usage.weekly.pct, 12);
});

test("mirroring keeps each account's own organizationUuid", async () => {
  const { env, a, b } = await rotation();
  await env.core.switchTo(b.id, 'teste');
  env.clock.t += 5;
  await sessionWrite(env, 'ta-late', A); // keeps B's organizationUuid in the main item
  await env.core.tick();
  env.clock.t += 10;
  await env.core.tick();
  const itemA = await env.kc.read(serviceForDir(a.dir));
  assert.equal(itemA.claudeAiOauth.accessToken, 'ta-late');
  assert.equal(itemA.organizationUuid, `org-${A.token}`);
  assert.equal((await env.kc.read(MAIN_SERVICE)).organizationUuid, `org-${B.token}`);
});

test('a ~/.claude.json that could not be written during a switch is repaired on a later pass', async () => {
  const { env, b } = await rotation();
  const good = fs.readFileSync(env.claudeJson, 'utf8');
  fs.writeFileSync(env.claudeJson, '{"half-written');
  await env.core.switchTo(b.id, 'teste');
  assert.equal(env.core.state.active, b.id);
  assert.equal(env.core.state.oaRepair, b.id);
  fs.writeFileSync(env.claudeJson, good);
  await env.core.tick();
  assert.equal(JSON.parse(fs.readFileSync(env.claudeJson, 'utf8')).oauthAccount.accountUuid, B.uuid);
  assert.equal(env.core.state.oaRepair, null);
});

test('a manual /login is told apart from a write-back: ~/.claude.json follows it', async () => {
  const { env, a, b } = await rotation();
  await env.core.switchTo(b.id, 'teste');
  env.clock.t += 30;
  await putMain(env, 'ta-manual', A); // /login into A: Keychain and ~/.claude.json
  await env.core.tick();
  assert.equal(env.core.state.active, a.id);
  assert.equal(env.core.state.pinned, true);
  assert.equal(await tokenOf(env, MAIN_SERVICE), 'ta-manual');
});

test('a parked login refused by the Anthropic while the endpoint works is flagged for reconnection', async () => {
  const { env, a, c } = await rotation();
  env.api.owners.delete(C.token); // C's grant was revoked
  await env.core.refresh();
  assert.equal(env.core.state.accounts[c.id].needsLogin, false, 'one refusal is not enough');
  env.clock.t += 130;
  await env.core.refresh();
  assert.equal(env.core.state.accounts[c.id].needsLogin, true);
  assert.equal(env.core.state.accounts[a.id].needsLogin, false);
});

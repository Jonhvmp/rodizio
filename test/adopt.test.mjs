import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MAIN_SERVICE, serviceForDir } from '../src/keychain.mjs';
import { A, B, connect, putMain, sessionWrite, setup } from './helpers.mjs';

const tokenOf = async (env, service) => (await env.kc.read(service))?.claudeAiOauth?.accessToken;

test('the account already in Claude Code joins without a new login, holding the baton', async () => {
  const env = setup();
  await putMain(env, 'ta-live', A);
  await env.core.tick();
  const acc = await env.core.adoptCurrent();
  assert.equal(acc.email, A.email);
  assert.equal(acc.plan.label, 'Max 20x');
  assert.equal(env.core.state.active, acc.id);
  assert.equal(await tokenOf(env, serviceForDir(acc.dir)), 'ta-live');
  assert.deepEqual((await env.kc.read(serviceForDir(acc.dir))).mcpOAuth, undefined, 'MCP logins stay in the main item only');
  assert.equal(JSON.parse(fs.readFileSync(path.join(acc.dir, '.claude.json'), 'utf8')).oauthAccount.accountUuid, A.uuid);
  assert.equal(env.cli.logins.length, 0);
  // and it rotates like any other account
  const b = await connect(env, B);
  await env.core.switchTo(b.id, 'teste');
  assert.equal(await tokenOf(env, MAIN_SERVICE), B.token);
  assert.equal(await tokenOf(env, serviceForDir(acc.dir)), 'ta-live');
});

test('a token refreshed after adopting is mirrored like for any account in use', async () => {
  const env = setup();
  await putMain(env, 'ta-live', A);
  const acc = await env.core.adoptCurrent();
  await sessionWrite(env, 'ta-refreshed', A);
  await env.core.tick();
  assert.equal(await tokenOf(env, serviceForDir(acc.dir)), 'ta-refreshed');
});

test('adopting needs the profile to say whose login it is, and refuses duplicates', async () => {
  const env = setup();
  await putMain(env, 'ta-live', A);
  const profile = env.api.profile.bind(env.api);
  env.api.profile = async () => ({ status: 0 });
  await assert.rejects(env.core.adoptCurrent(), /não confirmou/);
  assert.equal(Object.keys(env.core.state.accounts).length, 0);
  assert.ok(!fs.existsSync(env.p.accounts) || fs.readdirSync(env.p.accounts).length === 0, 'no folder left behind');
  env.api.profile = profile;
  await env.core.adoptCurrent();
  await assert.rejects(env.core.adoptCurrent(), /já está no rodízio/);
});

test('nothing to adopt without a login in Claude Code', async () => {
  const env = setup();
  await assert.rejects(env.core.adoptCurrent(), /sem login/);
});

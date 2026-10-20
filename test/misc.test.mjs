import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { usageFromApi } from '../src/api.mjs';
import { loginOnly, planOf, withLogin } from '../src/blob.mjs';
import { readOauthAccount, writeOauthAccount } from '../src/claudejson.mjs';
import { cleanEnv } from '../src/claudecli.mjs';
import { MacKeychain, decodeSecret, serviceForDir } from '../src/keychain.mjs';
import { plist, removeStatusLine, setStatusLine } from '../src/install.mjs';
import { browserScript, loginUrl } from '../src/logins.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-misc-'));

test('Keychain item name for an account folder follows Claude Code', () => {
  assert.match(serviceForDir('/Users/x/.rodizio/contas/abc'), /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.notEqual(serviceForDir('/a'), serviceForDir('/b'));
});

test('moving a login keeps the MCP logins of the machine', () => {
  const main = { claudeAiOauth: { accessToken: 'old' }, organizationUuid: 'o1', mcpOAuth: { s: 1 } };
  const next = withLogin(main, { claudeAiOauth: { accessToken: 'new' }, organizationUuid: 'o2', mcpOAuth: { other: 2 } });
  assert.deepEqual(next, { mcpOAuth: { s: 1 }, claudeAiOauth: { accessToken: 'new' }, organizationUuid: 'o2' });
  assert.deepEqual(loginOnly(main), { claudeAiOauth: { accessToken: 'old' }, organizationUuid: 'o1' });
});

test('plan from the rate limit tier', () => {
  assert.equal(planOf({ claudeAiOauth: { rateLimitTier: 'default_claude_max_20x', subscriptionType: 'max' } }).label, 'Max 20x');
  assert.equal(planOf({ claudeAiOauth: { rateLimitTier: 'default_claude_max_5x' } }).multiplier, 5);
  assert.equal(planOf({ claudeAiOauth: { subscriptionType: 'pro' } }).label, 'Pro');
  assert.equal(planOf({}), null);
});

test('usage endpoint answer', () => {
  const u = usageFromApi({ seven_day: { utilization: 41.26, resets_at: '2026-10-24T14:00:00+00:00' }, five_hour: null });
  assert.equal(u.weekly.pct, 41.3);
  assert.equal(u.weekly.resetsAt, Date.parse('2026-10-24T14:00:00Z') / 1000);
  // listed as null: the window has not started, so nothing is used in it
  assert.deepEqual(u.fiveHour, { pct: 0, resetsAt: null, unstarted: true });
  // missing altogether: unknown
  assert.equal(u.opus, null);
  assert.deepEqual(usageFromApi({ five_hour: { utilization: 3, resets_at: null }, seven_day: null }).weekly, { pct: 0, resetsAt: null, unstarted: true });
});

test('security: hex output, stdin for short values, argv for long ones, read-back check', async () => {
  assert.equal(decodeSecret(Buffer.from('{"a":"é"}').toString('hex')), '{"a":"é"}');
  assert.equal(decodeSecret('{"a":1}\n'), '{"a":1}');
  const store = new Map();
  const calls = [];
  const runner = async (argv, { input } = {}) => {
    calls.push({ argv, input });
    if (argv[1] === 'find-generic-password') {
      assert.equal(argv[argv.indexOf('-a') + 1], 'me');
      const v = store.get(argv[argv.indexOf('-s') + 1]);
      return v ? { code: 0, out: Buffer.from(v).toString('hex') } : { code: 44, out: '' };
    }
    const line = input ?? argv.join(' ');
    const m = /-s "?([^"]+?)"? -X ([0-9a-f]+)/.exec(line);
    store.set(m[1], Buffer.from(m[2], 'hex').toString('utf8'));
    return { code: 0, out: '' };
  };
  const kc = new MacKeychain({ account: 'me', runner });
  await kc.write('svc', { a: 1 });
  assert.deepEqual(calls[0].argv, ['security', '-i']);
  assert.deepEqual(await kc.read('svc'), { a: 1 });
  await kc.write('svc', { big: 'x'.repeat(5000) });
  assert.equal(calls.at(-2).argv[1], 'add-generic-password');
  assert.equal(await kc.read('missing'), null);
  await assert.rejects(new MacKeychain({ account: 'me', runner: async () => ({ code: 1, out: '' }) }).read('x'), /não respondeu/);
});

test('~/.claude.json: only oauthAccount changes, mode is kept, lock is released', async () => {
  const dir = tmp();
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ a: 1, oauthAccount: { emailAddress: 'x' } }), { mode: 0o644 });
  await writeOauthAccount(file, { emailAddress: 'y' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, oauthAccount: { emailAddress: 'y' } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(readOauthAccount(file).emailAddress, 'y');
  fs.writeFileSync(file, '{"a": 1, "trunc');
  await assert.rejects(writeOauthAccount(file, {}), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a": 1, "trunc');
});

test('login: only official https addresses, private window when available', () => {
  assert.ok(loginUrl('https://claude.ai/oauth/authorize?x=1'));
  assert.ok(loginUrl('https://platform.claude.com/oauth/code'));
  assert.equal(loginUrl('https://claude.ai.evil.com/x'), null);
  assert.equal(loginUrl('http://claude.ai/x'), null);
  assert.equal(loginUrl('https://user:pw@claude.ai/x'), null);
  const s = browserScript("/tmp/it's/url", true);
  assert.match(s, /printf '%s\\n' "\$1" > '\/tmp\/it'\\''s\/url'/);
  assert.match(s, /open -na 'Brave Browser' --args --incognito "\$1"/);
  assert.ok(!browserScript('/tmp/u', false).includes('incognito'));
});

test('child processes do not inherit the calling session', () => {
  const env = cleanEnv('/x', { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/y' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/x' });
});

test('install: the status line goes in with a backup, never over somebody else\'s', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [] }, model: 'opus' }), { mode: 0o600 });
  assert.match(setStatusLine('/opt/homebrew/bin/node', file), /configurada/);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.hooks, { Stop: [] });
  assert.match(s.statusLine.command, /^'\/opt\/homebrew\/bin\/node' '.*\/src\/statusline\.mjs'$/);
  assert.ok(fs.existsSync(`${file}.rodizio.bak`));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(setStatusLine('/opt/homebrew/bin/node', file), /já estava/);
  assert.match(removeStatusLine(file), /removida/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, undefined);

  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-line.sh' } }));
  assert.match(setStatusLine('/opt/homebrew/bin/node', file), /já existe outra/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'my-line.sh');
  assert.equal(removeStatusLine(file), null);
});

test('install: launchd plist escapes paths and keeps the agent alive', () => {
  const xml = plist({ node: '/n<de>', script: '/a&b/main.mjs', logFile: '/l/agente.log', pathEnv: '/bin', home: '/Users/x' });
  assert.match(xml, /<string>\/n&lt;de&gt;<\/string><string>\/a&amp;b\/main\.mjs<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.match(xml, /<key>Label<\/key><string>local\.rodizio\.agente<\/string>/);
});

test('status line: prints the account and the limits, leaves a sample for the agent', () => {
  const home = tmp();
  fs.writeFileSync(
    path.join(home, 'state.json'),
    JSON.stringify({ active: 'a1', accounts: { a1: { email: 'a@exemplo.com', plan: { label: 'Max 20x' } } } }),
  );
  const script = fileURLToPath(new URL('../src/statusline.mjs', import.meta.url));
  const input = JSON.stringify({
    session_id: 'abc-123',
    model: { display_name: 'Opus' },
    rate_limits: { seven_day: { used_percentage: 41.2, resets_at: 1 }, five_hour: { used_percentage: 92, resets_at: 2 } },
  });
  const out = execFileSync(process.execPath, [script], { input, env: { ...process.env, RODIZIO_HOME: home } }).toString();
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(plain, 'Opus · ⇄ a@exemplo.com Max 20x · semana 41% · 5h 92%');
  const sample = JSON.parse(fs.readFileSync(path.join(home, 'amostras', 'abc-123.json'), 'utf8'));
  assert.equal(sample.rl.seven_day.used_percentage, 41.2);
  // a broken payload still prints a line
  assert.ok(execFileSync(process.execPath, [script], { input: '{oops', env: { ...process.env, RODIZIO_HOME: home } }).length > 0);
});

test('install: the watchdog runs the doctor every few minutes, and never keeps itself alive', async () => {
  const { watchPlist, WATCH_EVERY_S } = await import('../src/install.mjs');
  const xml = watchPlist({ node: '/n', logFile: '/l/vigia.log', pathEnv: '/bin', home: '/Users/x' });
  assert.match(xml, /<key>Label<\/key><string>local\.rodizio\.vigia<\/string>/);
  assert.match(xml, /<string>doctor<\/string><string>--vigia<\/string>/);
  assert.match(xml, new RegExp(`<key>StartInterval</key><integer>${WATCH_EVERY_S}</integer>`));
  assert.doesNotMatch(xml, /KeepAlive/);
});

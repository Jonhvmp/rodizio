import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WATCH_EVERY_S, agentUnit, watchUnits } from '../src/install.mjs';
import { CREDENTIALS_FILE, LinuxKeychain, MAIN_SERVICE, MacKeychain, serviceForDir, systemKeychain } from '../src/keychain.mjs';
import { browserScript } from '../src/logins.mjs';
import { notifyMac, systemNotify } from '../src/notify.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-linux-'));
const blob = (token) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 1 } });
const mode = (f) => fs.statSync(f).mode & 0o777;

test('linux keychain: the main login is ~/.claude/.credentials.json, only for this user', async () => {
  const home = tmp();
  const kc = new LinuxKeychain({ home });
  assert.equal(await kc.read(MAIN_SERVICE), null);
  await kc.write(MAIN_SERVICE, blob('a'));
  const file = path.join(home, '.claude', CREDENTIALS_FILE);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), blob('a'));
  assert.equal(mode(file), 0o600);
  assert.deepEqual(await kc.read(MAIN_SERVICE), blob('a'));
  await kc.remove(MAIN_SERVICE);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await kc.read(MAIN_SERVICE), null);
});

test('linux keychain: an account login lives in its own folder, the one Claude Code gets as CLAUDE_CONFIG_DIR', async () => {
  const home = tmp();
  const dir = path.join(home, 'contas', 'abc');
  const kc = new LinuxKeychain({ home });
  await kc.write(serviceForDir(dir), blob('b'));
  const file = path.join(dir, CREDENTIALS_FILE);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.deepEqual(await kc.read(serviceForDir(dir)), blob('b'));
});

test('linux keychain: a service never named this run is found among the account folders', async () => {
  const home = tmp();
  const accounts = path.join(home, 'contas');
  const dir = path.join(accounts, `x${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CREDENTIALS_FILE), JSON.stringify(blob('c')));
  // the name Claude Code gives that folder, computed here without telling the keychain module about the folder
  const service = `${MAIN_SERVICE}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
  assert.deepEqual(await new LinuxKeychain({ home, accountsDir: accounts }).read(service), blob('c'));
  await assert.rejects(new LinuxKeychain({ home }).read(`${MAIN_SERVICE}-ffffffff`), /não sei em que pasta/);
});

test('linux keychain: a file that is not JSON is an error, not "no login" (like the Keychain)', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', CREDENTIALS_FILE), '{oops');
  await assert.rejects(new LinuxKeychain({ home }).read(MAIN_SERVICE));
  fs.writeFileSync(path.join(home, '.claude', CREDENTIALS_FILE), '  \n');
  assert.equal(await new LinuxKeychain({ home }).read(MAIN_SERVICE), null);
});

test('the system keychain: the Keychain on macOS, the credential files elsewhere', () => {
  assert.ok(systemKeychain({ platform: 'darwin' }) instanceof MacKeychain);
  assert.ok(systemKeychain({ platform: 'linux', accountsDir: '/x' }) instanceof LinuxKeychain);
});

test('systemd: the agent unit keeps it alive, quotes paths and leaves the processes it started alone', () => {
  const unit = agentUnit({ node: '/usr/local/bin/node', script: '/home/x/my "repo"/src/main.mjs', logFile: '/home/x/.rodizio/logs/50%.log', pathEnv: '/a:/b', home: '/home/x' });
  assert.match(unit, /^ExecStart="\/usr\/local\/bin\/node" "\/home\/x\/my \\"repo\\"\/src\/main\.mjs"$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^Environment="PATH=\/a:\/b"$/m);
  assert.match(unit, /^Environment="HOME=\/home\/x"$/m);
  assert.match(unit, /^StandardOutput=append:\/home\/x\/\.rodizio\/logs\/50%%\.log$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('systemd: the watchdog is a oneshot doctor --vigia that a timer runs every few minutes', () => {
  const u = watchUnits({ node: '/n', logFile: '/l/vigia.log', pathEnv: '/bin', home: '/home/x' });
  assert.deepEqual(Object.keys(u).sort(), ['rodizio-vigia.service', 'rodizio-vigia.timer']);
  assert.match(u['rodizio-vigia.service'], /^Type=oneshot$/m);
  assert.match(u['rodizio-vigia.service'], /^ExecStart="\/n" ".*\/bin\/rodizio" doctor --vigia$/m);
  assert.match(u['rodizio-vigia.timer'], new RegExp(`^OnUnitActiveSec=${WATCH_EVERY_S}$`, 'm'));
  assert.match(u['rodizio-vigia.timer'], /^WantedBy=timers\.target$/m);
});

test('login off macOS: no browser to open and no localhost address to offer, only the link that ends in a code', () => {
  const s = browserScript('/tmp/u', true, '/Applications', 'linux');
  assert.equal(s, '#!/bin/sh\nexit 0\n');
  assert.ok(browserScript('/tmp/u', true, '/Applications', 'darwin').includes('open'));
});

test('notifications: Notification Center on macOS, nothing on a server', () => {
  assert.equal(systemNotify('darwin'), notifyMac);
  const quiet = systemNotify('linux');
  assert.notEqual(quiet, notifyMac);
  assert.equal(quiet('t', 'x'), undefined);
});

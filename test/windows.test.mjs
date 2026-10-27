// The Windows pieces, as text: they are checked on every system, and run for real only on Windows.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findClaude } from '../src/claudecli.mjs';
import { LABEL, WATCH_EVERY_S, WATCH_LABEL, agentCmd, taskXml, watchCmd } from '../src/install.mjs';
import { browserScript, loginUrl } from '../src/logins.mjs';
import { notifyMac, notifyWindows, systemNotify } from '../src/notify.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-windows-'));
const WIN = process.platform === 'win32';

test('windows: the agent is a task of this user at logon, hidden, on battery too, never stopped for running long', () => {
  const x = taskXml({ label: LABEL, cmdFile: 'C:\\Users\\a&b\\.rodizio\\servicos\\agente.cmd', user: 'PC\\a&b' });
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-16"\?>/);
  assert.match(x, /<LogonTrigger><Enabled>true<\/Enabled><UserId>PC\\a&amp;b<\/UserId><\/LogonTrigger>/);
  assert.match(x, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(x, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(x, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(x, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(x, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(x, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(x, /<Command>conhost.exe<\/Command>/);
  assert.match(x, /<Arguments>--headless cmd.exe \/d \/c "C:\\Users\\a&amp;b\\.rodizio\\servicos\\agente.cmd"<\/Arguments>/);
});

test('windows: the watchdog is a task every few minutes, with a time limit', () => {
  const x = taskXml({ label: WATCH_LABEL, cmdFile: 'C:\\r\\vigia.cmd', user: 'PC\\a' });
  assert.match(x, new RegExp(`<Interval>PT${WATCH_EVERY_S / 60}M</Interval>`));
  assert.doesNotMatch(x, /LogonTrigger/);
  assert.match(x, /<ExecutionTimeLimit>PT30M<\/ExecutionTimeLimit>/);
});

test('windows: the agent comes back a few seconds after it exits; % in a path is not read by cmd', () => {
  const c = agentCmd({ node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\r\\src\\main.mjs', logFile: 'C:\\r\\50%.log', pathEnv: 'C:\\a;C:\\b%x' });
  const lines = c.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.includes('set "PATH=C:\\a;C:\\b%%x;%PATH%"'));
  assert.ok(lines.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\r\\src\\main.mjs" >> "C:\\r\\50%%.log" 2>&1'));
  assert.ok(lines.indexOf(':de-novo') < lines.indexOf('goto de-novo'));
  assert.ok(c.endsWith('\r\n'));
  const w = watchCmd({ node: 'C:\\n\\node.exe', logFile: 'C:\\r\\vigia.log', pathEnv: 'C:\\a' });
  assert.match(w, /"C:\\n\\node.exe" ".*[\\/]bin[\\/]rodizio" doctor --vigia >> "C:\\r\\vigia.log" 2>&1\r\n$/);
  assert.doesNotMatch(w, /goto/);
});

test('windows: the login opens in a private window and the address is remembered as it came, & and % included', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  const s = browserScript('C:\\Users\\a\\.rodizio\\contas\\x\\.login-url', true, '/Applications', 'win32', env);
  assert.ok(s.includes('set "u=%~1"'));
  assert.ok(s.includes('>"C:\\Users\\a\\.rodizio\\contas\\x\\.login-url" echo(!u!'));
  assert.ok(s.includes('if exist "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" (start "" "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --incognito "!u!" & exit /b 0)'));
  assert.ok(s.includes('--inprivate'));
  assert.ok(s.trimEnd().endsWith('start "" "!u!"'));
  assert.ok(!browserScript('C:\\u', false, '/Applications', 'win32', env).includes('incognito'));
});

test('windows: the login script, run by cmd as Claude Code runs it, keeps the address intact', { skip: !WIN && 'só no Windows' }, () => {
  const dir = tmp();
  const urlFile = path.join(dir, '.login-url');
  // the lines that would open a real browser are left out
  const script = path.join(dir, 'abrir.cmd');
  fs.writeFileSync(script, browserScript(urlFile, true, '/Applications', 'win32').replace(/^(if exist|start).*\r\n/gm, ''));
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d&redirect_uri=http%3A%2F%2Flocalhost%3A5%2Fcallback&state=a!b^c';
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${script}" "${url}""`], { windowsVerbatimArguments: true, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loginUrl(fs.readFileSync(urlFile, 'utf8')), loginUrl(url));
});

test('windows: claude is claude.exe, found in the PATH (split on ;) or in ~/.local/bin', () => {
  const home = tmp();
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude.exe'), '');
  assert.equal(findClaude({ PATH: 'C:\\nada;C:\\outra' }, home, 'win32'), path.win32.join(bin, 'claude.exe'));
  assert.equal(findClaude({ Path: '' }, tmp(), 'win32'), 'claude');
});

test('windows: notifications are toasts; the text never goes into the script', () => {
  assert.equal(systemNotify('win32'), notifyWindows);
  assert.notEqual(systemNotify('win32'), notifyMac);
  const src = fs.readFileSync(new URL('../src/notify.mjs', import.meta.url), 'utf8');
  assert.match(src, /\$env:RODIZIO_TITULO/);
  assert.match(src, /\$env:RODIZIO_TEXTO/);
});

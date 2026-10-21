import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HOST_RE, Machines, openRemotePanel, reason, sshArgs, summarize } from '../src/machines.mjs';
import { routes } from '../src/server.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-maquinas-'));

/** What `rodizio status --json` prints there (a trimmed core.view()). */
const remoteState = (over = {}) => ({
  version: '0.6.0',
  platform: 'linux',
  port: 47001,
  config: { auto: true },
  trigger: 95,
  mainEmail: 'a@x.com',
  events: [{ text: 'not shown here' }],
  accounts: [
    { id: '1', email: 'a@x.com', plan: 'Max 20x', status: 'ativa', active: true, position: 1, slot: 0, weekly: { pct: 41.5, resetsAt: 1 }, fiveHour: { pct: 12, resetsAt: null }, cost: 99 },
    { id: '2', email: 'b@x.com', plan: 'Max 5x', status: 'livre', active: false, position: 2, slot: 1, weekly: null, fiveHour: null },
  ],
  ...over,
});

const answer = (code, out = '', err = '') => async () => ({ code, out, err });

test('machines: a host is a name from ~/.ssh/config, never an ssh option or a shell word', () => {
  for (const ok of ['devbox', 'user@host.example.com', 'ec2-1-2-3-4', 'a_b']) assert.ok(HOST_RE.test(ok), ok);
  for (const bad of ['', '-oProxyCommand=touch x', 'a b', 'a;b', '$(x)', 'a/b', '.hidden', 'x'.repeat(101)]) assert.ok(!HOST_RE.test(bad), bad);
  const args = sshArgs('devbox', 'rodizio status --json');
  assert.deepEqual(args.slice(-3), ['--', 'devbox', 'rodizio status --json']);
  assert.ok(args.includes('BatchMode=yes'));
});

test('machines: only what the card shows comes across, typed', () => {
  const s = summarize(remoteState());
  assert.deepEqual(Object.keys(s).sort(), ['accounts', 'auto', 'mainEmail', 'platform', 'port', 'trigger', 'version']);
  assert.deepEqual(s.accounts[0], { email: 'a@x.com', plan: 'Max 20x', status: 'ativa', active: true, position: 1, slot: 0, weekly: { pct: 41.5, resetsAt: 1 }, fiveHour: { pct: 12, resetsAt: null } });
  assert.equal(s.accounts[1].weekly, null);
  assert.deepEqual(summarize(remoteState({ port: 'x', version: 7, accounts: [{ email: {}, weekly: { pct: 'NaN' } }] })), {
    version: null, platform: 'linux', port: null, auto: true, trigger: 95, mainEmail: 'a@x.com',
    accounts: [{ email: '?', plan: null, status: null, active: false, position: null, slot: null, weekly: { pct: null, resetsAt: null }, fiveHour: null }],
  });
  assert.throws(() => summarize({}), /sem contas/);
});

test('machines: why a machine did not answer, in words', () => {
  assert.match(reason({ code: 255, err: 'ssh: connect to host 1.2.3.4 port 22: Operation timed out\n' }), /sem resposta do SSH.*timed out/);
  assert.match(reason({ code: 127, err: 'zsh:1: command not found: rodizio' }), /não está instalado lá/);
  assert.match(reason({ code: 1, err: 'bash: rodizio: command not found' }), /não está instalado lá/);
  assert.match(reason({ code: 1, out: '{"erro":"o agente de lá não responde em 127.0.0.1:47001"}' }), /não responde/);
  assert.match(reason({ code: 1, err: 'rodizio: o rodízio ainda não foi instalado: rode `rodizio instalar`' }), /rode `rodizio instalar` lá/);
});

test('machines: add asks the machine at once and keeps it in ~/.rodizio/maquinas.json', async () => {
  const home = tmp();
  const calls = [];
  let changes = 0;
  const m = new Machines({ home, clock: () => 1000, onChange: () => changes++, run: async (host, cmd) => (calls.push([host, cmd]), { code: 0, out: JSON.stringify(remoteState()), err: '' }) });
  m.add(' devbox ');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'maquinas.json'), 'utf8')), { hosts: ['devbox'] });
  assert.equal(m.view()[0].checking, true);
  await m.poll('devbox');
  assert.deepEqual(calls, [['devbox', 'PATH="$HOME/.local/bin:$PATH" rodizio status --json']]);
  const v = m.view()[0];
  assert.equal(v.ok, true);
  assert.equal(v.seenAt, 1000);
  assert.equal(v.checking, false);
  assert.equal(v.data.accounts.length, 2);
  assert.ok(changes >= 2);
  assert.throws(() => m.add('devbox'), /já está/);
  assert.throws(() => m.add('-oProxyCommand=x'), /nome do host/);
});

test('machines: a machine that stops answering keeps its last reading, marked old, until it answers again', async () => {
  const home = tmp();
  let run = answer(0, JSON.stringify(remoteState()));
  let t = 1000;
  const m = new Machines({ home, clock: () => t, run: (...a) => run(...a) });
  m.add('devbox');
  await m.poll('devbox');
  run = answer(255, '', 'ssh: connect to host devbox port 22: Connection refused');
  t = 2000;
  await m.poll('devbox');
  const v = m.view()[0];
  assert.equal(v.ok, false);
  assert.match(v.error, /sem resposta do SSH/);
  assert.equal(v.at, 2000);
  assert.equal(v.seenAt, 1000);
  assert.equal(v.data.accounts[0].email, 'a@x.com');
  run = answer(0, 'not json');
  await m.poll('devbox');
  assert.match(m.view()[0].error, /não entendi/);
});

test('machines: one consultation at a time per machine; removing forgets it', async () => {
  const home = tmp();
  let n = 0;
  let release;
  const m = new Machines({ home, run: () => (n++, new Promise((r) => (release = () => r({ code: 0, out: JSON.stringify(remoteState()), err: '' })))) });
  m.add('devbox');
  const again = m.poll('devbox');
  assert.equal(n, 1);
  release();
  await again;
  m.remove('devbox');
  assert.deepEqual(m.view(), []);
  assert.throws(() => m.remove('devbox'), /não está nas máquinas/);
  assert.throws(() => m.known('other'), /não está nas máquinas/);
});

test('machines: the list on disk is checked again when read (a hand-edited file cannot slip in an option)', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'maquinas.json'), JSON.stringify({ hosts: ['devbox', '-oProxyCommand=x', 42] }));
  assert.deepEqual(new Machines({ home, run: answer(0) }).hosts(), ['devbox']);
});

test("machines: the other dashboard opens here through a tunnel on its own port, with the key it gives", async () => {
  const opened = [];
  const tunnels = [];
  const run = async (host, cmd) => {
    assert.equal(cmd, 'PATH="$HOME/.local/bin:$PATH" rodizio painel --url');
    return { code: 0, out: `✓ agente religado\nhttp://rodizio.localhost:47001/#t=${'k'.repeat(43)}\n`, err: '' };
  };
  const base = await openRemotePanel('devbox', { run, ownPort: 41000, open: (u) => opened.push(u), tunnel: (h, p) => tunnels.push([h, p]) });
  assert.equal(base, 'http://rodizio.localhost:47001/');
  assert.deepEqual(tunnels, [['devbox', 47001]]);
  assert.deepEqual(opened, [`http://rodizio.localhost:47001/#t=${'k'.repeat(43)}`]);
  await assert.rejects(openRemotePanel('devbox', { run, ownPort: 47001, open() {}, tunnel() {} }), /mesma porta/);
  await assert.rejects(openRemotePanel('devbox', { run: answer(0, 'http://evil.example/#t=x'), open() {}, tunnel() {} }), /não deu o endereço/);
  await assert.rejects(openRemotePanel('-oProxyCommand=x', { run, open() {}, tunnel() {} }), /host inválido/);
});

test('machines: dashboard routes act on known machines only, and say so on an agent without them', async () => {
  const home = tmp();
  const m = new Machines({ home, run: answer(0, JSON.stringify(remoteState())) });
  const core = { machines: m, view: () => ({ accounts: [], machines: m.view() }) };
  const call = (method, url, body = {}) => {
    const [, re, fn] = routes(core).find(([mm, re]) => mm === method && re.test(url));
    return fn(re.exec(url).slice(1), body);
  };
  const v = await call('POST', '/api/machines', { host: 'devbox' });
  assert.equal(v.machines[0].host, 'devbox');
  assert.equal((await call('POST', '/api/machines/devbox/check')).machines[0].ok, true);
  assert.throws(() => call('POST', '/api/machines/other/open'), /não está nas máquinas/);
  assert.deepEqual((await call('POST', '/api/machines/devbox/remove')).machines, []);
  const bare = { view: () => ({}) };
  const [, , add] = routes(bare).find(([mm, re]) => mm === 'POST' && re.test('/api/machines'));
  assert.throws(() => add([], { host: 'devbox' }), /não estão disponíveis/);
});

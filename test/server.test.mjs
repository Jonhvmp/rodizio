import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createServer } from '../src/server.mjs';
import { A, B, connect, putMain, setup } from './helpers.mjs';

let env;
let server;
let port;
const token = 't'.repeat(32);

function call(method, route, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: route, headers: { Host: `127.0.0.1:${port}`, 'X-Rodizio-Token': token, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: () => JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body));
    else req.end();
  });
}

before(async () => {
  env = setup();
  await putMain(env, 'ta-live', A);
  await connect(env, A);
  await connect(env, B);
  await env.core.tick();
  server = createServer(env.core, { port: 0, token });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  // the allowed Host is fixed when the server is created: recreate it on the real port
  server.close();
  server = createServer(env.core, { port, token });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(() => server.close());

test('answers only to its own host name (DNS rebinding)', async () => {
  const r = await call('GET', '/api/state', { headers: { Host: `evil.example:${port}` } });
  assert.equal(r.status, 421);
});

test('every /api call needs the token', async () => {
  assert.equal((await call('GET', '/api/state', { headers: { 'X-Rodizio-Token': 'x' } })).status, 403);
  assert.equal((await call('POST', '/api/config', { headers: { 'X-Rodizio-Token': '' }, body: { auto: false } })).status, 403);
  assert.equal(env.core.config.auto, true);
});

test('rejects calls from another origin even with the token', async () => {
  const r = await call('POST', '/api/config', { headers: { Origin: 'http://evil.example' }, body: { auto: false } });
  assert.equal(r.status, 403);
});

test('the page never carries the token, and has strict headers', async () => {
  const r = await call('GET', '/', { headers: { 'X-Rodizio-Token': '' } });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(token));
  assert.match(r.text, /location\.hash/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('state lists the accounts without any secret', async () => {
  const r = await call('GET', '/api/state');
  assert.equal(r.status, 200);
  const s = r.json();
  assert.equal(s.accounts.length, 2);
  assert.equal(s.accounts[0].email, A.email);
  assert.equal(s.accounts[0].active, true);
  assert.ok(!r.text.includes('ta-live') && !r.text.includes('r-ta') && !r.text.includes('mcp-secret'));
});

test('config changes are validated', async () => {
  let r = await call('POST', '/api/config', { body: { remainingPct: 3 } });
  assert.equal(r.status, 200);
  assert.equal(r.json().config.remainingPct, 3);
  assert.equal(r.json().trigger, 97);
  r = await call('POST', '/api/config', { body: { remainingPct: 80 } });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/config', { body: { auto: 'sim' } });
  assert.equal(r.status, 400);
});

test('manual switch through the API', async () => {
  const b = Object.values(env.core.state.accounts).find((a) => a.email === B.email);
  const r = await call('POST', `/api/accounts/${b.id}/use`);
  assert.equal(r.status, 200);
  assert.equal(r.json().active, b.id);
  assert.equal(env.core.state.pinned, true);
});

test('a fixed, easy address and the pieces that make the dashboard installable, all without secrets', async () => {
  assert.equal((await call('GET', '/api/state', { headers: { Host: `rodizio.localhost:${port}` } })).status, 200);
  const h = await call('GET', '/healthz', { headers: { 'X-Rodizio-Token': '' } });
  assert.equal(h.status, 200);
  assert.equal(h.json().ok, true);
  assert.match(h.json().version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(h.json()).sort(), ['ok', 'pid', 'version']);
  const m = await call('GET', '/manifest.webmanifest', { headers: { 'X-Rodizio-Token': '' } });
  assert.equal(m.json().display, 'standalone');
  assert.ok(!m.text.includes(token));
  assert.equal((await call('GET', '/icon.svg', { headers: { 'X-Rodizio-Token': '' } })).headers['content-type'], 'image/svg+xml');
  assert.equal((await call('GET', '/healthz', { headers: { Host: `evil.example:${port}` } })).status, 421);
});

test('the live stream sends the state at once and again the moment it changes', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { 'X-Rodizio-Token': token } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const nextEvent = async () => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buf += value;
    }
  };
  const first = await nextEvent();
  assert.ok(Array.isArray(first.accounts));
  const started = Date.now();
  await env.core.setConfig({ notify: !first.config.notify });
  const second = await nextEvent();
  assert.equal(second.config.notify, !first.config.notify);
  assert.ok(Date.now() - started < 1000, 'pushed right away, not on a timer');
  await reader.cancel();
  // and no token, no stream
  assert.equal((await call('GET', '/api/stream', { headers: { 'X-Rodizio-Token': 'x' } })).status, 403);
});

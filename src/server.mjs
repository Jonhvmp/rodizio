// The dashboard: 127.0.0.1 only. Every /api call needs the token, which reaches the page in the address that
// `rodizio painel` opens (#t=…, never sent to the server) and stays in that browser; the page itself carries no
// secret, so any local program may fetch it. The Host header must be ours, which stops DNS rebinding.

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../web/index.html', import.meta.url));
const MAX_BODY = 64 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

export function routes(core) {
  return [
    ['GET', /^\/api\/state$/, () => core.view()],
    ['POST', /^\/api\/refresh$/, async () => (await core.refresh(), core.view())],
    ['POST', /^\/api\/config$/, async (_, body) => (await core.setConfig(body), core.view())],
    ['POST', /^\/api\/order$/, async (_, body) => (await core.setOrder(body.ids), core.view())],
    ['POST', /^\/api\/accounts\/connect$/, (_, body) => core.startLogin({ email: body.email || null })],
    ['POST', /^\/api\/accounts\/adopt$/, async () => (await core.adoptCurrent(), core.view())],
    ['POST', /^\/api\/accounts\/([a-f0-9]+)\/reconnect$/, ([id]) => core.startLogin({ reconnectOf: id })],
    ['POST', /^\/api\/accounts\/([a-f0-9]+)\/use$/, async ([id]) => (await core.switchTo(id, 'troca manual pelo painel'), core.view())],
    ['POST', /^\/api\/accounts\/([a-f0-9]+)\/pause$/, async ([id], body) => (await core.setPaused(id, body.paused), core.view())],
    ['POST', /^\/api\/accounts\/([a-f0-9]+)\/remove$/, async ([id]) => (await core.removeAccount(id), core.view())],
    ['GET', /^\/api\/jobs\/([a-f0-9]+)$/, ([id]) => core.job(id).view()],
    ['POST', /^\/api\/jobs\/([a-f0-9]+)\/code$/, ([id], body) => (core.job(id).sendCode(body.code), core.job(id).view())],
    ['POST', /^\/api\/jobs\/([a-f0-9]+)\/cancel$/, ([id]) => (core.job(id).cancel(), core.job(id).view())],
  ];
}

const MANIFEST = {
  name: 'Rodízio',
  short_name: 'Rodízio',
  description: 'Rodízio local das contas do Claude Code',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f9f9f7',
  theme_color: '#0b0b0b',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
};
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="115" fill="#0b0b0b"/><rect x="112" y="216" width="288" height="80" rx="40" fill="#fcfcfb" transform="rotate(-30 256 256)"/><circle cx="376" cy="188" r="23" fill="#eb6834"/></svg>';

/** How long a burst of changes is gathered into one push, and how often the state is sent anyway (it ages). */
export const PUSH_GATHER_MS = 120;
export const PUSH_EVERY_MS = 15_000;
const MAX_STREAMS = 16;

export function createServer(core, { port, token }) {
  const streams = new Set();

  /**
   * The dashboard's live view: the whole state, pushed the moment it changes (server-sent events over a fetch that
   * carries the token in a header, never in the address).
   */
  function stream(req, res) {
    if (streams.size >= MAX_STREAMS) return send(res, 429, { erro: 'painéis abertos demais' });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const push = () => {
      try {
        res.write(`data: ${JSON.stringify(core.view())}\n\n`);
      } catch {
        // the client went away; 'close' cleans up
      }
    };
    let pending = null;
    const off = core.onChange(() => {
      pending ??= setTimeout(() => {
        pending = null;
        push();
      }, PUSH_GATHER_MS);
    });
    const beat = setInterval(push, PUSH_EVERY_MS);
    const entry = { res };
    streams.add(entry);
    req.on('close', () => {
      off();
      clearInterval(beat);
      clearTimeout(pending);
      streams.delete(entry);
    });
    push();
  }

  // rodizio.localhost: any *.localhost name resolves to this machine in the browser, so it is a fixed, easy address.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `rodizio.localhost:${port}`]);
  const table = routes(core);
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, { erro: e.message });
      else res.end();
    });
  });

  async function handle(req, res) {
    if (!hosts.has(req.headers.host ?? '')) return send(res, 421, { erro: 'endereço não permitido' });
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(PAGE, 'utf8'));
    }
    // No secret in these: the watchdog's check, and what lets the browser install the dashboard as an app.
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/manifest+json' });
      return res.end(JSON.stringify(MANIFEST));
    }
    if (req.method === 'GET' && url.pathname === '/icon.svg') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/svg+xml' });
      return res.end(ICON);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { erro: 'não encontrado' });
    if (!sameToken(req.headers['x-rodizio-token'], token)) return send(res, 403, { erro: 'token inválido' });
    const origin = req.headers.origin;
    if (origin && !hosts.has(origin.replace(/^http:\/\//, ''))) return send(res, 403, { erro: 'origem não permitida' });

    if (req.method === 'GET' && url.pathname === '/api/stream') return stream(req, res);

    const route = table.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) return send(res, 404, { erro: 'não encontrado' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const params = route[1].exec(url.pathname).slice(1);
      send(res, 200, await route[2](params, body));
    } catch (e) {
      send(res, 400, { erro: e.message });
    }
  }
}

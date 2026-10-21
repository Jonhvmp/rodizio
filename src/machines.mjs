// Other computers with a rodízio of their own (a cloud dev box, say), watched from this one over SSH. Each machine keeps
// its own logins and decides for itself; this side only asks `rodizio status --json` there, once a minute, and shows a
// summary. Nothing listens on the network for it: ssh does all of it with your ~/.ssh/config, never asking for a
// password (BatchMode) and never waking a machine that is off or asleep (it just shows no answer).
//
// The other machine's own dashboard opens here through a tunnel to its port, with the key it gives over the same SSH.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { nowS, readJson, writeJsonAtomic } from './util.mjs';

/** A host as written in ~/.ssh/config: never an option (no leading dash), never anything a shell would read. */
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/;
export const POLL_EVERY_MS = 60_000;
const TIMEOUT_MS = 25_000;
const MAX_OUT = 2 * 1024 * 1024;
const MAX_MACHINES = 8;
const MAX_ACCOUNTS = 20;
/** The rodízio command where `instalar` puts it, even when ~/.local/bin is not in the PATH ssh gets there. */
const THERE = 'PATH="$HOME/.local/bin:$PATH" rodizio';

/** Never a prompt (a password, an unknown host key): an unattended consultation must fail instead of hanging. */
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];

export const sshArgs = (host, command) => [...SSH_OPTS, '--', host, command];

/** ssh `host` `command`: {code, out, err}, the output capped, killed after the timeout. */
export function sshRun(host, command, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn('ssh', sshArgs(host, command), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, out, err: e.message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUT) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < 4000) err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** Why a machine gave no state, in words for the dashboard. */
export function reason({ code, out = '', err = '' }) {
  try {
    const j = JSON.parse(out);
    if (j?.erro) return String(j.erro).slice(0, 200);
  } catch {
    // not the JSON of an agent that is down
  }
  const last = err.trim().split('\n').filter(Boolean).at(-1) ?? '';
  if (code === 255) return `sem resposta do SSH: desligada, hibernando ou fora da rede?${last ? ` (${last.slice(0, 160)})` : ''}`;
  // bash says "rodizio: command not found", zsh "command not found: rodizio"
  if (code === 127 || /command not found|rodizio: not found/.test(err)) return 'o rodízio não está instalado lá (ou não está em ~/.local/bin)';
  if (/ainda não foi instalado/.test(err)) return 'o rodízio está lá, mas não foi instalado: rode `rodizio instalar` lá';
  return (last || `saiu com código ${code}`).slice(0, 200);
}

const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) ? v : null);
const win = (w) => (w && typeof w === 'object' ? { pct: num(w.pct), resetsAt: num(w.resetsAt) } : null);

/** What this dashboard shows of another machine: who has the baton and how each account is, typed and trimmed. */
export function summarize(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.accounts)) throw new Error('resposta sem contas');
  return {
    version: str(s.version),
    platform: str(s.platform),
    port: int(s.port),
    auto: !!s.config?.auto,
    trigger: num(s.trigger),
    mainEmail: str(s.mainEmail),
    accounts: s.accounts.slice(0, MAX_ACCOUNTS).map((a) => ({
      email: str(a?.email) ?? '?',
      plan: str(a?.plan),
      status: str(a?.status),
      active: !!a?.active,
      position: int(a?.position),
      slot: int(a?.slot),
      weekly: win(a?.weekly),
      fiveHour: win(a?.fiveHour),
    })),
  };
}

export class Machines {
  constructor({ home, run = sshRun, onChange = () => {}, log = console, everyMs = POLL_EVERY_MS, clock = nowS }) {
    Object.assign(this, { run, onChange, log, everyMs, clock });
    this.file = path.join(home, 'maquinas.json');
    /** host → the last answer: {ok, at, error, data, seenAt} */
    this.snapshots = new Map();
    /** host → the consultation in flight */
    this.inFlight = new Map();
    this.timer = null;
  }

  hosts() {
    const list = readJson(this.file, {})?.hosts;
    return Array.isArray(list) ? list.filter((h) => typeof h === 'string' && HOST_RE.test(h)) : [];
  }

  view() {
    return this.hosts().map((host) => ({
      host,
      ok: null,
      at: null,
      error: null,
      data: null,
      seenAt: null,
      ...this.snapshots.get(host),
      checking: this.inFlight.has(host),
    }));
  }

  known(host) {
    if (!this.hosts().includes(host)) throw new Error(`${host} não está nas máquinas`);
    return host;
  }

  /** Adds a host and asks it at once; the answer arrives with the live state, not with this call. */
  add(raw) {
    const host = String(raw ?? '').trim();
    if (!HOST_RE.test(host)) throw new Error('use o nome do host como está no ~/.ssh/config: letras, números, ponto, hífen');
    const hosts = this.hosts();
    if (hosts.includes(host)) throw new Error(`${host} já está nas máquinas`);
    if (hosts.length >= MAX_MACHINES) throw new Error(`no máximo ${MAX_MACHINES} máquinas`);
    writeJsonAtomic(this.file, { hosts: [...hosts, host] });
    void this.poll(host);
    this.onChange();
  }

  remove(host) {
    this.known(host);
    writeJsonAtomic(this.file, { hosts: this.hosts().filter((h) => h !== host) });
    this.snapshots.delete(host);
    this.onChange();
  }

  /** One consultation per host at a time: a second call waits for the one in flight. */
  poll(host) {
    if (this.inFlight.has(host)) return this.inFlight.get(host);
    const prev = this.snapshots.get(host);
    const job = (async () => {
      const r = await this.run(host, `${THERE} status --json`);
      const at = this.clock();
      let snap;
      try {
        if (r.code !== 0) throw new Error(reason(r));
        snap = { ok: true, at, error: null, data: summarize(JSON.parse(r.out)), seenAt: at };
      } catch (e) {
        // the last good answer stays, marked old, so a machine asleep still shows who it had
        snap = { ok: false, at, error: e instanceof SyntaxError ? 'resposta que não entendi (versão diferente lá?)' : e.message, data: prev?.data ?? null, seenAt: prev?.seenAt ?? null };
      }
      if (this.hosts().includes(host)) this.snapshots.set(host, snap);
    })()
      .catch((e) => this.log.error?.(`máquina ${host}: ${e.message}`))
      .finally(() => {
        this.inFlight.delete(host);
        this.onChange();
      });
    this.inFlight.set(host, job);
    this.onChange();
    return job;
  }

  start() {
    const all = () => {
      for (const h of this.hosts()) void this.poll(h);
    };
    this.timer = setInterval(all, this.everyMs);
    this.timer.unref?.();
    all();
  }

  stop() {
    clearInterval(this.timer);
  }
}

/** Whether a rodízio dashboard answers on this port here (a tunnel opened before, still up). */
async function answers(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return r.status === 200 && (await r.json())?.ok === true;
  } catch {
    return false;
  }
}

/**
 * The other machine's dashboard, opened here: its address and key asked over SSH, a tunnel from the same port here to
 * its 127.0.0.1 (so the address, and the Host it checks, are the ones it expects), then the browser. Resolves to the
 * address without the key.
 */
export async function openRemotePanel(host, { run = sshRun, ownPort = null, open = (url) => spawnSync('open', [url]), tunnel = openTunnel } = {}) {
  if (!HOST_RE.test(host)) throw new Error('host inválido');
  const r = await run(host, `${THERE} painel --url`);
  if (r.code !== 0) throw new Error(`${host}: ${reason(r)}`);
  const m = /^http:\/\/rodizio\.localhost:(\d{2,5})\/#t=([A-Za-z0-9_-]{32,})\s*$/m.exec(r.out);
  if (!m) throw new Error(`${host} não deu o endereço do painel (versão antiga lá? rode \`rodizio atualizar\` lá)`);
  const port = Number(m[1]);
  if (port === ownPort) throw new Error(`o painel de ${host} usa a mesma porta (${port}) que o deste computador: troque a porta de um deles`);
  if (!(await answers(port))) tunnel(host, port);
  const base = `http://rodizio.localhost:${port}/`;
  open(`${base}#t=${m[2]}`);
  return base;
}

/** A tunnel in the background, apart from any shared SSH connection, that ends when the other machine goes away. */
export function openTunnel(host, port) {
  const r = spawnSync(
    'ssh',
    ['-fNT', '-o', 'ExitOnForwardFailure=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...SSH_OPTS, '-L', `${port}:127.0.0.1:${port}`, '--', host],
    { stdio: 'ignore', timeout: 30_000 },
  );
  if (r.status !== 0) throw new Error(`não consegui abrir o túnel para a porta ${port} de ${host} (ela está ocupada aqui?)`);
}

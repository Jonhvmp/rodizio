// One official login (`claude auth login`) in a fresh account folder, followed from the dashboard.

import fs from 'node:fs';
import path from 'node:path';
import { stripAnsi } from './util.mjs';

const LOGIN_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];
const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** Only an https address of the official login, with no credentials or port, is shown or opened. */
export function loginUrl(s) {
  try {
    const u = new URL(String(s).trim());
    const host = u.hostname.toLowerCase();
    const official = LOGIN_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && official ? u.toString() : null;
  } catch {
    return null;
  }
}

// A private window has no claude.ai session open, so the login cannot land on the wrong account.
const PRIVATE_BROWSERS = [
  { name: 'Brave Browser', flag: '--incognito' },
  { name: 'Google Chrome', flag: '--incognito' },
  { name: 'Firefox', flag: '-private-window' },
];

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The $BROWSER that `claude auth login` calls: remembers the address for the dashboard, then opens it. Off macOS (a
 * server with no browser) it opens nothing and remembers nothing: that address finishes on a localhost callback that
 * only this machine can answer, so the dashboard offers only the link that ends in a code to paste.
 */
export function browserScript(urlFile, incognito, appsDir = '/Applications', platform = process.platform) {
  if (platform !== 'darwin') return '#!/bin/sh\nexit 0\n';
  const lines = ['#!/bin/sh', `printf '%s\\n' "$1" > ${shq(urlFile)}`];
  if (incognito) {
    for (const b of PRIVATE_BROWSERS) {
      lines.push(`[ -d ${shq(path.join(appsDir, `${b.name}.app`))} ] && exec open -na ${shq(b.name)} --args ${b.flag} "$1"`);
    }
  }
  lines.push('exec open "$1"');
  return lines.join('\n') + '\n';
}

export class LoginJob {
  constructor({ id, dir, email = null, reconnectOf = null, cli, incognito, onSuccess, onFail, onUpdate = () => {} }) {
    Object.assign(this, { id, dir, email, reconnectOf, cli, incognito, onSuccess, onFail, onUpdate });
    this.status = 'iniciando';
    this.output = '';
    this.manualUrl = null;
    this.error = null;
    this.result = null;
    this.startedAt = Date.now();
  }

  /** Every step of the login is pushed to the dashboard as it happens. */
  setStatus(status) {
    this.status = status;
    this.onUpdate(this);
  }

  get running() {
    return ['iniciando', 'aguardando', 'finalizando'].includes(this.status);
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.urlFile = path.join(this.dir, '.login-url');
    const script = path.join(this.dir, '.abrir-login');
    fs.writeFileSync(script, browserScript(this.urlFile, this.incognito), { mode: 0o700 });
    this.child = this.cli.login(this.dir, { email: this.email, browser: script });
    this.setStatus('aguardando');
    const onData = (d) => {
      this.output = (this.output + stripAnsi(d)).slice(-8000);
      for (const m of this.output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
        const u = loginUrl(m[0]);
        if (u && u !== this.browserUrl() && u !== this.manualUrl) {
          this.manualUrl = u;
          this.onUpdate(this);
        }
      }
    };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.stdin.on('error', () => {});
    this.child.on('error', (e) => (this.output += `\n${e.message}`));
    this.child.on('close', (code) => void this.finish(code));
    this.timer = setTimeout(() => this.cancel('o login passou de 15 minutos sem terminar; abra de novo e conclua na janela que abrir'), LOGIN_TIMEOUT_MS);
    this.timer.unref?.();
  }

  browserUrl() {
    try {
      return loginUrl(fs.readFileSync(this.urlFile, 'utf8'));
    } catch {
      return null;
    }
  }

  /** The code the login page shows when the link was opened somewhere else. */
  sendCode(code) {
    if (this.status !== 'aguardando') throw new Error('esse login não está esperando código');
    const c = String(code ?? '').trim();
    if (/^\d{4,8}$/.test(c)) {
      throw new Error('Esse é o código do e-mail: digite-o na página do claude.ai, na janela de login. Aqui vai só o código longo que a página de autorização mostra.');
    }
    if (!/^[A-Za-z0-9#_\-.~]{8,512}$/.test(c)) throw new Error('código inválido');
    this.child.stdin.write(`${c}\n`);
  }

  cancel(reason = 'cancelado') {
    if (this.status !== 'aguardando' && this.status !== 'iniciando') return;
    this.cancelReason = reason;
    this.child?.kill('SIGTERM');
    // A login that ignores SIGTERM would hold the "one login at a time" slot until the agent restarts.
    setTimeout(() => {
      if (this.running) this.child?.kill('SIGKILL');
    }, 5000).unref?.();
  }

  async finish(code) {
    clearTimeout(this.timer);
    if (code === 0 && !this.cancelReason) {
      this.setStatus('finalizando');
      try {
        this.result = await this.onSuccess(this);
        this.setStatus('concluido');
        return;
      } catch (e) {
        this.error = e.message;
      }
    } else {
      const tail = this.output.trim().split('\n').slice(-3).join(' ').trim();
      this.error = this.cancelReason ?? (tail || `o login saiu com código ${code}`);
    }
    try {
      await this.onFail(this);
    } catch {
      // the folder stays for a later cleanup
    }
    this.setStatus(this.cancelReason ? 'cancelado' : 'erro');
  }

  view() {
    return {
      id: this.id,
      status: this.status,
      email: this.result?.email ?? this.email,
      plan: this.result?.plan?.label ?? null,
      error: this.error,
      browserUrl: this.browserUrl(),
      manualUrl: this.manualUrl,
      reconnectOf: this.reconnectOf,
      startedAt: this.startedAt,
    };
  }
}

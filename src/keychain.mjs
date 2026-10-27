// Where Claude Code keeps a login: on macOS, a Keychain item read and written through `security`, the same tool Claude
// Code uses for its own items; on Linux, a .credentials.json file in the config folder. Both answer to the same names
// (services), so the rotation does not know which one it is talking to.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, run, writeJsonAtomic } from './util.mjs';

export const MAIN_SERVICE = 'Claude Code-credentials';
/** The file Claude Code keeps the login in, on Linux, inside the config folder (~/.claude, or CLAUDE_CONFIG_DIR). */
export const CREDENTIALS_FILE = '.credentials.json';

/** service → folder, for every folder named here: on Linux the service is only a name, and the file is in the folder. */
const folders = new Map();

/** Claude Code names the item of a non-default CLAUDE_CONFIG_DIR after a hash of that path. */
export function serviceForDir(dir) {
  const service = `${MAIN_SERVICE}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
  folders.set(service, dir);
  return service;
}

const NOT_FOUND = 44;
// `security -i` cuts input lines at about 4 KB. Longer values go through argv, as Claude Code does, and are
// briefly visible in the process list to processes of the same user.
const MAX_INTERACTIVE_LINE = 4000;

/** `security -w` prints hex instead of text when the value has bytes outside printable ASCII. */
export function decodeSecret(out) {
  const t = out.trim();
  if (!t) return null;
  if (/^[0-9a-f]+$/i.test(t) && t.length % 2 === 0) {
    const s = Buffer.from(t, 'hex').toString('utf8');
    if (s.trimStart().startsWith('{')) return s;
  }
  return t;
}

export class MacKeychain {
  constructor({ account = process.env.USER || os.userInfo().username, runner = run } = {}) {
    this.account = account;
    this.run = runner;
  }

  /** null when the item does not exist; throws when the Keychain does not answer or the item is not JSON. */
  async read(service) {
    const r = await this.run(['security', 'find-generic-password', '-a', this.account, '-s', service, '-w']);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`o Keychain não respondeu (${service})`);
    const text = decodeSecret(r.out);
    if (!text) return null;
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  }

  async write(service, obj) {
    if (/["\n\r]/.test(service) || /["\n\r]/.test(this.account)) throw new Error('nome inválido para o Keychain');
    const hex = Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
    const line = `add-generic-password -U -a "${this.account}" -s "${service}" -X ${hex}\n`;
    const r =
      line.length <= MAX_INTERACTIVE_LINE
        ? await this.run(['security', '-i'], { input: line })
        : await this.run(['security', 'add-generic-password', '-U', '-a', this.account, '-s', service, '-X', hex]);
    if (r.code !== 0) throw new Error(`não consegui gravar no Keychain (${service})`);
    // `security -i` exits 0 even when the command inside it fails: only reading it back proves the write.
    const back = await this.read(service);
    if (JSON.stringify(back) !== JSON.stringify(obj)) throw new Error(`o Keychain não confirmou a gravação (${service})`);
  }

  async remove(service) {
    await this.run(['security', 'delete-generic-password', '-a', this.account, '-s', service]);
  }
}

/**
 * Linux: the .credentials.json Claude Code itself reads, ~/.claude for the main login and the account's own folder for
 * the others, only for this user (0600, folders 0700). A service the agent never named this run (it names every
 * account folder when it loads them) is looked up among the folders in `accountsDir`.
 */
export class LinuxKeychain {
  constructor({ home = os.homedir(), accountsDir = null } = {}) {
    this.home = home;
    this.accountsDir = accountsDir;
  }

  fileFor(service) {
    if (service === MAIN_SERVICE) return path.join(this.home, '.claude', CREDENTIALS_FILE);
    let dir = folders.get(service);
    if (!dir && this.accountsDir) {
      let names = [];
      try {
        names = fs.readdirSync(this.accountsDir);
      } catch {
        // no account folder yet
      }
      dir = names.map((n) => path.join(this.accountsDir, n)).find((d) => serviceForDir(d) === service);
    }
    if (!dir) throw new Error(`não sei em que pasta fica o login ${service}`);
    return path.join(dir, CREDENTIALS_FILE);
  }

  /** null when there is no login there; throws when the file is unreadable or not JSON, like the Keychain. */
  async read(service) {
    const file = this.fileFor(service);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`não consegui ler ${file}`);
    }
    if (!text.trim()) return null;
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  }

  /** Atomic (Claude Code may be reading it at the same moment), and read back like the Keychain write. */
  async write(service, obj) {
    const file = this.fileFor(service);
    writeJsonAtomic(file, obj, 0o600);
    const back = await this.read(service);
    if (JSON.stringify(back) !== JSON.stringify(obj)) throw new Error(`não confirmei a gravação de ${file}`);
  }

  async remove(service) {
    fs.rmSync(this.fileFor(service), { force: true });
  }
}

/** The store of this system: the Keychain on macOS, the credential files on Linux and Windows (the same layout). */
export function systemKeychain({ accountsDir = null, platform = process.platform } = {}) {
  return platform === 'darwin' ? new MacKeychain() : new LinuxKeychain({ accountsDir });
}

/** Stand-in used by the demo: same interface, a plain JSON file. */
export class FileKeychain {
  constructor(file) {
    this.file = file;
  }

  async read(service) {
    return readJson(this.file, {})[service] ?? null;
  }

  async write(service, obj) {
    const all = readJson(this.file, {});
    all[service] = obj;
    writeJsonAtomic(this.file, all);
  }

  async remove(service) {
    const all = readJson(this.file, {});
    delete all[service];
    writeJsonAtomic(this.file, all);
  }
}

// macOS Keychain through `security`, the same tool Claude Code uses for its own items.

import { createHash } from 'node:crypto';
import os from 'node:os';
import { readJson, run, writeJsonAtomic } from './util.mjs';

export const MAIN_SERVICE = 'Claude Code-credentials';

/** Claude Code names the item of a non-default CLAUDE_CONFIG_DIR after a hash of that path. */
export function serviceForDir(dir) {
  return `${MAIN_SERVICE}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
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

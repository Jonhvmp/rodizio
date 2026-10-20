// `oauthAccount` in ~/.claude.json tells Claude Code whose login it holds. The file has much more in it and Claude
// Code writes it often: only that key changes, under the same directory lock Claude Code takes (`<file>.lock`).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

/** null when there is no account in it; undefined when the file cannot be read right now (half-written?). */
export function readOauthAccount(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? null : undefined;
  }
  try {
    const v = JSON.parse(raw).oauthAccount;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return undefined;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lock(file) {
  const dir = `${file}.lock`;
  for (let i = 0; i < 100; i++) {
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > 10_000) {
          fs.rmdirSync(dir);
          continue;
        }
      } catch {
        // released between the two calls
      }
      await sleep(100);
    }
  }
  return null;
}

export async function writeOauthAccount(file, account) {
  const held = await lock(file);
  if (!held) throw new Error(`${file} está travado por outro processo; tento de novo depois`);
  try {
    let data = {};
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (raw !== null) {
      // A file that does not parse may be half-written by Claude Code: writing over it would drop the rest of it.
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file} não é um objeto JSON`);
      data = v;
    }
    data.oauthAccount = account;
    const mode = raw !== null ? fs.statSync(file).mode & 0o777 : 0o600;
    const tmp = `${file}.tmp.rodizio.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode, flag: 'wx' });
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  } finally {
    fs.rmSync(held, { recursive: true, force: true });
  }
}

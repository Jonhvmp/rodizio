import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const nowS = () => Math.floor(Date.now() / 1000);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * On Windows a file another program has open at that instant (Claude Code reading its login, an antivirus scanning it)
 * cannot be replaced: the rename is tried again for a moment before giving up.
 */
export function renameRetrying(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export function writeJsonAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode, flag: 'wx' });
    renameRetrying(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Runs async jobs one at a time, in arrival order. */
export class Mutex {
  #tail = Promise.resolve();

  run(fn) {
    const job = this.#tail.then(() => fn());
    this.#tail = job.catch(() => {});
    return job;
  }
}

/** Spawns without a shell and collects the output; never rejects. */
export function run(argv, { input, timeoutMs = 20_000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env, cwd, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out, err: e.message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * Opens an address in the default browser: `open` on macOS; on Windows the shell's own handler (`start` would go
 * through cmd, which reads & and ^ in the address). Whether there was a browser to open it in.
 */
export function openUrl(url, platform = process.platform) {
  if (platform === 'darwin') return spawnSync('open', [url]).status === 0;
  if (platform === 'win32') return spawnSync('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true }).status === 0;
  return false;
}

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

// Claude Code itself, run inside an account's folder (CLAUDE_CONFIG_DIR) for the official login and renewals.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.mjs';

/**
 * On Windows, claude.exe (the native install, in ~/.local/bin too): a claude.cmd from npm would need a shell to run,
 * and nothing here is run through one.
 */
export function findClaude(env = process.env, home = os.homedir(), platform = process.platform) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dirs = [...(env.PATH || env.Path || '').split(win ? ';' : ':'), p.join(home, '.local', 'bin'), ...(win ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])];
  for (const d of dirs) {
    if (!d) continue;
    const c = p.join(d, win ? 'claude.exe' : 'claude');
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // next
    }
  }
  return 'claude';
}

/** The child must not inherit the variables of a Claude Code session that started the agent. */
export function cleanEnv(dir, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('CLAUDE_CODE_') || k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CONFIG_DIR' || k === 'CLAUDECODE') continue;
    env[k] = v;
  }
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

export class ClaudeCli {
  constructor(bin = findClaude()) {
    this.bin = bin;
  }

  /** `claude auth login`: opens $BROWSER on the login page and also prints a link that answers with a code. */
  login(dir, { email, browser } = {}) {
    const argv = ['auth', 'login', '--claudeai'];
    if (email) argv.push('--email', email);
    const env = cleanEnv(dir);
    if (browser) env.BROWSER = browser;
    return spawn(this.bin, argv, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }

  /** Lets Claude Code refresh a parked account's token. Never call it for the account in use. */
  renew(dir) {
    return run([this.bin, 'auth', 'status', '--json'], { cwd: dir, env: cleanEnv(dir), timeoutMs: 60_000 });
  }
}

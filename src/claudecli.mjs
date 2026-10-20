// Claude Code itself, run inside an account's folder (CLAUDE_CONFIG_DIR) for the official login and renewals.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.mjs';

export function findClaude(env = process.env, home = os.homedir()) {
  const dirs = [...(env.PATH || '').split(':'), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const c = path.join(d, 'claude');
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
    return spawn(this.bin, argv, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /** Lets Claude Code refresh a parked account's token. Never call it for the account in use. */
  renew(dir) {
    return run([this.bin, 'auth', 'status', '--json'], { cwd: dir, env: cleanEnv(dir), timeoutMs: 60_000 });
  }
}

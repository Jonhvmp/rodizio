import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { nowS, readJson, writeJsonAtomic } from './util.mjs';

export const DEFAULT_CONFIG = {
  /** Switch when this much of the weekly limit is left (5 → at 95% used). */
  remainingPct: 5,
  /** Also switch near the end of the 5-hour window, with its own margin. */
  fiveHourSwitch: true,
  fiveHourRemainingPct: 5,
  auto: true,
  returnToPreferred: true,
  notify: true,
  /** Read usage from api.anthropic.com with each account's own token. Off: only the status line measures. */
  useApi: true,
  pollParked: true,
  incognitoLogin: true,
  /** Install new published versions by themselves (signed releases only; see update.mjs). */
  autoUpdate: true,
  order: [],
};

export const CONFIG_KEYS = ['remainingPct', 'fiveHourSwitch', 'fiveHourRemainingPct', 'auto', 'returnToPreferred', 'notify', 'useApi', 'pollParked', 'incognitoLogin', 'autoUpdate'];
export const PCT_KEYS = new Set(['remainingPct', 'fiveHourRemainingPct']);


export function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** A random free port high enough to stay clear of the usual development servers and databases. */
export async function pickPort(rand = Math.random) {
  for (let i = 0; i < 50; i++) {
    const port = 41000 + Math.floor(rand() * 23000);
    if (await portIsFree(port)) return port;
  }
  throw new Error('não achei porta livre');
}

/** Loads the config, creating the port and the dashboard token on first run. */
export async function ensureConfig(p) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  } catch (e) {
    // An unreadable config is kept aside rather than overwritten; a new port and token are drawn.
    if (e.code !== 'ENOENT') fs.renameSync(p.config, `${p.config}.ilegivel-${Date.now()}`);
  }
  const config = { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) };
  let changed = !saved;
  if (!Number.isInteger(config.port)) {
    config.port = await pickPort();
    changed = true;
  }
  if (typeof config.token !== 'string' || config.token.length < 32) {
    config.token = randomBytes(24).toString('base64url');
    changed = true;
  }
  if (changed) writeJsonAtomic(p.config, config);
  return config;
}

export function emptyState() {
  return {
    accounts: {},
    active: null,
    activeSince: 0,
    /** Accounts switched out in the last few minutes → when; a session may still write their login back. */
    recentFrom: {},
    lastSwitchAt: 0,
    /** When each recent automatic switch happened, to catch a rotation that keeps bouncing. */
    autoSwitches: [],
    /** The account in use was picked by hand: no automatic return to the preferred one. */
    pinned: false,
    /** The last switch, until the open sessions are seen on the new account (or one is seen stuck on the old). */
    handover: null,
    mainHash: null,
    mainEmail: null,
    exhaustedAt: 0,
    sessions: {},
    /** [{id, from, to}] who held the baton when; the open segment has to = null. */
    timeline: [],
    /** accountId → [[t, weekly %, 5-hour %, weekly resetsAt, 5-hour resetsAt]] */
    history: {},
    /** accountId → day → status line activity (cost, tokens, lines) */
    activity: {},
    events: [],
  };
}

export const backupPath = (p) => `${p.state}.bak`;

/**
 * The saved state. An unreadable file never means starting over in silence: the account folders and their Keychain
 * items would be orphaned. It is kept aside, the backup is used, and without a backup the accounts are rebuilt from
 * their folders (their usage comes back with the next readings).
 */
export function loadState(p) {
  let raw;
  try {
    raw = fs.readFileSync(p.state, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('não é um objeto');
    return { ...emptyState(), ...v };
  } catch {
    const aside = `${p.state}.ilegivel-${Date.now()}`;
    fs.renameSync(p.state, aside);
    const backup = readJson(backupPath(p), null);
    const st = { ...emptyState(), ...(backup && typeof backup === 'object' ? backup : {}) };
    // The backup can be minutes old: accounts connected since then are still in their folders.
    const found = accountsFromFolders(p);
    const missing = Object.keys(found).filter((id) => !st.accounts[id]);
    for (const id of missing) st.accounts[id] = found[id];
    st.mainHash = null; // whoever is in Claude Code now is looked at again
    st.events = [
      {
        at: nowS(),
        kind: 'aviso',
        text: `O estado salvo estava ilegível (guardado em ${path.basename(aside)}); ${backup ? 'recuperei a cópia de segurança' : 'não havia cópia de segurança'}${missing.length ? ` e remontei ${missing.length} conta(s) pelas pastas` : ''}.`,
      },
      ...(st.events ?? []),
    ];
    return st;
  }
}

function accountsFromFolders(p) {
  const out = {};
  let dirs = [];
  try {
    dirs = fs.readdirSync(p.accounts, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(p.accounts, d.name);
    const oa = readJson(path.join(dir, '.claude.json'), null)?.oauthAccount;
    if (!oa?.accountUuid) continue;
    out[d.name] = {
      id: d.name,
      email: oa.emailAddress ?? '(sem e-mail)',
      uuid: oa.accountUuid,
      orgUuid: oa.organizationUuid ?? null,
      orgName: oa.organizationName ?? null,
      plan: null,
      dir,
      addedAt: Math.floor(fs.statSync(dir).mtimeMs / 1000),
      lastHash: null,
      usage: null,
      needsLogin: false,
      paused: false,
    };
  }
  return out;
}

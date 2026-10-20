// Usage and profile of an account, read with its own access token. These are the endpoints behind Claude Code's
// /usage; reading them does not rotate the token. The User-Agent says what is calling.

import fs from 'node:fs';

const BETA = 'oauth-2025-04-20';
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0';
  }
})();
const USER_AGENT = `rodizio/${VERSION} (rotacao local de contas do Claude Code)`;

function windowFromApi(w) {
  if (!w || typeof w !== 'object') return null;
  const reset = Date.parse(w.resets_at);
  return {
    pct: typeof w.utilization === 'number' ? Math.round(w.utilization * 10) / 10 : null,
    resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null,
  };
}

/**
 * Keys of the answer, with numbers, booleans and nulls kept and every string reduced to its type, for diagnosing an
 * answer that does not look as expected. Arrays keep their first item's shape.
 */
export function shapeOf(v, depth = 0, key = '') {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  // Labels of kinds and groups are enumerations, worth keeping; any other string is reduced to its type.
  if (typeof v === 'string') return LABEL_KEYS.has(key) && v.length <= 80 ? v : 'string';
  if (typeof v !== 'object') return typeof v;
  if (depth >= 4) return Array.isArray(v) ? 'array' : 'object';
  if (Array.isArray(v)) return v.map((x) => shapeOf(x, depth + 1, key)).slice(0, 12);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1, k)]));
}
const LABEL_KEYS = new Set(['kind', 'group', 'severity', 'scope', 'key', 'display_name', 'currency', 'disabled_reason', 'locked_reason', 'period']);

/**
 * A window the answer lists as null has not started: nothing used in it yet (it starts, and its reset time is set,
 * with the first use). A window missing from the answer is unknown.
 */
const windowOrUnstarted = (j, key) => (key in j && j[key] === null ? { pct: 0, resetsAt: null, unstarted: true } : windowFromApi(j[key]));

export const usageFromApi = (j) => ({
  weekly: windowOrUnstarted(j, 'seven_day'),
  fiveHour: windowOrUnstarted(j, 'five_hour'),
  // Separate weekly limits per model, when the account has them.
  opus: windowFromApi(j.seven_day_opus),
  sonnet: windowFromApi(j.seven_day_sonnet),
  shape: shapeOf(j),
});

function windowFromStatusline(w) {
  if (!w || typeof w.used_percentage !== 'number') return null;
  return {
    pct: Math.round(w.used_percentage * 10) / 10,
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null,
  };
}

/** `rate_limits` from the JSON Claude Code hands to the status line. */
export const usageFromStatusline = (rl) => ({
  weekly: windowFromStatusline(rl?.seven_day),
  fiveHour: windowFromStatusline(rl?.five_hour),
});

export function profileFromApi(j) {
  const a = j.account ?? {};
  const o = j.organization ?? {};
  return {
    uuid: a.uuid ?? null,
    email: typeof a.email === 'string' ? a.email.toLowerCase() : null,
    orgUuid: o.uuid ?? null,
    orgName: o.name ?? null,
  };
}

/** Seconds the server asked to wait (Retry-After, in seconds or as a date), or null. */
export function retryAfterOf(value, nowMs = Date.now()) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - nowMs) / 1000)) : null;
}

const TIMEOUT_MS = 10_000;

/** Status 0 means no answer at all (offline, DNS, timeout); a JSON that does not parse counts the same. */
export function createApi({ base = process.env.RODIZIO_API_BASE || 'https://api.anthropic.com', fetchImpl = fetch } = {}) {
  async function get(route, token) {
    try {
      const r = await fetchImpl(base + route, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': BETA, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.status !== 200) return { status: r.status, retryAfter: retryAfterOf(r.headers?.get?.('retry-after')), body: null };
      return { status: 200, body: await r.json() };
    } catch {
      return { status: 0, body: null };
    }
  }

  return {
    async usage(token) {
      const { status, body, retryAfter } = await get('/api/oauth/usage', token);
      return status === 200 && body && typeof body === 'object' ? { status, ...usageFromApi(body) } : { status: status === 200 ? 0 : status, retryAfter };
    },
    async profile(token) {
      const { status, body, retryAfter } = await get('/api/oauth/profile', token);
      return status === 200 && body && typeof body === 'object' ? { status, ...profileFromApi(body) } : { status: status === 200 ? 0 : status, retryAfter };
    },
  };
}

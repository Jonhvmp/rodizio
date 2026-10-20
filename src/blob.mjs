// The JSON Claude Code keeps in a Keychain item, and the rules for moving a login between items.

import { createHash } from 'node:crypto';

/** What belongs to the account. Everything else in the item (mcpOAuth: MCP server logins) belongs to the machine. */
export const LOGIN_KEYS = ['claudeAiOauth', 'organizationUuid'];

export function loginOnly(blob) {
  const out = {};
  if (blob && typeof blob === 'object') for (const k of LOGIN_KEYS) if (k in blob) out[k] = blob[k];
  return out;
}

/** `base` with its login replaced by the one in `login`; the rest of `base` stays. */
export function withLogin(base, login) {
  const out = base && typeof base === 'object' ? { ...base } : {};
  for (const k of LOGIN_KEYS) delete out[k];
  return { ...out, ...loginOnly(login) };
}

export function oauth(blob) {
  const o = blob?.claudeAiOauth;
  return o && typeof o === 'object' ? o : {};
}

export function tokenHash(blob) {
  const t = oauth(blob).accessToken;
  return t ? createHash('sha256').update(t).digest('hex').slice(0, 16) : null;
}

export function expiresAtS(blob) {
  const e = oauth(blob).expiresAt;
  return typeof e === 'number' ? Math.floor(e / 1000) : 0;
}

export const hasRefresh = (blob) => !!oauth(blob).refreshToken;

export function planOf(blob) {
  const o = oauth(blob);
  const tier = String(o.rateLimitTier ?? '');
  const sub = String(o.subscriptionType ?? '');
  const m = /(\d+)x/i.exec(tier);
  if (m) return { label: `Max ${m[1]}x`, multiplier: Number(m[1]) };
  if (/max/i.test(sub)) return { label: 'Max', multiplier: 5 };
  if (/pro/i.test(sub)) return { label: 'Pro', multiplier: 1 };
  return sub ? { label: sub, multiplier: 1 } : null;
}

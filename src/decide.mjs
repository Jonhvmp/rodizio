// When to pass the baton and to whom. Pure: state and config in, a decision out.
//
// Two windows can end an account's turn: the week and the 5-hour window. Each has its own exchange zone, the last
// N% of it. An account may carry the baton while both windows have room; it hands it over as soon as either enters
// its zone, or when it can no longer carry it at all (taken out of the queue, login refused).

/** Minimum time between two automatic switches. */
export const SWITCH_GAP_S = 90;
/** Going back to a preferred account waits this long after any switch... */
export const RETURN_GAP_S = 15 * 60;
/** ...and needs the preferred account this many points short of each zone, so it does not bounce. */
export const RETURN_MARGIN = 10;
/** A 5-hour window that resets this soon is waited out instead of spending another account on it. */
export const FIVE_HOUR_WAIT_S = 5 * 60;
/** More automatic switches than this within an hour means something is wrong: hold and say so. */
export const MAX_SWITCHES_PER_HOUR = 8;
const H = 3600;

const NONE = Object.freeze({ kind: 'none' });

/** A window whose reset time has passed counts as empty. */
export function effPct(win, now) {
  if (!win || win.pct === null || win.pct === undefined) return null;
  if (win.resetsAt && win.resetsAt <= now) return 0;
  return win.pct;
}

export const weeklyOf = (acc, now) => effPct(acc?.usage?.weekly, now);
export const fiveHourOf = (acc, now) => effPct(acc?.usage?.fiveHour, now);

/** % used at which an account enters the exchange zone of each window. */
export const triggerOf = (cfg) => 100 - cfg.remainingPct;
export const fiveHourTriggerOf = (cfg) => 100 - (cfg.fiveHourRemainingPct ?? cfg.remainingPct);

const fmt = (n) => String(Math.max(0, Math.round(n * 10) / 10)).replace('.', ',');

/** Account ids in rotation order: the order set in the dashboard, then the bigger plans, then the oldest. */
export function priority(state, cfg) {
  const rank = (id) => {
    const i = cfg.order.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  const a = state.accounts;
  return Object.keys(a).sort(
    (x, y) =>
      rank(x) - rank(y) ||
      (a[y].plan?.multiplier ?? 0) - (a[x].plan?.multiplier ?? 0) ||
      (a[x].addedAt ?? 0) - (a[y].addedAt ?? 0),
  );
}

/**
 * Room on both windows, `margin` points short of each zone. A window never measured counts as room, unless
 * `requireKnown` (then the week must have been read: going back to an account needs evidence it has room).
 */
export function hasRoom(acc, cfg, now, margin = 1, requireKnown = false) {
  if (!acc || acc.needsLogin || acc.paused) return false;
  const w = weeklyOf(acc, now);
  if (w === null ? requireKnown : w >= triggerOf(cfg) - margin) return false;
  if (cfg.fiveHourSwitch) {
    const f = fiveHourOf(acc, now);
    if (f !== null && f >= fiveHourTriggerOf(cfg) - margin) return false;
  }
  return true;
}

/** Which window, if any, has the account in its exchange zone. The week wins: it lasts longer. */
export function zoneOf(acc, cfg, now) {
  const w = weeklyOf(acc, now);
  if (w !== null && w >= triggerOf(cfg)) return 'weekly';
  if (cfg.fiveHourSwitch) {
    const f = fiveHourOf(acc, now);
    if (f !== null && f >= fiveHourTriggerOf(cfg)) return 'fiveHour';
  }
  return null;
}

/** The account the next switch would go to. */
export function nextCandidate(state, cfg, now) {
  return priority(state, cfg).find((id) => id !== state.active && hasRoom(state.accounts[id], cfg, now)) ?? null;
}

/** Why the account in use has to hand over the baton now, or null. A 5-hour zone about to reset says "wait". */
function handOver(acc, cfg, now) {
  if (acc.needsLogin) return { window: null, reason: 'o login dela foi recusado' };
  if (acc.paused) return { window: null, reason: 'ela saiu da fila' };
  const zone = zoneOf(acc, cfg, now);
  if (zone === 'weekly') return { window: 'weekly', reason: `faltavam ${fmt(100 - weeklyOf(acc, now))}% da semana` };
  if (zone === 'fiveHour') {
    const f = fiveHourOf(acc, now);
    const reset = acc.usage?.fiveHour?.resetsAt;
    if (f < 100 && reset && reset - now <= FIVE_HOUR_WAIT_S) return { wait: reset, window: 'fiveHour' };
    return { window: 'fiveHour', reason: `faltavam ${fmt(100 - f)}% da janela de 5 h` };
  }
  return null;
}

/**
 * @returns {{kind: 'none'} | {kind: 'switch', to: string, reason: string, window: string|null}
 *   | {kind: 'exhausted', window: string|null} | {kind: 'wait', until: number}
 *   | {kind: 'throttled', count: number, pending: object}}
 */
export function decide(state, cfg, now) {
  const d = decideOnce(state, cfg, now);
  if (d.kind !== 'switch') return d;
  const recent = (state.autoSwitches ?? []).filter((t) => now - t < H).length;
  return recent >= MAX_SWITCHES_PER_HOUR ? { kind: 'throttled', count: recent, pending: d } : d;
}

function decideOnce(state, cfg, now) {
  const active = state.accounts[state.active];
  if (!cfg.auto || !active) return NONE;
  const sinceSwitch = now - (state.lastSwitchAt ?? 0);
  const out = handOver(active, cfg, now);
  if (out?.wait) return { kind: 'wait', until: out.wait };

  if (out) {
    const to = nextCandidate(state, cfg, now);
    if (!to) return { kind: 'exhausted', window: out.window };
    if (sinceSwitch < SWITCH_GAP_S) return NONE;
    return { kind: 'switch', to, reason: out.reason, window: out.window };
  }

  // A manual choice (dashboard or /login) holds until that account reaches a zone.
  if (cfg.returnToPreferred && !state.pinned && sinceSwitch >= RETURN_GAP_S) {
    for (const id of priority(state, cfg)) {
      if (id === state.active) break;
      if (hasRoom(state.accounts[id], cfg, now, RETURN_MARGIN, true)) {
        return { kind: 'switch', to: id, reason: 'a conta preferida tem folga de novo', window: null };
      }
    }
  }
  return NONE;
}

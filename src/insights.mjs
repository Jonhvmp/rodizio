// Metrics derived from what the agent records: who held the baton when, how fast each window is being spent, how
// long the whole rotation lasts at that pace, and per-day activity from the status line. Pure: state in, numbers out.

import { FIVE_HOUR_WAIT_S, RETURN_GAP_S, RETURN_MARGIN, effPct, fiveHourOf, fiveHourTriggerOf, priority, triggerOf, weeklyOf } from './decide.mjs';

const H = 3600;
const DAY = 24 * H;
const WEEK = 7 * DAY;
const FIVE_H = 5 * H;
const KEEP_S = 9 * DAY;
const HISTORY_STEP_S = 300;
const HISTORY_IDLE_S = 1800;
const SESSION_LIVE_S = 180;
/** Two resets_at closer than this belong to the same window (the API and the status line round differently). */
const SAME_RESET_S = 120;
const PACE = {
  weekly: { value: 1, reset: 3, windowS: 6 * H, minSpanS: 45 * 60 },
  fiveHour: { value: 2, reset: 4, windowS: 3 * H, minSpanS: 20 * 60 },
};

/** Local calendar day of an epoch-seconds time, as YYYY-MM-DD. */
export function dayKey(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function startOfDay(t) {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Capacity of a plan in Max-5x units (a week, or a 5-hour window); the 20x counts as four. */
export const capacityOf = (acc) => (acc?.plan?.multiplier ?? 5) / 5;

const sameWindow = (a, b) => (a ?? null) === (b ?? null) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < SAME_RESET_S);

// ------------------------------------------------------------------------------------------------ recording

/** Keeps the baton timeline: one open segment for the account in use. */
export function setActive(state, id, now) {
  const tl = (state.timeline ??= []);
  const last = tl.at(-1);
  if (last && last.to === null) {
    if (last.id === id) return;
    last.to = now;
  }
  if (id) tl.push({ id, from: now, to: null });
  state.timeline = tl.filter((s) => s.to === null || s.to > now - KEEP_S);
}

/** One point per reading, thinned to one every 5 minutes, or every 30 while nothing moves. */
export function recordHistory(state, acc, now) {
  const w = acc.usage?.weekly;
  const f = acc.usage?.fiveHour;
  const point = [now, w?.pct ?? null, f?.pct ?? null, w?.resetsAt ?? null, f?.resetsAt ?? null];
  const list = ((state.history ??= {})[acc.id] ??= []);
  const last = list.at(-1);
  if (last) {
    if (now < last[0]) return;
    const same = last[1] === point[1] && last[2] === point[2] && sameWindow(last[3], point[3]) && sameWindow(last[4], point[4]);
    if (now - last[0] < (same ? HISTORY_IDLE_S : HISTORY_STEP_S)) {
      if (!same) list[list.length - 1] = point; // keep the newest value within the step
      return;
    }
  }
  list.push(point);
  while (list.length && list[0][0] < now - KEEP_S) list.shift();
}

/** Adds status line activity (already a delta) to the account's day. */
export function addActivity(state, accId, t, d) {
  const day = (((state.activity ??= {})[accId] ??= {})[dayKey(t)] ??= { cost: 0, tokensIn: 0, tokensOut: 0, linesAdded: 0, linesRemoved: 0 });
  for (const k of Object.keys(day)) day[k] += Math.max(0, d[k] ?? 0);
  const cutoff = dayKey(t - KEEP_S);
  for (const k of Object.keys(state.activity[accId])) if (k < cutoff) delete state.activity[accId][k];
}

/** Session totals the status line reports (cumulative per session) → what changed since the previous sample. */
export function totalsDelta(prev, next) {
  if (!prev || !next) return null;
  const d = {};
  for (const k of ['cost', 'tokensIn', 'tokensOut', 'linesAdded', 'linesRemoved']) {
    const a = prev[k] ?? 0;
    const b = next[k] ?? 0;
    d[k] = b >= a ? b - a : b; // a smaller total means a new session behind the same id: count it from zero
  }
  return d;
}

// ------------------------------------------------------------------------------------------------ deriving

/** % per hour of a window over its last readings within the same window, or null when there is too little to tell. */
export function burnRate(state, accId, now, window = 'weekly') {
  const { value, reset, windowS, minSpanS } = PACE[window];
  const list = state.history?.[accId] ?? [];
  const last = list.at(-1);
  if (!last || last[value] === null || last[value] === undefined) return null;
  const pts = list.filter((p) => p[0] >= now - windowS && p[value] !== null && p[value] !== undefined && sameWindow(p[reset], last[reset]));
  if (pts.length < 2) return null;
  const span = pts.at(-1)[0] - pts[0][0];
  if (span < minSpanS) return null;
  return Math.max(0, ((pts.at(-1)[value] - pts[0][value]) / span) * H);
}

/** Seconds each account held the baton inside [from, to]. */
export function batonTime(state, from, to) {
  const out = {};
  for (const s of state.timeline ?? []) {
    const a = Math.max(from, s.from);
    const b = Math.min(to, s.to ?? to);
    if (b > a) out[s.id] = (out[s.id] ?? 0) + (b - a);
  }
  return out;
}

export function activityBetween(state, accId, fromDay, toDay) {
  const sum = { cost: 0, tokensIn: 0, tokensOut: 0, linesAdded: 0, linesRemoved: 0 };
  for (const [day, v] of Object.entries(state.activity?.[accId] ?? {})) {
    if (day < fromDay || day > toDay) continue;
    for (const k of Object.keys(sum)) sum[k] += v[k] ?? 0;
  }
  return sum;
}

/**
 * The reset of a window still running, or null when it starts on first use: never read, or already reset (a new one
 * begins with the next use, not on the old schedule).
 */
const nextReset = (resetsAt, now) => (resetsAt && resetsAt > now ? resetsAt : null);

/**
 * Who holds the baton from now on, following the same rules as decide(): hand over when either window enters its
 * zone (waiting out a 5-hour window about to reset), come back to the preferred account once it has room, and treat a
 * window that has not started as starting on first use. `pace` is the spending rate in Max-5x units per hour, for the
 * week and for the 5-hour window (null when not measured: that window is then left out). A stretch with no account
 * that has room is a gap.
 */
export function forecast(state, cfg, now, pace, horizon = now + 3 * DAY) {
  const weekPace = pace?.week;
  if (!state.active || !state.accounts[state.active] || !(weekPace > 0)) return null;
  const fivePace = cfg.fiveHourSwitch && pace.fiveHour > 0 ? pace.fiveHour : null;
  const tW = triggerOf(cfg);
  const tF = fiveHourTriggerOf(cfg);
  const accs = priority(state, cfg).map((id) => {
    const a = state.accounts[id];
    const w = weeklyOf(a, now);
    const f = fiveHourOf(a, now);
    return {
      id,
      cap: capacityOf(a),
      w: w ?? 0,
      f: f ?? 0,
      known: w !== null,
      wReset: nextReset(a.usage?.weekly?.resetsAt, now),
      fReset: nextReset(a.usage?.fiveHour?.resetsAt, now),
      usable: !a.needsLogin && !a.paused,
    };
  });
  const room = (a, margin) => a.usable && a.w < tW - margin && (!fivePace || a.f < tF - margin);
  const inZone = (a) => a.w >= tW || (fivePace && a.f >= tF);
  const pick = (except) => accs.find((a) => a !== except && room(a, 1)) ?? null;

  let cur = accs.find((a) => a.id === state.active);
  if (!cur.usable) cur = pick(cur);
  let pinned = !!state.pinned;
  let lastSwitch = state.lastSwitchAt ?? 0;
  let t = now;
  let uncertain = false;
  const segments = [];
  const push = (id, from, to) => {
    const last = segments.at(-1);
    if (last && last.id === id && last.to === from) last.to = to;
    else if (to > from) segments.push({ id, from, to });
  };

  for (let i = 0; i < 2000 && t < horizon; i++) {
    let tEnd = Infinity;
    let endsBy = null;
    let waiting = false;
    if (cur) {
      // Windows that had not started start now, with the first use.
      cur.wReset ??= t + WEEK;
      if (fivePace) cur.fReset ??= t + FIVE_H;
      if (!cur.known) uncertain = true;
      if (fivePace && cur.f >= tF && cur.w < tW && cur.fReset - t <= FIVE_HOUR_WAIT_S) {
        waiting = true; // the 5-hour window resets in a moment: held, without spending
      } else {
        const toWeek = ((tW - cur.w) / 100) * (cur.cap / weekPace) * H;
        const toFive = fivePace ? ((tF - cur.f) / 100) * (cur.cap / fivePace) * H : Infinity;
        endsBy = toFive < toWeek ? 'fiveHour' : 'weekly';
        tEnd = t + Math.max(0, Math.min(toWeek, toFive));
      }
    }
    const resets = accs.flatMap((a) => [a.wReset, fivePace ? a.fReset : null]).filter((r) => r !== null && r > t);
    const tNext = Math.min(tEnd, resets.length ? Math.min(...resets) : Infinity, horizon);
    if (tNext === Infinity) break;
    if (cur && !waiting) {
      const dt = (tNext - t) / H;
      cur.w += (dt * weekPace * 100) / cur.cap;
      if (fivePace) cur.f += (dt * fivePace * 100) / cur.cap;
      // The window that ran out lands exactly on its trigger, so float rounding cannot leave it a hair short.
      if (tNext === tEnd) {
        if (endsBy === 'weekly') cur.w = tW;
        else cur.f = tF;
      }
    }
    push(cur?.id ?? null, t, tNext);
    t = tNext;
    for (const a of accs) {
      if (a.wReset !== null && a.wReset <= t) {
        a.w = 0;
        a.known = true;
        a.wReset = null;
      }
      if (a.fReset !== null && a.fReset <= t) {
        a.f = 0;
        a.fReset = null;
      }
    }
    if (!cur || inZone(cur)) {
      if (cur && fivePace && cur.w < tW && cur.fReset !== null && cur.fReset - t <= FIVE_HOUR_WAIT_S) continue;
      const next = pick(cur);
      if (next !== cur) lastSwitch = t;
      cur = next;
      pinned = false;
    } else if (cfg.returnToPreferred && !pinned && t - lastSwitch >= RETURN_GAP_S) {
      // The same rule as decide(): back to a preferred account only with room measured, not assumed.
      for (const a of accs) {
        if (a === cur) break;
        if (a.known && room(a, RETURN_MARGIN)) {
          cur = a;
          lastSwitch = t;
          break;
        }
      }
    }
  }
  const gap = segments.find((s) => s.id === null);
  return { segments, gapAt: gap?.from ?? null, gapUntil: gap?.to ?? null, horizon, uncertain };
}

/** Everything the dashboard shows beyond the raw readings. */
export function insights(state, cfg, now) {
  const tW = triggerOf(cfg);
  const tF = fiveHourTriggerOf(cfg);
  const ids = priority(state, cfg);
  const today = dayKey(now);
  const weekAgo = now - WEEK;
  const baton7 = batonTime(state, weekAgo, now);
  const batonToday = batonTime(state, startOfDay(now), now);

  // Weekly pace summed over every account, in Max-5x weeks per hour, so another machine using a parked account
  // counts too. The 5-hour pace is the account in use's: only the baton holder spends its window here.
  let weekPace = 0;
  let measured = false;
  let fivePace = null;
  const perAccount = {};
  for (const id of ids) {
    const a = state.accounts[id];
    const rate = burnRate(state, id, now, 'weekly');
    const rate5 = burnRate(state, id, now, 'fiveHour');
    if (rate !== null) {
      measured = true;
      weekPace += (rate / 100) * capacityOf(a);
    }
    if (id === state.active && rate5 !== null) fivePace = (rate5 / 100) * capacityOf(a);
    const w = weeklyOf(a, now);
    const f = fiveHourOf(a, now);
    const left = a.needsLogin || a.paused || w === null ? 0 : Math.max(0, tW - w);
    const active = id === state.active;
    // When the account in use reaches each zone at its pace; nothing when the window resets before that.
    const eta = (pct, trigger, perHour, resetsAt) => {
      if (!active || !(perHour > 0) || pct === null || pct >= trigger) return null;
      const t = now + ((trigger - pct) / perHour) * H;
      return resetsAt && resetsAt > now && t >= resetsAt ? null : t;
    };
    perAccount[id] = {
      ratePctPerHour: rate,
      rate5PctPerHour: rate5,
      etaToTrigger: eta(w, tW, rate, a.usage?.weekly?.resetsAt),
      etaToTrigger5: cfg.fiveHourSwitch ? eta(f, tF, rate5, a.usage?.fiveHour?.resetsAt) : null,
      batonWeekS: baton7[id] ?? 0,
      batonTodayS: batonToday[id] ?? 0,
      today: activityBetween(state, id, today, today),
      week: activityBetween(state, id, dayKey(weekAgo), today),
      leftUnits: (left / 100) * capacityOf(a),
      opus: a.usage?.opus ? { pct: effPct(a.usage.opus, now), resetsAt: a.usage.opus.resetsAt } : null,
      sonnet: a.usage?.sonnet ? { pct: effPct(a.usage.sonnet, now), resetsAt: a.usage.sonnet.resetsAt } : null,
    };
  }
  const totalUnits = ids.reduce((s, id) => s + (state.accounts[id].paused ? 0 : capacityOf(state.accounts[id])), 0);
  const leftUnits = ids.reduce((s, id) => s + perAccount[id].leftUnits, 0);

  const todayTotals = { cost: 0, tokensIn: 0, tokensOut: 0, linesAdded: 0, linesRemoved: 0 };
  for (const id of Object.keys(state.activity ?? {})) {
    const v = state.activity[id][today];
    if (v) for (const k of Object.keys(todayTotals)) todayTotals[k] += v[k] ?? 0;
  }

  const live = Object.values(state.sessions ?? {}).filter((s) => now - s.at < SESSION_LIVE_S);
  const switches = (state.events ?? []).filter((e) => e.kind === 'troca' && e.at >= weekAgo);
  const fc = measured ? forecast(state, cfg, now, { week: weekPace, fiveHour: fivePace }) : null;

  return {
    perAccount,
    rotation: {
      unitsPerHour: measured ? weekPace : null,
      leftUnits,
      totalUnits,
      leftShare: totalUnits ? leftUnits / totalUnits : null,
      hoursLeft: measured && weekPace > 0 ? leftUnits / weekPace : null,
    },
    forecast: fc,
    today: todayTotals,
    live: {
      sessions: live.length,
      models: [...new Set(live.map((s) => s.model).filter(Boolean))],
      maxContext: live.reduce((m, s) => Math.max(m, s.ctx ?? 0), 0) || null,
    },
    week: { switches: switches.length, lastSwitchAt: switches[0]?.at ?? null },
    timeline: (state.timeline ?? []).filter((s) => (s.to ?? now) > now - WEEK).map((s) => ({ ...s, to: s.to ?? now })),
  };
}

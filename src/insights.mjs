// Metrics derived from what the agent records: who held the baton when, how fast each window is being spent, how
// long the whole rotation lasts at that pace, and per-day activity from the status line. Pure: state in, numbers out.

import { paceModel } from './learn.mjs';
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

/** Up to how far the forecast looks: past the next weekly renewal. */
export const FORECAST_DAYS = 8;

/**
 * Who holds the baton from now on, following the same rules as decide(): hand over when either window enters its
 * zone (waiting out a 5-hour window about to reset), come back to the preferred account once it has room, and treat a
 * window that has not started as starting on first use.
 *
 * `pace` gives the spending rate in Max-5x units per hour, for the week and for the 5-hour window: either flat numbers
 * ({week, fiveHour}) or the learned model ({week: t => rate, five: t => rate | null}, see learn.mjs paceModel), which
 * changes hour by hour. Without a 5-hour pace that window is left out. A stretch with no account that has room is a
 * gap, tagged with why: only the 5-hour windows (a pause), or the weeks.
 */
export function forecast(state, cfg, now, pace, horizon = now + 3 * DAY) {
  if (!pace || !state.active || !state.accounts[state.active]) return null;
  const varying = typeof pace.week === 'function';
  const weekAt = varying ? pace.week : () => pace.week;
  const fiveAt = varying ? pace.five : pace.fiveHour > 0 ? () => pace.fiveHour : null;
  if (!varying && !(pace.week > 0)) return null;
  const useFive = !!(cfg.fiveHourSwitch && fiveAt);
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
  const room = (a, margin) => a.usable && a.w < tW - margin && (!useFive || a.f < tF - margin);
  const inZone = (a) => a.w >= tW || (useFive && a.f >= tF);
  const pick = (except) => accs.find((a) => a !== except && room(a, 1)) ?? null;
  // With no account left, is it only the 5-hour windows (a pause), or the weeks?
  const whyNone = () => (accs.some((a) => a.usable && a.w < tW - 1) ? 'fiveHour' : 'weekly');

  let cur = accs.find((a) => a.id === state.active);
  if (!cur.usable) cur = pick(cur);
  let why = cur ? null : whyNone();
  let pinned = !!state.pinned;
  let lastSwitch = state.lastSwitchAt ?? 0;
  let t = now;
  let uncertain = false;
  const segments = [];
  const push = (id, from, to) => {
    const last = segments.at(-1);
    if (last && last.id === id && last.to === from && last.why === (id ? undefined : why)) last.to = to;
    else if (to > from) segments.push(id ? { id, from, to } : { id, from, to, why });
  };

  for (let i = 0; i < 5000 && t < horizon; i++) {
    const weekPace = Math.max(0, weekAt(t) || 0);
    const fivePace = useFive ? Math.max(0, fiveAt(t) || 0) : 0;
    let tEnd = Infinity;
    let endsBy = null;
    let waiting = false;
    if (cur) {
      // Windows that had not started start now, with the first use.
      cur.wReset ??= t + WEEK;
      if (useFive) cur.fReset ??= t + FIVE_H;
      if (!cur.known) uncertain = true;
      if (useFive && cur.f >= tF && cur.w < tW && cur.fReset - t <= FIVE_HOUR_WAIT_S) {
        waiting = true; // the 5-hour window resets in a moment: held, without spending
      } else {
        const toWeek = weekPace > 0 ? ((tW - cur.w) / 100) * (cur.cap / weekPace) * H : Infinity;
        const toFive = fivePace > 0 ? ((tF - cur.f) / 100) * (cur.cap / fivePace) * H : Infinity;
        endsBy = toFive < toWeek ? 'fiveHour' : 'weekly';
        tEnd = t + Math.max(0, Math.min(toWeek, toFive));
      }
    }
    const resets = accs.flatMap((a) => [a.wReset, useFive ? a.fReset : null]).filter((r) => r !== null && r > t);
    // A learned pace changes with the hour: the step never crosses one.
    const hourEnd = varying ? (Math.floor(t / H) + 1) * H : Infinity;
    const tNext = Math.min(tEnd, resets.length ? Math.min(...resets) : Infinity, hourEnd, horizon);
    if (tNext === Infinity) break;
    if (cur && !waiting) {
      const dt = (tNext - t) / H;
      cur.w += (dt * weekPace * 100) / cur.cap;
      if (useFive) cur.f += (dt * fivePace * 100) / cur.cap;
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
      if (cur && useFive && cur.w < tW && cur.fReset !== null && cur.fReset - t <= FIVE_HOUR_WAIT_S) continue;
      const next = pick(cur);
      if (next !== cur) lastSwitch = t;
      cur = next;
      pinned = false;
      why = cur ? null : whyNone();
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
  return { segments, gapAt: gap?.from ?? null, gapUntil: gap?.to ?? null, gapWhy: gap?.why ?? null, horizon, uncertain };
}

/** Capacity the pace model expects to be spent between two moments. */
function spendBetween(weekAt, from, to) {
  let u = 0;
  for (let t = from; t < to; ) {
    const end = Math.min(to, (Math.floor(t / H) + 1) * H);
    u += Math.max(0, weekAt(t) || 0) * ((end - t) / H);
    t = end;
  }
  return u;
}

/** Whether the forecast at `k` times the expected pace reaches `until` without running out of weeks. */
function reaches(state, cfg, now, model, until, k) {
  const scaled = { week: (t) => k * model.week(t), five: model.five ? (t) => k * model.five(t) : null };
  const fc = forecast(state, cfg, now, scaled, until);
  return !fc || !fc.segments.some((g) => g.id === null && g.why !== 'fiveHour' && g.from < until);
}

/** Past this many times the expected use, the rotation is simply roomy. */
const MAX_HEADROOM = 16;

/**
 * How many times the expected use, as the forecast sees it (renewals on the way, accounts never read, pauses), still
 * reaches `until`: above 1 there is room to spare, below 1 it runs out first. Null when it is roomier than MAX_HEADROOM.
 */
function headroom(state, cfg, now, model, until) {
  let lo = 0;
  let hi = 1;
  if (reaches(state, cfg, now, model, until, 1)) {
    lo = 1;
    hi = 2;
    while (reaches(state, cfg, now, model, until, hi)) {
      if (hi >= MAX_HEADROOM) return null;
      lo = hi;
      hi *= 2;
    }
  }
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (reaches(state, cfg, now, model, until, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * "Do I make it to the renewal?": until the preferred account's week renews (or the first known weekly renewal), does
 * the forecast run into a stretch with no account, and how many hours a day can be used to just make it. The room and
 * the hours come from the same simulation as the answer, so they never contradict it.
 */
export function verdictOf(state, cfg, now, model, fc) {
  if (!model || !fc) return null;
  const ids = priority(state, cfg);
  const pref = nextReset(state.accounts[ids[0]]?.usage?.weekly?.resetsAt, now);
  const known = ids.map((id) => nextReset(state.accounts[id].usage?.weekly?.resetsAt, now)).filter(Boolean);
  const target = pref ?? (known.length ? Math.min(...known) : null);
  if (!target) return null;
  const until = Math.min(target, fc.horizon);
  const gaps = fc.segments.filter((g) => g.id === null && g.from < until).map((g) => ({ ...g, to: Math.min(g.to, until) }));
  const weekGaps = gaps.filter((g) => g.why !== 'fiveHour');
  const pauses = gaps.filter((g) => g.why === 'fiveHour');
  const hours = (list) => list.reduce((sum, g) => sum + (g.to - g.from), 0) / H;
  const prof = model.profile;
  const days = (until - now) / DAY;
  const activeRate = prof?.activeRate ?? null;
  // Scaling the expected pace needs some expected use to scale: with almost none until the renewal (a weekend, say),
  // the same question is asked of an hour a day of typical use.
  const expected = spendBetween(model.week, now, until);
  const base = activeRate && expected < activeRate * 0.5 ? { week: () => activeRate / 24, five: null } : model;
  const baseSpend = base === model ? expected : (activeRate / 24) * ((until - now) / H);
  const k = baseSpend > 0 ? headroom(state, cfg, now, base, until) : null;
  const usable = k === null ? null : k * baseSpend;
  const budget = !activeRate || !(days > 0) ? null : usable === null ? Infinity : usable / activeRate / days;
  return {
    target: until,
    preferred: ids[0] ?? null,
    ok: weekGaps.length === 0,
    firstGapAt: weekGaps[0]?.from ?? null,
    gapHours: hours(weekGaps),
    pauseHours: hours(pauses),
    /** Capacity left over (negative: missing) at the expected pace, in Max-5x weeks; null when there is plenty. */
    slackUnits: usable === null ? null : usable - expected,
    typicalHoursPerDay: prof ? prof.activeHoursPerDay : null,
    /** Hours a day of typical use that just make it; null when unknown, or when there is room all day (roomy). */
    budgetHoursPerDay: budget !== null && budget < 24 ? budget : null,
    roomy: budget !== null && budget >= 24,
    basis: model.basis,
  };
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

  // The recent weekly pace summed over every account, in Max-5x weeks per hour (another machine using a parked
  // account counts too), and the 5-hour pace of the account in use. The forecast runs on the learned pattern when
  // there is one, and on these flat paces until then.
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

  const model = paceModel(state, now, { flatWeek: measured ? weekPace : null, flatFive: fivePace });
  const prof = model?.profile ?? null;
  const fc = model ? forecast(state, cfg, now, model, now + FORECAST_DAYS * DAY) : null;
  const observedDays = Object.values(state.learn?.hours ?? {}).reduce((sum, e) => sum + (e.s || 0), 0) / DAY;
  const live = Object.values(state.sessions ?? {}).filter((s) => now - s.at < SESSION_LIVE_S);
  const switches = (state.events ?? []).filter((e) => e.kind === 'troca' && e.at >= weekAgo);

  return {
    perAccount,
    rotation: {
      unitsPerHour: measured ? weekPace : null,
      leftUnits,
      totalUnits,
      leftShare: totalUnits ? leftUnits / totalUnits : null,
      /** Hours of use left, at the pace of a typical working hour (learned) or of the last hours (until then). */
      hoursLeft: prof?.activeRate ? leftUnits / prof.activeRate : measured && weekPace > 0 ? leftUnits / weekPace : null,
    },
    forecast: fc,
    verdict: verdictOf(state, cfg, now, model, fc),
    learning: {
      basis: model?.basis ?? null,
      observedDays,
      confidence: prof?.confidence ?? 'baixa',
      typicalHoursPerDay: prof?.activeHoursPerDay ?? null,
      unitsPerDay: prof?.unitsPerDay ?? null,
      activeRate: prof?.activeRate ?? null,
      ratio5: prof?.ratio5 ?? null,
      grid: prof?.grid ?? null,
    },
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

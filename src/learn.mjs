// Learns how the person uses Claude: how much of the rotation's capacity goes in each hour of the week, counting the
// hours with no use at all (nights, weekends), so a forecast follows their real rhythm instead of assuming nonstop use.
// Pure: state in, state or numbers out.
//
// What it keeps, per hour of the clock (epoch hour): `u`, capacity spent (in Max-5x weeks: a 20x week is 4), and `s`,
// seconds observed. Spending comes from the weekly % of every account rising between two readings; observation from
// the agent's passes. A gap longer than a day (the Mac off) teaches nothing.

const H = 3600;
const DAY = 24 * H;
const KEEP_DAYS = 35;
const MAX_GAP_S = DAY;
/** Recent weeks weigh more: an hour from two weeks ago counts half. */
const HALF_LIFE_DAYS = 14;
/** How many observed hours a bucket needs before its own average outweighs the broader one (shrinkage). */
const PRIOR_HOURS = 1;
/** Below this pace an hour counts as idle (about 0.06% of a 20x week per hour). */
export const ACTIVE_UNITS_PER_H = 0.0025;
/** The next hours lean on what is happening right now, fading into the learned pattern over this long. */
export const NOW_BLEND_S = 3 * H;
const SAME_RESET_S = 120;
/** A week lower than its highest reading by more than rounding: the week really went down (an early reset). */
const DROP_PCT = 1.5;
/** A highest reading this far ahead of a new one is from a clock that has since gone back. */
const FUTURE_S = 15 * 60;
/** Each new sample of the week-to-5-hour ratio counts this much more than the ones before it. */
const RATIO_DECAY = 0.97;

const isWeekend = (day) => day === 0 || day === 6;

const sameWindow = (a, b) => (a ?? null) === (b ?? null) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < SAME_RESET_S);

export const emptyLearn = () => ({ hours: {}, lastObsAt: 0, high: {}, ratio5: { w: 0, f: 0 } });

/** Adds `amount` of `field` to the hours of [from, to), in proportion to how much of each hour the interval covers. */
function spread(L, from, to, field, amount) {
  const dur = to - from;
  if (dur <= 0) return;
  for (let t = from; t < to; ) {
    const h = Math.floor(t / H);
    const end = Math.min(to, (h + 1) * H);
    const e = (L.hours[h] ??= { u: 0, s: 0 });
    e[field] += field === 's' ? end - t : amount * ((end - t) / dur);
    t = end;
  }
}

function prune(L, now) {
  const oldest = Math.floor((now - KEEP_DAYS * DAY) / H);
  for (const k of Object.keys(L.hours)) if (Number(k) < oldest) delete L.hours[k];
}

/** The agent was watching from the previous pass until now. */
export function observe(state, now) {
  const L = (state.learn ??= emptyLearn());
  if (L.lastObsAt && now > L.lastObsAt && now - L.lastObsAt <= MAX_GAP_S) spread(L, L.lastObsAt, now, 's');
  L.lastObsAt = now; // also after a clock that went back: from here on
  prune(L, now);
}

/**
 * A new reading of an account: what its week rose by since the highest reading of the same week is spending, spread
 * over the time in between. Comparing with the highest (not the last) keeps readings from two sources that round
 * differently (the API in whole percents, the status line with decimals) from being counted twice.
 */
export function consume(state, accId, capacity, usage) {
  const w = usage?.weekly;
  const at = usage?.at;
  if (!w || w.pct === null || w.pct === undefined || !at) return;
  const L = (state.learn ??= emptyLearn());
  const hi = L.high[accId];
  const f = usage.fiveHour;
  const fresh = () => ({ reset: w.resetsAt ?? null, pct: w.pct, at, f: f?.pct ?? null, fReset: f?.resetsAt ?? null });
  if (!hi || !sameWindow(hi.reset, w.resetsAt)) {
    // A week that had not started is starting now: what it shows was spent since the last look at it.
    if (hi && hi.reset === null && hi.pct === 0 && w.pct > 0 && at > hi.at && at - hi.at <= MAX_GAP_S) {
      spread(L, hi.at, at, 'u', (w.pct / 100) * capacity);
    }
    L.high[accId] = fresh();
    return;
  }
  // The same week, but lower than before (reset early), or a highest reading from a clock that has gone back since:
  // counting starts again from here.
  if (w.pct < hi.pct - DROP_PCT || hi.at - at > FUTURE_S) {
    L.high[accId] = fresh();
    return;
  }
  if (at <= hi.at) return;
  // The 5-hour baseline moves only with the week (so the ratio pairs rises over the same stretch), or with its window.
  const fiveMoved = f && typeof f.pct === 'number' && !sameWindow(hi.fReset, f.resetsAt);
  if (w.pct > hi.pct) {
    const dw = w.pct - hi.pct;
    if (at - hi.at <= MAX_GAP_S) spread(L, hi.at, at, 'u', (dw / 100) * capacity);
    // How much of the 5-hour window a point of the week costs, from moments where both rose in the same windows.
    if (f && typeof f.pct === 'number' && hi.f !== null && !fiveMoved && f.pct > hi.f) {
      L.ratio5.w = L.ratio5.w * RATIO_DECAY + dw;
      L.ratio5.f = L.ratio5.f * RATIO_DECAY + (f.pct - hi.f);
    }
    Object.assign(hi, { pct: w.pct, at, f: f?.pct ?? hi.f, fReset: f?.resetsAt ?? hi.fReset });
  } else if (w.pct === hi.pct) {
    hi.at = at;
    if (fiveMoved) Object.assign(hi, { f: f.pct, fReset: f.resetsAt ?? null });
  }
}

/** An account left the rotation: what was kept to measure its week goes too. */
export function forget(state, accId) {
  if (state.learn?.high) delete state.learn.high[accId];
}

/** Capacity spent in the last hour (Max-5x weeks per hour): what is happening right now. */
export function recentPace(state, now) {
  const L = state.learn;
  if (!L) return 0;
  let u = 0;
  for (let h = Math.floor((now - H) / H); h <= Math.floor(now / H); h++) {
    const e = L.hours[h];
    if (!e) continue;
    const from = Math.max(h * H, now - H);
    const to = Math.min((h + 1) * H, now);
    if (to > from) u += e.u * ((to - from) / H);
  }
  return u;
}

/**
 * The learned pattern: the expected spending pace for any hour of the week (Max-5x weeks per hour), shrunk toward the
 * same hour on any day, and that toward the overall average, until the bucket has enough hours of its own. Null until
 * a few hours have been observed.
 */
export function profile(state, now) {
  const L = state.learn;
  if (!L) return null;
  const byHour = Array.from({ length: 24 }, () => ({ u: 0, s: 0 }));
  // Weekdays tend to look alike, and weekends too: the level between "this hour of this day" and "this hour".
  const byKindHour = Array.from({ length: 48 }, () => ({ u: 0, s: 0 }));
  const byWeekHour = Array.from({ length: 168 }, () => ({ u: 0, s: 0 }));
  let U = 0;
  let S = 0;
  let observedS = 0;
  let activeH = 0;
  let activeU = 0;
  for (const [k, e] of Object.entries(L.hours)) {
    const t = Number(k) * H;
    const age = (now - t) / DAY;
    if (age < 0 || age > KEEP_DAYS || !e.s) continue;
    const weight = 0.5 ** (age / HALF_LIFE_DAYS);
    const d = new Date(t * 1000);
    const hours = (e.s / H) * weight;
    const spent = e.u * weight;
    byHour[d.getHours()].u += spent;
    byHour[d.getHours()].s += hours;
    const kind = (isWeekend(d.getDay()) ? 24 : 0) + d.getHours();
    byKindHour[kind].u += spent;
    byKindHour[kind].s += hours;
    byWeekHour[d.getDay() * 24 + d.getHours()].u += spent;
    byWeekHour[d.getDay() * 24 + d.getHours()].s += hours;
    U += spent;
    S += hours;
    observedS += e.s;
    if (e.s >= 1800 && e.u / (e.s / H) >= ACTIVE_UNITS_PER_H) {
      activeH += e.s / H;
      activeU += e.u;
    }
  }
  if (observedS < 3 * H) return null;
  const all = U / S;
  const hourRate = byHour.map((b) => (b.u + PRIOR_HOURS * all) / (b.s + PRIOR_HOURS));
  const kindRate = byKindHour.map((b, i) => (b.u + PRIOR_HOURS * hourRate[i % 24]) / (b.s + PRIOR_HOURS));
  const weekRate = byWeekHour.map((b, i) => {
    const kind = (isWeekend(Math.floor(i / 24)) ? 24 : 0) + (i % 24);
    return (b.u + PRIOR_HOURS * kindRate[kind]) / (b.s + PRIOR_HOURS);
  });
  const days = observedS / DAY;
  return {
    rateAt: (t) => {
      const d = new Date(t * 1000);
      return weekRate[d.getDay() * 24 + d.getHours()];
    },
    /** For the dashboard's heat map: [weekday 0 = Sunday][hour]. */
    grid: Array.from({ length: 7 }, (_, d) => weekRate.slice(d * 24, d * 24 + 24)),
    observedDays: days,
    unitsPerDay: all * 24,
    activeHoursPerDay: activeH / days,
    activeRate: activeH > 0 ? activeU / activeH : null,
    confidence: days >= 7 ? 'alta' : days >= 2 ? 'media' : 'baixa',
    /** % of the 5-hour window per % of the week, learned; null until there is enough of it. */
    ratio5: L.ratio5.w >= 2 ? L.ratio5.f / L.ratio5.w : null,
  };
}

/**
 * The pace model a forecast runs on: the learned pattern, leaning on the last hour's pace for the next few hours
 * (fading out), or a flat recent pace while nothing has been learned yet.
 */
export function paceModel(state, now, { flatWeek = null, flatFive = null } = {}) {
  const prof = profile(state, now);
  if (!prof) {
    if (!(flatWeek > 0)) return null;
    return { week: () => flatWeek, five: flatFive > 0 ? () => flatFive : null, basis: 'recente', profile: null };
  }
  // Only actual use right now says something about the next hours: being idle at 9:00 on a Monday does not mean the
  // day will be idle, so then the pattern alone decides.
  const recent = recentPace(state, now);
  const leaning = recent >= ACTIVE_UNITS_PER_H;
  const week = (t) => {
    const a = leaning ? Math.max(0, 1 - (t - now) / NOW_BLEND_S) : 0;
    return a * recent + (1 - a) * prof.rateAt(t);
  };
  const ratio = prof.ratio5 ?? (flatWeek > 0 && flatFive > 0 ? flatFive / flatWeek : null);
  return { week, five: ratio ? (t) => week(t) * ratio : null, basis: 'aprendido', profile: prof };
}

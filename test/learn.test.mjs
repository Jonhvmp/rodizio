import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forecast, verdictOf } from '../src/insights.mjs';
import { consume, emptyLearn, observe, paceModel, profile, recentPace } from '../src/learn.mjs';
import { DEFAULT_CONFIG, emptyState } from '../src/state.mjs';
import { A, connect, setup } from './helpers.mjs';

const H = 3600;
const DAY = 24 * H;
const cfg = (extra = {}) => ({ ...DEFAULT_CONFIG, order: [], ...extra });

/** A Monday 00:00 in local time, so weekdays and hours below are the machine's own. */
function monday() {
  const d = new Date(2026, 9, 5, 0, 0, 0); // 5 Oct 2026 is a Monday
  return Math.floor(d.getTime() / 1000);
}
const works = (t) => {
  const d = new Date(t * 1000);
  return d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 9 && d.getHours() < 18;
};

/**
 * Two weeks of a person who works 9:00-18:00 on weekdays and never at night or on weekends, on one 20x account
 * spending 1.5% of its week per working hour (0.06 Max-5x weeks per hour), read every 10 minutes.
 */
function twoWeeks() {
  const state = emptyState();
  const t0 = monday();
  let pct = 0;
  let reset = t0 + 7 * DAY;
  for (let t = t0; t <= t0 + 14 * DAY; t += 600) {
    if (t >= reset) {
      pct = 0;
      reset += 7 * DAY;
    }
    if (works(t - 600)) pct += 1.5 / 6; // what was used in the 10 minutes this reading covers
    observe(state, t);
    consume(state, 'a', 4, { weekly: { pct, resetsAt: reset }, fiveHour: null, at: t });
  }
  return { state, t0, end: t0 + 14 * DAY };
}

test('observed time is spread over the hours it covers; a gap of more than a day teaches nothing', () => {
  const s = emptyState();
  const t = monday() + 10 * H + 30 * 60; // 10:30
  observe(s, t);
  observe(s, t + H); // until 11:30: half of 10h, half of 11h
  const h = Math.floor(t / H);
  assert.equal(s.learn.hours[h].s, 1800);
  assert.equal(s.learn.hours[h + 1].s, 1800);
  observe(s, t + H + 2 * DAY);
  assert.equal(Object.values(s.learn.hours).reduce((a, e) => a + e.s, 0), 3600);
});

test('spending is what the week rose by, never counted twice when two sources round differently', () => {
  const s = emptyState();
  const t = monday() + 9 * H;
  const r = t + 3 * DAY;
  const read = (pct, at) => consume(s, 'a', 4, { weekly: { pct, resetsAt: r }, fiveHour: null, at });
  read(40, t);
  read(40.4, t + 600); // status line, with decimals
  read(40, t + 900); // the API, rounded down: not a fall
  read(40.6, t + 1200); // only 0.2 more than the highest
  read(41, t + 1800);
  const spent = Object.values(s.learn.hours).reduce((a, e) => a + e.u, 0);
  assert.equal(Math.round(spent * 10000) / 10000, Math.round((1 / 100) * 4 * 10000) / 10000);
});

test('a week that starts counts what it shows since the last look; a new week starts over', () => {
  const s = emptyState();
  const t = monday() + 9 * H;
  consume(s, 'b', 1, { weekly: { pct: 0, resetsAt: null }, fiveHour: null, at: t });
  consume(s, 'b', 1, { weekly: { pct: 6, resetsAt: t + 7 * DAY }, fiveHour: null, at: t + H });
  assert.equal(Math.round(Object.values(s.learn.hours).reduce((a, e) => a + e.u, 0) * 100) / 100, 0.06);
  consume(s, 'b', 1, { weekly: { pct: 2, resetsAt: t + 14 * DAY }, fiveHour: null, at: t + 8 * DAY });
  assert.equal(s.learn.high.b.pct, 2);
});

test('learns how much of the 5-hour window a point of the week costs', () => {
  const s = emptyState();
  const t = monday() + 9 * H;
  for (let i = 0; i <= 10; i++) {
    consume(s, 'a', 4, { weekly: { pct: 30 + i, resetsAt: t + 3 * DAY }, fiveHour: { pct: 3.5 * i, resetsAt: t + 5 * H }, at: t + i * 600 });
  }
  observe(s, t);
  observe(s, t + 4 * H);
  assert.equal(Math.round(profile(s, t + 4 * H).ratio5 * 10) / 10, 3.5);
});

test('the learned pattern: busy weekday hours, idle nights and weekends, and how many hours a day are used', () => {
  const { state, end } = twoWeeks();
  const p = profile(state, end);
  const at = (dow, hour) => {
    const d = new Date(end * 1000);
    d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
    d.setHours(hour, 30, 0, 0);
    return p.rateAt(Math.floor(d.getTime() / 1000));
  };
  assert.ok(Math.abs(at(2, 10) - 0.06) < 0.01, `Tuesday 10:30: ${at(2, 10)}`);
  assert.ok(at(2, 3) < 0.005, `Tuesday 3:30: ${at(2, 3)}`);
  assert.ok(at(0, 14) < 0.005, `Sunday 14:30: ${at(0, 14)}`);
  assert.ok(Math.abs(p.activeHoursPerDay - (9 * 5 * 2) / 14) < 0.5, `${p.activeHoursPerDay} h/day`);
  assert.ok(Math.abs(p.activeRate - 0.06) < 0.005);
  assert.equal(p.confidence, 'alta');
  assert.equal(p.grid.length, 7);
});

test('the next hours lean on what is happening right now, then follow the pattern', () => {
  const { state, end } = twoWeeks();
  // Sunday night: the pattern says idle, but the person is working hard right now
  const now = end + 6 * DAY + 22 * H; // a Sunday, 22:00
  for (let t = now - H; t <= now; t += 600) {
    observe(state, t);
    consume(state, 'a', 4, { weekly: { pct: 50 + (t - now + H) / 600, resetsAt: now + 3 * DAY }, fiveHour: null, at: t });
  }
  assert.ok(recentPace(state, now) > 0.1);
  const m = paceModel(state, now);
  assert.equal(m.basis, 'aprendido');
  assert.ok(m.week(now) > 0.1, 'right now: the current pace');
  assert.ok(m.week(now + 4 * H) < 0.01, 'later tonight: back to the idle pattern');
});

test('a forecast on the learned pattern lasts longer than one that assumes nonstop use', () => {
  const { state, end } = twoWeeks();
  const now = end + 9 * H; // Monday 09:00 of the third week
  state.active = 'a';
  state.accounts = { a: { id: 'a', plan: { label: 'Max 20x', multiplier: 20 }, addedAt: 0, usage: { weekly: { pct: 40, resetsAt: now + 5 * DAY }, fiveHour: null } } };
  state.lastSwitchAt = 0;
  const learned = forecast(state, cfg(), now, paceModel(state, now), now + 8 * DAY);
  const flat = forecast(state, cfg(), now, { week: 0.06, fiveHour: null }, now + 8 * DAY);
  // 55 points of a 20x = 2.2 Max-5x weeks: 36.7 working hours, so Thursday afternoon with nights and weekends off,
  // against 36.7 hours of nonstop use (Tuesday evening).
  assert.ok(learned.gapAt - flat.gapAt > 36 * H, `${(learned.gapAt - now) / H} h vs ${(flat.gapAt - now) / H} h`);
  assert.equal(learned.gapWhy, 'weekly');
});

test('the verdict says whether the renewal is reached and how many hours a day that allows', () => {
  const { state, end } = twoWeeks();
  const now = end + 9 * H;
  state.active = 'a';
  state.lastSwitchAt = 0;
  const run = (pct, renewInDays) => {
    state.accounts = { a: { id: 'a', plan: { label: 'Max 20x', multiplier: 20 }, addedAt: 0, usage: { weekly: { pct, resetsAt: now + renewInDays * DAY }, fiveHour: null } } };
    const m = paceModel(state, now);
    return verdictOf(state, cfg(), now, m, forecast(state, cfg(), now, m, now + 8 * DAY));
  };
  const easy = run(40, 2); // 2.2 units left, ~0.5 needed before Wednesday
  assert.equal(easy.ok, true);
  assert.ok(easy.slackUnits > 1);
  assert.ok(easy.budgetHoursPerDay > easy.typicalHoursPerDay);
  const tight = run(80, 5); // 0.6 units left: 10 working hours, the renewal is 5 days away
  assert.equal(tight.ok, false);
  assert.ok(tight.firstGapAt > now && tight.firstGapAt < now + 2 * DAY);
  assert.ok(tight.budgetHoursPerDay < tight.typicalHoursPerDay);
  assert.ok(Math.abs(tight.budgetHoursPerDay - 0.6 / 5 / 0.06) < 0.2);
});

test('nothing learned yet: no profile, and a forecast on the recent flat pace', () => {
  const s = emptyState();
  assert.equal(profile(s, monday()), null);
  assert.equal(paceModel(s, monday()), null);
  assert.equal(paceModel(s, monday(), { flatWeek: 0.05 }).basis, 'recente');
  assert.deepEqual(emptyLearn().ratio5, { w: 0, f: 0 });
});

test('the 5-hour ratio pairs the rises of the same stretch, even when the week moves in coarse steps', () => {
  const s = emptyState();
  const t0 = monday() + 9 * H;
  let w = 10;
  let f = 0;
  for (let i = 1; i <= 240; i++) {
    w += 0.03; // the week shows one decimal: most readings see no change in it
    f += 0.3;
    consume(s, 'a', 1, { weekly: { pct: Math.floor(w * 10) / 10, resetsAt: t0 + 5 * DAY }, fiveHour: { pct: Math.round(f * 10) / 10, resetsAt: t0 + 5 * H }, at: t0 + i * 60 });
  }
  const ratio = s.learn.ratio5.f / s.learn.ratio5.w;
  assert.ok(Math.abs(ratio - 10) < 1, `learned ${ratio}`);
});

test('a week that drops inside the same window (an early reset) is learned from its new level', () => {
  const s = emptyState();
  const t0 = monday() + 9 * H;
  const reset = t0 + 6 * DAY;
  consume(s, 'a', 1, { weekly: { pct: 80, resetsAt: reset }, at: t0 });
  consume(s, 'a', 1, { weekly: { pct: 0, resetsAt: reset }, at: t0 + 60 });
  for (let k = 1; k <= 10; k++) consume(s, 'a', 1, { weekly: { pct: k, resetsAt: reset }, at: t0 + 60 + k * 600 });
  const spent = Object.values(s.learn.hours).reduce((sum, e) => sum + e.u, 0);
  assert.ok(Math.abs(spent - 0.1) < 1e-9, `learned ${spent}`);
});

test('a clock that went back does not stop the learning', () => {
  const s = emptyState();
  const t0 = monday() + 9 * H;
  const reset = t0 + 6 * DAY;
  observe(s, t0 + 2 * H); // two hours ahead
  consume(s, 'a', 1, { weekly: { pct: 10, resetsAt: reset }, at: t0 + 2 * H });
  observe(s, t0); // set right
  consume(s, 'a', 1, { weekly: { pct: 10, resetsAt: reset }, at: t0 });
  observe(s, t0 + 600);
  consume(s, 'a', 1, { weekly: { pct: 12, resetsAt: reset }, at: t0 + 600 });
  const hours = Object.values(s.learn.hours);
  assert.ok(Math.abs(hours.reduce((sum, e) => sum + e.u, 0) - 0.02) < 1e-9);
  assert.equal(hours.reduce((sum, e) => sum + e.s, 0), 600);
});

test('a reading with only the 5-hour window does not move the weekly baseline; a removed account is forgotten', async () => {
  const env = setup();
  const a = await connect(env, A);
  const at = env.clock.t;
  env.core.applyUsage(a, { weekly: { pct: 10, resetsAt: at + 3 * DAY } }, at, 'api');
  env.core.applyUsage(a, { fiveHour: { pct: 40, resetsAt: at + 4 * H } }, at + 3 * H, 'linha');
  assert.equal(env.core.state.learn.high[a.id].at, at);
  assert.equal(env.core.state.learn.high[a.id].pct, 10);
  const { forget } = await import('../src/learn.mjs');
  forget(env.core.state, a.id);
  assert.equal(env.core.state.learn.high[a.id], undefined);
});

test('the verdict agrees with the forecast: an account renewing before the target counts as room', () => {
  const { state, end } = twoWeeks();
  const now = end + 9 * H;
  state.active = 'a';
  state.lastSwitchAt = 0;
  state.accounts = {
    a: { id: 'a', plan: { label: 'Max 20x', multiplier: 20 }, addedAt: 0, usage: { weekly: { pct: 80, resetsAt: now + 5 * DAY }, fiveHour: null } },
    // nearly spent, but renewing tomorrow
    b: { id: 'b', plan: { label: 'Max 20x', multiplier: 20 }, addedAt: 1, usage: { weekly: { pct: 94, resetsAt: now + DAY }, fiveHour: null } },
  };
  const c = cfg({ order: ['a', 'b'] });
  const m = paceModel(state, now);
  const v = verdictOf(state, c, now, m, forecast(state, c, now, m, now + 8 * DAY));
  assert.equal(v.ok, true);
  assert.ok(v.roomy || v.slackUnits > 0, JSON.stringify(v));
  assert.ok(v.roomy || v.budgetHoursPerDay > v.typicalHoursPerDay, JSON.stringify(v));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addActivity, batonTime, burnRate, dayKey, forecast, insights, recordHistory, setActive, totalsDelta } from '../src/insights.mjs';
import { DEFAULT_CONFIG, emptyState } from '../src/state.mjs';

const H = 3600;
const NOW = 1_800_000_000;
const cfg = (extra = {}) => ({ ...DEFAULT_CONFIG, order: [], ...extra });
const acc = (id, mult, pct, resetsAt, extra = {}) => ({
  id,
  addedAt: extra.addedAt ?? 0,
  plan: { label: `Max ${mult}x`, multiplier: mult },
  usage: pct === null ? null : { weekly: { pct, resetsAt }, fiveHour: null },
  ...extra,
});
function state(active, accounts, extra = {}) {
  return { ...emptyState(), active, accounts: Object.fromEntries(accounts.map((a) => [a.id, a])), ...extra };
}

test('the baton timeline keeps one open segment and closes it on a change', () => {
  const s = emptyState();
  setActive(s, 'a', NOW);
  setActive(s, 'a', NOW + 10);
  setActive(s, 'b', NOW + 100);
  setActive(s, null, NOW + 200);
  assert.deepEqual(s.timeline, [
    { id: 'a', from: NOW, to: NOW + 100 },
    { id: 'b', from: NOW + 100, to: NOW + 200 },
  ]);
  assert.deepEqual(batonTime(s, NOW + 50, NOW + 150), { a: 50, b: 50 });
});

test('history is thinned and the pace comes from the same week only', () => {
  const s = emptyState();
  const a = { id: 'a', usage: null };
  const reset = NOW + 3 * 24 * H;
  for (let i = 0; i <= 12; i++) {
    a.usage = { weekly: { pct: 40 + i, resetsAt: reset }, fiveHour: { pct: 10, resetsAt: NOW } };
    recordHistory(s, a, NOW + i * 600); // 10-minute readings, 1% each → 6%/h
  }
  assert.equal(s.history.a.length, 13);
  assert.equal(Math.round(burnRate(s, 'a', NOW + 7200) * 10) / 10, 6);
  // a reading within 5 minutes replaces the last point instead of adding one
  a.usage.weekly.pct = 53;
  recordHistory(s, a, NOW + 7260);
  assert.equal(s.history.a.length, 13);
  // a new week: the previous week's points no longer count
  a.usage = { weekly: { pct: 1, resetsAt: reset + 7 * 24 * H }, fiveHour: null };
  recordHistory(s, a, NOW + 7600);
  assert.equal(burnRate(s, 'a', NOW + 7600), null);
});

test('too little history gives no pace', () => {
  const s = emptyState();
  const a = { id: 'a', usage: { weekly: { pct: 10, resetsAt: NOW + H }, fiveHour: null } };
  recordHistory(s, a, NOW);
  a.usage.weekly.pct = 11;
  recordHistory(s, a, NOW + 600);
  assert.equal(burnRate(s, 'a', NOW + 600), null);
});

test('session totals become deltas; a restarted session counts from zero', () => {
  assert.equal(totalsDelta(null, { cost: 1 }), null);
  assert.deepEqual(totalsDelta({ cost: 1, tokensIn: 100 }, { cost: 1.5, tokensIn: 250 }), { cost: 0.5, tokensIn: 150, tokensOut: 0, linesAdded: 0, linesRemoved: 0 });
  assert.equal(totalsDelta({ cost: 5 }, { cost: 0.2 }).cost, 0.2);
  const s = emptyState();
  addActivity(s, 'a', NOW, { cost: 0.5, tokensIn: 150 });
  addActivity(s, 'a', NOW + 60, { cost: 0.25, linesAdded: 3 });
  assert.deepEqual(s.activity.a[dayKey(NOW)], { cost: 0.75, tokensIn: 150, tokensOut: 0, linesAdded: 3, linesRemoved: 0 });
});

test('forecast: the 20x runs to the trigger, then the queue takes over, then a gap until the first reset', () => {
  // pace: 1 Max-5x week per 10 hours. The 20x (capacity 4) at 85%: 10% left → 0.4 units → 4 h.
  const s = state('a', [acc('a', 20, 85, NOW + 100 * H), acc('b', 5, 45, NOW + 50 * H, { addedAt: 1 }), acc('c', 5, 95.5, NOW + 20 * H, { addedAt: 2 })]);
  const f = forecast(s, cfg(), NOW, { week: 0.1, fiveHour: null }, NOW + 30 * H);
  assert.equal(f.segments[0].id, 'a');
  assert.equal(f.segments[0].to, NOW + 4 * H);
  // b: 50% left → 0.5 units → 5 h
  assert.deepEqual(f.segments[1], { id: 'b', from: NOW + 4 * H, to: NOW + 9 * H });
  // c is at the limit until its week resets at +20 h: nothing to use in between
  assert.deepEqual(f.segments[2], { id: null, from: NOW + 9 * H, to: NOW + 20 * H });
  assert.equal(f.gapAt, NOW + 9 * H);
  assert.equal(f.segments[3].id, 'c');
});

test('forecast: the preferred account comes back when its week resets', () => {
  const s = state('b', [acc('a', 20, 99, NOW + 2 * H), acc('b', 5, 10, NOW + 90 * H, { addedAt: 1 })]);
  const f = forecast(s, cfg(), NOW, { week: 0.01, fiveHour: null }, NOW + 10 * H);
  assert.deepEqual(f.segments.map((x) => x.id), ['b', 'a']);
  assert.equal(f.segments[1].from, NOW + 2 * H);
  assert.equal(f.gapAt, null);
  // a manual choice holds
  assert.deepEqual(forecast({ ...s, pinned: true }, cfg(), NOW, { week: 0.01, fiveHour: null }, NOW + 10 * H).segments.map((x) => x.id), ['b']);
});

test('insights: pace across accounts, rotation left, live sessions and today', () => {
  const s = state('a', [acc('a', 20, 50, NOW + 80 * H), acc('b', 5, 20, NOW + 60 * H, { addedAt: 1 })]);
  for (let i = 0; i <= 6; i++) {
    s.history.a = [...(s.history.a ?? []), [NOW - 3 * H + i * 1800, 47 + i * 0.5, null, NOW + 80 * H]];
  }
  s.sessions = { x: { at: NOW - 30, model: 'Opus', ctx: 41 }, y: { at: NOW - 10, model: 'Sonnet', ctx: 12 }, old: { at: NOW - 900 } };
  addActivity(s, 'a', NOW - 60, { cost: 12.5, tokensIn: 1000, tokensOut: 200, linesAdded: 40, linesRemoved: 2 });
  const v = insights(s, cfg(), NOW);
  assert.equal(Math.round(v.perAccount.a.ratePctPerHour * 10) / 10, 1);
  // 1%/h of a 20x (capacity 4) → 0.04 Max-5x weeks per hour
  assert.equal(Math.round(v.rotation.unitsPerHour * 1000) / 1000, 0.04);
  // left until 95%: a 45% of 4 = 1.8; b 75% of 1 = 0.75
  assert.equal(Math.round(v.rotation.leftUnits * 100) / 100, 2.55);
  assert.equal(Math.round(v.rotation.hoursLeft), 64);
  assert.equal(v.perAccount.a.etaToTrigger, NOW + 45 * H);
  assert.equal(v.live.sessions, 2);
  assert.deepEqual(v.live.models, ['Opus', 'Sonnet']);
  assert.equal(v.live.maxContext, 41);
  assert.equal(v.today.cost, 12.5);
  assert.ok(v.forecast.segments.length >= 1);
});

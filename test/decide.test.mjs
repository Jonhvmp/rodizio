import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RETURN_GAP_S, SWITCH_GAP_S, decide, effPct, nextCandidate, priority } from '../src/decide.mjs';
import { DEFAULT_CONFIG } from '../src/state.mjs';

const NOW = 1_800_000_000;
const acc = (id, weekly, extra = {}) => ({
  id,
  addedAt: extra.addedAt ?? 0,
  plan: { multiplier: extra.mult ?? 5 },
  usage: weekly === undefined ? null : { weekly: { pct: weekly, resetsAt: extra.resetsAt ?? NOW + 86_400 } },
  ...extra,
});
const state = (active, accounts, extra = {}) => ({
  active,
  lastSwitchAt: NOW - 3600,
  accounts: Object.fromEntries(accounts.map((a) => [a.id, a])),
  ...extra,
});
const cfg = (extra = {}) => ({ ...DEFAULT_CONFIG, order: [], ...extra });

test('a window whose reset time passed counts as empty', () => {
  assert.equal(effPct({ pct: 99, resetsAt: NOW - 1 }, NOW), 0);
  assert.equal(effPct({ pct: 40, resetsAt: NOW + 1 }, NOW), 40);
  assert.equal(effPct(null, NOW), null);
});

test('priority: dashboard order first, then bigger plan, then oldest', () => {
  const s = state('a', [acc('a', 0, { mult: 5, addedAt: 1 }), acc('b', 0, { mult: 20, addedAt: 2 }), acc('c', 0, { mult: 5, addedAt: 0 })]);
  assert.deepEqual(priority(s, cfg()), ['b', 'c', 'a']);
  assert.deepEqual(priority(s, cfg({ order: ['a'] })), ['a', 'b', 'c']);
});

test('switches when 5% of the week is left, not before', () => {
  const others = [acc('b', 10), acc('c', 20)];
  assert.deepEqual(decide(state('a', [acc('a', 94.9), ...others]), cfg(), NOW), { kind: 'none' });
  const d = decide(state('a', [acc('a', 95), ...others]), cfg(), NOW);
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'b');
  assert.match(d.reason, /faltavam 5% da semana/);
});

test('with a 3% margin it waits until 97%', () => {
  const others = [acc('b', 10)];
  assert.equal(decide(state('a', [acc('a', 96), ...others]), cfg({ remainingPct: 3 }), NOW).kind, 'none');
  assert.equal(decide(state('a', [acc('a', 97), ...others]), cfg({ remainingPct: 3 }), NOW).kind, 'switch');
});

test('skips accounts that are full, paused or need a login; unmeasured counts as free', () => {
  const s = state('a', [
    acc('a', 96, { mult: 20 }),
    acc('b', 99, { mult: 5, addedAt: 1 }),
    acc('c', 5, { mult: 5, addedAt: 2, paused: true }),
    acc('d', 5, { mult: 5, addedAt: 3, needsLogin: true }),
    acc('e', undefined, { mult: 5, addedAt: 4 }),
  ]);
  assert.equal(nextCandidate(s, cfg(), NOW), 'e');
  assert.equal(decide(s, cfg(), NOW).to, 'e');
});

test('an account whose week reset is free again', () => {
  const s = state('a', [acc('a', 96), acc('b', 99, { resetsAt: NOW - 10 })]);
  assert.equal(decide(s, cfg(), NOW).to, 'b');
});

test('exhausted when there is nowhere to go', () => {
  assert.deepEqual(decide(state('a', [acc('a', 97), acc('b', 98)]), cfg(), NOW), { kind: 'exhausted', window: 'weekly' });
});

test('waits a little between automatic switches', () => {
  const s = state('a', [acc('a', 97), acc('b', 1)], { lastSwitchAt: NOW - SWITCH_GAP_S + 5 });
  assert.equal(decide(s, cfg(), NOW).kind, 'none');
});

test('goes back to the preferred account once its week resets', () => {
  const accounts = [acc('a', 96, { mult: 20, resetsAt: NOW - 5 }), acc('b', 30)];
  assert.deepEqual(decide(state('b', accounts, { lastSwitchAt: NOW - RETURN_GAP_S }), cfg(), NOW), {
    kind: 'switch',
    to: 'a',
    reason: 'a conta preferida tem folga de novo',
    window: null,
  });
  assert.equal(decide(state('b', accounts, { lastSwitchAt: NOW - 60 }), cfg(), NOW).kind, 'none');
  assert.equal(decide(state('b', accounts, { lastSwitchAt: NOW - RETURN_GAP_S }), cfg({ returnToPreferred: false }), NOW).kind, 'none');
});

test('a manual choice is not undone by the return to the preferred account', () => {
  const accounts = [acc('a', 0, { mult: 20 }), acc('b', 30)];
  assert.equal(decide(state('b', accounts, { lastSwitchAt: 0, pinned: true }), cfg(), NOW).kind, 'none');
  // ...but the threshold still applies to it
  const full = [acc('a', 0, { mult: 20 }), acc('b', 96)];
  assert.equal(decide(state('b', full, { lastSwitchAt: 0, pinned: true }), cfg(), NOW).to, 'a');
});

test('does not go back to a preferred account that was never measured or is still high', () => {
  assert.equal(decide(state('b', [acc('a', undefined, { mult: 20 }), acc('b', 30)], { lastSwitchAt: 0 }), cfg(), NOW).kind, 'none');
  assert.equal(decide(state('b', [acc('a', 88, { mult: 20 }), acc('b', 30)], { lastSwitchAt: 0 }), cfg(), NOW).kind, 'none');
});

test('nothing happens with automatic switching off', () => {
  assert.deepEqual(decide(state('a', [acc('a', 99), acc('b', 1)]), cfg({ auto: false }), NOW), { kind: 'none' });
});

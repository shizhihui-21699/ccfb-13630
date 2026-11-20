import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchema } from 'graphql';
import { analyzeQueryCost } from '../src/cost/analyzer.js';
import { DEFAULT_PRICING } from '../src/cost/pricing.js';
import { decide, type QuotaPlan, type RemainingQuota } from '../src/cost/decision.js';
import { SCHEMA_SDL } from '../src/schema/sdl.js';
import { QuotaStore } from '../src/gateway/quota-store.js';
import { CALLERS } from '../src/gateway/callers.js';

const schema = buildSchema(SCHEMA_SDL);
const plan: QuotaPlan = {
  maxQueryCost: 1_000,
  perMinuteBudget: 5_000,
  perDayBudget: 50_000,
  maxDepth: 10,
};
const full: RemainingQuota = {
  minute: { used: 0, limit: 5_000, remaining: 5_000 },
  day: { used: 0, limit: 50_000, remaining: 50_000 },
};

test('query under every limit is allowed', () => {
  const s = analyzeQueryCost({
    query: '{ me { id displayName } }',
    schema,
    pricing: DEFAULT_PRICING,
    maxDepth: 10,
  });
  assert.equal(decide(s, plan, full).allowed, true);
});

test('per-query cost limit rejects with actionable contributor details', () => {
  const s = analyzeQueryCost({
    query: '{ users(first: 100) { id posts(first: 100) { id comments(first: 100) { id } } } }',
    schema,
    pricing: DEFAULT_PRICING,
    maxDepth: 10,
  });
  const verdict = decide(s, plan, full);
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.equal(verdict.rejection.code, 'COST_LIMIT_EXCEEDED');
  assert.ok(verdict.rejection.details.some((d) => d.includes('Query.users')));
});

test('minute-window budget blocks once consumed, independent of per-query cap', () => {
  const s = analyzeQueryCost({
    query: '{ me { id } }',
    schema,
    pricing: DEFAULT_PRICING,
    maxDepth: 10,
  });
  const tight: RemainingQuota = {
    minute: { used: 4_999, limit: 5_000, remaining: 1 },
    day: full.day,
  };
  const verdict = decide(s, plan, tight);
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed) assert.equal(verdict.rejection.code, 'QUOTA_EXCEEDED');
});

test('QuotaStore rolls fixed windows and charges only allowed queries', () => {
  const store = new QuotaStore();
  const caller = CALLERS[0]!;
  const t0 = new Date('2026-11-20T09:00:30Z');
  store.recordAllowed(caller, 100, t0);
  store.recordAllowed(caller, 200, t0);
  assert.equal(store.remaining(caller, t0).minute.used, 300);

  // Same hour, next minute: minute window resets, day window keeps accumulating.
  const t1 = new Date('2026-11-20T09:01:05Z');
  assert.equal(store.remaining(caller, t1).minute.used, 0);
  assert.equal(store.remaining(caller, t1).day.used, 300);

  // Next UTC day: both windows reset.
  const t2 = new Date('2026-11-21T00:00:01Z');
  assert.equal(store.remaining(caller, t2).day.used, 0);
  assert.equal(store.remaining(caller, t2).minute.used, 0);

  store.recordRejected(caller, t2);
  const snap = store.snapshot()[caller.apiKey]!;
  assert.equal(snap.totalRejected, 1);
  assert.equal(snap.totalRequests, 2);
});

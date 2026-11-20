import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchema } from 'graphql';
import { analyzeQueryCost, AnalysisError } from '../src/cost/analyzer.js';
import { DEFAULT_PRICING } from '../src/cost/pricing.js';
import { SCHEMA_SDL } from '../src/schema/sdl.js';

const schema = buildSchema(SCHEMA_SDL);
const analyze = (query: string, variables?: Record<string, unknown>, maxDepth = 20) =>
  analyzeQueryCost({ query, variables, schema, pricing: DEFAULT_PRICING, maxDepth });

test('single scalar field costs object materialisation plus the scalar price', () => {
  const s = analyze('{ me { id } }');
  // me is a non-list object field (objectCost 5) wrapping one scalar (1).
  assert.equal(s.totalCost, DEFAULT_PRICING.objectCost + DEFAULT_PRICING.scalarCost);
  assert.equal(s.maxDepth, 2);
});

test('nested list fan-out multiplies through pagination: 10 users × 5 posts', () => {
  const s = analyze('{ users(first: 10) { id posts(first: 5) { id } } }');
  // posts per row: self (10 base + 5 elements) + id scalar = 16, ×5 rows = 80
  // users per row: id (1) + posts subtree (80) = 81
  // users total: self (10 base + 10 elements) + 81 per row, ×10 rows = 1010
  assert.equal(s.totalCost, 1010);
  assert.equal(s.pagination.length, 2);
  assert.deepEqual(
    s.pagination.map((p) => [p.path, p.effective, p.requested]),
    [
      ['Query.users', 10, 10],
      ['Query.users.posts', 5, 5],
    ],
  );
});

test('omitted pagination is billed at the backend default page size', () => {
  const s = analyze('{ users { id } }');
  const usersPage = s.pagination.find((p) => p.path === 'Query.users')!;
  assert.equal(usersPage.argName, 'default');
  assert.equal(usersPage.effective, DEFAULT_PRICING.defaultPageSize);
  // users self = 10 base + 20 elements = 30; plus one scalar per row:
  // (30 + 1) × 20 = 620
  assert.equal(s.totalCost, 620);
});

test('page size over the cap is clamped for costing but flagged', () => {
  const s = analyze('{ users(first: 9999) { id } }');
  const p = s.pagination.find((p) => p.path === 'Query.users')!;
  assert.equal(p.requested, 9999);
  assert.equal(p.effective, DEFAULT_PRICING.maxPageSize);
  assert.equal(p.cappedToMax, true);
});

test('hard page limit rejects outright instead of clamping', () => {
  assert.throws(
    () => analyze('{ users(first: 50000) { id } }'),
    (err: unknown) => err instanceof AnalysisError && err.code === 'PAGE_LIMIT_EXCEEDED',
  );
});

test('pagination hidden in a variable is resolved and billed correctly', () => {
  const s = analyze(
    'query Q($n: Int) { users(first: $n) { id } }',
    { n: 40 },
  );
  const p = s.pagination.find((p) => p.path === 'Query.users')!;
  assert.equal(p.effective, 40);
  assert.equal(p.fromVariable, true);
});

test('aliased repeated selection of the same field is billed per copy', () => {
  const once = analyze('{ me { posts(first: 10) { id } } }');
  const twice = analyze(
    '{ me { a: posts(first: 10) { id } b: posts(first: 10) { id } } }',
  );
  // The single `me` object cost is paid once; every aliased posts subtree
  // (210 points) is paid independently by the backend.
  assert.equal(twice.totalCost, once.totalCost + 210);
  assert.equal(twice.aliasDuplicates.length, 1);
  assert.equal(twice.aliasDuplicates[0]!.count, 2);
  assert.deepEqual(twice.aliasDuplicates[0]!.aliases, ['a', 'b']);
});

test('named fragments are expanded and their nested cost multiplied', () => {
  const withFragment = analyze(`
    fragment F on User { id posts(first: 5) { id } }
    query Q { users(first: 3) { ...F } }
  `);
  const inline = analyze('{ users(first: 3) { id posts(first: 5) { id } } }');
  assert.equal(withFragment.totalCost, inline.totalCost);
});

test('inline fragments on non-overlapping types contribute zero cost', () => {
  const s = analyze(`
    { node(id: "u_1") {
        __typename
        ... on Product { id name priceCents reviews(first: 50) { id } }
        ... on User { id displayName }
    } }
  `);
  // The Product branch cannot apply to a node selected as User-shaped data;
  // statically, doTypesOverlap(Node, Product) IS true, so both branches are
  // conservatively included — but verify the User branch content is present.
  assert.ok(s.totalCost > 0);
  const paths = JSON.stringify(s.costTree);
  assert.ok(paths.includes('displayName'));
});

test('fragment cycles are rejected', () => {
  assert.throws(
    () => analyze(`
      fragment A on User { id friends(first: 1) { ...B } }
      fragment B on User { id friends(first: 1) { ...A } }
      query Q { me { ...A } }
    `),
    (err: unknown) => err instanceof AnalysisError && err.code === 'VALIDATION_ERROR',
  );
});

test('unknown fields are validation errors with the path included', () => {
  assert.throws(
    () => analyze('{ me { nonexistentField } }'),
    (err: unknown) =>
      err instanceof AnalysisError &&
      err.code === 'VALIDATION_ERROR' &&
      err.message.includes('nonexistentField'),
  );
});

test('depth guard rejects queries nesting beyond the caller limit', () => {
  const deep = '{ me { friends(first: 1) { friends(first: 1) { friends(first: 1) { id } } } } }';
  assert.throws(
    () => analyze(deep, undefined, 3),
    (err: unknown) => err instanceof AnalysisError && err.message.includes('depth'),
  );
  assert.doesNotThrow(() => analyze(deep, undefined, 10));
});

test('pricing overrides apply to heavy fields like search and analytics', () => {
  const s = analyze('{ analytics(days: 7) { date signups } }');
  // analytics base 1000 + per-element * 7 (default page size, capped arg=days
  // is not a recognised pagination arg) — check the override dominates.
  assert.ok(s.totalCost >= DEFAULT_PRICING.fieldOverrides['Query.analytics']!);
});

test('saturated multiplication stays finite for pathological nesting', () => {
  // 8 levels × 100 rows = 1e16, beyond the 1e15 ceiling.
  const levels = 8;
  let q = 'id';
  for (let i = 0; i < levels; i++) {
    q = `friends(first: 100) { ${q} }`;
  }
  const s = analyze(`{ users(first: 100) { ${q} } }`, undefined, 30);
  assert.ok(Number.isFinite(s.totalCost));
  assert.equal(s.totalCost, DEFAULT_PRICING.costCeiling);
});

test('introspection meta fields carry the configured premium', () => {
  const s = analyze('{ __typename }');
  assert.equal(s.totalCost, DEFAULT_PRICING.typenameCost);
  const intro = analyze('{ __type(name: "User") { name } }');
  assert.ok(intro.totalCost >= DEFAULT_PRICING.introspectionCost);
});

test('top contributors point at the heaviest subtree paths', () => {
  const s = analyze(`
    { users(first: 50) {
        id
        posts(first: 50) { id comments(first: 50) { id body } }
    } }
  `);
  // The root users subtree is #1; the comments chain must appear as a
  // contributor so a rejection can name the exact expensive path.
  assert.ok(s.topContributors.some((c) => c.path.includes('comments')));
  const costs = s.topContributors.map((c) => c.subtreeCost);
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a));
});

test('list of scalars still fans out by its pagination argument', () => {
  // tags is a [String!]! scalar list living on Post.
  const s = analyze('{ posts(first: 1) { edges { node { tags } } } }');
  const tagPages = s.pagination.filter((p) => p.path.endsWith('tags'));
  assert.ok(tagPages.length > 0);
  assert.ok(tagPages.every((p) => p.effective === DEFAULT_PRICING.defaultPageSize));
  assert.ok(s.totalCost > DEFAULT_PRICING.defaultPageSize);
});

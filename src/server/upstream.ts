import express from 'express';
import { buildSchema, graphql, type GraphQLSchema } from 'graphql';
import { SCHEMA_SDL } from '../schema/sdl.js';

/**
 * The "backend" the gateway protects. Resolvers fabricate rows deterministically
 * and clamp page sizes defensively, so a forwarded query always gets a real
 * (mocked) response and the demo stays end-to-end.
 */
export function buildMockSchema(): GraphQLSchema {
  const schema = buildSchema(SCHEMA_SDL);
  return schema;
}

const clamp = (n: unknown, fallback: number, max = 100): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(0, Math.min(v, max));
};

const now = () => new Date('2026-11-20T09:00:00.000Z').toISOString();

function makeUser(id: number) {
  return {
    id: `u_${id}`,
    createdAt: now(),
    email: `user${id}@example.test`,
    displayName: `User ${id}`,
    role: id === 1 ? 'ADMIN' : 'MEMBER',
    posts: (args: { first?: unknown; last?: unknown }) =>
      makePosts(clamp(args.first ?? args.last, 20), id),
    friends: (args: { first?: unknown; last?: unknown }) =>
      Array.from({ length: clamp(args.first ?? args.last, 20) }, (_, i) =>
        makeUser((id + i + 7) % 97 + 1),
      ),
    orders: (args: { limit?: unknown }) =>
      Array.from({ length: clamp(args.limit, 10) }, (_, i) => makeOrder(id * 10 + i)),
  };
}

function makePost(id: number, authorId = (id % 13) + 1) {
  return {
    id: `p_${id}`,
    createdAt: now(),
    title: `Post ${id}`,
    body: `Body text for post ${id}. `.repeat(4),
    author: () => makeUser(authorId),
    tags: ['graphql', 'security', 'cost-control'],
    comments: (args: { first?: unknown; last?: unknown }) =>
      Array.from({ length: clamp(args.first ?? args.last, 10) }, (_, i) => ({
        id: `c_${id}_${i}`,
        createdAt: now(),
        body: `Comment ${i} on post ${id}`,
        author: makeUser((id + i) % 50 + 1),
        post: () => makePost(id),
      })),
    viewerCanEdit: true,
  };
}

function makePosts(n: number, authorId?: number) {
  return Array.from({ length: n }, (_, i) => makePost(i + 1, authorId));
}

function makeProduct(id: number) {
  return {
    id: `pr_${id}`,
    createdAt: now(),
    name: `Product ${id}`,
    priceCents: id * 999,
    sku: `SKU-${1000 + id}`,
    reviews: (args: { first?: unknown; last?: unknown }) =>
      Array.from({ length: clamp(args.first ?? args.last, 5) }, (_, i) => ({
        id: `r_${id}_${i}`,
        createdAt: now(),
        rating: (i % 5) + 1,
        body: `Review ${i}`,
        product: () => makeProduct(id),
      })),
  };
}

function makeOrder(id: number) {
  return {
    id: `o_${id}`,
    createdAt: now(),
    totalCents: id * 1_250,
    status: ['PENDING', 'PAID', 'SHIPPED', 'CANCELLED'][id % 4]!,
    items: (args: { limit?: unknown }) =>
      Array.from({ length: clamp(args.limit, 3) }, (_, i) => {
        const product = makeProduct((id + i) % 40 + 1);
        return { product, quantity: i + 1, unitPriceCents: product.priceCents };
      }),
  };
}

const root = {
  me: () => makeUser(1),
  user: ({ id }: { id: string }) => makeUser(Number(String(id).replace(/\D/g, '')) || 1),
  users: ({ first, last }: { first?: unknown; last?: unknown }) =>
    Array.from({ length: clamp(first ?? last, 20) }, (_, i) => makeUser(i + 1)),
  posts: ({ first, last }: { first?: unknown; last?: unknown; after?: string }) => {
    const n = clamp(first ?? last, 20);
    const edges = makePosts(n).map((node, i) => ({
      cursor: `cursor_${i}`,
      node,
    }));
    return {
      edges,
      pageInfo: { hasNextPage: n >= 100, endCursor: edges.at(-1)?.cursor ?? null },
      totalCount: n,
    };
  },
  post: ({ id }: { id: string }) => makePost(Number(String(id).replace(/\D/g, '')) || 1),
  products: ({
    first,
    last,
    take,
  }: {
    first?: unknown;
    last?: unknown;
    take?: unknown;
  }) => Array.from({ length: clamp(first ?? last ?? take, 20) }, (_, i) => makeProduct(i + 1)),
  product: ({ sku }: { sku: string }) =>
    makeProduct(Number(String(sku).replace(/\D/g, '')) || 1),
  search: ({ term, first, last }: { term: string; first?: unknown; last?: unknown }) => {
    const n = clamp(first ?? last, 10);
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const kind = i % 3;
      if (kind === 0) out.push(makeUser(i + 1));
      else if (kind === 1) out.push(makePost(i + 1));
      else out.push(makeProduct(i + 1));
    }
    return out.map((row) => ({ ...(row as object), _term: term }));
  },
  analytics: ({ days }: { days: number }) =>
    Array.from({ length: clamp(days, 30, 90) }, (_, i) => ({
      date: `2026-11-${String(20 - i).padStart(2, '0')}`,
      signups: 12 + i,
      activeUsers: 400 + i * 7,
      revenueCents: 9_900 + i * 321,
    })),
  auditLog: ({ limit }: { limit?: unknown }) =>
    Array.from({ length: clamp(limit, 25) }, (_, i) => `event ${i}: ok`),
  node: ({ id }: { id: string }) => {
    if (id.startsWith('u_')) return makeUser(Number(id.slice(2)));
    if (id.startsWith('p_')) return makePost(Number(id.slice(2)));
    return makeProduct(Number(id.replace(/\D/g, '')) || 1);
  },
  createPost: ({ title, body }: { title: string; body: string }) =>
    makePost(Math.floor(Math.random() * 1_000)),
  updateProfile: ({ displayName }: { displayName: string }) => ({
    ...makeUser(1),
    displayName,
  }),
};

export async function startUpstream(port: number): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const schema = buildMockSchema();

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post('/graphql', async (req, res) => {
    const { query, variables, operationName } = req.body ?? {};
    if (typeof query !== 'string') {
      res.status(400).json({ errors: [{ message: 'Missing "query" string' }] });
      return;
    }
    const result = await graphql({
      schema,
      source: query,
      rootValue: root,
      variableValues: variables ?? undefined,
      operationName: operationName ?? undefined,
    });
    res.json(result);
  });

  await new Promise<void>((resolve) => app.listen(port, resolve));
  console.log(`[upstream] mock GraphQL backend listening on http://localhost:${port}/graphql`);
}

if (process.argv[1]?.endsWith('upstream.ts')) {
  const port = Number(process.env.UPSTREAM_PORT ?? 4001);
  startUpstream(port).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildSchema } from 'graphql';
import { analyzeQueryCost, AnalysisError } from '../cost/analyzer.js';
import { DEFAULT_PRICING } from '../cost/pricing.js';
import { decide } from '../cost/decision.js';
import { findCaller } from '../gateway/callers.js';
import { QuotaStore } from '../gateway/quota-store.js';
import { EventLog, type GatewayEvent } from '../gateway/event-log.js';
import { SCHEMA_SDL } from '../schema/sdl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.GATEWAY_PORT ?? 4000);
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? 'http://localhost:4001/graphql';
const EVENT_LOG_FILE = resolve(process.cwd(), process.env.EVENT_LOG_FILE ?? './data/events.jsonl');

const schema = buildSchema(SCHEMA_SDL);
const quotaStore = new QuotaStore();
const eventLog = new EventLog(EVENT_LOG_FILE);

const app = express();
app.use(express.json({ limit: '2mb' }));

interface GraphqlRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, upstream: UPSTREAM_URL });
});

/**
 * Dry-run cost explanation: analyse a query without charging quota or touching
 * the upstream, so callers can self-serve budget checks before sending traffic.
 */
app.post('/admin/explain', (req, res) => {
  const body = (req.body ?? {}) as GraphqlRequestBody;
  if (typeof body.query !== 'string') {
    res.status(400).json({ error: 'Request body must contain a "query" string' });
    return;
  }
  const variables =
    body.variables && typeof body.variables === 'object'
      ? (body.variables as Record<string, unknown>)
      : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  try {
    const summary = analyzeQueryCost({
      query: body.query,
      operationName,
      variables,
      schema,
      pricing: DEFAULT_PRICING,
      maxDepth: Number.MAX_SAFE_INTEGER,
    });
    res.json({
      ok: true,
      totalCost: summary.totalCost,
      totalEstimatedResolutions: summary.totalEstimatedResolutions,
      staticFieldCount: summary.staticFieldCount,
      maxDepth: summary.maxDepth,
      maxPageSizeRequested: summary.maxPageSizeRequested,
      pagination: summary.pagination,
      aliasDuplicates: summary.aliasDuplicates,
      topContributors: summary.topContributors,
    });
  } catch (err) {
    if (err instanceof AnalysisError) {
      res.status(400).json({ ok: false, code: err.code, error: err.message });
      return;
    }
    throw err;
  }
});

/** Everything the dashboard needs in one round trip. */
app.get('/admin/stats', (_req, res) => {
  const events = eventLog.all();
  const now = new Date();

  const byCaller = new Map<
    string,
    {
      callerName: string;
      tier: string;
      requests: number;
      allowed: number;
      rejected: number;
      totalCost: number;
      maxCost: number;
    }
  >();

  const minuteBuckets = new Map<string, { allowed: number; rejected: number; cost: number }>();

  for (const e of events) {
    const key = e.callerApiKey ?? 'anonymous';
    const cur =
      byCaller.get(key) ??
      ({
        callerName: e.callerName,
        tier: e.tier ?? 'unknown',
        requests: 0,
        allowed: 0,
        rejected: 0,
        totalCost: 0,
        maxCost: 0,
      });
    cur.requests += 1;
    if (e.decision === 'allowed') cur.allowed += 1;
    else cur.rejected += 1;
    cur.totalCost += e.estimatedCost;
    cur.maxCost = Math.max(cur.maxCost, e.estimatedCost);
    byCaller.set(key, cur);

    const bucket = e.timestamp.slice(11, 16); // HH:MM
    const b = minuteBuckets.get(bucket) ?? { allowed: 0, rejected: 0, cost: 0 };
    if (e.decision === 'allowed') {
      b.allowed += 1;
      b.cost += e.estimatedCost;
    } else {
      b.rejected += 1;
    }
    minuteBuckets.set(bucket, b);
  }

  const callers = [...byCaller.entries()].map(([apiKey, agg]) => {
    const caller = findCaller(apiKey);
    const remaining = caller ? quotaStore.remaining(caller, now) : null;
    const counters = quotaStore.snapshot()[apiKey];
    return {
      apiKey,
      ...agg,
      quota: caller
        ? {
            maxQueryCost: caller.quota.maxQueryCost,
            perMinuteBudget: caller.quota.perMinuteBudget,
            perDayBudget: caller.quota.perDayBudget,
            maxDepth: caller.quota.maxDepth,
          }
        : null,
      remaining,
      totalRequestsAllTime: counters?.totalRequests ?? agg.requests,
      totalRejectedAllTime: counters?.totalRejected ?? agg.rejected,
    };
  });

  const totals = {
    requests: events.length,
    allowed: events.filter((e) => e.decision === 'allowed').length,
    rejected: events.filter((e) => e.decision === 'rejected').length,
    cost: events
      .filter((e) => e.decision === 'allowed')
      .reduce((sum, e) => sum + e.estimatedCost, 0),
  };

  res.json({
    generatedAt: now.toISOString(),
    totals,
    callers,
    timeline: [...minuteBuckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-40)
      .map(([minute, v]) => ({ minute, ...v })),
    recent: eventLog.recent(60),
  });
});

app.post('/graphql', async (req, res) => {
  const started = Date.now();
  const body = (req.body ?? {}) as GraphqlRequestBody;
  const apiKey = headerApiKey(req);
  const caller = findCaller(apiKey);
  const queryPreview =
    typeof body.query === 'string' ? body.query.replace(/\s+/g, ' ').slice(0, 400) : '';

  const baseEvent = (): GatewayEvent => ({
    timestamp: new Date().toISOString(),
    callerApiKey: apiKey ?? null,
    callerName: caller?.name ?? 'anonymous',
    tier: caller?.tier ?? null,
    decision: 'rejected',
    estimatedCost: 0,
    estimatedResolutions: 0,
    depth: 0,
    staticFieldCount: 0,
    durationMs: 0,
    queryPreview,
  });

  if (!caller) {
    const event = baseEvent();
    event.rejectionCode = 'UNAUTHENTICATED';
    event.reason = 'Missing or invalid X-API-Key';
    event.durationMs = Date.now() - started;
    eventLog.append(event);
    res.status(401).json({
      errors: [
        {
          message: 'Unauthorized: provide a valid X-API-Key header',
          extensions: { code: 'UNAUTHENTICATED' },
        },
      ],
    });
    return;
  }

  if (typeof body.query !== 'string') {
    const event = baseEvent();
    event.rejectionCode = 'VALIDATION_ERROR';
    event.reason = 'Request body must contain a "query" string';
    event.durationMs = Date.now() - started;
    eventLog.append(event);
    quotaStore.recordRejected(caller, new Date());
    res.status(400).json({
      errors: [
        {
          message: 'Request body must contain a "query" string',
          extensions: { code: 'VALIDATION_ERROR' },
        },
      ],
    });
    return;
  }

  const variables =
    body.variables && typeof body.variables === 'object'
      ? (body.variables as Record<string, unknown>)
      : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;

  // ---- 1. Parse + pre-execution cost estimation ---------------------------
  let summary;
  try {
    summary = analyzeQueryCost({
      query: body.query,
      operationName,
      variables,
      schema,
      pricing: DEFAULT_PRICING,
      maxDepth: caller.quota.maxDepth,
    });
  } catch (err) {
    const event = baseEvent();
    event.operationName = operationName;
    event.durationMs = Date.now() - started;
    if (err instanceof AnalysisError) {
      event.rejectionCode = err.code;
      event.reason = err.message;
      eventLog.append(event);
      quotaStore.recordRejected(caller, new Date());
      const status = err.code === 'PAGE_LIMIT_EXCEEDED' ? 422 : 400;
      res.status(status).json({
        errors: [
          {
            message: err.message,
            extensions: { code: err.code },
          },
        ],
      });
      return;
    }
    throw err;
  }

  const costEvent = (decision: 'allowed' | 'rejected'): GatewayEvent => ({
    ...baseEvent(),
    decision,
    operationName,
    estimatedCost: summary.totalCost,
    estimatedResolutions: summary.totalEstimatedResolutions,
    depth: summary.maxDepth,
    staticFieldCount: summary.staticFieldCount,
    maxPageSize: summary.maxPageSizeRequested,
  });

  // ---- 2. Quota decision ---------------------------------------------------
  const remaining = quotaStore.remaining(caller, new Date());
  const verdict = decide(summary, caller.quota, remaining);

  if (!verdict.allowed) {
    const event = costEvent('rejected');
    event.rejectionCode = verdict.rejection.code;
    event.reason = verdict.rejection.message;
    event.durationMs = Date.now() - started;
    eventLog.append(event);
    quotaStore.recordRejected(caller, new Date());
    res.status(429).json({
      errors: [
        {
          message: verdict.rejection.message,
          extensions: {
            code: verdict.rejection.code,
            details: verdict.rejection.details,
            cost: summary.totalCost,
            limit: caller.quota.maxQueryCost,
            remaining,
          },
        },
      ],
    });
    return;
  }

  // ---- 3. Charge + forward to the backend ----------------------------------
  quotaStore.recordAllowed(caller, summary.totalCost, new Date());

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: body.query,
        variables,
        operationName,
      }),
    });
  } catch (err) {
    const event = costEvent('allowed');
    event.durationMs = Date.now() - started;
    event.reason = `Upstream unreachable: ${err instanceof Error ? err.message : String(err)}`;
    eventLog.append(event);
    res.status(502).json({
      errors: [{ message: 'Upstream GraphQL service unreachable' }],
    });
    return;
  }

  const payload = (await upstream.json()) as Record<string, unknown>;
  const event = costEvent('allowed');
  event.durationMs = Date.now() - started;
  eventLog.append(event);

  res.setHeader('X-Gateway-Cost', String(summary.totalCost));
  res.setHeader(
    'X-Gateway-Remaining-Minute',
    String(quotaStore.remaining(caller, new Date()).minute.remaining),
  );
  res.status(upstream.status).json({
    ...payload,
    extensions: {
      ...((payload.extensions as Record<string, unknown> | undefined) ?? {}),
      gateway: {
        estimatedCost: summary.totalCost,
        estimatedResolutions: summary.totalEstimatedResolutions,
        depth: summary.maxDepth,
        remaining: quotaStore.remaining(caller, new Date()),
      },
    },
  });
});

function headerApiKey(req: express.Request): string | undefined {
  const header = req.header('x-api-key');
  if (header) return header.trim();
  const bearer = req.header('authorization');
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7).trim();
  return undefined;
}

/** Dashboard page. */
app.get(['/', '/dashboard'], (_req, res) => {
  const html = readFileSync(resolve(__dirname, '../../public/dashboard.html'), 'utf8');
  res.type('html').send(html);
});

app.listen(PORT, () => {
  console.log(`[gateway] cost-aware GraphQL gateway on http://localhost:${PORT}`);
  console.log(`[gateway] endpoint:  POST http://localhost:${PORT}/graphql`);
  console.log(`[gateway] dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`[gateway] audit log: ${EVENT_LOG_FILE}`);
});

import type { QueryCostSummary, Rejection } from './types.js';

export interface QuotaPlan {
  /** Hard ceiling for a single query. */
  maxQueryCost: number;
  /** Budget shared across all queries in each rolling minute. */
  perMinuteBudget: number;
  /** Budget shared across all queries in the current UTC day. */
  perDayBudget: number;
  /** Allowed nesting depth. */
  maxDepth: number;
}

export interface RemainingQuota {
  minute: { used: number; limit: number; remaining: number };
  day: { used: number; limit: number; remaining: number };
}

const fmt = new Intl.NumberFormat('en-US');

/**
 * Decide whether an analysed query fits the caller's remaining quota.
 *
 * The per-query check runs first (it carries the most actionable explanation);
 * window budgets are checked without mutating any state — the gateway deducts
 * only after a query is allowed.
 */
export function decide(
  summary: QueryCostSummary,
  plan: QuotaPlan,
  remaining: RemainingQuota,
): { allowed: true } | { allowed: false; rejection: Rejection } {
  if (summary.totalCost > plan.maxQueryCost) {
    return {
      allowed: false,
      rejection: {
        code: 'COST_LIMIT_EXCEEDED',
        message: `Estimated query cost ${fmt.format(summary.totalCost)} exceeds per-query limit ${fmt.format(plan.maxQueryCost)}`,
        details: buildCostDetails(summary, plan),
      },
    };
  }

  if (remaining.minute.remaining < summary.totalCost) {
    return {
      allowed: false,
      rejection: {
        code: 'QUOTA_EXCEEDED',
        message: `Per-minute budget exhausted: query needs ${fmt.format(summary.totalCost)} but only ${fmt.format(remaining.minute.remaining)} of ${fmt.format(plan.perMinuteBudget)} remains this minute`,
        details: [
          `Minute window: ${fmt.format(remaining.minute.used)} / ${fmt.format(plan.perMinuteBudget)} used`,
          ...buildCostDetails(summary, plan).slice(0, 3),
        ],
      },
    };
  }

  if (remaining.day.remaining < summary.totalCost) {
    return {
      allowed: false,
      rejection: {
        code: 'QUOTA_EXCEEDED',
        message: `Daily budget exhausted: query needs ${fmt.format(summary.totalCost)} but only ${fmt.format(remaining.day.remaining)} of ${fmt.format(plan.perDayBudget)} remains today (UTC)`,
        details: [
          `Day window: ${fmt.format(remaining.day.used)} / ${fmt.format(plan.perDayBudget)} used`,
          ...buildCostDetails(summary, plan).slice(0, 3),
        ],
      },
    };
  }

  return { allowed: true };
}

/** Explain *where* the cost concentrates, so callers can actually fix it. */
function buildCostDetails(summary: QueryCostSummary, plan: QuotaPlan): string[] {
  const details: string[] = [];

  details.push(
    `Total estimated cost: ${fmt.format(summary.totalCost)} work points (per-query limit: ${fmt.format(plan.maxQueryCost)})`,
  );
  details.push(
    `Estimated backend field resolutions: ${fmt.format(summary.totalEstimatedResolutions)}; max nesting depth: ${summary.maxDepth} (limit: ${plan.maxDepth})`,
  );

  for (const c of summary.topContributors) {
    details.push(`· ${c.path} — ${fmt.format(c.subtreeCost)} points: ${c.reason}`);
  }

  const capped = summary.pagination.filter((p) => p.cappedToMax);
  for (const p of capped) {
    details.push(
      `· ${p.path}: requested ${p.argName}=${fmt.format(p.requested!)}, clamped to ${fmt.format(p.effective)} rows for costing`,
    );
  }

  for (const g of summary.aliasDuplicates) {
    details.push(
      `· ${g.path}: field "${g.fieldName}" selected ${g.count}× under aliases [${g.aliases.join(', ')}] — each copy costs ~${fmt.format(g.subtreeCostEach)} points`,
    );
  }

  return details;
}

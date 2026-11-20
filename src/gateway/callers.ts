import type { QuotaPlan } from '../cost/decision.js';

export interface Caller {
  apiKey: string;
  name: string;
  tier: 'free' | 'pro' | 'enterprise';
  quota: QuotaPlan;
}

/**
 * Demo caller directory. In production this would be backed by a database or
 * secrets manager; the gateway only needs read access plus the quota plan.
 */
export const CALLERS: Caller[] = [
  {
    apiKey: 'demo-free-001',
    name: 'Sandbox Explorer',
    tier: 'free',
    quota: {
      maxQueryCost: 5_000,
      perMinuteBudget: 20_000,
      perDayBudget: 200_000,
      maxDepth: 8,
    },
  },
  {
    apiKey: 'demo-pro-002',
    name: 'Growth Analytics Co.',
    tier: 'pro',
    quota: {
      maxQueryCost: 50_000,
      perMinuteBudget: 200_000,
      perDayBudget: 2_000_000,
      maxDepth: 12,
    },
  },
  {
    apiKey: 'demo-ent-003',
    name: 'Enterprise Data Platform',
    tier: 'enterprise',
    quota: {
      maxQueryCost: 500_000,
      perMinuteBudget: 2_000_000,
      perDayBudget: 20_000_000,
      maxDepth: 15,
    },
  },
];

export function findCaller(apiKey: string | undefined): Caller | null {
  if (!apiKey) return null;
  return CALLERS.find((c) => c.apiKey === apiKey) ?? null;
}

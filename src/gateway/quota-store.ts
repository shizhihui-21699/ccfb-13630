import type { RemainingQuota } from '../cost/decision.js';
import type { Caller } from './callers.js';

interface WindowCounters {
  minuteKey: string;
  minuteUsed: number;
  minuteRequests: number;
  dayKey: string;
  dayUsed: number;
  dayRequests: number;
  totalUsed: number;
  totalRequests: number;
  totalRejected: number;
}

/** UTC fixed-window counters. Windows roll over lazily on the next touch. */
export class QuotaStore {
  private readonly counters = new Map<string, WindowCounters>();

  private static minuteKey(d: Date): string {
    return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  }

  private static dayKey(d: Date): string {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private touch(caller: Caller, now: Date): WindowCounters {
    let c = this.counters.get(caller.apiKey);
    const minuteKey = QuotaStore.minuteKey(now);
    const dayKey = QuotaStore.dayKey(now);
    if (!c) {
      c = {
        minuteKey,
        minuteUsed: 0,
        minuteRequests: 0,
        dayKey,
        dayUsed: 0,
        dayRequests: 0,
        totalUsed: 0,
        totalRequests: 0,
        totalRejected: 0,
      };
      this.counters.set(caller.apiKey, c);
    }
    if (c.minuteKey !== minuteKey) {
      c.minuteKey = minuteKey;
      c.minuteUsed = 0;
      c.minuteRequests = 0;
    }
    if (c.dayKey !== dayKey) {
      c.dayKey = dayKey;
      c.dayUsed = 0;
      c.dayRequests = 0;
    }
    return c;
  }

  remaining(caller: Caller, now: Date): RemainingQuota {
    const c = this.touch(caller, now);
    return {
      minute: {
        used: c.minuteUsed,
        limit: caller.quota.perMinuteBudget,
        remaining: Math.max(0, caller.quota.perMinuteBudget - c.minuteUsed),
      },
      day: {
        used: c.dayUsed,
        limit: caller.quota.perDayBudget,
        remaining: Math.max(0, caller.quota.perDayBudget - c.dayUsed),
      },
    };
  }

  /** Charge an allowed query against all windows. */
  recordAllowed(caller: Caller, cost: number, now: Date): void {
    const c = this.touch(caller, now);
    c.minuteUsed += cost;
    c.dayUsed += cost;
    c.totalUsed += cost;
    c.minuteRequests += 1;
    c.dayRequests += 1;
    c.totalRequests += 1;
  }

  recordRejected(caller: Caller, now: Date): void {
    const c = this.touch(caller, now);
    c.totalRejected += 1;
  }

  snapshot(): Record<string, WindowCounters> {
    return Object.fromEntries(this.counters.entries());
  }
}

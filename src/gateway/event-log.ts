import { appendFileSync, mkdirSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GatewayEvent {
  timestamp: string;
  callerApiKey: string | null;
  callerName: string;
  tier: string | null;
  decision: 'allowed' | 'rejected';
  rejectionCode?: string;
  reason?: string;
  operationName?: string | null;
  estimatedCost: number;
  estimatedResolutions: number;
  depth: number;
  staticFieldCount: number;
  maxPageSize?: number;
  durationMs: number;
  queryPreview: string;
}

const MAX_EVENTS_IN_FILE = 5_000;

/**
 * Append-only JSONL audit trail. When the file grows past the cap it is rolled
 * to `<file>.1` so the dashboard's tail scan stays bounded while the most
 * recent history is preserved on disk.
 */
export class EventLog {
  private events: GatewayEvent[] = [];

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      try {
        const lines = readFileSync(filePath, 'utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            this.events.push(JSON.parse(line) as GatewayEvent);
          } catch {
            // Ignore a corrupted trailing line rather than lose the whole log.
          }
        }
        if (this.events.length > MAX_EVENTS_IN_FILE) {
          this.events = this.events.slice(-MAX_EVENTS_IN_FILE);
        }
      } catch {
        // Unreadable log: start fresh.
      }
    }
  }

  append(event: GatewayEvent): void {
    this.events.push(event);
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);

    if (this.events.length > MAX_EVENTS_IN_FILE) {
      this.events = this.events.slice(-MAX_EVENTS_IN_FILE);
      try {
        renameSync(this.filePath, `${this.filePath}.1`);
        const rebuilt = this.events.map((e) => `${JSON.stringify(e)}\n`).join('');
        appendFileSync(this.filePath, rebuilt);
      } catch {
        // Rolling is best-effort; never fail a request over log maintenance.
      }
    }
  }

  recent(limit = 100): GatewayEvent[] {
    return this.events.slice(-limit).reverse();
  }

  all(): GatewayEvent[] {
    return [...this.events];
  }
}

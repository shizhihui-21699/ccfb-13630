/**
 * End-to-end demo: replays every legitimate sample and every crafted attack
 * against the running gateway, rotating caller tiers so the dashboard shows a
 * realistic mix of consumption, then deliberately exhausts the free tier's
 * minute budget to demonstrate rate-based (not request-count-based) blocking.
 *
 * Prerequisite: `npm run dev` (upstream + gateway) in another terminal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4000/graphql';

const FREE = 'demo-free-001';
const PRO = 'demo-pro-002';
const ENT = 'demo-ent-003';

interface AttackFile {
  name: string;
  description: string;
  body: Record<string, unknown>;
}

function loadJson<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(root, relative), 'utf8')) as T;
}

async function send(
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
): Promise<{ status: number; cost: number; code?: string; message: string }> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`  ✖ ${label}: gateway unreachable (${err instanceof Error ? err.message : err})`);
    console.error('    start the services first: npm run dev');
    process.exitCode = 1;
    return { status: 0, cost: 0, message: 'unreachable' };
  }
  const json = (await res.json()) as {
    errors?: Array<{ message: string; extensions?: { code?: string; cost?: number } }>;
    extensions?: { gateway?: { estimatedCost?: number } };
  };
  const cost =
    json.extensions?.gateway?.estimatedCost ??
    json.errors?.[0]?.extensions?.cost ??
    0;
  const code = json.errors?.[0]?.extensions?.code;
  const message = json.errors?.[0]?.message ?? 'ok';
  const ms = Date.now() - started;
  const mark = res.ok ? '✔ allowed ' : '✖ blocked ';
  console.log(
    `  ${mark} ${label.padEnd(34)} ${String(res.status).padStart(3)}  ${String(cost).padStart(12)} pts  ${ms}ms${code ? `  [${code}]` : ''}`,
  );
  if (!res.ok) console.log(`      → ${message}`);
  return { status: res.status, cost, code, message };
}

async function waitForGateway(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://localhost:4000/health');
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('Gateway did not become ready on :4000 — run `npm run dev` first.');
  process.exit(1);
}

async function main(): Promise<void> {
  await waitForGateway();

  console.log('\n=== 1. Legitimate sample queries (heavy tiers get the heavy samples) ===');
  const sampleFiles = readdirSync(resolve(root, 'samples'))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const tiers = [FREE, PRO, ENT];
  for (const [i, file] of sampleFiles.entries()) {
    const body = loadJson<Record<string, unknown>>(`samples/${file}`);
    // Heavy-field samples need a paid tier; the rest rotate freely.
    const key = file.startsWith('07-') ? ENT : tiers[i % tiers.length]!;
    await send(key, body, file.replace('.json', ''));
  }

  console.log('\n=== 2. Crafted attack queries (all sent as the free tier) ===');
  const attackFiles = readdirSync(resolve(root, 'samples/attacks'))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const attacks = attackFiles.map((f) =>
    loadJson<AttackFile>(`samples/attacks/${f}`),
  );
  for (const attack of attacks) {
    console.log(`\n  · ${attack.description}`);
    await send(FREE, attack.body, attack.name);
  }

  console.log('\n=== 3. Same deep-nesting attack, but an enterprise caller tries it ===');
  const deep = attacks.find((a) => a.name === 'nested-fanout-12-levels')!;
  await send(ENT, deep.body, 'nested-fanout (enterprise)');

  console.log('\n=== 4. Quota exhaustion: burn the free-tier minute window ===');
  // Each burst fits the per-query cap (~4.4k < 5k) so requests are admitted
  // and actually charge the minute budget — until the window runs dry and the
  // gateway starts answering QUOTA_EXCEEDED instead of COST_LIMIT_EXCEEDED.
  const burner = {
    query: '{ users(first: 10) { id displayName posts(first: 10) { id title } } }',
  };
  let exhausted = false;
  for (let i = 1; i <= 12; i++) {
    const r = await send(FREE, burner, `burner burst #${i}`);
    if (r.code === 'QUOTA_EXCEEDED') {
      console.log('      (minute budget exhausted — subsequent requests in this window fail)');
      exhausted = true;
      break;
    }
  }
  if (!exhausted) {
    console.log('      (minute window survived the burst — rerun the demo to pile on more)');
  }

  console.log('\n=== 5. Unauthenticated and malformed requests ===');
  await send('not-a-real-key', { query: '{ me { id } }' }, 'invalid api key');
  await send(FREE, { query: '{ me { ' }, 'parse error query');

  console.log('\nDone. Open the dashboard:  http://localhost:4000/dashboard\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

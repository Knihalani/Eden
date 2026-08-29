/**
 * Wave 4.3 — steering decision forensics.
 *
 * Times the wrap execute path for a non-matching call (ping) with W live
 * armings, session-partitioned vs one-bucket. p50 W=100 vs W=10 must stay
 * flat. p99 of the decision must be <1 ms.
 *
 *   bun packages/wrap/src/steer-profile.ts
 */
import { withVersion, type StretchProgram } from "@eden/ir";
import { createArmingStore, createState, wrapTools, type ToolDef } from "./index";

const WARM = 2_000;
const N = 12_000;
const P99_BUDGET_MS = 1;

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

function prog(): StretchProgram {
  const sequence = ["lookup", "fetch", "write", "audit"];
  return withVersion({
    id: "p_steer",
    name: "p_steer",
    description: "d",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
    sequence,
    steps: sequence.map((tool, i) => ({
      id: tool,
      kind: "tool" as const,
      tool,
      args: { id: { kind: "input" as const, path: "id" }, ...(i === 0 ? { text: { kind: "input" as const, path: "text" } } : {}) },
    })),
    returns: { kind: "from", step: "audit", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
    manifest: { llmReduction: 5, latencyReduction: 2, costReduction: 5, skipRateBefore: 0, skipRateAfter: 0, nShadow: 3 },
  }) as StretchProgram;
}

function tools(): Record<string, ToolDef> {
  const mk = (name: string): ToolDef => ({ description: name, execute: async (a) => ({ name, id: a.id }) });
  return { ping: { description: "ping", execute: async () => ({ pong: true }) }, lookup: mk("lookup"), fetch: mk("fetch"), write: mk("write"), audit: mk("audit") };
}

async function armHosted(w: number) {
  const p = prog();
  const t = tools();
  const store = createArmingStore();
  const wraps: Array<ReturnType<typeof wrapTools>> = [];
  await Promise.all(
    Array.from({ length: w }, async (_, i) => {
      const state = createState({ programs: [p], arming: store, sessionId: `s${i}` });
      const wrapped = wrapTools(t, state);
      wraps.push(wrapped);
      await wrapped.lookup.execute({ id: `E-${i}`, text: "t" });
    }),
  );
  return { store, ping: wraps[0]! };
}

async function sample(fn: () => Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < WARM; i++) await fn();
  const xs: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await fn();
    xs.push(performance.now() - t0);
  }
  return xs;
}

const w10 = await armHosted(10);
const s10 = await sample(() => w10.ping.ping.execute({}));
const w100 = await armHosted(100);
const s100 = await sample(() => w100.ping.ping.execute({}));

const p50_10 = pct(s10, 50);
const p50_100 = pct(s100, 50);
const p99_100 = pct(s100, 99);
const ratio = p50_100 / Math.max(p50_10, 1e-9);

process.stdout.write(
  JSON.stringify(
    {
      n: N,
      w10: { p50_ms: +p50_10.toFixed(4), p99_ms: +pct(s10, 99).toFixed(4) },
      w100: { p50_ms: +p50_100.toFixed(4), p99_ms: +p99_100.toFixed(4) },
      p50_ratio: +ratio.toFixed(3),
      p99_budget_ms: P99_BUDGET_MS,
      flat: ratio < 1.5,
      p99_ok: p99_100 < P99_BUDGET_MS,
      admits_100: w100.store.stats().admits,
      rejects_100: w100.store.stats().rejects,
    },
    null,
    2,
  ) + "\n",
);

if (ratio >= 1.5) {
  process.stdout.write(`STEER P50 NOT FLAT: W=100/W=10 = ${ratio.toFixed(2)}\n`);
  process.exitCode = 1;
}
if (p99_100 >= P99_BUDGET_MS) {
  process.stdout.write(`STEER P99 OVER BUDGET: ${p99_100.toFixed(3)}ms\n`);
  process.exitCode = 1;
}
if (!process.exitCode) process.stdout.write("STEER PROFILE WIN\n");

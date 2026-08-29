/**
 * Idle-path micro-bench: wrap overhead with no live programs vs raw execute,
 * and with 64 live armings on a non-matching tool (Wave 4.3).
 * Prints µs/call. Not a correctness test.
 *
 *   bun packages/wrap/src/idle.bench.ts
 */
import { withVersion, type StretchProgram } from "@eden/ir";
import { createState, wrapTools } from "./index";

const N = 80_000;
const WARM = 4_000;
const BUDGET = 12;

async function rawPing(): Promise<{ pong: true }> {
  return { pong: true };
}

async function bench(label: string, fn: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < WARM; i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await fn();
  const us = ((performance.now() - t0) * 1000) / N;
  process.stdout.write(`${label}: ${us.toFixed(2)} µs/call (n=${N})\n`);
  return us;
}

function armingProgram(): StretchProgram {
  const sequence = ["lookup", "fetch", "write", "audit"];
  return withVersion({
    id: "p_idle64",
    name: "p_idle64",
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

const raw = await bench("raw", rawPing);

{
  const state = createState({ programs: [] });
  const wrapped = wrapTools({ ping: rawPing }, state);
  const wrap = await bench("wrap idle (0 armings)", () => wrapped.ping.execute({}));
  const overhead = wrap - raw;
  process.stdout.write(`overhead 0-arm: ${overhead.toFixed(2)} µs/call  (budget ≤${BUDGET})\n`);
  process.stdout.write(overhead <= BUDGET ? "IDLE WIN\n" : "IDLE OVER BUDGET\n");
  if (overhead > BUDGET) process.exitCode = 1;
}

{
  const prog = armingProgram();
  const tools = {
    ping: rawPing,
    lookup: async (a: Record<string, unknown>) => ({ id: a.id }),
    fetch: async (a: Record<string, unknown>) => ({ id: a.id }),
    write: async (a: Record<string, unknown>) => ({ id: a.id }),
    audit: async (a: Record<string, unknown>) => ({ id: a.id }),
  };
  const state = createState({ programs: [prog] });
  const wrapped = wrapTools(tools, state);
  await Promise.all(
    Array.from({ length: 64 }, (_, i) => wrapped.lookup.execute({ id: `E-${i}`, text: `t${i}` })),
  );
  if (state.arming.sessionSize(state.sessionId) < 1) {
    process.stdout.write("WARN: expected live armings after 64 heads\n");
  }
  const wrap = await bench("wrap idle (64 live armings)", () => wrapped.ping.execute({}));
  const overhead = wrap - raw;
  process.stdout.write(`overhead 64-arm: ${overhead.toFixed(2)} µs/call  (budget ≤${BUDGET})\n`);
  process.stdout.write(`armings still live: ${state.arming.sessionSize(state.sessionId)}\n`);
  process.stdout.write(overhead <= BUDGET ? "IDLE-64 WIN\n" : "IDLE-64 OVER BUDGET\n");
  if (overhead > BUDGET) process.exitCode = 1;
}

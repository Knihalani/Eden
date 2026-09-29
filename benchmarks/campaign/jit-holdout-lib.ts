/**
 * Shared runner for Wave 22.2 JIT hold-out soaks. Each soak file supplies a
 * different world set so the scorer cannot overfit github/kubectl/desk.
 */
import type { StretchProgram } from "@eden/ir";
import { rankPrograms, selectSurfacePrograms, steerToolCalls, type OpenAiToolCall } from "@eden/wrap";

export const PRECISION_BAR = 0.95;

export function soakProg(opts: {
  name: string;
  seq: string[];
  url?: string;
  cmd?: string;
  envelope?: Record<string, unknown[]>;
}): StretchProgram {
  const first = opts.seq[0] ?? opts.name;
  const args: Record<string, unknown> = {};
  if (opts.url) args.u = { kind: "literal", value: opts.url };
  if (opts.cmd) args.command = { kind: "transform", fn: "template", expr: opts.cmd };
  return {
    id: `p_${opts.name}`,
    version: "v1",
    name: opts.name,
    description: "",
    inputSchema: { type: "object", properties: {} },
    steps: [{ id: "s0", kind: "tool", tool: first, args }] as never,
    returns: { kind: "input", path: "" },
    contract: {
      envelope: { inputs: opts.envelope ?? {} },
      allowExact: true,
      witnesses: 3,
      minLlmReduction: 1,
    } as never,
    manifest: {
      llmReduction: 2,
      latencyReduction: 1,
      costReduction: 1,
      skipRateBefore: 0,
      skipRateAfter: 0,
      nShadow: 3,
    } as never,
    sequence: opts.seq,
  };
}

export function call(name: string, args: Record<string, unknown>): OpenAiToolCall {
  return { type: "function", function: { name, arguments: JSON.stringify(args) } };
}

export function steeringPick(c: OpenAiToolCall, live: StretchProgram[]): string | null {
  const out = steerToolCalls([c], live);
  const steered = out[0];
  if (!steered) return null;
  const n = steered.function?.name || "";
  if (steered.matched_by && live.some((p) => p.name === n)) return n;
  if (live.some((p) => p.name === n)) return n;
  return null;
}

export type HoldoutTurn = {
  label: string;
  expect: string;
  messages: unknown[];
  call: OpenAiToolCall;
};

export const UNIQUE_WORK_MESSAGES: unknown[][] = [
  [{ role: "user", content: "alpha then bravo then charlie for N-0 — never seen this sequence" }],
  [{ role: "user", content: "delta echo foxtrot hotel india for N-1 unique work" }],
  [{ role: "user", content: "write a one-off script that will not repeat" }],
  [{ role: "user", content: "what's crashing in staging" }],
];

export const VAGUE_MESSAGES: unknown[][] = [
  [{ role: "user", content: "please handle ticket 123" }],
  [{ role: "user", content: "write a sonnet about the sea" }],
  [{ role: "user", content: "what should I do next" }],
  [{ role: "user", content: "thanks" }],
];

export type HoldoutResult = {
  precision: number;
  n: number;
  hits: number;
  misses: number;
  uniqueWorkSchemas: number;
  vagueSchemas: number;
  pass: boolean;
  by: Record<string, { n: number; hits: number }>;
  crossHits: number;
  lines: string[];
};

export function runHoldoutSoak(opts: {
  programs: StretchProgram[];
  turns: HoldoutTurn[];
  uniqueWork?: unknown[][];
  vague?: unknown[][];
}): HoldoutResult {
  const live = opts.programs;
  const uniqueWork = opts.uniqueWork ?? UNIQUE_WORK_MESSAGES;
  const vague = opts.vague ?? VAGUE_MESSAGES;
  let hits = 0;
  let misses = 0;
  let n = 0;
  let crossHits = 0;
  const by: Record<string, { n: number; hits: number }> = {};
  for (const t of opts.turns) {
    const steered = steeringPick(t.call, live);
    if (!steered) continue;
    n++;
    const bucket = (by[t.label] ??= { n: 0, hits: 0 });
    bucket.n++;
    const ranked = rankPrograms(t.messages, live);
    const top = ranked[0]?.program.name ?? null;
    if (top === steered && steered === t.expect) {
      hits++;
      bucket.hits++;
    } else misses++;
    if (top && top !== t.expect) crossHits++;
  }

  const surfaceCount = (messages: unknown[]) =>
    selectSurfacePrograms({ mode: "jit", live, messages }).surface.length;
  let uniqueWorkSchemas = 0;
  for (const messages of uniqueWork) uniqueWorkSchemas += surfaceCount(messages);
  let vagueSchemas = 0;
  for (const messages of vague) vagueSchemas += surfaceCount(messages);

  const precision = n ? hits / n : 0;
  const pass =
    precision >= PRECISION_BAR && n > 0 && uniqueWorkSchemas === 0 && vagueSchemas === 0 && crossHits === 0;
  const byLine = Object.entries(by)
    .map(([k, v]) => `${k}:${v.hits}/${v.n}`)
    .join(" ");
  const lines = [
    `precision=${precision.toFixed(3)} n=${n} hits=${hits} misses=${misses}`,
    `by=${byLine}`,
    `unique_work_schemas=${uniqueWorkSchemas}`,
    `vague_schemas=${vagueSchemas}`,
    `cross_hits=${crossHits}`,
    `verdict=${pass ? "PASS" : "FAIL"}`,
  ];
  return { precision, n, hits, misses, uniqueWorkSchemas, vagueSchemas, pass, by, crossHits, lines };
}

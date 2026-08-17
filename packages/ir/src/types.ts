export const IR_VERSION = 1;
export const DEFAULT_MIN_LLM_REDUCTION = 2;

export const BINDING_KINDS = ["literal", "input", "from", "transform"] as const;
export const STEP_KINDS = ["tool", "island", "loop", "assert"] as const;
export const TRANSFORM_FNS = ["identity", "jsonpath", "template"] as const;
export const ASSERT_ON_FAIL = ["deopt", "error"] as const;

export type BindingKind = (typeof BINDING_KINDS)[number];
export type StepKind = (typeof STEP_KINDS)[number];
export type TransformFn = (typeof TRANSFORM_FNS)[number];
export type AssertOnFail = (typeof ASSERT_ON_FAIL)[number];

export type Binding =
  | { kind: "literal"; value: unknown }
  | { kind: "input"; path: string }
  | { kind: "from"; step: string; path: string }
  | { kind: "transform"; fn: TransformFn; expr: string; of: Binding };

/** The `from` variant, for producers that can only ever reference a prior step. */
export type FromBinding = Extract<Binding, { kind: "from" }>;

export type ToolStep = {
  id: string;
  kind: "tool";
  tool: string;
  args: Record<string, Binding>;
  /**
   * Asserts this call has no side effects, so the runtime may repeat it out of
   * order inside a parallel loop. Only ever set from something that knows —
   * a registry capability, or an MCP `readOnlyHint` — never inferred from a
   * name at this level. Absent means "unknown", which is treated as unsafe.
   */
  readOnly?: boolean;
};

export type IslandStep = {
  id: string;
  kind: "island";
  input: Binding;
  system: string;
  outputSchema: object;
};

export type LoopStep = {
  id: string;
  kind: "loop";
  over: Binding;
  item: string;
  body: string[];
  /**
   * Set false to force sequential iteration even when the body looks read-only
   * — for a paginated API that must be walked in order, say. Leaving it unset
   * lets the runtime decide, and it only parallelises a body it can prove safe.
   */
  parallel?: boolean;
};

export type AssertStep = {
  id: string;
  kind: "assert";
  expr: string;
  onFail: AssertOnFail;
};

export type Step = ToolStep | IslandStep | LoopStep | AssertStep;

export function minLlmReductionOf(n?: number | null): number {
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : DEFAULT_MIN_LLM_REDUCTION;
}

export type Contract = {
  witnesses: number;
  minLlmReduction: number;
  allowExact: boolean;
  envelope?: { inputs: Record<string, unknown[]> };
};

export type Manifest = {
  llmReduction: number;
  latencyReduction: number;
  costReduction: number;
  skipRateBefore: number;
  skipRateAfter: number;
  nShadow: number;
};

export type StretchProgram = {
  id: string;
  version: string;
  name: string;
  description: string;
  inputSchema: object;
  steps: Step[];
  returns: Binding;
  contract: Contract;
  manifest: Manifest | null;
  /** Original tool-name sequence, used to steer the agent into this program. */
  sequence?: string[];
};

export type TraceEvent = {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  ok: boolean;
  duration_ms?: number;
  skipped?: boolean;
};

export type StretchTrace = {
  id: string;
  events: TraceEvent[];
  input?: Record<string, unknown>;
  output?: unknown;
  llmCalls: number;
  duration_ms: number;
  cost_cents: number;
  skipped?: string[];
  complete?: boolean;
};

export type Refusal = {
  sequence: string[];
  reason: string;
  slot?: string;
};

export type IslandCaller = (args: {
  system: string;
  input: unknown;
  outputSchema: object;
  signal?: AbortSignal;
}) => Promise<unknown>;

export type ToolRunCtx = { signal?: AbortSignal };

export type ToolExecute = (args: Record<string, unknown>, ctx?: ToolRunCtx) => Promise<unknown> | unknown;

export type ToolRegistry = {
  execute: (name: string, args: Record<string, unknown>, ctx?: ToolRunCtx) => Promise<unknown>;
  has?: (name: string) => boolean;
};

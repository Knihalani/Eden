export const IR_VERSION = 1;
export const DEFAULT_MIN_LLM_REDUCTION = 2;

export const BINDING_KINDS = ["literal", "input", "from", "transform"] as const;
export const STEP_KINDS = ["tool", "island", "loop", "assert", "branch"] as const;
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

/**
 * A witnessed conditional (G2).
 *
 * `expr` is an assert-style expression evaluated against the prior step's
 * result (plus input and step results); truthy runs the `then` arm, falsy the
 * `else` arm. Arm ids reference flat steps elsewhere in `program.steps` —
 * the same shape loops use for bodies.
 *
 * Admission discipline lives in the compiler, not here: every arm must be
 * covered by successful taped executions (one witness per arm plus the
 * negative witness that forced the split), or the program is refused before
 * it ever reaches this representation. The runtime trusts the shape and
 * executes deterministically.
 */
export type BranchStep = {
  id: string;
  kind: "branch";
  expr: string;
  then: string[];
  else?: string[];
};

export type AssertStep = {
  id: string;
  kind: "assert";
  expr: string;
  onFail: AssertOnFail;
};

export type Step = ToolStep | IslandStep | LoopStep | AssertStep | BranchStep;

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
  /** Reported only. Not a ship gate (20b). */
  llmReduction: number;
  /** Null when the clocks cannot be compared honestly (synthetic fixture, missing durations). */
  latencyReduction: number | null;
  costReduction: number;
  skipRateBefore: number;
  skipRateAfter: number;
  nShadow: number;
  /** Mean naive − compiled tokens when wrap scraped usage. */
  tokensSaved?: number | null;
  /** Mean naive − compiled ms from event `duration_ms` (+ island wall if it ran). */
  timeSavedMs?: number | null;
  tokensMeasured?: boolean;
  timeMeasured?: boolean;
};

export type ProgramBudget = {
  llmCalls: number;
  ms: number;
  cents: number;
};

export type ProgramOrigin = {
  mode: "happy" | "loop" | "fail_streak" | "low_gain" | "evidence";
  firstWarningAt?: number;
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
  /** Mean witness llm/ms/cents. Halt compares predicted vs actual (47). */
  budget?: ProgramBudget;
  /** Set when this program was mined from a warned/failing cluster (45, 50). */
  origin?: ProgramOrigin;
};

export type TraceEvent = {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  ok: boolean;
  duration_ms?: number;
  skipped?: boolean;
};

export const SIGNAL_KINDS = ["repeat_ngram", "fail_streak", "budget", "low_gain", "evidence_gap", "repeat_visits"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Wall / LLM snapshot. Token fields are omitted until wrap scraped `usage`. */
export type SignalBudget = {
  duration_ms: number;
  llmCalls: number;
  prompt_tokens?: number;
  completion_tokens?: number;
};

export type OnlineWarning = SignalBudget & {
  kind: SignalKind;
  /** Event index the warning fired at (the run is still in progress). */
  at: number;
  detail: string;
  n?: number;
  ngram?: string[];
  gain?: number;
};

export type EvidenceLedger = {
  required: string[];
  present: string[];
  absent: string[];
  failed: string[];
};

export type StretchTrace = {
  id: string;
  events: TraceEvent[];
  input?: Record<string, unknown>;
  output?: unknown;
  llmCalls: number;
  /** Present only when the wrap scraped provider `usage`. Absent = not measured. */
  prompt_tokens?: number;
  completion_tokens?: number;
  duration_ms: number;
  cost_cents: number;
  skipped?: string[];
  complete?: boolean;
  /** Cheap online warnings. Absent until the wrap bus has something to say. */
  warnings?: OnlineWarning[];
  /** First deopt / skip / ok:false / bus warning. Cost after this is post-warning spend. */
  firstWarningAt?: number;
  postWarning?: SignalBudget;
  evidence?: EvidenceLedger;
  /** Complete trace + grounded, non-empty result. Empty-but-ok is not success. */
  usable?: boolean;
  grounded?: boolean | "unknown";
  /**
   * True when llmCalls/duration_ms/cost_cents were reconstructed from event
   * counts (trace imports) rather than measured. Gates may treat such numbers
   * as directional only; the honest-savings ledger never reads them anyway.
   */
  metrics_estimated?: true;
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

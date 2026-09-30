import type { TokenClass, TokenClasses } from "./tokens";

export const IR_VERSION = 1;
export const DEFAULT_MIN_LLM_REDUCTION = 2;

export const BINDING_KINDS = ["literal", "input", "from", "transform"] as const;
export const STEP_KINDS = ["tool", "island", "loop", "assert", "branch"] as const;
export const TRANSFORM_FNS = [
  "identity",
  "jsonpath",
  "template",
  "slice",
  "except",
  "flatten",
  "filter",
  "lookup",
  "chunk",
  "zip",
  "group",
  "unique",
  "sort",
  "reduce",
  "add",
] as const;
export const ASSERT_ON_FAIL = ["deopt", "error"] as const;

export type BindingKind = (typeof BINDING_KINDS)[number];
export type StepKind = (typeof STEP_KINDS)[number];
export type TransformFn = (typeof TRANSFORM_FNS)[number];
export type AssertOnFail = (typeof ASSERT_ON_FAIL)[number];

export type Binding =
  | { kind: "literal"; value: unknown }
  | { kind: "input"; path: string }
  | {
      kind: "from";
      step: string;
      path: string;
      /**
       * Seed when `step` has not run yet (cursor page 0, optional prior).
       * Once `step` is in scope, `or` is ignored — null nextCursor is a real value.
       */
      or?: Binding;
    }
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
  /**
   * Graduation pin (Wave 10). Memo hits only; a miss deopts. Never a silent
   * swap — Approve sets this. Absent/false means the island may still call a model.
   */
  pinned?: boolean;
  /**
   * Wave 11. One-liner for SKILL.md / drain. Absent or blank → callers fall
   * back to the program description. Never invent copy at drain time.
   */
  when_to_use?: string;
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
  /**
   * Poll-until: repeat the body until this assert-style expression is truthy
   * on the last body result. Not a foreach — same args, changing ready flag.
   * Absent means ordinary iteration over `over`.
   */
  until?: string;
  /** Witnessed max poll iterations. Runtime deopts if `until` is still false. */
  maxIters?: number;
};

/**
 * A witnessed conditional (G2).
 *
 * `expr` is an assert-style expression evaluated against the prior step's
 * result (plus input and step results). Truthy runs the `then` arm. If that
 * misses, `cases` are tried in order — first matching `expr` wins — then
 * `else`. Binary programs use `expr`/`then`/`else` with `cases` absent.
 * n-way: first arm is `expr`/`then`; remaining non-else arms are `cases`;
 * the final arm is `else`.
 *
 * Arm ids reference flat steps elsewhere in `program.steps` — the same shape
 * loops use for bodies. Nested `branch` ids in `else` (old else-of-else
 * programs) stay valid; the runtime executes that inner step as the arm.
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
  /** Remaining non-else arms. Absent on binary programs. First matching expr wins, then else. */
  cases?: Array<{ expr: string; steps: string[] }>;
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
  /**
   * Soft-match tier (Wave 10). Same keys and types, novel value. Serves only
   * when true AND the session is canary or the tool is live-promoted.
   * Default (absent/false) stays envelope-strict.
   */
  softMatch?: boolean;
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
  /** True when compiled tokens were scaled, not scraped. Ship gate treats as absent. */
  tokensEstimated?: boolean;
  /**
   * True when savings rest on provider-scraped usage (or measured time).
   * False/absent + tokensEstimated → show UNCERTIFIED, never quote the number.
   */
  certified?: boolean;
};

export type ProgramBudget = {
  llmCalls: number;
  ms: number;
  cents: number;
};

export type ProgramOrigin = {
  mode: "happy" | "loop" | "fail_streak" | "low_gain" | "evidence" | "handoff" | "compose";
  firstWarningAt?: number;
};

export type StretchProgram = {
  id: string;
  version: string;
  name: string;
  description: string;
  /**
   * Wave 11. Island-written one-liner for manifests. Absent → `whenToUseOf`
   * walks island steps, then `description`.
   */
  when_to_use?: string;
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
  /**
   * Child program ids when this is a composed agent→agent handoff (Wave 7.3).
   * Absent on linear/fork programs. Approve still required — this is identity,
   * not a live gate.
   */
  composedOf?: string[];
  /**
   * Serving stamp from the live tool (Wave 10). Not part of program identity.
   * `canary` = 10% of sessions; absent/`live` = 100%. Already-shipped tools
   * without this field stay live.
   */
  rollout?: "canary" | "live";
  /**
   * Provider prompt+completion on the mined cluster. Waiting PASS candidates
   * carry this so Needs attention can rank uncompiled frequent patterns by
   * waste, not recency. 0 when unmeasured — never estimated.
   */
  wastedTokens?: number;
};

export type TraceEvent = {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  ok: boolean;
  duration_ms?: number;
  skipped?: boolean;
  /** How this event's provider tokens were earned. Absent = unattributed. */
  tokenClass?: TokenClass;
  /** Agent that issued this event. Absent = single-agent wrap. */
  agentId?: string;
  /**
   * How many agents in the fleet claimed this fetch (Wave 7.1). Omitted at 1.
   * Never set on mutating events.
   */
  sharedAcross?: number;
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
  required: readonly string[];
  present: readonly string[];
  absent: readonly string[];
  failed: readonly string[];
};

export type StretchTrace = {
  id: string;
  events: TraceEvent[];
  /** Agent that produced this stretch. Absent = single-agent wrap. */
  agentId?: string;
  /** Parent run id when this stretch is a child of an orchestrator. */
  parentRunId?: string;
  /** Orchestrator span id this stretch must match on fixtures (Wave 7.1). */
  spanId?: string;
  /** `invoke_workflow` (parent) or `invoke_agent` (child). Stamped when spanId is set. */
  spanName?: string;
  /** Shared fleet key for read-only cross-agent claims. Not a tenancy boundary. */
  fleetId?: string;
  /** Deployment region label. Isolation stays workspace-keyed. */
  region?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  llmCalls: number;
  /** Present only when the wrap scraped provider `usage`. Absent = not measured. */
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Provider cache-read tokens. Separate line — never blended into DC%. */
  cached_tokens?: number;
  /** Provider cache-write tokens. 0 is measured. */
  cache_write_tokens?: number;
  /** Hit-% denominator stamped at parse time. */
  cache_input_tokens?: number;
  /** Per-run class ledger. Sum of five classes must equal prompt+completion when measured. */
  tokenClasses?: TokenClasses;
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

export type RefusalCode =
  | "unbound_foreach"
  | "read_set_mismatch"
  | "underdetermined_write"
  | "underdetermined_command"
  | "empty_output"
  | "too_short"
  | "no_envelope"
  | "invalid_program"
  | "unbound_branch"
  | "max_programs";

export type Refusal = {
  sequence: string[];
  reason: string;
  slot?: string;
  /** Named class for the novelty feed and canvas. Additive; older rows omit it. */
  code?: RefusalCode;
  /** Near-miss: length of the array a prior read returned. */
  readSet?: number;
  /** Near-miss: how many times the repeating tool actually ran. */
  repeats?: number;
  /** What to change. Canvas and Home show this; `reason` stays the pin string. */
  hint?: string;
  /**
   * Provider prompt+completion summed over the refused cluster.
   * 0 when unmeasured — never estimated from llmCalls or duration.
   */
  wastedTokens?: number;
};

export type IslandCaller = (args: {
  system: string;
  input: unknown;
  outputSchema: object;
  signal?: AbortSignal;
  /**
   * Graduation pin (Wave 10). Lookup-only: a memo hit serves, a miss deopts.
   * Absent/false means the island may still call a model.
   */
  pinned?: boolean;
  /**
   * Wave 14. True when this miss can wait for sibling islands in the same
   * program wave (batch transport). Absent/false → the agent is blocked on
   * this call and it stays on the sync path.
   */
  wait?: boolean;
}) => Promise<unknown>;

export type ToolRunCtx = { signal?: AbortSignal };

export type ToolExecute = (args: Record<string, unknown>, ctx?: ToolRunCtx) => Promise<unknown> | unknown;

/** PTC guidance, not a security wall. Direct + code-execution callers. */
export const PTC_CALLERS = ["direct", "code_execution_20260120"] as const;

export type ToolRegistry = {
  execute: (name: string, args: Record<string, unknown>, ctx?: ToolRunCtx) => Promise<unknown>;
  has?: (name: string) => boolean;
  /**
   * Hosts with code execution may call these tools from a PTC script.
   * Guidance only — not a hard block (Anthropic's own contract).
   */
  allowed_callers?: string[];
};

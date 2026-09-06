import type { EvidenceLedger, IslandCaller, OnlineWarning, SignalBudget, StretchProgram, StretchTrace, TokenClass, TokenClasses, TraceEvent } from "@eden/ir";
import type { ArmingStore } from "./arming";

export type Receipt = {
  toolId: string;
  version: string;
  ms: number;
  llmCalls: number;
  cents: number;
  ok: boolean;
  early?: boolean;
  deoptReason?: string;
  stepsRun?: number;
  skipped?: string[];
  outcome?: "ok" | "deopt" | "failed" | "skipped" | "degraded";
  reason?: string;
  tokens?: number;
  tokensSaved?: number | null;
  timeSavedMs?: number | null;
  fingerprint?: string;
  tokenClass?: TokenClass;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_input_tokens?: number;
  tokenClasses?: TokenClasses;
  certified?: boolean;
  agentId?: string;
  parentRunId?: string;
  fleetId?: string;
  region?: string;
  /**
   * Agents that shared this serving (Wave 7.1). Omitted at 1.
   * Product copy: `shared across ${sharedAcross} agents`.
   */
  sharedAcross?: number;
};

export type ToolDef = {
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

export type ToolsIn = Record<string, ToolDef | ((args: Record<string, unknown>) => Promise<unknown> | unknown)>;

export type EdenOpts = {
  apiKey?: string;
  baseUrl?: string;
  programs?: StretchProgram[];
  island?: IslandCaller;
  failOpen?: boolean;
  llmCents?: number;
  fetch?: typeof fetch;
  onTrace?: (t: StretchTrace) => void;
  onWarning?: (w: OnlineWarning) => void;
  onReceipt?: (r: Receipt) => void;
  shadow?: boolean;
  timeoutMs?: number;
  /**
   * Hosted-dispatch session key. Armings are partitioned by this id so two
   * agents on one process cannot claim each other's tails. Default: `EDEN_SESSION`
   * or the single-tenant bucket.
   */
  sessionId?: string;
  arming?: ArmingStore;
  armMax?: number;
  armGlobal?: number;
  /**
   * Fleet key for read-only cross-agent claims (Wave 7.1). Distinct sessions
   * in the same fleet may claim each other's *read-only* fetches. Mutating
   * tails stay session-scoped. Default: `EDEN_FLEET` or empty (no sharing).
   */
  fleetId?: string;
  agentId?: string;
  parentRunId?: string;
  spanId?: string;
  region?: string;
  killAfterWarning?: boolean;
  /**
   * Opt-in hard enforcement. Default (false) is strict fail-safe: Eden never
   * refuses, blocks, or halts a call — guards record warnings and steer where
   * safe, but the agent's own call always goes through. Setting this lets
   * guards halt loops, cap spend, and refuse unverifiable writes.
   */
  enforce?: boolean;
};

export type RunRecorder = {
  events: TraceEvent[];
  llmCalls: number;
  t0: number;
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  measured: boolean;
  cached_tokens: number;
  /** Provider cache-write tokens. Separate line; 0 is measured. */
  cache_write_tokens: number;
  /** Hit-% denominator stamped from the usage object (not inferred later). */
  cache_input_tokens: number;
  /** Island scrape accumulated from compiled runs this window. */
  island_prompt_tokens: number;
  island_completion_tokens: number;
  island_cached_tokens: number;
  island_cache_write_tokens: number;
  island_cache_input_tokens: number;
  island_memoized: boolean;
  island_measured: boolean;
  output?: unknown;
  warnings: OnlineWarning[];
  seenSignals: Set<string>;
  firstWarningAt?: number;
  warnBudget?: SignalBudget;
  evidence?: EvidenceLedger;
  tripped?: boolean;
  /** Executed (non-skipped) raw calls this run. Unconditional ceiling input. */
  rawExecuted: number;
};

export function emptyRun(): RunRecorder {
  return {
    events: [],
    llmCalls: 0,
    t0: performance.now(),
    cost: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    measured: false,
    cached_tokens: 0,
    cache_write_tokens: 0,
    cache_input_tokens: 0,
    island_prompt_tokens: 0,
    island_completion_tokens: 0,
    island_cached_tokens: 0,
    island_cache_write_tokens: 0,
    island_cache_input_tokens: 0,
    island_memoized: false,
    island_measured: false,
    warnings: [],
    seenSignals: new Set(),
    /** Executed (non-skipped) raw calls this run. Unconditional ceiling input. */
    rawExecuted: 0,
  };
}

export function asToolDef(name: string, def: ToolsIn[string]): ToolDef {
  if (typeof def === "function") return { description: name, execute: def };
  return def;
}

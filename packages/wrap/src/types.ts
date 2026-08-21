import type { EvidenceLedger, IslandCaller, OnlineWarning, SignalBudget, StretchProgram, StretchTrace, TraceEvent } from "@eden/ir";

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
  tokens?: number;
  tokensSaved?: number | null;
  timeSavedMs?: number | null;
  fingerprint?: string;
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
  /** Operator override (43): after the first warning, further LLM/tool spend is refused. */
  killAfterWarning?: boolean;
};

export type RunRecorder = {
  events: TraceEvent[];
  llmCalls: number;
  t0: number;
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  measured: boolean;
  output?: unknown;
  warnings: OnlineWarning[];
  seenSignals: Set<string>;
  firstWarningAt?: number;
  warnBudget?: SignalBudget;
  evidence?: EvidenceLedger;
  tripped?: boolean;
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
    warnings: [],
    seenSignals: new Set(),
  };
}

export function asToolDef(name: string, def: ToolsIn[string]): ToolDef {
  if (typeof def === "function") return { description: name, execute: def };
  return def;
}

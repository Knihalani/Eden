import type { TypedPrRow } from "./plan";

export type StepKind = "cloud_http" | "cloud_oauth" | "runner";

export type ToolEvent = {
  event_id: string;
  seq: number;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  ok: boolean;
  duration_ms?: number;
  command?: string;
};

export type IslandStep = {
  name: string;
  cli_family?: string;
  arg_keys: string[];
  constants: Record<string, string>;
  param_keys: string[];
  kind: StepKind;
  commute: boolean;
  rewrite_host?: string;
  source_url?: string;
  /**
   * Raw command for shell-derived steps. Kept so cutIslands can run
   * variation-driven slot abstraction across an island's peers (see
   * abstractShellGroup) — a single command cannot know which of its words
   * are data, but its siblings voting on the same positions can.
   */
  command?: string;
};

export type CompiledStep = {
  id: string;
  kind: StepKind;
  name: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  command?: string;
  bind?: Record<string, string>;
  commute?: boolean;
};

export type Receipt = {
  ok: boolean;
  steps_ok: number;
  steps_attempted: number;
  server_ms: number;
  runner_ms: number;
  raw_bytes: number;
  densified_bytes: number;
  billable_ms: number;
  cache_hits: number;
  result: unknown;
  facts?: unknown;
  table?: string;
  rows?: TypedPrRow[];
  failed_step?: number;
  /** True when mutating steps were rehearsed, not executed (G9 dry-run). */
  dryRun?: boolean;
};

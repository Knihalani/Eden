export type StepKind = "cloud_http" | "cloud_oauth" | "runner";

export type ToolEvent = {
  event_id: string;
  seq: number;
  name: string;
  args: Record<string, unknown>;
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
  failed_step?: number;
};

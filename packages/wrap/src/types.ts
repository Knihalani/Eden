import type { IslandCaller, StretchProgram, StretchTrace, TraceEvent } from "@eden/ir";

export type Receipt = {
  toolId: string;
  version: string;
  ms: number;
  llmCalls: number;
  cents: number;
  ok: boolean;
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
  onReceipt?: (r: Receipt) => void;
  shadow?: boolean;
  timeoutMs?: number;
};

export type RunRecorder = {
  events: TraceEvent[];
  llmCalls: number;
  t0: number;
  cost: number;
};

export function emptyRun(): RunRecorder {
  return { events: [], llmCalls: 0, t0: performance.now(), cost: 0 };
}

export function asToolDef(name: string, def: ToolsIn[string]): ToolDef {
  if (typeof def === "function") return { description: name, execute: def };
  return def;
}

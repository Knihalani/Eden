export type Binding =
  | { kind: "literal"; value: unknown }
  | { kind: "input"; path: string }
  | { kind: "from"; step: string; path: string }
  | { kind: "transform"; fn: string; expr: string; of: Binding };

export type Step =
  | { id: string; kind: "tool"; tool: string; args: Record<string, Binding> }
  | { id: string; kind: "island"; input: Binding; system: string; outputSchema: object }
  | { id: string; kind: "loop"; over: Binding; item: string; body: string[] }
  | { id: string; kind: "assert"; expr: string; onFail: "deopt" | "error" };

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
  steps: Step[];
  sequence?: string[];
  manifest: Manifest | null;
  contract?: { witnesses: number; minLlmReduction: number };
};

export type Candidate = {
  id: string;
  sequence: string[];
  program: StretchProgram | null;
  refusal: { sequence: string[]; reason: string; slot?: string } | null;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE" | "pending";
  manifest: Manifest | null;
  created_at: number;
};

export type ReceiptStats = { n: number; ms: number; llm: number; cents: number; fail: number };

export type LiveLast = { ok: number; ms: number; llm_calls: number; created_at: number };

export type LiveTool = {
  id: string;
  name: string;
  version: string;
  program: StretchProgram;
  state: "live" | "paused" | "rolled_back";
  stats?: ReceiptStats;
  last?: LiveLast | null;
  canRollback?: boolean;
};

export type Inbox = {
  connected: boolean;
  sig: string;
  candidates: Candidate[];
  live: LiveTool[];
  savings: { runs: number; fail: number; llmReductionMean: number; live: number };
};

export type Edits = {
  name?: string;
  forceIsland?: string[];
  drop?: string[];
  pinAssert?: string[];
};

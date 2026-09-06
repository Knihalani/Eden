import type { Manifest, StretchProgram } from "@eden/ir/types";
import type { TokenClass, TokenClasses } from "@eden/ir";
import type { CanvasFail } from "./fail";

export type CanvasSibling = {
  id: string;
  name: string;
  verdict: string;
  /** Named short label — same words as Needs attention, never a raw compiler string. */
  status: string;
};

export type { CanvasFail };

export type CanvasReceipt = {
  ok?: number | boolean;
  outcome?: string;
  deoptReason?: string;
  reason?: string;
  early?: boolean;
  stepsRun?: number;
  skipped?: string[];
  fingerprint?: string;
  tokenClass?: TokenClass;
  tokenClasses?: TokenClasses;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_input_tokens?: number;
  tokensSaved?: number | null;
  timeSavedMs?: number | null;
  ms?: number;
  llm_calls?: number;
  cache_hits?: number;
  cache_lookups?: number;
  cache_hit_rate?: number;
};

export type CanvasModel = {
  mode: "request" | "live";
  id: string;
  name: string;
  program: StretchProgram | null;
  version: string;
  pinnedVersion?: string;
  liveVersion?: string;
  state?: string;
  verdict?: string;
  refusal?: string;
  manifest: Manifest | null;
  siblings: CanvasSibling[];
  fail: CanvasFail | null;
  receipt?: CanvasReceipt | null;
  drift?: boolean;
  origin?: { mode: string; firstWarningAt?: number };
  rollout?: "canary" | "live";
  envelopeLine?: string;
  llmBadge?: "Zero-LLM" | "Island remains";
};

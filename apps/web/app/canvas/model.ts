import type { Manifest, StretchProgram } from "@eden/ir/types";
import type { CanvasFail } from "./fail";

export type CanvasSibling = {
  id: string;
  name: string;
  verdict: string;
  reason?: string;
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
  tokensSaved?: number | null;
  timeSavedMs?: number | null;
  ms?: number;
  llm_calls?: number;
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
};

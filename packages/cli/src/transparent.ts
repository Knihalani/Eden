import { readConfig, sitePlaneUrl, resolveApiKey, type Config } from "./home";
import { inCanary, inDistribution } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import {
  HOOK_OUTPUT_CAP,
  buildSentinel,
  capMerged,
  isBuiltInTool,
  mergeSentinel,
  nativeTextOf,
  sentinelInTextField,
} from "./shapes";

/**
 * Transparent execution — surfacing without a surface.
 *
 * When a recorded tool call matches a live read-only program's first step,
 * Eden executes the program and merges the remainder into the native result
 * shape (plus `additionalContext` so R3 still delivers if the host drops the
 * rewrite). Unknown tools degrade to a string + additionalContext duplicate.
 *
 * Failsafe rules:
 *   - read-only programs only unless Write dual-gate is on
 *   - unknown eligibility ⇒ ineligible (fail closed)
 *   - every failure path returns null → the hook answers normally
 *   - kill switch: `transparent_exec: false` or EDEN_TRANSPARENT=0
 *   - writes: EDEN_TRANSPARENT_WRITES=1 AND `transparent_writes: true` on the tool
 */

export type LiveTool = {
  name?: string;
  sequence?: string[];
  id?: string;
  envelope?: { inputs?: Record<string, unknown[]> } | null;
  read_only?: boolean;
  /** Approve-time checkbox. Required (with the env) to serve a Write-inclusive program. */
  transparent_writes?: boolean;
  /** Missing = already-live 100%. Canary serves only the hashed session bucket. */
  rollout?: "canary" | "live";
};

/** Canary tools stay off for hosted sessions outside the bucket. Empty session is the operator. */
export function inSessionBucket(entry: Pick<LiveTool, "rollout">, sessionId?: string | null): boolean {
  if (entry.rollout !== "canary") return true;
  return inCanary(sessionId);
}

export function transparencyEnabled(cfg: Config | null): boolean {
  if (process.env.EDEN_TRANSPARENT === "0") return false;
  return cfg?.transparent_exec !== false;
}

export function writesGateOpen(entry: LiveTool): boolean {
  return process.env.EDEN_TRANSPARENT_WRITES === "1" && entry.transparent_writes === true;
}

export function sequenceIncludesWrite(seq: string[] | undefined): boolean {
  return (seq ?? []).includes("Write");
}

/**
 * Host tool args are a superset of the program envelope (Read always carries
 * `file_path`, Grep `pattern`, …). Envelope membership is about witnessed
 * entity keys, not the host schema — slice before `inDistribution`.
 */
export function envelopeSlice(entry: LiveTool, input: Record<string, unknown>): Record<string, unknown> {
  const env = entry.envelope?.inputs;
  if (!env) return input;
  const out: Record<string, unknown> = Object.create(null);
  for (const path of Object.keys(env)) {
    const top = path.split(/[.\[]/, 1)[0]!;
    if (Object.prototype.hasOwnProperty.call(input, top)) out[top] = input[top];
  }
  return out;
}

/** Eligibility is fail-closed: anything unknown disqualifies. */
export function eligibleForTransparent(entry: LiveTool, input: Record<string, unknown>): boolean {
  if (!transparencyEnabled(readConfigSafely())) return false;
  if (!entry || typeof entry.name !== "string" || !entry.name) return false;
  const seq = entry.sequence ?? [];
  // Must be the program's FIRST step — later steps are remainder, not trigger.
  if (seq.length < 2) return false;
  if (sequenceIncludesWrite(seq)) {
    if (!writesGateOpen(entry)) return false;
  } else if (entry.read_only !== true) {
    return false;
  }
  if (entry.envelope?.inputs) {
    const probe = {
      contract: { envelope: entry.envelope, allowExact: false, witnesses: 1, minLlmReduction: 2 },
    } as StretchProgram;
    if (!inDistribution(probe, envelopeSlice(entry, input))) return false;
  }
  return true;
}

let cfgCache: { at: number; cfg: Config | null } | null = null;
function readConfigSafely(): Config | null {
  // Hook fires per tool call; config is tiny but disk is disk.
  if (cfgCache && Date.now() - cfgCache.at < 2_000) return cfgCache.cfg;
  try {
    cfgCache = { at: Date.now(), cfg: readConfig() };
  } catch {
    cfgCache = { at: Date.now(), cfg: null };
  }
  return cfgCache.cfg;
}

const TRANSPARENT_TIMEOUT_MS = Math.min(
  8_000,
  Math.max(1_000, Number(process.env.EDEN_TRANSPARENT_MS) || 6_000),
);

/** Execute the compiled program; any failure resolves null (fail open). */
export async function executeTransparent(entry: LiveTool, input: Record<string, unknown>): Promise<string | null> {
  const cfg = readConfigSafely();
  if (!cfg) return null;
  let key: string;
  try {
    key = resolveApiKey([]);
  } catch {
    return null;
  }
  const base = sitePlaneUrl(cfg.base_url);
  try {
    const res = await fetch(`${base}/v1/play`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: entry.name, args: input, params: input }),
      signal: AbortSignal.timeout(TRANSPARENT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; facts?: unknown; table?: string };
    if (json.ok === false) return null;
    const factsText =
      json.table ||
      (json.facts ? JSON.stringify(json.facts) : null);
    return typeof factsText === "string" && factsText.length > 0 ? factsText : null;
  } catch {
    return null;
  }
}

export type PostToolUseOpts = {
  /** Degrade path (R3): additionalContext still lands when the host blocks. */
  decision?: "block";
};

/**
 * Claude Code PostToolUse output replacement.
 *
 * `updatedToolOutput` must mirror the tool's NATIVE result shape. Built-ins
 * get a structured object with the sentinel merged into the text field (Glob
 * has none — object identity preserved, sentinel only in additionalContext).
 * Unknown tools get a string. Facts are always duplicated into
 * `additionalContext` (R3). Cap 9,500 with an honest truncation note.
 */
export function postToolUseReplacement(
  toolName: string,
  originalOutput: unknown,
  receiptText: string | unknown,
  programName?: string,
  opts?: PostToolUseOpts,
): Record<string, unknown> {
  const label = programName || toolName;
  const suffix = buildSentinel(label, receiptText);
  const additionalContext = suffix.trim();
  const updatedToolOutput = isBuiltInTool(toolName)
    ? mergeSentinel(toolName, originalOutput, suffix)
    : capMerged(
        typeof originalOutput === "string" ? originalOutput : nativeTextOf(toolName, originalOutput),
        suffix,
      );

  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: "PostToolUse",
    additionalContext,
    updatedToolOutput,
  };
  const out: Record<string, unknown> = { hookSpecificOutput };
  if (opts?.decision === "block") out.decision = "block";
  return out;
}

export { HOOK_OUTPUT_CAP, sentinelInTextField };

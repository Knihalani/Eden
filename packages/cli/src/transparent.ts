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

export type LiveTool = {
  name?: string;
  sequence?: string[];
  id?: string;
  envelope?: { inputs?: Record<string, unknown[]> } | null;
  read_only?: boolean;
  transparent_writes?: boolean;
  rollout?: "canary" | "live";
};

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

export function eligibleForTransparent(entry: LiveTool, input: Record<string, unknown>): boolean {
  if (!transparencyEnabled(readConfigSafely())) return false;
  if (!entry || typeof entry.name !== "string" || !entry.name) return false;
  const seq = entry.sequence ?? [];
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
  decision?: "block";
};

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

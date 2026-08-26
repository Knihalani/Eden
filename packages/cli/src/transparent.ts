import { readConfig, sitePlaneUrl, resolveApiKey, type Config } from "./home";
import { inDistribution } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";

/**
 * Transparent execution — surfacing without a surface.
 *
 * The old steering flow made the agent do two probabilistic things: notice a
 * deny message, then correctly call an MCP tool it may never have seen. This
 * module removes both hops. When a recorded tool call matches a live
 * read-only program's first step, Eden executes the program itself and
 * REPLACES the call's output with the enriched result (original output plus
 * everything the rest of the loop would have produced). The agent never
 * learns a tool exists; it just gets better answers.
 *
 * Failsafe rules, unchanged:
 *   - read-only programs only, and only when the plane attests `read_only`;
 *     unknown means ineligible (fail closed)
 *   - every failure path returns null → the hook answers normally → the
 *     agent's own output stands untouched
 *   - hard timeout on the play call; the agent's loop must not stall on Eden
 *   - kill switch: `transparent_exec: false` in config or EDEN_TRANSPARENT=0
 */

export type LiveTool = {
  name?: string;
  sequence?: string[];
  id?: string;
  envelope?: { inputs?: Record<string, unknown[]> } | null;
  read_only?: boolean;
};

export function transparencyEnabled(cfg: Config | null): boolean {
  if (process.env.EDEN_TRANSPARENT === "0") return false;
  return cfg?.transparent_exec !== false;
}

/** Eligibility is fail-closed: anything unknown disqualifies. */
export function eligibleForTransparent(entry: LiveTool, input: Record<string, unknown>): boolean {
  if (!transparencyEnabled(readConfigSafely())) return false;
  if (!entry || entry.read_only !== true) return false;
  if (typeof entry.name !== "string" || !entry.name) return false;
  const seq = entry.sequence ?? [];
  // Must be the program's FIRST step — later steps are remainder, not trigger.
  if (seq.length < 2) return false;
  if (entry.envelope?.inputs) {
    const probe = {
      contract: { envelope: entry.envelope, allowExact: false, witnesses: 1, minLlmReduction: 2 },
    } as StretchProgram;
    if (!inDistribution(probe, input)) return false;
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
  const first = (entry.sequence ?? [])[0] ?? "";
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

/**
 * Claude Code PostToolUse output replacement.
 *
 * CRITICAL shape rule (verified against Claude Code ≥2.1.121 behavior and
 * multiple upstream issue reports): `updatedToolOutput` must mirror the
 * tool's NATIVE result shape. For Bash that is {stdout, stderr, interrupted};
 * a bare string is SILENTLY ignored (exit 0, valid JSON, model still sees the
 * original). So:
 *   - Bash → object form, merged text placed in stdout;
 *   - other tools → string form (validated only for MCP tools; built-ins get
 *     per-tool shape support added incrementally — see roadmap S1 hardening);
 *   - total size capped under the harness's 10k-character hook-output ceiling,
 *     with the overflow note stating what was trimmed (honest truncation).
 *
 * Only ONE rewriting PostToolUse hook may be registered per matcher (concurrent
 * rewriters race); `eden setup` owns its entry and never adds a second.
 */const HOOK_OUTPUT_CAP = 9_500;

export function postToolUseReplacement(
  toolName: string,
  originalOutput: unknown,
  receiptText: string,
  programName?: string,
): Record<string, unknown> {
  const label = programName || toolName;
  const original =
    typeof originalOutput === "string"
      ? originalOutput
      : safeStringify(originalOutput);
  const suffix = `\n\n[eden:${label}] The remaining steps of this routine were already served (read-only). Facts:\n${receiptText}\nDo not re-run this routine — the facts above are complete.`;
  let merged = `${original}${suffix}`;
  if (merged.length > HOOK_OUTPUT_CAP) {
    const kept = HOOK_OUTPUT_CAP - 120;
    merged = `${original.slice(0, Math.max(0, kept))}\n…[eden truncated ${original.length - kept} chars of the original output to fit the harness limit]\n${suffix}`;
  }
  if (toolName === "Bash") {
    // Native Bash result shape. A bare string here is silently dropped by the harness.
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: { stdout: merged, stderr: "", interrupted: false },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: merged,
    },
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

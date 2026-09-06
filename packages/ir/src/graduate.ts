/**
 * Wave 10 — envelope graduation helpers.
 *
 * Frozen labels. Home, canvas, and CLI consume these; they do not fork copy.
 * inDistribution stays exact. Soft-match is matchClass === "soft" behind
 * contract.softMatch. Drop may tighten; add of invented values is refused
 * at the editor. Width-inherit uses inheritEnvelopeValues on confirmed live ids.
 */
import { createHash } from "node:crypto";
import type { StretchProgram } from "./types";
import { inDistribution, extraInputKeys } from "./envelope";
import { eq } from "./eq";
import { getPath } from "./path";

export const WIDTH_INHERIT_K = 3;
export const CANARY_PCT = 10;
export const JIT_MAX = 4;
export const ISLAND_READY_AGREEING = 4;

export type MatchClass = "exact" | "soft" | "ood";

export type Envelope = { inputs: Record<string, unknown[]> };

/** True when no island can still call a model. Pinned islands are memo-only. */
export function zeroLlm(program: { steps: Array<{ kind: string; pinned?: boolean }> }): boolean {
  return !program.steps.some((s) => s.kind === "island" && s.pinned !== true);
}

export function llmBadge(program: { steps: Array<{ kind: string; pinned?: boolean }> }): "Zero-LLM" | "Island remains" {
  return zeroLlm(program) ? "Zero-LLM" : "Island remains";
}

export function islandStability(counts: { agreeing: number; disagreeing: number }): { score: number; ready: boolean } {
  const agreeing = Math.max(0, counts.agreeing | 0);
  const disagreeing = Math.max(0, counts.disagreeing | 0);
  const n = agreeing + disagreeing;
  const score = n === 0 ? 0 : agreeing / n;
  return { score, ready: agreeing >= ISLAND_READY_AGREEING && disagreeing === 0 };
}

export function matchClass(program: StretchProgram, input: Record<string, unknown>): MatchClass {
  const env = program.contract.envelope?.inputs;
  if (!env || Object.keys(env).length === 0) return inDistribution(program, input) ? "exact" : "ood";
  if (extraInputKeys(program, input).length) return "ood";
  if (inDistribution(program, input)) return "exact";
  let novel = false;
  for (const [path, values] of Object.entries(env)) {
    if (!Array.isArray(values) || values.length === 0) return "ood";
    const v = getPath(input, path);
    if (v === undefined) return "ood";
    const sample = values[0];
    if (sample !== null && v !== null && typeof v !== typeof sample) return "ood";
    if (!values.some((w) => eq(w, v))) novel = true;
  }
  return novel ? "soft" : "ood";
}

/** Steer may serve soft only when the contract opted in. OOD never. */
export function mayServe(program: StretchProgram, input: Record<string, unknown>, opts?: { canaryOrLive?: boolean }): boolean {
  const cls = matchClass(program, input);
  if (cls === "exact") return true;
  if (cls === "ood") return false;
  return program.contract.softMatch === true && opts?.canaryOrLive !== false;
}

export function dropEnvelopeValue(
  envelope: Envelope,
  path: string,
  value: unknown,
): { ok: true; envelope: Envelope } | { ok: false; error: string } {
  const cur = envelope.inputs[path];
  if (!Array.isArray(cur)) return { ok: false, error: `${path} is not a witnessed key. Nothing is invented.` };
  const next = cur.filter((w) => !eq(w, value));
  if (next.length === cur.length) return { ok: false, error: `${path} does not contain that value.` };
  if (next.length === 0) return { ok: false, error: `${path}: emptying a key is refused.` };
  return { ok: true, envelope: { inputs: { ...envelope.inputs, [path]: next } } };
}

/**
 * Add witnessed live values onto existing keys only. New keys are ignored.
 * Used after K clean sibling-width receipts — never from the editor.
 */
export function inheritEnvelopeValues(envelope: Envelope, input: Record<string, unknown>): Envelope {
  const inputs: Record<string, unknown[]> = { ...envelope.inputs };
  for (const [path, values] of Object.entries(envelope.inputs)) {
    if (!Array.isArray(values)) continue;
    const v = getPath(input, path);
    if (v === undefined) continue;
    if (values.some((w) => eq(w, v))) continue;
    inputs[path] = [...values, v];
  }
  return { inputs };
}

export function envelopeCounts(envelope?: Envelope | null): { keys: number; values: number } {
  if (!envelope?.inputs) return { keys: 0, values: 0 };
  const keys = Object.keys(envelope.inputs).length;
  let values = 0;
  for (const v of Object.values(envelope.inputs)) if (Array.isArray(v)) values += v.length;
  return { keys, values };
}

export function envelopeLine(envelope?: Envelope | null): string {
  const { keys, values } = envelopeCounts(envelope);
  if (keys === 0) return "Envelope · none";
  return `Envelope · ${keys} key${keys === 1 ? "" : "s"} · ${values} value${values === 1 ? "" : "s"}`;
}

export function canaryPct(): number {
  const n = Number(process.env.EDEN_CANARY_PCT);
  if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.floor(n);
  return CANARY_PCT;
}

export function jitMax(): number {
  const n = Number(process.env.EDEN_JIT_MAX);
  if (Number.isFinite(n) && n >= 0 && n <= 64) return Math.floor(n);
  return JIT_MAX;
}

/**
 * Stable session bucket.
 * Unpartitioned wrap (empty session) is the operator — they see canary, so
 * Approve is not a no-op until Promote. Hosted sessions hash at `pct`.
 */
export function inCanary(sessionId: string | undefined | null, pct = canaryPct()): boolean {
  if (!sessionId) return true;
  const hex = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n)) return true;
  return n % 100 < pct;
}

export function shouldInheritWidth(cleanSiblingReceipts: number, k = WIDTH_INHERIT_K): boolean {
  return cleanSiblingReceipts >= k;
}

export function rolloutOf(flag: string | undefined | null): "canary" | "live" {
  return flag === "canary" ? "canary" : "live";
}

/** Missing rollout is already-shipped 100% Live. Canary is never counted as Live. */
export function rolloutPartition(tools: Array<{ rollout?: string | null }>): { n: number; canary: number; live: number } {
  const n = tools.length;
  const canary = tools.filter((t) => t.rollout === "canary").length;
  return { n, canary, live: n - canary };
}

/** Canary first, then Live. Omits a zero count so a canary-only fleet is not "0 Live". */
export function canaryLiveParts(p: { live: number; canary: number }): string[] {
  const parts: string[] = [];
  if (p.canary) parts.push(`${p.canary} Canary`);
  if (p.live) parts.push(`${p.live} Live`);
  return parts;
}

/** Doctor/digest inventory. Same words everywhere: `N programs`, plus Canary/Live when mixed. */
export function toolsInventoryLine(p: { n: number; canary: number; live: number }): string {
  if (!p.canary) return `${p.n} programs`;
  return [`${p.n} programs`, ...canaryLiveParts(p)].join(" · ");
}

/** Home/nav/canvas list title. A canary-only fleet is Canary, not Live tools. Empty is `0 programs`, same as doctor/digest. */
export function toolsListTitle(p: { canary: number; live: number }): string {
  if (!p.canary && !p.live) return "0 programs";
  if (p.canary && !p.live) return "Canary";
  if (p.canary) return "Tools";
  return "Live tools";
}

/**
 * Skill / drain one-liner. Prefer the program field, then the first island
 * that wrote one, then description. Silent islands do not invent copy.
 */
export function whenToUseOf(program: {
  description: string;
  when_to_use?: string | null;
  steps?: Array<{ kind: string; when_to_use?: string | null }>;
}): string {
  const own = typeof program.when_to_use === "string" ? program.when_to_use.trim() : "";
  if (own) return own;
  for (const s of program.steps ?? []) {
    if (s.kind !== "island") continue;
    const line = typeof s.when_to_use === "string" ? s.when_to_use.trim() : "";
    if (line) return line;
  }
  return program.description;
}

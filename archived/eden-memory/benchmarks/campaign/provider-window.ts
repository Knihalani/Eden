/**
 * Recorded provider-usage window — Wave 12.1 attribution fixture.
 *
 * A critic can open `provider-window.json` and see real-shaped OpenAI +
 * Anthropic `usage` objects plus independently labeled `tokenClasses`.
 * Reconciliation compares those two: labeled billed tokens vs parseUsage
 * prompt+completion. Cache is a separate line. Classes are never filled
 * by dumping parseUsage into `tokenClass`.
 *
 * Not a campaign world. Does not retune cert-rate.
 *
 *   bun test benchmarks/campaign/provider-window.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  billedTokens,
  emptyTokenClasses,
  reconcileTokenClasses,
  TOKEN_CLASSES,
  tokenClassKey,
  type TokenClass,
  type TokenClasses,
} from "@eden/ir";
import { parseCacheTokens, parseUsage } from "@eden/wrap";

export const PROVIDER_WINDOW_PATH = join(import.meta.dir, "provider-window.json");

export type ProviderTurn = {
  id: string;
  provider: "openai" | "anthropic" | "none";
  tokenClass: TokenClass;
  /** Independently labeled expected classes. Absent when unmeasured. */
  tokenClasses?: TokenClasses;
  note?: string;
  response?: { usage?: unknown };
};

export type ProviderWindow = {
  recordedAt: string;
  purpose: string;
  notes?: string[];
  /** Independently labeled window rollup. Must match the sum of turn labels. */
  tokenClasses?: TokenClasses;
  turns: ProviderTurn[];
};

export function loadProviderWindow(path: string = PROVIDER_WINDOW_PATH): ProviderWindow {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ProviderWindow;
  if (!raw || !Array.isArray(raw.turns) || raw.turns.length === 0) {
    throw new Error("provider-window.json: missing turns");
  }
  return raw;
}

export function usageOf(turn: ProviderTurn): unknown {
  return turn.response?.usage;
}

function n(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return 0;
}

/** Read labeled classes from JSON only. Never parseUsage. */
export function labeledClasses(raw: unknown): TokenClasses | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const present =
    "compiled" in o ||
    "memoized" in o ||
    "transparent" in o ||
    "steeredSkip" in o ||
    "steered-skip" in o ||
    "frontier" in o;
  if (!present) return null;
  const classes: TokenClasses = {
    compiled: n(o.compiled),
    memoized: n(o.memoized),
    transparent: n(o.transparent),
    steeredSkip: n(o.steeredSkip ?? o["steered-skip"]),
    frontier: n(o.frontier),
  };
  const cache = n(o.providerCache);
  if (cache > 0) classes.providerCache = cache;
  return classes;
}

/** Labeled classes for a turn — JSON `tokenClasses`, not parseUsage dumped into tokenClass. */
export function classesForTurn(turn: ProviderTurn): TokenClasses | null {
  return labeledClasses(turn.tokenClasses);
}

/**
 * All billed tokens sit in the named class. A dump of parseUsage into the
 * wrong `tokenClass` label fails here even when the sum still matches.
 */
export function attributionAgrees(turn: ProviderTurn): boolean {
  const labeled = classesForTurn(turn);
  const parsed = parseUsage(usageOf(turn));
  if (!parsed) return labeled == null;
  if (!labeled) return false;
  const billed = billedTokens(labeled);
  if (billed !== parsed.prompt + parsed.completion) return false;
  return labeled[tokenClassKey(turn.tokenClass)] === billed;
}

export function addWindowClasses(into: TokenClasses, extra: TokenClasses): TokenClasses {
  into.compiled += extra.compiled;
  into.memoized += extra.memoized;
  into.transparent += extra.transparent;
  into.steeredSkip += extra.steeredSkip;
  into.frontier += extra.frontier;
  const cache = (into.providerCache ?? 0) + (extra.providerCache ?? 0);
  if (cache > 0) into.providerCache = cache;
  else delete into.providerCache;
  return into;
}

export function windowClasses(window: ProviderWindow): TokenClasses {
  const into = emptyTokenClasses();
  for (const turn of window.turns) {
    const labeled = classesForTurn(turn);
    if (labeled) addWindowClasses(into, labeled);
  }
  return into;
}

export function windowProvider(window: ProviderWindow): { prompt: number; completion: number } {
  let prompt = 0;
  let completion = 0;
  for (const turn of window.turns) {
    const parsed = parseUsage(usageOf(turn));
    if (!parsed) continue;
    prompt += parsed.prompt;
    completion += parsed.completion;
  }
  return { prompt, completion };
}

export function reconcileProviderWindow(window: ProviderWindow = loadProviderWindow()): {
  ok: boolean;
  billed: number;
  provider: number;
  delta: number;
  classes: TokenClasses;
  prompt: number;
  completion: number;
  providerCache: number;
  attribution: boolean;
  rollupAgrees: boolean;
} {
  const classes = windowClasses(window);
  const provider = windowProvider(window);
  const recon = reconcileTokenClasses(classes, provider);
  const expected = labeledClasses(window.tokenClasses);
  const rollupAgrees =
    expected != null &&
    expected.compiled === classes.compiled &&
    expected.memoized === classes.memoized &&
    expected.transparent === classes.transparent &&
    expected.steeredSkip === classes.steeredSkip &&
    expected.frontier === classes.frontier &&
    (expected.providerCache ?? 0) === (classes.providerCache ?? 0);
  return {
    ...recon,
    ok: recon.ok && rollupAgrees && window.turns.every(attributionAgrees),
    classes,
    prompt: provider.prompt,
    completion: provider.completion,
    providerCache: classes.providerCache ?? 0,
    attribution: window.turns.every(attributionAgrees),
    rollupAgrees,
  };
}

export { billedTokens, TOKEN_CLASSES };

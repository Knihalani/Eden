/**
 * Weekly digest payload (Wave 8.4). Same tiles as Home. Honest zeros.
 * Opt-in: render returns null when optIn is false — never send a letter
 * nobody asked for.
 */
import { canaryLiveParts, providerCacheHitInput, providerCacheHitPct, toolsInventoryLine } from "@eden/ir";
import { stretchHead, stretchLine, type StretchWord } from "./stretch";

export { providerCacheHitInput, providerCacheHitPct };

export type DigestDay = {
  label: string;
  dcPct: number;
  measured: boolean;
};

export type DigestNovelty = {
  name: string;
  status: string;
};

export type DigestStretch = {
  name: string;
  state: string;
  /** Serving stamp. Missing = already-shipped 100%. */
  rollout?: string | null;
  words: StretchWord[];
  extra?: string[];
};

export type DigestInput = {
  optIn: boolean;
  compiled: number;
  runs: number;
  waiting: number;
  fails: number;
  tokensSaved: number;
  /** Null when no receipt carried tokenClasses. */
  dcPct: number | null;
  /**
   * Provider cache hit % against the dialect's total input, 0–100 like dcPct.
   * Null when unmeasured — omit the ledger line. 0 when measured zero.
   * Not run-cache `cache_hits / cache_lookups`.
   */
  cacheHitPct?: number | null;
  dcSeries: DigestDay[];
  novelty: DigestNovelty[];
  stretches?: DigestStretch[];
  /** Canary among compiled. Missing = 0 (already-shipped 100%). */
  canary?: number;
};

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(n)));
}

/** Unmeasured is an em dash; measured zero is 0%. */
export function formatDcPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

/**
 * 0–100 display of dialect-aware cache-hit rate. Null when unmeasured.
 * Same words Home / canvas should import — not run-cache hit rate.
 */
export function cacheHitPctOf(
  cached: number | null | undefined,
  prompt: number | null | undefined,
  cacheWrite?: number | null,
  cacheDenom?: number | null,
): number | null {
  const ratio = providerCacheHitPct(cached, prompt, cacheWrite, cacheDenom);
  return ratio == null ? null : ratio * 100;
}

/** Ledger line, or null when unmeasured (omit — never a fake %). */
export function providerCacheHitLine(
  cached: number | null | undefined,
  prompt: number | null | undefined,
  cacheWrite?: number | null,
  cacheDenom?: number | null,
): string | null {
  const pct = cacheHitPctOf(cached, prompt, cacheWrite, cacheDenom);
  if (pct == null) return null;
  return `provider cache hit % ${formatDcPct(pct)}`;
}

function digestCacheHitLine(input: DigestInput): string | null {
  if (input.cacheHitPct == null || !Number.isFinite(input.cacheHitPct)) return null;
  return `provider cache hit % ${formatDcPct(input.cacheHitPct)}`;
}

function digestToolsLine(input: DigestInput): string {
  const canary = input.canary ?? 0;
  const n = input.compiled;
  return toolsInventoryLine({ n, canary, live: n - canary });
}

function digestToolsRow(input: DigestInput): [string, string] {
  const canary = input.canary ?? 0;
  const n = input.compiled;
  if (!canary) return ["Programs", formatCount(n)];
  return ["Programs", canaryLiveParts({ live: n - canary, canary }).join(" · ")];
}

function stretchText(s: DigestStretch): string {
  return stretchLine(stretchHead(s.state, s.rollout), s.words, s.extra);
}

function dayLine(d: DigestDay): string {
  const n = d.measured ? formatDcPct(d.dcPct) : "0";
  return `${d.label} ${n}`;
}

export function renderDigestText(input: DigestInput): string | null {
  if (!input.optIn) return null;
  const novelty =
    input.novelty.length === 0
      ? "Needs attention 0"
      : input.novelty.map((n) => `${n.name} · ${n.status}`).join("\n");
  const stretches =
    input.stretches && input.stretches.length
      ? input.stretches.map((s) => stretchText(s)).join("\n")
      : null;
  const dcDays = input.dcSeries.length
    ? input.dcSeries.map(dayLine).join(" · ")
    : "Mon 0 · Tue 0 · Wed 0 · Thu 0 · Fri 0 · Sat 0 · Sun 0";
  const cacheLine = digestCacheHitLine(input);
  return [
    "Eden weekly",
    digestToolsLine(input),
    `Compiled runs ${formatCount(input.runs)}`,
    `Waiting ${formatCount(input.waiting)}`,
    `Failed ${formatCount(input.fails)}`,
    `Deterministic share ${formatDcPct(input.dcPct)}`,
    ...(cacheLine ? [cacheLine] : []),
    `Tokens saved ${formatCount(input.tokensSaved)}`,
    `Last 7 days ${dcDays}`,
    novelty,
    ...(stretches ? [stretches] : []),
  ].join("\n");
}

export function renderDigestHtml(input: DigestInput): string | null {
  const text = renderDigestText(input);
  if (text == null) return null;
  const rows = [
    digestToolsRow(input),
    ["Compiled runs", formatCount(input.runs)],
    ["Waiting", formatCount(input.waiting)],
    ["Failed", formatCount(input.fails)],
    ["Deterministic share", formatDcPct(input.dcPct)],
    ...(input.cacheHitPct != null && Number.isFinite(input.cacheHitPct)
      ? ([["provider cache hit %", formatDcPct(input.cacheHitPct)]] as [string, string][])
      : []),
    ["Tokens saved", formatCount(input.tokensSaved)],
  ];
  const metrics = rows
    .map(([k, v]) => `<p><b>${escapeHtml(v!)}</b> ${escapeHtml(k!)}</p>`)
    .join("");
  const days = (input.dcSeries.length ? input.dcSeries : emptyDays())
    .map((d) => `<li>${escapeHtml(d.label)} ${escapeHtml(d.measured ? formatDcPct(d.dcPct) : "0")}</li>`)
    .join("");
  const novelty =
    input.novelty.length === 0
      ? "<p>Needs attention 0</p>"
      : `<ul>${input.novelty.map((n) => `<li>${escapeHtml(n.name)} · ${escapeHtml(n.status)}</li>`).join("")}</ul>`;
  const stretches =
    input.stretches && input.stretches.length
      ? `<ul>${input.stretches.map((s) => `<li>${escapeHtml(stretchText(s))}</li>`).join("")}</ul>`
      : "<p>0</p>";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Eden weekly</title></head>
<body>
<article>
<h1>Eden weekly</h1>
${metrics}
<h2>Last 7 days</h2>
<ul>${days}</ul>
<h2>Needs attention</h2>
${novelty}
<h2>Stretches</h2>
${stretches}
</article>
</body>
</html>`;
}

function emptyDays(): DigestDay[] {
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => ({
    label,
    dcPct: 0,
    measured: false,
  }));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const EMPTY_DIGEST: DigestInput = {
  optIn: true,
  compiled: 0,
  runs: 0,
  waiting: 0,
  fails: 0,
  tokensSaved: 0,
  dcPct: null,
  cacheHitPct: null,
  dcSeries: emptyDays(),
  novelty: [],
  stretches: [],
};

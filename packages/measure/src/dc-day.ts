/**
 * Per-workspace per-day DC% aggregation (Wave 2.2).
 *
 * Sums TokenClasses, then calls the frozen dcShare() — providerCache is
 * accumulated as a separate line and never enters the share.
 */
import { billedTokens, emptyTokenClasses, type TokenClasses } from "@eden/ir";
import { dcPct, dcShare } from "./dc";

export type DcRun = {
  workspace: string;
  day: string;
  classes: TokenClasses;
  at?: number;
};

export type DcDay = {
  workspace: string;
  day: string;
  classes: TokenClasses;
  dcShare: number;
  dcPct: number;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcDaysEnding(now: number, n: number): string[] {
  const days = Math.max(1, Math.floor(n));
  const today = utcDay(now);
  if (!DAY_RE.test(today)) return [];
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const end = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(end - i * 86_400_000));
  return out;
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

export function asTokenClasses(value: unknown): TokenClasses | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const steered = o.steeredSkip ?? o["steered-skip"];
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
    steeredSkip: n(steered),
    frontier: n(o.frontier),
  };
  const cache = n(o.providerCache);
  if (cache > 0) classes.providerCache = cache;
  // Leftover empty object (skip-only, no billed tokens, no cache) is unmeasured.
  // Real measured zeros still have billed tokens (e.g. all frontier).
  if (billedTokens(classes) === 0 && !(classes.providerCache && classes.providerCache > 0)) return null;
  return classes;
}

export function addTokenClasses(into: TokenClasses, extra: TokenClasses): TokenClasses {
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

export function parseDcRun(value: unknown): DcRun | null {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!row) return null;
  const workspace = typeof row.workspace === "string" ? row.workspace.trim() : "";
  const day = typeof row.day === "string" ? row.day.trim() : "";
  if (!workspace || !DAY_RE.test(day)) return null;
  const nested = asTokenClasses(row.classes);
  const flat = nested ?? asTokenClasses(row);
  if (!flat) return null;
  const at = Number(row.at);
  return {
    workspace,
    day,
    classes: flat,
    ...(Number.isFinite(at) && at > 0 ? { at } : {}),
  };
}

export function parseDcJsonl(text: string): DcRun[] {
  const runs: DcRun[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const run = parseDcRun(parsed);
    if (run) runs.push(run);
  }
  return runs;
}

function keyOf(workspace: string, day: string): string {
  return `${workspace}\t${day}`;
}

export function aggregateDc(runs: DcRun[]): DcDay[] {
  const buckets = new Map<string, { workspace: string; day: string; classes: TokenClasses }>();
  for (const run of runs) {
    if (!run.workspace || !DAY_RE.test(run.day)) continue;
    const key = keyOf(run.workspace, run.day);
    const hit = buckets.get(key);
    if (hit) addTokenClasses(hit.classes, run.classes);
    else {
      buckets.set(key, {
        workspace: run.workspace,
        day: run.day,
        classes: addTokenClasses(emptyTokenClasses(), run.classes),
      });
    }
  }
  const out: DcDay[] = [];
  for (const row of buckets.values()) {
    const share = dcShare(row.classes);
    const pct = dcPct(row.classes);
    out.push({
      workspace: row.workspace,
      day: row.day,
      classes: row.classes,
      dcShare: Number.isFinite(share) ? share : 0,
      dcPct: Number.isFinite(pct) ? pct : 0,
    });
  }
  out.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.day.localeCompare(b.day));
  return out;
}

export function detTokens(c: TokenClasses): number {
  return c.compiled + c.memoized + c.transparent + c.steeredSkip;
}

export function formatDcLine(row: DcDay): string {
  const billed = billedTokens(row.classes);
  const det = detTokens(row.classes);
  const json = {
    workspace: row.workspace,
    day: row.day,
    dcShare: row.dcShare,
    dcPct: row.dcPct,
    billed,
    det,
    frontier: row.classes.frontier,
    classes: row.classes,
  };
  return `${row.workspace} ${row.day} ${row.dcPct} ${billed} ${det} ${row.classes.frontier} ${JSON.stringify(json)}`;
}


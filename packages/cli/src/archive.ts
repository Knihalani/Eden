/**
 * Archival tiers on top of ~/.eden/runs retention.
 *
 *   hot  — ~/.eden/runs (existing retain window, EDEN_RETAIN_DAYS default 14)
 *   warm — ~/.eden/archive/warm compacted JSONL receipts (no full events)
 *   cold — ~/.eden/archive/cold/YYYY-MM.jsonl monthly DC+counts
 *
 * CLI-only. A bug here must never throw on the wrap/agent path.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { billedTokens, emptyTokenClasses, type TokenClasses } from "@eden/ir";
import { edenHome, writeFileAtomic } from "./home";

export const DEFAULT_RETAIN_DAYS = 14;
export const DEFAULT_WARM_DAYS = 90;
export const DEFAULT_COLD_MONTHS = 24;

const DAY_MS = 86_400_000;

export type WarmReceipt = {
  id: string;
  tokenClasses?: TokenClasses;
  agentId?: string;
  parentRunId?: string;
  fleetId?: string;
  region?: string;
  at: number;
};

export type ColdMonth = {
  month: string;
  runs: number;
  classes: TokenClasses;
  billed: number;
  dcShare: number;
};

export type ArchiveStatus = {
  hot: number;
  warm: number;
  cold: number;
  hotDir: string;
  warmDir: string;
  coldDir: string;
};

export type CompactResult = {
  ok: boolean;
  error?: string;
  hotToWarm: number;
  warmToCold: number;
  coldDropped: number;
  liveHotKept: number;
};

function daysEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function retainMs(): number {
  return daysEnv("EDEN_RETAIN_DAYS", DEFAULT_RETAIN_DAYS) * DAY_MS;
}

export function warmMs(): number {
  return daysEnv("EDEN_WARM_DAYS", DEFAULT_WARM_DAYS) * DAY_MS;
}

export function coldMonths(): number {
  return Math.floor(daysEnv("EDEN_COLD_MONTHS", DEFAULT_COLD_MONTHS));
}

export function archivePaths(home = edenHome()): { hot: string; warm: string; cold: string; warmFile: string } {
  return {
    hot: join(home, "runs"),
    warm: join(home, "archive", "warm"),
    cold: join(home, "archive", "cold"),
    warmFile: join(home, "archive", "warm", "receipts.jsonl"),
  };
}

/** Frozen DC% — same arithmetic as @eden/measure dcShare. Provider cache excluded. */
export function archiveDcShare(c: TokenClasses): number {
  const det = c.compiled + c.memoized + c.transparent + c.steeredSkip;
  const total = det + c.frontier;
  if (!(total > 0)) return 0;
  return det / total;
}

function asClasses(v: unknown): TokenClasses | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    compiled: n(o.compiled),
    memoized: n(o.memoized),
    transparent: n(o.transparent),
    steeredSkip: n(o.steeredSkip),
    frontier: n(o.frontier),
    ...(typeof o.providerCache === "number" && Number.isFinite(o.providerCache)
      ? { providerCache: o.providerCache }
      : {}),
  };
}

function addClasses(into: TokenClasses, extra?: TokenClasses): void {
  if (!extra) return;
  into.compiled += extra.compiled;
  into.memoized += extra.memoized;
  into.transparent += extra.transparent;
  into.steeredSkip += extra.steeredSkip;
  into.frontier += extra.frontier;
  if (extra.providerCache) into.providerCache = (into.providerCache ?? 0) + extra.providerCache;
}

function monthKey(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

function readJsonl(path: string): unknown[] {
  try {
    const text = readFileSync(path, "utf8");
    const out: unknown[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip corrupt line — fail-open */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function strField(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Compact one hot run file into a warm receipt. Full `events` are dropped.
 * Identity and tokenClasses come from the file name + last record that carried them.
 */
export function compactHotFile(path: string, id: string, at: number): WarmReceipt {
  const rows = readJsonl(path);
  const receipt: WarmReceipt = { id, at };
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const classes = asClasses(row.tokenClasses);
    if (classes) receipt.tokenClasses = classes;
    const agentId = strField(row, "agentId");
    if (agentId) receipt.agentId = agentId;
    const parentRunId = strField(row, "parentRunId");
    if (parentRunId) receipt.parentRunId = parentRunId;
    const fleetId = strField(row, "fleetId");
    if (fleetId) receipt.fleetId = fleetId;
    const region = strField(row, "region");
    if (region) receipt.region = region;
    const stamped = typeof row.at === "number" ? row.at : typeof row.ts === "number" ? row.ts : undefined;
    if (typeof stamped === "number" && Number.isFinite(stamped)) receipt.at = stamped;
  }
  return receipt;
}

function rmQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* gone */
  }
}

function countLines(path: string): number {
  try {
    const text = readFileSync(path, "utf8");
    let n = 0;
    for (const line of text.split("\n")) if (line.trim()) n += 1;
    return n;
  } catch {
    return 0;
  }
}

export function archiveStatus(): ArchiveStatus {
  try {
    const p = archivePaths();
    const hot = listJsonl(p.hot).length;
    let warm = 0;
    for (const f of listJsonl(p.warm)) warm += countLines(join(p.warm, f));
    const cold = listJsonl(p.cold).length;
    return { hot, warm, cold, hotDir: p.hot, warmDir: p.warm, coldDir: p.cold };
  } catch {
    const p = archivePaths();
    return { hot: 0, warm: 0, cold: 0, hotDir: p.hot, warmDir: p.warm, coldDir: p.cold };
  }
}

export function formatArchiveStatus(s: ArchiveStatus = archiveStatus()): string {
  return [
    "eden archive",
    `  hot   ${s.hot} runs       ${s.hotDir}`,
    `  warm  ${s.warm} receipts   ${s.warmDir}`,
    `  cold  ${s.cold} months     ${s.coldDir}`,
  ].join("\n");
}

function coldFromFile(path: string, month: string): ColdMonth {
  const rows = readJsonl(path);
  const classes = emptyTokenClasses();
  let runs = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    runs += typeof row.runs === "number" && row.runs > 0 ? row.runs : 1;
    addClasses(classes, asClasses(row.classes) ?? asClasses(row.tokenClasses));
  }
  return { month, runs, classes, billed: billedTokens(classes), dcShare: archiveDcShare(classes) };
}

function writeCold(path: string, row: ColdMonth): void {
  writeFileAtomic(path, JSON.stringify(row) + "\n");
}

/**
 * Move eligible hot → warm → cold. Never deletes a live hot file younger than
 * the retain window. Never throws (fail-open for the CLI; wrap never calls this).
 */
export function compactArchive(now = Date.now()): CompactResult {
  try {
    return compactArchiveUnsafe(now);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hotToWarm: 0,
      warmToCold: 0,
      coldDropped: 0,
      liveHotKept: 0,
    };
  }
}

function compactArchiveUnsafe(now: number): CompactResult {
  const p = archivePaths();
  mkdirSync(p.warm, { recursive: true });
  mkdirSync(p.cold, { recursive: true });
  const retain = retainMs();
  const warmHorizon = warmMs();
  let hotToWarm = 0;
  let liveHotKept = 0;

  const newWarm: WarmReceipt[] = [];
  for (const f of listJsonl(p.hot)) {
    const path = join(p.hot, f);
    let st: { mtimeMs: number };
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const age = now - st.mtimeMs;
    if (!(age > retain)) {
      liveHotKept += 1;
      continue;
    }
    const id = f.replace(/\.jsonl$/, "");
    newWarm.push(compactHotFile(path, id, st.mtimeMs));
    rmQuiet(path);
    const base = f.replace(/\.jsonl$/, "");
    rmQuiet(join(p.hot, `${base}.lock`));
    rmQuiet(join(p.hot, `${base}.cursor`));
    hotToWarm += 1;
  }

  const existingWarm: WarmReceipt[] = [];
  for (const raw of readJsonl(p.warmFile)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string") continue;
    existingWarm.push({
      id: row.id,
      tokenClasses: asClasses(row.tokenClasses),
      agentId: strField(row, "agentId"),
      parentRunId: strField(row, "parentRunId"),
      fleetId: strField(row, "fleetId"),
      region: strField(row, "region"),
      at: typeof row.at === "number" && Number.isFinite(row.at) ? row.at : now,
    });
  }

  const keepWarm: WarmReceipt[] = [];
  const coldAgg = new Map<string, ColdMonth>();
  const bumpCold = (receipt: WarmReceipt) => {
    const month = monthKey(receipt.at);
    let row = coldAgg.get(month);
    if (!row) {
      const existing = join(p.cold, `${month}.jsonl`);
      row = existsSync(existing) ? coldFromFile(existing, month) : {
        month,
        runs: 0,
        classes: emptyTokenClasses(),
        billed: 0,
        dcShare: 0,
      };
      coldAgg.set(month, row);
    }
    row.runs += 1;
    addClasses(row.classes, receipt.tokenClasses);
    row.billed = billedTokens(row.classes);
    row.dcShare = archiveDcShare(row.classes);
  };

  let warmToCold = 0;
  for (const r of [...existingWarm, ...newWarm]) {
    if (now - r.at > warmHorizon) {
      bumpCold(r);
      warmToCold += 1;
    } else {
      keepWarm.push(r);
    }
  }

  const warmBody = keepWarm.map((r) => JSON.stringify(r)).join("\n");
  writeFileAtomic(p.warmFile, warmBody ? warmBody + "\n" : "");

  for (const row of coldAgg.values()) {
    writeCold(join(p.cold, `${row.month}.jsonl`), row);
  }

  let coldDropped = 0;
  const keepMonths = coldMonths();
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - keepMonths);
  const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}`;
  for (const f of listJsonl(p.cold)) {
    const month = f.replace(/\.jsonl$/, "");
    if (month < cutoffKey) {
      rmQuiet(join(p.cold, f));
      coldDropped += 1;
    }
  }

  return { ok: true, hotToWarm, warmToCold, coldDropped, liveHotKept };
}

export function archiveHelp(): string {
  return `eden archive — hot / warm / cold retention tiers

  eden archive status    Counts per tier a person can read
  eden archive compact   Move eligible hot → warm → cold

hot:   ~/.eden/runs (EDEN_RETAIN_DAYS, default 14)
warm:  compacted receipts, no events (EDEN_WARM_DAYS, default 90)
cold:  monthly DC+counts (EDEN_COLD_MONTHS, default 24)

Compact never deletes a live hot file younger than the retain window.
Archive is CLI-only — a bug here never sits on the wrap path.
`;
}

/**
 * CLI entry. Returns an exit code. Never throws into wrap.
 */
export async function archiveCli(args: string[]): Promise<number> {
  try {
    const sub = args[0];
    if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
      console.log(archiveHelp());
      return 0;
    }
    if (sub === "status") {
      console.log(formatArchiveStatus());
      return 0;
    }
    if (sub === "compact") {
      const r = compactArchive();
      if (!r.ok) {
        console.error(`archive compact · ${r.error ?? "failed"}`);
        return 1;
      }
      console.log(
        `archive compact · hot→warm ${r.hotToWarm} · warm→cold ${r.warmToCold} · live kept ${r.liveHotKept}` +
          (r.coldDropped ? ` · cold dropped ${r.coldDropped}` : ""),
      );
      return 0;
    }
    console.error(archiveHelp());
    return 1;
  } catch (err) {
    console.error(`archive · ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

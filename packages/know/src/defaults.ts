/** CLI `run` flags and `tick()` fallbacks. Keep these in one place. */

export function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const DEFAULT_INTERVAL_SEC = 20;
export const DEFAULT_CC = 120;
export const DEFAULT_LIVE = 96;
export const DEFAULT_NEWS = 16;
/** CDX Range hits per tick (cheap RAM vs a full WET). */
export const DEFAULT_CDX = 8;
export const DEFAULT_WIKI = 100;
export const DEFAULT_WIKI_GROW = 80;
export const DEFAULT_RECRAWL = 48;
export const DEFAULT_QUALITY = 16;
/** Compact-publish when WAL is at least this and the last upload is old enough. */
export const COMPACT_WAL_MIN = 64;
export const DEFAULT_COMPACT_MS = 900_000;
/** Run a full WET gunzip every N ticks when the last slice kept nothing. */
export const DEFAULT_WET_EVERY = 3;

export function shardIndex(): number {
  return envNum("EDEN_KNOW_SHARD", 0);
}

export function shardCount(): number {
  return Math.max(1, envNum("EDEN_KNOW_SHARDS", 1) | 0);
}

/** Hash-partition a URL so N ingest boxes do not fetch the same page. */
export function shardOwns(url: string, i = shardIndex(), n = shardCount()): boolean {
  if (n <= 1) return true;
  const shard = ((i % n) + n) % n;
  let h = 2166136261;
  for (let k = 0; k < url.length; k++) {
    h ^= url.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n === shard;
}

/** True when ingest should rewrite and upload the single `graph.kpk`. */
export function compactDue(wal: number, lastMs: number, now = Date.now()): boolean {
  if (wal < COMPACT_WAL_MIN) return false;
  if (!lastMs) return true;
  return now - lastMs >= envNum("EDEN_KNOW_COMPACT_MS", DEFAULT_COMPACT_MS);
}
/** Consecutive latest-crawl WET files per tick (worker sets 2). */
export const DEFAULT_CC_SLICES = 1;
/** Parallel live fetches per tick (sqlite writes stay serial). */
export const LIVE_CONCURRENCY = envNum("EDEN_KNOW_LIVE_CONC", 64);
/** Cap concurrent fetches to one origin so RFC 9309 crawl-delay still means something. */
export const LIVE_PER_HOST = 3;
/** Skip catalog re-fetch when last success is newer than this. */
export const CATALOG_REFRESH_MS = 6 * 3600_000;
/** WET records scanned per kept record (was 8). */
export const WET_SCAN_MULT = 40;

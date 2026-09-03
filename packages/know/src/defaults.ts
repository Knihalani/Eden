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

import { createHash } from "node:crypto";
import type { EdenDb } from "./db";
import type { CompiledStep } from "@eden/core";
import { isMutatingMethod, observeCacheKey, recordAdmissionDecision, resetCacheAdmission as resetAdmitSketch, shouldAdmitWrite } from "./cache-admit";
import { packCacheBody, unpackCacheBody } from "./cache-compress";

export {
  ADMISSION_WINDOW_CAP,
  admissionStats,
  isMutatingMethod,
  observeCacheKey,
  shouldAdmitWrite,
} from "./cache-admit";
export {
  COMPRESS_MIN_BYTES,
  ENVELOPE_REV,
  GUNZIP_MAX_BYTES,
  LEGACY_ENVELOPE_REV,
  packCacheBody,
  unpackCacheBody,
} from "./cache-compress";

/**
 * Exact-result cache shared by playback and speculative prefetch.
 *
 * Key = canonical content hash of (workspace_id, tool identity, step identity,
 * resolved URL, resolved bind args). Equal hash ⇒ equal value by construction:
 * every input that can change the response is folded into the hashed payload,
 * and the payload is canonicalized (object keys sorted) before hashing, so key
 * order or whitespace can never produce two keys for one value. This mirrors
 * `canonicalize` in packages/ir/src/eq.ts — which apps/site cannot import
 * (it only links @eden/core) — for the JSON-safe value shapes used here.
 *
 * The workspace id is part of every key. Two tenants hitting the same public
 * API produce identical step shapes, so a workspace-less key would let one
 * tenant's cached body answer another tenant's call — a silent cross-tenant
 * leak wearing a cache-hit costume.
 */

export const RESULT_CACHE_TTL_MS = 30 * 60_000;

/**
 * Decoded hot set. gzip is a durability/size choice (SQLite TEXT); the hit
 * path serves the JS value already in hand from the fill, the way a RAM
 * cache would. Gunzip is paid on a hot-set miss (restart, eviction), not on
 * every hit — that is how the read-latency tax stays under the §10 budget
 * without giving up −30% stored size.
 */
const HOT_DECODED_CAP = 256;
type HotRow = { entry: CacheEntry; expiresAt: number };
const hotDecoded = new Map<string, HotRow>();

function rememberHot(key: string, entry: CacheEntry, expiresAt: number): void {
  if (hotDecoded.has(key)) hotDecoded.delete(key);
  hotDecoded.set(key, { entry, expiresAt });
  while (hotDecoded.size > HOT_DECODED_CAP) {
    const oldest = hotDecoded.keys().next().value;
    if (oldest === undefined) break;
    hotDecoded.delete(oldest);
  }
}

function takeHot(key: string): CacheEntry | undefined {
  const row = hotDecoded.get(key);
  if (!row) return undefined;
  if (row.expiresAt <= Date.now()) {
    hotDecoded.delete(key);
    return undefined;
  }
  hotDecoded.delete(key);
  hotDecoded.set(key, row);
  return row.entry;
}

function forgetHot(key: string): void {
  hotDecoded.delete(key);
}

const inflight = new Map<string, Promise<unknown>>();

export function resetCacheAdmission(): void {
  resetAdmitSketch();
  hotDecoded.clear();
}

/** Deterministic JSON: sorted object keys, arrays kept in order, no whitespace. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

export type ResultCacheIdentity = {
  workspaceId: string;
  toolId: string;
  step: Pick<CompiledStep, "id" | "name" | "method">;
  /** Fully resolved (templates expanded) request URL. */
  url: string;
  /** Resolved bind arguments, when known — folded in for identity completeness. */
  bound?: Record<string, string>;
};

export function resultCacheKey(identity: ResultCacheIdentity): string {
  const canon = stableStringify({
    v: 1,
    ws: identity.workspaceId,
    tool: identity.toolId,
    step: identity.step.id,
    name: identity.step.name ?? "",
    method: identity.step.method || "GET",
    url: identity.url,
    bound: identity.bound ?? {},
  });
  return `rc:${createHash("sha256").update(canon).digest("hex")}`;
}

/**
 * Public-pool key: identical to the tenant key minus the workspace. Only
 * responses fetched WITHOUT credentials may land here (see playback's
 * credential-free check) — two tenants hitting the same unauthenticated
 * public endpoint receive byte-identical bodies, so sharing them costs one
 * upstream request instead of W. Private calls never touch this namespace.
 */
export function publicResultKey(identity: Omit<ResultCacheIdentity, "workspaceId">): string {
  const canon = stableStringify({
    v: 1,
    pool: "public",
    tool: identity.toolId,
    step: identity.step.id,
    name: identity.step.name ?? "",
    method: identity.step.method || "GET",
    url: identity.url,
    bound: identity.bound ?? {},
  });
  return `rcp:${createHash("sha256").update(canon).digest("hex")}`;
}

export type CacheEntry = { value: unknown; etag?: string };

export type WriteResultOpts = {
  /** HTTP method of the step that produced this value. Non-GET is never stored. */
  method?: string;
  /** Skip admission (TTL refresh / 304 revalidation of an already-admitted row). */
  force?: boolean;
  /** Partitions the admission window; omitted keys share one bucket. */
  workspaceId?: string;
};

/**
 * Hit-rate fields for a receipt. Zero lookups → omit (never a fake 0% that
 * looks like a failure on a run that never consulted the cache).
 */
export function cacheHitRateFields(
  hits: number,
  lookups: number,
): { cache_lookups: number; cache_hit_rate: number } | Record<string, never> {
  if (!(lookups > 0)) return {};
  return { cache_lookups: lookups, cache_hit_rate: hits / lookups };
}

/**
 * A corrupt cached body (older writer, truncated write) is a miss, not a
 * crash: callers fall through to a live fetch and overwrite below.
 */
export async function readResult<T = unknown>(db: EdenDb, key: string): Promise<T | undefined> {
  const entry = await readEntry(db, key);
  return entry === undefined ? undefined : (entry.value as T);
}

/** Fresh-only entry read (envelope-aware). */
export async function readEntry(db: EdenDb, key: string): Promise<CacheEntry | undefined> {
  try {
    const mem = takeHot(key);
    if (mem) {
      observeCacheKey(key);
      return mem;
    }
    const hit = await db.get<{ body: string; expires_at: number }>(
      `SELECT body, expires_at FROM result_cache WHERE cache_key = ?`,
      [key],
    );
    if (!hit || hit.expires_at <= Date.now()) return undefined;
    const entry = unpackCacheBody(hit.body);
    if (!entry) return undefined;
    observeCacheKey(key);
    rememberHot(key, entry, hit.expires_at);
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * Entry of ANY age, with its expiry — the revalidation path. An expired
 * entry is not garbage while its ETag lives: one If-None-Match round trip
 * either proves it current (a ~free hit) or the upstream returns fresher
 * bytes. Entries without an etag are worthless once expired.
 */
export async function readStaleEntry(
  db: EdenDb,
  key: string,
): Promise<(CacheEntry & { expiresAt: number }) | undefined> {
  try {
    const hit = await db.get<{ body: string; expires_at: number }>(
      `SELECT body, expires_at FROM result_cache WHERE cache_key = ?`,
      [key],
    );
    if (!hit) return undefined;
    const entry = unpackCacheBody(hit.body);
    if (!entry) return undefined;
    // Without a validator, expiry means worthless; with one, revalidation
    // can still prove the entry current.
    if (!entry.etag && hit.expires_at <= Date.now()) return undefined;
    return { ...entry, expiresAt: hit.expires_at };
  } catch {
    return undefined;
  }
}

export async function writeResult(
  db: EdenDb,
  key: string,
  value: unknown,
  ttlMs: number = RESULT_CACHE_TTL_MS,
  etag?: string,
  opts?: WriteResultOpts,
): Promise<void> {
  try {
    // Frequency is not an excuse to cache a mutation. Method omitted (tests
    // writing synthetic keys) is allowed through; playback always passes one.
    if (isMutatingMethod(opts?.method)) return;
    if (opts?.method !== undefined && opts.method.toUpperCase() !== "GET") return;
    if (!opts?.force && !shouldAdmitWrite(key, opts?.workspaceId)) {
      recordAdmissionDecision(false);
      return;
    }
    await db.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
      key,
      packCacheBody(value, etag),
      Date.now() + ttlMs,
    ]);
    recordAdmissionDecision(true);
    rememberHot(key, { value, ...(etag !== undefined ? { etag } : {}) }, Date.now() + ttlMs);
    // Expired rows are never read again but were never deleted, so the table
    // grew without bound on long-lived installs. Sampled sweep keeps the hot
    // path clean while still converging.
    if (Math.random() < 0.02) {
      void db.run(`DELETE FROM result_cache WHERE expires_at < ?`, [Date.now() - ttlMs]).catch(() => undefined);
    }
  } catch {
    /* a cache write must never break the path it serves */
  }
}

/**
 * On-demand invalidation: drop one exact-result key from SQLite and the
 * decoded hot set. A missing key is a no-op (returns false), never a throw —
 * the next read is a miss either way. Does not scan, does not wipe, and never
 * writes a replacement row. Callers that know a public GET identity also drop
 * the matching `rcp:` key themselves; this function only touches the named
 * key, so one tenant's webhook cannot evict another tenant's private `rc:`.
 */
export async function dropResult(db: EdenDb, key: string): Promise<boolean> {
  if (!key) return false;
  try {
    forgetHot(key);
    inflight.delete(key);
    const hit = await db.get<{ cache_key: string }>(`SELECT cache_key FROM result_cache WHERE cache_key = ?`, [key]);
    if (!hit) return false;
    await db.run(`DELETE FROM result_cache WHERE cache_key = ?`, [key]);
    return true;
  } catch {
    forgetHot(key);
    inflight.delete(key);
    return false;
  }
}

/**
 * Single-flight dedupe over one cache key.
 *
 * Speculative prefetch and the ordinary hot path both resolve to the same key;
 * without this, a prefetch that loses the race against its own wave would
 * double-fetch the resource. The first caller runs the loader, everyone else
 * with the same key rides along. Entries are removed on settle, so a rejected
 * load is never sticky — the next caller simply fetches fresh.
 */
export function singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const prev = inflight.get(key);
  if (prev) return prev as Promise<T>;
  const p = load().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/**
 * Join an already-in-flight load without starting one. Rejection maps to
 * undefined — a miss the caller falls through from — because a failed
 * speculative load may never surface into the response path at all.
 */
export async function joinInflight<T>(key: string): Promise<T | undefined> {
  const p = inflight.get(key);
  if (!p) return undefined;
  try {
    return (await p) as T;
  } catch {
    return undefined;
  }
}

/**
 * Prefetch bookkeeping. Fire-and-forget by contract: trackPrefetch owns the
 * rejection (swallow + count), so a broken speculative load can never reject
 * into an unobserved context or affect a run's outcome. drainPrefetches()
 * exists for tests — production code never awaits it.
 */
export const prefetchCounters = { started: 0, errors: 0 };

const pending = new Set<Promise<void>>();

export function resetPrefetchCounters(): void {
  prefetchCounters.started = 0;
  prefetchCounters.errors = 0;
}

export function trackPrefetch(run: () => Promise<unknown>): void {
  prefetchCounters.started++;
  const settled = run().then(
    () => undefined,
    () => {
      prefetchCounters.errors++;
    },
  );
  pending.add(settled);
  void settled.finally(() => {
    pending.delete(settled);
  });
}

export async function drainPrefetches(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

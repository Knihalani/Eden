import { createHash } from "node:crypto";
import type { EdenDb } from "./db";
import type { CompiledStep } from "@eden/core";

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

/**
 * Storage envelope. When an entry carries an upstream validator (ETag), it is
 * stored as {"__eden_cache":2,"etag","v"}; readers without an etag get the
 * plain body exactly as before, so pre-envelope rows stay readable and
 * etag-less writers keep writing legacy-shaped bodies.
 */
type Envelope = { __eden_cache: 2; etag?: string; v: unknown };

function packBody(value: unknown, etag?: string): string {
  return etag === undefined ? JSON.stringify(value) : JSON.stringify({ __eden_cache: 2 as const, etag, v: value });
}

function unpackBody(body: string): CacheEntry | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Envelope).__eden_cache === 2
    ) {
      const env = parsed as Envelope;
      return { value: env.v, ...(env.etag !== undefined ? { etag: env.etag } : {}) };
    }
    return { value: parsed };
  } catch {
    return undefined;
  }
}

export type CacheEntry = { value: unknown; etag?: string };

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
    const hit = await db.get<{ body: string; expires_at: number }>(
      `SELECT body, expires_at FROM result_cache WHERE cache_key = ?`,
      [key],
    );
    if (!hit || hit.expires_at <= Date.now()) return undefined;
    return unpackBody(hit.body);
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
    const entry = unpackBody(hit.body);
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
): Promise<void> {
  try {
    await db.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
      key,
      packBody(value, etag),
      Date.now() + ttlMs,
    ]);
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
 * Single-flight dedupe over one cache key.
 *
 * Speculative prefetch and the ordinary hot path both resolve to the same key;
 * without this, a prefetch that loses the race against its own wave would
 * double-fetch the resource. The first caller runs the loader, everyone else
 * with the same key rides along. Entries are removed on settle, so a rejected
 * load is never sticky — the next caller simply fetches fresh.
 */
const inflight = new Map<string, Promise<unknown>>();

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

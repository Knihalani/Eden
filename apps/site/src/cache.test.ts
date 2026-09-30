import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { playTool } from "./playback";
import { handleForge } from "./forge";
import {
  COMPRESS_MIN_BYTES,
  ENVELOPE_REV,
  LEGACY_ENVELOPE_REV,
  cacheHitRateFields,
  publicResultKey,
  readStaleEntry,
  drainPrefetches,
  dropResult,
  joinInflight,
  packCacheBody,
  prefetchCounters,
  readResult,
  resetCacheAdmission,
  resetPrefetchCounters,
  resultCacheKey,
  singleFlight,
  stableStringify,
  unpackCacheBody,
  writeResult,
} from "./cache";
import type { CompiledStep } from "@eden/core";

const step = (over: Partial<CompiledStep> & { id: string }): CompiledStep => ({
  kind: "cloud_http",
  name: over.id,
  url: `https://x.test/forge/1/comments`,
  commute: false,
  ...over,
});

describe("speculative read prefetch", () => {
  const dbP = openDb(`/tmp/eden-prefetch-${Date.now()}.db`);
  const ws = "ws_prefetch";

  resetCacheAdmission();

  async function insertTool(db: Awaited<typeof dbP>, id: string, steps: CompiledStep[]) {
    await db.run(
      `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES (?, ?, ?, '', 'on', ?, '[]')`,
      [id, ws, id, JSON.stringify(steps)],
    );
    return { id, name: id, steps: JSON.stringify(steps), workspace_id: ws };
  }

  test("next-layer read-only steps get prefetched and later hit the cache", async () => {
    const db = await dbP;
    // w2 is a GET behind a mutating wave-1 POST: the DAG puts it alone in wave
    // two (commute:false chains it after w1), so playOne kicks its prefetch the
    // moment wave one lands.
    const tool = await insertTool(db, "t_prefetch_hit", [
      step({ id: "w1", method: "POST", url: "https://x.test/shop/1/orders" }),
      step({ id: "w2", method: "GET", url: "https://x.test/forge/7/comments" }),
    ]);
    resetPrefetchCounters();
    const knownKeys = new Set((await db.all<{ cache_key: string }>(`SELECT cache_key FROM result_cache`)).map((r) => r.cache_key));
    const receipt = await playTool(db, tool, {});
    await drainPrefetches();

    expect(receipt.ok).toBe(true);
    // Hit-rate is a first-class meter on the first instrumented run, not only
    // a cache_hits count. This run has a GET so lookups > 0; the rate is real
    // (may be 0 if prefetch lost the race).
    expect(receipt.cache_lookups).toBeGreaterThan(0);
    expect(typeof receipt.cache_hit_rate).toBe("number");
    expect(receipt.cache_hit_rate).toBe(receipt.cache_hits / receipt.cache_lookups!);
    // Exactly one speculative load was kicked: the read-only next layer.
    expect(prefetchCounters.started).toBe(1);
    expect(prefetchCounters.errors).toBe(0);
    // The prefetched GET landed in result_cache under a hashed tenant-scoped key.
    const fresh = (await db.all<{ cache_key: string; body: string }>(`SELECT cache_key, body FROM result_cache`)).filter(
      (r) => !knownKeys.has(r.cache_key),
    );
    expect(fresh.length).toBe(1);
    expect(fresh[0]!.cache_key.startsWith("rc:")).toBe(true);
    const expectedBody = await handleForge(new URL("https://x.test/forge/7/comments"))!.json();
    const stored = unpackCacheBody(fresh[0]!.body);
    expect(stored?.value).toEqual(expectedBody);
    // comments payload is >2KB JSON-ish — must land gzip+base64 in the one
    // envelope revision, not a second wrapper and not raw JSON.
    const env = JSON.parse(fresh[0]!.body) as { __eden_cache?: number; z?: string };
    expect(env.__eden_cache).toBe(ENVELOPE_REV);
    expect(typeof env.z).toBe("string");

    // Second run: prefetch finds the entry already warm and starts nothing;
    // the wave-2 step answers from the cache and counts as a hit.
    const before = prefetchCounters.started;
    const again = await playTool(db, tool, {});
    await drainPrefetches();
    expect(prefetchCounters.started).toBe(before);
    expect(again.cache_hits).toBe(1);
    expect(again.cache_lookups).toBeGreaterThan(0);
    expect(again.cache_hit_rate).toBeCloseTo(again.cache_hits / again.cache_lookups!, 6);
    expect(again.ok).toBe(true);
  });

  test("mutating next layer is never prefetched", async () => {
    const db = await dbP;
    const tool = await insertTool(db, "t_prefetch_mutating", [
      step({ id: "w1", method: "POST", url: "https://x.test/shop/2/orders" }),
      step({ id: "w2", method: "POST", url: "https://x.test/shop/2/customers/9/orders" }),
    ]);
    resetPrefetchCounters();
    const beforeMut = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);
    const receipt = await playTool(db, tool, {});
    await drainPrefetches();
    expect(receipt.ok).toBe(true);
    expect(prefetchCounters.started).toBe(0);
    expect(prefetchCounters.errors).toBe(0);
    // Neither POST may appear in an exact-result cache.
    const afterMut = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);
    expect(afterMut?.c ?? 0).toBe(beforeMut?.c ?? 0);
    // A mutating-only run never consulted the cache — no fake 0% hit-rate.
    expect(receipt.cache_lookups).toBeUndefined();
    expect(receipt.cache_hit_rate).toBeUndefined();
  });

  test("prefetch failure is swallowed and counted, run outcome untouched", async () => {
    const db = await dbP;
    // Wave two is a read-only GET at an address that always fails; the
    // speculative load must reject into trackPrefetch, never into the run.
    const tool = await insertTool(db, "t_prefetch_fail", [
      step({ id: "w1", method: "GET", url: "https://x.test/forge/3/comments" }),
      step({ id: "w2", method: "GET", url: "http://127.0.0.1:1/unreachable" }),
    ]);
    resetPrefetchCounters();
    const receipt = await playTool(db, tool, {}); // must not throw
    await drainPrefetches(); // must not throw
    expect(receipt.steps_attempted).toBe(2);
    expect(prefetchCounters.started).toBeGreaterThanOrEqual(1);
    expect(prefetchCounters.errors).toBeGreaterThanOrEqual(1);
  });

  test("TTL expiry and corrupt bodies are misses, fresh entries are hits", async () => {
    const db = await dbP;
    const key = "rc:ttl-check";
    await writeResult(db, key, { v: "fresh" });
    expect(await readResult<{ v: string }>(db, key)).toEqual({ v: "fresh" });
    await writeResult(db, key, { v: "stale" }, -1000);
    expect(await readResult(db, key)).toBeUndefined();

    await db.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
      "rc:corrupt",
      "{not json",
      Date.now() + 60_000,
    ]);
    expect(await readResult(db, "rc:corrupt")).toBeUndefined();
  });

  test("keys are canonical, collision-proof by construction, and tenant-isolated", () => {
    const base = {
      workspaceId: "ws_a",
      toolId: "t1",
      step: { id: "s1", name: "s1", method: "GET" },
      url: "https://x.test/a",
      bound: {},
    };
    const k = resultCacheKey(base);
    // Canonical: key order in resolved bind args cannot change the hash.
    expect(
      resultCacheKey({ ...base, bound: { a: "1", b: "2" } }),
    ).toBe(resultCacheKey({ ...base, bound: { b: "2", a: "1" } }));
    // Any identity-bearing difference produces a different key.
    expect(resultCacheKey({ ...base, workspaceId: "ws_b" })).not.toBe(k);
    expect(resultCacheKey({ ...base, url: "https://x.test/b" })).not.toBe(k);
    expect(resultCacheKey({ ...base, step: { id: "s1", name: "s1", method: "POST" } })).not.toBe(k);
    expect(stableStringify({ b: 2, a: [1, { c: null }] })).toBe('{"a":[1,{"c":null}],"b":2}');
  });

  test("tenant isolation end to end: one workspace's cached body cannot answer another's call", async () => {
    const db = await dbP;
    const stepsA = [step({ id: "r1", kind: "cloud_http", name: "r1", method: "GET", url: "https://x.test/forge/9/comments" })];
    await db.run(
      `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES ('t_iso', 'ws_iso_A', 't_iso', '', 'on', ?, '[]')`,
      [JSON.stringify(stepsA)],
    );
    const toolA = { id: "t_iso", name: "t_iso", steps: JSON.stringify(stepsA), workspace_id: "ws_iso_A" };
    const first = await playTool(db, toolA, {});
    await drainPrefetches();
    expect(first.ok).toBe(true);

    // Same tool id, same steps, different workspace: the key differs, so this
    // run cannot read ws_iso_A's row — it fetches and caches its own.
    const cachedRowsBefore = await db.all<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);
    const toolB = { ...toolA, workspace_id: "ws_iso_B" };
    const second = await playTool(db, toolB, {});
    expect(second.cache_hits).toBe(0);
    const cachedRowsAfter = await db.all<{ c: number }>(
      `SELECT COUNT(*) as c FROM result_cache WHERE cache_key LIKE 'rc:%'`,
    );
    expect((cachedRowsAfter[0]?.c ?? 0)).toBeGreaterThan(cachedRowsBefore[0]?.c ?? 0);
  });

  test("singleFlight dedupes concurrent loads and never sticks on rejection", async () => {
    let runs = 0;
    const p1 = singleFlight("sf:1", async () => {
      runs++;
      throw new Error("boom");
    });
    await expect(p1).rejects.toBeInstanceOf(Error); // first caller sees the failure
    expect(await joinInflight("sf:1")).toBeUndefined(); // rejected load is a miss, not sticky
    expect(await singleFlight("sf:1", async () => ((runs++, "fresh")))).toBe("fresh");
    expect(runs).toBe(2);

    // Hold the winner open with a deferred so the rider joins the same
    // inflight promise — no wall sleep used as synchronization.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let concurrent = 0;
    const winner = singleFlight("sf:2", async () => {
      concurrent++;
      await gate;
      return "shared";
    });
    const rider = singleFlight("sf:2", async () => {
      concurrent++;
      return "other";
    });
    release();
    expect(await rider).toBe("shared");
    expect(await winner).toBe("shared");
    expect(concurrent).toBe(1);
  });

  afterAll(async () => {
    /* file db */
  });
});

describe("public pool + etag envelopes", () => {
  const dbP = openDb(`/tmp/eden-cache-env-${Date.now()}.db`);
  const db = () => dbP;
  resetCacheAdmission();

  test("public keys differ from tenant keys and ignore the workspace", () => {
    const base = { toolId: "t1", step: step({ id: "s0" }), url: "https://api.github.com/x" };
    const a = publicResultKey(base);
    const b = publicResultKey(base);
    expect(a).toBe(b); // workspace-less identity is the point
    expect(a.startsWith("rcp:")).toBe(true);
    const tenant = resultCacheKey({ ...base, workspaceId: "ws1" });
    expect(tenant).not.toBe(a);
  });

  test("etag envelope round-trips; legacy plain rows stay readable", async () => {
    const d = await db();
    await writeResult(d, "k-env", { hello: "world" }, 60_000, '"abc"');
    const entry = await readStaleEntry(d, "k-env");
    expect(entry?.etag).toBe('"abc"');
    expect(entry?.value).toEqual({ hello: "world" });
    // legacy row (no envelope) written directly
    await d.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES ('k-legacy', '{"plain":1}', ?)`, [
      Date.now() + 60_000,
    ]);
    expect(await readResult<Record<string, unknown>>(d, "k-legacy")).toEqual({ plain: 1 });
    const stale = await readStaleEntry(d, "k-legacy");
    expect(stale?.value).toEqual({ plain: 1 });
    expect(stale?.etag).toBeUndefined();
  });

  test("expired entries without an etag are worthless; with one they survive for revalidation", async () => {
    // Suppress writeResult's sampled sweep for the duration: these rows are
    // written already-expired, and a sweep fired by one of THIS test's own
    // writes (its cutoff derives from that write's ttl) deletes them before
    // the assertions run — a ~2%/write race that eventually fails the suite.
    const realRandom = Math.random;
    Math.random = () => 0.99;
    try {
      const d = await db();
      await writeResult(d, "k-old", { a: 1 }, -1_000); // already expired, no etag
      expect(await readStaleEntry(d, "k-old")).toBeUndefined();
      await writeResult(d, "k-tagged", { b: 2 }, -1_000, '"e1"');
      const entry = await readStaleEntry(d, "k-tagged");
      expect(entry?.etag).toBe('"e1"');
      expect(entry?.value).toEqual({ b: 2 });
    } finally {
      Math.random = realRandom;
    }
  });
});

function jsonishBody(minBytes: number): unknown {
  const row = {
    id: 0,
    user: { login: "alice", type: "User" },
    body: "the lockfile drifted and the deploy pipeline failed; pin and rerun. ",
    labels: ["bug", "deploy", "ci"],
  };
  const rows: typeof row[] = [];
  const one = JSON.stringify({ ...row, body: row.body.repeat(8) });
  const n = Math.max(1, Math.ceil(minBytes / one.length) + 1);
  for (let i = 0; i < n; i++) rows.push({ ...row, id: i, body: row.body.repeat(8) });
  return rows;
}

describe("envelope v3: etag + gzip, legacy v2 still unpacks", () => {
  const dbP = openDb(`/tmp/eden-cache-v3-${Date.now()}.db`);
  resetCacheAdmission();

  test("bodies >2KB store gzip+base64 and unpack to the original value", async () => {
    const d = await dbP;
    const value = jsonishBody(COMPRESS_MIN_BYTES + 512);
    const raw = JSON.stringify(value);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(COMPRESS_MIN_BYTES);
    await writeResult(d, "k-gz", value, 60_000, '"etag-gz"');
    const row = await d.get<{ body: string }>(`SELECT body FROM result_cache WHERE cache_key = ?`, ["k-gz"]);
    expect(row).toBeDefined();
    const env = JSON.parse(row!.body) as { __eden_cache: number; etag?: string; z?: string; v?: unknown };
    expect(env.__eden_cache).toBe(ENVELOPE_REV);
    expect(env.etag).toBe('"etag-gz"');
    expect(typeof env.z).toBe("string");
    expect(env.v).toBeUndefined();
    expect(row!.body.length).toBeLessThan(raw.length * 0.7);
    // Drop the decoded hot set so this read is forced through SQL + gunzip.
    resetCacheAdmission();
    expect(await readResult<unknown>(d, "k-gz")).toEqual(value);
    const stale = await readStaleEntry(d, "k-gz");
    expect(stale?.etag).toBe('"etag-gz"');
    expect(stale?.value).toEqual(value);
  });

  test("small bodies stay JSON; etag-only uses the same v3 revision", async () => {
    const d = await dbP;
    await writeResult(d, "k-small", { hello: "world" });
    const plain = await d.get<{ body: string }>(`SELECT body FROM result_cache WHERE cache_key = ?`, ["k-small"]);
    expect(plain?.body).toBe('{"hello":"world"}');
    await writeResult(d, "k-small-etag", { hello: "world" }, 60_000, '"e"');
    const tagged = await d.get<{ body: string }>(`SELECT body FROM result_cache WHERE cache_key = ?`, ["k-small-etag"]);
    const env = JSON.parse(tagged!.body) as { __eden_cache: number; etag?: string; z?: string; v?: unknown };
    expect(env.__eden_cache).toBe(ENVELOPE_REV);
    expect(env.etag).toBe('"e"');
    expect(env.z).toBeUndefined();
    expect(env.v).toEqual({ hello: "world" });
  });

  test("legacy __eden_cache: 2 rows still unpack (etag and value)", async () => {
    const d = await dbP;
    const v2 = JSON.stringify({ __eden_cache: LEGACY_ENVELOPE_REV, etag: '"old"', v: { legacy: true, n: 2 } });
    await d.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
      "k-v2",
      v2,
      Date.now() + 60_000,
    ]);
    const entry = await readStaleEntry(d, "k-v2");
    expect(entry?.etag).toBe('"old"');
    expect(entry?.value).toEqual({ legacy: true, n: 2 });
    expect(await readResult<{ legacy: boolean; n: number }>(d, "k-v2")).toEqual({ legacy: true, n: 2 });
    // pack/unpack helpers agree with the live path.
    expect(unpackCacheBody(v2)).toEqual({ value: { legacy: true, n: 2 }, etag: '"old"' });
  });

  test("packCacheBody of a large value with etag carries both in one revision", () => {
    const value = jsonishBody(COMPRESS_MIN_BYTES + 100);
    const packed = packCacheBody(value, '"both"');
    const env = JSON.parse(packed) as { __eden_cache: number; etag?: string; z?: string };
    expect(env.__eden_cache).toBe(ENVELOPE_REV);
    expect(env.etag).toBe('"both"');
    expect(typeof env.z).toBe("string");
    expect(unpackCacheBody(packed)).toEqual({ value, etag: '"both"' });
  });

  test("cacheHitRateFields omits on zero lookups and never fakes a rate", () => {
    expect(cacheHitRateFields(0, 0)).toEqual({});
    expect(cacheHitRateFields(3, 0)).toEqual({});
    expect(cacheHitRateFields(1, 4)).toEqual({ cache_lookups: 4, cache_hit_rate: 0.25 });
    expect(cacheHitRateFields(0, 2)).toEqual({ cache_lookups: 2, cache_hit_rate: 0 });
  });
});

describe("mutating methods never land in the exact-result cache", () => {
  const dbP = openDb(`/tmp/eden-cache-mut-${Date.now()}.db`);
  resetCacheAdmission();

  test("writeResult refuses POST/PUT/PATCH/DELETE even when identity includes method", async () => {
    const d = await dbP;
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"] as const) {
      const key = `rc:mut-${method}`;
      await writeResult(d, key, { sneaky: method }, 60_000, undefined, { method });
      expect(await readResult(d, key)).toBeUndefined();
      const row = await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache WHERE cache_key = ?`, [key]);
      expect(row?.c ?? 0).toBe(0);
    }
    // force must not override the mutating refuse
    await writeResult(d, "rc:mut-force", { x: 1 }, 60_000, undefined, { method: "POST", force: true });
    expect(await readResult(d, "rc:mut-force")).toBeUndefined();
  });

  test("PUT/PATCH/DELETE playback never writes result_cache rows", async () => {
    const d = await dbP;
    const ws = "ws_mut_methods";
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const id = `t_mut_${method}`;
      const steps = [
        step({
          id: "m1",
          method,
          url: `https://x.test/shop/1/orders`,
        }),
      ];
      await d.run(
        `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES (?, ?, ?, '', 'on', ?, '[]')`,
        [id, ws, id, JSON.stringify(steps)],
      );
      const before = await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);
      await playTool(d, { id, name: id, steps: JSON.stringify(steps), workspace_id: ws }, {});
      const after = await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);
      expect(after?.c ?? 0).toBe(before?.c ?? 0);
    }
  });
});

describe("dropResult: webhook invalidation", () => {
  const dbP = openDb(`/tmp/eden-cache-drop-${Date.now()}.db`);
  resetCacheAdmission();

  test("write GET → read hit → drop → read miss; missing key is ok; hot set evicts", async () => {
    const d = await dbP;
    const key = "rc:drop-hot";
    await writeResult(d, key, { v: "cached" }, 60_000, undefined, { method: "GET", force: true });
    expect(await readResult<{ v: string }>(d, key)).toEqual({ v: "cached" });

    expect(await dropResult(d, key)).toBe(true);
    expect(await readResult(d, key)).toBeUndefined();
    const gone = await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache WHERE cache_key = ?`, [key]);
    expect(gone?.c ?? 0).toBe(0);

    // Missing key: no throw, not a wipe of the rest of the table.
    const other = "rc:drop-keep";
    await writeResult(d, other, { keep: true }, 60_000, undefined, { method: "GET", force: true });
    expect(await dropResult(d, "rc:never-existed")).toBe(false);
    expect(await dropResult(d, "")).toBe(false);
    expect(await readResult<{ keep: boolean }>(d, other)).toEqual({ keep: true });
  });

  test("unrelated key is not dropped; public rcp: is a separate identity", async () => {
    const d = await dbP;
    const identity = {
      workspaceId: "ws_drop",
      toolId: "t_drop",
      step: { id: "s1", name: "s1", method: "GET" },
      url: "https://api.github.com/x",
    };
    const tenant = resultCacheKey(identity);
    const pub = publicResultKey(identity);
    const otherWs = resultCacheKey({ ...identity, workspaceId: "ws_other" });
    await writeResult(d, tenant, { tenant: 1 }, 60_000, undefined, { method: "GET", force: true });
    await writeResult(d, pub, { pub: 1 }, 60_000, undefined, { method: "GET", force: true });
    await writeResult(d, otherWs, { other: 1 }, 60_000, undefined, { method: "GET", force: true });

    expect(await dropResult(d, tenant)).toBe(true);
    expect(await readResult(d, tenant)).toBeUndefined();
    expect(await readResult<{ pub: number }>(d, pub)).toEqual({ pub: 1 });
    expect(await readResult<{ other: number }>(d, otherWs)).toEqual({ other: 1 });

    expect(await dropResult(d, pub)).toBe(true);
    expect(await readResult(d, pub)).toBeUndefined();
    expect(await readResult<{ other: number }>(d, otherWs)).toEqual({ other: 1 });
  });
});

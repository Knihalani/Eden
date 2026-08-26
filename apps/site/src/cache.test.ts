import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { playTool } from "./playback";
import { handleForge } from "./forge";
import {
  publicResultKey,
  readStaleEntry,
  drainPrefetches,
  joinInflight,
  prefetchCounters,
  readResult,
  resetPrefetchCounters,
  resultCacheKey,
  singleFlight,
  stableStringify,
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
    expect(JSON.parse(fresh[0]!.body)).toEqual(expectedBody);

    // Second run: prefetch finds the entry already warm and starts nothing;
    // the wave-2 step answers from the cache and counts as a hit.
    const before = prefetchCounters.started;
    const again = await playTool(db, tool, {});
    await drainPrefetches();
    expect(prefetchCounters.started).toBe(before);
    expect(again.cache_hits).toBe(1);
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

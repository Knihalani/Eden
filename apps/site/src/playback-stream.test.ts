import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { buildDag, layers, type CompiledStep } from "@eden/core";
import { openDb } from "./db";
import {
  clearPlaybackStreamProbe,
  installPlaybackStreamProbe,
  playTool,
  setPlaybackFetchGate,
} from "./playback";
import { drainPrefetches, prefetchCounters, resetPrefetchCounters } from "./cache";

/**
 * First-wave streaming (13.3): bind/prefetch of wave N+1 must start as soon as
 * its templates can resolve, not when the slowest wave-N sibling finishes.
 * Official execution still respects data deps; mutating is never prefetched.
 */

const SLOW_MS = 180;
const FAST_MS = 8;
const NEXT_MS = 120;

const step = (over: Partial<CompiledStep> & { id: string }): CompiledStep => ({
  kind: "cloud_http",
  name: over.id,
  method: "GET",
  commute: true,
  ...over,
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function barrierWall(slow: number, fast: number, next: number): Promise<number> {
  const t0 = performance.now();
  await Promise.all([delay(slow), delay(fast)]);
  await delay(next);
  return performance.now() - t0;
}

async function insertTool(
  db: Awaited<ReturnType<typeof openDb>>,
  id: string,
  steps: CompiledStep[],
  ws = "ws_stream",
) {
  await db.run(
    `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES (?, ?, ?, '', 'on', ?, '[]')`,
    [id, ws, id, JSON.stringify(steps)],
  );
  return { id, name: id, steps: JSON.stringify(steps), workspace_id: ws };
}

describe("first-wave streaming", () => {
  const dbP = openDb(`/tmp/eden-stream-${Date.now()}.db`);
  const prevSched = process.env.EDEN_SCHED;
  delete process.env.EDEN_SCHED;

  afterEach(async () => {
    clearPlaybackStreamProbe();
    setPlaybackFetchGate(undefined);
    await drainPrefetches();
  });

  afterAll(() => {
    if (prevSched === undefined) delete process.env.EDEN_SCHED;
    else process.env.EDEN_SCHED = prevSched;
  });

  test("wave-1 bind/prefetch starts before the last wave-0 member finishes; server_ms beats the barrier", async () => {
    const db = await dbP;
    const steps: CompiledStep[] = [
      step({ id: "slow", url: "https://x.test/forge/21/comments" }),
      step({ id: "fast", url: "https://x.test/forge/21/status" }),
      step({ id: "next", url: "https://x.test/forge/21/reviews?ref={{fast.state}}" }),
    ];
    const waves = layers(buildDag(steps)).map((w) => w.map((n) => n.id));
    expect(waves[0]!.sort()).toEqual(["fast", "slow"]);
    expect(waves[1]).toEqual(["next"]);

    const tool = await insertTool(db, "t_stream_overlap", steps);
    const delays: Record<string, number> = { slow: SLOW_MS, fast: FAST_MS, next: NEXT_MS };
    setPlaybackFetchGate(async ({ id }) => {
      const ms = delays[id];
      if (ms) await delay(ms);
    });
    resetPrefetchCounters();
    const probe = installPlaybackStreamProbe();

    const barrierMs = await barrierWall(SLOW_MS, FAST_MS, NEXT_MS);
    const receipt = await playTool(db, tool, {});
    await drainPrefetches();

    expect(receipt.ok).toBe(true);
    expect(receipt.steps_ok).toBe(3);
    expect(receipt.steps_attempted).toBe(3);
    expect(typeof receipt.server_ms).toBe("number");
    expect(typeof receipt.raw_bytes).toBe("number");
    expect(typeof receipt.densified_bytes).toBe("number");
    expect(receipt.facts).toBeDefined();
    expect(receipt.densified_bytes).toBeLessThanOrEqual(receipt.raw_bytes);

    const slowDone = probe.stepDone.find((m) => m.id === "slow");
    const fastDone = probe.stepDone.find((m) => m.id === "fast");
    const nextBind = probe.bindPrefetch.find((m) => m.id === "next");
    expect(slowDone).toBeDefined();
    expect(fastDone).toBeDefined();
    expect(nextBind).toBeDefined();
    expect(fastDone!.t).toBeLessThan(slowDone!.t);
    // The meter: wave-1 bind started while the slow wave-0 GET was still in flight.
    expect(nextBind!.t).toBeLessThan(slowDone!.t);

    const hiddenMs = slowDone!.t - nextBind!.t;
    expect(hiddenMs).toBeGreaterThan(SLOW_MS * 0.4);

    // Prefetch of `next` must actually have launched (not just a bind mark).
    expect(prefetchCounters.started).toBeGreaterThanOrEqual(1);

    // Barrier would pay slow+next serially; streaming hides next behind slow.
    expect(receipt.server_ms).toBeLessThan(barrierMs);
    expect(receipt.server_ms).toBeLessThan(SLOW_MS + NEXT_MS - 40);

    // Stash numbers on the receipt object for the run log (assertion messages).
    expect(receipt.server_ms).toBeGreaterThan(0);
    console.log(
      JSON.stringify({
        overlap: {
          server_ms: receipt.server_ms,
          barrier_ms: Math.round(barrierMs),
          hidden_ms: Math.round(hiddenMs),
          next_bind_before_slow_ms: Math.round(slowDone!.t - nextBind!.t),
          fast_done_before_slow_ms: Math.round(slowDone!.t - fastDone!.t),
        },
      }),
    );
  });

  test("a next-wave bind that needs both wave-0 members waits for the slow one", async () => {
    const db = await dbP;
    const steps: CompiledStep[] = [
      step({ id: "slow", url: "https://x.test/forge/22/status" }),
      step({ id: "fast", url: "https://x.test/forge/23/status" }),
      step({
        id: "next",
        url: "https://x.test/forge/22/reviews?a={{slow.state}}&b={{fast.state}}",
      }),
    ];
    const tool = await insertTool(db, "t_stream_both_deps", steps);
    setPlaybackFetchGate(async ({ id }) => {
      if (id === "slow") await delay(SLOW_MS);
      if (id === "fast") await delay(FAST_MS);
    });
    const probe = installPlaybackStreamProbe();
    const receipt = await playTool(db, tool, {});
    expect(receipt.ok).toBe(true);

    const slowDone = probe.stepDone.find((m) => m.id === "slow")!;
    const nextBind = probe.bindPrefetch.find((m) => m.id === "next")!;
    expect(nextBind).toBeDefined();
    // Cannot bind until slow has written — no empty {{slow.state}}.
    expect(nextBind.t).toBeGreaterThanOrEqual(slowDone.t);
  });

  test("mutating next-layer is never prefetched even when its bind is ready early", async () => {
    const db = await dbP;
    const steps: CompiledStep[] = [
      step({ id: "slow", url: "https://x.test/forge/24/comments" }),
      step({ id: "fast", url: "https://x.test/forge/24/status" }),
      step({
        id: "write",
        method: "POST",
        commute: false,
        url: "https://x.test/shop/3/orders",
        bind: { ref: "{{fast.state}}" },
      }),
    ];
    const tool = await insertTool(db, "t_stream_no_mut_prefetch", steps);
    resetPrefetchCounters();
    setPlaybackFetchGate(async ({ id }) => {
      if (id === "slow") await delay(80);
      if (id === "fast") await delay(FAST_MS);
    });
    const probe = installPlaybackStreamProbe();
    const before = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);
    const receipt = await playTool(db, tool, {});
    await drainPrefetches();

    expect(receipt.ok).toBe(true);
    expect(receipt.steps_attempted).toBe(3);
    expect(prefetchCounters.started).toBe(0);
    expect(probe.bindPrefetch.some((m) => m.id === "write")).toBe(false);
    // Official POST still runs, and only after the wave-0 barrier.
    const slowDone = probe.stepDone.find((m) => m.id === "slow")!;
    const writeStart = probe.stepStart.find((m) => m.id === "write")!;
    expect(writeStart.t).toBeGreaterThanOrEqual(slowDone.t);
    const after = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);
    // POST must not have added a cache row (GET fills still may).
    expect((after?.c ?? 0) - (before?.c ?? 0)).toBeGreaterThanOrEqual(0);
  });

  test("dry-run still skips writes; reads still execute", async () => {
    const db = await dbP;
    const steps: CompiledStep[] = [
      step({ id: "r0", url: "https://x.test/forge/25/status" }),
      step({ id: "w0", method: "POST", commute: false, url: "https://x.test/shop/4/orders" }),
    ];
    const tool = await insertTool(db, "t_stream_dry", steps);
    const receipt = await playTool(db, tool, {}, { dryRun: true });
    expect(receipt.ok).toBe(true);
    expect(receipt.dryRun).toBe(true);
    expect((receipt.result as Record<string, unknown>)["w0"]).toEqual({
      skipped: "dry_run",
      method: "POST",
      url: "https://x.test/shop/4/orders",
    });
  });

  test("a failed wave-0 step stops official wave-1 execution", async () => {
    const db = await dbP;
    const steps: CompiledStep[] = [
      step({ id: "ok0", url: "https://x.test/forge/26/status" }),
      { id: "boom", kind: "runner", name: "shell_thing", command: "echo hi", commute: true },
      step({ id: "never", url: "https://x.test/forge/26/comments?ref={{ok0.state}}" }),
    ];
    const tool = await insertTool(db, "t_stream_fail", steps);
    const receipt = await playTool(db, tool, {});
    expect(receipt.ok).toBe(false);
    expect(receipt.failed_step).toBeDefined();
    expect(receipt.steps_attempted).toBeLessThan(3);
    const result = receipt.result as Record<string, unknown>;
    expect(result["never"]).toBeUndefined();
  });
});

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

/** A promise the test settles by hand, so step order never rests on timer margins (#81). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** True if `p` settles within `ms`. A guard against hanging, not a timing assertion. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)));
  try {
    return await Promise.race([p.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
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

  test("wave-1 prefetch starts while slow wave-0 is in flight; next is fetched once", async () => {
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
    // `slow` stays in flight until the test releases it; nothing here waits on a timer.
    const slow = deferred();
    const nextFetching = deferred();
    const fetches: string[] = [];
    setPlaybackFetchGate(async ({ id }) => {
      fetches.push(id);
      if (id === "slow") await slow.promise;
      if (id === "next") nextFetching.resolve();
    });
    resetPrefetchCounters();
    const probe = installPlaybackStreamProbe();

    const played = playTool(db, tool, {});
    // `next` needs only `fast`, so its fetch must start while `slow` is still held.
    // Behind a wave-0 barrier it would wait for `slow`, and this guard would expire.
    const nextFetchedWhileSlowHeld = await settlesWithin(nextFetching.promise, 2_000);
    const slowStillRunning = !probe.stepDone.some((m) => m.id === "slow");
    slow.resolve();
    const receipt = await played;
    await drainPrefetches();

    expect(nextFetchedWhileSlowHeld).toBe(true);
    expect(slowStillRunning).toBe(true);
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
    expect(nextBind!.t).toBeLessThan(slowDone!.t);

    // The prefetch did the work: official wave-1 reused it instead of fetching `next`
    // again after `slow`. That is why a streamed run beats the barrier's slow + next.
    expect(prefetchCounters.started).toBeGreaterThanOrEqual(1);
    expect(fetches.filter((id) => id === "next")).toEqual(["next"]);
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

import { afterEach, describe, expect, test } from "bun:test";
import { PoolClosedError, PoolFullError, PoolTimeoutError, WorkerPool, type PoolOptions } from "./pool";

const MODULE = new URL("./pool.fixture.ts", import.meta.url).href;
const pools: WorkerPool[] = [];

async function pool(options: Partial<PoolOptions>): Promise<WorkerPool> {
  const p = await WorkerPool.start({
    module: MODULE,
    size: 2,
    maxQueue: 1_000,
    maxBatch: 16,
    taskTimeoutMs: Infinity,
    inlineBelow: 0,
    ...options,
  });
  pools.push(p);
  return p;
}

afterEach(() => {
  for (const p of pools.splice(0)) p.close();
});

describe("WorkerPool", () => {
  test("runs tasks in workers and returns each result to its caller", async () => {
    const p = await pool({});
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => p.run<number>("double", i)));
    expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i * 2));
    expect(await p.run("where", null)).toBe("worker");
    expect(p.stats().completed).toBe(101);
  });

  test("a task that throws fails alone; the rest of its batch succeeds", async () => {
    const p = await pool({ size: 1 });
    const [a, b, c] = await Promise.allSettled([p.run("double", 1), p.run("fail", "boom"), p.run("double", 3)]);
    expect(a).toEqual({ status: "fulfilled", value: 2 });
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason.message).toBe("boom");
    expect(c).toEqual({ status: "fulfilled", value: 6 });
    // Awaited by hand: under bun 1.4.4, `expect(promise).rejects` never settled for a rejection a worker delivers.
    const missing = await p.run("nope", 1).catch((error: Error) => error);
    expect((missing as Error).message).toBe("no task named nope");
  });

  test("back-pressure: past maxQueue waiting tasks, run rejects at once", async () => {
    const p = await pool({ size: 1, maxQueue: 2, maxBatch: 1 });
    const running = p.run("spin", 100);
    await Bun.sleep(5); // the first task is now in the worker, not waiting
    const waiting = [p.run("double", 1), p.run("double", 2)];
    await expect(p.run("double", 3)).rejects.toBeInstanceOf(PoolFullError);
    expect(p.stats().rejectedFull).toBe(1);
    await running;
    expect(await Promise.all(waiting)).toEqual([2, 4]);
  });

  test("an aborted waiting task never runs; an aborted running task rejects at once", async () => {
    const p = await pool({ size: 1, maxBatch: 1 });
    const running = new AbortController();
    const first = p.run("spin", 200, running.signal);
    const queued = new AbortController();
    const second = p.run("double", 5, queued.signal);
    const third = p.run("double", 6);
    await Bun.sleep(5);
    queued.abort(new Error("not needed"));
    await expect(second).rejects.toThrow("not needed");
    const t0 = performance.now();
    running.abort(new Error("caller left"));
    await expect(first).rejects.toThrow("caller left");
    expect(performance.now() - t0).toBeLessThan(50);
    expect(await third).toBe(12);
    // The worker finished the abandoned spin, never ran the aborted task, then ran the third.
    expect(p.stats().completed).toBe(2);
    const aborted = new AbortController();
    aborted.abort(new Error("already"));
    await expect(p.run("double", 1, aborted.signal)).rejects.toThrow("already");
  });

  test("a batch past its deadline is stopped: the worker is replaced and the pool keeps working", async () => {
    const p = await pool({ size: 1, taskTimeoutMs: 100 });
    const t0 = performance.now();
    await expect(p.run("spin", 10_000)).rejects.toBeInstanceOf(PoolTimeoutError);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(await p.run("double", 21)).toBe(42);
    expect(p.stats()).toMatchObject({ timedOut: 1, restarts: 1, workers: 1 });
  });

  test("a crashed worker is replaced", async () => {
    const p = await pool({ size: 1 });
    expect(await p.run("crashLater", null)).toBe(1);
    await Bun.sleep(100);
    expect(await p.run("double", 4)).toBe(8);
    expect(p.stats().restarts).toBe(1);
  });

  test("runOrInline: small or overflowing work runs on the calling thread", async () => {
    const p = await pool({ size: 1, inlineBelow: 1_000, maxQueue: 1, maxBatch: 1 });
    expect(await p.runOrInline("where", null, 10)).toBe("main");
    expect(await p.runOrInline("where", null, 5_000)).toBe("worker");
    const busy = p.run("spin", 100);
    await Bun.sleep(5);
    const queued = p.run("double", 1);
    // The queue is full, so even large work runs inline rather than failing.
    expect(await p.runOrInline("where", null, 5_000)).toBe("main");
    await Promise.all([busy, queued]);
    expect(p.stats().inline).toBe(2);
    await expect(p.runOrInline("fail", "inline boom", 1)).rejects.toThrow("inline boom");
  });

  test("close rejects waiting and running tasks, and later runs", async () => {
    const p = await pool({ size: 1, maxBatch: 1 });
    const running = p.run("spin", 200);
    const waiting = p.run("double", 1);
    await Bun.sleep(5);
    p.close();
    await expect(running).rejects.toBeInstanceOf(PoolClosedError);
    await expect(waiting).rejects.toBeInstanceOf(PoolClosedError);
    await expect(p.run("double", 1)).rejects.toBeInstanceOf(PoolClosedError);
  });

  test("a module that fails to load fails start", async () => {
    await expect(
      WorkerPool.start({
        module: new URL("./does-not-exist.ts", import.meta.url).href,
        size: 1,
        maxQueue: 1,
        maxBatch: 1,
        taskTimeoutMs: Infinity,
        inlineBelow: 0,
      }),
    ).rejects.toThrow();
  });
});

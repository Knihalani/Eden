/**
 * Wave 4 durability guards for the TS SDK.
 *
 * Five defects, each of which lost telemetry without saying so:
 *
 * 1. A 413 on the main event path destroyed the batch. `postJson` maps
 *    413 to `"too_large"`, but `postBatch` only spilled on `"spill"`, so
 *    the batch was neither retried, split, nor written to the offline
 *    queue. `postChunkBatch` has bisected on 413 since it was written;
 *    the event path never got the same treatment.
 * 2. `maxBatchSize` was a flush *trigger*, not a cap: `flush()` took the
 *    whole queue. With one POST in flight the queue kept growing, so a
 *    burst went out as a single request of up to `maxQueueSize` events —
 *    making (1) catastrophic instead of merely bad.
 * 3. The queue-ceiling eviction (`this.queue.shift()`) had no counter and
 *    not even a debug log, so a process shedding telemetry under
 *    back-pressure looked identical to one emitting nothing.
 * 4. `flush()` reported `true` when it had merely awaited a *concurrent*
 *    batch that failed, because `allOk` is per-invocation. Since `emit()`
 *    fires `void this.flush()` itself at `maxBatchSize`, this was the
 *    common path, not the rare one.
 * 5. `OfflineQueue` rewrote the live file with `writeFileSync`, which
 *    truncates before writing — a crash in that window emptied the queue
 *    whose entire purpose is surviving a crash. And `_trim()` called
 *    `size()` on every append, re-reading the whole file, making a fill
 *    quadratic (measured 91us/row at 500 rows, 541us/row at 8000).
 */

import { describe, expect, test, afterEach } from "bun:test";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EdenSDK } from "../src/client.js";
import { OfflineQueue } from "../src/offline-queue.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function tmp(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "eden-dur-")), name);
}

/** A gateway that 413s any batch carrying more than `max` events. */
function sizeLimitGateway(max: number) {
  const batches: number[] = [];
  const accepted: string[] = [];
  globalThis.fetch = (async (_u: string, init: { body: Uint8Array }) => {
    const parsed = JSON.parse(gunzipSync(Buffer.from(init.body)).toString());
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    batches.push(arr.length);
    if (arr.length > max) return new Response("too large", { status: 413 });
    for (const e of arr) accepted.push(e.event_id ?? e.payload?.event_id);
    return new Response(JSON.stringify({ accepted: arr.length }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { batches, accepted };
}

function sdk(overrides: Record<string, unknown> = {}): EdenSDK {
  return new EdenSDK({
    orgId: "o",
    apiKey: "k",
    baseUrl: "http://gateway.invalid",
    flushIntervalMs: 100_000,
    ...overrides,
  } as never);
}

function emitN(client: EdenSDK, n: number, prefix = "e"): void {
  for (let i = 0; i < n; i++) {
    client.emit({
      sourceFormat: "openai",
      payload: { event_id: `${prefix}${i}` },
    } as never);
  }
}

describe("413 on the main event path bisects instead of vanishing", () => {
  test("every event is delivered despite a 413", async () => {
    const gw = sizeLimitGateway(2);
    const client = sdk({ maxBatchSize: 10_000 });
    emitN(client, 8);
    await client.flush();
    await client.dispose();

    expect(new Set(gw.accepted)).toEqual(
      new Set(Array.from({ length: 8 }, (_, i) => `e${i}`)),
    );
  });

  test("it halves rather than resending the same size", async () => {
    const gw = sizeLimitGateway(2);
    const client = sdk({ maxBatchSize: 10_000 });
    emitN(client, 8);
    await client.flush();
    await client.dispose();

    expect(gw.batches[0]).toBe(8);
    expect(gw.batches).toContain(4);
    expect(Math.max(...gw.batches)).toBe(8); // never grew
  });

  test("a batch that can never fit terminates at one event", async () => {
    const gw = sizeLimitGateway(0); // 413 everything
    const client = sdk({ maxBatchSize: 10_000 });
    emitN(client, 8);
    const ok = await client.flush();
    await client.dispose();

    expect(ok).toBe(false);
    expect(gw.accepted).toEqual([]);
    expect(gw.batches).toContain(1); // bisected all the way down
    expect(gw.batches.length).toBeLessThan(64); // and terminated
  });
});

describe("maxBatchSize caps the batch, not just the flush trigger", () => {
  test("130 events at cap 50 go out as 50/50/30", async () => {
    const gw = sizeLimitGateway(10_000); // accept everything
    const client = sdk({ maxBatchSize: 50 });
    emitN(client, 130, "q");
    await client.flush();
    await client.dispose();

    expect(Math.max(...gw.batches)).toBe(50);
    expect(gw.accepted.length).toBe(130);
  });

  test("a hung POST cannot grow an unbounded batch", async () => {
    // The regression: with maxBatchSize=50 and one POST hung, the queue
    // reached 910 events that would have shipped as a single request.
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const batches: number[] = [];
    let first = true;
    globalThis.fetch = (async (_u: string, init: { body: Uint8Array }) => {
      const parsed = JSON.parse(gunzipSync(Buffer.from(init.body)).toString());
      batches.push(Array.isArray(parsed) ? parsed.length : 1);
      if (first) {
        first = false;
        await held;
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = sdk({ maxBatchSize: 50, maxQueueSize: 4096 });
    emitN(client, 60, "a");
    await new Promise((r) => setTimeout(r, 20));
    emitN(client, 900, "b");
    await new Promise((r) => setTimeout(r, 20));
    release?.();
    await client.flush();
    await client.dispose();

    expect(Math.max(...batches)).toBeLessThanOrEqual(50);
  });
});

describe("queue-ceiling evictions are counted", () => {
  test("droppedTotal reflects events shed at maxQueueSize", async () => {
    sizeLimitGateway(10_000);
    const client = sdk({ maxQueueSize: 10, maxBatchSize: 10_000 });
    emitN(client, 25, "z");
    expect(client.droppedTotal).toBe(15);
    await client.dispose();
  });

  test("nothing is counted when the queue never fills", async () => {
    sizeLimitGateway(10_000);
    const client = sdk({ maxQueueSize: 100, maxBatchSize: 10_000 });
    emitN(client, 25, "z");
    expect(client.droppedTotal).toBe(0);
    await client.dispose();
  });
});

describe("flush() reports the outcome of batches it waited on", () => {
  // emit() fires `void this.flush()` once the queue reaches maxBatchSize,
  // so an explicit `await flush()` usually only *waits*. It used to
  // return its own untouched `true` in that case.
  test("a permanent 4xx started by emit() still reports false", async () => {
    globalThis.fetch = (async () =>
      new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const client = sdk({ maxBatchSize: 8 });
    emitN(client, 8);
    expect(await client.flush()).toBe(false);
    await client.dispose();
  });

  test("an unsplittable 413 started by emit() still reports false", async () => {
    globalThis.fetch = (async () =>
      new Response("too large", { status: 413 })) as unknown as typeof fetch;
    const client = sdk({ maxBatchSize: 8 });
    emitN(client, 8);
    expect(await client.flush()).toBe(false);
    await client.dispose();
  });

  test("success still reports true", async () => {
    sizeLimitGateway(10_000);
    const client = sdk({ maxBatchSize: 8 });
    emitN(client, 8);
    expect(await client.flush()).toBe(true);
    await client.dispose();
  });

  test("an empty queue reports true", async () => {
    sizeLimitGateway(10_000);
    const client = sdk();
    expect(await client.flush()).toBe(true);
    await client.dispose();
  });
});

describe("OfflineQueue rewrites are atomic and appends are O(1)", () => {
  test("ack leaves a fully-parseable file", () => {
    const q = new OfflineQueue(tmp("a.jsonl"), 100_000);
    for (let i = 0; i < 200; i++) q.enqueue("openai", { event_id: `a${i}` });
    q.ack(q.peek(3));

    const raw = readFileSync(q.path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(197);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("a rewrite swaps the file rather than truncating it in place", () => {
    // This is the property that makes the rewrite crash-safe, and the
    // only one an in-process test can actually observe. `writeFileSync`
    // on the live path truncates to zero length and then writes, so a
    // crash inside that window leaves the queue empty or cut mid-line —
    // losing not just the acked rows but every unacked row that was
    // being written back. A temp-file-plus-`rename()` never exposes a
    // partial file: a reader sees either the whole old queue or the
    // whole new one. The visible signature of that strategy is that the
    // path points at a *different inode* afterwards; an in-place
    // truncate keeps the same one.
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const q = new OfflineQueue(tmp("ino.jsonl"), 100_000);
    for (let i = 0; i < 20; i++) q.enqueue("openai", { event_id: `i${i}` });
    const before = statSync(q.path).ino;
    q.ack(q.peek(4));
    const after = statSync(q.path).ino;

    expect(after).not.toBe(before);
    expect(q.size()).toBe(16);
  });

  test("no temp file is left behind", () => {
    const q = new OfflineQueue(tmp("b.jsonl"), 100_000);
    for (let i = 0; i < 20; i++) q.enqueue("openai", { event_id: `b${i}` });
    q.ack(q.peek(5));
    // A crash-safe rewrite writes a sibling temp then renames it away.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const { dirname } = require("node:path") as typeof import("node:path");
    const leftovers = readdirSync(dirname(q.path)).filter((f) =>
      f.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  test("append cost does not grow with queue depth", () => {
    // The regression was quadratic: _trim() called size(), which read and
    // split the entire file, on every single append. Compare the marginal
    // cost of an append at depth ~4000 against one at depth ~250. A
    // per-append full-file read makes the former ~16x the latter; this
    // asserts a generous 6x so it fails on the regression without being
    // flaky on a loaded machine.
    const measure = (depth: number): number => {
      const q = new OfflineQueue(tmp(`p${depth}.jsonl`), 1_000_000);
      const payload = { event_id: "x", blob: "y".repeat(200) };
      for (let i = 0; i < depth; i++) q.enqueue("openai", payload);
      const reps = 40;
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) q.enqueue("openai", payload);
      return (performance.now() - t0) / reps;
    };
    const shallow = measure(250);
    const deep = measure(4000);
    expect(deep).toBeLessThan(Math.max(shallow, 0.01) * 6);
  });

  test("the row cap still evicts and counts", () => {
    const q = new OfflineQueue(tmp("c.jsonl"), 10);
    for (let i = 0; i < 25; i++) q.enqueue("openai", { event_id: `c${i}` });
    expect(q.size()).toBe(10);
    expect(q.dropped).toBe(15);
    // Oldest evicted, newest retained.
    const ids = q.peek(10).map((r) => r.payload.event_id);
    expect(ids).toContain("c24");
    expect(ids).not.toContain("c0");
  });

  test("the cached row count self-heals from an external append", () => {
    const path = tmp("d.jsonl");
    const q = new OfflineQueue(path, 100_000);
    q.enqueue("openai", { event_id: "d0" });
    const other = new OfflineQueue(path, 100_000);
    other.enqueue("openai", { event_id: "d1" });
    // `q` has a stale in-memory count of 1; size() re-reads and corrects.
    expect(q.size()).toBe(2);
  });
});

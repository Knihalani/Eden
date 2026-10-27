import { afterAll, describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { WorkerPool } from "@eden/primitives";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { SourceFanout, StaticSource } from "@eden/sources";
import { ItemCache, sanitizeItem } from "./cache";
import { GATE_MODULE, pooledSanitizer } from "./gate";
import { ContextPartner } from "./partner";

const KEY = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
const item = (ref: string, text: string): ContextItem => ({
  id: `crm:${ref}`,
  sourceId: "crm",
  ref,
  title: `Note ${ref}`,
  text,
});

let pool: WorkerPool;
const started = WorkerPool.start({
  module: GATE_MODULE,
  size: 1,
  maxQueue: 1_000,
  maxBatch: 32,
  taskTimeoutMs: 5_000,
  inlineBelow: 0, // Every item through the worker.
}).then((p) => (pool = p));
afterAll(() => pool?.close());

describe("pooledSanitizer", () => {
  test("gives the same items as sanitizeItem, gated in a worker", async () => {
    await started;
    const raw = [
      item("a", `Globex renewal, token ${KEY}`),
      item(`ref-${KEY}`, "a ref that holds a secret"),
      item("b", "x".repeat(20_000)),
    ];
    const gated = await pooledSanitizer(pool)(raw);
    expect(gated).toEqual(raw.map((r) => sanitizeItem(r)));
    expect(JSON.stringify(gated)).not.toContain(KEY);
    expect(pool.stats().completed).toBe(3);
  });

  test("fails closed: an item whose task fails is dropped, never kept ungated", async () => {
    let n = 0;
    const flaky = {
      runOrInline: <T>(_fn: string, input: unknown) =>
        n++ === 1
          ? Promise.reject(new Error("deadline"))
          : Promise.resolve(sanitizeItem((input as { item: ContextItem }).item) as T),
    };
    const gated = await pooledSanitizer(flaky)([item("a", "one"), item("b", `two ${KEY}`), item("c", "three")]);
    expect(gated.map((i) => i.ref)).toEqual(["a", "c"]);
  });

  test("a partner whose fan-out gates through the pool delivers redacted context", async () => {
    await started;
    const crm = new StaticSource("crm", "Deals", [
      { ref: "deal-9", title: "Globex renewal", text: `Globex renewal due 2026-11-30, Dana Lee, api key ${KEY}` },
    ]);
    const p = new ContextPartner({
      sources: async () => [crm],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      fanout: new SourceFanout({ sanitize: pooledSanitizer(pool) }),
    });
    const event = { tenantId: "t", userId: "u", sessionId: "s", at: 1, kind: "user_message" } as const;
    const r = await p.observe({ ...event, text: "Draft a note to Dana Lee about the Globex renewal" } as AgentEvent, {
      waitMs: 2_000,
    });
    expect(r.injection?.citations.map((c) => c.itemId)).toContain("crm:deal-9");
    expect(r.injection?.text).not.toContain(KEY);
  });
});

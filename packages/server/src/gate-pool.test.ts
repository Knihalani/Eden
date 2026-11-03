import { describe, expect, test } from "bun:test";
import { gateItem } from "@eden/engine";
import { startGatePool } from "./build";

describe("startGatePool (D25)", () => {
  test("0 workers: no pool", async () => {
    expect(await startGatePool(0)).toBeUndefined();
  });

  test("every worker, a replacement too, has compiled the secret gate before its first task", async () => {
    const pool = (await startGatePool(2))!;
    const both = () => Promise.all([pool.run("gateWarmed", null), pool.run("gateWarmed", null)]);
    try {
      // The first tasks the pool serves: one to each idle worker (dispatch shares a turn's tasks evenly).
      expect(await both()).toEqual([true, true]);
      // Still gates as before: the same result as on the calling thread.
      const item = { id: "a", sourceId: "mail", ref: "m1", title: "keys", text: "api key and password rotated" };
      expect(await pool.run("gateItem", { item, maxTextChars: 400 })).toEqual(gateItem({ item, maxTextChars: 400 }));
      // Replace both workers the way a timeout or a crash does (the private path, reached directly: no gate input
      // reliably runs past the deadline), then check the fresh ones are warm before they serve.
      const internal = pool as unknown as { slots: unknown[]; replace(slot: unknown, error: Error): void };
      for (const slot of [...internal.slots]) internal.replace(slot, new Error("test: replaced"));
      expect(pool.stats().restarts).toBe(2);
      expect(await both()).toEqual([true, true]);
    } finally {
      pool.close();
    }
  });
});

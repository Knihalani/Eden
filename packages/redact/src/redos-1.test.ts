/** D24 and D86: shard 1 of the crafted-input sweep (redos-sweep.ts; shard 0 and the rest are in redos.test.ts). */
import { expect, test } from "bun:test";
import { shardRules, slowOn } from "./redos-sweep";

test("rules left on JavaScript's engine stay cheap on crafted input: shard 1", () => {
  expect(shardRules(1).length).toBeGreaterThan(0);
  expect(slowOn(1)).toEqual([]);
}, 60_000);

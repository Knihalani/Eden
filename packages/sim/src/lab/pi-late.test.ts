import { describe, expect, test } from "bun:test";
import type { Task } from "./ab-common";
import { holdPlanted, laterText, release } from "./pi-late";
import type { World, WorldItem } from "../world";

const item = (id: string): WorldItem =>
  ({
    id,
    sourceId: "gmail",
    ref: id,
    title: id,
    text: id,
    updatedAt: 1,
    kind: "email",
    facts: [],
    noise: false,
  }) as unknown as WorldItem;
const task = (id: string, planted?: string) => ({ id, ...(planted ? { planted } : {}) }) as unknown as Task;

describe("pi-late (A9): planted items held back and released after their request", () => {
  test("holds only the planted items, and releases each once, new at the given time", () => {
    const world = { items: [item("a"), item("b"), item("c")] } as unknown as World;
    const held = holdPlanted(world, [task("t1", "b"), task("t2"), task("t3", "c")]);
    expect(world.items.map((i) => i.id)).toEqual(["a"]);
    expect([...held.keys()]).toEqual(["b", "c"]);
    const out = release(world, held, "b", 99);
    expect(out?.updatedAt).toBe(99);
    expect(world.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(release(world, held, "b", 100)).toBeNull();
    expect(release(world, held, "zzz", 100)).toBeNull();
  });

  test("the later text heads each reply and skips empty ones", () => {
    expect(laterText({ task: task("t"), after: ["first", "", " second "] })).toBe(
      "[Later reply 1]\nfirst\n\n[Later reply 3]\nsecond",
    );
    expect(laterText({ task: task("t"), after: [] })).toBe("");
  });
});

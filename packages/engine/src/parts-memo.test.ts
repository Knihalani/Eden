import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { clearParts, partsMemoCount, renderPacket } from "./render";

/*
 * D1882: `PARTS_MEMO` holds the packet's parts of recent items by item object, so the cache empties it wherever a
 * user's items leave memory (`clearParts` beside each `clearDecoded`): a removed, forgotten, frozen, released or
 * evicted user's text must not stay resident there. One case a path.
 */

const NOW = Date.UTC(2026, 10, 2, 9);
const alice = { tenantId: "t", userId: "alice" };
const item = (ref: string): ContextItem => ({
  id: `mail:${ref}`,
  sourceId: "mail",
  ref,
  title: `Budget ${ref}`,
  text: `The budget review with Dana moved to Friday. ${"Notes on the freeze and the board deck. ".repeat(12)}`,
  updatedAt: NOW - 60_000,
});

/** A cache holding alice's items, each rendered once from the cache's own object, so the memo holds them. */
function rendered(limits: ConstructorParameters<typeof ItemCache>[0] = {}): ItemCache {
  clearParts();
  const cache = new ItemCache(limits);
  cache.put(alice, [item("1"), item("2")], NOW);
  const held = cache.hits(alice, ["mail:1", "mail:2"], NOW).map((h) => h.item);
  expect(held.length).toBe(2);
  renderPacket(held, { maxBytes: 2_000, focus: new Set(["budget", "friday"]) });
  expect(partsMemoCount()).toBe(2);
  return cache;
}

describe("the cache empties the packet parts memo (D1882)", () => {
  test("removeItems", () => {
    const cache = rendered();
    cache.removeItems(alice, ["mail:1"], NOW);
    expect(partsMemoCount()).toBe(0);
  });

  test("forget", () => {
    const cache = rendered();
    cache.forget(alice);
    expect(partsMemoCount()).toBe(0);
  });

  test("a freeze (install)", () => {
    const cache = rendered();
    for (let i = 0; i < 40 && cache.frozenCount === 0; i++) cache.expireIdle(NOW);
    expect(cache.frozenCount).toBe(1);
    expect(partsMemoCount()).toBe(0);
  });

  test("release", () => {
    const cache = rendered();
    cache.release(alice);
    expect(partsMemoCount()).toBe(0);
  });

  test("an evicted user (dropUser)", () => {
    const cache = rendered({ maxUsersPerTenant: 1 });
    cache.put({ tenantId: "t", userId: "bob" }, [item("3")], NOW);
    expect(partsMemoCount()).toBe(0);
  });
});

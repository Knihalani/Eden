import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "./source-map";

const alice = { tenantId: "t", userId: "alice" };
const bob = { tenantId: "t", userId: "bob" };
const all = ["calendar", "crm", "gmail", "notion"];

describe("SourceMap", () => {
  test("routes to the sources that have mentioned the cue's entities", () => {
    const map = new SourceMap(":memory:", { explore: false });
    map.recordMentions(alice, "crm", ["Acme Corp", "Dana Lee"]);
    map.recordMentions(alice, "gmail", ["acme corp"]);
    map.recordMentions(alice, "crm", ["Acme Corp"]);
    const ranked = map.route({ scope: alice, entities: ["ACME corp"], situation: "chat", sourceIds: all, limit: 2 });
    expect(ranked.map((r) => r.sourceId)).toEqual(["crm", "gmail"]);
  });

  test("learned usefulness lifts a source in its situation only", () => {
    const map = new SourceMap(":memory:", { explore: false });
    for (let i = 0; i < 5; i++) map.recordOutcome(alice, "scheduling", "calendar", true);
    for (let i = 0; i < 5; i++) map.recordOutcome(alice, "scheduling", "notion", false);
    expect(
      map.route({ scope: alice, entities: [], situation: "scheduling", sourceIds: all, limit: 1 })[0]!.sourceId,
    ).toBe("calendar");
    expect(map.utility(alice, "research", "calendar")).toBe(0.5);
  });

  test("an explicit correction flips one recorded outcome", () => {
    const map = new SourceMap(":memory:", { explore: false });
    map.recordOutcome(alice, "chat", "crm", false);
    map.correctOutcome(alice, "chat", "crm", true);
    expect(map.utility(alice, "chat", "crm")).toBeCloseTo(2 / 3);
    map.correctOutcome(alice, "chat", "crm", true);
    expect(map.utility(alice, "chat", "crm")).toBeCloseTo(2 / 3);
  });

  test("users never see each other's map, and forget clears a user", () => {
    const map = new SourceMap(":memory:", { explore: false });
    map.recordMentions(alice, "crm", ["Acme"]);
    expect(map.sourcesFor(bob, "acme")).toEqual([]);
    map.forget(alice);
    expect(map.sourcesFor(alice, "acme")).toEqual([]);
  });
});

describe("Thompson routing", () => {
  test("an unlucky source is still queried sometimes, a proven one most of the time", () => {
    const map = new SourceMap(":memory:", { seed: 7 });
    for (let i = 0; i < 20; i++) map.recordOutcome(alice, "chat", "calendar", true);
    for (let i = 0; i < 3; i++) map.recordOutcome(alice, "chat", "notion", false);
    const firsts: Record<string, number> = {};
    for (let i = 0; i < 1_000; i++) {
      const top = map.route({
        scope: alice,
        entities: [],
        situation: "chat",
        sourceIds: ["calendar", "notion"],
        limit: 1,
      })[0]!;
      firsts[top.sourceId] = (firsts[top.sourceId] ?? 0) + 1;
    }
    expect(firsts.calendar!).toBeGreaterThan(900);
    expect(firsts.notion ?? 0).toBeGreaterThan(0);
  });

  test("a seed makes routing reproducible", () => {
    const route = (seed: number) => {
      const map = new SourceMap(":memory:", { seed });
      return Array.from({ length: 20 }, () =>
        map
          .route({ scope: alice, entities: [], situation: "chat", sourceIds: all, limit: 2 })
          .map((r) => r.sourceId)
          .join(),
      );
    };
    expect(route(3)).toEqual(route(3));
  });

  test("outcomes are written behind but every read sees them, and they reach the file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "eden-map-")), "map.db");
    const map = new SourceMap(path, { explore: false });
    map.recordOutcome(alice, "chat", "crm", true);
    expect(map.utility(alice, "chat", "crm")).toBe(2 / 3); // Read flushes first.
    map.recordOutcome(alice, "chat", "crm", true);
    map.recordOutcome(alice, "chat", "gmail", false);
    await Bun.sleep(30); // The timer writes them.
    const other = new SourceMap(path, { explore: false });
    expect(other.utility(alice, "chat", "crm")).toBe(3 / 4);
    expect(other.utility(alice, "chat", "gmail")).toBe(1 / 3);
    map.recordOutcome(bob, "chat", "crm", true);
    map.close(); // Close flushes.
    expect(other.utility(bob, "chat", "crm")).toBe(2 / 3);
    other.close();
  });

  test("forget drops outcomes still buffered", () => {
    const map = new SourceMap(":memory:", { explore: false });
    map.recordOutcome(alice, "chat", "crm", true);
    map.forget(alice);
    expect(map.utility(alice, "chat", "crm")).toBe(0.5);
  });
});

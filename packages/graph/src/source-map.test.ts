import { describe, expect, test } from "bun:test";
import { SourceMap } from "./source-map";

const alice = { tenantId: "t", userId: "alice" };
const bob = { tenantId: "t", userId: "bob" };
const all = ["calendar", "crm", "gmail", "notion"];

describe("SourceMap", () => {
  test("routes to the sources that have mentioned the cue's entities", () => {
    const map = new SourceMap();
    map.recordMentions(alice, "crm", "deal-9", ["Acme Corp", "Dana Lee"]);
    map.recordMentions(alice, "gmail", "m-1", ["acme corp"]);
    map.recordMentions(alice, "crm", "deal-10", ["Acme Corp"]);
    const ranked = map.route({ scope: alice, entities: ["ACME corp"], situation: "chat", sourceIds: all, limit: 2 });
    expect(ranked.map((r) => r.sourceId)).toEqual(["crm", "gmail"]);
  });

  test("learned usefulness lifts a source in its situation only", () => {
    const map = new SourceMap();
    for (let i = 0; i < 5; i++) map.recordOutcome(alice, "scheduling", "calendar", true);
    for (let i = 0; i < 5; i++) map.recordOutcome(alice, "scheduling", "notion", false);
    expect(
      map.route({ scope: alice, entities: [], situation: "scheduling", sourceIds: all, limit: 1 })[0]!.sourceId,
    ).toBe("calendar");
    expect(map.utility(alice, "research", "calendar")).toBe(0.5);
  });

  test("users never see each other's map, and forget clears a user", () => {
    const map = new SourceMap();
    map.recordMentions(alice, "crm", "deal-9", ["Acme"]);
    expect(map.sourcesFor(bob, "acme")).toEqual([]);
    map.forget(alice);
    expect(map.sourcesFor(alice, "acme")).toEqual([]);
  });
});

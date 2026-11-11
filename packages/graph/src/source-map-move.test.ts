import { expect, test } from "bun:test";
import { SourceMap } from "./source-map";

const alice = { tenantId: "acme", userId: "alice" };
const bob = { tenantId: "acme", userId: "bob" };

test("a user's rows move between files whole, without touching another user's (D992)", () => {
  const a = new SourceMap();
  a.recordMentions(alice, "mail", ["Dana Lee", "Globex"], 1_000);
  a.recordOutcome(alice, "planning", "mail", true);
  a.saveArms(alice, "mail", [{ bucket: 3, shape: "and", alpha: 2.5, beta: 1 }]);
  a.recordMentions(bob, "mail", ["Bob's"], 1_000);
  const rows = a.exportUser(alice);
  expect(rows.mention).toHaveLength(2);
  expect(rows.utility).toEqual([["planning", "mail", 1, 1]]);
  expect(rows.arms).toEqual([["mail", 3, "and", 2.5, 1]]);
  expect(JSON.stringify(rows)).not.toContain("bob");

  const b = new SourceMap();
  b.recordMentions(alice, "docs", ["stale"], 1); // an older stay's row: replaced, not merged
  b.recordMentions(bob, "docs", ["kept"], 1);
  b.importUser(alice, JSON.parse(JSON.stringify(rows)));
  expect(b.exportUser(alice)).toEqual(rows);
  expect(b.sourcesFor(alice, "stale")).toEqual([]);
  expect(b.sourcesFor(bob, "kept")).toEqual([{ sourceId: "docs", count: 1 }]);
  expect(b.utility(alice, "planning", "mail")).toBe(a.utility(alice, "planning", "mail"));
  expect(b.loadArms(alice, "mail")).toEqual([{ bucket: 3, shape: "and", alpha: 2.5, beta: 1 }]);
});

test("malformed carried rows are skipped, never written", () => {
  const b = new SourceMap();
  b.importUser(alice, {
    mention: [["x", "mail", "NaN", 1], ["y", "mail", 2, 3, "extra"], "nope" as never, ["z", 5, 1, 1]],
    utility: [[1, 2, 3, 4]],
    arms: [["mail", 1, "and", Infinity, 1]],
  });
  expect(b.exportUser(alice)).toEqual({ mention: [["y", "mail", 2, 3]], utility: [], arms: [] });
});

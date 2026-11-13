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

  test("routing many sources reads each one's outcomes in its own situation and user (D261's one query)", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `src-${i}`);
    const seeded = (explore: boolean) => {
      const map = new SourceMap(":memory:", { explore, seed: 5 });
      ids.forEach((id, i) => {
        for (let k = 0; k < i % 7; k++) map.recordOutcome(alice, "scheduling", id, k % 3 !== 0);
        // Another situation and another user must not leak into alice's scheduling routes.
        if (i % 11 === 0) for (let k = 0; k < 9; k++) map.recordOutcome(alice, "chat", id, true);
        if (i % 13 === 0) for (let k = 0; k < 9; k++) map.recordOutcome(bob, "scheduling", id, true);
      });
      map.recordMentions(alice, "src-42", ["Dana Lee"]);
      return map;
    };
    const map = seeded(false);
    const ranked = map.route({
      scope: alice,
      entities: ["Dana Lee"],
      situation: "scheduling",
      sourceIds: ids,
      limit: 300,
    });
    for (const r of ranked) expect(r.utility).toBeCloseTo(map.utility(alice, "scheduling", r.sourceId));
    const expected = [...ranked].sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
    expect(ranked.map((r) => r.sourceId)).toEqual(expected.map((r) => r.sourceId));
    expect(ranked[0]!.sourceId).toBe("src-42");
    // With exploration, the same seed draws the same order whatever the limit.
    const a = seeded(true).route({ scope: alice, entities: [], situation: "scheduling", sourceIds: ids, limit: 5 });
    const b = seeded(true).route({ scope: alice, entities: [], situation: "scheduling", sourceIds: ids, limit: 300 });
    expect(a.map((r) => r.sourceId)).toEqual(b.slice(0, 5).map((r) => r.sourceId));
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

  test("planner arms persist per user and connector, upsert, and are forgotten with the user or connector", () => {
    const map = new SourceMap(":memory:", { explore: false });
    map.saveArms(alice, "crm", [{ bucket: 1, shape: "each-entity", alpha: 5, beta: 2 }]);
    map.saveArms(alice, "crm", [{ bucket: 1, shape: "each-entity", alpha: 6, beta: 2 }]);
    map.saveArms(alice, "gmail", [{ bucket: 0, shape: "terms", alpha: 3, beta: 3 }]);
    expect(map.loadArms(alice, "crm")).toEqual([{ bucket: 1, shape: "each-entity", alpha: 6, beta: 2 }]);
    expect(map.loadArms(bob, "crm")).toEqual([]);
    map.forget(alice, "crm");
    expect(map.loadArms(alice, "crm")).toEqual([]);
    expect(map.loadArms(alice, "gmail")).toHaveLength(1);
    map.forget(alice);
    expect(map.loadArms(alice, "gmail")).toEqual([]);
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

  test("a write the timer cannot make is counted and logged, never thrown out of the timer", async () => {
    const map = new SourceMap(":memory:", { explore: false });
    const db = (map as unknown as { db: { transaction: (f: () => void) => () => void } }).db;
    const real = db.transaction.bind(db);
    db.transaction = () => () => {
      throw new Error("SQLITE_BUSY");
    };
    const log = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      map.recordOutcome(alice, "chat", "crm", true);
      await Bun.sleep(30);
    } finally {
      console.error = log;
      db.transaction = real;
    }
    expect(map.failedFlushes).toBe(1);
    expect(JSON.stringify(logged)).not.toContain("alice");
    map.recordOutcome(alice, "chat", "crm", true);
    expect(map.utility(alice, "chat", "crm")).toBe(2 / 3); // Writes go on.
  });

  test("two processes writing one file at once both open it and neither write throws (busy_timeout)", async () => {
    // Two MCP clients launching mcp-stdio for one user share one file. Without a busy timeout one process failed in
    // the constructor with "database is locked" and the other lost writes to SQLITE_BUSY.
    const path = join(mkdtempSync(join(tmpdir(), "eden-sm-lock-")), "map.db");
    const writer = `
      const { SourceMap } = await import(${JSON.stringify(join(import.meta.dir, "source-map.ts"))});
      let errors = 0, writes = 0, opened = true, map;
      try { map = new SourceMap(process.argv[1]); } catch { opened = false; }
      const scope = { tenantId: "t", userId: "u" };
      const end = Date.now() + 400;
      while (map && Date.now() < end) {
        // flush() each time: mentions are written behind (D1745), and this test is of the writes contending.
        try { map.recordMentionsMany(scope, [{ sourceId: "p" + process.pid, entities: ["shared"] }]); map.flush(); writes++; }
        catch { errors++; }
      }
      console.log(JSON.stringify({ opened, writes, errors }));
    `;
    const run = () => Bun.spawn([process.execPath, "-e", writer, path], { stdout: "pipe", stderr: "inherit" });
    const procs = [run(), run()];
    const results = await Promise.all(procs.map(async (p) => JSON.parse(await new Response(p.stdout).text())));
    for (const r of results) {
      expect(r.opened).toBe(true);
      expect(r.errors).toBe(0);
      expect(r.writes).toBeGreaterThan(0);
    }
    // Both wrote to this file: one row per process, each counting every write it made.
    const map = new SourceMap(path);
    const counts = map.sourcesFor({ tenantId: "t", userId: "u" }, "shared").map((r) => r.count);
    expect(counts.sort((a, b) => a - b)).toEqual(results.map((r) => r.writes).sort((a, b) => a - b));
    map.close();
  });
});

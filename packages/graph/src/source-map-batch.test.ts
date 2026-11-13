/**
 * D1780: mentions are written behind, in one transaction a second. Reads see them before they are written, a crash
 * loses at most the pending batch and never a written row, and a normal exit or `close` writes them.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeKey } from "@eden/protocol";
import { SourceMap } from "./source-map";

const alice = { tenantId: "t", userId: "alice" };
const bob = { tenantId: "t", userId: "bob" };
const otherTenant = { tenantId: "t2", userId: "alice" };
const MODULE = JSON.stringify(join(import.meta.dir, "source-map.ts"));

const fileOf = () => join(mkdtempSync(join(tmpdir(), "eden-sm-batch-")), "map.db");
/** What another connection (another process) reads from the file: written rows only. */
const onDisk = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT scope, entity, source_id, count, last_seen FROM mention ORDER BY 1, 2, 3").all() as {
      scope: string;
      entity: string;
      source_id: string;
      count: number;
      last_seen: number;
    }[];
  } finally {
    db.close();
  }
};

describe("SourceMap mentions written behind (D1780)", () => {
  test("a read right after a write sees it, summed with what the file holds, per user and tenant", () => {
    const path = fileOf();
    const map = new SourceMap(path, { explore: false });
    map.recordMentions(alice, "crm", ["Dana Lee", "Acme"], 1_000);
    map.flush();
    map.recordMentions(alice, "crm", ["dana  lee"], 2_000);
    map.recordMentions(alice, "mail", ["Dana Lee"], 2_000);
    map.recordMentions(alice, "mail", ["Dana Lee"], 3_000);
    map.recordMentions(bob, "docs", ["Dana Lee"], 2_000);
    map.recordMentions(otherTenant, "docs", ["Dana Lee"], 2_000);
    // Not written yet: another connection sees only the first lookup's rows.
    expect(onDisk(path).map((r) => [r.entity, r.source_id, r.count])).toEqual([
      ["acme", "crm", 1],
      ["dana lee", "crm", 1],
    ]);
    // This map sees all of it, its own user's only.
    const before = map.sourcesFor(alice, "Dana Lee");
    expect(before).toEqual([
      { sourceId: "crm", count: 2 },
      { sourceId: "mail", count: 2 },
    ]);
    expect(map.sourcesFor(bob, "Dana Lee")).toEqual([{ sourceId: "docs", count: 1 }]);
    expect(map.sourcesFor(otherTenant, "dana lee")).toEqual([{ sourceId: "docs", count: 1 }]);
    expect(map.sourcesFor(alice, "nobody")).toEqual([]);
    const ranked = map.route({
      scope: alice,
      entities: ["Dana Lee"],
      situation: "chat",
      sourceIds: ["docs", "mail", "crm"],
      limit: 3,
    });
    expect(ranked.map((r) => [r.sourceId, r.entityHits])).toEqual([
      ["crm", Math.log2(3)],
      ["mail", Math.log2(3)],
      ["docs", 0],
    ]);
    // Written, the same answers, and the rows one upsert a mention would have left (the last mention's time).
    map.flush();
    expect(map.sourcesFor(alice, "Dana Lee")).toEqual(before);
    const scope = scopeKey(alice);
    expect(onDisk(path).filter((r) => r.scope === scope)).toEqual([
      { scope, entity: "acme", source_id: "crm", count: 1, last_seen: 1_000 },
      { scope, entity: "dana lee", source_id: "crm", count: 2, last_seen: 2_000 },
      { scope, entity: "dana lee", source_id: "mail", count: 2, last_seen: 3_000 },
    ]);
    map.close();
  });

  test("a batched map leaves the same rows as one transaction a mention, on a seeded stream", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) >>> 0) >>> 8) % n;
    const users = [alice, bob, otherTenant];
    const batched = new SourceMap(":memory:", { explore: false });
    const each = new SourceMap(":memory:", { explore: false });
    for (let i = 0; i < 2_000; i++) {
      const scope = users[rand(3)]!;
      const rows = Array.from({ length: 1 + rand(4) }, () => ({
        sourceId: `s${rand(5)}`,
        entities: Array.from({ length: rand(4) }, () => `Name ${rand(40)}`),
      }));
      batched.recordMentionsMany(scope, rows, i);
      each.recordMentionsMany(scope, rows, i);
      each.flush();
      if (i % 97 === 0) {
        const name = `name ${rand(40)}`;
        expect(batched.sourcesFor(scope, name)).toEqual(each.sourcesFor(scope, name));
      }
      if (i % 503 === 0) batched.flush();
    }
    for (const scope of users) {
      for (let n = 0; n < 40; n++)
        expect(batched.sourcesFor(scope, `name ${n}`)).toEqual(each.sourcesFor(scope, `name ${n}`));
      expect(batched.exportUser(scope)).toEqual(each.exportUser(scope));
    }
  });

  test("forget, export and import act on pending mentions too", () => {
    const map = new SourceMap(":memory:", { explore: false });
    map.recordMentions(alice, "crm", ["Dana Lee"], 5);
    map.recordMentions(alice, "mail", ["Dana Lee"], 5);
    map.recordMentions(bob, "crm", ["Dana Lee"], 5);
    expect(map.exportUser(alice).mention).toEqual([
      ["dana lee", "crm", 1, 5],
      ["dana lee", "mail", 1, 5],
    ]);
    map.recordMentions(alice, "crm", ["Globex"], 6);
    map.forget(alice, "crm");
    expect(map.sourcesFor(alice, "Globex")).toEqual([]);
    expect(map.sourcesFor(alice, "Dana Lee")).toEqual([{ sourceId: "mail", count: 1 }]);
    map.recordMentions(alice, "docs", ["stale"], 7);
    map.importUser(alice, { mention: [["kept", "mail", 3, 1]], utility: [], arms: [] });
    expect(map.sourcesFor(alice, "stale")).toEqual([]);
    expect(map.sourcesFor(alice, "kept")).toEqual([{ sourceId: "mail", count: 3 }]);
    map.recordMentions(alice, "docs", ["gone"], 8);
    map.forget(alice);
    expect(map.exportUser(alice)).toEqual({ mention: [], utility: [], arms: [] });
    expect(map.sourcesFor(bob, "Dana Lee")).toEqual([{ sourceId: "crm", count: 1 }]);
  });

  test("the timer writes a batch within its interval, and a full buffer writes at once", async () => {
    const path = fileOf();
    const map = new SourceMap(path, { explore: false, mentionFlushMs: 20 });
    map.recordMentions(alice, "crm", ["Dana Lee"], 1);
    expect(onDisk(path)).toEqual([]);
    await Bun.sleep(80);
    expect(onDisk(path).map((r) => r.count)).toEqual([1]);
    const slow = new SourceMap(fileOf(), { explore: false });
    // 4,096 distinct rows: written by the call that filled the buffer, no timer.
    const names = Array.from({ length: 4_096 }, (_, i) => `n${i}`);
    slow.recordMentionsMany(alice, [{ sourceId: "crm", entities: names }], 1);
    expect(onDisk((slow as unknown as { db: Database }).db.filename).length).toBe(4_096);
    map.close();
    slow.close();
  });

  test("a write the timer cannot make is counted and logged, never thrown, kept and retried until it lands", async () => {
    const map = new SourceMap(":memory:", { explore: false, mentionFlushMs: 5 });
    const db = (map as unknown as { db: { transaction: (f: () => void) => () => void } }).db;
    const real = db.transaction.bind(db);
    db.transaction = () => () => {
      throw new Error("SQLITE_BUSY");
    };
    const log = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      map.recordMentions(alice, "crm", ["Dana Lee"]);
      await Bun.sleep(40);
    } finally {
      console.error = log;
      db.transaction = real;
    }
    // Retried at the timer's interval while the lock held: every try failed and was counted.
    expect(map.failedFlushes).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(logged)).not.toContain("alice");
    expect(JSON.stringify(logged)).not.toContain("dana");
    // The lock cleared: the kept mention and a new one are written together.
    map.recordMentions(alice, "crm", ["Dana Lee"]);
    map.flush();
    expect(map.exportUser(alice).mention.map((r) => r.slice(0, 3))).toEqual([["dana lee", "crm", 2]]);
    expect(map.droppedMentionRows).toBe(0);
  });

  test("killed with a batch pending: the written rows survive whole, the pending batch alone is lost", async () => {
    const path = fileOf();
    const child = `
      const { SourceMap } = await import(${MODULE});
      const map = new SourceMap(process.argv[1], { explore: false });
      const scope = { tenantId: "t", userId: "alice" };
      map.recordMentionsMany(scope, [{ sourceId: "crm", entities: ["Dana Lee", "Acme"] }], 1);
      map.flush();
      map.recordMentionsMany(scope, [{ sourceId: "crm", entities: ["Dana Lee"] }, { sourceId: "mail", entities: ["Late"] }], 2);
      console.log("pending");
      await new Promise(() => {});
    `;
    const proc = Bun.spawn([process.execPath, "-e", child, path], { stdout: "pipe", stderr: "inherit" });
    const reader = proc.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("pending");
    proc.kill("SIGKILL");
    await proc.exited;
    const map = new SourceMap(path, { explore: false });
    expect(map.sourcesFor(alice, "Dana Lee")).toEqual([{ sourceId: "crm", count: 1 }]);
    expect(map.sourcesFor(alice, "Acme")).toEqual([{ sourceId: "crm", count: 1 }]);
    expect(map.sourcesFor(alice, "Late")).toEqual([]);
    map.close();
  });

  test("killed while batches are being written: the file is intact and holds whole batches only", async () => {
    const path = fileOf();
    // Each batch adds one to each of 300 rows in one transaction; a kill lands inside one at some point.
    const child = `
      const { SourceMap } = await import(${MODULE});
      const map = new SourceMap(process.argv[1], { explore: false });
      const scope = { tenantId: "t", userId: "alice" };
      const names = Array.from({ length: 300 }, (_, i) => "n" + i);
      let batches = 0;
      for (;;) {
        map.recordMentionsMany(scope, [{ sourceId: "crm", entities: names }], batches);
        map.flush();
        if (++batches === 20) console.log("writing");
      }
    `;
    const proc = Bun.spawn([process.execPath, "-e", child, path], { stdout: "pipe", stderr: "inherit" });
    const reader = proc.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("writing");
    await Bun.sleep(30);
    proc.kill("SIGKILL");
    await proc.exited;
    const db = new Database(path);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const counts = db.query("SELECT DISTINCT count FROM mention").all() as { count: number }[];
    const rows = (db.query("SELECT COUNT(*) AS n FROM mention").get() as { n: number }).n;
    db.close();
    expect(rows).toBe(300);
    expect(counts.length).toBe(1);
    expect(counts[0]!.count).toBeGreaterThanOrEqual(20);
  });

  test("maps never closed are collected, and their entries leave the exit registry", async () => {
    const before = SourceMap.openCount();
    const refs: WeakRef<SourceMap>[] = [];
    // In a function of its own, so no local of this frame holds a map when the collector runs.
    const make = () => {
      for (let i = 0; i < 20; i++) {
        const map = new SourceMap(i % 2 ? ":memory:" : fileOf(), { explore: false });
        map.flush();
        refs.push(new WeakRef(map));
      }
    };
    make();
    // Only the ten file-backed maps are registered (an in-memory map loses nothing at exit).
    expect(SourceMap.openCount()).toBe(before + 10);
    // Collection and the registry's callbacks run later than `gc()` returns: a few rounds, with turns between.
    for (let round = 0; round < 20 && SourceMap.openCount() > before; round++) {
      Bun.gc(true);
      await Bun.sleep(5);
    }
    expect(refs.filter((r) => r.deref() === undefined).length).toBeGreaterThanOrEqual(18);
    expect(SourceMap.openCount()).toBeLessThanOrEqual(before + 2);
    // A closed map leaves at once.
    const closed = new SourceMap(fileOf(), { explore: false });
    expect(SourceMap.openCount()).toBeGreaterThan(0);
    const now = SourceMap.openCount();
    closed.close();
    expect(SourceMap.openCount()).toBe(now - 1);
  });

  test("a full buffer the file refuses is kept for the retry, never thrown into the lookup (D1780's review)", () => {
    // probes/cap-busy.ts: the 4,096-row write threw SQLITE_BUSY into the caller's lookup and lost every user's rows.
    const map = new SourceMap(":memory:", { explore: false, mentionFlushMs: 60_000 });
    map.recordMentions(bob, "crm", ["Dana Lee"], 1);
    const db = (map as unknown as { db: { transaction: (f: () => void) => () => void } }).db;
    const real = db.transaction.bind(db);
    db.transaction = () => () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    const log = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    const names = Array.from({ length: 4_095 }, (_, i) => `n${i}`);
    try {
      expect(() => map.recordMentionsMany(alice, [{ sourceId: "crm", entities: names }], 2)).not.toThrow();
      expect(map.failedFlushes).toBe(1);
      // Kept, and read as before: bob's row and alice's, none written.
      expect(map.sourcesFor(bob, "Dana Lee")).toEqual([{ sourceId: "crm", count: 1 }]);
      expect(map.sourcesFor(alice, "n7")).toEqual([{ sourceId: "crm", count: 1 }]);
      // Further lookups do not each try the locked file again (the retry is the timer's) until the buffer reaches
      // the retention bound.
      map.recordMentionsMany(alice, [{ sourceId: "mail", entities: names.slice(0, 100) }], 3);
      expect(map.failedFlushes).toBe(1);
    } finally {
      console.error = log;
      db.transaction = real;
    }
    expect(JSON.stringify(logged)).not.toContain("alice");
    expect(JSON.stringify(logged)).not.toContain("dana");
    // The lock clears: the next flush writes every row kept, with its count.
    map.flush();
    expect(map.exportUser(bob).mention).toEqual([["dana lee", "crm", 1, 1]]);
    expect(map.exportUser(alice).mention.length).toBe(4_095 + 100);
    expect(map.droppedMentionRows).toBe(0);
  });

  test("a lock that never clears drops batches past the retention bound, counted, and memory stays bounded", () => {
    const map = new SourceMap(":memory:", { explore: false, mentionFlushMs: 60_000 });
    const db = (map as unknown as { db: { transaction: (f: () => void) => () => void } }).db;
    db.transaction = () => () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    const log = console.error;
    console.error = () => {};
    try {
      for (let lookup = 0; lookup < 40; lookup++) {
        const names = Array.from({ length: 1_000 }, (_, i) => `l${lookup}-${i}`);
        map.recordMentionsMany(alice, [{ sourceId: "crm", entities: names }], lookup);
        const held = (map as unknown as { mentionRows: number }).mentionRows;
        // 4 x 4,096 retained at most, plus the one lookup's rows that pushed it over.
        expect(held).toBeLessThanOrEqual(4 * 4_096 + 1_000);
      }
    } finally {
      console.error = log;
    }
    expect(map.droppedMentionRows).toBeGreaterThan(0);
    expect(map.failedFlushes).toBeGreaterThan(1);
    // Nothing is counted twice: every row recorded is held or dropped.
    const held = (map as unknown as { mentionRows: number }).mentionRows;
    expect(held + map.droppedMentionRows).toBe(40 * 1_000);
  });

  test("a process that exits without close writes its pending mentions", async () => {
    const path = fileOf();
    const child = `
      const { SourceMap } = await import(${MODULE});
      const map = new SourceMap(process.argv[1], { explore: false });
      map.recordMentions({ tenantId: "t", userId: "alice" }, "crm", ["Dana Lee"], 9);
    `;
    const proc = Bun.spawn([process.execPath, "-e", child, path], { stdout: "inherit", stderr: "inherit" });
    // Exits at once: the pending batch's timer does not hold the process open.
    expect(await proc.exited).toBe(0);
    expect(onDisk(path).map((r) => [r.entity, r.source_id, r.count, r.last_seen])).toEqual([["dana lee", "crm", 1, 9]]);
  });
});

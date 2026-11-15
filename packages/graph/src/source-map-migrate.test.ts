/**
 * D1960: a source-map file made before D1936 (rowid tables) is moved to the WITHOUT ROWID layout once, at open. The
 * move must keep every row and value and every answer (held to `source-map.reference.ts` on a copy), leave a valid
 * file in one layout or the other wherever it stops (an error between statements, a SIGKILL at each step and inside
 * a statement), keep a file it cannot move (locked, read-only, full, damaged, too large, other columns) working in
 * its old layout with one log line, never throw, and leave a moved file alone.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Xoshiro128 } from "@eden/primitives";
import { scopeKey } from "@eden/protocol";
import { MIGRATE_BUSY_MS, migrateLayout, SourceMap } from "./source-map";
import { differential, SCOPES } from "./source-map.fuzz";
import { SourceMap as ReferenceMap } from "./source-map.reference";

const dir = mkdtempSync(join(tmpdir(), "eden-map-migrate-"));
let files = 0;
const fileOf = () => join(dir, `m${files++}.db`);

const TABLES = ["mention", "utility", "planner_arm"] as const;
const KEYS = { mention: 3, utility: 3, planner_arm: 4 };
const STEPS = [
  "begin",
  ...TABLES.flatMap((t) => [`${t}:create`, `${t}:copy`, `${t}:drop`, `${t}:rename`]),
  "commit",
  "vacuum",
];

let logged: string[] = [];
let spy: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  logged = [];
  spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.join(" ")));
});
afterEach(() => spy?.mockRestore());

/** An old-layout file: the map before D1936 made it, a random stream of every call filled it, `extra` raw rows more. */
function oldFile(seed: number, extra: number): string {
  const path = fileOf();
  const opts = { seed, mentionFlushMs: 60_000 };
  const made = new ReferenceMap(path, opts);
  differential(
    seed,
    400,
    () => made,
    () => new ReferenceMap(":memory:", opts),
  );
  const db = new Database(path);
  const rng = new Xoshiro128(seed);
  const scope = () =>
    rng.uniform() < 0.5 ? scopeKey(SCOPES[rng.below(SCOPES.length)]!) : `t${rng.below(4)}/u${rng.below(50)}`;
  const m = db.query("INSERT OR IGNORE INTO mention (scope, entity, source_id, count, last_seen) VALUES (?,?,?,?,?)");
  const u = db.query("INSERT OR IGNORE INTO utility (scope, situation, source_id, shown, used) VALUES (?,?,?,?,?)");
  const a = db.query("INSERT OR IGNORE INTO planner_arm VALUES (?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < extra; i++) {
      const r = rng.uniform();
      if (r < 0.85) m.run(scope(), `name ${rng.below(1e6).toString(36)} é李`, `src${rng.below(9)}`, rng.below(99), i);
      else if (r < 0.97) u.run(scope(), `situation ${rng.below(30)}`, `src${rng.below(9)}`, 1 + rng.below(9), 0);
      else a.run(scope(), `src${rng.below(9)}`, rng.below(4), "and", 1 + rng.uniform(), 1 + rng.uniform());
    }
    // Values at the edges: a count past 2^31 and at 2^53, a real where an integer is declared, empty and astral text.
    m.run("edge/u", "", "s", 2 ** 53, -1);
    m.run("edge/u", "😀 zoë", "s", 2 ** 31 + 7, 0);
    m.run("edge/u", "real", "s", 2.5, 1.25);
    a.run("edge/u", "s", 0, "", 0.1 + 0.2, Number.MAX_VALUE);
  })();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  expect(layout(path)).toEqual(["rowid", "rowid", "rowid"]);
  return path;
}

/** Each map table's layout, from `PRAGMA table_list`. */
function layout(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const wr = new Map(
    (db.query("PRAGMA table_list").values() as [string, string, string, number, number][]).map((r) => [r[1], r[4]]),
  );
  db.close();
  return TABLES.map((t) => (wr.get(t) === 1 ? "without rowid" : wr.get(t) === 0 ? "rowid" : "missing"));
}

/** Every row of every table in key order, each value `quote`d (so 2 and 2.0 differ), and the file's integrity. */
function dump(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const out = [String(db.query("PRAGMA integrity_check").values()[0]![0])];
  const names = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").values().flat();
  out.push(names.join());
  for (const t of TABLES) {
    const cols = (db.query(`PRAGMA table_info(${t})`).values() as [number, string][]).map((r) => r[1]);
    const order = cols.slice(0, KEYS[t]).join(", ");
    const sql = `SELECT ${cols.map((c) => `quote(${c})`).join(" || ',' || ")} FROM ${t} ORDER BY ${order}`;
    for (const r of db.query(sql).values()) out.push(`${t}:${r[0]}`);
  }
  db.close();
  return out;
}

const rowsOf = (d: string[]) => d.length - 2;

/** The new map on `path` against the map before D1935 on a copy made now, over a random stream of every call. */
function answersAsReference(
  path: string,
  seed: number,
  steps = 500,
  open = () => new SourceMap(path, { seed, mentionFlushMs: 60_000 }),
) {
  const copy = fileOf();
  copyFileSync(path, copy);
  differential(seed, steps, open, () => new ReferenceMap(copy, { seed, mentionFlushMs: 60_000 }));
}

describe("migrateLayout (D1960)", () => {
  test("old-layout files of several sizes move at open with every row and value, and answer as the old map", () => {
    for (const [seed, extra] of [
      [1, 0],
      [2, 50],
      [3, 2_000],
      [4, 20_000],
    ] as const) {
      const path = oldFile(seed, extra);
      const before = dump(path);
      const copy = fileOf();
      copyFileSync(path, copy);
      const map = new SourceMap(path, { seed, mentionFlushMs: 60_000 });
      expect(layout(path)).toEqual(["without rowid", "without rowid", "without rowid"]);
      // Unordered reads (a user's rows as exportUser reads them) come back in the same order as the old file's.
      const raw = [new Database(path, { readonly: true }), new Database(copy, { readonly: true })];
      for (const s of [...SCOPES.map(scopeKey), "edge/u", "t1/u3"]) {
        for (const t of TABLES) {
          const [a, b] = raw.map((d) => d.query(`SELECT * FROM ${t} WHERE scope = ?`).values(s));
          expect(a).toEqual(b!);
        }
      }
      for (const d of raw) d.close();
      map.close();
      const after = dump(path);
      expect(after).toEqual(before);
      expect(rowsOf(after)).toBeGreaterThan(extra * 0.9);
      expect(logged.filter((l) => l.includes("moved to the WITHOUT ROWID layout"))).toHaveLength(1);
      expect(logged.at(-1)).toContain(`${rowsOf(before)} rows, compacted`);
      logged = [];
      // The moved file against the old map on the copy of the file before the move.
      differential(
        seed,
        600,
        () => new SourceMap(path, { seed, mentionFlushMs: 60_000 }),
        () => new ReferenceMap(copy, { seed, mentionFlushMs: 60_000 }),
      );
      expect(logged).toEqual([]); // a moved file is left alone
    }
  });

  test("the moved file is about half the old one once compacted", () => {
    const path = oldFile(5, 20_000);
    const before = statSync(path).size;
    new SourceMap(path).close();
    const after = statSync(path).size;
    expect(after / before).toBeLessThan(0.6);
  });

  test("idempotent: a new file and a moved one are `current`, with no log line and no byte written", () => {
    const fresh = fileOf();
    new SourceMap(fresh).close();
    const path = oldFile(6, 300);
    new SourceMap(path).close();
    logged = [];
    for (const f of [fresh, path]) {
      const bytes = readFileSync(f);
      const db = new Database(f);
      expect(migrateLayout(db)).toEqual({ status: "current" });
      db.close();
      new SourceMap(f).close();
      expect(readFileSync(f).equals(bytes)).toBe(true);
    }
    expect(logged).toEqual([]);
  });

  test("an error at any step leaves the file in one layout, every row in it, and the next open moves it", () => {
    const base = oldFile(7, 1_500);
    const before = dump(base);
    for (const at of STEPS) {
      const path = fileOf();
      copyFileSync(base, path);
      const db = new Database(path);
      db.exec("PRAGMA journal_mode = WAL");
      const lines: string[] = [];
      const result = migrateLayout(db, {
        log: (l) => lines.push(l),
        onStep: (s) => {
          if (s === at) throw new Error(`stopped at ${s}`);
        },
      });
      expect(lines).toHaveLength(1);
      if (at === "vacuum") {
        // Past the commit: moved, not compacted; the free pages are reused by later writes.
        expect(result.status).toBe("migrated");
        expect(lines[0]).toContain("not compacted (stopped at vacuum");
      } else {
        expect(result).toEqual({ status: "kept", reason: `stopped at ${at}` });
        expect(lines[0]).toContain("keeps its rowid layout");
      }
      db.close();
      const moved = at === "vacuum";
      expect(layout(path)).toEqual(Array(3).fill(moved ? "without rowid" : "rowid"));
      expect(dump(path)).toEqual(before);
      answersAsReference(path, 7, 150);
      expect(layout(path)).toEqual(Array(3).fill("without rowid"));
    }
  });

  test("a copy that lost a row is refused by the count, and a file another connection moved first is left alone", () => {
    // A row the copy skips (here a temp trigger ignores one insert; in the wild an index missing a row) fails the
    // count against the table itself, and the whole move rolls back.
    const path = oldFile(16, 500);
    const before = dump(path);
    const db = new Database(path);
    const lines: string[] = [];
    const lossy = migrateLayout(db, {
      log: (l) => lines.push(l),
      onStep: (s) => {
        if (s === "mention:copy") {
          db.exec(`CREATE TEMP TRIGGER skip BEFORE INSERT ON main.mention_new WHEN NEW.scope = 'edge/u'
            BEGIN SELECT RAISE(IGNORE); END`);
        }
      },
    });
    expect(lossy.status).toBe("kept");
    expect(lossy.reason).toMatch(/^mention: copied \d+ of \d+ rows$/);
    db.close();
    expect(dump(path)).toEqual(before);
    // Another process moves the file between this one's look and its lock: the second finds nothing to move.
    const late = new Database(path);
    const first = new Database(path);
    const raced = migrateLayout(late, {
      log: (l) => lines.push(l),
      onStep: (s) => {
        if (s === "begin") expect(migrateLayout(first, { log: (l) => lines.push(l) }).status).toBe("migrated");
      },
    });
    expect(raced).toEqual({ status: "current" });
    for (const d of [late, first]) d.close();
    expect(lines).toHaveLength(2); // the refused copy and the first process's move
    expect(dump(path)).toEqual(before);
  });

  test("a SIGKILL at each step, and inside the copy and the VACUUM, leaves a valid file in one layout", async () => {
    // Small for the steps (each killed exactly there), large for the kills inside a statement, so the statement is
    // still running when the parent's signal lands (60,000 rows: about 0.2 s of copy and 0.1 s of VACUUM).
    const bases = { self: oldFile(8, 1_500), parent: oldFile(15, 60_000) };
    const before = { self: dump(bases.self), parent: dump(bases.parent) };
    const script = `
      const { Database } = require("bun:sqlite");
      const { migrateLayout } = require(${JSON.stringify(join(import.meta.dir, "source-map.ts"))});
      const [path, at, mode] = process.argv.slice(1);
      const db = new Database(path);
      db.exec("PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
      migrateLayout(db, { log: () => {}, onStep: (s) => {
        if (s !== at) return;
        if (mode === "self") process.kill(process.pid, "SIGKILL");
        else require("node:fs").writeSync(1, s + "\\n");
      } });
      require("node:fs").writeSync(1, "done\\n");
    `;
    const runs = [
      ...STEPS.map((at) => [at, "self"] as const),
      ["mention:copy", "parent"] as const,
      ["vacuum", "parent"] as const,
    ];
    const run = async ([at, mode]: (typeof runs)[number]) => {
      const path = fileOf();
      copyFileSync(bases[mode], path);
      const child = Bun.spawn([process.execPath, "-e", script, path, at, mode], { stdout: "pipe", stderr: "pipe" });
      if (mode === "parent") {
        // Killed as soon as the step is reported: the signal lands inside its statement or just after.
        const reader = child.stdout.getReader();
        let seen = "";
        while (!seen.includes("\n")) {
          const { value, done } = await reader.read();
          if (done) break;
          seen += new TextDecoder().decode(value);
        }
        child.kill("SIGKILL");
      }
      await child.exited;
      return { path, at, mode, signal: child.signalCode, code: child.exitCode };
    };
    // The step kills together; the two inside a statement after them, alone, so the parent's signal is not late.
    const outcomes = await Promise.all(runs.filter((r) => r[1] === "self").map(run));
    for (const r of runs.filter((r) => r[1] === "parent")) outcomes.push(await run(r));
    for (const { path, at, mode, signal, code } of outcomes) {
      // Under a heavy load the parent's signal can still land after the child finished the move (exit 0); the file is
      // checked the same either way.
      if (mode === "self" || code !== 0) expect([at, mode, signal]).toEqual([at, mode, "SIGKILL"]);
      const l = layout(path);
      const moved = at === "vacuum" || (mode === "parent" && l[0] === "without rowid");
      expect([at, l]).toEqual([at, Array(3).fill(moved ? "without rowid" : "rowid")]);
      expect(dump(path)).toEqual(before[mode]);
      if (mode === "self") answersAsReference(path, 8, 150);
      else new SourceMap(path).close(); // the next open finishes the move
      expect(layout(path)).toEqual(Array(3).fill("without rowid"));
    }
  }, 60_000);

  test("a file locked by another connection keeps its layout after a bounded wait, answers as the old map, and moves later", () => {
    const path = oldFile(9, 500);
    const before = dump(path);
    const holder = new Database(path);
    holder.exec(`PRAGMA busy_timeout = 0; BEGIN IMMEDIATE`);
    const started = performance.now();
    const map = new SourceMap(path, { seed: 9, mentionFlushMs: 60_000 });
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(MIGRATE_BUSY_MS * 0.9);
    expect(waited).toBeLessThan(MIGRATE_BUSY_MS + 1_500);
    holder.exec("ROLLBACK");
    holder.close();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("keeps its rowid layout (D1960; it works as before): database is locked");
    expect(layout(path)).toEqual(["rowid", "rowid", "rowid"]);
    expect(dump(path)).toEqual(before);
    // The old layout served by the new map, against the old map on a copy (D1936's guarantee, still needed).
    answersAsReference(path, 9, 500, () => map);
    expect(layout(path)).toEqual(["rowid", "rowid", "rowid"]);
    new SourceMap(path).close();
    expect(layout(path)).toEqual(["without rowid", "without rowid", "without rowid"]);
  });

  test("read-only, full and damaged files are kept as they were, with one line and no throw", () => {
    // Read-only (a connection that cannot write: the file's mode does not stop root, so the open says so).
    const ro = oldFile(10, 500);
    const roBytes = readFileSync(ro);
    const roDb = new Database(ro, { readonly: true });
    const lines: string[] = [];
    expect(migrateLayout(roDb, { log: (l) => lines.push(l) }).status).toBe("kept");
    roDb.close();
    expect(readFileSync(ro).equals(roBytes)).toBe(true);

    // Full: the disk (here the connection's page limit) refuses the copy part way; the transaction rolls back.
    const full = oldFile(11, 3_000);
    const fullBefore = dump(full);
    const fullDb = new Database(full);
    fullDb.exec("PRAGMA journal_mode = WAL");
    const pages = fullDb.query("PRAGMA page_count").values()[0]![0] as number;
    fullDb.exec(`PRAGMA max_page_count = ${pages + 5}`);
    expect(migrateLayout(fullDb, { log: (l) => lines.push(l) }).status).toBe("kept");
    // The connection still reads and writes in the old layout.
    fullDb.query("UPDATE mention SET count = count WHERE scope = 'edge/u'").run();
    fullDb.close();
    expect(dump(full)).toEqual(fullBefore);

    // Damaged: pages past the schema overwritten. The open must not throw; the file is not touched.
    const bad = oldFile(12, 5_000);
    const size = statSync(bad).size;
    const fd = openSync(bad, "r+");
    for (let page = 3; page * 4096 < size; page += 7) writeSync(fd, Buffer.alloc(512, 0xa5), 0, 512, page * 4096 + 100);
    closeSync(fd);
    const badBytes = readFileSync(bad);
    const map = new SourceMap(bad);
    map.close();
    expect(readFileSync(bad).equals(badBytes)).toBe(true);

    // Too large to move at open, and a file with columns the map does not know (an October 27 file's `last_ref`).
    const big = oldFile(13, 100);
    const bigDb = new Database(big);
    expect(migrateLayout(bigDb, { log: (l) => lines.push(l), maxPages: 1 }).status).toBe("kept");
    bigDb.close();
    const odd = fileOf();
    const oddDb = new Database(odd);
    oddDb.exec(`CREATE TABLE mention (scope TEXT NOT NULL, entity TEXT NOT NULL, source_id TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, last_ref TEXT, last_seen INTEGER NOT NULL, PRIMARY KEY (scope, entity, source_id))`);
    expect(migrateLayout(oddDb, { log: (l) => lines.push(l) }).status).toBe("kept");
    oddDb.close();

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("readonly");
    expect(lines[1]).toContain("full");
    expect(lines[2]).toContain("more than the 1 moved at open");
    expect(lines[3]).toContain("mention has the columns scope, entity, source_id, count, last_ref, last_seen");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("keeps its rowid layout (D1960; it works as before): database disk image is malformed");
  });

  test("other connections open during the move: an old map writing and reading, and a reader in a transaction", () => {
    const path = oldFile(14, 1_000);
    const copy = fileOf();
    copyFileSync(path, copy);
    const opts = { seed: 14, explore: false, mentionFlushMs: 60_000 };
    // The old map (an older process on the same file) opened before the move, with writes buffered across it.
    const oldMap = new ReferenceMap(path, opts);
    const oldTwin = new ReferenceMap(copy, opts);
    const alice = SCOPES[0]!;
    for (const m of [oldMap, oldTwin]) {
      m.recordMentions(alice, "crm", ["Dana Lee", "Globex"], 5);
      m.recordOutcome(alice, "planning", "crm", true);
    }
    const reader = new Database(path);
    const read = reader.query("SELECT count(*) FROM mention");
    reader.exec("BEGIN");
    const seen = read.values()[0]![0];
    const map = new SourceMap(path, opts);
    expect(layout(path)).toEqual(["without rowid", "without rowid", "without rowid"]);
    expect(read.values()[0]![0]).toBe(seen); // its snapshot, unchanged
    reader.exec("COMMIT");
    expect(read.values()[0]![0]).toBe(seen);
    reader.close();
    // Both connections now answer as two old maps on the copy do, through a random stream on each.
    const twin = new ReferenceMap(copy, opts);
    const rng = new Xoshiro128(14);
    for (let i = 0; i < 400; i++) {
      const w = rng.below(2);
      const scope = SCOPES[rng.below(3)]!;
      const [a, b] = w === 0 ? [map, twin] : [oldMap, oldTwin];
      const r = rng.uniform();
      const source = `s${rng.below(3)}`;
      if (r < 0.3) for (const m of [a, b]) m.recordMentions(scope, source, ["Dana Lee", `n${i % 7}`], i);
      else if (r < 0.45) for (const m of [a, b]) m.recordOutcome(scope, "planning", `s${i % 3}`, i % 2 === 0);
      else if (r < 0.55) for (const m of [a, b]) m.flush();
      else if (r < 0.75) expect(a.sourcesFor(scope, "dana lee")).toEqual(b.sourcesFor(scope, "dana lee"));
      else {
        const req = {
          scope,
          entities: ["Dana Lee", `n${i % 7}`],
          situation: "planning",
          sourceIds: ["s0", "s1", "s2", "crm"],
          limit: 4,
        };
        expect(a.route(req)).toEqual(b.route(req));
      }
    }
    for (const m of [map, oldMap, twin, oldTwin]) m.close();
    expect(dump(path).slice(2)).toEqual(dump(copy).slice(2));
  });
});

describe("migrateLayout's bounds (D1960: disk room, time, other schema)", () => {
  const big = () => 1e15;
  const walSize = (path: string) => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
  const wait = (ms: number) => {
    const until = performance.now() + ms;
    while (performance.now() < until);
  };

  test("a disk without room for the move and its VACUUM keeps the file as it was, with one line", () => {
    const path = oldFile(17, 3_000);
    const bytes = readFileSync(path);
    // The test's files and SQLite's temp directory are one filesystem here (both under TMPDIR): twice the file
    // and the 4 MiB reserve. Just short of it is refused; just over it moves.
    const need = 2 * bytes.length + 4 * 2 ** 20;
    const lines: string[] = [];
    const db = new Database(path);
    const short = migrateLayout(db, { log: (l) => lines.push(l), freeBytes: () => need - 4096 });
    expect(short.status).toBe("kept");
    expect(short.reason).toMatch(/MiB free beside it, short of the [\d.]+ MiB the move needs$/);
    expect(lines).toHaveLength(1);
    db.close();
    expect(readFileSync(path).equals(bytes)).toBe(true);
    const db2 = new Database(path);
    expect(migrateLayout(db2, { log: (l) => lines.push(l), freeBytes: () => need + 4096 }).status).toBe("migrated");
    db2.close();
    // A free-space query that fails is no room.
    const db3 = new Database(oldFile(18, 100));
    const unknown = migrateLayout(db3, {
      log: (l) => lines.push(l),
      freeBytes: () => {
        throw new Error("statfs refused");
      },
    });
    db3.close();
    expect(unknown).toEqual({ status: "kept", reason: "free space unknown (statfs refused)" });
  });

  test("a VACUUM that fails after the commit still truncates the WAL; writes work; a later open with room compacts", () => {
    const path = oldFile(19, 30_000);
    const before = dump(path);
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL");
    const lines: string[] = [];
    const moved = migrateLayout(db, {
      log: (l) => lines.push(l),
      freeBytes: big,
      onStep: (s) => {
        if (s === "vacuum") throw new Error("database or disk is full");
      },
    });
    expect(moved.status).toBe("migrated");
    expect(lines[0]).toContain("not compacted (database or disk is full; later writes reuse its free pages");
    expect(walSize(path)).toBe(0);
    const pages = db.query("PRAGMA page_count").values()[0]![0] as number;
    const loose = db.query("PRAGMA freelist_count").values()[0]![0] as number;
    expect(loose).toBeGreaterThan(pages * 0.4);
    db.close();
    // No room yet: one line, the file untouched, and the map reads and writes it.
    const bytes = readFileSync(path);
    const noRoom = new Database(path);
    expect(migrateLayout(noRoom, { log: (l) => lines.push(l), freeBytes: () => 0 }).status).toBe("kept");
    noRoom.close();
    expect(lines[1]).toContain("is not compacted (D1960; it works as before): 0.0 MiB free beside it");
    expect(readFileSync(path).equals(bytes)).toBe(true);
    // Room again: compacted once, every row kept, then left alone.
    new SourceMap(path).close();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/compacted \(D1960\): \d+ free pages of \d+, \d+ ms$/);
    expect(statSync(path).size).toBeLessThan(bytes.length * 0.5);
    expect(dump(path)).toEqual(before);
    answersAsReference(path, 19, 150);
    expect(logged).toHaveLength(1);
  });

  test("the time budget: a copy past it rolls back between batches, and a slow move skips its VACUUM", () => {
    // 20,000 rows: five batches of the mention copy. The step waits out the budget, so the clock read after the
    // first batch is past it.
    const path = oldFile(20, 20_000);
    const before = dump(path);
    const lines: string[] = [];
    const db = new Database(path);
    const late = migrateLayout(db, {
      log: (l) => lines.push(l),
      budgetMs: 200,
      onStep: (s) => {
        if (s === "mention:copy") wait(210);
      },
    });
    expect(late.status).toBe("kept");
    expect(late.reason).toMatch(/^over the 200 ms a move may take at open \(\d+ ms, mention:copy\)$/);
    expect(lines[0]).toContain("keeps its rowid layout");
    db.close();
    expect(layout(path)).toEqual(["rowid", "rowid", "rowid"]);
    expect(dump(path)).toEqual(before);
    // Past half the budget at the commit: moved, not compacted; the next open compacts it.
    const db2 = new Database(path);
    const slow = migrateLayout(db2, {
      log: (l) => lines.push(l),
      budgetMs: 2_000,
      onStep: (s) => {
        if (s === "commit") wait(1_010);
        if (s === "vacuum") throw new Error("the VACUUM ran");
      },
    });
    db2.close();
    expect(slow.status).toBe("migrated");
    expect(lines[1]).toMatch(/not compacted \(the move took \d+ ms; a later open compacts it\)/);
    expect(walSize(path)).toBe(0);
    new SourceMap(path).close();
    expect(logged.at(-1)).toContain("compacted (D1960)");
    expect(dump(path)).toEqual(before);
  });

  test("keys a JS round trip would change (invalid UTF-8, a lone surrogate) at a batch boundary move with every row", () => {
    // The batch's last key is read in SQL: read into JS, text that is not valid UTF-8 came back as U+FFFD and the
    // next batch skipped rows (the count check kept the file at every open, D1960's second review).
    for (const mode of ["invalid-utf8", "lone-surrogate"]) {
      const path = fileOf();
      const db = new Database(path);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec(`CREATE TABLE mention (scope TEXT NOT NULL, entity TEXT NOT NULL, source_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL, PRIMARY KEY (scope, entity, source_id))`);
      const add = db.query("INSERT INTO mention VALUES (?, ?, ?, ?, ?)");
      for (let i = 0; i < 4_095; i++) add.run(`a${String(i).padStart(5, "0")}`, "e", "x", 1, 1);
      if (mode === "invalid-utf8") db.exec("INSERT INTO mention VALUES (CAST(x'c3' AS TEXT), 'e', 'x', 1, 1)");
      else add.run("\ud800", "e", "x", 1, 1);
      for (let i = 0; i < 100; i++) add.run(`é${i}`, "e", "x", 1, 1);
      for (let i = 0; i < 100; i++) add.run(`\ud7ff${i}`, "e", "x", 1, 1);
      const before = db.query("SELECT hex(scope) FROM mention ORDER BY scope").values();
      const result = migrateLayout(db, { log: () => {}, freeBytes: () => 1e15 });
      expect(result).toEqual({ status: "migrated", rows: 4_296 });
      expect(db.query("SELECT hex(scope) FROM mention ORDER BY scope").values()).toEqual(before);
      db.close();
    }
  });

  test("an index, trigger or view made outside Eden on the tables keeps the layout, with one line naming it", () => {
    const cases = [
      ["index", "CREATE INDEX by_source ON mention (source_id)"],
      ["trigger", "CREATE TRIGGER audit AFTER INSERT ON utility BEGIN SELECT 1; END"],
      ["view", "CREATE VIEW counts AS SELECT scope, sum(count) FROM mention GROUP BY scope"],
      ["trigger", "CREATE TABLE log (x); CREATE TRIGGER other AFTER INSERT ON log BEGIN DELETE FROM planner_arm; END"],
    ] as const;
    for (const [type, sql] of cases) {
      const path = oldFile(21, 200);
      const setup = new Database(path);
      setup.exec(sql);
      setup.close();
      const before = dump(path);
      const lines: string[] = [];
      const db = new Database(path);
      const result = migrateLayout(db, { log: (l) => lines.push(l) });
      db.close();
      expect(result.status).toBe("kept");
      expect(result.reason).toMatch(new RegExp(`^${type} \\w+ not made by Eden names its tables`));
      expect(lines).toHaveLength(1);
      expect(dump(path)).toEqual(before);
      // The map still reads and writes it, and leaves the user's schema alone.
      answersAsReference(path, 21, 100);
      expect(layout(path)).toEqual(["rowid", "rowid", "rowid"]);
    }
  });

  test("migrate.ts: a file without the map's tables says so and exits 1; a moved file exits 0", () => {
    const empty = fileOf();
    new Database(empty).close();
    const cli = join(import.meta.dir, "migrate.ts");
    const run = (file: string) => Bun.spawnSync([process.execPath, cli, file], { stdout: "pipe", stderr: "pipe" });
    const none = run(empty);
    expect(none.exitCode).toBe(1);
    expect(none.stderr.toString()).toContain(`eden: ${empty}: no source-map tables`);
    const old = oldFile(22, 100);
    const moved = run(old);
    expect(moved.exitCode).toBe(0);
    expect(moved.stdout.toString()).toContain("moved to the WITHOUT ROWID layout");
    const again = run(old);
    expect(again.exitCode).toBe(0);
    expect(again.stdout.toString()).toContain("already has the WITHOUT ROWID layout");
  });

  // On a real small filesystem (a tmpfs, where this runs as root and may mount one): the review's case, a nearly
  // full disk. Everything SQLite writes, its VACUUM temp file included, is on the tmpfs (the child's TMPDIR).
  const mountable = process.platform === "linux" && process.getuid?.() === 0 && tryMount();
  test.skipIf(!mountable)(
    "on a nearly full tmpfs: kept by the real free space, writes work, compacted once there is room",
    () => {
      const mnt = mkdtempSync(join(tmpdir(), "eden-map-tmpfs-"));
      expect(Bun.spawnSync(["mount", "-t", "tmpfs", "-o", "size=24m", "tmpfs", mnt]).exitCode).toBe(0);
      try {
        const path = join(mnt, "map.db");
        copyFileSync(oldFile(23, 100_000), path);
        const before = dump(path);
        const size = statSync(path).size;
        const filler = join(mnt, "filler");
        const fill = (free: number) => {
          const s = statfsSync(mnt);
          const now = s.bavail * s.bsize + (existsSync(filler) ? statSync(filler).size : 0);
          writeFileSync(filler, Buffer.alloc(Math.max(0, Math.round(now - free))));
        };
        const child = (code: string) => {
          const r = Bun.spawnSync([process.execPath, "-e", code, path], {
            env: { ...process.env, TMPDIR: mnt, SQLITE_TMPDIR: mnt },
            stdout: "pipe",
            stderr: "pipe",
          });
          return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
        };
        const src = JSON.stringify(join(import.meta.dir, "source-map.ts"));
        // Writes through the map, enough to need new pages, then a read back.
        const writes = `
        const { SourceMap } = require(${src});
        const map = new SourceMap(process.argv[1], { mentionFlushMs: 60_000 });
        const scope = { tenantId: "t", userId: "u" };
        for (let i = 0; i < 2000; i++) map.recordMentions(scope, "crm", ["new name " + i]);
        map.recordOutcome(scope, "planning", "crm", true);
        map.flush();
        console.log(JSON.stringify(map.sourcesFor(scope, "new name 1999")));
        map.close();`;
        // The review's probe: an old file with 0.7x its size free. Kept by the real statfs; the map writes it.
        fill(size * 0.7);
        const kept = child(writes);
        expect(kept.err).toContain("keeps its rowid layout (D1960; it works as before)");
        expect(kept.err).toContain("free beside it, short of the");
        expect(kept.err).not.toContain("failed");
        expect(kept.out).toContain('"crm"');
        expect(kept.code).toBe(0);
        expect(layout(path)).toEqual(["rowid", "rowid", "rowid"]);
        // Forced past the check (as if the disk filled during the move) with room for the move but not its VACUUM:
        // moved and committed, the VACUUM refused by the full disk, the WAL truncated; the map still writes.
        fill(size * 1.25);
        const forced = child(`
        const { Database } = require("bun:sqlite");
        const { migrateLayout } = require(${src});
        const db = new Database(process.argv[1]);
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
        const r = migrateLayout(db, { freeBytes: () => 1e15, log: (l) => console.log(l) });
        console.log(JSON.stringify(r));
        db.close();`);
        expect(forced.out).toContain('"status":"migrated"');
        expect(forced.out).toContain("not compacted (database or disk is full");
        expect(walSize(path)).toBe(0);
        const loose = child(writes);
        expect(loose.err).toContain("is not compacted (D1960; it works as before)");
        expect(loose.err).not.toContain("failed");
        expect(loose.out).toContain('"crm"');
        // Room again: the next open compacts it.
        rmSync(filler);
        const room = child(writes);
        expect(room.err).toMatch(/compacted \(D1960\): \d+ free pages/);
        expect(room.code).toBe(0);
        expect(layout(path)).toEqual(["without rowid", "without rowid", "without rowid"]);
        expect(statSync(path).size).toBeLessThan(size * 0.7);
        const after = dump(path);
        expect(after[0]).toBe("ok");
        // Every row from before is still there; the writes added rows for one new user only.
        const key = `'${scopeKey({ tenantId: "t", userId: "u" })}'`;
        const mine = (r: string) => r.includes(key);
        expect(after.filter((r) => !mine(r))).toEqual(before.filter((r) => !mine(r)));
        expect(after.filter(mine).length).toBeGreaterThan(2000);
      } finally {
        Bun.spawnSync(["umount", mnt]);
        rmSync(mnt, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

/** Whether a tmpfs can be mounted here (root on Linux, and a container that allows it). */
function tryMount(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "eden-map-probe-"));
  try {
    if (Bun.spawnSync(["mount", "-t", "tmpfs", "-o", "size=1m", "tmpfs", probe]).exitCode !== 0) return false;
    Bun.spawnSync(["umount", probe]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

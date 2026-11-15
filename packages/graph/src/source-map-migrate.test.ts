/**
 * D1960: a source-map file made before D1936 (rowid tables) is moved to the WITHOUT ROWID layout once, at open. The
 * move must keep every row and value and every answer (held to `source-map.reference.ts` on a copy), leave a valid
 * file in one layout or the other wherever it stops (an error between statements, a SIGKILL at each step and inside
 * a statement), keep a file it cannot move (locked, read-only, full, damaged, too large, other columns) working in
 * its old layout with one log line, never throw, and leave a moved file alone.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, openSync, readFileSync, statSync, writeSync, closeSync } from "node:fs";
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

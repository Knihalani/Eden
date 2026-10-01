import { describe, expect, test } from "bun:test";
import { openDb } from "./db";

/**
 * The ingest path guards with read-then-insert everywhere it counts, and
 * counts are what trip the knock threshold — so the database constraints,
 * not the reads, are what keep one observed stretch looking like one. These
 * tests pin the constraints themselves; the concurrency they exist for cannot
 * be reproduced deterministically on SQLite's serialized writer.
 */
describe("ingest uniqueness constraints", () => {
  test("the same island observation in one run is stored once", async () => {
    const db = await openDb(`/tmp/eden-uniq-stretch-${Date.now()}.db`);
    await db.run(
      `INSERT OR IGNORE INTO stretch (id, workspace_id, run_id, fingerprint, steps, island_index) VALUES ` +
        `(?, ?, ?, ?, ?, ?)`,
      ["s1", "ws_local", "run1", "fp", "[]", 0],
    );
    // A concurrent ingest would insert a different id for the same
    // (workspace, run, fingerprint, island_index); the unique index must
    // swallow it rather than double-count toward the knock threshold.
    await db.run(
      `INSERT OR IGNORE INTO stretch (id, workspace_id, run_id, fingerprint, steps, island_index) VALUES ` +
        `(?, ?, ?, ?, ?, ?)`,
      ["s2", "ws_local", "run1", "fp", "[]", 0],
    );
    const n = (await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM stretch`))?.c;
    expect(n).toBe(1);
  });

  test("one tool row per workspace fingerprint", async () => {
    const db = await openDb(`/tmp/eden-uniq-tool-${Date.now()}.db`);
    const tool = (id: string) =>
      `INSERT OR IGNORE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES ('${id}', 'ws_local', 't_${id}', 'x', 'draft', '[]', '[]', 'shared_fp')`;
    await db.exec(tool("a"));
    await db.exec(tool("b"));
    const rows = await db.all<{ id: string }>(`SELECT id FROM tool WHERE fingerprint = 'shared_fp'`);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  test("different workspaces may hold the same fingerprint", async () => {
    const db = await openDb(`/tmp/eden-uniq-tenant-${Date.now()}.db`);
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES ('a', 'ws_a', 'same', 'x', 'draft', '[]', '[]', 'fp')`,
    );
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES ('b', 'ws_b', 'same', 'x', 'draft', '[]', '[]', 'fp')`,
    );
    const n = (await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool`))?.c;
    expect(n).toBe(2); // one per workspace — tenancy preserved
  });
});

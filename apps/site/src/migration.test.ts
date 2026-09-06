import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * M9 regression: a database from an older schema used to brick startup —
 * baseline index DDL named tool_run.created_at BEFORE migrate() added the
 * column, so `eden` crashed on first run after upgrade. Booting against a
 * legacy-shaped file must succeed and backfill the column.
 */
describe("legacy database migration", () => {
  test("a pre-created_at tool_run table boots and gains the column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-mig-"));
    try {
      // Shape the table as an OLD install had it: no created_at anywhere.
      const seed = [
        "CREATE TABLE tool_run (id TEXT PRIMARY KEY, tool_id TEXT, steps_attempted INTEGER);",
        "INSERT INTO tool_run (id, tool_id, steps_attempted) VALUES ('r1','t1',3);",
      ];
      const dbFile = join(dir, "old.db");
      // Create via bun:sqlite to avoid needing the sqlite3 CLI.
      const { Database } = await import("bun:sqlite");
      {
        const raw = new Database(dbFile) as unknown as { exec(s: string): void; close(): void };
        for (const stmt of seed) raw.exec(stmt);
        raw.close();
      }
      process.env.EDEN_DB = dbFile;
      const { openDb } = await import("./db");
      const db = await openDb(dbFile);
      // Column exists post-boot (migrate backfilled it).
      const row = await db.get<{ created_at: number | null }>(`SELECT created_at FROM tool_run WHERE id = 'r1'`);
      expect(row).toBeDefined();
      expect(row!.created_at).toBe(0); // legacy rows stay lifetime-history
    } finally {
      delete process.env.EDEN_DB;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh directory boots cleanly too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-mig-fresh-"));
    try {
      process.env.EDEN_DB = join(dir, "new.db");
      const { openDb } = await import("./db");
      const db = await openDb(join(dir, "new.db"));
      const one = await db.get<{ one: number }>(`SELECT 1 as one`);
      expect(one).toEqual({ one: 1 });
    } finally {
      delete process.env.EDEN_DB;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

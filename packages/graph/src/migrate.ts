/**
 * `bun packages/graph/src/migrate.ts FILE…`: moves source-map files to the WITHOUT ROWID layout with no size bound
 * and no time bound (D1960). The servers move a file at open up to `MIGRATE_MAX_PAGES` and `MIGRATE_BUDGET_MS`; a
 * larger or slower one keeps its layout and works as before, and an operator who wants its halved size runs this
 * with the server stopped (the move holds the file's write lock for its whole length, about 0.1 ms a page). A moved
 * file its VACUUM skipped is compacted. It still needs the disk room the open checks. Exit 1 if any file was kept as
 * it was or holds no source-map table.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { migrateLayout } from "./source-map";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: bun packages/graph/src/migrate.ts FILE…");
  process.exit(2);
}
let failed = 0;
for (const file of files) {
  // Never create a file: a typo would leave an empty database behind.
  if (!existsSync(file)) {
    console.error(`eden: ${file}: no such file`);
    failed++;
    continue;
  }
  const db = new Database(file);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    // A file that is not a source map (no table of the map's) is reported as such, not as already moved.
    const tables = new Set(
      db
        .query("PRAGMA main.table_list")
        .values()
        .map((r) => r[1]),
    );
    if (!["mention", "utility", "planner_arm"].some((t) => tables.has(t))) {
      console.error(`eden: ${file}: no source-map tables`);
      failed++;
      continue;
    }
    const result = migrateLayout(db, {
      maxPages: Number.POSITIVE_INFINITY,
      budgetMs: Number.POSITIVE_INFINITY,
      log: (line) => console.log(line),
    });
    if (result.status === "current") console.log(`eden: source map ${file} already has the WITHOUT ROWID layout`);
    if (result.status === "kept") failed++;
  } finally {
    db.close();
  }
}
process.exit(failed > 0 ? 1 : 0);

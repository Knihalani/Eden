/**
 * P0.6: the postings `relevant` ranks from hold only rows it can score (at most 12 needles). Long rows, tool results
 * and narratives, used to be tokenized whole at every Submit and to fill the candidate pool with rows that never rank.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("forty long rows sharing a fact's words do not crowd the fact out of the candidate pool", () => {
  const dir = mkdtempSync(join(tmpdir(), "eden-postings-"));
  dirs.push(dir);
  const mem = openMemory({ dir, session: "s1", perRepo: true });
  for (let i = 0; i < 40; i++)
    mem.remember(
      `Migration log ${i}: the database postgres replica ${i} reported lag, vacuum ran on tables orders users ` +
        `payments invoices sessions audit events, then the pooler restarted and checkpoints resumed normally.`,
      { kind: "episode", lane: "narrative", tags: ["src:tool"] },
    );
  mem.remember("The database is postgres.", { kind: "fact", tags: ["src:user"] });
  const found = mem.relevant("which database do we use, postgres?").map((row) => row.text);
  expect(found).toContain("The database is postgres.");
  mem.close();
});

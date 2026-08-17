import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolEvent } from "@eden/core";
import { openDb, type EdenDb } from "./db";
import { ingest } from "./cluster";

/**
 * Fingerprints are derived from URL *shape*, so two tenants hitting the same
 * public API produce the same fingerprint by construction. With `fingerprint`
 * as a global primary key that was not a hash collision to shrug at — it was
 * one tenant's row being overwritten by another's.
 */

function events(runId: string, urls: string[]): ToolEvent[] {
  return urls.map((url, i) => {
    const command = `curl ${url}`;
    return { event_id: `${runId}-${i}`, seq: i, name: "Bash", args: { command }, command, ok: true };
  }) as ToolEvent[];
}

// A shape both tenants would plausibly record: the same public API, same
// endpoints. That is the collision, and it is not a hash accident.
const SHARED = [
  "https://api.github.com/repos/acme/app/issues/12",
  "https://api.github.com/repos/acme/app/issues/12/comments",
];

describe("cluster rows are per workspace", () => {
  let dir: string;
  let db: EdenDb;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_AUTO_APPROVE"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-tenancy-"));
    db = await openDb(join(dir, "t.db"));
    await db.run(`INSERT OR IGNORE INTO workspace (id, name) VALUES (?, ?)`, ["ws_a", "a"]);
    await db.run(`INSERT OR IGNORE INTO workspace (id, name) VALUES (?, ?)`, ["ws_b", "b"]);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = () =>
    db.all<{ fingerprint: string; workspace_id: string; count: number }>(
      `SELECT fingerprint, workspace_id, count FROM cluster ORDER BY workspace_id`,
    );

  test("two tenants running the same sequence get their own rows", async () => {
    await ingest(db, "ws_a", "run-a1", events("a1", SHARED), true);
    await ingest(db, "ws_b", "run-b1", events("b1", SHARED), true);
    const all = await rows();
    expect(all.map((r) => r.workspace_id).sort()).toEqual(["ws_a", "ws_b"]);
    // Same shape, same fingerprint — that is expected and must not collide.
    expect(new Set(all.map((r) => r.fingerprint)).size).toBe(1);
  });

  test("one tenant's ingest cannot reset another's count", async () => {
    // The precise failure: B's upsert landed in A's row and rewrote count to 1,
    // so A never reached the knock threshold. A cross-tenant denial of the
    // product's core feature.
    await ingest(db, "ws_a", "run-a1", events("a1", SHARED), true);
    await ingest(db, "ws_b", "run-b1", events("b1", SHARED), true);
    await ingest(db, "ws_a", "run-a2", events("a2", SHARED), true);

    const all = await rows();
    const a = all.find((r) => r.workspace_id === "ws_a");
    const b = all.find((r) => r.workspace_id === "ws_b");
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  test("reaching the threshold creates exactly one knock, for the right tenant", async () => {
    await ingest(db, "ws_a", "run-a1", events("a1", SHARED), true);
    await ingest(db, "ws_a", "run-a2", events("a2", SHARED), true);
    // A third ingest must not create a second knock; the count is now past 2,
    // which the old `=== 2` test would have missed entirely.
    await ingest(db, "ws_a", "run-a3", events("a3", SHARED), true);

    const knocks = await db.all<{ workspace_id: string }>(`SELECT workspace_id FROM knock`);
    expect(knocks).toHaveLength(1);
    expect(knocks[0]!.workspace_id).toBe("ws_a");
  });

  test("a tenant that only ever ingests once gets no knock", async () => {
    await ingest(db, "ws_b", "run-b1", events("b1", SHARED), true);
    expect(await db.all(`SELECT id FROM knock`)).toHaveLength(0);
  });

  test("tools stay scoped to the workspace that recorded them", async () => {
    await ingest(db, "ws_a", "run-a1", events("a1", SHARED), true);
    await ingest(db, "ws_b", "run-b1", events("b1", SHARED), true);
    const tools = await db.all<{ workspace_id: string }>(`SELECT workspace_id FROM tool`);
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tools.map((t) => t.workspace_id))).toEqual(new Set(["ws_a", "ws_b"]));
  });
});

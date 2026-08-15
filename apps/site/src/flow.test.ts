import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { ingest } from "./cluster";
import { playTool } from "./playback";
import type { ToolEvent } from "@eden/core";

function ev(i: number, command: string): ToolEvent {
  return {
    event_id: `e${i}-${command}-${Date.now()}`,
    seq: i,
    name: "Bash",
    args: { command },
    command,
    ok: true,
  };
}

describe("ingest → draft → approve → play", () => {
  const dbP = openDb(`/tmp/eden-int-${Date.now()}.db`);
  afterAll(async () => {
    /* file db */
  });

  test("silent draft on run 1, knock on run 2", async () => {
    const db = await dbP;
    const island = [
      ev(1, "gh pr view 12 --json title"),
      ev(2, "curl https://api.github.com/repos/acme/app/issues/12/comments"),
      ev(3, "gh api repos/acme/app/commits/abc/status"),
    ];
    const a = await ingest(db, "ws_local", "run1", island, true);
    expect(a.islands).toBe(1);
    const draft = await db.get<{ state: string }>(
      `SELECT state FROM tool WHERE fingerprint IS NOT NULL AND name != 'fetch_issue_bundle'`,
    );
    expect(draft?.state).toBe("draft");
    const b = await ingest(
      db,
      "ws_local",
      "run2",
      island.map((e, i) => ({ ...e, event_id: e.event_id + "b", seq: i })),
      true,
    );
    expect(b.islands).toBe(1);
    const knock = await db.get<{ attempt: number }>(`SELECT attempt FROM knock LIMIT 1`);
    expect(knock?.attempt).toBe(1);
  });

  test("re-ingest of the same run_id does not inflate cluster count", async () => {
    const db = await openDb(`/tmp/eden-dup-${Date.now()}.db`);
    const island = [
      ev(1, "curl https://api.github.com/repos/acme/app/issues/1"),
      ev(2, "curl https://api.github.com/repos/acme/app/issues/1/comments"),
    ];
    await ingest(db, "ws_local", "same", island, true);
    await ingest(db, "ws_local", "same", island, true);
    const cluster = await db.get<{ count: number }>(`SELECT count FROM cluster LIMIT 1`);
    expect(cluster?.count).toBe(1);
    const knocks = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM knock`);
    expect(knocks?.c).toBe(0);
  });
});

describe("playback densify + cache + parallel", () => {
  test("play seeded-shaped tool against live forge", async () => {
    const origin = process.env.EDEN_ORIGIN;
    if (!origin) return;
    const db = await openDb();
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE name = 'fetch_issue_bundle'`,
    );
    if (!tool) return;
    const receipt = await playTool(db, tool, { issue: "12", origin });
    expect(receipt.ok).toBe(true);
    expect(receipt.steps_attempted).toBe(6);
    expect(receipt.densified_bytes).toBeLessThan(receipt.raw_bytes);
    expect(receipt.facts).toBeTruthy();
  });
});

describe("product wrap matches seen names", () => {
  test("findOnTool hits seen, not only compiled name", async () => {
    const db = await openDb(`/tmp/eden-wrap-${Date.now()}.db`);
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES (?, 'ws_local', 'issue_bundle', 'use it', 'on', ?, ?, 'fp')`,
      [
        crypto.randomUUID(),
        JSON.stringify([{ id: "s1", kind: "cloud_http", name: "issue", commute: true, url: "http://example.invalid/{issue}" }]),
        JSON.stringify(["get_issue", "list_comments"]),
      ],
    );
    const { findOnTool } = await import("./wrap");
    const hit = await findOnTool(db, "ws_local", "get_issue");
    expect(hit?.name).toBe("issue_bundle");
    const miss = await findOnTool(db, "ws_local", "unrelated");
    expect(miss).toBeUndefined();
  });
});

describe("runner fail-closed", () => {
  test("unbound runner step fails the receipt", async () => {
    const db = await openDb(`/tmp/eden-runner-${Date.now()}.db`);
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES (?, 'ws_local', 'local_only', 'x', 'on', ?, '[]', 'fp')`,
      [
        crypto.randomUUID(),
        JSON.stringify([{ id: "s1", kind: "runner", name: "git.status", commute: true }]),
      ],
    );
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE name = 'local_only'`,
    );
    const receipt = await playTool(db, tool!, { origin: "http://127.0.0.1" });
    expect(receipt.ok).toBe(false);
    expect(receipt.steps_ok).toBe(0);
  });
});

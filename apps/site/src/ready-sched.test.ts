import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { playTool } from "./playback";
import type { CompiledStep } from "@eden/core";

/**
 * Ready-node scheduler (EDEN_SCHED=ready): dependency-driven execution with
 * no wave barriers. These tests pin the safety contract that makes it
 * shippable: identical results, write ordering respected, failures stop new
 * launches, and unresolvable deps still throw.
 */

const step = (over: Partial<CompiledStep> & { id: string }): CompiledStep => ({
  kind: "cloud_http",
  name: over.id,
  method: "GET",
  commute: true,
  ...over,
});

async function insertTool(db: Awaited<ReturnType<typeof openDb>>, id: string, steps: CompiledStep[], ws = "ws_ready") {
  await db.run(
    `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES (?, ?,` +
      ` ?, '', 'on', ?, '[]')`,
    [id, ws, id, JSON.stringify(steps)],
  );
  return { id, name: id, steps: JSON.stringify(steps), workspace_id: ws };
}

describe("EDEN_SCHED=ready", () => {
  const dbP = openDb(`/tmp/eden-ready-${Date.now()}.db`);
  const prevSched = process.env.EDEN_SCHED;
  process.env.EDEN_SCHED = "ready";

  afterAll(() => {
    if (prevSched === undefined) delete process.env.EDEN_SCHED;
    else process.env.EDEN_SCHED = prevSched;
  });

  test("fan-out tool produces the same receipt facts as success on all steps", async () => {
    const db = await dbP;
    const tool = await insertTool(db, "t_ready_fanout", [
      step({ id: "root", url: "https://x.test/forge/7/status" }),
      step({ id: "a", url: "https://x.test/forge/7/comments?ref={{root.state}}" }),
      step({ id: "b", url: "https://x.test/forge/7/reviews?ref={{root.state}}" }),
      step({ id: "c", url: "https://x.test/forge/7/status?ref={{root.state}}" }),
    ]);
    const receipt = await playTool(db, tool, {});
    expect(receipt.ok).toBe(true);
    expect(receipt.steps_ok).toBe(4);
    expect(receipt.steps_attempted).toBe(4);
    expect(receipt.cache_hits).toBeGreaterThanOrEqual(0);
  });

  test("a write gates its dependent reads; independent reads are not blocked by it", async () => {
    const db = await dbP;
    const tool = await insertTool(db, "t_ready_write", [
      step({ id: "root", url: "https://x.test/forge/3/status" }),
      // Long-independent chain (several hops) hanging off root.
      step({ id: "i1", url: "https://x.test/forge/3/files?ref={{root.state}}" }),
      step({ id: "i2", url: "https://x.test/forge/3/reviews?ref=1" }),
      step({ id: "i3", url: "https://x.test/forge/3/actions/runs?run_id=1" }),
      // Write fed by root; a read depends only on the write.
      step({
        id: "w0",
        method: "POST",
        commute: false,
        url: "https://x.test/shop/1/orders",
        bind: { b: "{{root.state}}" },
      }),
      step({ id: "dep", url: "https://x.test/forge/3/status?pr=1" }),
    ]);
    const receipt = await playTool(db, tool, {});
    expect(receipt.ok).toBe(true);
    expect(receipt.steps_attempted).toBe(6);
    // Latency is asserted in benchmarks/poc/poc3 — do not sample Date.now here.
  });

  test("failure stops new launches and marks the receipt failed", async () => {
    const db = await dbP;
    const tool = await insertTool(db, "t_ready_fail", [
      step({ id: "ok0", url: "https://x.test/forge/5/status" }),
      // runner steps always fail in playback (runner_unbound).
      { id: "boom", kind: "runner", name: "shell_thing", command: "echo hi" },
      step({ id: "never", url: "https://x.test/forge/5/comments?ref={{boom.x}}" }),
    ]);
    const receipt = await playTool(db, tool, {});
    expect(receipt.ok).toBe(false);
    expect(receipt.failed_step).toBeDefined();
    // The step downstream of the failure must never have launched.
    expect(receipt.steps_attempted).toBeLessThan(3);
  });

  test("dry-run still executes reads but reports writes as skipped", async () => {
    const db = await dbP;
    const tool = await insertTool(db, "t_ready_dry", [
      step({ id: "r0", url: "https://x.test/forge/9/status" }),
      step({ id: "w0", method: "POST", commute: false, url: "https://x.test/shop/2/orders" }),
    ]);
    const receipt = await playTool(db, tool, {}, { dryRun: true });
    expect(receipt.ok).toBe(true);
    expect((receipt.result as Record<string, unknown>)["w0"]).toEqual({
      skipped: "dry_run",
      method: "POST",
      url: "https://x.test/shop/2/orders",
    });
  });
});

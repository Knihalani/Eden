import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { recordDeopt } from "./db";
import { maybeRecompile } from "./canary";
import { buildDag, layers } from "@eden/core";

function tmpDb(tag: string) {
  return openDb(`/tmp/eden-canary-${tag}-${Date.now()}.db`);
}

async function seedTool(db: Awaited<ReturnType<typeof openDb>>, workspaceId: string, fingerprint = "fp/acme/issues") {
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k)
     VALUES (?, ?, ?, ?, 'on', ?, ?, ?, 2)`,
    [
      id,
      workspaceId,
      `issues_bundle_${workspaceId}`,
      "test tool",
      JSON.stringify([{ id: "s1", kind: "cloud_http", name: "curl", commute: true, url: "https://api.github.com/repos/a/b/issues/{issue}" }]),
      JSON.stringify(["curl"]),
      fingerprint,
    ],
  );
  return id;
}

/**
 * A program shaped like @eden/compile's real output: one IR tool step naming
 * the recorded call, which the canary projects onto the drifted tool's own
 * CompiledStep (the URL source of truth) before queueing.
 */
const passingDeps = {
  gatherTracesFn: async () => [
    { id: "t1", input: { issue: 1 }, events: [{ name: "curl", args: {}, ok: true }] },
    { id: "t2", input: { issue: 2 }, events: [{ name: "curl", args: {}, ok: true }] },
    { id: "t3", input: { issue: 3 }, events: [{ name: "curl", args: {}, ok: true }] },
  ],
  compileTracesFn: () => ({
    programs: [{ id: "p1", sequence: ["curl"], steps: [{ id: "x1", kind: "tool", tool: "curl" }] }],
    refusals: [],
  }),
  shadowProgramFn: async () => ({ verdict: "PASS" as const, reasons: [] }),
};

describe("drift canary & auto-recompile", () => {
  afterAll(() => {
    /* file dbs */
  });

  test("below the deopt threshold nothing happens", async () => {
    const db = await tmpDb("thresh");
    const toolId = await seedTool(db, "ws_local");
    await recordDeopt(db, "ws_local", toolId, { reason: "island X needs an island caller", steps_run: 0 });
    const out = await maybeRecompile(db, { workspace_id: "ws_local", tool_id: toolId, ...passingDeps });
    expect(out.action).toBe("below-threshold");
    const tools = await db.all(`SELECT id FROM tool`);
    expect(tools.length).toBe(1);
    const knocks = await db.all(`SELECT id FROM knock`);
    expect(knocks.length).toBe(0);
  });

  test("two deopts + passing recompile → new draft + knock referencing the OLD tool", async () => {
    const db = await tmpDb("queued");
    const oldTool = await seedTool(db, "ws_local");
    await recordDeopt(db, "ws_local", oldTool, { reason: "island X needs an island caller" });
    await recordDeopt(db, "ws_local", oldTool, { reason: "island X needs an island caller" });

    let shadowedProgram: unknown;
    const out = await maybeRecompile(db, {
      workspace_id: "ws_local",
      tool_id: oldTool,
      ...passingDeps,
      shadowProgramFn: async (program) => {
        shadowedProgram = program;
        return { verdict: "PASS", reasons: [] };
      },
    });
    expect(out.action).toBe("queued");
    if (out.action !== "queued") return;
    // the gate actually saw the recompiled candidate
    expect((shadowedProgram as { id?: string })?.id).toBe("p1");

    // old version untouched and still On
    const original = await db.get<{ state: string; steps: string }>(`SELECT state, steps FROM tool WHERE id = ?`, [oldTool]);
    expect(original?.state).toBe("on");
    expect(JSON.parse(original!.steps!).length).toBe(1);

    // exactly one NEW row beside it
    const rows = await db.all<{ id: string; state: string; steps: string; fingerprint: string }>(`SELECT id, state, steps, fingerprint FROM tool`);
    expect(rows.length).toBe(2);
    const fresh = rows.find((r) => r.id !== oldTool)!;
    expect(fresh.state).toBe("draft");
    expect(fresh.fingerprint.startsWith("fp/acme/issues@rc")).toBe(true);
    // the new draft carries a CompiledStep[] projection of the recompiled
    // program — URL-bearing, same shape every other writer stores — not the
    // raw StretchProgram object playback cannot consume.
    expect(JSON.parse(fresh.steps)).toEqual([
      { id: "s1", kind: "cloud_http", name: "curl", commute: true, url: "https://api.github.com/repos/a/b/issues/{issue}" },
    ]);

    // knock references the OLD version so the workshop shows old-vs-new
    const knocks = await db.all<{ tool_id: string }>(`SELECT tool_id FROM knock`);
    expect(knocks.length).toBe(1);
    expect(knocks[0]!.tool_id).toBe(oldTool);
    void out.draft_id;
    void out.knock_id;
  });

  test("approval invariant: the recompiled tool is a draft, never On", async () => {
    process.env.EDEN_AUTO_APPROVE = "1"; // must not leak into the canary path
    try {
      const db = await tmpDb("invariant");
      const toolId = await seedTool(db, "ws_local");
      await recordDeopt(db, "ws_local", toolId, {});
      await recordDeopt(db, "ws_local", toolId, {});
      await maybeRecompile(db, { workspace_id: "ws_local", tool_id: toolId, ...passingDeps });
      const rows = await db.all<{ state: string }>(`SELECT state FROM tool`);
      // every row in this database is draft or on, but only the ORIGINAL may be on
      const states = rows.map((r) => r.state).sort();
      expect(states).toEqual(["draft", "on"]);
    } finally {
      delete process.env.EDEN_AUTO_APPROVE;
    }
  });

  test("a failing recompile leaves the original untouched", async () => {
    const db = await tmpDb("fail");
    const toolId = await seedTool(db, "ws_local");
    await recordDeopt(db, "ws_local", toolId, {});
    await recordDeopt(db, "ws_local", toolId, {});
    const out = await maybeRecompile(db, {
      workspace_id: "ws_local",
      tool_id: toolId,
      ...passingDeps,
      shadowProgramFn: async () => ({ verdict: "FAIL", reasons: ["compiled output differs from the recorded trace"] }),
    });
    expect(out.action).toBe("skipped");
    const rows = await db.all<{ id: string; state: string; steps: string }>(`SELECT id, state, steps FROM tool`);
    expect(rows.length).toBe(1); // no draft queued behind a failed gate
    expect(rows[0]!.id).toBe(toolId);
    expect(rows[0]!.state).toBe("on");
    expect(await db.all(`SELECT id FROM knock`)).toEqual([]);
  });

  test("an INCONCLUSIVE gate also changes nothing", async () => {
    const db = await tmpDb("inconcl");
    const toolId = await seedTool(db, "ws_local");
    await recordDeopt(db, "ws_local", toolId, {});
    await recordDeopt(db, "ws_local", toolId, {});
    const out = await maybeRecompile(db, {
      workspace_id: "ws_local",
      tool_id: toolId,
      ...passingDeps,
      shadowProgramFn: async () => ({ verdict: "INCONCLUSIVE", reasons: ["n=2 < 3"] }),
    });
    expect(out.action).toBe("skipped");
    expect((await db.all(`SELECT id FROM tool`)).length).toBe(1);
  });

  test("one pending recompile per tool: a draft descendant dampens churn", async () => {
    const db = await tmpDb("churn");
    const toolId = await seedTool(db, "ws_local");
    await recordDeopt(db, "ws_local", toolId, {});
    await recordDeopt(db, "ws_local", toolId, {});
    const first = await maybeRecompile(db, { workspace_id: "ws_local", tool_id: toolId, ...passingDeps });
    expect(first.action).toBe("queued");
    const second = await maybeRecompile(db, { workspace_id: "ws_local", tool_id: toolId, ...passingDeps });
    expect(second.action).toBe("pending-recompile-exists");
    // and still just one knock, one draft
    expect((await db.all(`SELECT id FROM knock`)).length).toBe(1);
    expect((await db.all(`SELECT id FROM tool`)).length).toBe(2);
  });

  test("tenant isolation: another workspace's deopts never trigger mine, drafts land in the right one", async () => {
    const db = await tmpDb("tenants");
    const wsA = "ws_alpha";
    const wsB = "ws_beta";
    await db.run(`INSERT OR IGNORE INTO workspace (id, name) VALUES (?, ?)`, [wsA, "alpha"]);
    await db.run(`INSERT OR IGNORE INTO workspace (id, name) VALUES (?, ?)`, [wsB, "beta"]);
    const toolA = await seedTool(db, wsA);
    const toolB = await seedTool(db, wsB); // same fingerprint shape, other tenant

    // drift observed only in A
    await recordDeopt(db, wsA, toolA, {});
    await recordDeopt(db, wsA, toolA, {});

    // B's identical-looking tool stays below threshold — A's ledger is invisible
    const outB = await maybeRecompile(db, { workspace_id: wsB, tool_id: toolB, ...passingDeps });
    expect(outB.action).toBe("below-threshold");
    expect((await db.all(`SELECT id FROM tool WHERE workspace_id = ?`, [wsB])).length).toBe(1);

    // A queues its draft into A, never into B
    const outA = await maybeRecompile(db, { workspace_id: wsA, tool_id: toolA, ...passingDeps });
    expect(outA.action).toBe("queued");
    const draftsInB = await db.all(`SELECT id FROM tool WHERE workspace_id = ? AND state = 'draft'`, [wsB]);
    const draftsInA = await db.all(`SELECT id FROM tool WHERE workspace_id = ? AND state = 'draft'`, [wsA]);
    expect(draftsInB.length).toBe(0);
    expect(draftsInA.length).toBe(1);
    const knocksInB = await db.all(`SELECT id FROM knock WHERE workspace_id = ?`, [wsB]);
    expect(knocksInB.length).toBe(0);
  });

  test("no compiler or gate wired → refuse loudly, change nothing", async () => {
    const db = await tmpDb("nowiring");
    const toolId = await seedTool(db, "ws_local");
    await recordDeopt(db, "ws_local", toolId, {});
    await recordDeopt(db, "ws_local", toolId, {});
    const noCompiler = await maybeRecompile(db, { workspace_id: "ws_local", tool_id: toolId });
    expect(noCompiler.action).toBe("no-compiler");
    const noGate = await maybeRecompile(db, {
      workspace_id: "ws_local",
      tool_id: toolId,
      compileTracesFn: passingDeps.compileTracesFn,
      gatherTracesFn: passingDeps.gatherTracesFn,
    });
    expect(noGate.action).toBe("no-shadow-gate");
    expect((await db.all(`SELECT id FROM tool`)).length).toBe(1);
  });

  test("a queued draft's steps survive playback's parse + buildDag path", async () => {
    /**
     * The recompiled draft used to store the raw StretchProgram object into
     * tool.steps. Every consumer expects a CompiledStep[] array — playback's
     * buildDag calls steps.map and threw a TypeError, so /v1/play 500'd the
     * moment a human approved the draft.
     */
    const db = await tmpDb("playable");
    const oldTool = await seedTool(db, "ws_local");
    await recordDeopt(db, "ws_local", oldTool, {});
    await recordDeopt(db, "ws_local", oldTool, {});
    const out = await maybeRecompile(db, { workspace_id: "ws_local", tool_id: oldTool, ...passingDeps });
    expect(out.action).toBe("queued");
    const draft = await db.get<{ steps: string }>(`SELECT steps FROM tool WHERE id = ?`, [
      (out as { draft_id: string }).draft_id,
    ]);
    const parsed: unknown = JSON.parse(draft!.steps!);
    // The exact shape playOne parses before buildDag.
    expect(Array.isArray(parsed)).toBe(true);
    // buildDag is what the object-shaped steps blew up on (.map over an
    // object). It must run clean against what we store now.
    const dag = buildDag(parsed as Parameters<typeof buildDag>[0]);
    expect(layers(dag).flat().map((s) => s.id)).toEqual(["s1"]);
  });

  test("a recompile that cannot be projected onto playable steps is refused, not queued", async () => {
    const db = await tmpDb("unplayable");
    const toolId = await seedTool(db, "ws_local");
    await recordDeopt(db, "ws_local", toolId, {});
    await recordDeopt(db, "ws_local", toolId, {});
    const out = await maybeRecompile(db, {
      workspace_id: "ws_local",
      tool_id: toolId,
      ...passingDeps,
      compileTracesFn: () => ({
        programs: [{ id: "p2", sequence: ["curl"], steps: [{ id: "i1", kind: "island", input: { kind: "literal", value: "" }, system: "", outputSchema: {} }] }],
        refusals: [],
      }),
    });
    expect(out.action).toBe("unplayable-refused");
    if (out.action !== "unplayable-refused") return;
    expect(out.reasons.join("; ")).toContain("island");
    // nothing queued, no knock raised — the original keeps serving
    expect((await db.all(`SELECT id FROM tool`)).length).toBe(1);
    expect(await db.all(`SELECT id FROM knock`)).toEqual([]);
  });
});

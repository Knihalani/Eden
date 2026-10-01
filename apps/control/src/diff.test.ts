import { afterAll, describe, expect, test } from "bun:test";
import { withVersion, type StretchProgram } from "@eden/ir";
import { createHandler } from "./server";
import { useTempEdenHome } from "./test-home";
import { Store } from "./store";

useTempEdenHome();

// Org binding: a DATABASE_URL in .env makes the control plane treat itself as
// managed, where the permissive legacy fallback requires explicit opt-in.
// These tests drive state-changing routes without org bindings, so pin dev.
const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
afterAll(() => {
  process.env.EDEN_DEV = PREV_DEV;
});
const program = (over: Partial<StretchProgram> = {}): StretchProgram =>
  withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }],
    returns: { kind: "from", step: "a", path: "" },
    contract: { witnesses: 3, minLlmReduction: 5, allowExact: false },
    manifest: null,
    ...over,
  });

/** Two compilations of one stretch that differ structurally (baked-in literal). */
const rebound = (p: StretchProgram): StretchProgram =>
  withVersion({
    ...p,
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "literal", value: "T-100" } } }],
  });

function putTool(store: Store, p: StretchProgram): void {
  const existing = store.tool(p.id);
  store.putTool({
    id: p.id,
    name: p.name,
    version: p.version,
    program: p,
    state: "live",
    created_at: existing?.created_at ?? Date.now(),
    updated_at: Date.now(),
  });
}

/** A genuinely different compilation of the same stretch (new version hash). */
const regen = (p: StretchProgram, tag: string): StretchProgram => withVersion({ ...p, description: `gen ${tag}` });

describe("program version history", () => {
  test("re-mining keeps the superseded compilations, newest first", () => {
    const store = new Store(":memory:");
    const first = program();
    putTool(store, first);
    expect(store.programVersions("t")).toEqual([]);

    const second = regen(first, "2");
    putTool(store, second);
    let stack = store.programVersions("t");
    expect(stack).toHaveLength(1);
    expect(stack[0]!.version).toBe(first.version);
    expect(stack[0]!.tool_id).toBe("t");

    const third = rebound(first);
    putTool(store, third);
    stack = store.programVersions("t");
    expect(stack.map((v) => v.version)).toEqual([second.version, first.version]);
  });

  test("history caps at five per tool and survives same-version writes", () => {
    const store = new Store(":memory:");
    let last = program();
    putTool(store, last);
    for (let i = 0; i < 7; i++) {
      // Each write is a genuinely new compilation, so each one parks the
      // previous program.
      last = regen(last, String(i));
      putTool(store, last);
    }
    expect(store.programVersions("t")).toHaveLength(5);

    // Pausing / resuming rewrites the row without changing the version —
    // that must not grow or reorder the history.
    const t = store.tool("t")!;
    t.state = "paused";
    store.putTool(t);
    expect(store.programVersions("t")).toHaveLength(5);
  });

  test("version rows are scoped by tool id — one stretch never sees another's history", () => {
    const store = new Store(":memory:");
    const a = program({ id: "stretch_a", name: "a" });
    const b = program({ id: "stretch_b", name: "b" });
    putTool(store, a);
    putTool(store, b);
    putTool(store, regen(a, "a2"));
    putTool(store, rebound(a));
    putTool(store, regen(b, "b2"));

    const aVersions = store.programVersions("stretch_a");
    const bVersions = store.programVersions("stretch_b");
    expect(aVersions.map((v) => v.version)).toEqual([regen(a, "a2").version, a.version]);
    expect(bVersions.map((v) => v.version)).toEqual([b.version]);
    for (const v of aVersions) {
      expect(v.tool_id).toBe("stretch_a");
      expect(v.program.name).toBe("a");
    }
    for (const v of bVersions) {
      expect(v.tool_id).toBe("stretch_b");
      // The programs are each stretch's own, byte-for-byte.
      expect(v.program.name).toBe("b");
      expect(aVersions.some((x) => x.version === v.version)).toBe(false);
    }
    expect(store.programVersions("stretch_missing")).toEqual([]);
  });
});

describe("candidate review surface", () => {
  function handler() {
    const store = new Store(":memory:");
    return { store, fetchHandler: createHandler({ store, token: "eden_dev" }) };
  }
  const auth = { authorization: "Bearer eden_dev", "content-type": "application/json" };

  const passManifest = {
    llmReduction: 5,
    latencyReduction: 2,
    costReduction: 2,
    skipRateBefore: 0.1,
    skipRateAfter: 0,
    nShadow: 6,
    tokensMeasured: true,
    tokensSaved: 400,
    timeMeasured: false,
    timeSavedMs: null,
  };

  test("GET candidate carries a structured diff against the live program", async () => {
    const { store, fetchHandler } = handler();
    const live = program();
    putTool(store, live);

    const candidate = rebound(live);
    store.putCandidate({
      id: "t",
      sequence: [],
      program: candidate,
      refusal: null,
      verdict: "PASS",
      manifest: passManifest,
      created_at: Date.now(),
    });
    const res = await fetchHandler(new Request("http://x/v1/candidates/t", { headers: auth }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diff: { literals_introduced: unknown[]; bindings_changed: Array<{ from_kind: string; to_kind: string }> } | null;
    };
    expect(body.diff).toBeTruthy();
    expect(body.diff!.literals_introduced).toEqual([{ step: "a", field: "id" }]);
    expect(body.diff!.bindings_changed[0]).toMatchObject({
      step: "a",
      field: "id",
      from_kind: "input",
      to_kind: "literal",
    });
  });

  test("a brand-new candidate diffs to null — there is nothing to review against", async () => {
    const { store, fetchHandler } = handler();
    const fresh = program({ id: "brand_new", name: "fresh" });
    store.putCandidate({
      id: "brand_new",
      sequence: [],
      program: fresh,
      refusal: null,
      verdict: "PASS",
      manifest: passManifest,
      created_at: Date.now(),
    });
    const res = await fetchHandler(new Request("http://x/v1/candidates/brand_new", { headers: auth }));
    expect(((await res.json()) as { diff: unknown }).diff).toBe(null);
  });

  test("approve echoes the reviewed diff and the replaced version lands in history", async () => {
    const { store, fetchHandler } = handler();
    const live = program();
    putTool(store, live);

    const candidate = rebound(live);
    store.putCandidate({
      id: "t",
      sequence: [],
      program: candidate,
      refusal: null,
      verdict: "PASS",
      manifest: passManifest,
      created_at: Date.now(),
    });
    const approved = await fetchHandler(
      new Request("http://x/v1/tools/t/approve", { method: "POST", headers: auth, body: "{}" }),
    );
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as { diff: { literals_introduced: unknown[] } | null };
    expect(body.diff?.literals_introduced).toEqual([{ step: "a", field: "id" }]);

    const got = await fetchHandler(new Request("http://x/v1/tools/t", { headers: auth }));
    const toolBody = (await got.json()) as {
      state: string;
      versions: Array<{ version: string }>;
      candidate_diff: unknown;
      candidate: { id: string } | null;
    };
    expect(toolBody.state).toBe("live");
    expect(toolBody.versions.map((v) => v.version)).toEqual([live.version]);
    // Candidate was consumed on approval, so there is nothing queued anymore.
    expect(toolBody.candidate).toBe(null);
    expect(toolBody.candidate_diff).toBe(null);
  });

  test("GET tool surfaces the queued candidate diff before approval", async () => {
    const { store, fetchHandler } = handler();
    const live = program();
    putTool(store, live);
    const candidate = rebound(live);
    store.putCandidate({
      id: "t",
      sequence: [],
      program: candidate,
      refusal: null,
      verdict: "pending",
      manifest: null,
      created_at: Date.now(),
    });
    const res = await fetchHandler(new Request("http://x/v1/tools/t", { headers: auth }));
    const body = (await res.json()) as {
      candidate: { id: string; verdict: string } | null;
      candidate_diff: { literals_introduced: unknown[] } | null;
    };
    expect(body.candidate).toMatchObject({ id: "t", verdict: "pending" });
    expect(body.candidate_diff?.literals_introduced).toHaveLength(1);
  });

  test("putTool round-trips transparent_writes", () => {
    const store = new Store(":memory:");
    const live = program();
    store.putTool({
      id: live.id,
      name: live.name,
      version: live.version,
      program: live,
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
      transparent_writes: true,
    });
    expect(store.tool(live.id)?.transparent_writes).toBe(true);
    const paused = store.tool(live.id)!;
    paused.state = "paused";
    store.putTool(paused);
    expect(store.tool(live.id)?.transparent_writes).toBe(true);
  });

  test("putTool writes rollout alongside transparent_writes and pause keeps both", () => {
    const store = new Store(":memory:");
    const live = program();
    store.putTool({
      id: live.id,
      name: live.name,
      version: live.version,
      program: live,
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
      transparent_writes: true,
      rollout: "canary",
    });
    expect(store.tool(live.id)?.transparent_writes).toBe(true);
    expect(store.tool(live.id)?.rollout).toBe("canary");
    const paused = store.tool(live.id)!;
    paused.state = "paused";
    store.putTool(paused);
    expect(store.tool(live.id)?.transparent_writes).toBe(true);
    expect(store.tool(live.id)?.rollout).toBe("canary");
  });

  test("existing tools with no rollout flag stay live 100%", () => {
    const store = new Store(":memory:");
    const live = program();
    store.putTool({
      id: live.id,
      name: live.name,
      version: live.version,
      program: live,
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    expect(store.tool(live.id)?.rollout).toBeUndefined();
  });

  test("approve defaults to canary and GET includes rollout", async () => {
    const { store, fetchHandler } = handler();
    const candidate = program({ id: "can", name: "can" });
    store.putCandidate({
      id: "can",
      sequence: [],
      program: candidate,
      refusal: null,
      verdict: "PASS",
      manifest: passManifest,
      created_at: Date.now(),
    });
    const approved = await fetchHandler(
      new Request("http://x/v1/tools/can/approve", { method: "POST", headers: auth, body: "{}" }),
    );
    expect(approved.status).toBe(200);
    expect(store.tool(candidate.id)?.rollout).toBe("canary");
    expect(((await approved.json()) as { rollout?: string }).rollout).toBe("canary");
    const got = await fetchHandler(new Request("http://x/v1/tools/can", { headers: auth }));
    expect(((await got.json()) as { rollout?: string }).rollout).toBe("canary");
  });

  test("approve persists transparent_writes from the checkbox body", async () => {
    const { store, fetchHandler } = handler();
    const candidate = program({ id: "tw", name: "tw" });
    store.putCandidate({
      id: "tw",
      sequence: [],
      program: candidate,
      refusal: null,
      verdict: "PASS",
      manifest: passManifest,
      created_at: Date.now(),
    });
    const approved = await fetchHandler(
      new Request("http://x/v1/tools/tw/approve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ transparent_writes: true }),
      }),
    );
    expect(approved.status).toBe(200);
    expect(store.tool(candidate.id)?.transparent_writes).toBe(true);
  });
});

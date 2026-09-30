import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@eden/control";
import type { StretchProgram } from "@eden/ir";
import { codingRegistry } from "@eden/wrap";
import { pollOnce, runJob, type RunnerCtx } from "./runner";

const workspaces: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

const GOOD_INPUT = { command: "touch approved.txt" };

/** An approved program whose one Bash step runs a command only from its witnessed envelope. */
function touchProgram(): StretchProgram {
  return {
    id: "wf_touch",
    version: "v1",
    name: "touch_file",
    description: "touches a file",
    inputSchema: { type: "object" },
    steps: [{ id: "s0", kind: "tool", tool: "Bash", args: { command: { kind: "input", path: "command" } } }],
    returns: { kind: "from", step: "s0", path: "" },
    contract: {
      witnesses: 2,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { command: [GOOD_INPUT.command] } },
    },
    sequence: ["Bash"],
    manifest: null,
  } as never;
}

function putTouch(store: Store, state: "live" | "paused"): void {
  const now = Date.now();
  store.putTool({
    id: "wf_touch",
    name: "touch_file",
    version: "v1",
    program: touchProgram(),
    state,
    created_at: now,
    updated_at: now,
  });
}

/** A runner host: its own workspace, and a store in which wf_touch v1 is in `state`. */
function host(state: "live" | "paused" = "live") {
  const ws = mkdtempSync(join(tmpdir(), "eden-runner-"));
  workspaces.push(ws);
  const store = new Store(":memory:");
  putTouch(store, state);
  const ctx: RunnerCtx = { store, registry: codingRegistry(ws), timeoutMs: 10_000 };
  return { store, ctx, has: (file: string) => existsSync(join(ws, file)) };
}

const RAW_BASH = { tool: "Bash", args: { command: "touch pwned.txt" } };

describe("eden runner plays only programs approved on this host (#82)", () => {
  test("a job carrying a raw Bash step is refused and nothing executes", async () => {
    const h = host();
    const legacy = await runJob({ id: "j1", tool_id: "wf_touch", steps: [RAW_BASH] }, h.ctx);
    expect(legacy).toEqual({
      job_id: "j1",
      ok: false,
      refused: "job carries raw steps; the runner plays approved programs only",
    });
    // Naming the live program at its live version does not let raw steps ride along.
    const riding = await runJob(
      { id: "j2", tool_id: "wf_touch", version: "v1", input: GOOD_INPUT, steps: [RAW_BASH] },
      h.ctx,
    );
    expect(riding.refused).toMatch(/raw steps/);
    expect(h.has("pwned.txt")).toBe(false);
    expect(h.has("approved.txt")).toBe(false);
    expect(h.store.receiptsFor("wf_touch")).toHaveLength(0);
  });

  test("a job naming an unknown program, or a version that is not live, is refused", async () => {
    const h = host();
    const unknown = await runJob({ id: "j3", tool_id: "wf_other", version: "v1", input: GOOD_INPUT }, h.ctx);
    expect(unknown).toEqual({ job_id: "j3", ok: false, refused: "program wf_other is not found on this host" });
    const stale = await runJob({ id: "j4", tool_id: "wf_touch", version: "v0", input: GOOD_INPUT }, h.ctx);
    expect(stale.refused).toBe("program wf_touch is live at v1, not v0");
    const unversioned = await runJob({ id: "j5", tool_id: "wf_touch", input: GOOD_INPUT }, h.ctx);
    expect(unversioned.refused).toBe("job must name a tool_id and a version");
    expect(h.has("approved.txt")).toBe(false);
    expect(h.store.receiptsFor("wf_touch")).toHaveLength(0);
  });

  test("an input outside the witness envelope deopts before any step runs", async () => {
    const h = host();
    const r = await runJob(
      { id: "j6", tool_id: "wf_touch", version: "v1", input: { command: "touch pwned.txt" } },
      h.ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.deopt).toMatch(/witness envelope/);
    expect(h.has("pwned.txt")).toBe(false);
  });

  test("a job naming the live program at its live version runs it, and the receipt lands locally", async () => {
    const h = host();
    const r = await runJob({ id: "j7", tool_id: "wf_touch", version: "v1", input: GOOD_INPUT }, h.ctx);
    expect(r).toMatchObject({ job_id: "j7", ok: true });
    expect(h.has("approved.txt")).toBe(true);
    const receipts = h.store.receiptsFor("wf_touch");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.version).toBe("v1");
    expect(JSON.parse(receipts[0]!.payload ?? "{}")).toMatchObject({ outcome: "ok", source: "runner" });
  });

  test("Approve is the opt-in: a paused program is refused, and runs once it is live again", async () => {
    const h = host("paused");
    const job = { id: "j8", tool_id: "wf_touch", version: "v1", input: GOOD_INPUT };
    expect((await runJob(job, h.ctx)).refused).toBe("program wf_touch is paused on this host");
    expect(h.has("approved.txt")).toBe(false);
    putTouch(h.store, "live");
    expect((await runJob(job, h.ctx)).ok).toBe(true);
    expect(h.has("approved.txt")).toBe(true);
  });

  test("a poll refuses and logs bad jobs, plays the approved one, and posts a receipt for each", async () => {
    const h = host();
    const jobs = [
      { id: "raw", tool_id: "wf_touch", steps: [RAW_BASH] },
      { id: "ghost", tool_id: "wf_ghost", version: "v1", input: {} },
      { id: "good", tool_id: "wf_touch", version: "v1", input: GOOD_INPUT },
    ];
    const posted: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/runner/jobs") return Response.json({ jobs });
        if (path === "/v1/runner/receipt") {
          posted.push({ auth: req.headers.get("authorization"), body: (await req.json()) as Record<string, unknown> });
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const logs = spyOn(console, "log").mockImplementation(() => undefined);
    let refusals: string[];
    try {
      await pollOnce(`http://127.0.0.1:${server.port}`, "runner_key", h.ctx);
    } finally {
      // Read before restoring: mockRestore clears the recorded calls.
      refusals = errors.mock.calls.map((c) => String(c[0]));
      errors.mockRestore();
      logs.mockRestore();
    }
    expect(posted.map((p) => [p.body.job_id, p.body.ok, p.auth])).toEqual([
      ["raw", false, "Bearer runner_key"],
      ["ghost", false, "Bearer runner_key"],
      ["good", true, "Bearer runner_key"],
    ]);
    expect(refusals).toEqual([
      "eden runner: refused job raw: job carries raw steps; the runner plays approved programs only",
      "eden runner: refused job ghost: program wf_ghost is not found on this host",
    ]);
    expect(h.has("pwned.txt")).toBe(false);
    expect(h.has("approved.txt")).toBe(true);
  });
});

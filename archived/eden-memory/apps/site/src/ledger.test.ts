import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type EdenDb } from "./db";
import { buildLedger, ensureLedgerSchema, sanitizeManifest, type SavingsLedger } from "./ledger";

const ENV_KEYS = ["DATABASE_URL", "VERCEL", "EDEN_DEV", "EDEN_DB", "EDEN_SKIP_SEED"] as const;

describe("savings ledger", () => {
  let dir: string;
  let db: EdenDb;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "eden-ledger-"));
    db = await openDb(join(dir, "test.db"));
    await ensureLedgerSchema(db);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function addTool(
    wsId: string,
    name: string,
    opts: { state?: string; manifest?: Record<string, unknown> } = {},
  ) {
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?)`,
      [id, wsId, name, "test", opts.state ?? "on", `fp-${name}-${wsId}`],
    );
    if (opts.manifest) {
      await db.run(`UPDATE tool SET manifest = ? WHERE id = ?`, [JSON.stringify(opts.manifest), id]);
    }
    return id;
  }

  async function addRun(toolId: string, opts: { steps_ok?: number; steps_attempted?: number } = {}) {
    await db.run(
      `INSERT INTO tool_run (id, tool_id, steps_attempted, steps_ok, server_ms, runner_ms, raw_bytes, \
densified_bytes, billable_ms, cache_hits, created_at)
       VALUES (?, ?, ?, ?, 10, 0, 1, 1, 1, 0, ?)`,
      [crypto.randomUUID(), toolId, opts.steps_attempted ?? 2, opts.steps_ok ?? 2, Date.now()],
    );
  }

  test("an empty workspace reports zeros and not-measured, never invented numbers", async () => {
    const led = await buildLedger(db, "ws_local");
    expect(led.runs).toBe(0);
    expect(led.fail).toBe(0);
    expect(led.live).toBe(0);
    expect(led.tokens_saved_mean).toEqual({ value: null, measured: false, estimated: false });
    expect(led.tokens_saved_estimated_mean.value).toBeNull();
    expect(led.time_saved_ms_mean).toEqual({ value: null, measured: false });
    expect(led.per_tool).toEqual([]);
  });

  test("means come only from manifests that carry a real measurement", async () => {
    await addTool("ws_local", "a", {
      manifest: { tokensSaved: 100, timeSavedMs: 1000, tokensMeasured: true, timeMeasured: true },
    });
    await addTool("ws_local", "b", {
      manifest: { tokensSaved: 300, timeSavedMs: 3000, tokensMeasured: true, timeMeasured: true },
    });
    // No measurement flags: contributes nothing to any mean.
    await addTool("ws_local", "bare", {});
    // Measured flag but no number: absent, not zero.
    await addTool("ws_local", "flagged_only", { manifest: { tokensMeasured: true, timeMeasured: true } });

    const led = await buildLedger(db, "ws_local");
    expect(led.tokens_saved_mean).toEqual({ value: 200, measured: true, estimated: false });
    expect(led.time_saved_ms_mean).toEqual({ value: 2000, measured: true });
    expect(led.per_tool.find((t) => t.name === "bare")?.tokens.measured).toBe(false);
    expect(led.per_tool.find((t) => t.name === "flagged_only")?.tokens.value).toBeNull();
  });

  test("negative savings figures are refused, not stored as measured wins", () => {
    expect(sanitizeManifest({ tokensSaved: -42, tokensMeasured: true }).ok).toBe(false);
    expect(sanitizeManifest({ timeSavedMs: -1, timeMeasured: true }).ok).toBe(false);
    // Zero is honest (no measurable saving) and still accepted.
    expect(sanitizeManifest({ tokensSaved: 0, tokensMeasured: true }).ok).toBe(true);
    const bad = sanitizeManifest({ tokensSaved: -42 });
    expect(bad.ok === false && bad.error).toContain("negative");
  });

  test("estimated-only tokens are reported as an estimate, never as measured savings", async () => {
    await addTool("ws_local", "est", { manifest: { tokensSaved: 500, tokensMeasured: true, tokensEstimated: true } });
    const led = await buildLedger(db, "ws_local");
    expect(led.tokens_saved_mean).toEqual({ value: null, measured: false, estimated: true });
    expect(led.tokens_saved_estimated_mean).toEqual({ value: 500 });
    // The per-tool row says the same thing.
    expect(led.per_tool[0]!.tokens).toEqual({ value: null, measured: false, estimated: true });
  });

  test("runs and failures count from this workspace's executions only", async () => {
    const mine = await addTool("ws_local", "mine");
    await addRun(mine, { steps_ok: 2 });
    await addRun(mine, { steps_ok: 1 }); // failed run
    const led = await buildLedger(db, "ws_local");
    expect(led.runs).toBe(2);
    expect(led.fail).toBe(1);
    expect(led.live).toBe(1);
    expect(led.per_tool).toHaveLength(1);
    expect(led.per_tool[0]).toMatchObject({ name: "mine", runs: 2, fail: 1 });
  });

  test("another workspace's tools and runs never leak into the ledger", async () => {
    const other = await addTool("ws_other", "theirs", {
      manifest: { tokensSaved: 99999, timeSavedMs: 99999, tokensMeasured: true, timeMeasured: true },
    });
    await addRun(other);
    await addTool("ws_other", "theirs_draft", { state: "draft" });

    const led = (await buildLedger(db, "ws_local")) as SavingsLedger;
    expect(led.runs).toBe(0);
    expect(led.live).toBe(0);
    expect(led.tokens_saved_mean.measured).toBe(false);
    expect(led.tokens_saved_mean.value).toBeNull();
    expect(led.per_tool).toEqual([]);

    // And the reverse scoping holds too.
    const theirs = await buildLedger(db, "ws_other");
    expect(theirs.tokens_saved_mean).toEqual({ value: 99999, measured: true, estimated: false });
    expect(theirs.runs).toBe(1);
  });
});

describe("GET /v1/ledger", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  let handleFetch: (req: Request) => Promise<Response>;
  let bust = 0;

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_DEV"] as const) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "eden-ledger-route-"));
    // A fresh module instance per test: ./server caches its dbPromise, so a
    // shared instance would answer from another file's database (the same
    // reason validation.test.ts busts the import).
    process.env.EDEN_DB = join(dir, "route.db");
    ({ handleFetch } = await import(`./server?ledger-bust=${++bust}`));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("requires the workspace key — no key, no ledger", async () => {
    process.env.EDEN_DEV = "0";
    const res = await handleFetch(new Request("http://127.0.0.1/v1/ledger"));
    expect(res.status).toBe(401);
  });

  test("answers with the workspace ledger and busts caches", async () => {
    const res = await handleFetch(
      new Request("http://127.0.0.1/v1/ledger", { headers: { authorization: "Bearer eden_dev" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as SavingsLedger;
    expect(body.runs).toBe(0);
    expect(body.tokens_saved_mean.measured).toBe(false);
    expect(Array.isArray(body.per_tool)).toBe(true);
  });
});

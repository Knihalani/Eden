import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type EdenDb } from "./db";
import { playTool } from "./playback";
import { wrapPlay } from "./wrap";
import { buildLedger, ensureLedgerSchema } from "./ledger";

/**
 * Regression tests for audited fixes: approve-of-nothing, loud migration
 * failures, workspace-scoped wrap caching and the bounded batch fan-out.
 */

describe("approve of an unknown or foreign tool is a 404", () => {
  /**
   * The UPDATE was scoped correctly — it just affected zero rows and then
   * answered 303 anyway. A caller (or a mistyped workshop link) could believe
   * a tool had been approved when nothing at all had happened.
   */
  let dir: string;
  let dbFile: string;
  let db: EdenDb;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED", "EDEN_DEV"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-approve-404-"));
    dbFile = join(dir, "a.db");
    process.env.EDEN_DB = dbFile;
    process.env.EDEN_DEV = "1";
    db = await openDb(dbFile);
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES ('t-live', 'ws_local', 'live_tool', 'x', 'draft', '[]', '[]', 'fp-live')`,
    );
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES ('t-foreign', 'ws_other', 'foreign_tool', 'x', 'draft', '[]', '[]', 'fp-foreign')`,
    );
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // One bust for the describe (not a fixed literal — those collide under
  // shuffle). Import once so db() stays on this suite's EDEN_DB.
  const SERVER_MOD = `./server?bust=approve-404-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let handleFetch: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    process.env.EDEN_DB = dbFile;
    ({ handleFetch } = await import(SERVER_MOD));
  });

  const post = (id: string, headers: Record<string, string> = {}) =>
    handleFetch(
      new Request(`http://127.0.0.1:8787/v1/tools/${id}/approve`, { method: "POST", headers: { host: "127.0.0.1:8787", ...headers } }),
    );

  test("an existing workspace tool still approves with a 303 redirect", async () => {
    const res = await post("t-live");
    expect(res.status).toBe(303);
    const row = await db.get<{ state: string; published: number }>(`SELECT state, published FROM tool WHERE id = 't-live'`);
    expect(row?.state).toBe("on");
    expect(Number(row?.published)).toBe(1);
  });

  test("a nonexistent id answers 404 instead of success", async () => {
    const res = await post("no-such-tool");
    expect(res.status).toBe(404);
  });

  test("the json caller gets a 404 body too, not an ok:true", async () => {
    const res = await post("no-such-tool", { accept: "application/json" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("not found");
  });

  test("another workspace's id is equally invisible", async () => {
    const res = await post("t-foreign");
    expect(res.status).toBe(404);
    const row = await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = 't-foreign'`);
    expect(row?.state).toBe("draft");
  });
});

describe("a failed tenant-key migration fails loudly", () => {
  /**
   * The migration must never block boot, but a silent catch meant an operator
   * whose tenant-isolation re-key failed had degraded cross-tenant keying with
   * zero signal. The failure now has to reach stderr.
   */
  test("boot logs the failure to stderr and continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-migrate-loud-"));
    const path = join(dir, "legacy.db");
    const { Database } = await import("bun:sqlite");
    // Hand-build the pre-composite-key shape: cluster keyed on fingerprint
    // alone, plus a v2 staging table that cannot accept the copied rows
    // (its extra NOT NULL column has no default), which forces the migration
    // down its failure path.
    const raw = new Database(path);
    raw.exec(
      `CREATE TABLE cluster (fingerprint TEXT PRIMARY KEY, workspace_id TEXT, count INTEGER, steps TEXT, status TEXT)`,
    );
    raw.exec(`INSERT INTO cluster VALUES ('fp', 'ws_a', 1, '[]', 'draft')`);
    raw.exec(
      `CREATE TABLE cluster_v2 (fingerprint TEXT, workspace_id TEXT, count INTEGER, steps TEXT, status TEXT, oops TEXT NOT NULL)`,
    );
    (raw as unknown as { close(): void }).close();

    const errSpy = spyOn(console, "error");
    try {
      // Must resolve: startup proceeds despite the failed migration.
      const d = await openDb(path);
      const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).toContain("cluster");
      expect(logged).toContain("FAILED");
      // Writes against the legacy table still work after the failed attempt.
      await d.run(`INSERT OR REPLACE INTO cluster (fingerprint, workspace_id, count, steps, status) VALUES ('fp', 'ws_a', 2, '[]', 'knock')`);
      const row = await d.get<{ count: number }>(`SELECT count FROM cluster WHERE fingerprint = 'fp' AND workspace_id = 'ws_a'`);
      expect(Number(row?.count)).toBe(2);
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the wrap result cache is workspace-scoped", () => {
  /**
   * The cache key used to be `runId:toolId:issues`. Tool ids are UUIDs minted
   * here, so exploiting it needs a bug elsewhere — but one tenant's cached
   * facts answering another tenant's call would be a silent leak, so the
   * workspace belongs in the key as defense-in-depth.
   */
  test("one workspace cannot hit another's cached play under the same run_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-wrap-ws-"));
    try {
      const db = await openDb(join(dir, "w.db"));
      const sharedId = "shared-tool-id";
      const playable = {
        id: sharedId,
        name: "bundle",
        seen: "[]",
        steps: JSON.stringify([
          { id: "s1", kind: "cloud_http", name: "issue", commute: true, url: "http://127.0.0.1/forge/repos/acme/app/issues/{issue}" },
        ]),
      };
      const failing = {
        id: sharedId,
        name: "bundle",
        seen: "[]",
        steps: JSON.stringify([{ id: "s1", kind: "runner", name: "git.status", commute: true }]),
      };

      const a1 = await wrapPlay(db, "ws_a", playable, { issue: "12" }, "http://127.0.0.1", "run-shared");
      expect(a1.ok).toBe(true);

      // Same run_id, same tool id, same args: the old unscoped key returned
      // ws_a's cached success here.
      const b = await wrapPlay(db, "ws_b", failing, { issue: "12" }, "http://127.0.0.1", "run-shared");
      expect(b.ok).toBe(false);

      // ws_a still hits its own cache.
      const a2 = await wrapPlay(db, "ws_a", playable, { issue: "12" }, "http://127.0.0.1", "run-shared");
      expect(a2.ok).toBe(true);
      expect(a2.server_ms).toBe(0);
      expect(a2.facts).toEqual(a1.facts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("batch fan-out over a caller-supplied issues csv is bounded", () => {
  /**
   * playTool replayed every id in the CSV concurrently; a huge list (hostile
   * or accidental) meant thousands of parallel fetches from one request. The
   * cap is MAX_BATCH_ISSUES (100) inside playback.ts.
   */
  test("an oversized csv plays only the capped number of ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-cap-"));
    try {
      const db = await openDb(join(dir, "c.db"));
      await db.run(
        `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
         VALUES ('t-cap', 'ws_local', 'capped', 'x', 'on', ?, '[]', 'fp-cap')`,
        [JSON.stringify([{ id: "s1", kind: "runner", name: "git.status", commute: true }])],
      );
      const tool = await db.get<{ id: string; name: string; steps: string }>(`SELECT id, name, steps FROM tool WHERE id = 't-cap'`);
      const ids = Array.from({ length: 250 }, (_, i) => String(i + 1)).join(",");
      const receipt = await playTool(db, tool!, { ids });
      // One attempted step per id played: 250 requested, 100 played.
      expect(receipt.steps_attempted).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("state-changing requests with a forged Host are refused", () => {
  /**
   * The Origin and Sec-Fetch-Site checks are relative to an origin derived
   * from the request itself (Bun fills req.url from Host), so a DNS-rebinding
   * page — evil.test re-resolved onto this server — passed every check: it
   * sends no Origin, `Sec-Fetch-Site: same-origin`, and a request-derived
   * origin that matches itself. Host is the one header that still tells the
   * truth about which name the client asked for.
   */
  let dir: string;
  let dbFile: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_DB", "EDEN_SKIP_SEED", "EDEN_PUBLIC_URL", "EDEN_DEV"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-host-"));
    dbFile = join(dir, "h.db");
    process.env.EDEN_DB = dbFile;
    process.env.EDEN_SKIP_SEED = "1";
    process.env.EDEN_DEV = "1";
    await openDb(dbFile);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, headers: Record<string, string>) =>
    // Cache-busted import: each suite here owns its private server/db
    // singleton, same reason as the approve-404 suite above.
    import(`./server?bust=${"host-" + Math.random().toString(36).slice(2)}`).then(({ handleFetch }) =>
      handleFetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ run_id: "r1", events: [] }) })),
    );

  test("a rebinding page's shape — no Origin, same-site fetch marker, forged Host — is refused", async () => {
    const res = await post("http://127.0.0.1:8787/v1/ingest", { host: "evil.test", "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(403);
  });

  test("forged Host with an Origin matching the request-derived origin is still refused", async () => {
    const res = await post("http://evil.test:8787/v1/ingest", { host: "evil.test", origin: "http://evil.test:8787" });
    expect(res.status).toBe(403);
  });

  test("a genuine loopback caller passes", async () => {
    const res = await post("http://127.0.0.1:8787/v1/ingest", { host: "127.0.0.1:8787" });
    expect(res.status).not.toBe(403);
  });

  test("EDEN_PUBLIC_URL admits the configured public host over http", async () => {
    process.env.EDEN_PUBLIC_URL = "https://eden.example.com";
    const allowed = await post("http://eden.example.com/v1/ingest", { host: "eden.example.com" });
    expect(allowed.status).not.toBe(403);
  });

  test("without EDEN_PUBLIC_URL the same public host is not admitted", async () => {
    const res = await post("http://eden.example.com/v1/ingest", { host: "eden.example.com" });
    expect(res.status).toBe(403);
  });

  test("a write with no Host header at all is refused (RFC 7230 §5.4, fail-closed)", async () => {
    // Bun does not synthesize Host on constructed Requests, so this really is
    // a Host-less write — the shape a rebinding page could send to slip past
    // every request-derived check.
    const { handleFetch } = await import(`./server?bust=${"nohost-" + Math.random().toString(36).slice(2)}`);
    const res = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: "r1", events: [] }),
      }),
    );
    expect(res.status).toBe(403);
    const res2 = await handleFetch(new Request("http://127.0.0.1:8787/v1/ingest", { method: "POST", body: "{}" }));
    expect(res2.status).toBe(403);
  });
});

describe("approving persists the candidate's shadow manifest", () => {
  /**
   * tool.manifest had no writer at all, so /v1/ledger could never report
   * measured savings. The manifest itself lives in the control plane's gate
   * run — unreachable through any existing helper — so the approve route
   * accepts it as an optional validated body field instead of fabricating
   * numbers.
   */
  let dir: string;
  let dbFile: string;
  let db: Awaited<ReturnType<typeof openDb>>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED", "EDEN_DEV"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-manifest-"));
    dbFile = join(dir, "m.db");
    process.env.EDEN_DB = dbFile;
    process.env.EDEN_SKIP_SEED = "1";
    process.env.EDEN_DEV = "1";
    db = await openDb(dbFile);
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES ('t-m', 'ws_local', 'manifested', 'x', 'draft', '[]', '[]', 'fp-m')`,
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const postJson = (id: string, body?: unknown) =>
    import(`./server?bust=${"manifest-" + Math.random().toString(36).slice(2)}`).then(({ handleFetch }) =>
      handleFetch(
        new Request(`http://127.0.0.1:8787/v1/tools/${id}/approve`, {
          method: "POST",
          headers: { accept: "application/json", host: "127.0.0.1:8787", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      ),
    );

  test("a valid manifest is persisted and the ledger reports it as measured", async () => {
    const res = await postJson("t-m", {
      manifest: { tokensSaved: 1200, timeSavedMs: 4000, tokensMeasured: true, timeMeasured: true },
    });
    expect(res.status).toBe(200);
    const row = await db.get<{ manifest: string | null; state: string }>(`SELECT manifest, state FROM tool WHERE id = 't-m'`);
    expect(row?.state).toBe("on");
    expect(JSON.parse(row!.manifest!)).toEqual({ tokensSaved: 1200, timeSavedMs: 4000, tokensMeasured: true, timeMeasured: true });
    const ledger = await buildLedger(db, "ws_local");
    expect(ledger.tokens_saved_mean).toEqual({ value: 1200, measured: true, estimated: false });
    expect(ledger.time_saved_ms_mean).toEqual({ value: 4000, measured: true });
  });

  test("an invalid manifest is refused without approving anything", async () => {
    const res = await postJson("t-m", { manifest: { tokensSaved: "lots", tokensMeasured: true } });
    expect(res.status).toBe(400);
    // The refusal path exits before the route's own schema ensure, so provide
    // the column here to assert nothing was written into it.
    await ensureLedgerSchema(db);
    const row = await db.get<{ manifest: string | null; state: string }>(`SELECT manifest, state FROM tool WHERE id = 't-m'`);
    expect(row?.state).toBe("draft");
    expect(row?.manifest).toBeNull();
  });

  test("an unknown manifest field is rejected rather than silently dropped", async () => {
    const res = await postJson("t-m", { manifest: { tokensSaved: 5, llmReduction: 9 } });
    expect(res.status).toBe(400);
    expect((await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = 't-m'`))?.state).toBe("draft");
  });

  test("a negative saving is refused — a cost must not render as measured savings", async () => {
    const res = await postJson("t-m", { manifest: { tokensSaved: -42, tokensMeasured: true } });
    expect(res.status).toBe(400);
    // The refusal path exits before the route's own schema ensure, so provide
    // the column here to assert nothing was written into it.
    await ensureLedgerSchema(db);
    const row = await db.get<{ manifest: string | null; state: string }>(`SELECT manifest, state FROM tool WHERE id = 't-m'`);
    expect(row?.state).toBe("draft");
    expect(row?.manifest).toBeNull();
  });

  test("the workshop's form approval carries no manifest and works unchanged", async () => {
    const res = await postJson("t-m");
    expect([200, 303]).toContain(res.status);
    const row = await db.get<{ manifest: string | null; state: string }>(`SELECT manifest, state FROM tool WHERE id = 't-m'`);
    expect(row?.state).toBe("on");
    expect(row?.manifest).toBeNull();
  });
});

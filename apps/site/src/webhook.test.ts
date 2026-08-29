import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { dropResult, publicResultKey, readResult, resetCacheAdmission, resultCacheKey, writeResult } from "./cache";
import { REFRESH_WAITING_COPY } from "./canary";
import {
  WEBHOOK_DROPPED_COPY,
  WEBHOOK_HEADER,
  WEBHOOK_NOOP_COPY,
  WEBHOOK_RAW_ENV,
  WEBHOOK_SECRET_ENV,
  WEBHOOK_SIG_HEADER,
  WEBHOOK_WAITING_COPY,
  handleWebhook,
  invalidateFromWebhook,
  keysToDrop,
  webhookAuthStatus,
  webhookHmacHex,
} from "./webhook";

const mineGetIssue = {
  gatherTracesFn: async () => [
    { id: "t1", input: {}, events: [{ name: "get_issue", args: {}, ok: true }] },
    { id: "t2", input: {}, events: [{ name: "get_issue", args: {}, ok: true }] },
    { id: "t3", input: {}, events: [{ name: "get_issue", args: {}, ok: true }] },
  ],
  compileTracesFn: () => ({
    programs: [{ id: "p1", sequence: ["get_issue"], steps: [{ id: "x1", kind: "tool", tool: "get_issue" }] }],
    refusals: [],
  }),
  shadowProgramFn: async () => ({ verdict: "PASS" as const, reasons: [] }),
};

const SECRET = "whsec_test_15_3";
const GET_URL = "https://api.github.com/repos/acme/app/issues/42";
const STEP = { id: "s1", name: "get_issue", method: "GET" };

function identity(workspaceId: string, toolId = "t_hook") {
  return { workspaceId, toolId, step: STEP, url: GET_URL, bound: {} as Record<string, string> };
}

function webhookReq(over: { secret?: string | null; header?: "named" | "bearer" | "raw" | "none" | "hmac" | "hmac-hub"; body?: unknown; path?: string } = {}): Request {
  const headers: Record<string, string> = { host: "127.0.0.1:8787", "content-type": "application/json" };
  const secret = over.secret === undefined ? SECRET : over.secret;
  const header = over.header ?? "hmac";
  const rawBody = JSON.stringify(over.body ?? {});
  if (header === "named" && secret) headers[WEBHOOK_HEADER] = secret;
  if (header === "bearer" && secret) headers.authorization = `Bearer ${secret}`;
  if (header === "raw" && secret) headers.authorization = secret;
  if ((header === "hmac" || header === "hmac-hub") && secret) {
    const sig = `sha256=${webhookHmacHex(secret, rawBody)}`;
    headers[header === "hmac" ? WEBHOOK_SIG_HEADER : "x-hub-signature-256"] = sig;
  }
  return new Request(`http://127.0.0.1:8787${over.path ?? "/v1/webhook"}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("webhook invalidation", () => {
  const dbP = openDb(`/tmp/eden-webhook-${Date.now()}.db`);
  const savedSecret = process.env[WEBHOOK_SECRET_ENV];
  const savedRaw = process.env[WEBHOOK_RAW_ENV];
  resetCacheAdmission();

  beforeAll(() => {
    process.env[WEBHOOK_SECRET_ENV] = SECRET;
    delete process.env[WEBHOOK_RAW_ENV];
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env[WEBHOOK_SECRET_ENV];
    else process.env[WEBHOOK_SECRET_ENV] = savedSecret;
    if (savedRaw === undefined) delete process.env[WEBHOOK_RAW_ENV];
    else process.env[WEBHOOK_RAW_ENV] = savedRaw;
  });

  test("write GET cache → read hit → webhook drop → read miss (hits 1 then 0)", async () => {
    const db = await dbP;
    const id = identity("ws_hook");
    const key = resultCacheKey(id);
    await writeResult(db, key, { title: "cached" }, 60_000, undefined, { method: "GET", force: true });
    expect(await readResult(db, key)).toEqual({ title: "cached" }); // hit 1

    const res = await handleWebhook(
      db,
      webhookReq({
        header: "hmac",
        body: { keys: [key], toolId: "t_hook", workspaceId: "ws_hook" },
      }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { dropped: string[]; live: string | null; message: string };
    expect(j.dropped).toEqual([key]);
    expect(j.message).toBe(WEBHOOK_DROPPED_COPY);
    expect(j.message).not.toMatch(/renamed a field/);
    expect(await readResult(db, key)).toBeUndefined(); // hit 0
  });

  test("live tool row stays on after drop — webhook is not pause", async () => {
    const db = await dbP;
    const toolId = "t_live_hook";
    await db.run(
      `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES (?, ?, ?, '', 'on', ?, '[]')`,
      [toolId, "ws_hook", "get_issue", JSON.stringify([{ id: "s1", kind: "cloud_http", name: "get_issue", method: "GET", url: GET_URL }])],
    );
    const key = resultCacheKey(identity("ws_hook", toolId));
    await writeResult(db, key, { n: 1 }, 60_000, undefined, { method: "GET", force: true });

    const out = await invalidateFromWebhook(db, { keys: [key], toolId, workspaceId: "ws_hook" });
    expect(out.dropped).toEqual([key]);
    expect(out.live).toBe("on");
    expect(out.message).toBe(WEBHOOK_DROPPED_COPY);
    expect(out.queued).toBe(false);
    const row = await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = ?`, [toolId]);
    expect(row?.state).toBe("on");
    expect(await db.all(`SELECT id FROM tool WHERE workspace_id = ? AND id != ?`, ["ws_hook", toolId])).toEqual([]);
    expect(await db.all(`SELECT id FROM knock WHERE workspace_id = ?`, ["ws_hook"])).toEqual([]);
  });

  test("passing recompile queues a mined draft — not a clone of live steps", async () => {
    const db = await dbP;
    const toolId = "t_mined_hook";
    const liveSteps = JSON.stringify([{ id: "s1", kind: "cloud_http", name: "get_issue", method: "GET", url: GET_URL }]);
    await db.run(
      `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint) VALUES (?, ?, ?, '', 'on', ?, '[]', ?)`,
      [toolId, "ws_mined", "get_issue", liveSteps, "fp/mined/get"],
    );
    const key = resultCacheKey(identity("ws_mined", toolId));
    await writeResult(db, key, { n: 1 }, 60_000, undefined, { method: "GET", force: true });

    const out = await invalidateFromWebhook(db, { keys: [key], toolId, workspaceId: "ws_mined" }, mineGetIssue);
    expect(out.live).toBe("on");
    expect(out.queued).toBe(true);
    expect(out.message).toBe(WEBHOOK_WAITING_COPY);
    expect(out.message).not.toMatch(/renamed a field/);
    expect(WEBHOOK_WAITING_COPY).toContain("unchanged until you Approve");

    const draft = await db.get<{ state: string; when_to_use: string; seen: string; steps: string }>(
      `SELECT state, when_to_use, seen, steps FROM tool WHERE workspace_id = ? AND id != ?`,
      ["ws_mined", toolId],
    );
    expect(draft?.state).toBe("draft");
    expect(draft?.when_to_use).toBe(WEBHOOK_WAITING_COPY);
    expect(draft?.when_to_use).not.toBe(REFRESH_WAITING_COPY);
    expect(JSON.parse(draft?.seen ?? "[]")).toEqual(["get_issue"]);
    const live = await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = ?`, [toolId]);
    expect(live?.state).toBe("on");
  });

  test("empty keys with a live tool queues nothing — not a wipe, not a knock", async () => {
    const db = await dbP;
    const toolId = "t_empty_knock";
    await db.run(
      `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES (?, ?, ?, '', 'on', ?, '[]')`,
      [toolId, "ws_empty_knock", "get_issue", JSON.stringify([{ id: "s1", kind: "cloud_http", name: "get_issue", method: "GET", url: GET_URL }])],
    );
    const key = resultCacheKey(identity("ws_empty_knock", toolId));
    await writeResult(db, key, { v: 1 }, 60_000, undefined, { method: "GET", force: true });

    const empty = await invalidateFromWebhook(db, { keys: [], toolId, workspaceId: "ws_empty_knock" });
    expect(empty.dropped).toEqual([]);
    expect(empty.message).toBe(WEBHOOK_NOOP_COPY);
    expect(empty.message).not.toMatch(/replacement is waiting/);
    expect(await readResult(db, key)).toEqual({ v: 1 });
    expect(await db.all(`SELECT id FROM tool WHERE workspace_id = ? AND id != ?`, ["ws_empty_knock", toolId])).toEqual([]);
    expect(await db.all(`SELECT id FROM knock WHERE workspace_id = ?`, ["ws_empty_knock"])).toEqual([]);
    const live = await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = ?`, [toolId]);
    expect(live?.state).toBe("on");
  });

  test("second webhook does not pile a second draft; live stays on", async () => {
    const db = await dbP;
    const toolId = "t_dampen";
    await db.run(
      `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint) VALUES (?, ?, ?, '', 'on', ?, '[]', ?)`,
      [toolId, "ws_dampen", "get_issue", JSON.stringify([{ id: "s1", kind: "cloud_http", name: "get_issue", method: "GET", url: GET_URL }]), "fp/dampen/get"],
    );
    const key = resultCacheKey(identity("ws_dampen", toolId));
    await writeResult(db, key, { n: 1 }, 60_000, undefined, { method: "GET", force: true });

    await invalidateFromWebhook(db, { keys: [key], toolId, workspaceId: "ws_dampen" }, mineGetIssue);
    await writeResult(db, key, { n: 2 }, 60_000, undefined, { method: "GET", force: true });
    await invalidateFromWebhook(db, { keys: [key], toolId, workspaceId: "ws_dampen" }, mineGetIssue);

    const drafts = await db.all<{ id: string }>(`SELECT id FROM tool WHERE workspace_id = ? AND state = 'draft'`, ["ws_dampen"]);
    expect(drafts.length).toBe(1);
    const live = await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = ?`, [toolId]);
    expect(live?.state).toBe("on");
    const knocks = await db.all(`SELECT id FROM knock WHERE workspace_id = ? AND tool_id = ?`, ["ws_dampen", toolId]);
    expect(knocks.length).toBe(1);
  });

  test("403 does not queue a knock or drop cache", async () => {
    const db = await dbP;
    const toolId = "t_403_knock";
    await db.run(
      `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES (?, ?, ?, '', 'on', ?, '[]')`,
      [toolId, "ws_403", "get_issue", JSON.stringify([{ id: "s1", kind: "cloud_http", name: "get_issue", method: "GET", url: GET_URL }])],
    );
    const key = resultCacheKey(identity("ws_403", toolId));
    await writeResult(db, key, { stay: true }, 60_000, undefined, { method: "GET", force: true });

    const res = await handleWebhook(
      db,
      webhookReq({ secret: "wrong-secret", body: { keys: [key], toolId, workspaceId: "ws_403" } }),
    );
    expect(res.status).toBe(403);
    expect(await readResult(db, key)).toEqual({ stay: true });
    expect(await db.all(`SELECT id FROM knock WHERE workspace_id = ?`, ["ws_403"])).toEqual([]);
    expect(await db.all(`SELECT id FROM tool WHERE workspace_id = ? AND id != ?`, ["ws_403", toolId])).toEqual([]);
  });

  test("bad secret: 403 and cache still hits", async () => {
    const db = await dbP;
    const key = resultCacheKey(identity("ws_hook_auth"));
    await writeResult(db, key, { stay: true }, 60_000, undefined, { method: "GET", force: true });
    expect(await readResult(db, key)).toEqual({ stay: true });

    const res = await handleWebhook(db, webhookReq({ secret: "wrong-secret", body: { keys: [key] } }));
    expect(res.status).toBe(403);
    expect(await readResult(db, key)).toEqual({ stay: true });

    const missing = await handleWebhook(db, webhookReq({ header: "none", body: { keys: [key] } }));
    expect(missing.status).toBe(401);
    expect(await readResult(db, key)).toEqual({ stay: true });
  });

  test("unrelated key is not dropped", async () => {
    const db = await dbP;
    const keep = resultCacheKey(identity("ws_keep"));
    const drop = resultCacheKey(identity("ws_drop_one"));
    await writeResult(db, keep, { keep: 1 }, 60_000, undefined, { method: "GET", force: true });
    await writeResult(db, drop, { drop: 1 }, 60_000, undefined, { method: "GET", force: true });

    const out = await invalidateFromWebhook(db, { keys: [drop] });
    expect(out.dropped).toEqual([drop]);
    expect(await readResult(db, drop)).toBeUndefined();
    expect(await readResult(db, keep)).toEqual({ keep: 1 });
  });

  test("empty keys is a no-op, not a wipe of the whole cache", async () => {
    const db = await dbP;
    const key = resultCacheKey(identity("ws_empty"));
    await writeResult(db, key, { v: 1 }, 60_000, undefined, { method: "GET", force: true });
    const before = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);

    expect(keysToDrop({})).toEqual([]);
    expect(keysToDrop({ keys: [] })).toEqual([]);
    const empty = await handleWebhook(db, webhookReq({ body: { keys: [] } }));
    expect(empty.status).toBe(200);
    const j = (await empty.json()) as { dropped: string[]; message: string };
    expect(j.dropped).toEqual([]);
    expect(j.message).toBe(WEBHOOK_NOOP_COPY);
    expect(await readResult(db, key)).toEqual({ v: 1 });
    const after = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`);
    expect(after?.c ?? 0).toBe(before?.c ?? 0);
  });

  test("public GET identity drops rcp: too; other tenants' private rc: stay", async () => {
    const db = await dbP;
    const a = identity("ws_a", "t_pub");
    const b = identity("ws_b", "t_pub");
    const keyA = resultCacheKey(a);
    const keyB = resultCacheKey(b);
    const pub = publicResultKey(a);
    await writeResult(db, keyA, { a: 1 }, 60_000, undefined, { method: "GET", force: true });
    await writeResult(db, keyB, { b: 1 }, 60_000, undefined, { method: "GET", force: true });
    await writeResult(db, pub, { pub: 1 }, 60_000, undefined, { method: "GET", force: true });

    const out = await invalidateFromWebhook(db, {
      url: GET_URL,
      toolId: "t_pub",
      workspaceId: "ws_a",
      step: STEP,
    });
    expect(out.dropped.sort()).toEqual([keyA, pub].sort());
    expect(await readResult(db, keyA)).toBeUndefined();
    expect(await readResult(db, pub)).toBeUndefined();
    expect(await readResult(db, keyB)).toEqual({ b: 1 });
  });

  test("mutating method identity does not invent a POST cache or wipe GETs", async () => {
    const db = await dbP;
    const getKey = resultCacheKey(identity("ws_mut"));
    await writeResult(db, getKey, { get: 1 }, 60_000, undefined, { method: "GET", force: true });
    expect(keysToDrop({ url: GET_URL, toolId: "t_hook", workspaceId: "ws_mut", step: { ...STEP, method: "POST" } })).toEqual([]);
    const out = await invalidateFromWebhook(db, {
      url: GET_URL,
      toolId: "t_hook",
      workspaceId: "ws_mut",
      step: { ...STEP, method: "POST" },
    });
    expect(out.dropped).toEqual([]);
    expect(await readResult(db, getKey)).toEqual({ get: 1 });
    expect(await dropResult(db, "rc:post-never")).toBe(false);
  });

  test("named header, Bearer, and raw Authorization do not authenticate (HMAC-only)", async () => {
    const db = await dbP;
    const named = await handleWebhook(db, webhookReq({ header: "named", body: { keys: [] } }));
    expect(named.status).toBe(401);
    const bearer = await handleWebhook(db, webhookReq({ header: "bearer", body: { keys: [] } }));
    expect(bearer.status).toBe(401);
    const raw = await handleWebhook(db, webhookReq({ header: "raw", body: { keys: [] } }));
    expect(raw.status).toBe(401);
  });

  test("EDEN_WEBHOOK_RAW=1 restores named / Bearer / raw; empty secret still 401", async () => {
    const db = await dbP;
    const prevRaw = process.env[WEBHOOK_RAW_ENV];
    process.env[WEBHOOK_RAW_ENV] = "1";
    try {
      const named = await handleWebhook(db, webhookReq({ header: "named", body: { keys: [] } }));
      expect(named.status).toBe(200);
      const bearer = await handleWebhook(db, webhookReq({ header: "bearer", body: { keys: [] } }));
      expect(bearer.status).toBe(200);
      const raw = await handleWebhook(db, webhookReq({ header: "raw", body: { keys: [] } }));
      expect(raw.status).toBe(200);
      const j = (await raw.json()) as { message: string };
      expect(j.message).toBe(WEBHOOK_NOOP_COPY);
      expect(j.message).not.toMatch(/replacement is waiting/);

      expect(webhookAuthStatus(webhookReq({ header: "named" }), "", "{}", "1")).toBe(401);
      expect(webhookAuthStatus(webhookReq({ header: "bearer" }), "", "{}", "1")).toBe(401);
      expect(webhookAuthStatus(webhookReq({ header: "hmac" }), "", "{}", "1")).toBe(401);
    } finally {
      if (prevRaw === undefined) delete process.env[WEBHOOK_RAW_ENV];
      else process.env[WEBHOOK_RAW_ENV] = prevRaw;
    }
  });

  test("bare hex MAC is malformed (403); sha256= prefix still authenticates", async () => {
    const emptyBody = "{}";
    const hex = webhookHmacHex(SECRET, emptyBody);

    const bareEden = new Request("http://127.0.0.1:8787/v1/webhook", {
      method: "POST",
      headers: { [WEBHOOK_SIG_HEADER]: hex },
      body: emptyBody,
    });
    expect(webhookAuthStatus(bareEden, SECRET, emptyBody)).toBe(403);

    const bareHub = new Request("http://127.0.0.1:8787/v1/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": hex },
      body: emptyBody,
    });
    expect(webhookAuthStatus(bareHub, SECRET, emptyBody)).toBe(403);

    expect(webhookAuthStatus(webhookReq({ header: "hmac" }), SECRET, emptyBody)).toBe(200);
    expect(webhookAuthStatus(webhookReq({ header: "hmac-hub" }), SECRET, emptyBody)).toBe(200);

    const db = await dbP;
    const bareRes = await handleWebhook(db, bareEden);
    expect(bareRes.status).toBe(403);
    const prefixed = await handleWebhook(db, webhookReq({ header: "hmac", body: { keys: [] } }));
    expect(prefixed.status).toBe(200);
  });

  test("GitHub golden HMAC of the raw body — secret is not a header", () => {
    const secret = "It's a Secret to Everybody";
    const payload = "Hello, World!";
    const hex = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(webhookHmacHex(secret, payload)).toBe(hex);

    const req = new Request("http://127.0.0.1:8787/v1/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${hex}` },
      body: payload,
    });
    expect(req.headers.get(WEBHOOK_HEADER)).toBeNull();
    expect(webhookAuthStatus(req, secret, payload)).toBe(200);
    expect(webhookAuthStatus(req, "", payload)).toBe(401);
  });

  test("HMAC of the body authenticates without sending the secret", async () => {
    const db = await dbP;
    const key = resultCacheKey(identity("ws_hmac"));
    await writeResult(db, key, { v: 1 }, 60_000, undefined, { method: "GET", force: true });
    const ok = await handleWebhook(db, webhookReq({ header: "hmac", body: { keys: [key] } }));
    expect(ok.status).toBe(200);
    expect(await readResult(db, key)).toBeUndefined();

    await writeResult(db, key, { v: 2 }, 60_000, undefined, { method: "GET", force: true });
    const hub = await handleWebhook(db, webhookReq({ header: "hmac-hub", body: { keys: [key] } }));
    expect(hub.status).toBe(200);

    await writeResult(db, key, { v: 3 }, 60_000, undefined, { method: "GET", force: true });
    const wrong = await handleWebhook(
      db,
      webhookReq({ header: "hmac", secret: "wrong-secret", body: { keys: [key] } }),
    );
    expect(wrong.status).toBe(403);
    expect(await readResult(db, key)).toEqual({ v: 3 });
  });

  test("unconfigured secret refuses every drop (fail closed)", async () => {
    const emptyBody = "{}";
    expect(webhookAuthStatus(webhookReq({ header: "hmac", secret: SECRET }), "", emptyBody)).toBe(401);
    expect(webhookAuthStatus(webhookReq({ header: "none" }), SECRET, emptyBody)).toBe(401);
    expect(webhookAuthStatus(webhookReq({ header: "named", secret: SECRET }), SECRET, emptyBody)).toBe(401);
    expect(webhookAuthStatus(webhookReq({ secret: "nope" }), SECRET, emptyBody)).toBe(403);
    expect(webhookAuthStatus(webhookReq({ secret: SECRET }), SECRET, emptyBody)).toBe(200);

    const db = await dbP;
    const key = resultCacheKey(identity("ws_nosec"));
    await writeResult(db, key, { stay: 1 }, 60_000, undefined, { method: "GET", force: true });
    const prev = process.env[WEBHOOK_SECRET_ENV];
    delete process.env[WEBHOOK_SECRET_ENV];
    try {
      const res = await handleWebhook(db, webhookReq({ secret: SECRET, body: { keys: [key] } }));
      expect(res.status).toBe(401);
      expect(await readResult(db, key)).toEqual({ stay: 1 });
    } finally {
      process.env[WEBHOOK_SECRET_ENV] = prev ?? SECRET;
    }
  });
});

describe("POST /v1/webhook route", () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let handleFetch: (req: Request) => Promise<Response>;
  const SERVER_MOD = `./server?bust=webhook-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_DB", "EDEN_SKIP_SEED", WEBHOOK_SECRET_ENV, WEBHOOK_RAW_ENV]) {
      saved[k] = process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-webhook-route-"));
    process.env.EDEN_DB = join(dir, "w.db");
    process.env.EDEN_SKIP_SEED = "1";
    process.env[WEBHOOK_SECRET_ENV] = SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
    delete process.env[WEBHOOK_RAW_ENV];
    ({ handleFetch } = await import(SERVER_MOD));
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("/v1/webhook and /v1/hooks/invalidate accept an HMAC GET drop", async () => {
    const empty = await handleFetch(webhookReq({ body: { keys: [] } }));
    expect(empty.status).toBe(200);
    const j = (await empty.json()) as { dropped: string[] };
    expect(j.dropped).toEqual([]);

    const alias = await handleFetch(webhookReq({ path: "/v1/hooks/invalidate", body: { keys: [] } }));
    expect(alias.status).toBe(200);

    const denied = await handleFetch(webhookReq({ header: "none", body: { keys: ["rc:x"] } }));
    expect(denied.status).toBe(401);
    const named = await handleFetch(webhookReq({ header: "named", body: { keys: ["rc:x"] } }));
    expect(named.status).toBe(401);
    const wrong = await handleFetch(webhookReq({ secret: "nope", body: { keys: ["rc:x"] } }));
    expect(wrong.status).toBe(403);
  });
});

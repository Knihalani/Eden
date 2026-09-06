import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the on-disk driver before the first server import: a DATABASE_URL in
// .env would otherwise send every request down the network driver.
const DB_FILE = mkdtempSync(join(tmpdir(), "eden-validate-")) + "/validate.db";
process.env.EDEN_DB = DB_FILE;
delete process.env.DATABASE_URL;
delete process.env.VERCEL;

// A DATABASE_URL in .env makes openDb treat this as a managed deployment,
// where the permissive dev fallback requires an explicit opt-in.
process.env.EDEN_DEV = "1";

// Private server singleton — a bare `./server` import shares db() with every
// other site suite that also imports without a bust, and under --randomize
// their afterAll rmSync leaves this file's handle pointing at a deleted path
// (SQLite "disk I/O error").
const SERVER_MOD = `./server?bust=validate-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function siteFetch(req: Request): Promise<Response> {
  process.env.EDEN_DB = DB_FILE;
  process.env.EDEN_DEV = "1";
  const { handleFetch } = await import(SERVER_MOD);
  return handleFetch(req);
}

// Host rides along like a real client would send it — the server refuses
// Host-less writes (RFC 7230 §5.4), which Bun's Request constructor does not
// synthesize.
const AUTH = { authorization: "Bearer eden_dev", host: "127.0.0.1" };

afterEach(() => {
  // Tests below flip EDEN_DB; restore the fixture path + dev flag each time.
  process.env.EDEN_DB = DB_FILE;
  process.env.EDEN_DEV = "1";
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
});

/**
 * Bad JSON that *parses* used to reach the handlers as a typed cast and blow
 * up somewhere deeper — a 500 with a stack trace for what is plainly a bad
 * request. Each of these must come back as an intentional 4xx.
 */
describe("request validation", () => {
  test("a null body to /v1/ingest is 400, not a TypeError", async () => {
    const res = await siteFetch(
      new Request("http://127.0.0.1/v1/ingest", { method: "POST", headers: AUTH, body: "null" }),
    );
    expect(res.status).toBe(400);
  });

  test("non-array events are 400", async () => {
    const res = await siteFetch(
      new Request("http://127.0.0.1/v1/ingest", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ run_id: "r1", events: {} }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("an event without a string event_id is 400, naming the index", async () => {
    const res = await siteFetch(
      new Request("http://127.0.0.1/v1/ingest", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          run_id: "r1",
          events: [{ event_id: "ok", seq: 0 }, { seq: 1 }],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("events[1]");
    expect(body.error).toMatch(/event_id|name/);
  });

  test("stretch_end with named events is accepted 1 even when nothing compiles", async () => {
    const res = await siteFetch(
      new Request("http://127.0.0.1/v1/ingest", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          run_id: "judge-1",
          stretch_end: true,
          events: [{ name: "lookupTicket", args: { id: "T-100" }, ok: true }],
        }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok?: boolean; accepted?: number; drafts?: number };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(1);
    const health = await siteFetch(new Request("http://127.0.0.1/health", { headers: AUTH }));
    const h = (await health.json()) as { traces?: number };
    expect(h.traces).toBeGreaterThanOrEqual(1);
  });

  test("missing run_id is 400", async () => {
    const res = await siteFetch(
      new Request("http://127.0.0.1/v1/ingest", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ events: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("/mcp with no method returns the JSON-RPC invalid-request error", async () => {
    const res = await siteFetch(new Request("http://127.0.0.1/mcp", { method: "POST", headers: AUTH, body: "{}" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32600);
  });

  test("/mcp with a null body is 400, not a crash", async () => {
    const res = await siteFetch(new Request("http://127.0.0.1/mcp", { method: "POST", headers: AUTH, body: "null" }));
    expect(res.status).toBe(400);
  });

  test("/v1/play without a name is 400; with an unknown name is 404", async () => {
    const missing = await siteFetch(
      new Request("http://127.0.0.1/v1/play", { method: "POST", headers: AUTH, body: "{}" }),
    );
    expect(missing.status).toBe(400);
    const unknown = await siteFetch(
      new Request("http://127.0.0.1/v1/play", { method: "POST", headers: AUTH, body: JSON.stringify({ name: "nope" }) }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("unknown /v1 is JSON, same contract as local wrap", () => {
  test("keyed unknown route is 404 JSON with protocol header", async () => {
    const { PROTOCOL_HEADER, EDEN_PROTOCOL_VERSION } = await import("@eden/ir");
    const keyed = await siteFetch(
      new Request("http://127.0.0.1/v1/no-such-route", { headers: { authorization: "Bearer eden_dev" } }),
    );
    expect(keyed.status).toBe(404);
    expect(await keyed.json()).toEqual({ error: "not found" });
    expect(keyed.headers.get(PROTOCOL_HEADER)).toBe(String(EDEN_PROTOCOL_VERSION));
  });
});

describe("db open resilience", () => {
  test("a failed open is retried on the next request instead of being cached forever", async () => {
    // The singleton used to hold the rejection permanently: one transient
    // failure at first request poisoned every later request until restart.
    const fresh = await import(`./server?bust=validate-retry-${Date.now()}`);
    const prev = process.env.EDEN_DB;
    process.env.EDEN_DB = "/nonexistent-dir-that-cannot-exist/x.db";
    let failed = false;
    try {
      const bad = await fresh.handleFetch(new Request("http://127.0.0.1/health"));
      expect(bad.status).toBeGreaterThanOrEqual(500);
    } catch {
      // A raw rejection from the server handler is equally acceptable —
      // whatever fronts handleFetch turns it into a 500.
      failed = true;
    } finally {
      process.env.EDEN_DB = prev ?? DB_FILE;
    }
    void failed;
    const good = await fresh.handleFetch(new Request("http://127.0.0.1/health"));
    expect(good.status).toBe(200);
  });
});

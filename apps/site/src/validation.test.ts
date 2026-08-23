import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the on-disk driver before the first server import: a DATABASE_URL in
// .env would otherwise send every request down the network driver.
process.env.EDEN_DB = mkdtempSync(join(tmpdir(), "eden-validate-")) + "/validate.db";

// A DATABASE_URL in .env makes openDb treat this as a managed deployment,
// where the permissive dev fallback requires an explicit opt-in.
const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";

// Host rides along like a real client would send it — the server refuses
// Host-less writes (RFC 7230 §5.4), which Bun's Request constructor does not
// synthesize.
const AUTH = { authorization: "Bearer eden_dev", host: "127.0.0.1" };

afterEach(() => {
  // Tests below flip EDEN_DB; restore the dev flag's environment each time.
  process.env.EDEN_DEV = "1";
});

/**
 * Bad JSON that *parses* used to reach the handlers as a typed cast and blow
 * up somewhere deeper — a 500 with a stack trace for what is plainly a bad
 * request. Each of these must come back as an intentional 4xx.
 */
describe("request validation", () => {
  test("a null body to /v1/ingest is 400, not a TypeError", async () => {
    const { handleFetch } = await import("./server");
    const res = await handleFetch(
      new Request("http://127.0.0.1/v1/ingest", { method: "POST", headers: AUTH, body: "null" }),
    );
    expect(res.status).toBe(400);
  });

  test("non-array events are 400", async () => {
    const { handleFetch } = await import("./server");
    const res = await handleFetch(
      new Request("http://127.0.0.1/v1/ingest", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ run_id: "r1", events: {} }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("an event without a string event_id is 400, naming the index", async () => {
    const { handleFetch } = await import("./server");
    const res = await handleFetch(
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
  });

  test("missing run_id is 400", async () => {
    const { handleFetch } = await import("./server");
    const res = await handleFetch(
      new Request("http://127.0.0.1/v1/ingest", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ events: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("/mcp with no method returns the JSON-RPC invalid-request error", async () => {
    const { handleFetch } = await import("./server");
    const res = await handleFetch(new Request("http://127.0.0.1/mcp", { method: "POST", headers: AUTH, body: "{}" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32600);
  });

  test("/mcp with a null body is 400, not a crash", async () => {
    const { handleFetch } = await import("./server");
    const res = await handleFetch(new Request("http://127.0.0.1/mcp", { method: "POST", headers: AUTH, body: "null" }));
    expect(res.status).toBe(400);
  });

  test("/v1/play without a name is 400; with an unknown name is 404", async () => {
    const { handleFetch } = await import("./server");
    const missing = await handleFetch(
      new Request("http://127.0.0.1/v1/play", { method: "POST", headers: AUTH, body: "{}" }),
    );
    expect(missing.status).toBe(400);
    const unknown = await handleFetch(
      new Request("http://127.0.0.1/v1/play", { method: "POST", headers: AUTH, body: JSON.stringify({ name: "nope" }) }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("db open resilience", () => {
  test("a failed open is retried on the next request instead of being cached forever", async () => {
    // The singleton used to hold the rejection permanently: one transient
    // failure at first request poisoned every later request until restart.
    const fresh = await import(`./server?bust=${Date.now()}`);
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
      process.env.EDEN_DB = prev;
    }
    void failed;
    const good = await fresh.handleFetch(new Request("http://127.0.0.1/health"));
    expect(good.status).toBe(200);
  });
});

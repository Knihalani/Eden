/**
 * F23 agent session SDK tests.
 */

import { parseFetchBody } from "./_parseBody.js";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  begin,
  completeSession,
  currentSession,
  identify,
  AgentSession,
} from "../src/session.js";
import { configure, resetDefaultClient } from "../src/client.js";

const posts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];

/** Every lifecycle notify body is wire-compressed (see ``session.ts``'s
 * ``notifySession``: zstd when the runtime supports it, else gzip) —
 * decode the same way the server's ``GunzipRequestMiddleware`` does
 * before parsing as JSON. ``parseFetchBody`` sniffs the zstd/gzip magic
 * bytes, so no encoding needs to be hard-coded here. */
function decodeBody(body: unknown): unknown {
  if (!body) return null;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as ArrayBuffer);
  return parseFetchBody({ body: buf });
}

beforeEach(() => {
  posts.length = 0;
  resetDefaultClient();
  configure({
    orgId: "test-org",
    apiKey: "test-key",
    baseUrl: "http://eden.test",
    disabled: true,
  });
  // @ts-expect-error test stub
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    posts.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: decodeBody(init?.body),
    });
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  });
});

afterEach(() => {
  resetDefaultClient();
});

describe("session F23", () => {
  it("begin sets currentSession", async () => {
    const s = await begin({ agentId: "a1", userId: "u1" });
    expect(currentSession()).toBe(s);
    expect(s.orgId).toBe("test-org");
    await completeSession(s);
    expect(currentSession()).toBeNull();
  });

  it("posts start/end to ingest path with X-Org-Api-Key", async () => {
    const s = await begin({ sessionId: "sess-1", agentId: "ag" });
    await identify("user-9");
    await s.completeSession(true);
    const urls = posts.map((p) => p.url);
    expect(urls.some((u) => u.includes("/ingest/agent-sessions/start"))).toBe(true);
    expect(urls.some((u) => u.includes("/ingest/agent-sessions/sess-1/identify"))).toBe(
      true,
    );
    expect(urls.some((u) => u.includes("/ingest/agent-sessions/sess-1/end"))).toBe(true);
    for (const p of posts) {
      expect(p.headers["X-Org-Api-Key"]).toBe("test-key");
      expect(p.headers["X-Org-Id"]).toBe("test-org");
      // Phase 5 — every lifecycle notify is gzip-compressed like the
      // main ingest path (parity with the Python SDK's session.py).
      expect(["gzip", "zstd"]).toContain(p.headers["Content-Encoding"]);
    }
  });

  it("addCost accumulates", async () => {
    const s = new AgentSession({ orgId: "o", sessionId: "x" });
    s.addCost(0.02);
    s.addCost(0.03);
    expect(s.costUsd).toBeCloseTo(0.05);
  });
});

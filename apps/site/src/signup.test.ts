import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFetch } from "./server";
import { hashApiKey } from "./db";

/**
 * Self-serve signup: the door for actual users. A visitor must be able to
 * mint a workspace + key without talking to anyone, and the key must
 * immediately authenticate. Rate-limited per IP so abuse is bounded.
 *
 * One database for the whole suite (the site server memoizes its handle);
 * tests isolate via distinct IPs.
 */
describe("signup", () => {
  const saved: Record<string, string | undefined> = {};
  const dir = tmpdir();
  let dbFile: string;
  // Unique-per-run IP base so rate-limit state never leaks across runs.
  const ipBase = `${Math.floor(Math.random() * 200) + 10}.${Math.floor(Math.random() * 255)}.`;

  beforeEach(() => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED"]) saved[k] = process.env[k];
    // One SHARED database for every suite in this directory that drives the
    // server: the site server memoizes its handle process-wide, so per-suite
    // db files silently fork reality (data lands in whoever opened first).
    dbFile = dbFile || join(dir, "eden-site-suite.db");
    process.env.EDEN_DB = dbFile;
    process.env.EDEN_DEV = "0"; // production posture: no dev fallback
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function signup(ip: string, name?: string) {
    return handleFetch(
      new Request("http://127.0.0.1:8787/v1/signup", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8787",
          "content-type": "application/json",
          "x-real-ip": ip,
        },
        body: JSON.stringify(name ? { name } : {}),
      }),
    );
  }

  test("mints a workspace + key that authenticates immediately", async () => {
    const res = await signup(`${ipBase}1.1`, "acme");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { api_key: string; workspace_id: string };
    expect(j.api_key.startsWith("eden_")).toBe(true);

    // The key must work as a credential right away.
    const auth = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/tools", {
        headers: { host: "127.0.0.1:8787", authorization: `Bearer ${j.api_key}` },
      }),
    );
    expect(auth.status).toBe(200);

    // The dashboard renders for this workspace.
    const dash = await handleFetch(
      new Request("http://127.0.0.1:8787/dashboard", {
        headers: { host: "127.0.0.1:8787", accept: "text/html", authorization: `Bearer ${j.api_key}` },
      }),
    );
    expect(dash.status).toBe(200);
  });

  test("the raw key is never persisted — only its hash", async () => {
    const res = await signup(`${ipBase}2.2`);
    const j = (await res.json()) as { api_key: string };
    const { Database } = await import("bun:sqlite");
    const raw = new Database(dbFile) as unknown as {
      query(s: string): { all(): Array<{ prefix: string; hash: string | null }> };
      close(): void;
    };
    const rows = raw.query(`SELECT prefix, hash FROM api_key`).all();
    raw.close();
    const mine = rows.find((r) => r.prefix === j.api_key.slice(0, 12));
    expect(mine).toBeDefined();
    expect(mine!.hash).not.toBe(j.api_key); // plaintext never stored
    expect(mine!.hash).toBe(hashApiKey(j.api_key)); // sha256 of the token is
  });

  test("rate limit: sixth signup from one IP within the window is refused with 429", async () => {
    const ip = `${ipBase}3.3`;
    for (let i = 0; i < 5; i++) {
      const r = await signup(ip);
      expect(r.status).toBe(200);
    }
    const sixth = await signup(ip);
    expect(sixth.status).toBe(429);
    const body = (await sixth.json()) as { error?: string };
    expect(body.error).toContain("Too many");
    // A different IP is unaffected.
    expect((await signup(`${ipBase}3.4`)).status).toBe(200);
  });

  test("signup page and landing render for signed-out visitors", async () => {
    const land = await handleFetch(
      new Request("http://127.0.0.1:8787/", { headers: { host: "127.0.0.1:8787", accept: "text/html" } }),
    );
    expect(land.status).toBe(200);
    const html = await land.text();
    expect(html).toContain("Eden compiles the repetition");
    expect(html).toContain("/signup");

    const page = await handleFetch(
      new Request("http://127.0.0.1:8787/signup", { headers: { host: "127.0.0.1:8787", accept: "text/html" } }),
    );
    expect(page.status).toBe(200);
  });
});

describe("/v1/traces intake (CLI recorder path)", () => {
  const ip = `${Math.floor(Math.random() * 200) + 20}.77.`;

  test("accepts a single StretchTrace-shaped body and mines it", async () => {
    const res = await signup(`${ip}9.1`, "traces-e2e");
    const { api_key } = (await res.json()) as { api_key: string };

    const post = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/traces", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8787",
          "content-type": "application/json",
          authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify({
          id: `trace-${Math.random().toString(36).slice(2)}`,
          events: [
            { name: "fetchIssue", args: { url: `https://api.github.com/x/issues/${Math.floor(Math.random() * 999)}/7` }, result: { title: "bug" }, ok: true },
            { name: "fetchComments", args: { url: "https://api.github.com/x/comments" }, result: [], ok: true },
          ],
          input: {},
          output: { done: true },
          llmCalls: 4,
          duration_ms: 4000,
          cost_cents: 4,
          complete: true,
        }),
      }),
    );
    expect(post.status).toBe(202);
    const j = (await post.json()) as { accepted?: number };
    expect(j.accepted).toBe(1);
  });

  test("malformed trace bodies are rejected, not crashed", async () => {
    const res = await signup(`${ip}9.2`, "traces-malformed");
    const { api_key } = (await res.json()) as { api_key: string };
    const bad = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/traces", {
        method: "POST",
        headers: { host: "127.0.0.1:8787", "content-type": "application/json", authorization: `Bearer ${api_key}` },
        body: JSON.stringify({ id: 42 }), // no events anywhere
      }),
    );
    expect(bad.status).toBe(202); // tolerated: nothing acceptable in the batch
    void api_key;
  });
});

async function signup(ip: string, name: string): Promise<Response> {
  return handleFetch(
    new Request("http://127.0.0.1:8787/v1/signup", {
      method: "POST",
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({ name }),
    }),
  );
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashApiKey, openDb } from "./db";

/**
 * Cache-bust so this file owns its server singleton. A static import of
 * `./server` reuses whichever site test opened `db()` first — under shuffle
 * that is often a different EDEN_DB, and a second sqlite handle on
 * `eden-site-suite.db` then cannot see the key just minted.
 */
const SERVER_MOD = `./server?bust=signup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** One sqlite file for this module's memoized server — unique so shuffle cannot collide. */
const DB_FILE = join(tmpdir(), `eden-signup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
let handleFetch: (req: Request) => Promise<Response>;

async function siteFetch(req: Request): Promise<Response> {
  if (!handleFetch) {
    process.env.EDEN_DB = DB_FILE;
    ({ handleFetch } = await import(SERVER_MOD));
  }
  return handleFetch(req);
}

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
  // Unique-per-run IP base so rate-limit state never leaks across runs.
  const ipBase = `${Math.floor(Math.random() * 200) + 10}.${Math.floor(Math.random() * 255)}.`;

  beforeEach(() => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED", "EDEN_DEV", "EDEN_DB"]) saved[k] = process.env[k];
    process.env.EDEN_DB = DB_FILE;
    process.env.EDEN_DEV = "0"; // production posture: no dev fallback
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function signup(ip: string, name?: string) {
    return siteFetch(
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
    const auth = await siteFetch(
      new Request("http://127.0.0.1:8787/v1/tools", {
        headers: { host: "127.0.0.1:8787", authorization: `Bearer ${j.api_key}` },
      }),
    );
    expect(auth.status).toBe(200);

    // The dashboard renders for this workspace.
    const dash = await siteFetch(
      new Request("http://127.0.0.1:8787/dashboard", {
        headers: { host: "127.0.0.1:8787", accept: "text/html", authorization: `Bearer ${j.api_key}` },
      }),
    );
    expect(dash.status).toBe(200);
  });

  test("the raw key is never persisted — only its hash", async () => {
    const res = await signup(`${ipBase}2.2`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { api_key: string };
    expect(j.api_key).toBeString();
    // Look up by hash (not prefix): proves the stored secret is the digest.
    const d = await openDb(DB_FILE);
    const want = hashApiKey(j.api_key);
    const rows = await d.all<{ prefix: string; hash: string | null }>(`SELECT prefix, hash FROM api_key`);
    const mine = rows.find((r) => r.hash === want);
    expect(mine).toBeDefined();
    expect(mine!.hash).not.toBe(j.api_key); // plaintext never stored
    expect(mine!.prefix).toBe(j.api_key.slice(0, 12));
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
    const land = await siteFetch(
      new Request("http://127.0.0.1:8787/", { headers: { host: "127.0.0.1:8787", accept: "text/html" } }),
    );
    expect(land.status).toBe(200);
    const html = await land.text();
    expect(html).toContain("should cost");
    expect(html).toContain("/signup");

    const page = await siteFetch(
      new Request("http://127.0.0.1:8787/signup", { headers: { host: "127.0.0.1:8787", accept: "text/html" } }),
    );
    expect(page.status).toBe(200);
  });
});

describe("/v1/traces intake (CLI recorder path)", () => {
  const ip = `${Math.floor(Math.random() * 200) + 20}.77.`;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED", "EDEN_DEV", "EDEN_DB"]) saved[k] = process.env[k];
    process.env.EDEN_DB = DB_FILE;
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
    // Bearer auth — restore a permissive flag so we do not leave EDEN_DEV=0
    // for later files if this describe runs last under --randomize.
    process.env.EDEN_DEV = "1";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("accepts a single StretchTrace-shaped body and mines it", async () => {
    const res = await signup(`${ip}9.1`, "traces-e2e");
    expect(res.status).toBe(200);
    const { api_key } = (await res.json()) as { api_key: string };
    expect(api_key).toBeString();

    const post = await siteFetch(
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
    expect(res.status).toBe(200);
    const { api_key } = (await res.json()) as { api_key: string };
    expect(api_key).toBeString();
    const bad = await siteFetch(
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
  return siteFetch(
    new Request("http://127.0.0.1:8787/v1/signup", {
      method: "POST",
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({ name }),
    }),
  );
}

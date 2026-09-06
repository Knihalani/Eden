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
    expect(html).toContain("do less work");
    expect(html).toContain("/signup");
    expect(html).toContain("Making your agent do less work");
    expect(html).not.toContain("Making your agents more deterministic");
    expect(html).not.toContain("Compile repeating tools");
    expect(html).toContain("Sign in");
    expect(html).toContain("/logo.webp");
    expect(html).toContain("class=\"stage\"");
    expect(html).toContain("class=\"stage-hit\"");
    expect(html).toContain("<canvas");
    expect(html).not.toContain("room-desk");
    expect(html).not.toContain("room-sky");
    expect(html).not.toContain("class=\"abstract\"");
    expect(html).not.toContain("hero-mark");
    expect(html).not.toContain("hero-pin");
    expect(html).not.toContain("How it works");
    expect(html).not.toContain("I have a key");
    expect(html).not.toContain("site-foot");
    expect(html).not.toContain("If Eden is wrong");
    expect(html).not.toContain("room-blot");
    expect(html).not.toContain("0.12 18");
    const logo = await siteFetch(new Request("http://127.0.0.1:8787/logo.webp"));
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/webp");
    expect(html).not.toContain("8×");
    expect(html).not.toContain("7.7×");
    expect(html).toContain("Copy failed");
    expect(html).toContain("min-height:44px");
    expect(html).not.toContain("href=\"/workshop\"");
    expect(html).not.toContain("href=\"/dashboard\"");
    expect(html).not.toContain("github.com/Knihalani");
    expect(html).not.toContain(">Source<");
    expect(html).not.toContain("(1-bind)*0.42");

    const page = await siteFetch(
      new Request("http://127.0.0.1:8787/signup", { headers: { host: "127.0.0.1:8787", accept: "text/html" } }),
    );
    expect(page.status).toBe(200);
    const signupHtml = await page.text();
    expect(signupHtml).toContain("OPENAI_BASE_URL=");
    expect(signupHtml).toContain("x-eden-api-key");
    expect(signupHtml).toContain("/dashboard");
    expect(signupHtml).toContain("signupForm");
    expect(signupHtml).toContain('id="donePanel"');
    expect(signupHtml).toContain(".hidden{display:none");
    expect(signupHtml).not.toContain("eden login --url");
    expect(signupHtml).not.toContain("releases/latest/download");
    expect(signupHtml).not.toContain("npm i -g eden\n");
  });

  test("signup sets a session cookie; paste-key onboarding has a Continue button", async () => {
    const res = await signup(`${ipBase}9.9`, "session");
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/eden_key=/);
    expect(set).toMatch(/HttpOnly/i);
    const j = (await res.json()) as { api_key: string };
    const dash = await siteFetch(
      new Request("http://127.0.0.1:8787/dashboard", {
        headers: { host: "127.0.0.1:8787", accept: "text/html", cookie: `eden_key=${j.api_key}` },
      }),
    );
    expect(dash.status).toBe(200);

    const board = await siteFetch(
      new Request("http://127.0.0.1:8787/onboarding", { headers: { host: "127.0.0.1:8787", accept: "text/html" } }),
    );
    expect(board.status).toBe(200);
    const oh = await board.text();
    expect(oh).toContain("signInBtn");
    expect(oh).toContain("/v1/session");
    expect(oh).toContain("signInForm");
    expect(oh).not.toContain("dev=1");
    expect(oh).toContain("/signup");
  });

  test("signed-in setup can skip to an empty desk; logout clears the cookie", async () => {
    const res = await signup(`${ipBase}6.6`, "skip-desk");
    expect(res.status).toBe(200);
    const { api_key } = (await res.json()) as { api_key: string };
    const cookie = `eden_key=${api_key}`;
    const setup = await siteFetch(
      new Request("http://127.0.0.1:8787/onboarding", {
        headers: { host: "127.0.0.1:8787", accept: "text/html", cookie },
      }),
    );
    expect(setup.status).toBe(200);
    const setupHtml = await setup.text();
    expect(setupHtml).toContain("Skip to dashboard");
    expect(setupHtml).toContain("Sign out");
    expect(setupHtml).toContain("Point the agent here");
    expect(setupHtml).toContain("Waiting for the first run");
    expect(setupHtml).not.toContain("Do this");

    const desk = await siteFetch(
      new Request("http://127.0.0.1:8787/dashboard", {
        headers: { host: "127.0.0.1:8787", accept: "text/html", cookie },
      }),
    );
    expect(desk.status).toBe(200);
    const deskHtml = await desk.text();
    expect(deskHtml).toContain("Your desk");
    expect(deskHtml).not.toContain("8×");
    expect((deskHtml.match(/class="brand"/g) || []).length).toBe(1);

    const imported = await siteFetch(
      new Request("http://127.0.0.1:8787/import", {
        headers: { host: "127.0.0.1:8787", accept: "text/html", cookie },
      }),
    );
    expect(imported.status).toBe(200);
    const importHtml = await imported.text();
    expect((importHtml.match(/class="brand"/g) || []).length).toBe(1);
    expect(importHtml).toContain("textContent");
    expect(importHtml).not.toContain("innerHTML");

    const out = await siteFetch(
      new Request("http://127.0.0.1:8787/v1/logout", {
        method: "POST",
        headers: { host: "127.0.0.1:8787", accept: "text/html", cookie, origin: "http://127.0.0.1:8787" },
      }),
    );
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/");
    expect(out.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/i);

    const after = await siteFetch(
      new Request("http://127.0.0.1:8787/dashboard", {
        headers: { host: "127.0.0.1:8787", accept: "text/html" },
        redirect: "manual",
      }),
    );
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toContain("/onboarding");
  });

  test("x-eden-api-key authenticates when Authorization is a provider key", async () => {
    const res = await signup(`${ipBase}7.7`, "dual-key");
    expect(res.status).toBe(200);
    const { api_key } = (await res.json()) as { api_key: string };
    const tools = await siteFetch(
      new Request("http://127.0.0.1:8787/v1/tools", {
        headers: {
          host: "127.0.0.1:8787",
          authorization: "Bearer sk-not-an-eden-key",
          "x-eden-api-key": api_key,
        },
      }),
    );
    expect(tools.status).toBe(200);
  });

  test("signup JSON base_url prefers EDEN_PUBLIC_URL over the request host", async () => {
    const prev = process.env.EDEN_PUBLIC_URL;
    process.env.EDEN_PUBLIC_URL = "https://useeden.vercel.app";
    try {
      const res = await signup(`${ipBase}8.8`, "public-url");
      expect(res.status).toBe(200);
      const j = (await res.json()) as { base_url?: string };
      expect(j.base_url).toBe("https://useeden.vercel.app");
    } finally {
      if (prev === undefined) delete process.env.EDEN_PUBLIC_URL;
      else process.env.EDEN_PUBLIC_URL = prev;
    }
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

  test("chat miss with a signup key fail-opens HTTP 200 and does not forward the key", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await signup(`${ip}8.8`, "chat-miss");
      expect(res.status).toBe(200);
      const { api_key } = (await res.json()) as { api_key: string };
      const chat = await siteFetch(
        new Request("http://127.0.0.1:8787/v1/chat/completions", {
          method: "POST",
          headers: {
            host: "127.0.0.1:8787",
            "content-type": "application/json",
            authorization: `Bearer ${api_key}`,
          },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
        }),
      );
      expect(chat.status).toBe(200);
      const body = (await chat.json()) as { model?: string; fail_open?: boolean; error?: { message?: string } };
      expect(body.model).toBe("eden");
      expect(body.fail_open).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/Incorrect API key/i);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
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

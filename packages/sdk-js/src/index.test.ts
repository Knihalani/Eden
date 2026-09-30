import { describe, expect, test, afterAll, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, endStretch, Eden, EDEN_PROTOCOL_VERSION } from "./index";

/**
 * The SDK is the primary product surface for custom agents: import, wrap
 * your tools, get compiled results when available, fall back to originals
 * otherwise. These tests prove the contract WITHOUT any Eden infrastructure
 * — just a mock HTTP endpoint (Bun.serve on port 0).
 */

type Hit = { path: string; version: string | null; auth: string | null; body: unknown };

function mockWrap(replies: {
  wrap?: unknown;
  wrapStatus?: number;
  ingest?: unknown;
  ingestStatus?: number;
}): { hits: Hit[]; url: string; stop: () => void } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const version = req.headers.get("x-eden-version");
      const auth = req.headers.get("authorization");
      const body = await req.json().catch(() => ({}));
      hits.push({ path, version, auth, body });
      if (path === "/v1/wrap") {
        return Response.json(replies.wrap ?? { action: "original" }, {
          status: replies.wrapStatus ?? 200,
        });
      }
      if (path === "/v1/ingest") {
        return Response.json(replies.ingest ?? { ok: true }, {
          status: replies.ingestStatus ?? 200,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    hits,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

describe("sdk-js", () => {
  const saved = process.env.EDEN_BASE_URL;
  const savedKey = process.env.EDEN_API_KEY;
  const savedHome = process.env.EDEN_HOME;
  // Never the real ~/.eden: the loopback default reads config.json from EDEN_HOME.
  const home = mkdtempSync(join(tmpdir(), "eden-sdk-js-"));
  beforeAll(() => {
    process.env.EDEN_HOME = home;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.EDEN_BASE_URL = saved;
    else delete process.env.EDEN_BASE_URL;
    if (savedKey !== undefined) process.env.EDEN_API_KEY = savedKey;
    else delete process.env.EDEN_API_KEY;
    rmSync(join(home, "config.json"), { force: true });
  });
  afterAll(() => {
    if (savedHome !== undefined) process.env.EDEN_HOME = savedHome;
    else delete process.env.EDEN_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test("package.json has no workspace Know dependency", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      name?: string;
      main?: string;
      dependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe("@kaiavn/sdk");
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.dependencies?.["@eden/know"]).toBeUndefined();
    expect(JSON.stringify(pkg.dependencies ?? {})).not.toContain("workspace:");
  });

  test("loopback defaults eden_dev; a hosted origin does not", async () => {
    delete process.env.EDEN_API_KEY;
    const loop = mockWrap({ wrap: { action: "play", facts: { ok: true } } });
    try {
      await runTool("search", { q: "x" }, async () => "raw", { baseUrl: loop.url });
      expect(loop.hits[0]?.auth).toBe("Bearer eden_dev");
    } finally {
      loop.stop();
    }

    const orig = globalThis.fetch;
    let hostedAuth = "";
    globalThis.fetch = (async (_input, init) => {
      hostedAuth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ action: "play", facts: { ok: true } }), { status: 200 });
    }) as typeof fetch;
    try {
      const out = await runTool("search", { q: "x" }, async () => "raw", {
        baseUrl: "https://useeden.vercel.app",
      });
      expect(out).toEqual({ ok: true });
      expect(hostedAuth.toLowerCase().startsWith("bearer")).toBe(true);
      expect(hostedAuth).not.toContain("eden_dev");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("loopback sends the key eden wrap saved, only to the port it was saved for", async () => {
    delete process.env.EDEN_API_KEY;
    const key = `eden_local_${"ab".repeat(32)}`;
    const loop = mockWrap({ wrap: { action: "original" } });
    const save = (base_url: string) =>
      writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: key, base_url }));
    try {
      save(loop.url);
      await runTool("search", { q: "x" }, async () => "raw", { baseUrl: loop.url });
      expect(loop.hits.map((h) => h.auth)).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
      // Saved for another port (or for a hosted origin): the demo's eden_dev, never the key.
      for (const other of ["http://127.0.0.1:1", "https://useeden.vercel.app"]) {
        save(other);
        loop.hits.length = 0;
        await runTool("search", { q: "x" }, async () => "raw", { baseUrl: loop.url });
        expect(loop.hits[0]?.auth).toBe("Bearer eden_dev");
      }
    } finally {
      loop.stop();
    }

    const orig = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ action: "play", facts: { ok: true } }), { status: 200 });
    }) as typeof fetch;
    try {
      save("http://127.0.0.1:8788");
      for (const baseUrl of ["https://useeden.vercel.app", "http://localhost:8788@evil.example"]) {
        await runTool("search", { q: "x" }, async () => "raw", { baseUrl });
      }
      expect(sent.length).toBe(2);
      for (const auth of sent) expect(auth).not.toContain(key);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("protocol version is 1 and is sent as x-eden-version", async () => {
    expect(EDEN_PROTOCOL_VERSION).toBe(1);
    const mock = mockWrap({ wrap: { action: "play", facts: { ok: true } } });
    try {
      await runTool("search", { q: "x" }, async () => "raw", { baseUrl: mock.url });
      expect(mock.hits[0]?.version).toBe(String(EDEN_PROTOCOL_VERSION));
    } finally {
      mock.stop();
    }
  });

  test("play facts → original is never called, result is facts", async () => {
    const mock = mockWrap({ wrap: { action: "play", facts: { ok: true } } });
    const calls: string[] = [];
    try {
      const original = async () => {
        calls.push("original");
        return "raw";
      };
      const out = await runTool("search", { q: "x" }, original, { baseUrl: mock.url });
      expect(out).toEqual({ ok: true });
      expect(calls).toEqual([]);
      expect(mock.hits.map((h) => h.path)).toEqual(["/v1/wrap"]);
    } finally {
      mock.stop();
    }
  });

  test("action original → original is called, then ingest", async () => {
    const mock = mockWrap({ wrap: { action: "original" } });
    const calls: string[] = [];
    try {
      const original = async () => {
        calls.push("original");
        return "raw";
      };
      const out = await runTool("search", { q: "x" }, original, { baseUrl: mock.url });
      expect(out).toBe("raw");
      expect(calls).toEqual(["original"]);
      expect(mock.hits.map((h) => h.path)).toEqual(["/v1/wrap", "/v1/ingest"]);
      expect(mock.hits[1]?.version).toBe("1");
    } finally {
      mock.stop();
    }
  });

  test("server down → original is called", async () => {
    process.env.EDEN_BASE_URL = "http://127.0.0.1:1";
    const calls: string[] = [];
    const original = async () => {
      calls.push("original");
      return "raw";
    };
    const out = await runTool("search", { q: "x" }, original);
    expect(out).toBe("raw");
    expect(calls).toEqual(["original"]);
  });

  test("ingest after original is fire-and-forget (no throw)", async () => {
    const mock = mockWrap({ wrap: { action: "original" }, ingestStatus: 500 });
    try {
      const out = await runTool("search", { q: "x" }, async () => "raw", { baseUrl: mock.url });
      expect(out).toBe("raw");
      expect(mock.hits.some((h) => h.path === "/v1/ingest")).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("endStretch posts without error even when server unreachable", async () => {
    process.env.EDEN_BASE_URL = "http://127.0.0.1:1";
    await endStretch("run-1");
    // No throw = pass. Fire-and-forget recording must never break the caller.
  });

  test("know fails open and does not throw", async () => {
    const card = await new Eden().know("");
    expect("unknown" in card || "fact" in card).toBe(true);
  });
});

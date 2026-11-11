import { afterEach, describe, expect, test } from "bun:test";
import { EdenClient } from "./client";
import { defaultOnError, edenEnv, fixFor, resetDefaultOnError } from "./on-error";

afterEach(() => resetDefaultOnError());

const refusing = (status: number, error: string): typeof fetch =>
  (async () => Response.json({ error }, { status })) as unknown as typeof fetch;

describe("the default onError (D850)", () => {
  test("edenEnv reads EDEN_ENV, then NODE_ENV; anything but production is development", () => {
    expect(edenEnv({})).toBe("development");
    expect(edenEnv({ NODE_ENV: "production" })).toBe("production");
    expect(edenEnv({ NODE_ENV: "production", EDEN_ENV: "development" })).toBe("development");
    expect(edenEnv({ EDEN_ENV: " PROD " })).toBe("production");
    expect(edenEnv({ NODE_ENV: "test" })).toBe("development");
  });

  test("each common misuse gets a fix", () => {
    expect(fixFor("eden: userId must be 1-128 characters of [A-Za-z0-9._:@-] (map ids with edenId)")).toContain(
      "edenId",
    );
    expect(fixFor("eden /v1/events: cannot reach http://127.0.0.1:9 (refused)")).toContain("start the server");
    expect(fixFor("eden /v1/events: 401 unauthorized")).toContain("apiKey");
    expect(fixFor("eden /v1/events: 403 tenant mismatch")).toContain("tenant");
    expect(fixFor("eden /v1/events: 404")).toContain("baseUrl");
    expect(fixFor("eden /v1/pending: not a pending answer")).toContain("something other than Eden");
    expect(fixFor("eden /v1/events: 503 busy")).toContain("server failed");
    expect(fixFor("something else")).toBeNull();
  });

  test("development prints every distinct problem once, with its fix, and never throws", () => {
    const lines: string[] = [];
    const onError = defaultOnError("development", (l) => lines.push(l));
    onError(new Error("eden /v1/events: 401 unauthorized"));
    onError(new Error("eden /v1/events: 401 unauthorized"));
    onError(new Error("eden /v1/pending: 401 unauthorized"));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("fix: the server refused the key");
    expect(lines[0]).toContain("failed open");
  });

  test("production prints the first problem of each route and status once", () => {
    const lines: string[] = [];
    const onError = defaultOnError("production", (l) => lines.push(l));
    onError(new Error("eden /v1/events: cannot reach http://a (no answer within 800 ms)"));
    onError(new Error("eden /v1/events: cannot reach http://a (ECONNRESET)"));
    onError(new Error("eden /v1/events: 503 busy"));
    onError(new Error("eden /v1/events: 503 overloaded"));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("further errors of this kind are not printed");
  });

  test("a client with no onError uses the default; null silences it; a function replaces it", async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (l: string) => void warned.push(l);
    try {
      const fetch = refusing(401, "unauthorized");
      const loud = new EdenClient({ userId: "u", sessionId: "s", apiKey: "secret-key-123", fetch });
      expect(await loud.pending()).toEqual([]);
      expect(warned.length).toBe(1);
      expect(warned[0]).toContain("401");
      // The key never reaches the line.
      expect(warned[0]).not.toContain("secret-key-123");
      resetDefaultOnError();
      await new EdenClient({ userId: "u", sessionId: "s", fetch, onError: null }).pending();
      const mine: unknown[] = [];
      await new EdenClient({ userId: "u", sessionId: "s", fetch, onError: (e) => mine.push(e) }).pending();
      expect(warned.length).toBe(1);
      expect(mine.length).toBe(1);
    } finally {
      console.warn = original;
    }
  });

  test("a bad id is printed at construction with the edenId fix, without the id", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (l: string) => void warned.push(l);
    try {
      new EdenClient({ userId: "alice+work@x.com", sessionId: "s" });
      expect(warned.length).toBe(1);
      expect(warned[0]).toContain("edenId");
      expect(warned[0]).not.toContain("alice");
    } finally {
      console.warn = original;
    }
  });
});

describe("EDEN_URL and EDEN_API_KEY as defaults (D856)", () => {
  test("unset options read the environment; explicit ones win; an explicit empty key sends none", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return Response.json({ injections: [] });
    }) as unknown as typeof globalThis.fetch;
    const before = { url: process.env.EDEN_URL, key: process.env.EDEN_API_KEY };
    process.env.EDEN_URL = "http://eden.test:9100/";
    process.env.EDEN_API_KEY = "k_env_0123456789abcdef";
    try {
      await new EdenClient({ userId: "u", sessionId: "s", fetch, onError: null }).pending();
      await new EdenClient({
        userId: "u",
        sessionId: "s",
        fetch,
        onError: null,
        baseUrl: "http://other:1",
        apiKey: "k_mine_0123456789abc",
      }).pending();
      await new EdenClient({ userId: "u", sessionId: "s", fetch, onError: null, apiKey: "" }).pending();
    } finally {
      if (before.url === undefined) delete process.env.EDEN_URL;
      else process.env.EDEN_URL = before.url;
      if (before.key === undefined) delete process.env.EDEN_API_KEY;
      else process.env.EDEN_API_KEY = before.key;
    }
    expect(seen).toEqual([
      { url: "http://eden.test:9100/v1/pending", auth: "Bearer k_env_0123456789abcdef" },
      { url: "http://other:1/v1/pending", auth: "Bearer k_mine_0123456789abc" },
      { url: "http://eden.test:9100/v1/pending", auth: null },
    ]);
  });
});

test("with no global process (a browser bundle), the client is built and fails open (D14)", async () => {
  const saved = globalThis.process;
  // @ts-expect-error: the runtime a browser bundle sees
  delete globalThis.process;
  try {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (l: string) => void warned.push(l);
    try {
      const fetch = refusing(401, "unauthorized");
      const eden = new EdenClient({ userId: "u", sessionId: "s", fetch, baseUrl: "http://eden.test" });
      expect(await eden.pending()).toEqual([]);
      expect(warned.length).toBe(1);
    } finally {
      console.warn = original;
    }
  } finally {
    globalThis.process = saved;
  }
});

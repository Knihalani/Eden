/**
 * `oauth.ts` (D1874): the authorization flow against the official SDK's own authorization server (its
 * `mcpAuthRouter` with the demo provider it ships, which checks PKCE and the resource), and against hostile fakes:
 * a mismatched issuer, oversized metadata, a redirect to another origin, plain HTTP, metadata for another resource,
 * a forged state, a token leaking to another origin, and refresh run once for many callers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { AddressInfo } from "node:net";
import { McpClient } from "./client";
import { StreamableHttpTransport } from "./http";
import { MemoryTokenStore, OAuthClientProvider, OAuthError, parseChallenge, type StoredTokens } from "./oauth";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** The SDK's authorization server (express) and an MCP server that requires its tokens (Bun.serve). */
async function sdkAuth() {
  const provider = new DemoInMemoryAuthProvider();
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((r) => listener.once("listening", r));
  stops.push(() => listener.close());
  const issuer = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/`);
  app.use(mcpAuthRouter({ provider, issuerUrl: issuer, scopesSupported: ["mcp:tools"] }));

  const seen: { auth: string | null; path: string }[] = [];
  let mcpUrl!: URL;
  const make = async () => {
    const server = new McpServer({ name: "secured", version: "1" });
    server.registerTool("whoami", { annotations: { readOnlyHint: true } }, async (extra) => ({
      content: [{ type: "text", text: `client ${extra.authInfo?.clientId}` }],
    }));
    const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(t);
    return t;
  };
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      seen.push({ auth: req.headers.get("authorization"), path });
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ resource: mcpUrl.href, authorization_servers: [issuer.href] });
      }
      const header = req.headers.get("authorization") ?? "";
      const token = /^Bearer (.+)$/.exec(header)?.[1];
      const info = token ? await provider.verifyAccessToken(token).catch(() => null) : null;
      if (!info) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", mcpUrl).href}", scope="mcp:tools"`,
          },
        });
      }
      return (await make()).handleRequest(req, { authInfo: info });
    },
  });
  stops.push(() => void http.stop(true));
  mcpUrl = new URL(`http://127.0.0.1:${http.port}/mcp`);
  return { issuer, mcpUrl, seen };
}

describe("against the SDK's authorization server", () => {
  test("discovery, registration, PKCE, the resource, and the call with the token", async () => {
    const { mcpUrl, seen } = await sdkAuth();
    const redirects: URL[] = [];
    const store = new MemoryTokenStore();
    const oauth = new OAuthClientProvider(mcpUrl, {
      redirectUrl: "http://localhost:9/callback",
      onRedirect: (u) => void redirects.push(u),
      store,
    });
    const first = new McpClient({ name: "c", version: "0" });
    await expect(first.connect(new StreamableHttpTransport(mcpUrl, { auth: oauth }))).rejects.toThrow("HTTP 401");
    expect(redirects).toHaveLength(1);
    const at = redirects[0]!;
    expect(at.searchParams.get("code_challenge_method")).toBe("S256");
    expect(at.searchParams.get("resource")).toBe(mcpUrl.href);
    expect(at.searchParams.get("scope")).toBe("mcp:tools");
    // The user approves (the demo approves at once): the authorization server redirects to the callback.
    const approved = await fetch(at, { redirect: "manual" });
    const callback = approved.headers.get("location")!;
    expect(callback).toStartWith("http://localhost:9/callback?code=");
    await oauth.finishAuth(callback);
    const t = (await oauth.tokens())!;
    expect(t.resource).toBe(mcpUrl.href);
    const client = new McpClient({ name: "c", version: "0" });
    await client.connect(new StreamableHttpTransport(mcpUrl, { auth: oauth }));
    const result = await client.callTool({ name: "whoami" });
    expect((result.content[0] as { text: string }).text).toBe(`client ${t.clientId}`);
    expect(seen.at(-1)!.auth).toBe(`Bearer ${t.accessToken}`);
    // A code is used once: the same callback again is refused before it reaches the server.
    await expect(oauth.finishAuth(callback)).rejects.toThrow("state is not one this client began");
    await client.close();
  });
});

/** A fake world of HTTPS hosts, routed by origin and path; every request is recorded. */
function world(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const requests: { url: string; method: string; auth: string | null; body: string }[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const req = new Request(String(input), init);
    const body = init?.body ? String(init.body) : "";
    requests.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), body });
    const u = new URL(req.url);
    const route = routes[`${u.origin}${u.pathname}`] ?? routes[u.origin];
    return route ? route(req) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

const MCP = "https://mcp.example/mcp";
const ISSUER = "https://as.example";
const prm = (over: Record<string, unknown> = {}) =>
  Response.json({ resource: MCP, authorization_servers: [ISSUER], ...over });
const asMeta = (over: Record<string, unknown> = {}) =>
  Response.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    code_challenge_methods_supported: ["S256"],
    ...over,
  });
const challenge = {
  status: 401,
  wwwAuthenticate: `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"`,
  url: new URL(MCP),
};

function provider(
  routes: Record<string, (req: Request) => Response | Promise<Response>>,
  store = new MemoryTokenStore(),
) {
  const w = world({
    "https://mcp.example/.well-known/oauth-protected-resource/mcp": () => prm(),
    "https://as.example/.well-known/oauth-authorization-server": () => asMeta(),
    "https://as.example/register": () => Response.json({ client_id: "c1" }, { status: 201 }),
    ...routes,
  });
  const redirects: URL[] = [];
  const oauth = new OAuthClientProvider(MCP, {
    redirectUrl: "https://app.example/cb",
    onRedirect: (u) => void redirects.push(u),
    store,
    fetch: w.fetchFn,
  });
  return { oauth, redirects, ...w, store };
}

describe("adversarial", () => {
  test("an authorization server whose metadata names another issuer is refused", async () => {
    const p = provider({
      "https://as.example/.well-known/oauth-authorization-server": () => asMeta({ issuer: "https://evil.example" }),
    });
    await expect(p.oauth.unauthorized(challenge)).rejects.toThrow("names another issuer");
    expect(p.redirects).toEqual([]);
  });

  test("oversized metadata is refused at the cap, declared or streamed", async () => {
    const big = JSON.stringify({ resource: MCP, authorization_servers: [ISSUER], pad: "x".repeat(200_000) });
    const declared = provider({
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": () => new Response(big),
    });
    await expect(declared.oauth.unauthorized(challenge)).rejects.toThrow("larger than 65536 bytes");
    let sent = 0;
    const streamed = provider({
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": () =>
        new Response(
          new ReadableStream({
            pull(c) {
              sent += 16_384;
              c.enqueue(new Uint8Array(16_384).fill(0x20));
              if (sent > 64 * 1024 * 1024) c.close();
            },
          }),
        ),
    });
    await expect(streamed.oauth.unauthorized(challenge)).rejects.toThrow("larger than 65536 bytes");
    expect(sent).toBeLessThan(1024 * 1024);
  });

  test("a redirect to another origin is not followed, and nothing reaches that origin", async () => {
    const p = provider({
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": () =>
        new Response(null, { status: 307, headers: { location: "https://evil.example/prm" } }),
      "https://evil.example": () => prm(),
    });
    await expect(p.oauth.unauthorized(challenge)).rejects.toThrow("redirect (HTTP 307) was not followed");
    expect(p.requests.some((r) => r.url.startsWith("https://evil.example"))).toBe(false);
    // A token POST is never redirected, even within its origin.
    const q = provider({});
    await q.oauth.unauthorized(challenge);
    const state = q.redirects[0]!.searchParams.get("state")!;
    q.requests.length = 0;
    const r = provider({
      "https://as.example/token": () => new Response(null, { status: 307, headers: { location: `${ISSUER}/token2` } }),
    });
    await r.oauth.unauthorized(challenge);
    await expect(
      r.oauth.finishAuth(`https://app.example/cb?code=k&state=${r.redirects[0]!.searchParams.get("state")}`),
    ).rejects.toThrow("not followed");
    expect(state.length).toBeGreaterThanOrEqual(43);
  });

  test("plain HTTP is refused outside loopback: the server, the issuer and every endpoint", async () => {
    expect(
      () => new OAuthClientProvider("http://mcp.example/mcp", { redirectUrl: "https://a/cb", onRedirect: () => {} }),
    ).toThrow("HTTPS");
    expect(() => new OAuthClientProvider(MCP, { redirectUrl: "http://app.example/cb", onRedirect: () => {} })).toThrow(
      "HTTPS",
    );
    const p = provider({
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": () =>
        prm({ authorization_servers: ["http://as.example"] }),
    });
    await expect(p.oauth.unauthorized(challenge)).rejects.toThrow("must use HTTPS");
    const q = provider({
      "https://as.example/.well-known/oauth-authorization-server": () =>
        asMeta({ token_endpoint: "http://as.example/token" }),
    });
    await expect(q.oauth.unauthorized(challenge)).rejects.toThrow("must use HTTPS");
  });

  test("metadata for another resource, or an authorization server without S256, is refused", async () => {
    const p = provider({
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": () =>
        prm({ resource: "https://other.example/mcp" }),
    });
    await expect(p.oauth.unauthorized(challenge)).rejects.toThrow("for another resource");
    const q = provider({
      "https://as.example/.well-known/oauth-authorization-server": () =>
        asMeta({ code_challenge_methods_supported: ["plain"] }),
    });
    await expect(q.oauth.unauthorized(challenge)).rejects.toThrow("PKCE with S256");
  });

  test("the state is verified and used once; an error or an iss from elsewhere in the callback is refused", async () => {
    const p = provider({
      "https://as.example/token": () => Response.json({ access_token: "AT", token_type: "Bearer" }),
    });
    await p.oauth.unauthorized(challenge);
    const u = p.redirects[0]!;
    const state = u.searchParams.get("state")!;
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(p.oauth.finishAuth(`https://app.example/cb?code=k&state=${state}x`)).rejects.toThrow("state");
    await expect(
      p.oauth.finishAuth(`https://app.example/cb?code=k&state=${state}&iss=https://evil.example`),
    ).rejects.toThrow("another issuer");
    await p.oauth.unauthorized(challenge);
    const s2 = p.redirects[1]!.searchParams.get("state")!;
    await expect(p.oauth.finishAuth(`https://app.example/cb?error=<script>AT</script>&state=${s2}`)).rejects.toThrow(
      "refused (error)",
    );
    await p.oauth.unauthorized(challenge);
    const s3 = p.redirects[2]!.searchParams.get("state")!;
    await p.oauth.finishAuth(`https://app.example/cb?code=k&state=${s3}`);
    const exchange = p.requests.find((r) => r.url === `${ISSUER}/token`)!;
    const form = new URLSearchParams(exchange.body);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get("resource")).toBe(MCP);
    expect(form.get("client_id")).toBe("c1");
    await expect(p.oauth.finishAuth(`https://app.example/cb?code=k&state=${s3}`)).rejects.toThrow("state");
  });

  test("a token never leaks: not to a transport for another origin, not into an error", async () => {
    const p = provider({
      "https://as.example/token": () =>
        Response.json({ error: "invalid_grant AT-SECRET", error_description: "AT-SECRET" }, { status: 400 }),
    });
    await p.store.set(`tokens ${MCP}`, {
      accessToken: "AT-SECRET",
      refreshToken: "RT-SECRET",
      expiresAt: Date.now() - 1,
      issuer: ISSUER,
      tokenEndpoint: `${ISSUER}/token`,
      resource: MCP,
      clientId: "c1",
    } satisfies StoredTokens);
    // Another origin, another path: no token.
    expect(await p.oauth.authorization(new URL("https://evil.example/mcp"))).toBeUndefined();
    expect(await p.oauth.authorization(new URL("https://mcp.example/other"))).toBeUndefined();
    // The refresh fails: the error says so in fixed words and the server's text is not repeated.
    const errors: string[] = [];
    const refused = await p.oauth.unauthorized(challenge).catch((e: Error) => (errors.push(e.message), false));
    expect(refused).toBe(false);
    for (const r of p.requests.filter((x) => x.url.startsWith("https://evil.example"))) expect(r).toBeUndefined();
    for (const e of errors) expect(e).not.toContain("SECRET");
    const state = p.redirects[0]!.searchParams.get("state")!;
    const failed = await p.oauth
      .finishAuth(`https://app.example/cb?code=CODE-SECRET&state=${state}`)
      .catch((e: Error) => e);
    expect((failed as Error).message).toBe("OAuth: the token request failed (HTTP 400, error)");
    // The refresh token went to its own token endpoint only.
    const withRefresh = p.requests.filter((r) => r.body.includes("RT-SECRET"));
    expect(withRefresh.map((r) => r.url)).toEqual([`${ISSUER}/token`]);
    // Over a real transport to another origin: no Authorization header at all.
    const sent: (string | null)[] = [];
    const other = new StreamableHttpTransport(new URL("https://evil.example/mcp"), {
      auth: p.oauth,
      fetch: (async (_u: URL | string, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("authorization"));
        return new Response(null, { status: 500 });
      }) as typeof fetch,
    });
    await other.start();
    await other.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }).catch(() => {});
    expect(sent).toEqual([null]);
  });

  test("an expired token is refreshed once, however many requests ask at the same time", async () => {
    let refreshes = 0;
    const p = provider({
      "https://as.example/token": async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        return Response.json({ access_token: `AT${refreshes}`, token_type: "bearer", expires_in: 3600 });
      },
    });
    await p.store.set(`tokens ${MCP}`, {
      accessToken: "AT0",
      refreshToken: "RT",
      expiresAt: Date.now() - 1,
      issuer: ISSUER,
      tokenEndpoint: `${ISSUER}/token`,
      resource: MCP,
      clientId: "c1",
    } satisfies StoredTokens);
    const got = await Promise.all(Array.from({ length: 20 }, () => p.oauth.authorization(new URL(MCP))));
    expect(refreshes).toBe(1);
    expect(new Set(got)).toEqual(new Set(["Bearer AT1"]));
    // The refresh token was kept (the server did not rotate it) and the resource sent.
    expect((await p.oauth.tokens())!.refreshToken).toBe("RT");
    expect(new URLSearchParams(p.requests.find((r) => r.url.endsWith("/token"))!.body).get("resource")).toBe(MCP);
  });

  test("a timeout is an OAuthError in fixed words", async () => {
    const w = world({ "https://mcp.example/.well-known/oauth-protected-resource/mcp": () => new Promise(() => {}) });
    const oauth = new OAuthClientProvider(MCP, {
      redirectUrl: "https://app.example/cb",
      onRedirect: () => {},
      fetch: ((u: URL, init?: RequestInit) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error(`aborted ${u}`))),
        )) as typeof fetch,
      timeoutMs: 50,
    });
    void w;
    const e = await oauth.unauthorized(challenge).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OAuthError);
    expect((e as Error).message).toBe("OAuth: a request timed out");
  });
});

describe("the core's imports", () => {
  test("index.ts reaches neither oauth.ts nor the other opt-in entry points, whatever it imports in turn", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(new URL(`./${file}.ts`, import.meta.url), "utf8");
      for (const m of text.matchAll(/^(?:import|export)[^;]*?from "\.\/([a-z-]+)";/gms)) {
        if (!/^import type|^export type/.test(m[0])) walk(m[1]!);
      }
    };
    walk("index");
    expect(seen.has("http")).toBe(true);
    for (const optIn of ["oauth", "stdio", "extras"]) expect(seen.has(optIn)).toBe(false);
  });
});

describe("parseChallenge", () => {
  test("reads the Bearer scheme's parameters among others, quoted or not", () => {
    expect(
      parseChallenge(
        `Basic realm="x", Bearer error="insufficient_scope", scope="a b", resource_metadata="https://m/x?a=\\"q\\""`,
      ),
    ).toEqual({ error: "insufficient_scope", scope: "a b", resourceMetadata: 'https://m/x?a="q"' });
    expect(parseChallenge("Bearer resource_metadata=https://m/x")).toEqual({ resourceMetadata: "https://m/x" });
    expect(parseChallenge("Basic realm=x")).toEqual({});
    expect(parseChallenge(null)).toEqual({});
    expect(parseChallenge(`Bearer scope="${"a".repeat(10_000)}"`)).toEqual({});
  });
});

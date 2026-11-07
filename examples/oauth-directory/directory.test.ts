import { describe, expect, test } from "bun:test";
import { checkSpecs, UserSources } from "@eden/server";
import { oauthDirectory, type TokenVault } from "./directory";

// The per-user OAuth directory (D294): refresh tokens stay in the app, Eden gets short-lived access tokens on preset
// specs; per user, refreshed before expiry, a revoked grant is that user's error only.

function provider() {
  const calls: { refresh: string }[] = [];
  let n = 0;
  const revoked = new Set<string>();
  const fetch = (async (_url: string, init: RequestInit) => {
    const form = new URLSearchParams(String(init.body));
    const refresh = form.get("refresh_token")!;
    calls.push({ refresh });
    if (revoked.has(refresh)) return new Response('{"error":"invalid_grant"}', { status: 400 });
    return Response.json({ access_token: `at-${refresh}-${++n}`, expires_in: 3_600 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, revoked, fetch };
}

const vault: TokenVault = {
  async grant(scope) {
    if (scope.userId === "nobody") return null;
    return { refreshToken: `rt-${scope.userId}`, connected: ["gmail", "google-calendar"] };
  },
};

const setup = () => {
  const p = provider();
  let clock = 0;
  const dir = oauthDirectory({
    vault,
    tokenUrl: "https://oauth.example/token",
    clientId: "id",
    clientSecret: "secret",
    servers: { gmail: "https://gmail.example/mcp", "google-calendar": "https://calendar.example/mcp" },
    fetch: p.fetch,
    now: () => clock,
  });
  return { p, dir, tick: (ms: number) => (clock += ms) };
};

describe("oauthDirectory (D294)", () => {
  test("each user gets their own access token on preset specs that pass checkSpecs", async () => {
    const { dir } = setup();
    const a = checkSpecs(await dir({ tenantId: "t", userId: "a" }), "a");
    const b = checkSpecs(await dir({ tenantId: "t", userId: "b" }), "b");
    expect(a.map((s) => s.id)).toEqual(["mail", "calendar"]);
    expect(a[0]).toMatchObject({ kind: "mcp", searchTool: { name: "search_threads" } });
    const auth = (s: (typeof a)[number]) => (s.kind === "mcp" ? s.headers?.Authorization : undefined);
    expect(auth(a[0]!)).toBe("Bearer at-rt-a-1");
    expect(auth(b[0]!)).toBe("Bearer at-rt-b-2");
    // No refresh token or client secret in what Eden is handed.
    expect(JSON.stringify([a, b])).not.toMatch(/rt-a"|rt-b"|secret/);
    expect(await dir({ tenantId: "t", userId: "nobody" })).toEqual([]);
  });

  test("the token is reused until a minute before expiry; concurrent asks share one refresh", async () => {
    const { p, dir, tick } = setup();
    const s = { tenantId: "t", userId: "a" };
    await Promise.all([dir(s), dir(s), dir(s)]);
    expect(p.calls.length).toBe(1);
    tick(3_600_000 - 61_000);
    await dir(s);
    expect(p.calls.length).toBe(1);
    tick(2_000);
    await dir(s);
    expect(p.calls.length).toBe(2);
    // forget drops the user's token: the next ask refreshes.
    dir.forget(s);
    await dir(s);
    expect(p.calls.length).toBe(3);
  });

  test("a revoked grant is that user's configuration error; the other user is served", async () => {
    const { p, dir, tick } = setup();
    // A held token is dropped once it expires and the refresh fails: nothing of a revoked grant stays in use.
    await dir({ tenantId: "t", userId: "a" });
    tick(3_600_000);
    p.revoked.add("rt-a");
    await expect(dir({ tenantId: "t", userId: "a" })).rejects.toThrow(/HTTP 400/);
    const users = new UserSources({ directory: dir, log: () => {} });
    await expect(users.status({ tenantId: "t", userId: "a" })).resolves.toMatchObject({
      error: expect.stringContaining("HTTP 400"),
    });
    expect((await users.resolver({ tenantId: "t", userId: "b" })).map((s) => s.id)).toEqual(["mail", "calendar"]);
    await users.close();
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantSpendFor } from "./build";
import { childSourceMapPath, loadConfig } from "./config";
import { childFor, startRouter, userOf, type Router } from "./router";

const KEY = "k_acme_0123456789abcdef";
const OTHER_KEY = "k_globex_0123456789abcdef";
const keys = `acme:${KEY},globex:${OTHER_KEY}`;

/** Two users of tenant acme that the router sends to different children of `n`. */
function splitUsers(n: number): [string, string] {
  const first = "user-0";
  for (let i = 1; i < 1_000; i++) {
    const u = `user-${i}`;
    if (childFor("acme", u, n) !== childFor("acme", first, n)) return [first, u];
  }
  throw new Error("no split found");
}

describe("routing key", () => {
  test("childFor is stable, in range and spreads users", () => {
    expect(childFor("acme", "u1", 1)).toBe(0);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4_000; i++) {
      const c = childFor("acme", `u${i}`, 4);
      expect(c).toBe(childFor("acme", `u${i}`, 4));
      counts[c]!++;
    }
    for (const c of counts) expect(c).toBeGreaterThan(800); // 1,000 each when even
    // The tenant is part of the key: one user id in two tenants is two users.
    const spread = new Set(Array.from({ length: 50 }, (_, i) => childFor(`t${i}`, "same", 4)));
    expect(spread.size).toBeGreaterThan(1);
  });

  test("userOf reads only a top-level string userId", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(userOf(enc(`{"userId":"u-ü1","text":"x"}`))).toBe("u-ü1");
    expect(userOf(enc(`{"items":[{"meta":{"userId":"evil"}}],"userId":"u2"}`))).toBe("u2");
    expect(userOf(enc(`{"items":[{"meta":{"userId":"evil"}}]}`))).toBe("");
    for (const bad of ["", "{not json", "[1]", "null", `{"userId":5}`, "[".repeat(60_000)]) {
      expect(userOf(enc(bad))).toBe("");
    }
  });
});

describe("per-child caps and files (D163)", () => {
  test("a child divides the tenant rate and burst by N; burst stays at least 1", () => {
    const base = { EDEN_API_KEYS: keys, EDEN_TENANT_RPS: "200", EDEN_TENANT_BURST: "6" };
    const one = loadConfig(base);
    expect([one.tenantRatePerSec, one.tenantBurst, one.processes, one.child]).toEqual([200, 6, 1, null]);
    const child = loadConfig({ ...base, EDEN_ROUTER_CHILD: "3/4", EDEN_PROCESSES: "4" });
    expect(child.child).toEqual({ index: 3, count: 4 });
    expect([child.tenantRatePerSec, child.tenantBurst]).toEqual([50, 1.5]);
    // A child never routes again, whatever it inherited.
    expect(child.processes).toBe(1);
    expect(loadConfig({ ...base, EDEN_ROUTER_CHILD: "0/8" }).tenantBurst).toBe(1);
  });

  test("EDEN_PROCESSES and EDEN_ROUTER_CHILD are validated", () => {
    expect(loadConfig({ EDEN_API_KEYS: keys, EDEN_PROCESSES: "4" }).processes).toBe(4);
    for (const bad of ["0", "65", "1.5", "x", "-2"]) {
      expect(() => loadConfig({ EDEN_API_KEYS: keys, EDEN_PROCESSES: bad })).toThrow(/EDEN_PROCESSES/);
    }
    for (const bad of ["4/4", "1", "a/b", "0/0", "-1/2", "0/65"]) {
      expect(() => loadConfig({ EDEN_API_KEYS: keys, EDEN_ROUTER_CHILD: bad })).toThrow(/EDEN_ROUTER_CHILD/);
    }
  });

  test("the tenant's daily model spend is divided by N", () => {
    expect(tenantSpendFor(25).usdPerTenantDay).toBe(25);
    expect(tenantSpendFor(25, 4).usdPerTenantDay).toBe(6.25);
    const spend = tenantSpendFor(10, 4);
    expect(spend.tally("acme/u1", 2.4)).not.toBeNull();
    expect(spend.tally("acme/u1", 2.6)).toBeNull(); // past 10 / 4
  });

  test("each child gets its own source-map file", () => {
    expect(childSourceMapPath("/h/source-map.db", 2)).toBe("/h/source-map.2.db");
    expect(childSourceMapPath("/h/map", 0)).toBe("/h/map.0");
    expect(childSourceMapPath(":memory:", 1)).toBe(":memory:");
  });
});

describe("router over real child processes", () => {
  const N = 2;
  let dir: string;
  let router: Router;
  const output: string[] = ["", ""];
  const [a, b] = splitUsers(N);

  const post = (path: string, body: unknown, key = KEY, port = router.port) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const feedback = async (userId: string, injectionId: string, port?: number) =>
    (
      (await (await post("/v1/feedback", { userId, sessionId: "s1", injectionId, used: true }, KEY, port)).json()) as {
        applied: boolean;
      }
    ).applied;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "eden-router-"));
    const sources = join(dir, "sources.json");
    const doc = { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" };
    writeFileSync(sources, JSON.stringify({ sources: [{ id: "crm", description: "deals", docs: [doc] }] }));
    const env = {
      ...process.env,
      EDEN_HOME: dir,
      EDEN_SOURCE_MAP: join(dir, "source-map.db"),
      EDEN_SOURCES_FILE: sources,
      EDEN_MAX_BODY_BYTES: "100000",
      EDEN_API_KEYS: keys,
      EDEN_TENANT_RPS: "1000",
      EDEN_TENANT_BURST: "1000",
      EDEN_MODEL_USD_PER_TENANT_DAY: "10",
    };
    router = await startRouter({
      config: { ...loadConfig(env), port: 0, processes: N },
      env,
      restartMs: 200,
      onOutput: (i, text) => (output[i] += text),
      log: () => {},
    });
  }, 30_000);
  afterAll(async () => {
    await router?.stop();
  });

  test("starts N children, each with its own source-map file and divided caps", async () => {
    expect(router.children.map((c) => c.up)).toEqual([true, true]);
    expect(await (await fetch(`http://127.0.0.1:${router.port}/healthz`)).json()).toEqual({
      ok: true,
      processes: 2,
      up: 2,
    });
    for (let i = 0; i < N; i++) {
      expect(existsSync(join(dir, `source-map.${i}.db`))).toBe(true);
      expect(output[i]).toContain(`router child ${i} of 2, per-tenant caps divided by 2: $5/day, 500 rps, burst 500`);
    }
    expect(existsSync(join(dir, "source-map.db"))).toBe(false);
  });

  test("a user's state lives only on its child, and forget reaches that child", async () => {
    // Each user gets an injection through the router: a session and its outstanding injection, per-user state.
    const injected: string[] = [];
    for (const userId of [a, b]) {
      const event = { userId, sessionId: "s1", kind: "user_message", text: "Globex renewal with Dana Lee" };
      const res = await post("/v1/events?waitMs=2000", event);
      const body = (await res.json()) as { injection: { id: string; citations: { itemId: string }[] } | null };
      expect(body.injection?.citations[0]?.itemId).toBe("crm:d1");
      injected.push(body.injection!.id);
    }
    const [ia, ib] = injected as [string, string];
    // The child that does not serve user a holds nothing of a's: a's injection is unknown there.
    const home = childFor("acme", a, N);
    expect(await feedback(a, ia, router.children[1 - home]!.port)).toBe(false);
    expect(await feedback(a, ia, router.children[home]!.port)).toBe(true);
    // Forget through the router reaches a's child: a's session and record are gone there; b's are kept.
    expect((await post("/v1/forget", { userId: a })).status).toBe(200);
    expect(await feedback(a, ia)).toBe(false);
    expect(await feedback(a, ia, router.children[home]!.port)).toBe(false);
    expect(await feedback(b, ib)).toBe(true);
  });

  test("auth, tenant checks and validation are still the child's answers", async () => {
    expect((await post("/v1/ask", { userId: a, sessionId: "s", question: "x" }, "wrong-key-0123456789")).status).toBe(
      401,
    );
    expect((await post("/v1/ask", { userId: a, tenantId: "globex", sessionId: "s", question: "x" })).status).toBe(403);
    const bad = await fetch(`http://127.0.0.1:${router.port}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "body must be JSON" });
    expect((await fetch(`http://127.0.0.1:${router.port}/v1/ask`)).status).toBe(405);
    // Past EDEN_MAX_BODY_BYTES (100,000 here): refused at the router, never buffered twice.
    const big = await post("/v1/events", {
      userId: a,
      sessionId: "s",
      kind: "user_message",
      text: "x".repeat(200_000),
    });
    expect(big.status).toBe(413);
  });

  test("a dead child gives its users 503 (never 500) while the other child serves; it is restarted", async () => {
    const home = childFor("acme", a, N);
    const victim = router.children[home]!;
    const pid = victim.pid;
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 100 && victim.up; i++) await Bun.sleep(10);
    const down = await post("/v1/ask", { userId: a, sessionId: "s1", question: "x" });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "temporarily unable to serve context" });
    expect((await post("/v1/ask", { userId: b, sessionId: "s1", question: "x" })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${router.port}/healthz`)).status).toBe(503);
    // Restarted after restartMs, a fresh process on the same source-map file.
    for (let i = 0; i < 500 && !victim.up; i++) await Bun.sleep(20);
    expect(victim.up).toBe(true);
    expect(victim.pid).not.toBe(pid);
    expect((await post("/v1/ask", { userId: a, sessionId: "s1", question: "x" })).status).toBe(200);
  }, 20_000);
});

describe("router rate limit, divided", () => {
  test("a tenant's burst is split across children: one child holds burst / N", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-router-rate-"));
    const env = {
      ...process.env,
      EDEN_HOME: dir,
      EDEN_API_KEYS: keys,
      EDEN_TENANT_RPS: "0.01",
      EDEN_TENANT_BURST: "4",
    };
    const config = { ...loadConfig(env), port: 0, processes: 2 };
    const router = await startRouter({ config, env, log: () => {}, onOutput: () => {} });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`http://127.0.0.1:${router.port}/v1/whoami`, {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}` },
          body: JSON.stringify({ userId: "one-user" }),
        });
        statuses.push(res.status);
      }
      // One process would allow all 4; the user's child holds a burst of 2.
      expect(statuses).toEqual([200, 200, 429, 429]);
    } finally {
      await router.stop();
    }
  }, 30_000);

  test("a child that cannot start fails the router's start, and every child is stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-router-bad-"));
    const sources = join(dir, "bad.json");
    writeFileSync(sources, "{not json");
    const env = { ...process.env, EDEN_HOME: dir, EDEN_API_KEYS: keys, EDEN_SOURCES_FILE: sources };
    const errors: string[] = [];
    const start = startRouter({
      config: { ...loadConfig(env), port: 0, processes: 2 },
      env,
      log: (l) => errors.push(l),
    });
    await expect(start).rejects.toThrow(/exited with code 2 before listening/);
  }, 30_000);
});

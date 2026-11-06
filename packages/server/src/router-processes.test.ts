/**
 * The router tests that start routers of their own (D163, D172), split from router.test.ts so `scripts/test.sh`'s
 * `--parallel` runs them beside the shared-router tests: each starts and stops real child processes, which is most of
 * the server package's test time.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { childFor, startRouter, type Router } from "./router";

const KEY = "k_acme_0123456789abcdef";
const OTHER_KEY = "k_globex_0123456789abcdef";
const keys = `acme:${KEY},globex:${OTHER_KEY}`;

/** Every temp dir a test made, removed after the file (each holds SQLite files). */
const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** True once process `pid` is gone (signal 0 throws ESRCH), waiting up to 2 s. */
async function exited(pid: number): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}

/** The source-map files in `dir`, each with how many rows it holds for `scope` across its three tables. */
function rowsByFile(dir: string, scope: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of readdirSync(dir).filter((f) => /^source-map.*\.db$/.test(f))) {
    const db = new Database(join(dir, f));
    let rows = 0;
    for (const t of ["mention", "utility", "planner_arm"]) {
      rows += (db.query(`SELECT COUNT(*) AS c FROM ${t} WHERE scope = ?`).get(scope) as { c: number }).c;
    }
    db.close();
    out[f] = rows;
  }
  return out;
}

describe("router rate limit, divided", () => {
  test("a tenant's burst is split across children: one child holds burst / N", async () => {
    const dir = tempDir("eden-router-rate-");
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
    const dir = tempDir("eden-router-bad-");
    const sources = join(dir, "bad.json");
    writeFileSync(sources, "{not json");
    const env = { ...process.env, EDEN_HOME: dir, EDEN_API_KEYS: keys, EDEN_SOURCES_FILE: sources };
    const pids: number[] = [];
    const start = startRouter({
      config: { ...loadConfig(env), port: 0, processes: 2 },
      env,
      log: () => {},
      onSpawn: (_, pid) => pids.push(pid),
    });
    await expect(start).rejects.toThrow(/exited with code 2 before listening/);
    expect(pids.length).toBe(2);
    for (const pid of pids) expect(await exited(pid)).toBe(true);
  }, 30_000);
});

describe("changing N never strands a user's source-map rows (D163)", () => {
  test("through the router: N 2 -> 3 -> 2, forget removes the user's rows from every file", async () => {
    const dir = tempDir("eden-router-n-");
    const sources = join(dir, "sources.json");
    const doc = { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" };
    writeFileSync(sources, JSON.stringify({ sources: [{ id: "crm", description: "deals", docs: [doc] }] }));
    const env = {
      ...process.env,
      EDEN_HOME: dir,
      EDEN_SOURCE_MAP: join(dir, "source-map.db"),
      EDEN_SOURCES_FILE: sources,
      EDEN_API_KEYS: keys,
      EDEN_TENANT_RPS: "1000",
      EDEN_TENANT_BURST: "1000",
    };
    const start = (processes: number) =>
      startRouter({ config: { ...loadConfig(env), port: 0, processes }, env, log: () => {}, onOutput: () => {} });
    const call = (router: Router, path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${router.port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const event = async (router: Router, userId: string) => {
      const text = "Globex renewal with Dana Lee";
      const res = await call(router, "/v1/events?waitMs=2000", { userId, sessionId: "s1", kind: "user_message", text });
      expect(((await res.json()) as { injection: unknown }).injection).not.toBeNull();
    };
    const total = (userId: string) => Object.values(rowsByFile(dir, `acme/${userId}`)).reduce((a, b) => a + b, 0);
    // u moves from child 1 of 2 to another child of 3; v is served by child 2 of 3, a file N = 2 does not open.
    const pick = (ok: (u: string) => boolean) => Array.from({ length: 1_000 }, (_, i) => `user-${i}`).find(ok)!;
    const u = pick((x) => childFor("acme", x, 2) === 1 && childFor("acme", x, 3) !== 1);
    const v = pick((x) => childFor("acme", x, 3) === 2);
    const stopped: number[] = [];

    let router = await start(2);
    await event(router, u);
    stopped.push(...router.children.map((c) => c.pid));
    await router.stop();
    expect(rowsByFile(dir, `acme/${u}`)["source-map.1.db"]).toBeGreaterThan(0);

    router = await start(3);
    // u's rows sit in a file its new child does not read; forget still reaches them.
    expect((await call(router, "/v1/forget", { userId: u })).status).toBe(200);
    expect(total(u)).toBe(0);
    await event(router, v);
    stopped.push(...router.children.map((c) => c.pid));
    await router.stop();
    expect(rowsByFile(dir, `acme/${v}`)["source-map.2.db"]).toBeGreaterThan(0);

    router = await start(2);
    try {
      // source-map.2.db was merged into v's current child's file and deleted before the children started.
      expect(existsSync(join(dir, "source-map.2.db"))).toBe(false);
      expect(rowsByFile(dir, `acme/${v}`)[`source-map.${childFor("acme", v, 2)}.db`]).toBeGreaterThan(0);
      expect((await call(router, "/v1/forget", { userId: v })).status).toBe(200);
      expect(total(v)).toBe(0);
      // The owner's answer is the caller's: a malformed userId is still the child's 400.
      expect((await call(router, "/v1/forget", { userId: "" })).status).toBe(400);
    } finally {
      stopped.push(...router.children.map((c) => c.pid));
      await router.stop();
    }
    for (const pid of stopped) expect(await exited(pid)).toBe(true);
  }, 60_000);
});

describe("every start has a deadline (D172)", () => {
  /**
   * A stand-in child: the first start listens and reports its port, then exits after 300 ms; every later start
   * (`MARKER` exists) hangs without listening, as a start-up stall would. `HANG_ALWAYS` hangs from the first start.
   */
  const ENTRY = `
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.env.MARKER;
    if (!process.env.HANG_ALWAYS && !existsSync(marker)) {
      writeFileSync(marker, "started");
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
      process.send({ edenListening: server.port });
      setTimeout(() => process.exit(1), 300);
    } else {
      setInterval(() => {}, 1_000);
    }
  `;

  test("a restarted child that hangs before listening is killed and started again", async () => {
    const dir = tempDir("eden-router-hang-");
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, ENTRY);
    const env = { ...process.env, EDEN_HOME: dir, EDEN_API_KEYS: keys, MARKER: join(dir, "started") };
    const config = { ...loadConfig(env), port: 0, processes: 1 };
    const restartMs = 50;
    const startTimeoutMs = 600;
    const pids: number[] = [];
    const lines: string[] = [];
    const router = await startRouter({
      config,
      env,
      entry,
      restartMs,
      startTimeoutMs,
      log: (l) => lines.push(l),
      onOutput: () => {},
      onSpawn: (_, pid) => pids.push(pid),
    });
    try {
      expect(router.children[0]!.up).toBe(true);
      // The first start exits after 300 ms; the restart hangs.
      for (let i = 0; i < 300 && pids.length < 2; i++) await Bun.sleep(10);
      expect(pids.length).toBe(2);
      const hung = pids[1]!;
      // Killed at its deadline and started again after the doubled backoff (restartMs * 2), never left hanging.
      const bound = performance.now() + startTimeoutMs + restartMs * 2 + 1_500;
      while (pids.length < 3 && performance.now() < bound) await Bun.sleep(10);
      expect(pids.length).toBeGreaterThan(2);
      expect(await exited(hung)).toBe(true);
      expect(lines.some((l) => l.includes(`did not report its port in ${startTimeoutMs} ms`))).toBe(true);
      // Still down (every later start hangs): /healthz says so honestly.
      expect((await fetch(`http://127.0.0.1:${router.port}/healthz`)).status).toBe(503);
    } finally {
      await router.stop();
    }
    for (const pid of pids) expect(await exited(pid)).toBe(true);

    // A first start that hangs fails startRouter at its deadline and leaves no process behind.
    const always: number[] = [];
    const start = startRouter({
      config: { ...config, processes: 2 },
      env: { ...env, HANG_ALWAYS: "1" },
      entry,
      startTimeoutMs: 300,
      log: () => {},
      onOutput: () => {},
      onSpawn: (_, pid) => always.push(pid),
    });
    await expect(start).rejects.toThrow(/did not start in 300 ms/);
    expect(always.length).toBe(2);
    for (const pid of always) expect(await exited(pid)).toBe(true);
  }, 30_000);
});

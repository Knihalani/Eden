/**
 * The router tests that start routers of their own (D163, D172), split from router.test.ts so `scripts/test.sh`'s
 * `--parallel` runs them beside the shared-router tests: each starts and stops real child processes, which is most of
 * the server package's test time. They run concurrently too (`test.concurrent`): each makes its own temp dir, router
 * and children and reads no shared state, and they spend most of their time waiting on child start-up and exits.
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

describe("audit A20: dev mode behind the router", () => {
  test.concurrent(
    "a keyless request from another site's page is refused by the router (the child never sees Origin)",
    async () => {
      const dir = tempDir("eden-router-origin-");
      const env = { ...process.env, EDEN_HOME: dir, EDEN_DEV: "1" };
      const config = { ...loadConfig(env), port: 0, processes: 2 };
      const router = await startRouter({ config, env, log: () => {}, onOutput: () => {} });
      try {
        const whoami = (headers: Record<string, string>) =>
          fetch(`http://127.0.0.1:${router.port}/v1/whoami`, {
            method: "POST",
            headers,
            body: JSON.stringify({ userId: "me" }),
          }).then((r) => r.status);
        expect(await whoami({ origin: "http://evil.example:8790" })).toBe(403);
        // An Authorization that parses to no key is no key (the review: "Bearer" and a no-break space).
        expect(await whoami({ origin: "http://evil.example:8790", authorization: "Bearer \u00a0" })).toBe(403);
        expect(await whoami({ origin: "http://localhost:3000" })).toBe(200);
        expect(await whoami({})).toBe(200);
      } finally {
        await router.stop();
      }
    },
    30_000,
  );
});

describe("router rate limit, divided", () => {
  test.concurrent(
    "a tenant's burst is split across children: one child holds burst / N",
    async () => {
      const dir = tempDir("eden-router-rate-");
      const env = {
        ...process.env,
        EDEN_HOME: dir,
        EDEN_API_KEYS: keys,
        EDEN_PERSIST: "off",
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
    },
    30_000,
  );

  test.concurrent(
    "past the tenant's whole rate the router answers 429 before reading the body, as one process does",
    async () => {
      const dir = tempDir("eden-router-over-");
      const env = {
        ...process.env,
        EDEN_HOME: dir,
        EDEN_API_KEYS: keys,
        EDEN_PERSIST: "off",
        EDEN_TENANT_RPS: "0.01",
        EDEN_TENANT_BURST: "2",
      };
      const config = { ...loadConfig(env), port: 0, processes: 2 };
      const router = await startRouter({ config, env, log: () => {}, onOutput: () => {} });
      try {
        // The tenant's whole burst, over two users (one per child or both on one: either way the tenant's 2).
        for (const userId of ["u-a", "u-b"]) {
          await fetch(`http://127.0.0.1:${router.port}/v1/whoami`, {
            method: "POST",
            headers: { authorization: `Bearer ${KEY}` },
            body: JSON.stringify({ userId }),
          });
        }
        // A third request whose body never arrives: the router used to wait on it (each such request holding up to a
        // body's worth of buffer and a parse on the router's one thread) before any child could refuse it.
        const started = performance.now();
        const head = await new Promise<string>((resolve) => {
          let got = "";
          void Bun.connect({
            hostname: "127.0.0.1",
            port: router.port,
            socket: {
              open(s) {
                s.write(
                  `POST /v1/whoami HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${KEY}\r\nContent-Length: 64\r\n\r\n`,
                );
              },
              data(s, d) {
                got += new TextDecoder().decode(d);
                resolve(got);
                s.end();
              },
              close() {
                resolve(got);
              },
            },
          });
        });
        expect(head.split("\r\n")[0]).toBe("HTTP/1.1 429 Too Many Requests");
        expect(head.toLowerCase()).toContain("retry-after:");
        expect(performance.now() - started).toBeLessThan(2_000);
        // The other tenant is unaffected.
        const other = await fetch(`http://127.0.0.1:${router.port}/v1/whoami`, {
          method: "POST",
          headers: { authorization: `Bearer ${OTHER_KEY}` },
          body: JSON.stringify({ userId: "u-a" }),
        });
        expect(other.status).toBe(200);
      } finally {
        await router.stop();
      }
    },
    30_000,
  );

  test.concurrent(
    "a child that cannot start fails the router's start, and every child is stopped",
    async () => {
      const dir = tempDir("eden-router-bad-");
      const sources = join(dir, "bad.json");
      writeFileSync(sources, "{not json");
      const env = {
        ...process.env,
        EDEN_HOME: dir,
        EDEN_API_KEYS: keys,
        EDEN_PERSIST: "off",
        EDEN_SOURCES_FILE: sources,
      };
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
    },
    30_000,
  );

  test.concurrent(
    "a router port already in use fails the start, and every child it started is stopped",
    async () => {
      const dir = tempDir("eden-router-port-");
      const env = { ...process.env, EDEN_HOME: dir, EDEN_API_KEYS: keys, EDEN_PERSIST: "off" };
      const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("taken") });
      const pids: number[] = [];
      try {
        const start = startRouter({
          config: { ...loadConfig(env), port: taken.port!, processes: 2 },
          env,
          log: () => {},
          onOutput: () => {},
          onSpawn: (_, pid) => pids.push(pid),
        });
        await expect(start).rejects.toThrow();
      } finally {
        void taken.stop(true);
      }
      expect(pids.length).toBe(2);
      for (const pid of pids) expect(await exited(pid)).toBe(true);
    },
    30_000,
  );
});

describe("changing N never strands a user's source-map rows (D163)", () => {
  test.concurrent(
    "through the router: N 2 -> 3 -> 2, forget removes the user's rows from every file",
    async () => {
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
        EDEN_PERSIST: "off",
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
        const res = await call(router, "/v1/events?waitMs=2000", {
          userId,
          sessionId: "s1",
          kind: "user_message",
          text,
        });
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
    },
    60_000,
  );
});

describe("changing N keeps every persisted user (D992)", () => {
  test.concurrent(
    "N 2 -> 3 -> 2 with persistence on: each user's file is read by its new child; a third of users change child",
    async () => {
      const dir = tempDir("eden-router-resize-");
      const frozen = join(dir, "frozen");
      const sources = join(dir, "sources.json");
      const doc = { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" };
      writeFileSync(sources, JSON.stringify({ sources: [{ id: "crm", description: "deals", docs: [doc] }] }));
      const env = {
        ...process.env,
        EDEN_HOME: dir,
        EDEN_SOURCES_FILE: sources,
        EDEN_API_KEYS: keys,
        EDEN_PERSIST_KEY: "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0",
        EDEN_PERSIST_FROZEN_DIR: frozen,
        EDEN_SHUTDOWN_GRACE_MS: "5000",
        EDEN_TENANT_RPS: "1000",
        EDEN_TENANT_BURST: "1000",
      };
      const start = (processes: number) =>
        startRouter({ config: { ...loadConfig(env), port: 0, processes }, env, log: () => {}, onOutput: () => {} });
      const event = async (router: Router, userId: string) => {
        const res = await fetch(`http://127.0.0.1:${router.port}/v1/events?waitMs=2000`, {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ userId, sessionId: "s1", kind: "user_message", text: "Globex renewal with Dana Lee" }),
        });
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      };
      const held = async (router: Router) => {
        const text = await (await fetch(`http://127.0.0.1:${router.port}/metrics`)).text();
        return Number(/^eden_users_held (\d+)$/m.exec(text)?.[1]);
      };
      const blobs = () => readdirSync(frozen).filter((f) => f.endsWith(".blob")).length;
      const users = Array.from({ length: 12 }, (_, i) => `user-${i}`);
      const moved = users.filter((u) => childFor("acme", u, 2) !== childFor("acme", u, 3));
      expect(moved.length).toBeGreaterThan(0);
      expect(moved.length).toBeLessThan(users.length);
      // Jump hashing: every user that changes child goes to the new one.
      for (const u of moved) expect(childFor("acme", u, 3)).toBe(2);

      let router = await start(2);
      for (const u of users) await event(router, u);
      expect(await held(router)).toBe(users.length);
      await router.stop();
      // Every live user written at SIGTERM, into the one shared directory (no per-process subdirectory).
      expect(blobs()).toBe(users.length);
      expect(readdirSync(frozen).some((f) => /-of-/.test(f))).toBe(false);

      for (const n of [3, 2]) {
        router = await start(n);
        try {
          // Nothing was pruned: each child indexed its own buckets' files.
          expect(blobs()).toBe(users.length);
          for (const u of users) await event(router, u);
          // Each user was read back (its file deleted at the thaw) by the child that now serves it: none re-synced.
          expect(blobs()).toBe(0);
          expect(await held(router)).toBe(users.length);
        } finally {
          await router.stop();
        }
        expect(blobs()).toBe(users.length);
      }
    },
    90_000,
  );
});

describe("every start has a deadline (D172)", () => {
  /**
   * A stand-in child: the first start listens and reports its port, then exits after 200 ms; every later start
   * (`MARKER` exists) hangs without listening, as a start-up stall would. `HANG_ALWAYS` hangs from the first start.
   */
  const ENTRY = `
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.env.MARKER;
    if (!process.env.HANG_ALWAYS && !existsSync(marker)) {
      writeFileSync(marker, "started");
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
      process.send({ edenListening: server.port });
      setTimeout(() => process.exit(1), 200);
    } else {
      setInterval(() => {}, 1_000);
    }
  `;

  test.concurrent(
    "a restarted child that hangs before listening is killed and started again",
    async () => {
      const dir = tempDir("eden-router-hang-");
      const entry = join(dir, "entry.ts");
      writeFileSync(entry, ENTRY);
      const env = {
        ...process.env,
        EDEN_HOME: dir,
        EDEN_API_KEYS: keys,
        EDEN_PERSIST: "off",
        MARKER: join(dir, "started"),
      };
      const config = { ...loadConfig(env), port: 0, processes: 1 };
      const restartMs = 50;
      const startTimeoutMs = 500;
      // Alongside, in a directory of its own: a first start that hangs fails startRouter at its deadline and leaves
      // no process behind (no outer race any more; each spawn's own deadline settles the start).
      const hangDir = tempDir("eden-router-hang-first-");
      const always: number[] = [];
      const first = startRouter({
        config: { ...loadConfig({ ...env, EDEN_HOME: hangDir }), port: 0, processes: 2 },
        env: { ...env, EDEN_HOME: hangDir, HANG_ALWAYS: "1" },
        entry,
        startTimeoutMs: 300,
        log: () => {},
        onOutput: () => {},
        onSpawn: (_, pid) => always.push(pid),
      });
      const firstFailed = expect(first).rejects.toThrow(/did not start in 300 ms/);
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
        // The first start exits after 200 ms; the restart hangs.
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

      await firstFailed;
      expect(always.length).toBe(2);
      for (const pid of always) expect(await exited(pid)).toBe(true);
    },
    30_000,
  );
});

describe("a machine router in a cluster (R1)", () => {
  test.concurrent(
    "a restarted child is told the last membership before it serves, and /readyz stays ready while one child is down",
    async () => {
      const dir = tempDir("eden-router-cluster-");
      const clusterKey = "cluster-key-0123456789abcdef";
      const env = {
        ...process.env,
        EDEN_HOME: dir,
        EDEN_API_KEYS: keys,
        EDEN_PERSIST: "off",
        EDEN_CLUSTER_KEY: clusterKey,
      };
      const config = { ...loadConfig(env), port: 0, processes: 2 };
      const router = await startRouter({ config, env, restartMs: 100, log: () => {}, onOutput: () => {} });
      try {
        const base = `http://127.0.0.1:${router.port}`;
        // This machine ("me") owns no bucket: every request for a user is fenced (503) by the child that holds it.
        const told = await fetch(`${base}/internal/cluster`, {
          method: "POST",
          headers: { authorization: `Bearer ${clusterKey}`, "content-type": "application/json" },
          body: JSON.stringify({ self: "me", nodes: ["other"], epoch: 1, mode: "drop" }),
        });
        expect(told.status).toBe(200);
        const ask = () =>
          fetch(`${base}/v1/ask`, {
            method: "POST",
            headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
            body: JSON.stringify({ userId: "u1", sessionId: "s1", question: "x" }),
          });
        const fenced = await ask();
        expect(fenced.status).toBe(503);
        expect(((await fenced.json()) as { error: string }).error).toContain("not the owner");

        const victim = router.children[childFor("acme", "u1", 2)]!;
        const pid = victim.pid;
        process.kill(pid, "SIGKILL");
        for (let i = 0; i < 100 && victim.up; i++) await Bun.sleep(10);
        expect(victim.up).toBe(false);
        // One child down: ready for a load balancer, not for the cluster router (`?all=1`).
        expect((await fetch(`${base}/readyz`)).status).toBe(200);
        expect((await fetch(`${base}/readyz?all=1`)).status).toBe(503);
        for (let i = 0; i < 500 && !victim.up; i++) await Bun.sleep(20);
        expect(victim.up).toBe(true);
        expect(victim.pid).not.toBe(pid);
        // The new process got the membership: still fenced, not serving a user another machine owns.
        const again = await ask();
        expect(again.status).toBe(503);
        expect(((await again.json()) as { error: string }).error).toContain("not the owner");
        expect((await fetch(`${base}/readyz?all=1`)).status).toBe(200);
      } finally {
        await router.stop();
      }
    },
    30_000,
  );
});

describe("a child that ignores SIGTERM (R1)", () => {
  test.concurrent("is killed 1.25x the shutdown grace after it, not at the grace its drain fills", async () => {
    const dir = tempDir("eden-router-kill-");
    // Listens, reports its port as main.ts does, and ignores SIGTERM: only the router's SIGKILL ends it.
    const entry = join(dir, "stubborn.ts");
    writeFileSync(
      entry,
      'const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });\n' +
        'process.on("SIGTERM", () => {});\nprocess.send?.({ edenListening: s.port });\n',
    );
    const env = { ...process.env, EDEN_HOME: dir, EDEN_DEV: "1" };
    const config = { ...loadConfig(env), port: 0, processes: 1, shutdownGraceMs: 400 };
    const router = await startRouter({ config, env, entry, log: () => {}, onOutput: () => {} });
    const pid = router.children[0]!.pid;
    const t0 = performance.now();
    await router.stop();
    // A lower bound only: a loaded machine makes it later, never earlier. At the grace itself it took ~400 ms.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(480);
    expect(await exited(pid)).toBe(true);
  });
});

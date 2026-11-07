import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Path (c) of the onboarding smoke tests (D365): the server as the Dockerfile runs it (NODE_ENV=production, keyed,
// two processes, a volume for EDEN_HOME, a per-user sources file), started as a process the way an operator starts
// it. No Docker daemon is needed: the image's CMD is this command. No network, no keys.

const main = resolve(import.meta.dir, "../../packages/server/src/main.ts");
const KEY = "k_onboarding_0123456789abcdef";

/** Collects a stream's text in the background (a pipe nobody reads could fill and stall the server). */
const collect = (stream: ReadableStream<Uint8Array>) => {
  const got = { text: "" };
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) got.text += decoder.decode(chunk, { stream: true });
  })();
  return got;
};

/** The environment a test process gets: the key variables cleared, so it runs the no-model path for $0. */
const cleanEnv = (extra: Record<string, string>) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("EDEN_") && !k.startsWith("OPENROUTER_") && k !== "PORT" && k !== "HOST") {
      env[k] = v;
    }
  }
  return { ...env, ...extra };
};

const run = async (env: Record<string, string>) => {
  const p = Bun.spawn(["bun", main], { env: cleanEnv(env), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

describe("the production server (Dockerfile's command)", () => {
  test("keyed, two processes, per-user sources: healthz, a packet for its user only, 401 without the key", async () => {
    const home = mkdtempSync(join(tmpdir(), "eden-prod-"));
    const users = join(home, "users.json");
    writeFileSync(
      users,
      JSON.stringify({
        users: {
          "acme/u1": [
            {
              kind: "static",
              id: "calendar",
              description: "The user's calendar",
              docs: [
                { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
              ],
            },
          ],
        },
      }),
    );
    // PORT=0: the router takes a free port and names it in its listening line (no race for a port picked beforehand).
    const proc = Bun.spawn(["bun", main], {
      env: cleanEnv({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "0",
        EDEN_HOME: join(home, "data"),
        EDEN_API_KEYS: `acme:${KEY}`,
        EDEN_PROCESSES: "2",
        EDEN_USER_SOURCES_FILE: users,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = collect(proc.stdout);
    const err = collect(proc.stderr);
    try {
      let port = "";
      for (let i = 0; i < 200 && !port; i++) {
        port = /eden router listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out.text)?.[1] ?? "";
        if (!port) await Bun.sleep(50);
      }
      expect(port, `no listening line; stderr:\n${err.text}`).not.toBe("");
      const base = `http://127.0.0.1:${port}`;
      let health: unknown = null;
      for (let i = 0; i < 100 && health === null; i++) {
        health = await fetch(`${base}/healthz`).then(
          (r) => (r.ok ? r.json() : null),
          () => null,
        );
        if (health === null) await Bun.sleep(100);
      }
      expect(health).toEqual({ ok: true, processes: 2, up: 2 });

      const observe = (userId: string, key?: string) =>
        fetch(`${base}/v1/events?waitMs=3000`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({
            userId,
            sessionId: "s",
            kind: "user_message",
            text: "When is lunch with Priya Raman?",
          }),
        });
      const mine = await observe("u1", KEY);
      expect(mine.status).toBe(200);
      const got = (await mine.json()) as { injection: { text: string } | null };
      expect(got.injection?.text).toContain("Dishoom");
      // Another user of the same tenant has no sources: nothing of u1's reaches them (D9).
      const other = (await (await observe("u2", KEY)).json()) as { injection: { text: string } | null };
      expect(other.injection?.text ?? "").not.toContain("Dishoom");
      expect((await observe("u1")).status).toBe(401);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("a configuration mistake is one line naming the setting, exit 2, no stack", async () => {
    const home = mkdtempSync(join(tmpdir(), "eden-prod-"));
    try {
      // Each case stops before listening; port 0 keeps any that did from clashing with another test.
      const base = { NODE_ENV: "production", EDEN_HOME: home, PORT: "0", EDEN_PROCESSES: "1" };
      const cases: [Record<string, string>, string][] = [
        [{}, "eden: set EDEN_API_KEYS (or EDEN_DEV=1 for local development)"],
        [{ EDEN_API_KEYS: "acme:short" }, "eden: EDEN_API_KEYS entries must be tenant:key, keys 16+ chars"],
        [{ EDEN_API_KEYS: `acme:${KEY}`, EDEN_USER_SOURCES_FILE: join(home, "missing.json") }, "missing.json"],
      ];
      for (const [env, says] of cases) {
        const { err, code } = await run({ ...base, ...env });
        expect(code).toBe(2);
        expect(err).toContain(says);
        expect(err).not.toContain("    at ");
        expect(err.trim().split("\n").length).toBe(1);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("with several processes (the Dockerfile's setup) a mistake still ends in one eden: line, exit 2", async () => {
    const home = mkdtempSync(join(tmpdir(), "eden-prod-"));
    const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const base = { NODE_ENV: "production", EDEN_HOME: home, EDEN_PROCESSES: "2", EDEN_API_KEYS: `acme:${KEY}` };
      const port = await run({ ...base, PORT: String(busy.port) });
      expect(port.code).toBe(2);
      expect(port.err.trim()).toBe(
        `eden: 127.0.0.1:${busy.port} is in use: stop the other server, or set PORT to a free port`,
      );
      // A child's own line comes first (and the router's note that it retries); the last line says the start failed.
      const missing = await run({ ...base, PORT: "0", EDEN_USER_SOURCES_FILE: join(home, "missing.json") });
      expect(missing.code).toBe(2);
      expect(missing.err).toContain("missing.json");
      expect(missing.err).not.toContain("    at ");
      expect(missing.err.trim().split("\n").at(-1)).toStartWith("eden: cannot start: ");
    } finally {
      busy.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

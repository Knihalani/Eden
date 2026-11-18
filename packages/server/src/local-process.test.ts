import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const token = "local_" + "a".repeat(37);

async function exercise(compiled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "eden-local-"));
  const buildDir = compiled ? mkdtempSync(join(tmpdir(), "eden-local-build-")) : null;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    let command = [process.execPath, join(root, "packages/server/src/main.ts")];
    if (compiled) {
      const output = join(buildDir!, "build");
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "packages/server/src/main.ts",
          "--outfile",
          output,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const errors = new Response(build.stderr).text();
      expect(await build.exited, await errors).toBe(0);
      const moved = join(dir, "sidecar");
      copyFileSync(output, moved);
      command = [moved];
    }
    writeFileSync(join(dir, ".env"), "EDEN_DEV=1\nEDEN_API_KEYS=dotenv:weak\nEDEN_PROCESSES=4\n");
    writeFileSync(join(dir, "bunfig.toml"), compiled ? 'preload = ["./poison.ts"]\n' : "[run]\nsilent = true\n");
    if (compiled) {
      writeFileSync(join(dir, "poison.ts"), 'console.log("unexpected preload"); throw new Error("autoloaded");');
    }
    const fixture = join(dir, "sources.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        sources: [
          {
            id: "crm",
            description: "Globex renewal",
            docs: [
              { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" },
              { ref: "d2", title: "Plumber", text: "The plumber repairs the kitchen sink for 85 pounds." },
            ],
          },
        ],
      }),
    );
    const home = join(dir, "missing-home");
    const eden = join(dir, "missing-eden");
    child = Bun.spawn(command, {
      cwd: dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Source-mode Bun creates its transpiler cache before main.ts executes; binaries need no override.
        ...(compiled ? {} : { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
        HOME: home,
        EDEN_HOME: eden,
        EDEN_LOCAL: "1",
        EDEN_LOCAL_TOKEN: token,
        EDEN_SOURCES_FILE: fixture,
        EDEN_DEV: "1",
        EDEN_API_KEYS: "evil:weak",
        EDEN_PROCESSES: "4",
        EDEN_PERSIST_KEY: "invalid",
        EDEN_NODES: "invalid",
        EDEN_GATE_WORKERS: "4",
        EDEN_SOURCE_MAP: join(dir, "should-not-exist.db"),
        PORT: "1",
        HOST: "0.0.0.0",
        OPENROUTER_API_KEY: "fake",
      },
    });
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(15000).then(() => {
        throw new Error("ready timeout");
      }),
    ]);
    const ready = new TextDecoder().decode(first.value);
    expect(ready).toMatch(/^EDEN_LOCAL_READY [0-9]+\n$/);
    const port = Number(ready.trim().split(" ")[1]);
    expect(port).toBeGreaterThan(1024);
    if (process.platform === "linux") {
      expect(readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim()).toBe("");
      const socket = port.toString(16).toUpperCase().padStart(4, "0");
      const listeners = readFileSync(`/proc/${child.pid}/net/tcp`, "utf8")
        .split("\n")
        .filter((line) => line.includes(`:${socket} `) && line.trim().split(/\s+/)[3] === "0A");
      expect(listeners.length).toBe(1);
      expect(listeners[0]).toContain(`0100007F:${socket}`);
    }
    const base = `http://127.0.0.1:${port}`;
    const post = (auth: string, tenantId = "local", path = "/v1/whoami") =>
      fetch(base + path, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({ tenantId, userId: "u1", sessionId: "s1", question: "What does Dana Lee want?" }),
      });
    expect((await post("")).status).toBe(401);
    expect((await post("wrong")).status).toBe(401);
    expect((await post(token)).status).toBe(200);
    expect((await post(token, "dev")).status).toBe(403);
    const ask = await post(token, "local", "/v1/ask");
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain("12%");
    const translated = await fetch(base + "/v1/ask", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        userId: "u2",
        sessionId: "s2",
        question: "Preciso de um encanador para ver a pia da cozinha.",
      }),
    });
    expect(translated.status).toBe(200);
    expect(await translated.text()).toContain("85 pounds");
    expect((await fetch(base + "/metrics")).status).toBe(401);
    expect((await fetch(base + "/healthz", { headers: { origin: "null" } })).status).toBe(403);
    expect((await fetch(base + "/healthz", { headers: { host: "evil.test" } })).status).toBe(403);
    const before = performance.now();
    (child.stdin as import("bun").FileSink).end();
    expect(await child.exited).toBe(0);
    expect(performance.now() - before).toBeLessThan(3000);
    expect((await reader.read()).done).toBe(true);
    const logs = await stderr;
    expect(logs).not.toContain("turn-gate.bin could not be read");
    expect(logs).not.toContain("glossary's lexicons");
    expect(logs).not.toContain("router child");
    expect(existsSync(home)).toBe(false);
    expect(existsSync(eden)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(
      (compiled
        ? [".env", "bunfig.toml", "poison.ts", "sidecar", "sources.json"]
        : [".env", "bunfig.toml", "sources.json"]
      ).sort(),
    );
  } finally {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  }
}

test("local source process is private and volatile, with EOF ownership", () => exercise(false), 30000);
test.skipIf(process.env.LOCAL_COMPILE_TEST !== "1")("standalone local binary", () => exercise(true), 120000);

test("local invalid activation and token exit 2 without echoing secrets", async () => {
  for (const [mode, value] of [
    ["1", "bad-secret"],
    ["yes", token],
  ]) {
    const child = Bun.spawn([process.execPath, "packages/server/src/main.ts"], {
      cwd: root,
      env: { ...process.env, EDEN_LOCAL: mode, EDEN_LOCAL_TOKEN: value },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).not.toContain(value);
  }
}, 30000);

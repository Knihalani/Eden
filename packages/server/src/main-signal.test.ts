import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "eden-main-signal-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// One process (EDEN_PROCESSES=1, the image's usual shape) must stop on SIGTERM: as a container's PID 1 a signal with
// no handler is ignored, so `docker stop` waited 10 s and SIGKILLed it (exit 137, measured on the image), and as a
// router child it died by the signal with the source map's outcome batch unwritten.
test("one server process exits 0 on SIGTERM", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: { ...process.env, EDEN_HOME: dir, EDEN_DEV: "1", PORT: "0", EDEN_PROCESSES: "1" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = new TextDecoder();
  let out = "";
  for await (const chunk of proc.stdout) {
    out += text.decode(chunk);
    if (out.includes("listening on")) break;
  }
  expect(out).toContain("eden partner listening on");
  proc.kill("SIGTERM");
  const killer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  await proc.exited;
  clearTimeout(killer);
  expect(proc.signalCode).toBeNull();
  expect(proc.exitCode).toBe(0);
}, 20_000);

// D858: a dev server that inherits OPENROUTER_API_KEY would make paid model calls; it refuses unless allowed.
test("a dev server with OPENROUTER_API_KEY refuses to start unless EDEN_ALLOW_MODEL_ROLES=1", async () => {
  const run = (extra: Record<string, string>) =>
    Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
      env: { ...process.env, EDEN_HOME: dir, EDEN_DEV: "1", PORT: "0", EDEN_PROCESSES: "1", ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
  const refused = run({ OPENROUTER_API_KEY: "sk-or-not-a-real-key-0000" });
  expect(await refused.exited).toBe(2);
  const why = await new Response(refused.stderr).text();
  expect(why).toContain("EDEN_ALLOW_MODEL_ROLES=1");
  expect(why).not.toContain("sk-or-not-a-real-key");
  // Allowed: it starts (no model call is made before a request; it is stopped at once).
  const allowed = run({ OPENROUTER_API_KEY: "sk-or-not-a-real-key-0000", EDEN_ALLOW_MODEL_ROLES: "1" });
  let out = "";
  for await (const chunk of allowed.stdout) {
    out += new TextDecoder().decode(chunk);
    if (out.includes("listening on")) break;
  }
  expect(out).toContain("model roles on");
  allowed.kill("SIGTERM");
  await allowed.exited;
}, 20_000);

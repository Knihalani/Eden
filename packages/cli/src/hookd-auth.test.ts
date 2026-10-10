import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleHookd } from "./hookd";
import {
  HOOKD_KEY_HEADER,
  ensureHookdKey,
  hookdKeyMatches,
  hookdKeyPath,
  readHookdKey,
  rotateHookdKey,
} from "./hookd-key";
import { hookCommand, opencodePluginSource, preHookCommand } from "./setup";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.EDEN_HOME;
  home = mkdtempSync(join(tmpdir(), "eden-hookd-auth-"));
  process.env.EDEN_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.EDEN_HOME;
  else process.env.EDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("hookd key file (#85)", () => {
  test("is created once, 0600, as one header line, and reused", () => {
    expect(readHookdKey()).toBeNull();
    const key = ensureHookdKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(hookdKeyPath()).toBe(join(home, "hookd.key"));
    expect(statSync(hookdKeyPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(hookdKeyPath(), "utf8")).toBe(`x-eden-hookd-key: ${key}\n`);
    expect(ensureHookdKey()).toBe(key);
    expect(readHookdKey()).toBe(key);
  });

  test("a key file other accounts can read is not a key", () => {
    ensureHookdKey();
    chmodSync(hookdKeyPath(), 0o644);
    expect(readHookdKey()).toBeNull();
    expect(() => ensureHookdKey()).toThrow(/0600/);
  });

  test("a malformed key file is not a key", () => {
    writeFileSync(hookdKeyPath(), "x-eden-hookd-key: short\n", { mode: 0o600 });
    expect(readHookdKey()).toBeNull();
    expect(hookdKeyMatches("short")).toBe(false);
  });

  test("only the current key matches", () => {
    const key = ensureHookdKey();
    expect(hookdKeyMatches(key)).toBe(true);
    expect(hookdKeyMatches(null)).toBe(false);
    expect(hookdKeyMatches("")).toBe(false);
    expect(hookdKeyMatches(key.slice(1))).toBe(false);
    expect(hookdKeyMatches(`${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`)).toBe(false);
    rmSync(hookdKeyPath());
    expect(hookdKeyMatches(key)).toBe(false);
  });

  test("rotation replaces the key, and a loosened key file, with a new 0600 key", () => {
    const first = ensureHookdKey();
    const second = rotateHookdKey();
    expect(second).not.toBe(first);
    expect(hookdKeyMatches(first)).toBe(false);
    expect(hookdKeyMatches(second)).toBe(true);
    chmodSync(hookdKeyPath(), 0o644);
    const third = rotateHookdKey();
    expect(statSync(hookdKeyPath()).mode & 0o777).toBe(0o600);
    expect(readHookdKey()).toBe(third);
  });
});

const PRE_TOOL = { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "local" };

function post(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:8794/hook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(PRE_TOOL),
  });
}

/** A live hookd on a free port. `statuses` lists what it answered each POST. */
async function withHookd<T>(fn: (port: number, statuses: number[]) => Promise<T>): Promise<T> {
  const statuses: number[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const res = await handleHookd(req);
      if (req.method === "POST") statuses.push(res.status);
      return res;
    },
  });
  try {
    return await fn(server.port!, statuses);
  } finally {
    server.stop(true);
  }
}

/** A client's environment: its own Eden home, and no `eden` on PATH to fall back to. */
function clientEnv(edenHome: string, port: number): Record<string, string> {
  const stub = join(home, "stub");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "eden"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  return {
    PATH: `${stub}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmpdir(),
    EDEN_HOME: edenHome,
    EDEN_HOOKD_PORT: String(port),
  };
}

async function run(cmd: string[], env: Record<string, string>, input: unknown) {
  const proc = Bun.spawn(cmd, { env, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout: stdout.trim(), code };
}

/**
 * The eden-memory plugin as `/plugin install` copies it, with no Eden checkout to find: the case in which the plugin
 * used to fall back to hookd.
 */
function pluginCopy(): string {
  const copy = join(home, "plugin");
  cpSync(join(import.meta.dir, "../../../plugins/eden-memory"), copy, { recursive: true });
  return join(copy, "scripts", "hook.ts");
}

describe("hookd requires its key (#85)", () => {
  test("an unauthenticated POST is refused, and so is a wrong key", async () => {
    const key = ensureHookdKey();
    const none = await handleHookd(post());
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({});
    expect((await handleHookd(post({ [HOOKD_KEY_HEADER]: "0".repeat(64) }))).status).toBe(401);
    const ok = await handleHookd(post({ [HOOKD_KEY_HEADER]: key }));
    expect(ok.status).toBe(200);
    // A hook with nothing to say prints nothing (EXECUTION §5), so hookd answers with an empty body.
    expect(await ok.text()).toBe("");
  });

  test("with no key file hookd serves no hook, and /health still answers", async () => {
    expect((await handleHookd(post({ [HOOKD_KEY_HEADER]: "0".repeat(64) }))).status).toBe(401);
    expect((await handleHookd(new Request("http://127.0.0.1:8794/health"))).status).toBe(200);
  });

  test("the eden-memory plugin never sends hookd a hook, even with its key (P0.1)", async () => {
    ensureHookdKey();
    await withHookd(async (port, statuses) => {
      const prompt = { hook_event_name: "UserPromptSubmit", session_id: "local", prompt: "what is our CI?" };
      const out = await run(["bun", pluginCopy()], clientEnv(home, port), prompt);
      expect(out).toEqual({ stdout: "", code: 0 });
      expect(statuses).toEqual([]);
    });
  });

  test("installed hook commands send the key from its file, never in argv", async () => {
    const key = ensureHookdKey();
    await withHookd(async (port, statuses) => {
      const pre = preHookCommand(port);
      const warm = hookCommand("/must-not-spawn/cli.ts", port);
      for (const cmd of [pre, warm]) {
        expect(cmd).toContain(`-H @'${hookdKeyPath()}'`);
        expect(cmd).not.toContain(key);
        const out = await run(["sh", "-c", cmd], clientEnv(home, port), PRE_TOOL);
        expect(out).toEqual({ stdout: "", code: 0 });
      }
      expect(statuses).toEqual([200, 200]);
      rmSync(hookdKeyPath());
      // Refused (401): `curl --fail` prints nothing, and the command still exits 0.
      expect(await run(["sh", "-c", pre], clientEnv(home, port), PRE_TOOL)).toEqual({ stdout: "", code: 0 });
      expect(statuses).toEqual([200, 200]);
    });
  });

  test("a refused installed hook falls through to the in-process hook", async () => {
    ensureHookdKey();
    const other = join(home, "other-home");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "hookd.key"), `${HOOKD_KEY_HEADER}: ${"ab".repeat(32)}\n`, { mode: 0o600 });
    const fakeCli = join(home, "fake-cli.ts");
    writeFileSync(fakeCli, "console.log(JSON.stringify({ fallback: true }));\n");
    await withHookd(async (port, statuses) => {
      process.env.EDEN_HOME = other;
      const warm = hookCommand(fakeCli, port);
      process.env.EDEN_HOME = home;
      const out = await run(["sh", "-c", warm], clientEnv(other, port), PRE_TOOL);
      expect(out).toEqual({ stdout: JSON.stringify({ fallback: true }), code: 0 });
      expect(statuses).toEqual([401]);
    });
  });

  test("a hookd start writes a new key; the old one is refused", async () => {
    const old = ensureHookdKey();
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const hookd = Bun.spawn([process.execPath, join(import.meta.dir, "hookd.ts")], {
      env: { ...process.env, EDEN_HOME: home, EDEN_HOOKD_PORT: String(port) },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = await fetch(`http://127.0.0.1:${port}/health`).then(
          (r) => r.ok,
          () => false,
        );
        if (!up) await Bun.sleep(30);
      }
      expect(up).toBe(true);
      const current = readHookdKey();
      expect(current).toMatch(/^[0-9a-f]{64}$/);
      expect(current).not.toBe(old);
      const hook = (key: string) =>
        fetch(`http://127.0.0.1:${port}/hook`, {
          method: "POST",
          headers: { "content-type": "application/json", [HOOKD_KEY_HEADER]: key },
          body: JSON.stringify(PRE_TOOL),
        }).then((r) => r.status);
      expect(await hook(old)).toBe(401);
      expect(await hook(current!)).toBe(200);
    } finally {
      hookd.kill();
      await hookd.exited;
    }
  });

  test("the OpenCode plugin authenticates", async () => {
    ensureHookdKey();
    const prevPort = process.env.EDEN_HOOKD_PORT;
    try {
      await withHookd(async (port, statuses) => {
        process.env.EDEN_HOOKD_PORT = String(port);
        const file = join(home, "eden-recorder.js");
        writeFileSync(file, opencodePluginSource("/must-not-spawn/cli.ts"));
        const { EdenRecorderPlugin } = await import(file);
        const plugin = await EdenRecorderPlugin({ project: { directory: home }, directory: home });
        await plugin["tool.execute.before"]({ tool: "bash", sessionID: "local", callID: "c1" }, { args: {} });
        expect(statuses).toEqual([200]);
      });
    } finally {
      if (prevPort === undefined) delete process.env.EDEN_HOOKD_PORT;
      else process.env.EDEN_HOOKD_PORT = prevPort;
    }
  });
});

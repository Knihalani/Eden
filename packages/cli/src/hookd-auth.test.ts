import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleHookd } from "./hookd";
import { HOOKD_KEY_HEADER, ensureHookdKey, hookdKeyMatches, hookdKeyPath, readHookdKey } from "./hookd-key";
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
 * The plugin's client, copied out of the checkout so its in-process import fails and it takes the
 * hookd path, as it does when the plugin is installed on its own.
 */
function pluginCopy(): string {
  const copy = join(home, "plugin", "scripts", "hook.ts");
  mkdirSync(dirname(copy), { recursive: true });
  cpSync(join(import.meta.dir, "../../../plugins/eden-memory/scripts/hook.ts"), copy);
  return copy;
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
    expect(await ok.json()).toEqual({ ok: true });
  });

  test("with no key file hookd serves no hook, and /health still answers", async () => {
    expect((await handleHookd(post({ [HOOKD_KEY_HEADER]: "0".repeat(64) }))).status).toBe(401);
    expect((await handleHookd(new Request("http://127.0.0.1:8794/health"))).status).toBe(200);
  });

  test("the eden-memory plugin's client authenticates", async () => {
    ensureHookdKey();
    await withHookd(async (port, statuses) => {
      const out = await run(["bun", pluginCopy()], clientEnv(home, port), PRE_TOOL);
      expect(out).toEqual({ stdout: JSON.stringify({ ok: true }), code: 0 });
      expect(statuses).toEqual([200]);
    });
  });

  test("the plugin fails open with no key: exit 0, `{}`, hookd never asked", async () => {
    await withHookd(async (port, statuses) => {
      const prompt = { hook_event_name: "UserPromptSubmit", session_id: "local", prompt: "what is our CI?" };
      const out = await run(["bun", pluginCopy()], clientEnv(home, port), prompt);
      expect(out).toEqual({ stdout: "{}", code: 0 });
      expect(statuses).toEqual([]);
    });
  });

  test("the plugin fails open when hookd refuses its key", async () => {
    ensureHookdKey();
    const other = join(home, "other-home");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "hookd.key"), `${HOOKD_KEY_HEADER}: ${"ab".repeat(32)}\n`, { mode: 0o600 });
    await withHookd(async (port, statuses) => {
      const prompt = { hook_event_name: "UserPromptSubmit", session_id: "local", prompt: "what is our CI?" };
      const out = await run(["bun", pluginCopy()], clientEnv(other, port), prompt);
      expect(out).toEqual({ stdout: "{}", code: 0 });
      expect(statuses).toEqual([401]);
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
        expect(out).toEqual({ stdout: JSON.stringify({ ok: true }), code: 0 });
      }
      expect(statuses).toEqual([200, 200]);
      rmSync(hookdKeyPath());
      expect(await run(["sh", "-c", pre], clientEnv(home, port), PRE_TOOL)).toEqual({ stdout: "{}", code: 0 });
      expect(statuses).toEqual([200, 200]);
    });
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

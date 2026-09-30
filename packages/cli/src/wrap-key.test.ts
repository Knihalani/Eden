import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { LOCAL_KEY_PREFIX, resolveApiKey, resolveWrapKey, writeConfig } from "./home";
import { playCli } from "./play";
import { collectDoctor } from "./doctor";
import { respondToHook } from "./hook";
import { runTool } from "../../sdk-js/src/index";

// Issue #75: a plain loopback `eden wrap` used to guard /v1 with the public eden_dev key.

const CLI = join(import.meta.dir, "cli.ts");
const KEY_SHAPE = /^eden_local_[0-9a-f]{64}$/;
const ENV_NAMES = [
  "EDEN_HOME",
  "EDEN_API_KEY",
  "EDEN_DEV",
  "EDEN_WRAP_URL",
  "EDEN_BASE_URL",
  "EDEN_MEMORY",
  "EDEN_MEMORY_DIR",
] as const;

const homes: string[] = [];
const procs: Subprocess[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "eden-wrap-key-"));
  homes.push(home);
  return home;
}

function configAt(home: string): string {
  return join(home, ".eden", "config.json");
}

function readKey(home: string): string {
  return (JSON.parse(readFileSync(configAt(home), "utf8")) as { api_key: string }).api_key;
}

afterAll(() => {
  for (const proc of procs) proc.kill();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("resolveWrapKey", () => {
  const saved: Record<string, string | undefined> = {};
  let home = "";

  beforeEach(() => {
    for (const name of ENV_NAMES) saved[name] = process.env[name];
    for (const name of ENV_NAMES) delete process.env[name];
    home = tempHome();
    process.env.EDEN_HOME = join(home, ".eden");
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test("with no key it writes a 0600 config holding a fresh key, and later calls reuse it", () => {
    const first = resolveWrapKey([]);
    expect(first.created).toBe(true);
    expect(first.key).toMatch(KEY_SHAPE);
    expect(first.key.startsWith(LOCAL_KEY_PREFIX)).toBe(true);
    expect(statSync(configAt(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".eden")).mode & 0o777).toBe(0o700);
    expect(readKey(home)).toBe(first.key);
    expect(resolveWrapKey([])).toEqual({ key: first.key, created: false });
    // Every client resolves the same key through the same config path.
    expect(resolveApiKey([])).toBe(first.key);
  });

  test("two installs get different keys", () => {
    const one = resolveWrapKey([]).key;
    process.env.EDEN_HOME = join(tempHome(), ".eden");
    expect(resolveWrapKey([]).key).not.toBe(one);
  });

  test("an explicit key, a configured key, --dev or EDEN_DEV=1 wins and nothing is written", () => {
    expect(resolveWrapKey(["--key", "eden_flag"])).toEqual({ key: "eden_flag", created: false });
    process.env.EDEN_API_KEY = "eden_env";
    expect(resolveWrapKey([])).toEqual({ key: "eden_env", created: false });
    delete process.env.EDEN_API_KEY;
    expect(resolveWrapKey(["--dev"])).toEqual({ key: "eden_dev", created: false });
    process.env.EDEN_DEV = "1";
    expect(resolveWrapKey([])).toEqual({ key: "eden_dev", created: false });
    delete process.env.EDEN_DEV;
    expect(existsSync(configAt(home))).toBe(false);

    mkdirSync(join(home, ".eden"), { recursive: true });
    writeFileSync(configAt(home), JSON.stringify({ api_key: "eden_login", base_url: "http://127.0.0.1:8788" }));
    expect(resolveWrapKey(["--dev"])).toEqual({ key: "eden_login", created: false });
    expect(readKey(home)).toBe("eden_login");
  });

  test("writeConfig replaces a looser config.json with a new 0600 file", () => {
    mkdirSync(join(home, ".eden"), { recursive: true });
    writeFileSync(configAt(home), JSON.stringify({ base_url: "http://127.0.0.1:8788" }));
    chmodSync(configAt(home), 0o644);
    const before = statSync(configAt(home)).ino;
    writeConfig({ api_key: "eden_login", base_url: "http://127.0.0.1:8788" });
    expect(statSync(configAt(home)).mode & 0o777).toBe(0o600);
    expect(statSync(configAt(home)).ino).not.toBe(before);
    expect(readKey(home)).toBe("eden_login");
  });

  test("a config without a key keeps its other fields", () => {
    mkdirSync(join(home, ".eden"), { recursive: true });
    writeFileSync(configAt(home), JSON.stringify({ base_url: "http://127.0.0.1:9911", steer_hooks: false }));
    const { key } = resolveWrapKey([]);
    const cfg = JSON.parse(readFileSync(configAt(home), "utf8")) as Record<string, unknown>;
    expect(cfg).toEqual({ base_url: "http://127.0.0.1:9911", steer_hooks: false, api_key: key });
  });
});

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("no free port");
  return port;
}

function childEnv(home: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("EDEN_")) continue;
    if (k === "VERCEL" || k === "DATABASE_URL" || k === "OPENAI_API_KEY") continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    EDEN_HOME: join(home, ".eden"),
    EDEN_HOOKD: "0",
    EDEN_SCHEDULE_CLOCK: "0",
    ...extra,
  };
}

type Wrap = { url: string; stop: () => Promise<string> };

async function bootWrap(home: string, args: string[] = [], env: Record<string, string> = {}): Promise<Wrap> {
  const port = freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([process.execPath, CLI, "wrap", "--no-coding", "--port", String(port), ...args], {
    env: childEnv(home, { EDEN_WRAP_URL: url, ...env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const stop = async () => {
    proc.kill();
    await proc.exited;
    return new Response(proc.stdout).text();
  };
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) break;
    const up = await fetch(`${url}/health`).then((r) => r.ok, () => false);
    if (up) return { url, stop };
    await Bun.sleep(50);
  }
  const err = await stop().then(() => new Response(proc.stderr).text());
  throw new Error(`eden wrap did not come up: ${err}`);
}

async function inboxStatus(url: string, auth?: string): Promise<number> {
  const res = await fetch(`${url}/v1/inbox`, { headers: auth ? { authorization: auth } : {} });
  return res.status;
}

describe("eden wrap on loopback with no key", () => {
  test("the first boot writes a 0600 config with a fresh key; the second boot reuses it", async () => {
    const home = tempHome();
    const first = await bootWrap(home);
    const key = readKey(home);
    expect(key).toMatch(KEY_SHAPE);
    expect(statSync(configAt(home)).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(configAt(home), "utf8")) as { base_url: string }).base_url).toBe(first.url);
    const out1 = await first.stop();
    expect(out1).toContain(`Created a local wrap key in ${configAt(home)} (mode 0600).`);
    expect(out1).not.toContain(key);

    const second = await bootWrap(home);
    const out2 = await second.stop();
    expect(readKey(home)).toBe(key);
    expect(out2).not.toContain("Created a local wrap key");
  });

  test("/v1 refuses Bearer eden_dev and accepts only the generated key", async () => {
    const home = tempHome();
    const wrap = await bootWrap(home);
    try {
      expect(await inboxStatus(wrap.url, "Bearer eden_dev")).toBe(401);
      expect(await inboxStatus(wrap.url)).toBe(401);
      expect(await inboxStatus(wrap.url, `Bearer ${readKey(home)}`)).toBe(200);
    } finally {
      await wrap.stop();
    }
  });

  test("--dev or a user-set EDEN_DEV=1 serves eden_dev and writes no key", async () => {
    for (const [args, env] of [[["--dev"], {}], [[], { EDEN_DEV: "1" }]] as const) {
      const home = tempHome();
      const wrap = await bootWrap(home, [...args], { ...env });
      try {
        expect(await inboxStatus(wrap.url, "Bearer eden_dev")).toBe(200);
      } finally {
        await wrap.stop();
      }
      expect(existsSync(configAt(home))).toBe(false);
    }
  });

  test("a non-loopback host still needs a key and writes none", async () => {
    const home = tempHome();
    const args = [CLI, "wrap", "--no-coding", "--host", "0.0.0.0", "--port", String(freePort())];
    const proc = Bun.spawn([process.execPath, ...args], {
      env: childEnv(home, {}),
      stdout: "pipe",
      stderr: "pipe",
    });
    procs.push(proc);
    const timer = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);
    expect(code).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain("eden needs a key");
    expect(existsSync(configAt(home))).toBe(false);
  });
});

describe("local clients use the key a plain eden wrap wrote", () => {
  const saved: Record<string, string | undefined> = {};
  let home = "";
  let wrap: Wrap;

  beforeEach(async () => {
    home = tempHome();
    wrap = await bootWrap(home);
    for (const name of ENV_NAMES) saved[name] = process.env[name];
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.EDEN_HOME = join(home, ".eden");
    process.env.EDEN_WRAP_URL = wrap.url;
  });

  afterEach(async () => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await wrap.stop();
  });

  async function playErrors(args: string[]): Promise<string> {
    const lines: string[] = [];
    const error = console.error;
    console.error = (msg?: unknown) => {
      lines.push(String(msg ?? ""));
    };
    try {
      await playCli(args);
    } finally {
      console.error = error;
    }
    return lines.join("\n");
  }

  test("eden play authenticates; the public eden_dev key is refused", async () => {
    // Past the auth gate, an unknown tool is "not live".
    expect(await playErrors(["lookup", "--input", "{}"])).toBe("play: not live · Approve is the On switch");
    expect(await playErrors(["lookup", "--key", "eden_dev", "--input", "{}"])).toBe("play: unauthorized");
  });

  test("eden doctor's keyed probe of /v1/wrap is accepted", async () => {
    const onlyWrap = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith(wrap.url) ? fetch(input, init) : Promise.reject(new Error("offline"))) as typeof fetch;
    const checks = await collectDoctor({ fetch: onlyWrap });
    expect(checks.find((c) => c.name === "config")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "wrap")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "agent-http")).toMatchObject({ ok: true, detail: "POST /v1/wrap HTTP 200" });
  });

  test("the hook posts a finished session to /v1/traces with that key", async () => {
    process.env.EDEN_MEMORY = "off";
    process.env.EDEN_MEMORY_DIR = join(home, "memory");
    for (const id of ["T-1", "T-2"]) {
      const event = { session_id: "s75", tool_name: "lookupTicket", tool_input: { id }, tool_response: { ok: true } };
      await respondToHook({ hook_event_name: "PostToolUse", ...event });
    }
    await respondToHook({ hook_event_name: "Stop", session_id: "s75" });
    let traces = 0;
    for (let i = 0; i < 100 && traces === 0; i++) {
      traces = ((await (await fetch(`${wrap.url}/health`)).json()) as { traces: number }).traces;
      if (traces === 0) await Bun.sleep(20);
    }
    expect(traces).toBe(1);
  });

  test("the JS SDK's loopback default authenticates", async () => {
    const orig = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await orig(input, init);
      seen.push(`${new URL(String(input)).pathname} ${res.status}`);
      return res;
    }) as typeof fetch;
    try {
      await runTool("lookup", { id: "T-1" }, async () => "raw", { baseUrl: wrap.url });
    } finally {
      globalThis.fetch = orig;
    }
    expect(seen).toEqual(["/v1/wrap 200", "/v1/ingest 202"]);
  });
});

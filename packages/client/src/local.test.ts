import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findLocalBinary, LocalEden, resolveLocalEden } from "./local";

const root = resolve(import.meta.dir, "../../..");

test("a local child answers on loopback with its fresh token, then closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eden-local-client-"));
  const eden = new LocalEden([process.execPath, join(root, "packages/server/src/main.ts")], {
    home: join(dir, "data"),
    sourcesFile: undefined,
    logPath: join(dir, "logs", "eden-local.log"),
    env: { HOME: dir, PATH: process.env.PATH },
    readyTimeoutMs: 10_000,
    warn: () => {},
  });
  try {
    const got = await eden.endpoint();
    expect(got).not.toBeNull();
    const post = (auth: string | undefined) =>
      fetch(`${got!.url}/v1/whoami`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify({ tenantId: "local", userId: "u1", sessionId: "s1" }),
      });
    expect((await post(got!.token)).status).toBe(200);
    expect((await post("local_wrongwrong")).status).toBe(401);
    // The same live child answers again without a respawn.
    const again = await eden.endpoint();
    expect(again).toEqual(got);
  } finally {
    eden.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing binary fails open: null endpoint, one warning, a retry backoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eden-local-missing-"));
  const warnings: string[] = [];
  const eden = new LocalEden([join(dir, "no-such-binary")], {
    home: join(dir, "data"),
    env: {},
    readyTimeoutMs: 50,
    warn: (p) => warnings.push(p),
  });
  try {
    expect(await eden.endpoint()).toBeNull();
    expect(await eden.endpoint()).toBeNull(); // backoff: no immediate respawn
    expect(warnings.length).toBeGreaterThan(0);
  } finally {
    eden.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binary discovery: EDEN_LOCAL_BINARY, then the plugin's bin/, then the home's plugins/eden/bin", () => {
  const dir = mkdtempSync(join(tmpdir(), "eden-bin-"));
  try {
    const plugin = join(dir, "plugin");
    const home = join(dir, "home", "plugins", "eden");
    for (const p of [join(plugin, "bin"), join(home, "bin")]) mkdirSync(p, { recursive: true });
    const name = process.platform === "win32" ? "eden-local.cmd" : "eden-local";
    writeFileSync(join(home, "bin", name), "");
    expect(findLocalBinary({}, plugin, [join(dir, "home", "plugins", "eden")])).toBe(join(home, "bin", name));
    writeFileSync(join(plugin, "bin", name), "");
    expect(findLocalBinary({}, plugin, [])).toBe(join(plugin, "bin", name));
    const explicit = join(dir, "somewhere", name);
    mkdirSync(dirname(explicit), { recursive: true });
    writeFileSync(explicit, "");
    expect(findLocalBinary({ EDEN_LOCAL_BINARY: explicit }, plugin, [])).toBe(resolve(explicit));
    expect(findLocalBinary({}, join(dir, "nope"), [])).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveLocalEden: EDEN_URL wins with its key and tenant; else a found binary; else null", () => {
  const dir = mkdtempSync(join(tmpdir(), "eden-resolve-"));
  try {
    const hosted = resolveLocalEden(
      { EDEN_URL: "https://eden.example", EDEN_API_KEY: "k", EDEN_TENANT_ID: "acme", EDEN_USER_ID: "u 1" },
      { home: dir },
    );
    expect(hosted).toEqual({
      baseUrl: "https://eden.example",
      apiKey: "k",
      tenantId: "acme",
      userId: "u 1",
    });
    const binDir = join(dir, "plugins", "eden", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, process.platform === "win32" ? "eden-local.cmd" : "eden-local"), "");
    expect(resolveLocalEden({}, { home: dir })).toEqual({
      binary: join(dir, "plugins", "eden", "bin", process.platform === "win32" ? "eden-local.cmd" : "eden-local"),
      home: dir,
    });
    expect(resolveLocalEden({}, { home: join(dir, "empty") })).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

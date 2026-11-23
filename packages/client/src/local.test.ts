import { expect, test } from "bun:test";
import { tmpDir } from "../../primitives/src/tmpdir";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findLocalBinary, LocalEden, resolveLocalEden } from "./local";
import type { EdenClient } from "./client";

const root = resolve(import.meta.dir, "../../..");

test("a local child answers on loopback with its fresh token, then closes", async () => {
  const dir = tmpDir("eden-local-client-");
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

test("the spawned child sees the local-model options, else the owner's EDEN_MODEL_* (D2109)", async () => {
  const dir = tmpDir("eden-local-model-env-");
  const script = join(dir, "dump-env.ts");
  writeFileSync(
    script,
    `import { mkdirSync, writeFileSync } from "node:fs";
     import { join } from "node:path";
     mkdirSync(process.env.EDEN_HOME!, { recursive: true });
     writeFileSync(join(process.env.EDEN_HOME!, "env.json"), JSON.stringify(process.env));
     console.log("EDEN_LOCAL_READY 9");
     setTimeout(() => {}, 60_000);`,
  );
  const eden = new LocalEden([process.execPath, script], {
    home: join(dir, "data"),
    model: "opt-model",
    modelApiKey: "k",
    modelTimeoutMs: 90_000,
    env: {
      HOME: dir,
      PATH: process.env.PATH,
      EDEN_MODEL: "env-model",
      EDEN_MODEL_BASE_URL: "http://env/v1",
      OPENROUTER_API_KEY: "secret",
    },
    readyTimeoutMs: 10_000,
    warn: () => {},
  });
  try {
    expect(await eden.endpoint()).not.toBeNull();
    const child = JSON.parse(readFileSync(join(dir, "data", "env.json"), "utf8"));
    // The option wins where set; the owner's own variable carries the rest.
    expect(child.EDEN_MODEL).toBe("opt-model");
    expect(child.EDEN_MODEL_BASE_URL).toBe("http://env/v1");
    expect(child.EDEN_MODEL_API_KEY).toBe("k");
    expect(child.EDEN_MODEL_TIMEOUT_MS).toBe("90000");
    expect(child.OPENROUTER_API_KEY).toBeUndefined();
  } finally {
    eden.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sharePath: a second owner attaches to the recorded daemon, which outlives the first", async () => {
  const dir = tmpDir("eden-local-shared-");
  const share = join(dir, "eden", "local-endpoint.json");
  const command = [process.execPath, join(root, "packages/server/src/main.ts")];
  const opts = {
    home: join(dir, "data"),
    logPath: join(dir, "logs", "eden-local.log"),
    env: { HOME: dir, PATH: process.env.PATH },
    readyTimeoutMs: 10_000,
    warn: () => {},
  };
  const first = new LocalEden(command, { ...opts, sharePath: share });
  let daemonPid: number | undefined;
  try {
    const got = await first.endpoint();
    expect(got).not.toBeNull();
    const recorded = JSON.parse(readFileSync(share, "utf8"));
    daemonPid = recorded.pid;
    expect(recorded.url).toBe(got!.url);
    expect(String(got!.generation)).toContain(":");

    // A second owner (another process of the same agent) attaches: same endpoint, no respawn.
    const second = new LocalEden(command, { ...opts, sharePath: share });
    const attached = await second.endpoint();
    expect(attached).toEqual(got);
    const whoami = await fetch(`${attached!.url}/v1/whoami`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${attached!.token}` },
      body: JSON.stringify({ tenantId: "local", userId: "u1", sessionId: "s1" }),
    });
    expect(whoami.status).toBe(200);
    second.close();

    // Closing the spawner does not stop the shared daemon; the file stays attachable.
    first.close();
    expect((await fetch(`${got!.url}/healthz`, { headers: { authorization: `Bearer ${got!.token}` } })).status).toBe(
      200,
    );
  } finally {
    if (daemonPid !== undefined) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sharePath: a daemon recorded with other model settings is replaced (D2109)", async () => {
  const dir = tmpDir("eden-local-model-share-");
  const share = join(dir, "eden", "local-endpoint.json");
  const sourcesFile = join(dir, "sources.json");
  writeFileSync(sourcesFile, JSON.stringify({ sources: [] }));
  const command = [process.execPath, join(root, "packages/server/src/main.ts")];
  const opts = {
    home: join(dir, "data"),
    sourcesFile,
    env: { HOME: dir, PATH: process.env.PATH },
    readyTimeoutMs: 10_000,
    warn: () => {},
  };
  let daemonPid: number | null = null;
  try {
    const first = new LocalEden(command, { ...opts, sharePath: share });
    expect(await first.endpoint()).not.toBeNull();
    const recorded = JSON.parse(readFileSync(share, "utf8"));
    daemonPid = recorded.pid;
    expect(recorded.model).toEqual({});
    first.close();
    // Same sources, new model settings: the recorded daemon is stale and is replaced, not attached.
    const second = new LocalEden(command, {
      ...opts,
      sharePath: share,
      model: "m2",
      modelBaseUrl: "http://127.0.0.1:1/v1",
    });
    expect(await second.endpoint()).not.toBeNull();
    const newer = JSON.parse(readFileSync(share, "utf8"));
    expect(newer.pid).not.toBe(daemonPid);
    daemonPid = newer.pid;
    expect(newer.model).toEqual({ EDEN_MODEL: "m2", EDEN_MODEL_BASE_URL: "http://127.0.0.1:1/v1" });
    second.close();
  } finally {
    if (daemonPid) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sharePath: a daemon recorded before the sources changed is replaced, a dead one is dropped", async () => {
  const dir = tmpDir("eden-local-stale-");
  const share = join(dir, "eden", "local-endpoint.json");
  const sourcesFile = join(dir, "sources.json");
  writeFileSync(sourcesFile, JSON.stringify({ sources: [] }));
  const command = [process.execPath, join(root, "packages/server/src/main.ts")];
  const opts = {
    home: join(dir, "data"),
    sourcesFile,
    env: { HOME: dir, PATH: process.env.PATH },
    readyTimeoutMs: 10_000,
    warn: () => {},
  };
  const first = new LocalEden(command, { ...opts, sharePath: share });
  try {
    const got = await first.endpoint();
    expect(got).not.toBeNull();
    const oldPid = JSON.parse(readFileSync(share, "utf8")).pid;
    first.close();

    // A sources change makes the recorded daemon stale: the next owner kills and replaces it.
    writeFileSync(
      sourcesFile,
      JSON.stringify({
        sources: [{ id: "s2", description: "changed", docs: [{ ref: "r", title: "t", text: "x" }] }],
      }),
    );
    const second = new LocalEden(command, { ...opts, sharePath: share });
    const newer = await second.endpoint();
    expect(newer).not.toBeNull();
    expect(newer!.url).not.toBe(got!.url);
    // SIGTERM's shutdown grace keeps the port answering briefly; wait for it to refuse.
    const deadline = Date.now() + 6_000;
    let gone = false;
    while (Date.now() < deadline && !gone) {
      gone = await fetch(`${got!.url}/healthz`, { headers: { authorization: `Bearer ${got!.token}` } }).then(
        () => false,
        () => true,
      );
      if (!gone) await new Promise((r) => setTimeout(r, 100));
    }
    expect(gone).toBe(true);
    second.close();
    const newPid = JSON.parse(readFileSync(share, "utf8")).pid;
    try {
      process.kill(newPid, "SIGTERM");
    } catch {
      // Already gone.
    }

    // A recorded daemon that never answers healthz: the file is dropped, a fresh one spawned.
    writeFileSync(share, JSON.stringify({ url: "http://127.0.0.1:1", token: "t".repeat(33), pid: 1, generation: "x" }));
    const third = new LocalEden(command, { ...opts, sharePath: share });
    const fresh = await third.endpoint();
    expect(fresh).not.toBeNull();
    expect(fresh!.url).not.toBe("http://127.0.0.1:1");
    const lastPid = JSON.parse(readFileSync(share, "utf8")).pid;
    try {
      process.kill(lastPid, "SIGTERM");
    } catch {
      // Already gone.
    }
    third.close();
    expect(oldPid).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing binary fails open: null endpoint, one warning, a retry backoff", async () => {
  const dir = tmpDir("eden-local-missing-");
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
  const dir = tmpDir("eden-bin-");
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
  const dir = tmpDir("eden-resolve-");
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

test("surface closeSession reports session_end on the session's queue, then drops it", async () => {
  const { createLocalSurface } = await import("./surface");
  const { EdenClient } = await import("./client");
  const surface = createLocalSurface({ pluginDir: "/nope", home: "/nope" });
  const kinds: string[] = [];
  let closed = false;
  surface.sessions.set("s1", {
    eden: {
      observe: async (e: { kind: string }) => (kinds.push(e.kind), { injection: null, pending: false }),
    } as unknown as EdenClient,
    options: { userId: "u" },
    sessionId: "s1",
    generation: 0,
    seen: new Map(),
    copyCounts: new Map(),
    reportedAssistant: new Set(),
    kept: new Map(),
    trailing: [],
    reported: Promise.resolve(),
    queued: [],
    firstCall: false,
    local: { close: () => (closed = true) } as never,
    reportedCalls: new Set(),
    reportedResults: new Set(),
  });
  await surface.closeSession("s1");
  expect(kinds).toEqual(["session_end"]);
  expect(closed).toBe(true);
  expect(surface.sessions.has("s1")).toBe(false);
  await surface.closeSession("s1"); // unknown keys are a no-op
  expect(kinds).toEqual(["session_end"]);
});

test("surface closeSession during an in-flight sessionFor discards the made session", async () => {
  const { createLocalSurface } = await import("./surface");
  // EDEN_URL answers resolveLocalEden's hosted path with no probe, so create() succeeds without a server;
  // the doomed session's session_start/session_end observes just fail to reach it and are swallowed.
  const surface = createLocalSurface({
    pluginDir: "/nope",
    home: "/nope",
    env: { EDEN_URL: "http://127.0.0.1:1", EDEN_USER_ID: "u" },
  });
  const pending = surface.sessionFor("s-zombie");
  await surface.closeSession("s-zombie");
  expect(await pending).toBeNull();
  expect(surface.sessions.has("s-zombie")).toBe(false);
  // A later sighting of the same conversation creates it fresh — the tombstone does not stick.
  expect(await surface.sessionFor("s-zombie")).not.toBeNull();
  expect(surface.sessions.has("s-zombie")).toBe(true);
});

test("surface report serializes concurrent callers on the session's queue", async () => {
  const { createLocalSurface } = await import("./surface");
  const surface = createLocalSurface({ pluginDir: "/nope", home: "/nope" });
  const order: string[] = [];
  surface.sessions.set("s1", {
    eden: {
      observe: async (e: { kind: string }) => {
        await new Promise((r) => setTimeout(r, 1));
        order.push(e.kind);
        return { injection: null, pending: false };
      },
    } as unknown as EdenClient,
    options: { userId: "u" },
    sessionId: "s1",
    generation: 0,
    seen: new Map(),
    copyCounts: new Map(),
    reportedAssistant: new Set(),
    kept: new Map(),
    trailing: [],
    reported: Promise.resolve(),
    queued: [],
    firstCall: false,
    local: null,
    reportedCalls: new Set(),
    reportedResults: new Set(),
  });
  const s = surface.sessions.get("s1")!;
  await Promise.all([
    surface.report(s, [{ kind: "a" }, { kind: "b" }], false),
    surface.report(s, [{ kind: "c" }], false),
  ]);
  expect(order).toEqual(["a", "b", "c"]);
});

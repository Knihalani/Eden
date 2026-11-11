#!/usr/bin/env bun
/**
 * Starts the partner's HTTP API. `bun run dev` from the repo root. With EDEN_PROCESSES above 1 this process is the
 * router (router.ts, D163) and each of its children runs this file again as one server process (EDEN_ROUTER_CHILD).
 */
import { dirname } from "node:path";
import { DEFAULT_CACHE_LIMITS, EncryptedFrozenDisk, type PersistEvent } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { warmGate } from "@eden/redact";
import { loadConfig, type ServerConfig } from "./config";
import { sourcesOrExit } from "./connectors";
import { buildPartner, startGatePool, tenantSpendFor } from "./build";
import { engineConfig } from "./engine-config";
import { createHandler } from "./http";
import { modelRolesFromEnv } from "./models";
import { childPersistDir, prunePersistDirs } from "./persist";
import { rehomeSourceMaps, runRouter } from "./router";

const started = performance.now();
const config = configOrExit();
// Dev mode takes requests with no key as tenant "dev": say so loudly when anything but this machine can reach it (a
// container listens on 0.0.0.0; publish its port on 127.0.0.1 for local use).
if (config.dev && !config.child && !["127.0.0.1", "localhost", "::1"].includes(config.host)) {
  console.error(`eden: EDEN_DEV=1 on ${config.host}: anyone who can reach this port is served without a key`);
}
try {
  if (config.processes > 1) {
    await runRouter(config);
  } else {
    await serve(config);
  }
} catch (e) {
  startupFailed(e, config);
}

/**
 * A configuration mistake as one line naming the setting, exit 2 (D365). Uncaught, Bun printed ten lines of
 * config.ts's source and a stack with the message buried in them, the first thing an operator saw for a short key.
 */
function configOrExit(): ServerConfig {
  try {
    return loadConfig();
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const home =
      code === "ENOENT" || code === "EACCES" || code === "EROFS" ? " (EDEN_HOME must be a writable directory)" : "";
    console.error(`eden: ${e instanceof Error ? e.message : String(e)}${home}`);
    process.exit(2);
  }
}

/** A startup failure after the configuration parsed (a busy port, an unwritable EDEN_HOME) as one line, exit 2. */
function startupFailed(e: unknown, config: ServerConfig): never {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === "EADDRINUSE") {
    console.error(`eden: ${config.host}:${config.port} is in use: stop the other server, or set PORT to a free port`);
  } else if (code === "ENOENT" || code === "EACCES" || code === "EROFS") {
    const path = (e as { path?: unknown }).path;
    console.error(
      `eden: cannot start: ${message}${typeof path === "string" ? ` (${path})` : ""}: a file a setting names` +
        ` (EDEN_SOURCES_FILE, EDEN_USER_SOURCES_FILE, EDEN_ENGINE_CONFIG) is missing or unreadable, or EDEN_HOME` +
        ` (${dirname(config.sourceMapPath)}) is not writable`,
    );
  } else {
    console.error(`eden: cannot start: ${message}`);
  }
  process.exit(2);
}

async function serve(config: ServerConfig): Promise<void> {
  // One process (no router): the `.<i>` files a router's children wrote are merged back into this one before it is
  // opened, so forget reaches every row (D163). A router child skips this: the router did it before starting it.
  if (!config.child) {
    try {
      rehomeSourceMaps(config.sourceMapPath, 1);
    } catch (e) {
      console.error(`eden: cannot merge stranded source-map files: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  }
  const engine = engineConfig();
  // D425 (opt-in): frozen users written encrypted to this process's own directory, read back on first use.
  const persist = persistStore(config);
  // Per-user sources when EDEN_USER_SOURCES_FILE is set (D108); forget closes their connections. Before the gate
  // pool, so a bad sources file exits 2 with its message before any worker starts.
  const sources = sourcesOrExit();
  const gatePool = await startGatePool(config.gateWorkers);
  const models = modelRolesFromEnv();
  // Held here so a shutdown can write its last outcome batch (`SourceMap.close` flushes).
  const sourceMap = new SourceMap(config.sourceMapPath);
  const child = config.child;
  // The cap every model role shares (D163): divided by N in a router child.
  const tenants = tenantSpendFor(models.usdPerTenantDay, child?.count ?? 1);
  const partner = buildPartner({
    tenants,
    gatePool,
    sources: sources.resolver,
    sourceMap,
    queryPlanner: config.queryPlanner,
    engine,
    // Cards, intent and the reader on OPENROUTER_API_KEY's model (D112); without a key, the default's no-model path.
    models,
    // A router child holds 1/N of each tenant's daily model spend (D163).
    processes: config.child?.count ?? 1,
    onShadow: process.env.EDEN_TRACE === "1" ? (r) => console.log(JSON.stringify({ shadow: r })) : undefined,
    onTrace: process.env.EDEN_TRACE === "1" ? (t) => console.log(JSON.stringify(t)) : undefined,
    // Whether the agent used each injection (D293), for `bun run digest`; content-free like the traces.
    onUsage: process.env.EDEN_TRACE === "1" ? (u) => console.log(JSON.stringify({ usage: u })) : undefined,
    ...(persist ? { persist } : {}),
  });
  // The background sync's own connector calls (backfill, sweeps) are made outside any request, so no trace has them:
  // with EDEN_TRACE=1 its cumulative counters are logged once a minute, per process, for `bun run digest` (D293).
  // `run` tells processes apart where a pid cannot: a container restart is pid 1 again, and replicas share it.
  const sync = partner.sync;
  if (process.env.EDEN_TRACE === "1" && sync) {
    const run = crypto.randomUUID();
    setInterval(() => console.log(JSON.stringify({ sync: { run, pid: process.pid, ...sync.stats } })), 60_000).unref();
  }
  // The secret gate compiles its rules on first use; doing it here keeps that stall off the first request.
  warmGate();
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    // D100: Bun's default is 128 MB; the handler's content-length check cannot see chunked bodies, this cap can.
    maxRequestBodySize: config.maxBodyBytes,
    fetch: createHandler(partner, config, sources.userSources, tenants),
  });
  // Stop on SIGTERM/SIGINT with the source map's last outcome batch written. Without a handler a container's PID 1
  // ignores SIGTERM (`docker stop` waited 10 s, then SIGKILL), and a router child died by the signal, batch unwritten.
  // Installed before the listening line: whoever waits for that line may signal at once.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void server.stop(true);
    partner.stopSync();
    // D425: users still live are written as frozen ones, within the router's 2 s grace (the rest re-sync).
    if (persist) {
      const t0 = performance.now();
      const n = partner.persistLive(PERSIST_FLUSH_MS);
      console.error(`eden: persisted ${n} live users at shutdown in ${Math.round(performance.now() - t0)} ms`);
    }
    try {
      sourceMap.close();
    } catch (e) {
      console.error(`eden: source map not closed cleanly: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  const startupMs = Math.round(performance.now() - started);
  const keys = Object.keys(engine);
  console.log(
    `eden partner listening on http://${server.hostname}:${server.port}${config.dev ? " (dev, no auth)" : ""}` +
      ` (startup ${startupMs} ms; model roles ${process.env.OPENROUTER_API_KEY ? "on" : "off (no OPENROUTER_API_KEY)"}` +
      `; sources ${sources.shared} shared${sources.userSources ? " + per user (EDEN_USER_SOURCES_FILE)" : ""}` +
      `${keys.length > 0 ? `; engine settings: ${keys.join(", ")}` : ""}` +
      (persist ? `; frozen users persisted, encrypted (${persist.count} on disk, D425)` : "") +
      (child
        ? `; router child ${child.index} of ${child.count}, per-tenant caps divided by ${child.count}:` +
          ` $${round(models.usdPerTenantDay / child.count)}/day,` +
          ` ${round(config.tenantRatePerSec)} rps, burst ${round(config.tenantBurst)}`
        : "") +
      ")",
  );
  if (child) {
    // The router waits for this port before it routes here; the IPC channel exists only when the router spawned us.
    process.send?.({ edenListening: server.port });
    // The router is gone (killed, crashed): nothing can reach this child any more, so it must not outlive it.
    process.on("disconnect", shutdown);
  }
}

/** Shutdown's budget for writing live users (D425): under the router's 2 s before it kills a child. */
const PERSIST_FLUSH_MS = 1_500;

/**
 * The encrypted store of frozen users (D425), or null when not configured. One process with no router deletes the
 * directories a router's children wrote first (their users re-sync). Problems are reported by reason and count only,
 * a line a minute at most, never a name, id or the key.
 */
function persistStore(config: ServerConfig): EncryptedFrozenDisk | null {
  const p = config.persist;
  if (!p) return null;
  const child = config.child ?? { index: 0, count: 1 };
  if (!config.child) prunePersistDirs(p.dir, 1);
  const counts = new Map<string, number>();
  const report = (e: PersistEvent) => {
    const k = `${e.kind} (${e.reason})`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  const flush = () => {
    if (counts.size === 0) return;
    const parts = [...counts].map(([k, n]) => `${n} ${k}`);
    counts.clear();
    console.error(`eden: frozen users on disk: ${parts.join(", ")}; those users re-sync (D425)`);
  };
  const store = new EncryptedFrozenDisk({
    dir: childPersistDir(p.dir, child.index, child.count),
    key: p.key.bytes(),
    maxBytes: p.maxBytes,
    // The cap on a file's own expiry (its newest item's, D428): the cache's longest time to live (synced, 7 days).
    maxAgeMs: DEFAULT_CACHE_LIMITS.syncTtlMs,
    report,
  });
  flush();
  setInterval(flush, 60_000).unref();
  return store;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

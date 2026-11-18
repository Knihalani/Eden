#!/usr/bin/env bun
/**
 * Starts the partner's HTTP API. `bun run dev` from the repo root. With EDEN_PROCESSES above 1 this process is the
 * router (router.ts, D163) and each of its children runs this file again as one server process (EDEN_ROUTER_CHILD).
 */
import { dirname } from "node:path";
import {
  DEFAULT_CACHE_LIMITS,
  EncryptedFrozenDisk,
  type PersistEvent,
  PersistKeyMismatch,
  SharedFrozenDisk,
  turnGate,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { warmGate } from "@eden/redact";
import { loadConfig, type ServerConfig } from "./config";
import { sourcesOrExit } from "./connectors";
import { buildPartner, startGatePool, tenantSpendFor, turnGateNotice } from "./build";
import { engineConfig } from "./engine-config";
import { createHandler } from "./http";
import { modelRolesFromEnv, NO_MODELS } from "./models";
import { localBoundary, localConfig, redirectLocalConsole, watchLocalInput } from "./local";
import { S3BlobStore } from "./blob-store";
import { nodesFromEnv, runCluster } from "./cluster";
import { Ops, serveError } from "./ops";
import { childOwns, prunePersistDirs } from "./persist";
import { keyOf } from "./auth";
import { rehomeSourceMaps, runRouter, userOf } from "./router";

/** Logs the persistence problems counted since the last line; shutdown calls it, so the last minute's show (R1). */
let flushPersistReport: () => void = () => {};

const started = performance.now();
let local = false;
const config = configOrExit();
// Dev mode takes requests with no key as tenant "dev": say so loudly when anything but this machine can reach it (a
// container listens on 0.0.0.0; publish its port on 127.0.0.1 for local use).
if (config.dev && !config.child && !["127.0.0.1", "localhost", "::1"].includes(config.host)) {
  console.error(`eden: EDEN_DEV=1 on ${config.host}: anyone who can reach this port is served without a key`);
}
// D858: a dev server (the quick start, the examples, smoke runs) inheriting OPENROUTER_API_KEY from a shell turned its
// model roles on and made paid calls nobody asked for. It refuses to start unless the calls are wanted.
if (config.dev && !config.child && process.env.OPENROUTER_API_KEY && process.env.EDEN_ALLOW_MODEL_ROLES !== "1") {
  console.error(
    "eden: EDEN_DEV=1 with OPENROUTER_API_KEY set would make paid model calls; start it with " +
      "`env -u OPENROUTER_API_KEY …`, or set EDEN_ALLOW_MODEL_ROLES=1 to allow them (D858)",
  );
  process.exit(2);
}
// Wrapped in a call so the compiled local binary can ship `--bytecode` (top-level await forces the build off the
// bytecode cache; nothing else in the bundle needs it).
void (async () => {
  try {
    // D992: with EDEN_NODES (or EDEN_NODES_FILE) this process is the cluster router over machines, and holds no users.
    const cluster = local || config.child ? null : nodesFromEnv(process.env);
    if (cluster) {
      await runCluster(config, cluster);
    } else if (config.processes > 1) {
      await runRouter(config);
    } else {
      await serve(config);
    }
  } catch (e) {
    startupFailed(e, config);
  }
})();

/**
 * A configuration mistake as one line naming the setting, exit 2 (D365). Uncaught, Bun printed ten lines of
 * config.ts's source and a stack with the message buried in them, the first thing an operator saw for a short key.
 */
function configOrExit(): ServerConfig {
  try {
    if (process.env.EDEN_LOCAL === "1") redirectLocalConsole();
    const isolated = localConfig();
    if (isolated) {
      local = true;
      return isolated;
    }
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
  if (!local && !config.child) {
    try {
      rehomeSourceMaps(config.sourceMapPath, 1);
    } catch (e) {
      console.error(`eden: cannot merge stranded source-map files: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  }
  const engine = local ? {} : engineConfig();
  // D425, on by default since D991: frozen users written encrypted to the machine's directory (this child's buckets,
  // D992), read back on first use; with EDEN_PERSIST_STORE also mirrored to the store every machine reaches.
  const persist = local ? null : await persistStore(config);
  // Per-user sources when EDEN_USER_SOURCES_FILE is set (D108); forget closes their connections. Before the gate
  // pool, so a bad sources file exits 2 with its message before any worker starts.
  const sources = sourcesOrExit();
  const gatePool = await startGatePool(config.gateWorkers);
  const models = local ? NO_MODELS : modelRolesFromEnv();
  // Held here so a shutdown can write its last outcome batch (`SourceMap.close` flushes).
  const sourceMap = new SourceMap(config.sourceMapPath);
  const child = config.child;
  // The cap every model role shares (D163): divided by N in a router child, and by the machines in a cluster (D992).
  const share = (child?.count ?? 1) * (config.cluster?.size ?? 1);
  const tenants = tenantSpendFor(models.usdPerTenantDay, share);
  const partner = buildPartner({
    tenants,
    gatePool,
    sources: sources.resolver,
    sourceMap,
    queryPlanner: config.queryPlanner,
    engine,
    // Cards, intent and the reader on OPENROUTER_API_KEY's model (D112); without a key, the default's no-model path.
    models,
    // A router child holds 1/N of each tenant's daily model spend (D163), 1/(N x machines) in a cluster (D992).
    processes: share,
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
  // The secret gate compiles its rules on first use; doing it here keeps that stall off the first request. Local
  // mode warms it after EDEN_LOCAL_READY instead (the owner blocks on that line, and the local path never returns
  // a 503 while the compile runs: requests arriving during it just wait the ~35 ms once).
  if (!local) warmGate();
  // The turn gate fails open (D1014): unreadable weights leave the start rule alone. Said once, so a missing
  // `turn-gate.bin` in an image is seen (R1), not only measured.
  const gateNotice = turnGateNotice(partner.config.pushGate, turnGate());
  if (gateNotice) console.error(gateNotice);
  const grace = config.shutdownGraceMs ?? 10_000;
  // D992: readiness, metrics and the cluster router's membership messages, around the API.
  const ops = new Ops(partner, persist, {
    clusterKey: config.cluster?.key ?? undefined,
    child: child ?? { index: 0, count: 1 },
    releaseMs: Math.max(5_000, grace),
    // The fence's view of a request (only in a cluster): the tenant from its key, the user from its body.
    userOf: async (req) => {
      const key = keyOf(req);
      const tenantId = key && config.keys.has(key) ? config.keys.get(key)! : config.dev && !key ? "dev" : null;
      if (tenantId === null) return null;
      const userId = userOf(new Uint8Array(await req.arrayBuffer()));
      return userId === "" ? null : { tenantId, userId };
    },
    // A released user's connections close, as on a forget (D108).
    onReleased: (scope) => sources.userSources?.forget(scope),
  });
  if (persist instanceof SharedFrozenDisk) {
    // Store copies past the 7-day bound, in buckets this machine and child own (the bucket's lifecycle rule is the
    // backstop): every six hours, a listing of the store's keys.
    setInterval(() => void persist.sweepStore(Date.now(), ops.ownsInStore), 6 * 3_600_000).unref();
  }
  const handler = ops.wrap(createHandler(partner, config, sources.userSources, tenants));
  const fetch = local ? localBoundary(handler, () => server.port!, config.keys.keys().next().value!) : handler;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: config.port,
    hostname: config.host,
    // D100: Bun's default is 128 MB; the handler's content-length check cannot see chunked bodies, this cap can.
    maxRequestBodySize: config.maxBodyBytes,
    fetch,
    // `Ops.wrap` answers a throw itself; this is the backstop for anything Bun raises around it (never a 500, R1).
    error: serveError,
  });
  // Stop on SIGTERM/SIGINT with the source map's last outcome batch written. Without a handler a container's PID 1
  // ignores SIGTERM (`docker stop` waited 10 s, then SIGKILL), and a router child died by the signal, batch unwritten.
  // Installed before the listening line: whoever waits for that line may signal at once.
  // D992: a drain, in the grace's budget (`EDEN_SHUTDOWN_GRACE_MS`, the router kills a child past it): /readyz turns
  // 503, in-flight requests finish (40%), live users are written (30%), store writes settle (the rest).
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    ops.draining = true;
    // A router child's router drains for it; one process behind Caddy or a load balancer waits for them to look.
    if (!config.child && (config.drainDelayMs ?? 0) > 0) await Bun.sleep(config.drainDelayMs!);
    partner.stopSync();
    await Promise.race([server.stop(false), Bun.sleep(grace * 0.4)]);
    void server.stop(true);
    // D425: users still live are written as frozen ones (the rest re-sync).
    if (persist) {
      const t0 = performance.now();
      const n = partner.persistLive(grace * 0.3);
      // Only when it wrote something: a router's failed start stops its children, whose lines would bury the cause.
      if (n > 0)
        console.error(`eden: persisted ${n} live users at shutdown in ${Math.round(performance.now() - t0)} ms`);
      if (persist instanceof SharedFrozenDisk) {
        const left = await persist.settle(Math.max(250, grace * 0.3 - 250));
        if (left > 0) console.error(`eden: ${left} store writes unfinished at shutdown: those users re-sync`);
      }
    }
    flushPersistReport();
    try {
      sourceMap.close();
    } catch (e) {
      console.error(`eden: source map not closed cleanly: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // A closed terminal (or a supervisor that sends it) would otherwise kill the process with its batches unwritten.
  process.on("SIGHUP", shutdown);
  if (local) void watchLocalInput(shutdown);
  const startupMs = Math.round(performance.now() - started);
  const keys = Object.keys(engine);
  console.log(
    `eden partner listening on http://${server.hostname}:${server.port}${config.dev ? " (dev, no auth)" : ""}` +
      ` (startup ${startupMs} ms; model roles ${process.env.OPENROUTER_API_KEY ? "on" : "off (no OPENROUTER_API_KEY)"}` +
      `; sources ${sources.shared} shared${sources.userSources ? " + per user (EDEN_USER_SOURCES_FILE)" : ""}` +
      `${keys.length > 0 ? `; engine settings: ${keys.join(", ")}` : ""}` +
      (persist
        ? `; frozen users persisted, encrypted (${persist.count} on disk, cap ${mb(config.persist!.maxBytes)} MB` +
          `${persist instanceof SharedFrozenDisk ? `, mirrored to s3://${config.persist!.store!.bucket}` : ""}, D991)`
        : "; frozen users NOT persisted (EDEN_PERSIST=off or dev mode): a restart re-reads every user's sources") +
      (child
        ? `; router child ${child.index} of ${child.count}, per-tenant caps divided by ${child.count}:` +
          ` $${round(models.usdPerTenantDay / child.count)}/day,` +
          ` ${round(config.tenantRatePerSec)} rps, burst ${round(config.tenantBurst)}`
        : "") +
      ")",
  );
  if (local && !stopping) {
    process.stdout.write(`EDEN_LOCAL_READY ${server.port}\n`);
    setTimeout(warmGate, 0).unref();
  }
  if (child) {
    // The router waits for this port before it routes here; the IPC channel exists only when the router spawned us.
    process.send?.({ edenListening: server.port });
    // The router is gone (killed, crashed): nothing can reach this child any more, so it must not outlive it.
    process.on("disconnect", shutdown);
  }
}

/**
 * The encrypted store of frozen users (D425), or null when not configured. One process with no router deletes the
 * directories a router's children wrote first (their users re-sync). Problems are reported by reason and count only,
 * a line a minute at most, never a name, id or the key.
 */
async function persistStore(config: ServerConfig): Promise<EncryptedFrozenDisk | SharedFrozenDisk | null> {
  const p = config.persist;
  if (!p) return null;
  const child = config.child ?? { index: 0, count: 1 };
  // The layout before D992 (a directory per process); a router does this before starting its children.
  if (!config.child) prunePersistDirs(p.dir);
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
  const options = {
    dir: p.dir,
    key: p.key.bytes(),
    maxBytes: p.maxBytes,
    // The cap on a file's own expiry (its newest item's, D428): the cache's longest time to live (synced, 7 days).
    maxAgeMs: DEFAULT_CACHE_LIMITS.syncTtlMs,
    report,
    // D992: one directory per machine; this child reads only the buckets it serves.
    owns: childOwns(child.index, child.count),
    // D1071: a key that opens none of the users on disk stops the start, unless the operator asked to discard them.
    refuseForeignKey: !p.discard,
  };
  // A mistyped key on an upgrade would otherwise delete every persisted user (R1's smoke): exit 2, nothing deleted.
  const refused = (what: string) =>
    new Error(
      `EDEN_PERSIST_KEY ${what} (a mistyped or changed key?): set the key they were written with, or ` +
        "EDEN_PERSIST_DISCARD=1 to discard them and start (D1071)",
    );
  let store: EncryptedFrozenDisk | SharedFrozenDisk;
  try {
    store = makeStore();
  } catch (e) {
    if (e instanceof PersistKeyMismatch) throw refused(`opens none of the ${e.foreign} persisted users in ${p.dir}`);
    throw e;
  }
  if (store instanceof SharedFrozenDisk) {
    // In a cluster the local files were emptied (the store is the copy of record): the store's key marker decides,
    // or a sample of its blobs before there is one (D1071). A store that fails or hangs does not block the start.
    const { verdict, sampled, foreign } = await store.verifyStoreKey(p.discard === true);
    if (verdict === "foreign") {
      throw refused(
        sampled > 0
          ? `opens none of the ${foreign} persisted users sampled from the store`
          : "is not the key the store's persisted users were written with (its key marker)",
      );
    }
    if (verdict === "discarded") {
      console.error(
        "eden: EDEN_PERSIST_DISCARD=1: the store's users were written with another key; they are no longer read and " +
          "go with the store's 7-day age sweep (D1071)",
      );
    }
    if (verdict === "unknown") console.error("eden: the store did not answer the key check in time; starting (D1071)");
  }
  const byKey = counts.get("discarded (key)") ?? 0;
  if (byKey > 0) {
    console.error(
      `eden: ${p.discard ? "EDEN_PERSIST_DISCARD=1: " : ""}discarded ${byKey} persisted users written with ` +
        "another key; they re-sync from their sources (D1071)",
    );
  }
  flush();
  setInterval(flush, 60_000).unref();
  flushPersistReport = flush;
  return store;

  function makeStore(): EncryptedFrozenDisk | SharedFrozenDisk {
    return p!.store
      ? // In a cluster the store is the copy of record: local files left from before this start may be older than what
        // another machine wrote since, so this child's are deleted first (D992).
        new SharedFrozenDisk({
          ...options,
          startEmpty: true,
          store: new S3BlobStore(p!.store),
          prefix: p!.store.prefix,
        })
      : new EncryptedFrozenDisk(options);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}

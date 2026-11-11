/**
 * Server configuration, from the environment. Validated at startup: a bad value stops the server with a message
 * naming it, rather than surfacing later as a confusing request failure.
 *
 * EDEN_API_KEYS      tenant keys, "tenantA:key1,tenantB:key2". Required unless EDEN_DEV=1.
 * EDEN_DEV=1         accept unauthenticated requests as tenant "dev" (local development only).
 * PORT, HOST         default 8790 on 127.0.0.1.
 * EDEN_SOURCE_MAP    path of the source-map database; default $EDEN_HOME/source-map.db.
 * OPENROUTER_API_KEY turns on the default's model roles (cards, intent, the ask-time reader; models.ts, D112);
 *                    without it the same default runs with no model at all.
 * EDEN_MODEL         the roles' model, default anthropic/claude-haiku-5.5 through OpenRouter (D12's routing).
 * EDEN_MODEL_USD_PER_TENANT_DAY one cap on a tenant's model spend per UTC day, across roles; default 25.
 * EDEN_TENANT_RPS    requests per second per tenant on the HTTP API (GCRA), default 200; EDEN_TENANT_BURST, 400.
 *                    The stdio MCP server (mcp-stdio.ts) serves one local user and is not limited.
 * EDEN_GATE_WORKERS  workers that redact lookup results off the event loop (D25, D26); default 0, on the loop.
 * EDEN_QUERY_PLANNER the query planner chooses what each lookup sends to each connector (D28), on by default (D33):
 *                    1 (default) serves through it; "shadow" serves without it and runs it beside, learning and
 *                    reporting only; 0 turns it off.
 * EDEN_ENGINE_CONFIG path of a JSON file of engine settings over the default (D103, engine-config.ts); unset,
 *                    the default exactly (D112).
 * EDEN_SOURCES_FILE  static documents shared by every user (connectors.ts); EDEN_USER_SOURCES_FILE each user's own
 *                    sources, MCP connections with their own credentials included (user-sources.ts, D108). Both are
 *                    read and checked at startup by `sourcesFromEnv`, not here.
 * EDEN_MAX_BODY_BYTES largest request body the HTTP API reads, default 8 MB (8,388,608, D100): above the ~6 MB worst
 *                    case of a valid event, far below Bun's 128 MB default. Larger bodies get 413.
 * EDEN_PROCESSES     server processes behind the router (router.ts, D113, D163), 1-64; default the core count
 *                    (`machineCores`: `os.availableParallelism()`, lowered to a cgroup v2 CPU quota, capped at 64;
 *                    D172's gate passed, D178), which is 1, one process and no router, on a one-core machine. 1
 *                    serves in this process with no router. Above 1, each tenant/user is pinned to one child, each
 *                    child keeps its own source-map file (`childSourceMapPath`), and each divides the per-tenant
 *                    caps (rate, burst, model spend) by N: a tenant concentrated on few users needs higher caps or 1.
 * EDEN_ROUTER_CHILD  set by the router only ("i/N"): this process is child i of N.
 * EDEN_PERSIST_KEY   required (D991; D425 made persistence opt-in, D991 makes it the default): users frozen while
 *                    idle (D325) are also written to disk, encrypted (AES-256-GCM) with this key (32 bytes, as 64 hex
 *                    digits or base64; never logged), so a restart thaws them instead of re-reading every source.
 *                    Startup stops without it, unless EDEN_PERSIST=off (the operator's explicit choice) or EDEN_DEV=1
 *                    (local, no real users: off unless the key is set). The key is never generated here: one stored
 *                    beside the files would protect nothing.
 * EDEN_PERSIST       "off" turns persistence off (a restart re-reads every user's sources); unset or "on", on.
 * EDEN_PERSIST_DISCARD "1": start even when EDEN_PERSIST_KEY opens none of the persisted users, discarding them (a
 *                    key changed on purpose, D1071); unset, such a start stops with exit 2 and deletes nothing.
 * EDEN_PERSIST_FROZEN_DIR where the files go, default $EDEN_HOME/frozen. Each process writes its own subdirectory
 *                    (`<i>-of-<N>`).
 * EDEN_PERSIST_MAX_MB the directory's cap (MB, across processes; default the machine's memory, at least 4,096: what
 *                    every user a box can hold needs, `defaultPersistMb`). A freeze past it is not written.
 * EDEN_PERSIST_STORE s3://bucket/prefix (D992): frozen users mirrored to an S3-compatible store every machine of a
 *                    cluster reaches (blob-store.ts: EDEN_S3_ENDPOINT, _REGION, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY).
 * EDEN_CLUSTER_KEY   the cluster router's membership messages (D992), 24+ characters, the same on every machine;
 *                    EDEN_CLUSTER_SIZE the machine count, which divides the tenant's spend cap with N (D993).
 * EDEN_NODES, EDEN_NODES_FILE  this process is the cluster router over those machines (cluster.ts); it holds no users.
 * EDEN_SHUTDOWN_GRACE_MS a stop's budget (default 10,000, D994); EDEN_DRAIN_DELAY_MS how long a draining process keeps
 *                    serving after /readyz turned 503 (default 0; 5,000 behind Caddy or a load balancer).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { edenHome, isId, scopeKey } from "@eden/protocol";
import { type StoreConfig, storeConfig } from "./blob-store";

export interface ServerConfig {
  port: number;
  host: string;
  /** API key → tenant id. */
  keys: Map<string, string>;
  dev: boolean;
  sourceMapPath: string;
  /** Requests per second per tenant, sustained and burst (EDEN_TENANT_RPS, EDEN_TENANT_BURST). */
  tenantRatePerSec: number;
  tenantBurst: number;
  /** Workers in the gate pool (EDEN_GATE_WORKERS); 0 gates on the event loop. */
  gateWorkers: number;
  /** The query planner (EDEN_QUERY_PLANNER): "serve" by default (D33), "shadow" or "off". */
  queryPlanner: "off" | "serve" | "shadow";
  /** Largest request body the HTTP API reads (EDEN_MAX_BODY_BYTES); 8 MB by default (D100). */
  maxBodyBytes: number;
  /**
   * Server processes behind the router (EDEN_PROCESSES, D163); the core count when unset (D178), capped at
   * MAX_PROCESSES. 1 serves in this process with no router; a router child is always 1.
   */
  processes: number;
  /**
   * Set when the router started this process (EDEN_ROUTER_CHILD): it is child `index` of `count`. The tenant rate and
   * burst above are already divided by `count`; `buildPartner`'s `processes` divides the model spend cap.
   */
  child: { index: number; count: number } | null;
  /**
   * D425, on by default since D991 (EDEN_PERSIST_KEY): where frozen users are written, encrypted; null with
   * EDEN_PERSIST=off (or dev mode with nothing set). `maxBytes` is the whole directory's; a router child gets 1/N of
   * it. `store` (D992, EDEN_PERSIST_STORE): an S3-compatible store every machine of a cluster reaches.
   */
  persist?: {
    dir: string;
    key: PersistKey;
    maxBytes: number;
    store?: StoreConfig | null;
    /**
     * EDEN_PERSIST_DISCARD=1 (D1071): start even when the key opens none of the persisted users, discarding them
     * (a key rotated on purpose). Unset, such a start stops with exit 2 and deletes nothing.
     */
    discard?: boolean;
  } | null;
  /**
   * D992: this machine in a cluster. `key` (EDEN_CLUSTER_KEY, 24+ characters) authenticates the cluster router's
   * membership messages (`/internal/cluster`); `size` (EDEN_CLUSTER_SIZE, the machines) divides the tenant's model
   * spend cap with the child count, as D163 divides it by N. Both unset on a single machine.
   */
  cluster?: { key: string | null; size: number };
  /**
   * A shutdown's whole budget (EDEN_SHUTDOWN_GRACE_MS, default 10 s, D992): in-flight requests finish, live users are
   * written, store writes settle, then the process exits; the router kills a child still running after it. Give the
   * container more (`docker stop -t 30`, compose `stop_grace_period: 30s`).
   */
  shutdownGraceMs?: number;
  /**
   * How long a draining process keeps serving after /readyz turned 503 (EDEN_DRAIN_DELAY_MS, default 0, D994): the
   * time a load balancer or Caddy takes to see it and stop sending. Without it a request on a kept-alive connection
   * can meet the closing listener (a 502 at Caddy, which does not retry a POST). The grace counts from after it.
   */
  drainDelayMs?: number;
}

/**
 * The persistence key (D425), held so it cannot reach a log by accident: JSON, `String` and `console.log` of it say
 * "[redacted]"; only `bytes()` gives the key.
 */
export class PersistKey {
  readonly #bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  bytes(): Uint8Array {
    return this.#bytes;
  }
  toJSON(): string {
    return "[redacted]";
  }
  toString(): string {
    return "[redacted]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "PersistKey [redacted]";
  }
}

/** The header the router puts on a fan-out's copies to children that do not own the user (not counted, D326). */
export const FANOUT_COPY = "x-eden-fanout-copy";

/** Most server processes the router starts (EDEN_PROCESSES); far above any core count the router helps on. */
export const MAX_PROCESSES = 64;

/**
 * 8 MB (D100). The largest valid event holds one 1,000,000-unit text field; sent as `\uXXXX` escapes that is ~6 MB of
 * JSON, so every valid event fits and only padded bodies are refused.
 */
export const DEFAULT_MAX_BODY_BYTES = 8_388_608;

/**
 * `cores` is the machine's core count, a parameter so tests can pin it; the default reads it at call time
 * (`machineCores`).
 */
/**
 * Variables of deleted trials (D817): set, they stop startup, as a removed `EDEN_ENGINE_CONFIG` key does (D103),
 * rather than being ignored while the operator believes the trial still runs.
 */
export const RETIRED_ENV: Record<string, string> = {
  EDEN_SPEND_LEASES: "D817 deleted the spend leases: each child holds 1/N of the tenant's daily cap (D163)",
  EDEN_PERSIST_DISK_ONLY: "D817 deleted disk-only frozen users: a frozen user's blob stays in memory as well",
};

export function loadConfig(env = process.env, cores = machineCores(), memoryBytes = machineMemory()): ServerConfig {
  for (const [name, why] of Object.entries(RETIRED_ENV)) {
    if (env[name]) throw new Error(`${name} is no longer read (${why}): unset it`);
  }
  const port = Number(env.PORT ?? 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`PORT must be a port number, got ${env.PORT}`);
  const dev = env.EDEN_DEV === "1";
  const keys = new Map<string, string>();
  for (const pair of (env.EDEN_API_KEYS ?? "").split(",").filter(Boolean)) {
    // The tenant ends at the first ":"; the key is everything after it, so a key may itself hold ":".
    const colon = pair.indexOf(":");
    const tenant = colon < 0 ? "" : pair.slice(0, colon);
    const key = colon < 0 ? "" : pair.slice(colon + 1);
    if (!tenant || !key || key.length < 16) throw new Error("EDEN_API_KEYS entries must be tenant:key, keys 16+ chars");
    // Scope keys join tenant and user with "/": a tenant id holding one could alias another tenant's users.
    if (!isId(tenant)) throw new Error(`EDEN_API_KEYS tenant "${tenant}" must be 1-128 characters of [A-Za-z0-9._:@-]`);
    // One key for two tenants is a misconfiguration: refuse it rather than let the last entry win silently.
    const other = keys.get(key);
    if (other !== undefined && other !== tenant) throw new Error(`EDEN_API_KEYS lists one key for two tenants`);
    keys.set(key, tenant);
  }
  if (!dev && keys.size === 0) throw new Error("set EDEN_API_KEYS (or EDEN_DEV=1 for local development)");
  const child = routerChild(env.EDEN_ROUTER_CHILD);
  // A child serves 1/N of each tenant's users (D163), so it holds 1/N of the tenant's caps: N processes with the
  // whole cap each would raise a tenant's rate N-fold. Burst stays at least 1, the least a GCRA bucket can hold.
  const share = child?.count ?? 1;
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    keys,
    dev,
    // From the env given (a test's, the router's), not only the process's: EDEN_HOME of this env wins.
    sourceMapPath: env.EDEN_SOURCE_MAP ?? join(homeOf(env), "source-map.db"),
    tenantRatePerSec: positive(env.EDEN_TENANT_RPS, 200, "EDEN_TENANT_RPS") / share,
    tenantBurst: Math.max(1, positive(env.EDEN_TENANT_BURST, 400, "EDEN_TENANT_BURST") / share),
    gateWorkers: workers(env.EDEN_GATE_WORKERS),
    queryPlanner: plannerMode(env.EDEN_QUERY_PLANNER),
    maxBodyBytes: bodyBytes(env.EDEN_MAX_BODY_BYTES),
    // A child never starts a router of its own, whatever EDEN_PROCESSES it inherited.
    processes: child ? 1 : processCount(env.EDEN_PROCESSES, cores),
    child,
    persist: persistConfig(env, share, dev, memoryBytes),
    cluster: clusterConfig(env, persistConfigured(env)),
    shutdownGraceMs: Math.max(2_000, positive(env.EDEN_SHUTDOWN_GRACE_MS, 10_000, "EDEN_SHUTDOWN_GRACE_MS")),
    drainDelayMs: drainDelay(env.EDEN_DRAIN_DELAY_MS),
  };
}

/** The least default cap of the persistence directory (D425), MB across every process. */
export const DEFAULT_PERSIST_MAX_MB = 4_096;

/**
 * The directory's default cap (D991): the machine's memory in MB, at least `DEFAULT_PERSIST_MAX_MB`. Users per box are
 * bound by memory (2-4.4 MB of RSS a user at the 3,000-item cap, docs/research/p6-scale.md), and a user's file is
 * smaller than what it holds in memory (compact 0.8-1.2 MB, warm 1.8-2.7 MB at the cap): so a cap of the memory's size
 * holds a file for every user the box can serve, warm ones written at shutdown included. 4,096 MB (the old default)
 * was past at about 3,400 prose users, which a 16 GB box holds (D863).
 */
export function defaultPersistMb(memoryBytes: number): number {
  const mb = Number.isFinite(memoryBytes) && memoryBytes > 0 ? Math.floor(memoryBytes / 1_048_576) : 0;
  return Math.max(DEFAULT_PERSIST_MAX_MB, mb);
}

const NO_KEY =
  "EDEN_PERSIST_KEY is not set: idle users are persisted to disk, encrypted, by default (D991). Set it to 32 random " +
  "bytes kept in your secret store (openssl rand -hex 32), or set EDEN_PERSIST=off to re-read every user's sources " +
  "after each restart";

/**
 * Persistence (D425, the default since D991): on unless EDEN_PERSIST=off, and then the operator's key is required;
 * EDEN_DEV=1 with no persistence variable set is off (local, no real users). The key's own value is never in a message.
 * A child's cap is its 1/N share (`share`) of EDEN_PERSIST_MAX_MB.
 */
function persistConfig(env: NodeJS.ProcessEnv, share: number, dev: boolean, memoryBytes: number) {
  // The cluster router (D992, EDEN_NODES) holds no user: nothing of its own to persist.
  if (env.EDEN_NODES || env.EDEN_NODES_FILE) return null;
  const mode = env.EDEN_PERSIST ?? "";
  if (!["", "on", "off"].includes(mode)) throw new Error(`EDEN_PERSIST must be "on" or "off", got ${mode}`);
  const dir = env.EDEN_PERSIST_FROZEN_DIR ?? "";
  const raw = env.EDEN_PERSIST_KEY ?? "";
  const max = env.EDEN_PERSIST_MAX_MB ?? "";
  const discard = env.EDEN_PERSIST_DISCARD ?? "";
  if (!["", "0", "1"].includes(discard)) throw new Error(`EDEN_PERSIST_DISCARD must be 1 or unset, got ${discard}`);
  if (mode === "off") {
    if (env.EDEN_PERSIST_STORE) throw new Error("EDEN_PERSIST_STORE needs persistence: remove EDEN_PERSIST=off");
    if (dir !== "" || raw !== "" || max !== "" || discard === "1") {
      throw new Error(
        "EDEN_PERSIST=off with EDEN_PERSIST_FROZEN_DIR, _KEY, _MAX_MB or _DISCARD set: remove them, or the =off",
      );
    }
    return null;
  }
  if (raw === "") {
    if (dev && mode === "" && dir === "" && max === "") return null;
    throw new Error(NO_KEY);
  }
  const key = persistKey(raw);
  if (key === null) {
    throw new Error("EDEN_PERSIST_KEY must be 32 random bytes as 64 hex digits or base64 (e.g. openssl rand -hex 32)");
  }
  const mb = positive(max === "" ? undefined : max, defaultPersistMb(memoryBytes), "EDEN_PERSIST_MAX_MB");
  return {
    dir: dir === "" ? join(homeOf(env), "frozen") : dir,
    key: new PersistKey(key),
    maxBytes: Math.floor((mb * 1_048_576) / share),
    store: storeConfig(env),
    discard: discard === "1",
  };
}

/**
 * EDEN_HOME of the env given, created 0700 as `edenHome` does for the process's (review of D992: a test's or a
 * router's env names its own home); the process's otherwise.
 */
function homeOf(env: NodeJS.ProcessEnv): string {
  if (!env.EDEN_HOME) return edenHome();
  mkdirSync(env.EDEN_HOME, { recursive: true, mode: 0o700 });
  return env.EDEN_HOME;
}

/** Whether persistence is on for this env (the same rule as `persistConfig`, without its checks). */
function persistConfigured(env: NodeJS.ProcessEnv): boolean {
  if (env.EDEN_NODES || env.EDEN_NODES_FILE || env.EDEN_PERSIST === "off") return false;
  return Boolean(env.EDEN_PERSIST_KEY);
}

/** EDEN_DRAIN_DELAY_MS: 0-60,000 ms, default 0. */
function drainDelay(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 60_000) throw new Error(`EDEN_DRAIN_DELAY_MS must be 0-60000, got ${raw}`);
  return n;
}

/** EDEN_CLUSTER_KEY and EDEN_CLUSTER_SIZE (D992); the key's value is never in a message. */
function clusterConfig(env: NodeJS.ProcessEnv, persisting: boolean): { key: string | null; size: number } {
  const key = env.EDEN_CLUSTER_KEY ?? "";
  if (key !== "" && key.length < 24) throw new Error("EDEN_CLUSTER_KEY must be 24+ characters (openssl rand -hex 24)");
  // A cluster node that persists to its own disk only would keep stale blobs of users it released and read them back
  // if they returned (review of D992): a node needs the shared store, or no persistence at all.
  const router = Boolean(env.EDEN_NODES || env.EDEN_NODES_FILE);
  if (key !== "" && !router && persisting && !env.EDEN_PERSIST_STORE) {
    throw new Error(
      "a cluster node (EDEN_CLUSTER_KEY) that persists needs EDEN_PERSIST_STORE, the store every node reaches",
    );
  }
  const size = positive(env.EDEN_CLUSTER_SIZE, 1, "EDEN_CLUSTER_SIZE");
  if (!Number.isInteger(size) || size > 1_000) throw new Error("EDEN_CLUSTER_SIZE must be a whole number, 1-1000");
  return { key: key === "" ? null : key, size };
}

/** 64 hex digits or base64 of exactly 32 bytes; null otherwise (a key of all one byte too: a placeholder). */
function persistKey(raw: string): Uint8Array | null {
  const s = raw.trim();
  let bytes: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) bytes = Buffer.from(s, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) bytes = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes === null || bytes.length !== 32 || bytes.every((b) => b === bytes![0])) return null;
  return new Uint8Array(bytes);
}

/**
 * Child `index`'s source-map file (D163): `source-map.db` becomes `source-map.<index>.db`, a path without `.db` gets
 * `.<index>` appended. One SQLite file per process, as `SourceMap` assumes (graph/src/source-map.ts): N writers on
 * one file would wait on its lock and drop outcome batches on SQLITE_BUSY. Safe to split because each user is pinned
 * to one child and every row is keyed by scope. An in-memory map stays in memory.
 */
export function childSourceMapPath(base: string, index: number): string {
  if (base === "" || base === ":memory:") return base;
  return base.endsWith(".db") ? `${base.slice(0, -3)}.${index}.db` : `${base}.${index}`;
}

/**
 * EDEN_PROCESSES as a whole number 1-64; the core count when unset or empty (D178: the router over N children
 * measured 3.26x one process on 4 cores, D172's bar), at least 1 and at most MAX_PROCESSES.
 */
function processCount(raw: string | undefined, cores: number): number {
  if (raw === undefined || raw === "") {
    return Math.min(Math.max(1, Number.isInteger(cores) ? cores : 1), MAX_PROCESSES);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PROCESSES) {
    throw new Error(`EDEN_PROCESSES must be a whole number 1-${MAX_PROCESSES}, got ${raw}`);
  }
  return n;
}

/**
 * The cores this process may use, the default process count (D178). `availableParallelism()` already honours CPU
 * affinity and a cgroup v1 CFS quota on Bun 1.4.4 (measured on 4 cores: `taskset -c 0` gave 1; a v1 quota of 1 CPU
 * gave 1, 2.5 CPUs 2, 0.5 CPU 1), but a cgroup v2 `cpu.max` could not be checked on a v1 host, so it is read here too
 * and the lower count wins: a container with a 1-CPU quota on a 32-core node must not start 32 children (~68 MB
 * idle each).
 */
export function machineCores(read: (path: string) => string | null = readOrNull): number {
  const quota = cgroupCpuQuota(read);
  return quota === null ? availableParallelism() : Math.min(availableParallelism(), quota);
}

/**
 * Whole CPUs allowed by a cgroup v2 `cpu.max` ("<quota> <period>", or "max <period>" for none) on this process's
 * cgroup or any ancestor up to the mount root, floored and at least 1 (as Bun rounds a v1 quota); null when none is
 * set or nothing can be read (cgroup v1, no /sys/fs/cgroup, another OS). Walking up covers a container whose
 * /proc/self/cgroup names a host path while its own cgroup is mounted at /sys/fs/cgroup itself.
 */
export function cgroupCpuQuota(read: (path: string) => string | null): number | null {
  const line = (read("/proc/self/cgroup") ?? "").split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) return null;
  const parts = line.slice(3).trim().split("/").filter(Boolean);
  let least: number | null = null;
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = parts.slice(0, depth).join("/");
    const raw = read(dir === "" ? "/sys/fs/cgroup/cpu.max" : `/sys/fs/cgroup/${dir}/cpu.max`);
    const m = raw === null ? null : /^(\d+)\s+(\d+)$/.exec(raw.trim());
    if (m === null || Number(m[2]) <= 0) continue;
    const cpus = Math.max(1, Math.floor(Number(m[1]) / Number(m[2])));
    least = least === null ? cpus : Math.min(least, cpus);
  }
  return least;
}

/**
 * The memory this process may use, in bytes (D991, for the persistence directory's default cap): the machine's total,
 * lowered to a cgroup limit where one is visible (v2 `memory.max`, v1 `memory.limit_in_bytes`; "max" and v1's huge
 * "no limit" value are no limit). Not exact for every orchestrator: EDEN_PERSIST_MAX_MB overrides it.
 */
export function machineMemory(read: (path: string) => string | null = readOrNull, total = totalmem()): number {
  let least = total;
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    const raw = read(path)?.trim() ?? "";
    if (!/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (n > 0 && n < least) least = n;
  }
  return least;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** EDEN_ROUTER_CHILD ("i/N", set by the router) as this child's index and count; null when unset. */
function routerChild(raw: string | undefined): ServerConfig["child"] {
  if (raw === undefined || raw === "") return null;
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!(count >= 1 && count <= MAX_PROCESSES && index >= 0 && index < count)) {
    throw new Error(`EDEN_ROUTER_CHILD must be i/N with 0 <= i < N <= ${MAX_PROCESSES}, got ${raw}`);
  }
  return { index, count };
}

/**
 * Where the stdio MCP server (one user per process) keeps its source map: EDEN_SOURCE_MAP when set, as for the HTTP
 * server, else one file per tenant/user under $EDEN_HOME/mcp-stdio. Rows inside are keyed by scope either way, as
 * the HTTP server's are; the file per user keeps two users' processes from contending for one SQLite writer. The name
 * is a hash of the scope key, since ids may hold "." and ".." would leave the directory. Both the override and the
 * home come from `env`; with no EDEN_HOME there, edenHome()'s default applies.
 */
export function stdioSourceMapPath(tenantId: string, userId: string, env = process.env): string {
  if (env.EDEN_SOURCE_MAP) return env.EDEN_SOURCE_MAP;
  // `env`'s EDEN_HOME, not process.env's (which edenHome() reads), so a caller passing an env gets that home.
  const dir = join(env.EDEN_HOME || edenHome(), "mcp-stdio");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(scopeKey({ tenantId, userId })).digest("hex").slice(0, 32);
  return join(dir, `${name}.source-map.db`);
}

/** EDEN_QUERY_PLANNER's value as a planner mode; throws on anything else. */
export function plannerMode(raw: string | undefined): ServerConfig["queryPlanner"] {
  if (raw === "0") return "off";
  if (raw === undefined || raw === "" || raw === "1") return "serve";
  if (raw === "shadow") return "shadow";
  throw new Error(`EDEN_QUERY_PLANNER must be 0, 1 or shadow, got ${raw}`);
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
  return n;
}

/** EDEN_MAX_BODY_BYTES as a positive whole number of bytes; 8 MB when unset (D100). */
function bodyBytes(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MAX_BODY_BYTES;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`EDEN_MAX_BODY_BYTES must be a positive integer, got ${raw}`);
  return n;
}

/**
 * Default 0 (D26): on the real engine with realistic source latency the pool was neutral in steady state and cost
 * more CPU. Deployments whose sources return large or keyword-dense items may gain; more than cores − 1 never helps.
 */
function workers(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 64) throw new Error(`EDEN_GATE_WORKERS must be 0-64, got ${raw}`);
  return n;
}

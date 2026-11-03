/**
 * Server configuration, from the environment. Validated at startup: a bad value stops the server with a message
 * naming it, rather than surfacing later as a confusing request failure.
 *
 * EDEN_API_KEYS      tenant keys, "tenantA:key1,tenantB:key2". Required unless EDEN_DEV=1.
 * EDEN_DEV=1         accept unauthenticated requests as tenant "dev" (local development only).
 * PORT, HOST         default 8790 on 127.0.0.1.
 * EDEN_SOURCE_MAP    path of the source-map database; default $EDEN_HOME/source-map.db.
 * OPENROUTER_API_KEY enables the model; without it the engine runs with no model at all.
 * EDEN_MODEL         default z-ai/glm-5.3-flash.
 * EDEN_TENANT_RPS    requests per second per tenant on the HTTP API (GCRA), default 200; EDEN_TENANT_BURST, 400.
 *                    The stdio MCP server (mcp-stdio.ts) serves one local user and is not limited.
 * EDEN_GATE_WORKERS  workers that redact lookup results off the event loop (D25, D26); default 0, on the loop.
 * EDEN_QUERY_PLANNER the query planner chooses what each lookup sends to each connector (D28), on by default (D33):
 *                    1 (default) serves through it; "shadow" serves without it and runs it beside, learning and
 *                    reporting only; 0 turns it off.
 * EDEN_ASK_MODEL=1   ask answers are rewritten as prose by the model; off by default, the cited items are returned
 *                    as they are (D43).
 * EDEN_ENGINE_CONFIG path of a JSON file of engine settings over the production defaults (D103, engine-config.ts);
 *                    unset, the defaults exactly (D12).
 * EDEN_SOURCES_FILE  static documents shared by every user (connectors.ts); EDEN_USER_SOURCES_FILE each user's own
 *                    sources, MCP connections with their own credentials included (user-sources.ts, D108). Both are
 *                    read and checked at startup by `sourcesFromEnv`, not here.
 * EDEN_MAX_BODY_BYTES largest request body the HTTP API reads, default 8 MB (8,388,608, D100): above the ~6 MB worst
 *                    case of a valid event, far below Bun's 128 MB default. Larger bodies get 413.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { edenHome, isId, scopeKey } from "@eden/protocol";

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
  /** Whether ask answers are rewritten by the model (EDEN_ASK_MODEL=1); off by default (D43). */
  askWithModel: boolean;
  /** Largest request body the HTTP API reads (EDEN_MAX_BODY_BYTES); 8 MB by default (D100). */
  maxBodyBytes: number;
}

/**
 * 8 MB (D100). The largest valid event holds one 1,000,000-unit text field; sent as `\uXXXX` escapes that is ~6 MB of
 * JSON, so every valid event fits and only padded bodies are refused.
 */
export const DEFAULT_MAX_BODY_BYTES = 8_388_608;

export function loadConfig(env = process.env): ServerConfig {
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
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    keys,
    dev,
    sourceMapPath: env.EDEN_SOURCE_MAP ?? join(edenHome(), "source-map.db"),
    tenantRatePerSec: positive(env.EDEN_TENANT_RPS, 200, "EDEN_TENANT_RPS"),
    tenantBurst: positive(env.EDEN_TENANT_BURST, 400, "EDEN_TENANT_BURST"),
    gateWorkers: workers(env.EDEN_GATE_WORKERS),
    queryPlanner: plannerMode(env.EDEN_QUERY_PLANNER),
    askWithModel: askModel(env.EDEN_ASK_MODEL),
    maxBodyBytes: bodyBytes(env.EDEN_MAX_BODY_BYTES),
  };
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

/** EDEN_ASK_MODEL's value: "1" turns model-composed ask answers on (D43), unset or "0" leaves them off. */
export function askModel(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`EDEN_ASK_MODEL must be 0 or 1, got ${raw}`);
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

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
 */
import { join } from "node:path";
import { edenHome, isId } from "@eden/protocol";

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
}

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
    askWithModel: env.EDEN_ASK_MODEL === "1",
  };
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

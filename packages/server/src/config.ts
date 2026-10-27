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
 */
import { join } from "node:path";
import { edenHome } from "@eden/protocol";

export interface ServerConfig {
  port: number;
  host: string;
  /** API key → tenant id. */
  keys: Map<string, string>;
  dev: boolean;
  sourceMapPath: string;
}

export function loadConfig(env = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`PORT must be a port number, got ${env.PORT}`);
  const dev = env.EDEN_DEV === "1";
  const keys = new Map<string, string>();
  for (const pair of (env.EDEN_API_KEYS ?? "").split(",").filter(Boolean)) {
    const [tenant, key] = pair.split(":");
    if (!tenant || !key || key.length < 16) throw new Error("EDEN_API_KEYS entries must be tenant:key, keys 16+ chars");
    keys.set(key, tenant);
  }
  if (!dev && keys.size === 0) throw new Error("set EDEN_API_KEYS (or EDEN_DEV=1 for local development)");
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    keys,
    dev,
    sourceMapPath: env.EDEN_SOURCE_MAP ?? join(edenHome(), "source-map.db"),
  };
}

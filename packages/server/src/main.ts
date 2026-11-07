#!/usr/bin/env bun
/**
 * Starts the partner's HTTP API. `bun run dev` from the repo root. With EDEN_PROCESSES above 1 this process is the
 * router (router.ts, D163) and each of its children runs this file again as one server process (EDEN_ROUTER_CHILD).
 */
import { warmGate } from "@eden/redact";
import { loadConfig, type ServerConfig } from "./config";
import { sourcesOrExit } from "./connectors";
import { buildPartner, startGatePool, startIngestPool } from "./build";
import { engineConfig } from "./engine-config";
import { createHandler } from "./http";
import { modelRolesFromEnv } from "./models";
import { rehomeSourceMaps, runRouter } from "./router";

const started = performance.now();
const config = loadConfig();
if (config.processes > 1) {
  await runRouter(config);
} else {
  await serve(config);
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
  // Per-user sources when EDEN_USER_SOURCES_FILE is set (D108); forget closes their connections. Before the gate
  // pool, so a bad sources file exits 2 with its message before any worker starts.
  const sources = sourcesOrExit();
  const gatePool = await startGatePool(config.gateWorkers);
  // Trial `ingestWorker` (D216): one worker per process redacts and reads source pages off the event loop.
  const ingestPool = engine.ingestWorker ? await startIngestPool(1) : undefined;
  const models = modelRolesFromEnv();
  const partner = buildPartner({
    gatePool,
    ingestPool,
    sources: sources.resolver,
    sourceMapPath: config.sourceMapPath,
    queryPlanner: config.queryPlanner,
    engine,
    // Cards, intent and the reader on OPENROUTER_API_KEY's model (D112); without a key, the default's no-model path.
    models,
    // A router child holds 1/N of each tenant's daily model spend (D163).
    processes: config.child?.count ?? 1,
    onShadow: process.env.EDEN_TRACE === "1" ? (r) => console.log(JSON.stringify({ shadow: r })) : undefined,
    onTrace: process.env.EDEN_TRACE === "1" ? (t) => console.log(JSON.stringify(t)) : undefined,
  });
  // The secret gate compiles its rules on first use; doing it here keeps that stall off the first request.
  warmGate();
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    // D100: Bun's default is 128 MB; the handler's content-length check cannot see chunked bodies, this cap can.
    maxRequestBodySize: config.maxBodyBytes,
    fetch: createHandler(partner, config, sources.userSources),
  });
  const startupMs = Math.round(performance.now() - started);
  const keys = Object.keys(engine);
  const child = config.child;
  console.log(
    `eden partner listening on http://${server.hostname}:${server.port}${config.dev ? " (dev, no auth)" : ""}` +
      ` (startup ${startupMs} ms; model roles ${process.env.OPENROUTER_API_KEY ? "on" : "off (no OPENROUTER_API_KEY)"}` +
      `; sources ${sources.shared} shared${sources.userSources ? " + per user (EDEN_USER_SOURCES_FILE)" : ""}` +
      `${keys.length > 0 ? `; engine settings: ${keys.join(", ")}` : ""}` +
      (child
        ? `; router child ${child.index} of ${child.count}, per-tenant caps divided by ${child.count}:` +
          ` $${round(models.usdPerTenantDay / child.count)}/day, ${round(config.tenantRatePerSec)} rps,` +
          ` burst ${round(config.tenantBurst)}`
        : "") +
      ")",
  );
  if (child) {
    // The router waits for this port before it routes here; the IPC channel exists only when the router spawned us.
    process.send?.({ edenListening: server.port });
    // The router is gone (killed, crashed): nothing can reach this child any more, so it must not outlive it.
    process.on("disconnect", () => process.exit(0));
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

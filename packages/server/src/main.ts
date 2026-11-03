#!/usr/bin/env bun
/** Starts the partner's HTTP API. `bun run dev` from the repo root. */
import { warmGate } from "@eden/redact";
import { loadConfig } from "./config";
import { sourcesFromEnv } from "./connectors";
import { buildPartner, startGatePool } from "./build";
import { engineConfig } from "./engine-config";
import { createHandler } from "./http";

const started = performance.now();
const config = loadConfig();
const engine = engineConfig();
const gatePool = await startGatePool(config.gateWorkers);
// Per-user sources when EDEN_USER_SOURCES_FILE is set (D104); forget closes their connections.
const sources = sourcesFromEnv();
const partner = buildPartner({
  gatePool,
  sources: sources.resolver,
  sourceMapPath: config.sourceMapPath,
  queryPlanner: config.queryPlanner,
  // Unset unless EDEN_ASK_MODEL=1, so an EDEN_ENGINE_CONFIG `askWithModel` holds (build.ts).
  askWithModel: config.askWithModel || undefined,
  engine,
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
console.log(
  `eden partner listening on http://${server.hostname}:${server.port}${config.dev ? " (dev, no auth)" : ""}` +
    ` (startup ${startupMs} ms${keys.length > 0 ? `; engine settings: ${keys.join(", ")}` : ""})`,
);

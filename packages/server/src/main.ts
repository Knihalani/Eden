#!/usr/bin/env bun
/** Starts the partner's HTTP API. `bun run dev` from the repo root. */
import { warmGate } from "@eden/redact";
import { loadConfig } from "./config";
import { sourcesOrExit } from "./connectors";
import { buildPartner, startGatePool } from "./build";
import { engineConfig } from "./engine-config";
import { createHandler } from "./http";
import { modelRolesFromEnv } from "./models";

const started = performance.now();
const config = loadConfig();
const engine = engineConfig();
// Per-user sources when EDEN_USER_SOURCES_FILE is set (D108); forget closes their connections. Before the gate pool,
// so a bad sources file exits 2 with its message before any worker starts.
const sources = sourcesOrExit();
const gatePool = await startGatePool(config.gateWorkers);
const partner = buildPartner({
  gatePool,
  sources: sources.resolver,
  sourceMapPath: config.sourceMapPath,
  queryPlanner: config.queryPlanner,
  engine,
  // Cards, intent and the reader on OPENROUTER_API_KEY's model (D112); without a key, the default's no-model path.
  models: modelRolesFromEnv(),
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
    ` (startup ${startupMs} ms; model roles ${process.env.OPENROUTER_API_KEY ? "on" : "off (no OPENROUTER_API_KEY)"}` +
    `; sources ${sources.shared} shared${sources.userSources ? " + per user (EDEN_USER_SOURCES_FILE)" : ""}` +
    `${keys.length > 0 ? `; engine settings: ${keys.join(", ")}` : ""})`,
);

#!/usr/bin/env bun
/** Starts the partner's HTTP API. `bun run dev` from the repo root. */
import { loadConfig } from "./config";
import { staticResolver } from "./connectors";
import { buildPartner, startGatePool } from "./build";
import { createHandler } from "./http";

const config = loadConfig();
const gatePool = await startGatePool(config.gateWorkers);
const partner = buildPartner({
  gatePool,
  sources: staticResolver(process.env.EDEN_SOURCES_FILE),
  sourceMapPath: config.sourceMapPath,
  queryPlanner: config.queryPlanner,
  askWithModel: config.askWithModel,
  onShadow: process.env.EDEN_TRACE === "1" ? (r) => console.log(JSON.stringify({ shadow: r })) : undefined,
  onTrace: process.env.EDEN_TRACE === "1" ? (t) => console.log(JSON.stringify(t)) : undefined,
});
const server = Bun.serve({ port: config.port, hostname: config.host, fetch: createHandler(partner, config) });
console.log(`eden partner listening on http://${server.hostname}:${server.port}${config.dev ? " (dev, no auth)" : ""}`);

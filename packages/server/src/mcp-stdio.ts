#!/usr/bin/env bun
/**
 * Serves `ask_context` over stdio for one user, for MCP clients that launch servers as processes:
 *
 *   EDEN_TENANT=acme EDEN_USER=u1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json \
 *     bun packages/server/src/mcp-stdio.ts
 *
 * The session id starts per process and moves on after 2 h with no ask or at UTC midnight (D281: MCP sends no session
 * end). Proactive delivery needs the HTTP API or the SDK (D14). EDEN_QUERY_PLANNER and
 * EDEN_ENGINE_CONFIG (D103) work as for the HTTP server (config.ts). What the query planner
 * learns persists in a source map under $EDEN_HOME, one file per tenant/user (EDEN_SOURCE_MAP overrides it).
 */
import { isId, newId } from "@eden/protocol";
import { buildPartner, openSourceMap } from "./build";
import { warmGate } from "@eden/redact";
import { plannerMode, stdioSourceMapPath } from "./config";
import { sourcesOrExit } from "./connectors";
import { engineConfig } from "./engine-config";
import { createMcpServer } from "./mcp";
import { StdioServerTransport } from "./stdio-transport";
import { modelRolesFromEnv } from "./models";

const tenantId = process.env.EDEN_TENANT ?? "dev";
const userId = process.env.EDEN_USER ?? "";
if (!isId(tenantId) || !isId(userId)) {
  console.error("set EDEN_USER (and EDEN_TENANT) to ids of [A-Za-z0-9._:@-]");
  process.exit(1);
}
// EDEN_USER_SOURCES_FILE (D108) works here too: only this process's user's entry is read and checked. A bad file
// exits 2 with one line on stderr (stdout is the MCP channel).
const sources = sourcesOrExit(process.env, { tenantId, userId });
// Fails open to an in-memory map (logged to stderr) when the file cannot be opened, rather than not starting.
const sourceMap = openSourceMap(() => stdioSourceMapPath(tenantId, userId));
// An MCP client stops this process with a signal as often as by closing stdin. A signal's default action skips the
// `exit` listener that writes the map's buffered mentions and outcomes (D1780), so each closes the map and exits.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    try {
      sourceMap.close();
    } catch (e) {
      console.error(`eden: source map not closed cleanly: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  });
}
// The query planner as in the HTTP server (D33): on unless EDEN_QUERY_PLANNER=0, learning into this user's source map.
const partner = buildPartner({
  sources: sources.resolver,
  sourceMap,
  queryPlanner: plannerMode(process.env.EDEN_QUERY_PLANNER),
  engine: engineConfig(),
  // Cards, intent and the reader on OPENROUTER_API_KEY's model (D112), as in the HTTP server.
  models: modelRolesFromEnv(),
});
const server = createMcpServer(partner, { tenantId, userId, sessionId: newId("mcp") });
await server.connect(new StdioServerTransport());
// After connect, so the compile stays off the client's wait for a ready server but still lands before its first
// ask — one sent inside it just queues behind it once (the local mode's shape, D1969).
setTimeout(warmGate, 0).unref();

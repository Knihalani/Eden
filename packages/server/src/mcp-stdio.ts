#!/usr/bin/env bun
/**
 * Serves `ask_context` over stdio for one user, for MCP clients that launch servers as processes:
 *
 *   EDEN_TENANT=acme EDEN_USER=u1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json \
 *     bun packages/server/src/mcp-stdio.ts
 *
 * The session id is per process. Proactive delivery needs the HTTP API or the SDK (D14). EDEN_QUERY_PLANNER and
 * EDEN_ASK_MODEL and EDEN_ENGINE_CONFIG (D103) work as for the HTTP server (config.ts). What the query planner
 * learns persists in a source map under $EDEN_HOME, one file per tenant/user (EDEN_SOURCE_MAP overrides it).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isId, newId } from "@eden/protocol";
import { buildPartner, openSourceMap } from "./build";
import { warmGate } from "@eden/redact";
import { askModel, plannerMode, stdioSourceMapPath } from "./config";
import { sourcesFromEnv } from "./connectors";
import { engineConfig } from "./engine-config";
import { createMcpServer } from "./mcp";

const tenantId = process.env.EDEN_TENANT ?? "dev";
const userId = process.env.EDEN_USER ?? "";
if (!isId(tenantId) || !isId(userId)) {
  console.error("set EDEN_USER (and EDEN_TENANT) to ids of [A-Za-z0-9._:@-]");
  process.exit(1);
}
// The query planner as in the HTTP server (D33): on unless EDEN_QUERY_PLANNER=0, learning into this user's source map.
const partner = buildPartner({
  // EDEN_USER_SOURCES_FILE (D104) works here too: only this process's user's entry is read and checked.
  sources: sourcesFromEnv(process.env, { tenantId, userId }).resolver,
  // Fails open to an in-memory map (logged to stderr) when the file cannot be opened, rather than not starting.
  sourceMap: openSourceMap(() => stdioSourceMapPath(tenantId, userId)),
  queryPlanner: plannerMode(process.env.EDEN_QUERY_PLANNER),
  // Unset unless EDEN_ASK_MODEL=1, so an EDEN_ENGINE_CONFIG `askWithModel` holds (build.ts).
  askWithModel: askModel(process.env.EDEN_ASK_MODEL) || undefined,
  engine: engineConfig(),
});
// Before the transport opens, so the first ask does not compile the secret gate.
warmGate();
const server = createMcpServer(partner, { tenantId, userId, sessionId: newId("mcp") });
await server.connect(new StdioServerTransport());

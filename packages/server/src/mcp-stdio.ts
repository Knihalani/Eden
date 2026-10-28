#!/usr/bin/env bun
/**
 * Serves `ask_context` over stdio for one user, for MCP clients that launch servers as processes:
 *
 *   EDEN_TENANT=acme EDEN_USER=u1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json \
 *     bun packages/server/src/mcp-stdio.ts
 *
 * The session id is per process. Proactive delivery needs the HTTP API or the SDK (D14). EDEN_QUERY_PLANNER works as
 * for the HTTP server (config.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isId, newId } from "@eden/protocol";
import { buildPartner } from "./build";
import { plannerMode } from "./config";
import { staticResolver } from "./connectors";
import { createMcpServer } from "./mcp";

const tenantId = process.env.EDEN_TENANT ?? "dev";
const userId = process.env.EDEN_USER ?? "";
if (!isId(tenantId) || !isId(userId)) {
  console.error("set EDEN_USER (and EDEN_TENANT) to ids of [A-Za-z0-9._:@-]");
  process.exit(1);
}
// The query planner as in the HTTP server (D33): on unless EDEN_QUERY_PLANNER=0. Its source map is in memory here,
// so what it learns lasts as long as the process.
const partner = buildPartner({
  sources: staticResolver(process.env.EDEN_SOURCES_FILE),
  queryPlanner: plannerMode(process.env.EDEN_QUERY_PLANNER),
});
const server = createMcpServer(partner, { tenantId, userId, sessionId: newId("mcp") });
await server.connect(new StdioServerTransport());

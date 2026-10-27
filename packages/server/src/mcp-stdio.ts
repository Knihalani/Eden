#!/usr/bin/env bun
/**
 * Serves `ask_context` over stdio for one user, for MCP clients that launch servers as processes:
 *
 *   EDEN_TENANT=acme EDEN_USER=u1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json \
 *     bun packages/server/src/mcp-stdio.ts
 *
 * The session id is per process. Proactive delivery needs the HTTP API or the SDK (D14).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isId, newId } from "@eden/protocol";
import { buildPartner } from "./build";
import { staticResolver } from "./connectors";
import { createMcpServer } from "./mcp";

const tenantId = process.env.EDEN_TENANT ?? "dev";
const userId = process.env.EDEN_USER ?? "";
if (!isId(tenantId) || !isId(userId)) {
  console.error("set EDEN_USER (and EDEN_TENANT) to ids of [A-Za-z0-9._:@-]");
  process.exit(1);
}
const partner = buildPartner({ sources: staticResolver(process.env.EDEN_SOURCES_FILE) });
const server = createMcpServer(partner, { tenantId, userId, sessionId: newId("mcp") });
await server.connect(new StdioServerTransport());

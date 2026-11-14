/**
 * The official SDK's `McpServer` with one of each thing a client reads (a read-only tool, a resource, a resource
 * template, a prompt), for the interop tests. Run as a script it serves over stdio (`stdio.test.ts`).
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function sdkServer(): McpServer {
  const server = new McpServer({ name: "fixture", version: "1.2.3" }, { instructions: "Ask for notes." });
  server.registerTool(
    "search_notes",
    { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async ({ query }) => ({ content: [{ type: "text", text: `found: ${query}` }] }),
  );
  server.registerResource("readme", "notes://readme", { mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "the readme" }],
  }));
  server.registerResource(
    "note",
    new ResourceTemplate("notes://{id}", { list: undefined }),
    { mimeType: "text/plain" },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, text: `note ${String(id)}` }] }),
  );
  server.registerPrompt("summarize", { description: "Summarize a note", argsSchema: { id: z.string() } }, ({ id }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Summarize note ${id}` } }],
  }));
  return server;
}

if (import.meta.main) {
  const server = sdkServer();
  // What the process was given, so the stdio test can check that the parent's environment is not passed on.
  server.registerTool("env_names", { annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text", text: JSON.stringify(Object.keys(process.env).sort()) }],
  }));
  await server.connect(new StdioServerTransport());
}

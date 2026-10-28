#!/usr/bin/env bun
/**
 * Captures, from each lab server, one real search result (the fixture `toItems` is tested against) and its search
 * tool's input schema (the corpus the argument mapper is tested against). The data is the simulated world's, never a
 * real account's.
 *
 *   bun packages/sim/src/lab/capture.ts packages/sources/src/fixtures/mcp-results.json \
 *     packages/sources/src/fixtures/mcp-tools.json
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildWorld } from "../world";
import { CONNECTORS, ensureNetwork, removeLabContainers } from "./connectors";
const out: Record<string, unknown> = {};
const tools: Record<string, unknown> = {};
ensureNetwork();
const world = buildWorld({ seed: 1000 });
for (const name of [
  "memory",
  "mcpvault",
  "basic-memory",
  "meilisearch",
  "caldav",
  "imap-subject",
  "chroma",
  "gitea-bleve",
]) {
  const c = CONNECTORS[name]!();
  try {
    await c.setup(
      world.items.filter((i) => c.accepts(i)),
      world,
    );
    const client = new Client({ name: "cap", version: "0" });
    await client.connect(c.transport());
    const listed = (await client.listTools()).tools.find((t) => t.name === c.searchTool.name);
    tools[name] = { tool: c.searchTool.name, inputSchema: listed?.inputSchema, annotations: listed?.annotations };
    const q = name === "imap-subject" ? "Dinner" : "Jamie Fox";
    const r = await client.callTool({ name: c.searchTool.name, arguments: c.searchTool.args(q, 3) });
    out[name] = { tool: c.searchTool.name, query: q, content: r.content, structuredContent: r.structuredContent };
    await client.close();
  } catch (e) {
    out[name] = { error: String(e) };
  }
  await c.teardown().catch(() => {});
  removeLabContainers();
  console.error("captured", name);
}
writeFileSync(process.argv[2]!, JSON.stringify(out, null, 1));
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(tools, null, 1));

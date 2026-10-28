#!/usr/bin/env bun
/**
 * Captures one real search result from each lab server, as the fixture `toItems` is tested against
 * (packages/sources/src/fixtures/mcp-results.json). The data is the simulated world's, never a real account's.
 *
 *   bun packages/sim/src/lab/capture.ts packages/sources/src/fixtures/mcp-results.json
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildWorld } from "../world";
import { CONNECTORS, ensureNetwork, removeLabContainers } from "./connectors";
const out: Record<string, unknown> = {};
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

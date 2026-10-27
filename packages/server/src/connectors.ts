/**
 * Which sources each user has. This is the integration point with a tenant's connector setup: in production it
 * reads the user's connected accounts (and their tokens, from a vault) and builds an `McpSource` per connector.
 *
 * For now it reads a JSON file of static sources (EDEN_SOURCES_FILE), enough to run the server end to end.
 * TODO(connectors): per-user MCP connections with OAuth tokens; see docs/ROADMAP.md, M2.
 */
import { readFileSync } from "node:fs";
import { StaticSource, type Source, type SourceResolver, type StaticDoc } from "@eden/sources";

interface SourcesFile {
  sources: { id: string; description: string; docs: StaticDoc[] }[];
}

export function staticResolver(path: string | undefined): SourceResolver {
  if (!path) return async () => [];
  const file = JSON.parse(readFileSync(path, "utf8")) as SourcesFile;
  const sources: Source[] = file.sources.map((s) => new StaticSource(s.id, s.description, s.docs));
  return async () => sources;
}

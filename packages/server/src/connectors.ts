/**
 * Which sources each user has. This is the integration point with a tenant's connector setup: in production it
 * reads the user's connected accounts (and their tokens, from a vault) and builds an `McpSource` per connector.
 *
 * It reads a JSON file of static sources (EDEN_SOURCES_FILE), shared by every tenant and user. Per-user sources,
 * MCP connections with each user's own credentials included, are `UserSources` (user-sources.ts, D104): a source with
 * credentials must never go here, where every user would read it.
 */
import { readFileSync } from "node:fs";
import { StaticSource, type Source, type SourceResolver, type StaticDoc } from "@eden/sources";
import { fileDirectory, UserSources } from "./user-sources";

interface SourcesFile {
  sources: { id: string; description: string; docs: StaticDoc[] }[];
}

export function staticResolver(path: string | undefined): SourceResolver {
  const sources = staticSources(path);
  return async () => sources;
}

/** EDEN_SOURCES_FILE's sources (none when unset); throws, naming the entry, on a source without documents. */
export function staticSources(path: string | undefined): Source[] {
  if (!path) return [];
  const file = JSON.parse(readFileSync(path, "utf8")) as SourcesFile;
  file.sources.forEach((s, i) => {
    if (!Array.isArray(s.docs)) {
      throw new Error(
        `EDEN_SOURCES_FILE sources[${i}] has no docs: it holds static sources shared by every user; ` +
          "MCP sources are per user, in EDEN_USER_SOURCES_FILE (D104)",
      );
    }
  });
  return file.sources.map((s) => new StaticSource(s.id, s.description, s.docs));
}

/**
 * The servers' sources from the environment: EDEN_SOURCES_FILE (static, shared) and, when set,
 * EDEN_USER_SOURCES_FILE (per user, D104). Without the second, the static resolver as before. A bad file throws at
 * startup with a message naming the entry.
 */
export function sourcesFromEnv(env = process.env): { resolver: SourceResolver; userSources?: UserSources } {
  const shared = staticSources(env.EDEN_SOURCES_FILE);
  if (!env.EDEN_USER_SOURCES_FILE) return { resolver: async () => shared };
  const userSources = new UserSources({ directory: fileDirectory(env.EDEN_USER_SOURCES_FILE), shared }).start();
  return { resolver: userSources.resolver, userSources };
}

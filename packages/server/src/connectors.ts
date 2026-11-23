/**
 * Which sources each user has. This is the integration point with a tenant's connector setup: in production it
 * reads the user's connected accounts (and their tokens, from a vault) and builds an `McpSource` per connector.
 *
 * It reads a JSON file of static sources (EDEN_SOURCES_FILE), shared by every tenant and user. Per-user sources,
 * MCP connections with each user's own credentials included, are `UserSources` (user-sources.ts, D108): a source with
 * credentials must never go here, where every user would read it.
 */
import { readFileSync } from "node:fs";
import type { Scope } from "@eden/protocol";
import { FileSource, StaticSource, type Source, type SourceResolver } from "@eden/sources";
import { checkSpecs, fileDirectory, SourceConfigError, UserSources, type StaticSpec } from "./user-sources";

export function staticResolver(path: string | undefined): SourceResolver {
  const sources = staticSources(path);
  return async () => sources;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * EDEN_SOURCES_FILE's sources (none when unset). Every entry is checked as a static spec by `checkSpecs`, the same
 * checks as EDEN_USER_SOURCES_FILE's (id, duplicate ids, description, each doc's ref/title/text), so a bad id fails
 * at startup instead of loading a source the HTTP API can never address. Throws `SourceConfigError` naming the first
 * bad entry; the servers print it as one line and exit 2.
 */
export function staticSources(path: string | undefined): Source[] {
  if (!path) return [];
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // Not the parser's message: it can quote a word of the file, as for EDEN_USER_SOURCES_FILE.
    const why = e instanceof SyntaxError ? "is not valid JSON" : "cannot be read";
    throw new SourceConfigError(`EDEN_SOURCES_FILE ${path} ${why}`);
  }
  if (!isObject(file) || !Array.isArray(file.sources)) {
    throw new SourceConfigError(`EDEN_SOURCES_FILE must be {"sources": [{"id", "description", "docs"}]}`);
  }
  const entries: unknown[] = file.sources;
  entries.forEach((s, i) => {
    // Before checkSpecs, so an MCP-shaped entry gets the D108 pointer rather than a bare "docs must be an array".
    // `kind: "file"` entries are allowed too (A3): local paths have no credentials and serve every user.
    if (isObject(s) && s.kind !== "file" && !Array.isArray(s.docs)) {
      throw new SourceConfigError(
        `EDEN_SOURCES_FILE sources[${i}] has no docs: it holds static sources shared by every user; ` +
          "MCP sources are per user, in EDEN_USER_SOURCES_FILE (D108)",
      );
    }
  });
  // `kind` last: every shared entry is static unless it asked for the file source, so none is built as MCP.
  const specs = checkSpecs(
    entries.map((s) => (isObject(s) ? { ...s, kind: s.kind === "file" ? "file" : "static" } : s)),
    "EDEN_SOURCES_FILE.sources",
  );
  return specs.map((s) => {
    if (s.kind === "file") {
      return new FileSource(s.id, s.description, { paths: s.paths, maxBytes: s.maxBytes, maxFiles: s.maxFiles });
    }
    return new StaticSource(s.id, s.description, (s as StaticSpec).docs);
  });
}

/**
 * The servers' sources from the environment: EDEN_SOURCES_FILE (static, shared) and, when set,
 * EDEN_USER_SOURCES_FILE (per user, D108). Without the second, the static resolver as before. A bad file throws at
 * startup with a `SourceConfigError` naming the entry. `only` reads one scope's entry (the stdio server's one user).
 * `shared` is the number of shared sources, for the startup log.
 */
export function sourcesFromEnv(
  env = process.env,
  only?: Scope,
): { resolver: SourceResolver; userSources?: UserSources; shared: number } {
  const shared = staticSources(env.EDEN_SOURCES_FILE);
  if (!env.EDEN_USER_SOURCES_FILE) return { resolver: async () => shared, shared: shared.length };
  const directory = fileDirectory(env.EDEN_USER_SOURCES_FILE, { only });
  const userSources = new UserSources({ directory, shared }).start();
  return { resolver: userSources.resolver, userSources, shared: shared.length };
}

/**
 * `sourcesFromEnv` for a server's startup. A bad sources file is the operator's configuration, not a crash: its
 * message (which names the entry) goes to stderr as one line with no stack, and the process exits 2. Anything else
 * still throws.
 */
export function sourcesOrExit(env = process.env, only?: Scope): ReturnType<typeof sourcesFromEnv> {
  try {
    return sourcesFromEnv(env, only);
  } catch (e) {
    if (e instanceof SourceConfigError) console.error(`eden: ${e.message}`);
    // Not the parser's message, which can quote the file (both files' own parses are wrapped; this is a backstop).
    else if (e instanceof SyntaxError) console.error("eden: a sources file is not valid JSON");
    else throw e;
    process.exit(2);
  }
}

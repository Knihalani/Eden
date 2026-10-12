/**
 * Finds the Eden checkout whose memory hook the plugin runs. Claude Code runs the plugin in place (`--plugin-dir`)
 * or, after `/plugin install`, from a copy in its plugin cache, so a path relative to this file is not enough.
 * Only reads files: the Submit budget (150 ms, D20) has no room for a spawn or a network call.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The memory hook's module, relative to an Eden checkout. */
export const MEMORY_HOOK = join("packages", "cli", "src", "memory-hook.ts");
/** The PreToolUse policy guard's hook, beside it (`hook.ts guard <n>`), and the re-check it runs first. */
export const GUARD_HOOK = join("packages", "cli", "src", "memory-guard-hook.ts");
export const GUARD_MATCH = join("src", "memory-guard-match.ts");
/** `PreToolUse(Agent)`'s handler (`hook.ts spawn`): it records the launch for SubagentStart (A4 §5.3). */
export const SPAWN_HOOK = join("packages", "cli", "src", "memory-spawn-hook.ts");

export type EdenRoot = { root: string; via: string };

/**
 * Where an Eden checkout may be, in the order they are tried:
 * 1. the checkout this plugin directory sits in (in place);
 * 2. `EDEN_ROOT`;
 * 3. for an installed copy (`<claude>/plugins/cache/<marketplace>/<plugin>/<version>`) from a directory
 *    marketplace, that directory as Claude Code recorded it in `<claude>/plugins/known_marketplaces.json`.
 */
export function rootCandidates(pluginRoot: string, env: NodeJS.ProcessEnv = process.env): EdenRoot[] {
  const candidates: EdenRoot[] = [{ root: dirname(dirname(pluginRoot)), via: "plugin checkout" }];
  if (env.EDEN_ROOT) candidates.push({ root: env.EDEN_ROOT, via: "EDEN_ROOT" });
  const marketplace = marketplaceRoot(pluginRoot);
  if (marketplace) candidates.push(marketplace);
  return candidates;
}

type KnownMarketplace = { source?: { source?: unknown; path?: unknown } };

/**
 * A directory marketplace is the checkout itself. A git or GitHub one is Claude Code's own clone of it, which has no
 * `node_modules` and moves on every marketplace update, so it is not used: set `EDEN_ROOT` for such an install.
 */
function marketplaceRoot(pluginRoot: string): EdenRoot | null {
  const marketplaceDir = dirname(dirname(pluginRoot));
  const cache = dirname(marketplaceDir);
  const plugins = dirname(cache);
  if (basename(cache) !== "cache" || basename(plugins) !== "plugins") return null;
  const name = basename(marketplaceDir);
  try {
    const known = JSON.parse(readFileSync(join(plugins, "known_marketplaces.json"), "utf8")) as Record<
      string,
      KnownMarketplace | undefined
    >;
    const source = known[name]?.source;
    const root = source?.source === "directory" ? source.path : undefined;
    return typeof root === "string" && root ? { root, via: `marketplace ${name}` } : null;
  } catch {
    return null;
  }
}

/**
 * The first candidate that holds the memory hook, by its real path: Bun loads a module tree slower through a symlinked
 * path (macOS `/var`, `/tmp`). Throws, naming every place tried, when none does.
 */
export function findEdenRoot(pluginRoot: string, env: NodeJS.ProcessEnv = process.env): EdenRoot {
  const candidates = rootCandidates(pluginRoot, env);
  const found = candidates.find((c) => existsSync(join(c.root, MEMORY_HOOK)));
  if (found) return { root: realpathSync(found.root), via: found.via };
  const tried = candidates.map((c) => `${c.via} ${c.root}`);
  if (!env.EDEN_ROOT) tried.push("EDEN_ROOT unset");
  throw new Error(`no Eden checkout with ${MEMORY_HOOK} (tried: ${tried.join("; ")})`);
}

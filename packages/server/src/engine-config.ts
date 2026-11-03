/**
 * EDEN_ENGINE_CONFIG (D103): the path of a JSON file of `EngineConfig` keys, merged over the production defaults for
 * the whole process. Unset, the engine runs on `DEFAULT_CONFIG` exactly (D12). It turns on the flags that need nothing
 * beyond what the shipped servers wire (probes, graph, grounds, compaction, the action firewall, the judge); the lab's
 * presets stay in `@eden/sim` and are not read here, so the file names its flags itself. Checked-in profiles, each
 * with its measured numbers, are in docs/profiles/ (D104). Sync is not among them: it needs listable sources, the
 * shared `StaticSource`s (connectors.ts) have no list tool, and sync over per-user MCP sources (user-sources.ts, D108)
 * has not been tested from the servers (`SERVER_REFUSES`).
 *
 * Every key is checked at startup against `DEFAULT_CONFIG`: an unknown key (a typo, a flag from another version) or a
 * value of the wrong type stops the server with a message naming it, rather than running silently on the default.
 * So does a number outside the key's range (`RANGES`), an `anticipateOff` part the engine does not have, or setting a
 * key that acts only through a partner dependency the servers do not wire (`NEEDS_DEP`) to anything but its default:
 * the engine would accept it and do nothing, or (`syncPageSize: 0`, `syncMaxItems: 0`) stop syncing without a word.
 * Those deps are paid model roles (cards, the bridge, the reader); ALL3 and the NEW family need them, so they are not
 * runnable from the shipped servers until the deps are wired under a decision with a COST-MODEL.md entry. Two more
 * things the servers lack are refused the same way: a route relaying source watches and change notices (push sync)
 * and sources that can be listed (sync, with all its `sync*` sub-settings). The judge
 * (`judge*`, `anticipate`) and `askWithModel` use the partner's own model and `Budget`; docs/COST-MODEL.md has their
 * cost.
 */
import { readFileSync } from "node:fs";
import { ANTICIPATE_PARTS, checkEngineConfig, type EngineConfig } from "@eden/engine";

// The checks themselves (keys, types, `RANGES`, `anticipateOff` parts, `NEEDS_DEP`) live in @eden/engine's
// config-check.ts, shared with the lab's CLIs; re-exported for engine-config.test.ts.
export { ANTICIPATE_PARTS };

/** Why the shipped servers cannot serve a key beyond the unwired dependencies; the key's name is put in front. */
const NOTIFY =
  "needs a server route that relays source watches and change notices to the partner (`sourcePushes`, " +
  "`sourceChanged`), which the shipped servers do not have";
const LIST =
  "needs sources with a list tool: the static sources from EDEN_SOURCES_FILE cannot be listed (sync would read " +
  "nothing from them), and sync over per-user MCP sources (EDEN_USER_SOURCES_FILE) is not supported from the " +
  "servers yet";

/**
 * Keys that act only through something the servers lack besides a partner dependency (those are @eden/engine's
 * `NEEDS_DEP`). sync.ts applies the `syncPush*` settings only to a source marked by `pushing`, which only
 * `sourcePushes` calls. `sync` is refused (D106): static sources cannot be listed, and per-user MCP sources (D108),
 * which can carry a list tool, are not yet tested under sync from the servers; so is every other `sync*` key off its
 * default, since each is inert without it.
 * engine-config.test.ts requires every reader, card, bridge, intent, digest, push and sync key to be refused here or
 * by `NEEDS_DEP`, or allow-listed with a reason.
 */
const SERVER_REFUSES: Partial<Record<keyof EngineConfig, string>> = {
  syncPush: NOTIFY,
  syncPushMaxStaleMs: NOTIFY,
  syncPushSweepMs: NOTIFY,
  syncPushGapMs: NOTIFY,
  sync: LIST,
  // With `sync` refused, every sync sub-setting is inert (partner.ts and sync.ts read them only with `this.sync`), so
  // they are refused too: `syncPollBehind`, the latency lever D65 measures, would otherwise start and do nothing.
  syncMaxItems: LIST,
  syncPageSize: LIST,
  syncPollPageSize: LIST,
  syncEveryMs: LIST,
  syncStaleChance: LIST,
  syncMaxStaleMs: LIST,
  syncActiveMs: LIST,
  syncSweepMs: LIST,
  syncDropMs: LIST,
  syncCallsPerMin: LIST,
  syncOnDemand: LIST,
  syncPollBehind: LIST,
  syncCatchupPages: LIST,
  syncMaxUsersPerTenant: LIST,
  syncLocalAll: LIST,
  syncWide: LIST,
  syncTermProbes: LIST,
};

/** The engine settings EDEN_ENGINE_CONFIG names, validated; `{}` when it is unset or empty. Throws on a bad file. */
export function engineConfig(env: Record<string, string | undefined> = process.env): Partial<EngineConfig> {
  const path = env.EDEN_ENGINE_CONFIG;
  if (path === undefined || path === "") return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`EDEN_ENGINE_CONFIG: cannot read ${path} (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`EDEN_ENGINE_CONFIG: ${path} is not JSON (${(error as Error).message})`);
  }
  return parseEngineConfig(parsed, `EDEN_ENGINE_CONFIG (${path})`);
}

/**
 * `value` as engine settings: a JSON object of known keys, each of its default's type. Throws naming the key. No
 * partner dependency is wired here (buildPartner wires no cards, bridge or reader). The parent-flag check is left off:
 * a file is merged over the defaults, and refusing a child whose parent is off would refuse settings the server has
 * accepted so far (D104); the lab's CLIs run it.
 */
export function parseEngineConfig(value: unknown, where = "engine config"): Partial<EngineConfig> {
  return checkEngineConfig(value, {
    where,
    deps: {},
    depNote: "which the shipped servers do not wire (run it from an embedding that supplies it; buildPartner does not)",
    parents: false,
    refuse: SERVER_REFUSES,
  });
}

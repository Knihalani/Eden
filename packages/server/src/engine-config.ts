/**
 * EDEN_ENGINE_CONFIG (D103): the path of a JSON file of `EngineConfig` keys, merged over the production defaults for
 * the whole process. Unset, the engine runs on `DEFAULT_CONFIG` exactly (D12). It turns on the flags that need nothing
 * beyond what the shipped servers wire (probes, graph, grounds, compaction, the action firewall, sync, the judge); the
 * lab's presets stay in `@eden/sim` and are not read here, so the file names its flags itself. Checked-in profiles,
 * each with its measured numbers, are in docs/profiles/ (D104).
 *
 * Every key is checked at startup against `DEFAULT_CONFIG`: an unknown key (a typo, a flag from another version) or a
 * value of the wrong type stops the server with a message naming it, rather than running silently on the default.
 * So does a number outside the key's range (`RANGES`), an `anticipateOff` part the engine does not have, or setting a
 * key that acts only through a partner dependency the servers do not wire (`NEEDS_DEP`) to anything but its default:
 * the engine would accept it and do nothing, or (`syncPageSize: 0`, `syncMaxItems: 0`) stop syncing without a word.
 * Those deps are paid model roles (cards, the bridge, the reader); ALL3 and the NEW family need them, so they are not
 * runnable from the shipped servers until the deps are wired under a decision with a COST-MODEL.md entry. The judge
 * (`judge*`, `anticipate`) and `askWithModel` use the partner's own model and `Budget`; docs/COST-MODEL.md has their
 * cost.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, type EngineConfig } from "@eden/engine";

/** String-valued keys and the values each accepts; every other key's type is its default's. */
const CHOICES: Partial<Record<keyof EngineConfig, readonly string[]>> = { probeWhen: ["always", "actions"] };

/**
 * Keys that act only when the partner has a dependency `buildPartner` does not wire (partner.ts `PartnerDeps`), with
 * that dependency. Set to anything but their default they would be silent no-ops, so they are refused; the default
 * (off, for a flag) is accepted. The numbers and lists here are read only on their dependency's path (partner.ts:
 * `digestFor`, the only reader of `constraintDigest`, `digestLines` and `digestBytes`, returns nothing without cards,
 * `askReaderStanding` fills the reader's pool, `readerPushWaitMs` bounds the reader's push, the `intent*` settings are
 * read by `intentFinds`, which needs cards).
 */
const NEEDS_DEP: Partial<Record<keyof EngineConfig, "cards" | "bridge" | "reader">> = {
  cards: "cards",
  cardsEconomy: "cards",
  cardItems: "cards",
  constraintDigest: "cards",
  digestLines: "cards",
  digestBytes: "cards",
  intent: "cards",
  intentHits: "cards",
  intentMinCoverage: "cards",
  intentMinMatched: "cards",
  intentWeight: "cards",
  intentSeats: "cards",
  bridgeQuery: "bridge",
  bridgeQuestions: "bridge",
  bridgeWaitMs: "bridge",
  bridgeHits: "bridge",
  bridgeAskSeats: "bridge",
  askReader: "reader",
  askReaderQuestions: "reader",
  askReaderClear: "reader",
  askReaderDrop: "reader",
  askReaderPool: "reader",
  askReaderWaitMs: "reader",
  askReaderStanding: "reader",
  askReaderItemChars: "reader",
  askReaderStandingKinds: "reader",
  readerPush: "reader",
  readerPushNotes: "reader",
  readerPushKinds: "reader",
  readerPushWaitMs: "reader",
  readerGate: "reader",
};

/** A numeric key's legal values beyond "finite, ≥ 0" (every number's floor): whole, at least `min`, at most `max`. */
type Range = { integer?: true; min?: number; max?: number };
const COUNT: Range = { integer: true };
const SIZE: Range = { integer: true, min: 1 };
const SHARE: Range = { max: 1 };

/**
 * Per-key ranges, from each key's doc in the engine's config.ts. Counts (items, terms, calls, seats, turns) are whole;
 * 0 stays legal where config.ts gives it a meaning ("none", "off", `syncPollPageSize`'s "every page is pageSize").
 * `SIZE` is for keys where 0 breaks the feature instead of turning it off: a 0 `syncPageSize` lists 0-item pages, so
 * nothing syncs (sync.ts poll), and a 0 cap on sessions or synced users evicts every one. Chances and shares of the
 * user's items are in [0, 1]. Keys not listed (times, bytes, scores, weights) keep the general floor.
 */
const RANGES: Partial<Record<keyof EngineConfig, Range>> = {
  minMatchedTerms: COUNT,
  fallbackMatchedTerms: COUNT,
  maxItemsPerInjection: COUNT,
  maxRefreshes: COUNT,
  lookupSources: COUNT,
  askSources: COUNT,
  judgeCandidates: COUNT,
  windowEvents: COUNT,
  ledgerCooldownTurns: COUNT,
  cueCooldownTurns: COUNT,
  usageWindowTurns: COUNT,
  maxSessionsPerTenant: SIZE,
  maxSeenTokens: COUNT,
  maxCues: COUNT,
  maxSessionTerms: COUNT,
  probeCalls: COUNT,
  probePeopleSources: COUNT,
  probeTopicSources: COUNT,
  probeFreshFloor: SHARE,
  probeYieldFloor: SHARE,
  consequenceSources: COUNT,
  probeSecondSources: COUNT,
  graphItems: COUNT,
  graphSeats: COUNT,
  anticipateCalls: COUNT,
  anticipateSessionCalls: COUNT,
  judgeTiedShare: SHARE,
  confidentItems: COUNT,
  syncMaxItems: SIZE,
  syncPageSize: SIZE,
  syncPollPageSize: COUNT,
  syncStaleChance: SHARE,
  syncCallsPerMin: COUNT,
  syncCatchupPages: COUNT,
  syncMaxUsersPerTenant: SIZE,
  syncTermProbes: COUNT,
  cardItems: COUNT,
  askFullItems: COUNT,
  decideCandidates: COUNT,
  askContextItems: COUNT,
  intentHits: COUNT,
  intentMinCoverage: SHARE,
  intentMinMatched: COUNT,
  intentSeats: COUNT,
  bridgeHits: COUNT,
  bridgeAskSeats: COUNT,
  askReaderPool: COUNT,
  askReaderStanding: COUNT,
  digestLines: COUNT,
};

/**
 * The parts `anticipateOff` can switch off: every `anticipateOff.includes(…)` (and `off.includes(…)` on it) in
 * partner.ts. engine-config.test.ts reads them there, so a part added to the engine fails the test until it is listed
 * here. A typo would switch nothing off.
 */
export const ANTICIPATE_PARTS: readonly string[] = ["tools", "serve", "names", "learn", "days", "class"];

/** String-list keys whose entries must come from a known list. */
const NAMES: Partial<Record<keyof EngineConfig, readonly string[]>> = { anticipateOff: ANTICIPATE_PARTS };

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

/** `value` as engine settings: a JSON object of known keys, each of its default's type. Throws naming the key. */
export function parseEngineConfig(value: unknown, where = "engine config"): Partial<EngineConfig> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a JSON object of engine settings`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, given] of Object.entries(value)) {
    // `Object.hasOwn`, not `in`: "__proto__" and "constructor" are not settings.
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`${where}: unknown key "${key}"`);
    const fallback = DEFAULT_CONFIG[key as keyof EngineConfig];
    const choices = CHOICES[key as keyof EngineConfig];
    if (choices) {
      if (typeof given !== "string" || !choices.includes(given)) {
        throw new Error(`${where}: "${key}" must be one of ${choices.join(", ")}`);
      }
    } else if (Array.isArray(fallback)) {
      if (!Array.isArray(given) || !given.every((entry) => typeof entry === "string")) {
        throw new Error(`${where}: "${key}" must be an array of strings`);
      }
      const names = NAMES[key as keyof EngineConfig];
      const unknown = names ? (given as string[]).find((entry) => !names.includes(entry)) : undefined;
      if (names && unknown !== undefined) {
        throw new Error(`${where}: "${key}" has "${unknown}", which is not one of ${names.join(", ")}`);
      }
    } else if (typeof fallback === "number") {
      // Every numeric setting is a count, a size, a time or a score, none negative.
      if (typeof given !== "number" || !Number.isFinite(given) || given < 0) {
        throw new Error(`${where}: "${key}" must be a number ≥ 0`);
      }
      const range = RANGES[key as keyof EngineConfig];
      if (range?.integer && !Number.isInteger(given)) throw new Error(`${where}: "${key}" must be a whole number`);
      if (range?.min !== undefined && given < range.min) {
        throw new Error(`${where}: "${key}" must be at least ${range.min}`);
      }
      if (range?.max !== undefined && given > range.max) {
        throw new Error(`${where}: "${key}" must be at most ${range.max}`);
      }
    } else if (typeof given !== typeof fallback) {
      throw new Error(`${where}: "${key}" must be a ${typeof fallback}`);
    }
    const dep = NEEDS_DEP[key as keyof EngineConfig];
    // JSON equality: every such value is a boolean, a number or a list of strings.
    if (dep !== undefined && JSON.stringify(given) !== JSON.stringify(fallback)) {
      throw new Error(
        `${where}: "${key}" needs the partner's ${dep} dependency, which the shipped servers do not wire, so only ` +
          `its default (${JSON.stringify(fallback)}) is accepted; run it from an embedding that supplies it ` +
          "(buildPartner does not)",
      );
    }
    out[key] = given;
  }
  return out as Partial<EngineConfig>;
}

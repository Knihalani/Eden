/**
 * `checkEngineConfig`: a JSON object of `EngineConfig` keys, checked before an engine runs on it. One checker for every
 * entry point that takes engine settings as text (the server's EDEN_ENGINE_CONFIG, D103/D104; the lab's `--config`,
 * `--set` and presets): a typo or a wrong type would otherwise run silently on the default, and a screen would read
 * "the flag does nothing" (audit 2026-11-03b, devloop-lab-accepts-typos-silently).
 *
 * Checked, in this order, each failure throwing an error that names the key:
 * - the key is one of `DEFAULT_CONFIG`'s (an unknown key is a typo or a flag from another version);
 * - its value has its default's type (string lists' entries from `NAMES`);
 * - a number is finite and ≥ 0, and within its `RANGES` entry (whole, at least, at most);
 * - a key that acts only through a partner dependency (`NEEDS_DEP`: cards, reader) the caller does not wire
 *   is at its default or the core's (`deps`; the core's value takes the part out, so it needs nothing);
 * - with `parents` (the default), on the whole configuration merged over `DEFAULT_CONFIG`: a key given a value other
 *   than the core's (`CORE_CONFIG`, its part taken out) has every parent flag it acts under (`PARENTS`) on. Check
 *   the merged preset + override, never an override alone, so a child set under a preset that turns its parent on
 *   is accepted.
 */
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { CORE_CONFIG } from "./parts";
import { READER_KINDS } from "./reader";

type Key = keyof EngineConfig;

/** A partner dependency some settings act through (`PartnerDeps`). */
export type ConfigDep = "cards" | "reader" | "checker";

/**
 * Keys that act only when the partner has a dependency, with that dependency. Set to anything but their default
 * without it they would be silent no-ops, so they are refused; the default (off, for a flag) is accepted. The numbers
 * and lists here are read only on their dependency's path (partner.ts: `readerPushWaitMs` bounds the reader's push,
 * the `intent*` settings are read by `intentFinds`, which needs cards).
 */
export const NEEDS_DEP: Partial<Record<Key, ConfigDep>> = {
  cards: "cards",
  cardsEconomy: "cards",
  cardItems: "cards",
  intent: "cards",
  cardsLean: "cards",
  cardsLeanDays: "cards",
  cardsOrder: "cards",
  cardsLanes: "cards",
  cardsSourceAware: "cards",
  intentHits: "cards",
  intentMinCoverage: "cards",
  intentMinMatched: "cards",
  intentByKind: "cards",
  intentCardCoverage: "cards",
  intentCardHits: "cards",
  intentWeight: "cards",
  intentSeats: "cards",
  askReader: "reader",
  askReaderDrop: "reader",
  askReaderPool: "reader",
  askReaderWaitMs: "reader",
  askReaderItemChars: "reader",
  readerPush: "reader",
  readerPushKinds: "reader",
  readerPushWaitMs: "reader",
  readerPushBehind: "reader",
  readerGate: "reader",
  readerGateVisits: "reader",
  readerVerifyAfter: "reader",
  readerReuse: "reader",
  readerStopEarly: "reader",
  // `pushCandidates` is not here: the candidates make no reader call and act without one (D276).
  pushCheck: "checker",
  pushCheckWaitMs: "checker",
  pushCheckItemChars: "checker",
  pushCheckItems: "checker",
};

/**
 * Reader keys the push's candidates read with no reader wired (D276: partner.ts `observe` starts the push,
 * `candidatesOf` cuts the pool by `askReaderPool` and tests it with the constraint test, `readerGateVisits`
 * included). Accepted off their default without a reader while `pushCandidates` > 0.
 */
const CANDIDATES_WITHOUT_READER: ReadonlySet<Key> = new Set<Key>([
  "askReader",
  "readerPush",
  "readerPushWaitMs",
  "readerPushBehind",
  "askReaderPool",
  "readerGateVisits",
]);

/**
 * Keys that act only while every flag listed is on (config.ts's "with X", "applies only with it on", and the gates in
 * partner.ts). Set off their default with a parent off, they would do nothing: `syncPollBehind` alone, or `cardItems`
 * without `cards`, runs byte-identical to the defaults in `bun run eval`. Several parents per key: `syncPollBehind`
 * acts only with the sync running and polling on demand (partner.ts `if (this.config.syncPollBehind && this.sync &&
 * this.config.syncOnDemand)`), `readerPushBehind` only on a push that waits for such a poll.
 */
const SYNC: Key[] = ["sync"];
const POLL_BEHIND: Key[] = ["sync", "syncOnDemand", "syncPollBehind"];
const READER: Key[] = ["askReader"];
const PUSH: Key[] = ["askReader", "readerPush"];
export const PARENTS: Partial<Record<Key, readonly Key[]>> = {
  syncMaxItems: SYNC,
  syncPageSize: SYNC,
  syncPollPageSize: SYNC,
  syncStaleChance: SYNC,
  syncMaxStaleMs: SYNC,
  syncActiveMs: SYNC,
  syncSweepMs: SYNC,
  syncDropMs: SYNC,
  syncCallsPerMin: SYNC,
  syncOnDemand: SYNC,
  syncPollBehind: ["sync", "syncOnDemand"],
  syncPush: SYNC,
  syncIngestTurns: SYNC,
  syncKick: SYNC,
  syncKickLanes: ["sync", "syncKick"],
  syncKickRetryMs: ["sync", "syncKick"],
  syncPushMaxStaleMs: ["sync", "syncPush"],
  verifyTimeoutMs: ["verifyDelivery"],
  syncCatchupPages: SYNC,
  syncPollWidth: ["sync", "syncOnDemand"],
  syncBackfillLanes: SYNC,
  syncLocalComplete: SYNC,
  pushCutBehind: [...POLL_BEHIND, "syncLocalComplete"],
  askBehind: [...POLL_BEHIND, "syncLocalComplete", "pushCutBehind"],
  askBehindWaitMs: [...POLL_BEHIND, "syncLocalComplete", "pushCutBehind", "askBehind"],
  sourceYield: SYNC,
  sourceYieldRun: ["sync", "sourceYield"],
  sourceYieldHalfLifeMs: ["sync", "sourceYield"],
  sourceYieldPolls: ["sync", "sourceYield", "syncOnDemand"],
  sourceYieldEarn: ["sync", "sourceYield"],
  sourceYieldRare: ["sync", "sourceYield", "sourceYieldEarn"],
  sourceYieldNames: ["sync", "sourceYield", "sourceYieldEarn"],
  sourceYieldEngage: ["sync", "sourceYield", "sourceYieldEarn"],
  syncKeepCut: SYNC,
  routeSketch: SYNC,
  syncEngagedDeep: SYNC,
  syncUnusedSweepMs: ["sync", "verifyDelivery"],
  syncMaxUsersPerTenant: SYNC,
  syncLocalAll: SYNC,
  cardItems: ["cards"],
  cardsEconomy: ["cards"],
  intent: ["cards"],
  cardsLean: ["cards", "intent"],
  cardsLeanDays: ["cards", "intent", "cardsLean"],
  cardsOrder: ["cards"],
  cardsLanes: ["cards"],
  cardsSourceAware: ["cards", "sync"],
  intentHits: ["cards", "intent"],
  intentMinCoverage: ["cards", "intent"],
  intentMinMatched: ["cards", "intent"],
  intentByKind: ["cards", "intent"],
  intentCardCoverage: ["cards", "intent", "intentByKind"],
  intentCardHits: ["cards", "intent", "intentByKind"],
  intentWeight: ["cards", "intent"],
  intentSeats: ["cards", "intent"],
  askReaderPool: READER,
  askReaderWaitMs: READER,
  askReaderDrop: READER,
  askReaderItemChars: READER,
  readerPush: READER,
  readerGate: READER,
  readerGateVisits: [...READER, "readerGate"],
  readerPushKinds: PUSH,
  readerPushWaitMs: PUSH,
  readerPushBehind: [...PUSH, ...POLL_BEHIND],
  readerVerifyAfter: [...READER, "verifyDelivery"],
  readerReuse: PUSH,
  readerStopEarly: READER,
  pushCandidates: PUSH,
  planConflict: [...PUSH, "sync"],
  askNudge: PUSH,
  askNudgeDeep: [...PUSH, "askNudge"],
  pushCandidatesSettled: PUSH,
  pushOpen: PUSH,
  constraintTag: PUSH,
  pushSupersede: PUSH,
  pushIndirect: PUSH,
  pushCheck: PUSH,
  pushCheckWaitMs: [...PUSH, "pushCheck"],
  pushCheckItemChars: [...PUSH, "pushCheck"],
  pushCheckItems: [...PUSH, "pushCheck"],
  revisionDiff: ["revisionNotice"],
};

/** A numeric key's legal values beyond "finite, ≥ 0" (every number's floor): whole, at least `min`, at most `max`. */
type Range = { integer?: true; min?: number; max?: number };
const COUNT: Range = { integer: true };
const SIZE: Range = { integer: true, min: 1 };
const SHARE: Range = { max: 1 };

/**
 * Per-key ranges, from each key's doc in config.ts. Counts (items, terms, calls, seats, turns) are whole; 0 stays
 * legal where config.ts gives it a meaning ("none", "off", `syncPollPageSize`'s "every page is pageSize"). `SIZE` is
 * for keys where 0 breaks the feature instead of turning it off: a 0 `syncPageSize` lists 0-item pages, so nothing
 * syncs (sync.ts poll), and a 0 cap on sessions or synced users evicts every one. Chances and shares of the user's
 * items are in [0, 1]. Keys not listed (times, bytes, scores, weights) keep the general floor.
 */
const RANGES: Partial<Record<Key, Range>> = {
  minMatchedTerms: COUNT,
  fallbackMatchedTerms: COUNT,
  maxItemsPerInjection: COUNT,
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
  judgeTiedShare: SHARE,
  confidentItems: COUNT,
  syncMaxItems: SIZE,
  syncPageSize: SIZE,
  syncPollPageSize: COUNT,
  syncStaleChance: SHARE,
  syncCallsPerMin: COUNT,
  syncCatchupPages: COUNT,
  syncPollWidth: COUNT,
  cardsLanes: { integer: true, min: 1, max: 8 },
  syncBackfillLanes: SIZE,
  syncKickLanes: COUNT,
  syncKickRetryMs: COUNT,
  syncMaxUsersPerTenant: SIZE,
  cardItems: COUNT,
  decideCandidates: COUNT,
  intentHits: COUNT,
  intentMinCoverage: SHARE,
  intentMinMatched: COUNT,
  intentCardCoverage: SHARE,
  intentCardHits: COUNT,
  intentSeats: COUNT,
  askReaderPool: COUNT,
  pushCandidates: { integer: true, max: 40 },
  pushCandidatesSettled: { integer: true, max: 40 },
  pushCheckWaitMs: COUNT,
  pushCheckItemChars: { integer: true, min: 40, max: 400 },
  constraintTag: { min: 0, max: 1 },
  pushSupersede: { min: 0, max: 1 },
  pushCheckItems: { integer: true, min: 1, max: 20 },
  sourceYieldRare: { integer: true, max: 2 },
  sourceYieldNames: COUNT,
};

/** String-list keys whose entries must come from a known list. */
const NAMES: Partial<Record<Key, readonly string[]>> = {
  readerPushKinds: READER_KINDS,
};

export interface ConfigCheckOptions {
  /** Prefix of every error ("engine config" by default), naming where the settings came from. */
  where?: string;
  /** The partner dependencies the caller wires; a `NEEDS_DEP` key off its default needs its dependency here. */
  deps?: Partial<Record<ConfigDep, boolean>>;
  /** Why an unwired dependency is missing, said in its error (the server names `buildPartner`). */
  depNote?: string;
  /** Refuse a key set off its default whose `PARENTS` are not all on (default true). */
  parents?: boolean;
  /**
   * Keys the caller cannot serve beyond `NEEDS_DEP` (the server: sync needs listable sources), each with the phrase
   * its error gives after the key ("needs …"); refused unless at their default.
   */
  refuse?: Partial<Record<Key, string>>;
}

/**
 * `value` as engine settings: a JSON object of known keys, each of its default's type and range, needing only the
 * dependencies the caller wires and (with `parents`) acting under the configuration's own flags. Throws naming the
 * first bad key; returns the same keys and values, typed.
 */
export function checkEngineConfig(value: unknown, options: ConfigCheckOptions = {}): Partial<EngineConfig> {
  const where = options.where ?? "engine config";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a JSON object of engine settings`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, given] of Object.entries(value)) {
    checkKey(where, key, given);
    const dep = NEEDS_DEP[key as Key];
    // With the push's candidates on (the default), the push and its pool act with no reader (D276).
    const candidates = Number((value as Record<string, unknown>).pushCandidates ?? DEFAULT_CONFIG.pushCandidates) > 0;
    const actsWithout = dep === "reader" && candidates && CANDIDATES_WITHOUT_READER.has(key as Key);
    if (dep !== undefined && !actsWithout && options.deps?.[dep] !== true && !isInert(key as Key, given)) {
      throw new Error(
        `${where}: "${key}" needs the partner's ${dep} dependency, ` +
          `${options.depNote ?? "which this caller does not wire"}, so only its default ` +
          `(${JSON.stringify(DEFAULT_CONFIG[key as Key])}) is accepted`,
      );
    }
    const why = options.refuse?.[key as Key];
    if (why !== undefined && !isDefault(key as Key, given)) {
      throw new Error(
        `${where}: "${key}" ${why}, so only its default (${JSON.stringify(DEFAULT_CONFIG[key as Key])}) is accepted`,
      );
    }
    out[key] = given;
  }
  if (options.parents !== false) {
    const merged = { ...DEFAULT_CONFIG, ...out } as EngineConfig;
    for (const key of Object.keys(out) as Key[]) {
      const parents = PARENTS[key];
      if (!parents || isCore(key, merged[key])) continue;
      const off = parents.filter((p) => merged[p] !== true);
      if (off.length) {
        throw new Error(
          `${where}: "${key}" acts only with ${parents.map((p) => `"${p}"`).join(" and ")} on, and this ` +
            `configuration has ${off.map((p) => `"${p}"`).join(" and ")} off: it would do nothing`,
        );
      }
    }
  }
  return out as Partial<EngineConfig>;
}

/** JSON equality with the default: every setting is a boolean, a number, a string or a list of strings. */
function isDefault(key: Key, given: unknown): boolean {
  return JSON.stringify(given) === JSON.stringify(DEFAULT_CONFIG[key]);
}

/**
 * Whether a value asks nothing of a dependency or a parent flag: the default's own (which runs its no-model path
 * without the dependency, D112), or the core's (`CORE_CONFIG`: the part taken out, "default minus <part>").
 */
function isInert(key: Key, given: unknown): boolean {
  return isDefault(key, given) || isCore(key, given);
}

/** Whether a value is the core's: what a child holds with its part taken out, so it needs no parent on. */
function isCore(key: Key, given: unknown): boolean {
  return JSON.stringify(given) === JSON.stringify(CORE_CONFIG[key]);
}

/** Throws unless `key` is a setting and `given` a legal value for it. */
function checkKey(where: string, key: string, given: unknown): void {
  // `Object.hasOwn`, not `in`: "__proto__" and "constructor" are not settings.
  if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`${where}: unknown key "${key}"`);
  const fallback = DEFAULT_CONFIG[key as Key];
  if (Array.isArray(fallback)) {
    if (!Array.isArray(given) || !given.every((entry) => typeof entry === "string")) {
      throw new Error(`${where}: "${key}" must be an array of strings`);
    }
    const names = NAMES[key as Key];
    const unknown = names ? (given as string[]).find((entry) => !names.includes(entry)) : undefined;
    if (names && unknown !== undefined) {
      throw new Error(`${where}: "${key}" has "${unknown}", which is not one of ${names.join(", ")}`);
    }
  } else if (typeof fallback === "number") {
    // Every numeric setting is a count, a size, a time or a score, none negative.
    if (typeof given !== "number" || !Number.isFinite(given) || given < 0) {
      throw new Error(`${where}: "${key}" must be a number ≥ 0`);
    }
    const range = RANGES[key as Key];
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
}

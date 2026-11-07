/**
 * The default's parts (D112). `DEFAULT_CONFIG` is one configuration, the best measured; each part names the settings
 * that take one piece of it out, so "default minus <part>" is the only ablation there is: the lab's presets are made
 * from these (packages/sim/src/lab/presets.ts), and `CORE_CONFIG`, the default with every part taken out, is the
 * no-feature core the parts build on. Unit tests that check one mechanism in isolation start from the core and turn
 * on what they test; the default as a whole is checked by `bun run eval`, the funnel and `default.test.ts`.
 *
 * A part whose settings are model roles (cards, intent, the reader) needs its partner dependency as well: without it
 * the part is inert and the no-model path answers, so the same default runs with or without a model (D112).
 */
import { DEFAULT_CONFIG, type EngineConfig } from "./config";

export const PARTS = {
  /** Probes: the people and topics a request names, searched beside it (D46–D48, D50, D54). */
  probes: {
    probes: false,
    probeTopicAlone: false,
    probeFresh: false,
    probeYield: false,
    probeRoles: false,
    probeShare: false,
    consequenceProbe: false,
  },
  /** The no-model grounds and quiet rules (D44, D48, D49, D52, D54, D75). */
  grounds: {
    groundAway: false,
    groundConflict: false,
    groundOccasion: false,
    quietSettled: false,
    quietClear: false,
    quietNameOnly: false,
    conflictVocab: false,
  },
  /** The no-model fallback for a request that asks or acts (D48). */
  fallback: { fallbackAsks: false },
  /** Compact packets and answers (D47, D52, D76–D78). */
  compaction: {
    compactInjection: false,
    densePacket: false,
    compactAsk: false,
    askDedup: false,
    compactParts: false,
  },
  /** The judge's settings, used only when an embedding wires a judge model (D54, D55). */
  judge: { judgeContested: false, judgeTied: false, judgeItemBytes: 280 },
  /** The knowledge graph (D58, D107). */
  graph: { graph: false, graphMerge: false },
  /** Anticipation (D60). */
  anticipate: { anticipate: false },
  /** Background sync (D57) and its request-path switches (D65, D101). */
  sync: {
    sync: false,
    syncPollBehind: false,
    syncPollPageSize: 0,
    readerPushBehind: false,
    syncPush: false,
    verifyDelivery: false,
    readerVerifyAfter: false,
  },
  /** A delivered item its source signalled a change to since it was read is read again first (D126). */
  freshness: { verifyDelivery: false, readerVerifyAfter: false },
  /** The rule verdicts an ask gathers (D73). */
  askVerdicts: { askVerdicts: false },
  /** Implication cards (D59, D66), and with them the intent index, which their calls write. */
  cards: { cards: false, cardsEconomy: false, intent: false, cardsLean: false },
  /** The intent index (D87, D109), and what it reads (`cardsLean`, D125). */
  intent: { intent: false, cardsLean: false },
  /** The ask-time reader and its push (D95, D96, D99). */
  reader: {
    askReader: false,
    askReaderDrop: false,
    readerPush: false,
    readerGate: false,
    readerGateVisits: false,
    readerPushBehind: false,
    readerVerifyAfter: false,
    readerReuse: false,
    askReaderPool: 30,
    askReaderItemChars: 400,
  },
  /** A request arriving while the slow path is busy waits in a one-slot queue (D102). */
  slowPathQueue: { slowPathQueue: false },
  /** A lookup does not wait for its probes past its own search (D47's grace, 100 ms, taken out). */
  probeGrace: { probeGraceMs: 100 },
} satisfies Record<string, Partial<EngineConfig>>;

export type Part = keyof typeof PARTS;

/** The default with the named parts taken out. */
export function withoutParts(...parts: Part[]): EngineConfig {
  return Object.assign({ ...DEFAULT_CONFIG }, ...parts.map((p) => PARTS[p])) as EngineConfig;
}

/** The default with every part taken out: the core each part builds on, for tests of one mechanism alone. */
export const CORE_CONFIG: EngineConfig = withoutParts(...(Object.keys(PARTS) as Part[]));

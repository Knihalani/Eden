/** The lab's named engine configurations (`--config H|ALL3|ALL5`), shared by pi-ab.ts and hermes-ab.ts. */

// D55's recommended experimental configuration, by name, so the documented commands stay short.
export const PRESETS: Record<string, Record<string, unknown>> = {
  H: {
    probes: true,
    compactInjection: true,
    quietSettled: true,
    groundAway: true,
    judgeContested: true,
    judgeItemBytes: 200,
    probeShare: true,
    probeTopicAlone: true,
    fallbackAsks: true,
    groundConflict: true,
    quietClear: true,
    probeFresh: true,
    probeYield: true,
    densePacket: true,
    groundOccasion: true,
    quietNameOnly: true,
    judgeTied: true,
  },
};
// D80's ALL3, and ALL5 (docs/research/edge-combined.md, proposed): ALL3 plus the intent index, the bridging query and
// guarded, answer-shaped asks and packets. ALL5 needs `--cards` (with `--intent` to replay requests) and a bridge
// model.
PRESETS.ALL3 = {
  ...PRESETS.H,
  consequenceProbe: true,
  probeRoles: true,
  graph: true,
  graphMerge: true,
  cards: true,
  anticipate: true,
  sync: true,
  askVerdicts: true,
  conflictVocab: true,
  compactAsk: true,
  askDedup: true,
  compactParts: true,
  cardsEconomy: true,
};
PRESETS.ALL5 = {
  ...PRESETS.ALL3,
  intent: true,
  bridgeQuery: true,
  bridgeQuestions: true,
  bridgeAskSeats: 2,
  askGuard: true,
  packetBearing: true,
};

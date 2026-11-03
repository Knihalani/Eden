/** The lab's named engine configurations (`--config H|ALL3|NEW`), shared by pi-ab.ts and hermes-ab.ts. */

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
// D80's ALL3.
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
// docs/research/haiku-opt.md (D96, proposed): ALL3 plus the intent index (D87) and the ask-time reader (D95, prompt
// v5) with `askReaderDrop` and `readerPush` (the reader's flags as a packet for an acting request). Needs `--cards`
// and `--intent` (requests replayed) and a reader model (`--reader-model`).
PRESETS.NEW = {
  ...PRESETS.ALL3,
  intent: true,
  askReader: true,
  askReaderDrop: true,
  readerPush: true,
};
// docs/research/haiku-phase3.md (D99): NEW's cheaper operating point. The reader is skipped when no candidate could
// constrain the request, and reads 15 candidates of at most 240 characters.
PRESETS.NEWL = {
  ...PRESETS.NEW,
  readerGate: true,
  askReaderPool: 15,
  askReaderItemChars: 240,
};
// The deep audit of 2026-11-03 (finding lat-sync-poll-on-critical-path): ALL3 and NEW with `syncPollBehind`, so a
// warm on-demand sync poll no longer blocks the search it freshens. At profile latency (`funnel -- --time 1`) the
// poll was about 91% of ALL3's critical path. D72 left "syncPollBehind alone" to a fresh pre-registered run that never
// happened; these presets name that configuration for it. Lab only: production defaults are unchanged, and ALL3/NEW
// themselves are untouched. The trade (D57, D40): a stale warm copy can answer first, its correction queued for the
// next request, which the static sim worlds cannot show.
PRESETS.ALL3B = { ...PRESETS.ALL3, syncPollBehind: true };
PRESETS.NEWB = { ...PRESETS.NEW, syncPollBehind: true };
// The deep audit of 2026-11-03b, round 2. NEWBB (lat-push-read-waits-poll): NEWB with `readerPushBehind`, so the
// push's reader starts on the index as it stands instead of after the poll; a poll that stores something gets one
// second reading. ALL3BG and NEWBG (lat-probe-grace-floor): ALL3B and NEWB with no probe grace, so a lookup no longer
// waits up to 100 ms past its own search for its probes (D47's grace; what a late probe finds is still cached for
// later turns, but this lookup does not rank it). A plain override, measured as shipped. Lab only: no default changes,
// and D47's live probe gain was measured with the grace on, so a Pi run is owed before any decision.
PRESETS.NEWBB = { ...PRESETS.NEWB, readerPushBehind: true };
PRESETS.ALL3BG = { ...PRESETS.ALL3B, probeGraceMs: 0 };
PRESETS.NEWBG = { ...PRESETS.NEWB, probeGraceMs: 0 };
// Candidate unified default (claude/unify-default, measurement in progress): NEWL plus the audit's speed switches.
PRESETS.UNI = {
  ...PRESETS.NEWL,
  syncPollBehind: true,
  syncPollPageSize: 5,
  probeGraceMs: 0,
  readerPushBehind: true,
  slowPathQueue: true,
};

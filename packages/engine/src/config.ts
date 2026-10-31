/** Every threshold the engine uses, in one place. Tuned by the eval harness (packages/eval), not by hand-waving. */
export interface EngineConfig {
  /**
   * A candidate scoring at least this is delivered without asking the model. Above 1 on purpose: query coverage
   * tops out at 1, so only an item that also names an entity from the cue clears it. Topical similarity alone
   * never earns an unasked injection; it earns a place among the model's candidates.
   */
  confidentScore: number;
  /** A candidate below this is dropped; between the two, the model may judge it. */
  candidateScore: number;
  /** Weight of an exact entity match in an item, on top of its query coverage (0..1). */
  entityBonus: number;
  /** Distinct query terms an item must hold to be delivered without the model. One shared word is not evidence. */
  minMatchedTerms: number;
  /**
   * With no model to judge (none configured, or over budget), the best-scored candidate is still delivered if it
   * holds at least `fallbackMatchedTerms` distinct query terms and scores at least `fallbackScore`, entity or not
   * (D36). Chosen on the simulation's tuning set; 0 turns it off. A model, when there is one, judges instead.
   */
  fallbackMatchedTerms: number;
  fallbackScore: number;
  /** The fallback also takes an item the lookup's own search and a probe both found, sharing two request terms. */
  fallbackAgree: boolean;
  /** The fallback takes two of the request's terms, not `fallbackMatchedTerms`, when the request asks or acts. */
  fallbackAsks: boolean;
  /** The least score an agreed item needs (`fallbackAgree`). */
  fallbackAgreeScore: number;
  maxItemsPerInjection: number;
  maxInjectionBytes: number;
  /**
   * A cached item fetched or seen in a lookup longer ago than this is never delivered from the fast path: its cue goes
   * to the slow path, whose live search returns the source's current copy (so a moved meeting is not delivered at its
   * old time). 0 turns this off. See D40.
   */
  refreshAfterMs: number;
  /**
   * After that search, the best candidates still older than `refreshAfterMs` are re-read through their source's
   * `fetch`, at most this many per lookup. Off by default (0): in simulation it added calls and no recall beyond noise
   * (D40).
   */
  maxRefreshes: number;
  /** Sources asked per proactive lookup (routing picks them). An ask uses `askSources`. */
  lookupSources: number;
  askSources: number;
  sourceTimeoutMs: number;
  /** Most candidates shown to the model judge. Bounds its input tokens. */
  judgeCandidates: number;
  /**
   * Whether `ask` has the model rewrite the items it found as a short prose answer. Off by default (D43): the asker
   * is itself a model and reads the cited items directly, and that rewrite was about half of all model calls.
   */
  askWithModel: boolean;
  /** Events kept as the session's recent window. */
  windowEvents: number;
  /** Turns before a delivered item may be delivered again. */
  ledgerCooldownTurns: number;
  /** Turns before the same cue is looked up again. */
  cueCooldownTurns: number;
  /** Turns an injection has to show use before it counts as unused. */
  usageWindowTurns: number;
  /**
   * Live sessions per tenant. Past this, that tenant's least recently active session is dropped (with no learning):
   * one tenant can never push out another's sessions.
   */
  maxSessionsPerTenant: number;
  /** A session idle this long is dropped, with no learning, the next time any session starts. */
  sessionIdleMs: number;
  /** Per-session bounds on the tokens seen and the cues remembered. */
  maxSeenTokens: number;
  maxCues: number;
  /**
   * Terms in a session's vocabulary before it is rebuilt from what the session still holds (seen terms, terms of
   * injections awaiting use). Event text is interned there, not in the user's cache vocabulary, which would grow
   * with every id and hash in every tool result for as long as the user is cached.
   */
  maxSessionTerms: number;
  /**
   * Probes (docs/research/probes.md, PoC, off by default): send a request's people, their organisations, its topic
   * and, for an action on a named day, that day's listing, as short queries besides the request itself; ground a
   * clash with the requested time with no model; give the probes' finds seats among the judge's candidates.
   */
  probes: boolean;
  /**
   * Each delivered item cut to the sentences that bear on the request (its words, numbers, times), at most
   * `compactItemBytes`, with quoted threads, greetings and signatures dropped, rather than to its first bytes.
   */
  compactInjection: boolean;
  compactItemBytes: number;
  /** Compaction also drops the parts whose every content word the session has already seen. */
  compactNovel: boolean;
  /** How long a lookup waits for its probes past its own search (ms); slower ones only fill the cache. */
  probeGraceMs: number;
  /** A probe the user's lookups made this recently (ms) is answered from its cached finds, at no call. */
  probeMemoMs: number;
  /** Source calls the probes may make per lookup, on top of the lookup's own. */
  probeCalls: number;
  /**
   * Which requests are probed: "always", or "actions" (a request that starts with a verb, schedules, or acts on
   * someone, and arriving messages): where unasked context changes the outcome, at fewer source calls.
   */
  probeWhen: "always" | "actions";
  /** Sources each person or organisation probe goes to (the source map's best for that name). */
  probePeopleSources: number;
  /** Sources the topic probe goes to (the lookup's best routed). */
  probeTopicSources: number;
  /** Sources a second person's probe goes to (the first's: `probePeopleSources`). */
  probeSecondSources: number;
  /** A lookup's planner and probes send the same query to the same source once (`SharedCalls`). */
  probeShare: boolean;
  /** A request naming someone by their relation ("my manager") sends that word as a probe (`probes.ts` `rolesOf`). */
  probeRoles: boolean;
  /** The topic probe only for a request that names no person. */
  probeTopicAlone: boolean;
  /**
   * A probe's query is not sent again to a source whose answers to it have not been changing (`economy.ts`): the
   * chance it changed since last asked, from its own and the user's learned change rates, is below
   * `probeFreshFloor`; its last answer, still cached, stands in for the call.
   */
  probeFresh: boolean;
  /** With `probeFresh`, the least chance that a query's answer changed for it to be asked again. */
  probeFreshFloor: number;
  /**
   * A probe kind (person, organisation, topic, role, day) is sent to a source only while the upper 90% bound of what
   * such calls have yielded for this user (an item new to the cache that was seated with the judge or delivered, then
   * or later) is at least `probeYieldFloor` (`economy.ts`); the first person then goes to every source, not
   * `probePeopleSources` of them.
   */
  probeYield: boolean;
  /** With `probeYield`, the least yield per call worth a call. */
  probeYieldFloor: number;
  /**
   * A request that acts, of an action class (release, delete, pay, hire, travel, food, spend, share: `consequence.ts`),
   * sends that class's constraint vocabulary ("freeze moratorium blackout ...") as one more probe, to the
   * `consequenceSources` sources best for the class (learned per user with `probeYield`). A find that holds a class
   * term and that the conflict test, tied by the class's words, says conflicts with the request takes a judge seat
   * and, with `groundConflict`, is delivered with no model.
   */
  consequenceProbe: boolean;
  /** Sources the consequence probe goes to per lookup. */
  consequenceSources: number;
  /**
   * With a judge configured, the slow path's confident items are judged too (with the other candidates, one call)
   * rather than delivered on their score alone. Costs a judge call on lookups that had only confident items.
   */
  judgeConfident: boolean;
  /**
   * With a model: the judge leaves the critical path. Every lookup decides and answers as with no model (the fast
   * path, anticipation's early answer, grounding and the fallback); the judge then reads the candidates that answer
   * left out, and what it picks is queued for the agent's next turn. It can add, never hold back
   * (docs/research/econ-judge.md).
   */
  judgeBehind: boolean;
  /** With a judge configured, sure items are judged when more than one scored as sure (a contested set). */
  judgeContested: boolean;
  /**
   * The judge is asked only when a candidate is tied to the request: it holds a word of the request that is rare in
   * the user's items (on fewer than `judgeTiedShare` of them: a name, a reference, a place), or it is an event on a
   * day the request names. Candidates that share only common words with it ("nice", "week", "thanks") are what a
   * judge almost always turns down, so the call is not made and the lookup ends silent (`judgeTied`).
   */
  judgeTied: boolean;
  /** With `judgeTied`, a word on fewer than this share of the user's live items ties a candidate to the request. */
  judgeTiedShare: number;
  /** The judge's input: the recent conversation, at most this many characters (its newest end). */
  judgeWindowChars: number;
  /** With `compactInjection`, each candidate's compacted text in the judge's input, at most this many bytes. */
  judgeItemBytes: number;
  /** At most this many items delivered on their score alone, with no model's say (the confident path). */
  confidentItems: number;
  /**
   * With no model's say (the confident path and the fallback), an item that only says things stand as expected ("as
   * usual", "resolved", "no change": `probes.ts` `settled`) is not delivered: it changes nothing (D48).
   */
  quietSettled: boolean;
  /**
   * With no model's say: an item saying a person the request names is away on a day it names is delivered (grounded
   * "away"), and one saying someone is away only on other days is not (`probes.ts` `absenceSpan`; D48).
   */
  groundAway: boolean;
  /**
   * With no model's say: an item that would change what the request is about to do is delivered (grounded
   * "conflict"): a hold, absence or freeze over a day it acts on, a deadline or expiry before it, a limit below an
   * amount it commits, a thing already done, a standing constraint (an allergy, a confidentiality), about something
   * the request names or, for a request that names no one, one of its words, whatever the request (`conflict.ts`;
   * D49).
   */
  groundConflict: boolean;
  /**
   * With no model's say (the confident path and the fallback), an item about what the request names whose decisive
   * value does not conflict with it is not delivered: a span elsewhere, an amount under the limit, a matter lifted
   * or unchanged, a sibling reference (Q2 for Q3, another invoice number) (`conflict.ts`; D49).
   */
  quietClear: boolean;
  /** With `judgeConfident`, a lone sure item the lookup and a probe both found is judged too (false: delivered). */
  judgeAgreed: boolean;
  /**
   * With `compactInjection`, a packet says each occurrence once: an item that echoes one above it (the same weekday
   * and time, and no word the user's items make rare: an invitation under its calendar event, the reply that booked
   * it) is left out of the packet (`fold.ts`), and compaction drops a notification's echo of its own title, footers
   * run into a line and the user from attendee lists (`render.ts` `messageParts`).
   */
  densePacket: boolean;
  /**
   * With no model's say, names a request types in lowercase ("move my drinks with chen wei") ground it and pick its
   * fallback as capitalised ones do, when the user's own sources have been recorded mentioning them (the source map;
   * `Partner.withRecoveredNames`). Probes and ranking keep the request as typed: no source call is added.
   */
  recoverNames: boolean;
  /**
   * With no model's say, the event a request names the way people do is grounded: by its occasion and who it is with
   * ("dinner with Elena"), its occasion and day ("lunch on Monday"), or, for a message from someone about meeting, the
   * next event whose title names them (`Partner.occasion`).
   */
  groundOccasion: boolean;
  /**
   * With no model's say, an item tied to the request by a name alone is not pushed: it shares no other word of the
   * request, is on no day the request names and holds no reference it names (`Partner.beyondName`). A passing
   * mention of someone ("Sam says hi") is no need, and the name does not say which of their items would be meant.
   * Applies to the confident path, the fallback and the conflict ground.
   */
  quietNameOnly: boolean;
  /**
   * Span tracing (`spans.ts`): every phase of every event timed in wall and CPU time, totals kept per phase
   * (`ContextPartner.spanStats`). An `onSpan` sink turns it on too. Off: no span is made.
   */
  spans: boolean;
  /**
   * Background connector sync, "Eden Atlas" (`sync.ts`, D57): each active user's sources that can list (`Source.list`)
   * are read into the user's cache in the background, and a lookup answers from that local index the sources whose
   * synced copy is current, live-calling only the rest. Its probes and its own search of a current source cost no
   * call. The `sync*` settings below apply only with it on.
   */
  sync: boolean;
  /** Items synced per user, the newest across their sources (the cache's `maxSyncedPerUser` should allow them). */
  syncMaxItems: number;
  /** Items asked per listing page. */
  syncPageSize: number;
  /** Timed polls of an active user's sources this often (ms); 0 polls only on demand (`syncOnDemand`). */
  syncEveryMs: number;
  /** A synced source is stale once the chance it changed since its last poll (its learned rate) reaches this. */
  syncStaleChance: number;
  /** ... or once its last poll is this old (ms). */
  syncMaxStaleMs: number;
  /** A user with an event this recently (ms) is active: timed polls and sweeps run only for them. */
  syncActiveMs: number;
  /** Each source of an active user is re-listed whole this often (ms): what it no longer lists is dropped. */
  syncSweepMs: number;
  /** A user idle this long (ms) stops being synced and their synced items are dropped (retention, D57). */
  syncDropMs: number;
  /** The sync's own budget, per (user, source): listing calls per minute. */
  syncCallsPerMin: number;
  /**
   * A lookup that finds a synced source stale polls it (at most `syncCatchupPages` pages, within its deadline) and
   * then answers from the local index, rather than sending the source its search and probes.
   */
  syncOnDemand: boolean;
  /**
   * With `syncOnDemand`: an event's lookup does not wait for that poll. Every warm synced source answers from the
   * index as it stands while the poll runs behind; the agent's asks still wait for it (docs/research/econ-judge.md).
   */
  syncPollBehind: boolean;
  syncCatchupPages: number;
  /** Users synced per tenant; past it the tenant's least recently active user stops being synced. */
  syncMaxUsersPerTenant: number;
  /** A local answer holds every word of its query, as a mail or chat search does (false: ranked, any word). */
  syncLocalAll: boolean;
  /** Probes of a current synced source go to every synced source (they cost no call), not only the routed ones. */
  syncWide: boolean;
  /**
   * With sources answered locally, up to this many of the request's rare words (a place, a reference: on few of the
   * user's items) are each sent alone to them as a probe, at no call; their finds get the probes' seats. 0: none.
   */
  syncTermProbes: number;
  /**
   * Push (`SyncManager.notify`, `ContextPartner.sourceChanged`; docs/research/econ-background.md): a synced source
   * whose connector sends change notices (Gmail watch, Calendar push, Slack Events, relayed by the tenant) is current
   * until a notice arrives, read with one incremental poll, and swept only every `syncPushSweepMs`. Off: notices are
   * ignored and every source is polled as D57 says.
   */
  syncPush: boolean;
  /** A pushed source with no notice and no poll for this long (ms) is polled anyway (a lapsed watch). */
  syncPushMaxStaleMs: number;
  /**
   * A pushed source's sweep, for deletes its notices did not name, this often (ms). It is also what re-lists a quiet
   * source's older items, so it stays at most half the cache's `syncTtlMs` (7 days): a sweep spans many ticks on a
   * large source, and an item not re-listed within `syncTtlMs` lapses from the cache.
   */
  syncPushSweepMs: number;
  /** A pushed source with an unread notice is polled in the background at most this often (ms; 0: every tick). */
  syncPushGapMs: number;
  /**
   * A per-user knowledge graph over every cached item (`kg.ts`; docs/research/moon-graph.md): people, organisations,
   * projects and systems, identifiers, channels, roles and days, joined by typed edges. A lookup walks it from the
   * request's names, ids, roles and days (spreading activation, `graphBudgetMs` at most, no model, no source call);
   * what it reaches with zero shared words ("Ahmed Hassan" to "Umbrella Health" through his address) is a candidate:
   * `graphSeats` seats with the judge, a tie for `judgeTied`, and, with `groundConflict`, the conflict test with the
   * names it was reached through as ties. Edge-type weights are learned per user from delivered items' use.
   */
  graph: boolean;
  /** Items a graph walk returns at most. */
  graphItems: number;
  /** Judge seats for the walk's finds, beyond the best scored and the probes'. */
  graphSeats: number;
  /** Items the conflict ground delivers from the walk at most, with no model's say (the best walked first). */
  graphGround: number;
  /**
   * The walk's best conflict is delivered beside the request's own conflicts too, not only when there are none
   * (`graphGround` of them, within `maxItemsPerInjection`).
   */
  graphMerge: boolean;
  /** The user's edge-type weights learn from whether what the graph reached was used (`UserGraph.learn`). */
  graphLearn: boolean;
  /** A walk's hard time bound (ms): past it, it returns what it has. */
  graphBudgetMs: number;
  /** The least activation a walked item needs. */
  graphFloor: number;
  /** A walked item reached by a name is tied, in the conflict test, by the request's own words too. */
  graphWordTies: boolean;
  /** The walk starts from the days the request names too (reaching items whose blocking statements cover them). */
  graphDays: boolean;
  /**
   * Implication cards (`cards.ts`; needs `PartnerDeps.cards`): items entering the cache are read in the background by a
   * cheap model into small structured cards (the constraint, the actions it affects, its span and limit); at request
   * time, with no model, a cached item whose card bears on the request's actions is a candidate, and, with
   * `groundConflict`, one whose span or limit the request violates is delivered (grounded "card").
   */
  cards: boolean;
  /** With `cards` and `groundConflict`, at most this many items delivered on their card alone. */
  cardItems: number;
  /**
   * With `cards`: the enrichment's economy preset (`ECONOMY_CARD_LIMITS`, docs/research/econ-background.md). A strict
   * prefilter (footers and a reply's subject out), one card for items saying the same constraint sentences, and
   * twenty items per call. The card of every item still read is made by the same prompt; only which items are read,
   * and how many per call, change.
   */
  cardsEconomy: boolean;
  /** Probe parts switched off, for ablations: "day", "people", "org", "topic", "seats", "clash". */
  probeOff: string[];
  /**
   * Anticipation (`anticipate.ts`; docs/research/moon-anticipate.md): each event (a user message, a draft the user is
   * still typing, a tool call or result, an arriving message) is read, with no model, for what the agent will need next
   * (the names it mentions, the days it schedules, its action class, the names that followed that intent before for
   * this user), and those are fetched in the background through the probes' own queries, so the request's probes find
   * them in the memo at no call. A request is then first decided from the cache, on the critical path and with no
   * call (what is sure, or with no model what the request's structure grounds); the live search still runs behind it
   * and adds only what is sure or grounded. The action class's constraint vocabulary is fetched off the critical path
   * and read from the cache at the request (`consequence.ts`), whatever `consequenceProbe` says.
   */
  anticipate: boolean;
  /** Source calls one event's anticipation may make (the class query, one call, is counted on top). */
  anticipateCalls: number;
  /** Source calls a session's anticipation may make in all. */
  anticipateSessionCalls: number;
  /** Anticipation parts switched off, for ablations: "serve", "class", "learn", "names", "days". */
  anticipateOff: string[];
  /** Cost reserved per judge call before the real cost is known: about its worst case at the cap (D45). */
  estimatedCallUsd: number;
  /** Cost reserved per model-composed ask answer (`askWithModel`): about its worst case at its cap (D45). */
  estimatedAnswerUsd: number;
  /**
   * Characters of an event the engine reads (the head; the rest is ignored). The protocol accepts up to 1,000,000,
   * and redaction, tokenizing and usage checks are linear in it: without this, one large tool result costs every
   * session on the process milliseconds of CPU, and the cue it yields is no better than the head's.
   */
  maxEventChars: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  confidentScore: 1.1,
  candidateScore: 0.3,
  entityBonus: 0.35,
  minMatchedTerms: 2,
  fallbackMatchedTerms: 3,
  fallbackScore: 0.8,
  fallbackAgree: false,
  fallbackAsks: false,
  fallbackAgreeScore: 0.6,
  maxItemsPerInjection: 3,
  refreshAfterMs: 2 * 3_600_000,
  maxRefreshes: 0,
  maxInjectionBytes: 1_200,
  lookupSources: 3,
  askSources: 6,
  sourceTimeoutMs: 1_500,
  judgeCandidates: 6,
  askWithModel: false,
  windowEvents: 12,
  ledgerCooldownTurns: 40,
  cueCooldownTurns: 6,
  usageWindowTurns: 6,
  maxSessionsPerTenant: 5_000,
  sessionIdleMs: 2 * 3_600_000,
  maxSeenTokens: 5_000,
  maxCues: 200,
  maxSessionTerms: 20_000,
  estimatedCallUsd: 0.0005,
  estimatedAnswerUsd: 0.0015,
  probes: false,
  compactInjection: false,
  compactItemBytes: 320,
  compactNovel: false,
  probeGraceMs: 100,
  probeMemoMs: 10 * 60_000,
  probeCalls: 8,
  probeWhen: "always",
  probePeopleSources: 3,
  probeTopicSources: 8,
  probeTopicAlone: false,
  probeFresh: false,
  probeFreshFloor: 0.15,
  probeYield: false,
  probeYieldFloor: 0.05,
  consequenceProbe: false,
  consequenceSources: 1,
  probeRoles: false,
  probeShare: false,
  probeSecondSources: 3,
  graph: false,
  graphItems: 16,
  graphSeats: 1,
  graphGround: 1,
  graphMerge: false,
  graphLearn: true,
  graphBudgetMs: 2,
  graphFloor: 0.15,
  graphWordTies: false,
  graphDays: true,
  probeOff: [],
  anticipate: false,
  anticipateCalls: 4,
  anticipateSessionCalls: 24,
  anticipateOff: [],
  judgeConfident: false,
  judgeBehind: false,
  judgeContested: false,
  judgeTied: false,
  judgeTiedShare: 0.03,
  judgeWindowChars: 4_000,
  judgeItemBytes: 280,
  confidentItems: 3,
  quietSettled: false,
  groundAway: false,
  groundConflict: false,
  quietClear: false,
  judgeAgreed: true,
  densePacket: false,
  recoverNames: false,
  groundOccasion: false,
  quietNameOnly: false,
  spans: false,
  sync: false,
  syncMaxItems: 3_000,
  syncPageSize: 100,
  syncEveryMs: 0,
  syncStaleChance: 0.15,
  syncMaxStaleMs: 6 * 3_600_000,
  syncActiveMs: 2 * 3_600_000,
  syncSweepMs: 24 * 3_600_000,
  syncDropMs: 7 * 24 * 3_600_000,
  syncCallsPerMin: 30,
  syncOnDemand: true,
  syncPollBehind: false,
  syncCatchupPages: 2,
  syncMaxUsersPerTenant: 1_000,
  syncLocalAll: true,
  syncWide: false,
  syncTermProbes: 0,
  syncPush: false,
  syncPushMaxStaleMs: 24 * 3_600_000,
  syncPushSweepMs: 3 * 24 * 3_600_000,
  syncPushGapMs: 0,
  cards: false,
  cardsEconomy: false,
  cardItems: 1,
  maxEventChars: 32_000,
};

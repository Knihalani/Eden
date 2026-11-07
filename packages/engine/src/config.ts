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
  /** The fallback takes two of the request's terms, not `fallbackMatchedTerms`, when the request asks or acts. */
  fallbackAsks: boolean;
  maxItemsPerInjection: number;
  maxInjectionBytes: number;
  /**
   * A cached item fetched or seen in a lookup longer ago than this is never delivered from the fast path: its cue goes
   * to the slow path, whose live search returns the source's current copy (so a moved meeting is not delivered at its
   * old time). 0 turns this off. See D40.
   */
  refreshAfterMs: number;
  /** Sources asked per proactive lookup (routing picks them). An ask uses `askSources`. */
  lookupSources: number;
  askSources: number;
  sourceTimeoutMs: number;
  /** Most candidates shown to the model judge. Bounds its input tokens. */
  judgeCandidates: number;
  /** Events kept as the session's recent window. */
  windowEvents: number;
  /** Turns before a delivered item may be delivered again. */
  ledgerCooldownTurns: number;
  /** Turns before the same cue is looked up again. */
  cueCooldownTurns: number;
  /**
   * A request that arrives while the session's slow path is busy (a judge call, a slow source) is kept, not dropped:
   * one slot per session, the latest wins, looked up once the slow path settles, and its answer queued as pending.
   * Dropped instead if the session closed, its cue is in cooldown by then, or it waited over 10 s. At most one extra
   * slow path (so one judge call, under the budget) per busy window. The kept request runs the slow path alone (no
   * `anticipate` early answer); with `syncPollBehind` it gets the follow-up on the fresh index as any lookup does.
   * Off: such a request is not looked up. Proposed D102.
   */
  slowPathQueue: boolean;
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
  /** How long a lookup waits for its probes past its own search (ms); slower ones only fill the cache. */
  probeGraceMs: number;
  /** A probe the user's lookups made this recently (ms) is answered from its cached finds, at no call. */
  probeMemoMs: number;
  /** Source calls the probes may make per lookup, on top of the lookup's own. */
  probeCalls: number;
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
  /**
   * With `compactInjection`, a packet says each occurrence once: an item that echoes one above it (the same weekday
   * and time, and no word the user's items make rare: an invitation under its calendar event, the reply that booked
   * it) is left out of the packet (`fold.ts`), and compaction drops a notification's echo of its own title, footers
   * run into a line and the user from attendee lists (`render.ts` `messageParts`).
   */
  densePacket: boolean;
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
   * `conflictVocab` (D75, docs/research/gen-proactive.md): the conflict test (`conflict.ts`) reads a wider, general
   * vocabulary: more ways to say a thing is blocked ("until further notice", "not signed", "revoked", "I'm off from",
   * "hold every send", "no new spend", "scrapped"), a standing constraint ("stopped drinking"), lifted ("released",
   * "back to normal"); idioms that are not blocks ("can't wait for Friday") and sign-off courtesies ("happy to jump on
   * a call") are not read as statements; possessives tie ("Leila's" is Leila); a day of the month alone ("till the
   * 10th") and a weekday after a date word ("until Sunday", "back Thursday") are dates; a clearance about another
   * party does not undo a conflict tied to the one the request names (a table's other rows); and more leading verbs
   * make a request an imperative for `quietNameOnly` ("Transfer", "Renew", "Raise"). Off: as D49-D55.
   */
  conflictVocab: boolean;
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
  /**
   * An incremental poll's smallest first page (0: polls read `syncPageSize` pages, as backfill and sweeps do). Set, a
   * poll's first page is twice what the source's learned change rate expects since its last poll, at least this and
   * at most `syncPageSize`. While no page reaches what was already synced, the next page tops the items asked up to
   * the next multiple of `syncPageSize` (5, 95, 100): a poll lists at most `syncCatchupPages` (or its background
   * limit) full pages' worth of items, in at most one call more. Cuts items listed on the request path (D101).
   */
  syncPollPageSize: number;
  /** A synced source is stale once the chance it changed since its last poll (its learned rate) reaches this. */
  syncStaleChance: number;
  /** ... or once its last poll is this old (ms). */
  syncMaxStaleMs: number;
  /** A user with an event this recently (ms) is active: sweeps run only for them. */
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
   * index as it stands while the poll runs behind; the agent's asks still wait for it. If the poll stores anything the
   * lookup is made again with no judge call, and an item delivered from a copy the poll changed goes out again as it
   * now reads (D65, docs/research/econ-judge.md).
   */
  syncPollBehind: boolean;
  syncCatchupPages: number;
  /** Users synced per tenant; past it the tenant's least recently active user stops being synced. */
  syncMaxUsersPerTenant: number;
  /** A local answer holds every word of its query, as a mail or chat search does (false: ranked, any word). */
  syncLocalAll: boolean;
  /**
   * On in the default (D125). With `sync`, a source whose integrator forwards its change notifications
   * (`Source.notifies`, `ContextPartner.sourceChanged` / `sourceItems`) is polled when told it changed (by the next
   * lookup that reads it) and at most `syncPushMaxStaleMs` apart, not whenever its learned change rate says it may
   * have. Sources that do not notify are polled as before. The market-latency Pi runs made 3.4-3.9 sync polls per
   * task, each a billed call on a per-call connector platform (docs/research/eden-market-effect.md).
   */
  syncPush: boolean;
  /**
   * With `syncPush`: how long (ms) a notifying source's copy stands with no notification before it is polled anyway,
   * the bound on a lost notification. The daily sweep (`syncSweepMs`) re-reads it too.
   */
  syncPushMaxStaleMs: number;
  /**
   * Every item about to be delivered (a packet or an `ask` answer, from the slow path, the reader's push, anticipation
   * or the action firewall) whose source signalled a change after the copy was read (`Sync.signalledSince`, with
   * `syncPush`) is fetched again by its ref first (`SourceFanout.fetchChecked`, within `verifyTimeoutMs`, in parallel;
   * a reader's likely picks are re-read beside its call). A changed copy is stored and delivered in its place; one the
   * source no longer has (`gone`, only from a source with `fetchReportsGone`) is dropped from the cache and not
   * delivered; one that could not be checked is delivered as held. The fast path, which may not call a source, hands
   * such items to the slow path. Each check is one connector call; with no signal nothing is re-read (D126).
   */
  verifyDelivery: boolean;
  /** With `verifyDelivery`: each re-read's deadline (ms); past it the item is delivered as held. */
  verifyTimeoutMs: number;
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
  /**
   * An ask gathers the lookup's candidates (consequence probe, graph walk, card finds) and answers first with those
   * carrying a rule path's verdict: a conflict about the question, a binding graph conflict, a consequence find in
   * conflict, a violated card (D73, docs/research/gen-ask.md). Off by default.
   */
  askVerdicts: boolean;
  /** With `compactAsk`: each item of an ask's answer at most this many bytes. */
  askItemBytes: number;
  /** The ranked candidates whose facts the lab's candidate dump holds (`onCandidates`), best first. */
  decideCandidates: number;
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
  /**
   * Characters of an event the engine reads (the head; the rest is ignored). The protocol accepts up to 1,000,000,
   * and redaction, tokenizing and usage checks are linear in it: without this, one large tool result costs every
   * session on the process milliseconds of CPU, and the cue it yields is no better than the head's.
   */
  maxEventChars: number;
  /**
   * The action firewall (`checkAction`, `firewall.ts`; docs/research/econ-firewall.md): an agent's tool call is checked
   * before it runs, with no model and no source call, against what is held: the request and the call's structured
   * arguments (their days, times, amounts, names and references) read as one cue through the conflict test, the graph,
   * the cards and the calendar. A finding is returned as data; otherwise `proceed`. Off: `checkAction` always proceeds.
   */
  actionCheck: boolean;
  /**
   * `ask` answers compacted as packets are (D76; docs/research/gen-tokens.md): each item cut to the parts that bear on
   * the question (`compactText`), at most `askItemBytes`, rather than said whole up to the answer's 4 KB. The items and
   * their order are unchanged; only how much of each the agent reads. Off: answers say each item whole.
   */
  compactAsk: boolean;
  /**
   * An `ask` answer does not repeat what this session's packets and answers already showed the agent (D77): an item
   * shown before is said by its title alone with "(shown above)", or with only the parts not shown before. Words shown
   * are kept per session (`Session.shown`, bounded), never across sessions or users.
   */
  askDedup: boolean;
  /**
   * Compaction (packets and `compactAsk` answers) reads a quoted thread's earlier messages past the signature of the
   * message quoting them, and a table flattened to one line by its rows (D78, `messageParts`). Without it a quoted
   * sign-off ("— O") hides the rest of a thread, and a one-line table longer than an item's room is dropped whole.
   */
  compactParts: boolean;
  /**
   * The intent index (D87, docs/research/edge-intent.md; needs `cards` and `PartnerDeps.cards`): the background card
   * call also writes, per item, up to four requests the item would change, in a user's words, and items the card
   * prefilter rejects are read for theirs. They are indexed per user apart from the item's text (`intent.ts`). At
   * request time, with no model, the request is matched against them: the best matches (`intentHits`) join the
   * candidates a lookup ranks and the judge's seats (`intentSeats`), and an `ask` fuses them into its answer by
   * reciprocal rank (`intentWeight`). An item found only so is a candidate, never a no-model delivery: the rule paths
   * still read its own words, and its card if it has one.
   */
  intent: boolean;
  /**
   * On in the default (D125). With `intent`, an item the card prefilter rejects is read for its requests only when a
   * person wrote it and it is recent: not automated mail (`automated`, cards.ts) and dated within
   * the last `cardsLeanDays` days or upcoming. Items with constraint wording are read as before, whatever their age or
   * sender. Train1–6, seeds 41–42: 62% fewer items sent to the card model (55% fewer calls), and 81 of the 85 planted
   * items the prefilter rejects still read.
   */
  cardsLean: boolean;
  /** With `cardsLean`: how old (days, by its date or its start) an unconstrained item may be and still be read. */
  cardsLeanDays: number;
  /**
   * Items the intent index may add to a request's candidates, best first. The default's 12/0.2/1 (with the two
   * below) is D159's arm, promoted by D179 on a Pi held-out 13 pair with intent replayed
   * (docs/research/edge-intent.md).
   */
  intentHits: number;
  /** The least share of the request's (known) idf an item's requests must hold to count as a hit. */
  intentMinCoverage: number;
  /** ... and the least distinct request terms they must hold. */
  intentMinMatched: number;
  /**
   * On in the default (D200; docs/research/fix-s3a-intent.md): an intent hit whose item holds a constraint card (any
   * kind but `none`) counts from `intentCardCoverage` of the request's idf instead of `intentMinCoverage`, and up to
   * `intentCardHits` such hits left out by the `intentHits` cut (a second search, 3x `intentHits` deep) are kept
   * after the others (`keepIntents`, intent.ts). On train, the hits under the thresholds or past the cut that held a
   * constraint card were mostly hidden facts, the uncarded ones mostly decoys. Paid replay on train: hidden 311 to
   * 315, decoys 137 to 133; Pi held-out 13+14: hidden raised +2.3 points (not significant), false concerns unchanged
   * pooled.
   */
  intentByKind: boolean;
  /** With `intentByKind`: the least share of the request's idf a constraint-carded item's requests must hold. */
  intentCardCoverage: number;
  /** With `intentByKind`: constraint-carded hits kept past the `intentHits` cut, at most. */
  intentCardHits: number;
  /** The intent list's weight in an ask's reciprocal-rank fusion, against the lexical order's 1. */
  intentWeight: number;
  /** Judge seats kept for intent hits the lexical ranking did not seat (with a model). */
  intentSeats: number;
  /**
   * The ask-time model reader (D95, `reader.ts`): for an `ask` about an action, one budgeted model call reads the top
   * `askReaderPool` candidates the ask already ranked (compact, redacted, fenced as data) and says which would block,
   * limit or change the request, or show it done; those lead the answer, each with a short bearing, and the usual
   * items fill the seats left. Fails open (budget, error, unreadable output, `askReaderWaitMs`): the usual answer.
   * Verdicts are cached per user and session. Needs a reader in the deps; with none, nothing changes.
   */
  askReader: boolean;
  /** How many of the ask's ranked candidates the reader reads (capped at `READER_MAX_ITEMS`, 60). */
  askReaderPool: number;
  /** How long an ask waits for the reader (ms); past it, the usual answer (the call still fills the cache). */
  askReaderWaitMs: number;
  /**
   * With `askReader`: the items the reader named and judged not to bind (a lookalike, another thing of the same kind,
   * or a rule lifted or ended) leave the ask's answer, so a decoy the search found is not handed to the agent beside
   * the item that binds. Only items the model read and rejected by name; an item it did not mention stays.
   */
  askReaderDrop: boolean;
  /**
   * With `askReader`: a user request that acts is also read by the reader, as an ask of the engine's own over the
   * request, and the items it flags are queued as a proactive packet (an agent that never calls `ask_context` still
   * gets the reading). The observe waits for it within its own wait; later, it is taken before the next model request.
   * One reader call per acting request, budgeted and cached as an ask's; off by default.
   */
  readerPush: boolean;
  /** The characters of each item's most relevant parts the reader reads (`READER_ITEM_CHARS`, 400, is the most). */
  askReaderItemChars: number;
  /** With `readerPush`: the reader's kinds pushed unasked (`askReader` still shows every kind in an ask's answer). */
  readerPushKinds: string[];
  /**
   * With `readerPush`: the most `observe` waits for the push (ms), within the caller's own wait. 0: never; the reading
   * runs beside the agent's first model request and its packet is taken before the next one.
   */
  readerPushWaitMs: number;
  /**
   * With `readerPush`, `syncOnDemand` and `syncPollBehind`: the push's own lookup does not wait for the sync's poll
   * either (the agent's asks still do). It reads the index as it stands, so its reader starts about one poll sooner
   * (audit 2026-11-03b, lat-push-read-waits-poll). If the poll then stores anything, the push is ranked once more on
   * the fresh index with no new source call and read again (a reader cache hit, no call, when its pool is unchanged);
   * a packet the first reading queued and the agent has not taken is replaced, not joined by a second one. Off by
   * default; no decision yet.
   */
  readerPushBehind: boolean;
  /**
   * With `askReader`: no reader call when none of the request's candidates could constrain it (no card of a
   * constraint, state-change or already-done kind, no constraint wording).
   */
  readerGate: boolean;
  /**
   * With `readerGate`: a candidate stating an arranged visit or asking that someone be in (`arrangedVisit`,
   * conflict.ts: "i've booked the engineer, he'll come thursday between 8 and 12") also opens the gate, which no card
   * kind or constraint word reads (R3-19; on in the default, D124, amending D122).
   */
  readerGateVisits: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  confidentScore: 1.1,
  candidateScore: 0.3,
  entityBonus: 0.35,
  minMatchedTerms: 2,
  fallbackMatchedTerms: 3,
  fallbackScore: 0.8,
  fallbackAsks: true,
  maxItemsPerInjection: 3,
  refreshAfterMs: 2 * 3_600_000,
  maxInjectionBytes: 1_200,
  lookupSources: 3,
  askSources: 6,
  sourceTimeoutMs: 1_500,
  judgeCandidates: 6,
  windowEvents: 12,
  ledgerCooldownTurns: 40,
  cueCooldownTurns: 6,
  slowPathQueue: true,
  usageWindowTurns: 6,
  maxSessionsPerTenant: 5_000,
  sessionIdleMs: 2 * 3_600_000,
  maxSeenTokens: 5_000,
  maxCues: 200,
  maxSessionTerms: 20_000,
  estimatedCallUsd: 0.0005,
  probes: true,
  compactInjection: true,
  compactItemBytes: 320,
  probeGraceMs: 0,
  probeMemoMs: 10 * 60_000,
  probeCalls: 8,
  probePeopleSources: 3,
  probeTopicSources: 8,
  probeTopicAlone: true,
  probeFresh: true,
  probeFreshFloor: 0.15,
  probeYield: true,
  probeYieldFloor: 0.05,
  consequenceProbe: true,
  consequenceSources: 1,
  probeRoles: true,
  probeShare: true,
  probeSecondSources: 3,
  graph: true,
  graphItems: 16,
  graphSeats: 1,
  graphGround: 1,
  graphMerge: true,
  graphLearn: true,
  graphBudgetMs: 2,
  graphFloor: 0.15,
  graphDays: true,
  probeOff: [],
  anticipate: true,
  anticipateCalls: 4,
  anticipateSessionCalls: 24,
  anticipateOff: [],
  judgeContested: true,
  judgeTied: true,
  judgeTiedShare: 0.03,
  judgeWindowChars: 4_000,
  judgeItemBytes: 200,
  confidentItems: 3,
  quietSettled: true,
  groundAway: true,
  groundConflict: true,
  quietClear: true,
  densePacket: true,
  groundOccasion: true,
  quietNameOnly: true,
  conflictVocab: true,
  spans: false,
  sync: true,
  syncMaxItems: 3_000,
  syncPageSize: 100,
  syncPollPageSize: 5,
  syncStaleChance: 0.15,
  syncMaxStaleMs: 6 * 3_600_000,
  syncActiveMs: 2 * 3_600_000,
  syncSweepMs: 24 * 3_600_000,
  syncDropMs: 7 * 24 * 3_600_000,
  syncCallsPerMin: 30,
  syncOnDemand: true,
  syncPollBehind: true,
  syncCatchupPages: 2,
  syncMaxUsersPerTenant: 1_000,
  syncLocalAll: true,
  syncPush: true,
  syncPushMaxStaleMs: 24 * 3_600_000,
  verifyDelivery: true,
  verifyTimeoutMs: 1_500,
  cards: true,
  cardsEconomy: true,
  cardItems: 1,
  askVerdicts: true,
  askItemBytes: 320,
  decideCandidates: 64,
  maxEventChars: 32_000,
  actionCheck: false,
  compactAsk: true,
  askDedup: true,
  compactParts: true,
  intent: true,
  cardsLean: true,
  cardsLeanDays: 30,
  intentHits: 12,
  intentMinCoverage: 0.2,
  intentMinMatched: 1,
  intentByKind: true,
  intentCardCoverage: 0.1,
  intentCardHits: 4,
  intentWeight: 1,
  intentSeats: 1,
  askReader: true,
  askReaderPool: 15,
  askReaderWaitMs: 2_500,
  askReaderDrop: true,
  readerPush: true,
  askReaderItemChars: 240,
  readerPushKinds: ["blocks", "limits", "changes", "done"],
  readerPushWaitMs: 60_000,
  readerPushBehind: true,
  readerGate: true,
  readerGateVisits: true,
};

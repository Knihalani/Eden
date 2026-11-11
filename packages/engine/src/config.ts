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
  /** A packet's size cap. */
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
  /**
   * 8 in the default (D263): with `syncOnDemand`, a lookup over more than this many sources polls only the stale ones
   * among the top this-many by routing (its own search's and its probes' best sources); a warm source past them
   * answers from the index as it stands, as under `syncPollBehind`, until a lookup routes to it or the sweep re-reads
   * it. A user with 1,000 connectors otherwise had every stale one polled by whichever lookup came next. 0: every
   * stale source.
   */
  syncPollWidth: number;
  /** Sources whose backfill pages are read at once, newest unread first (1: one at a time; 8 in the default, D262). */
  syncBackfillLanes: number;
  /**
   * On in the default (D328, promoted by D370): a page the background sync listed (backfill, sweep, the pages a poll
   * reads in the background after a lookup stopped waiting; never what a lookup's on-demand poll waits for) is
   * redacted and stored only at its turn: at most one such page per turn of the event loop, the others waiting
   * (`SyncManager.turn`). A cold-start storm's pages otherwise arrive together and are stored back to back, and every
   * request waits behind them all. The card drain gathers the pages still waiting before it calls (D370,
   * `CardEnricher.gather`), so its batches do not shrink to one page.
   */
  syncIngestTurns: boolean;
  /**
   * On in the default (D751, D753, promoted by D755; part `sync`): a user the sync has not seen starts their
   * backfill with their first event (`SyncManager.kick`), not at the sync's next tick (`startSync`, every 60 s),
   * and it goes on without the ticks. A new user's first requests otherwise run on live searches alone, with no
   * cards and no intent index, for up to a minute.
   */
  syncKick: boolean;
  /**
   * With `syncKick` (D751): pages a kicked user's backfill reads at once, as a pool (a lane takes the next source as
   * soon as it is free; `syncBackfillLanes` reads batches and waits for each batch's slowest page). Each lane is
   * another source, under that source's own budget and guards. 0: the ticks' batches. Only a kicked step reads so:
   * a tick's step for the same user reads batches.
   */
  syncKickLanes: number;
  /**
   * With `syncKick` (D753): a backfill page that fails for the first time is tried again after this long (ms); a
   * second failure in a row waits 30 s and it doubles from there, as every failure does without it. A new user's
   * lookups wait on each source's first page, and a failed one otherwise holds them 30 s. 0: 30 s from the first.
   */
  syncKickRetryMs: number;
  /**
   * On in the default (D264): a synced source answers a lookup from the local index only when the user's copy holds
   * all of it; one cut at `syncMaxItems` (the backfill stopped before its listing ended, or a trim dropped some of its
   * items) is searched live, as an unsynced source is. Off: a cut copy answers from the index and misses what is
   * older.
   */
  syncLocalComplete: boolean;
  /**
   * On in the default (D405, D406, B1; docs/research/b1-scale-path.md). With `syncLocalComplete`, on a lookup that
   * does not wait for its poll (`syncPollBehind`: observe's slow-path lookup and the push's pass): a warm copy the cap
   * cut answers from the index as it stands, and the live search D264 would wait for runs behind, with the same query,
   * planner and deadline; the probes keep D264 (they are not waited for). What it stores reaches the agent as a
   * poll's does: the lookup's follow-up (`afterPoll`) and the push's second reading (`readerPushBehind`), re-checked
   * like any delivery. A follow-up starts no second search; an explicit ask keeps D264. Off: D264 on the push too,
   * which waited ~1.1 s a task for connectors at 1,000 sources.
   */
  pushCutBehind: boolean;
  /**
   * On in the default (D430, D431, C4; docs/research/c4-ask-path.md). With `pushCutBehind`: an explicit ask's lookup
   * runs as the push's does (a warm copy answers as it stands; the on-demand poll and the cut copies' live searches
   * run behind, joining any read of the same source already in flight), and the ask waits at most `askBehindWaitMs`
   * for that work. Done in time: the ask ranks on the refreshed index, as with D264. Not: it answers from what is
   * held, names the sources still being read (status "searching", never an all-clear, D127), and what that work then
   * stores which the ask would cite goes to the agent as a packet at its next take. Off: the ask waits for its poll
   * and searches cut copies live (D127, D264), ~1.4 s an ask at 1,000 sources (~3 ms at five).
   */
  askBehind: boolean;
  /**
   * With `askBehind`: how long an ask waits for its poll and cut copies' searches before answering from what is held.
   * 0 (C4's screens: at market latency the work never settled within 300 ms, and the wait was the ask's whole time).
   */
  askBehindWaitMs: number;
  /**
   * On in the default (D505, D509, N1; docs/research/n1-calls.md). With `sync`: each of a user's sources keeps a run
   * of the live reads it answered since one of its items last reached the agent (`source-yield.ts`). A warm synced
   * copy is not read live (no search of its cut copy behind, no probe, and with `sourceYieldPolls` no on-demand
   * poll; it answers from what is held, and an ask names it "not searched") when its own run is at `sourceYieldRun`
   * or more and the request has no strong evidence for it, or by `sourceYieldEarn` below. Runs halve every
   * `sourceYieldHalfLifeMs`, so sources are tried again. The pooled rates of D505 (`sourceYieldFloor`,
   * `sourceYieldWords`) were replaced by `sourceYieldEarn` and deleted (D603).
   */
  sourceYield: boolean;
  sourceYieldRun: number;
  sourceYieldHalfLifeMs: number;
  sourceYieldPolls: boolean;
  /**
   * On in the default (D600, promoted by D603; O1, docs/research/o1-earn.md). With `sourceYield`: a source earns
   * its live reads on weak evidence. A warm copy none of whose items has ever reached the agent is read live only on
   * strong evidence: a name its items mentioned, or a word of the request that at most `sourceYieldRare` (1 or 2) of
   * the user's sources hold, read from the user's table of rare words (`RareTerms`, at most 1 MB; 0: names only).
   * It acts from a user's first request. A source with an item used is read as before (`sourceYieldRun`), and a
   * rare word counts as a name for its run too. At about 1,000 sources: 23 → 5.5 connector calls a task one request
   * a session and 7.3 → 2.4 over a user's days, hidden facts level (D603).
   */
  sourceYieldEarn: boolean;
  sourceYieldRare: number;
  /**
   * On in the default (D601, promoted by D603; O1, docs/research/o1-earn.md), both with `sourceYieldEarn`.
   * `sourceYieldNames` (0: off): a
   * name more than this many of the user's sources mention is weak evidence for a source with nothing used (a
   * teammate's name is in hundreds of tickets and channels); it stays strong for a source with an item used.
   * `sourceYieldEngage`: a source the request reads nothing live of (`spentSources`) is not marked used by it
   * (`Sync.engage`), so it gets no deep copy, no daily sweep and no card call on that request's account.
   */
  sourceYieldNames: number;
  sourceYieldEngage: boolean;
  /**
   * On in the default (D265): routing adds, for each source, log2(1 + its items among the request's best matches in
   * the user's own index) to its score, so a source whose items share the request's words is searched and probed
   * first when a user has more sources than a lookup searches. No call. Off: names a source mentioned, and learned
   * usefulness, alone.
   */
  routeLocalHits: boolean;
  /**
   * On in the default (D321). The sync keeps each user to `syncMaxItems` after the backfill too: background polls and
   * sweeps store no dated item older than the user's cut (that source's copy is then cut, D264; a lookup's own poll
   * still stores past it), the user's synced items are trimmed back to the cap at 1.5x it, and a sweep stops once it
   * has listed every id it holds for the source. Off: a sweep of a source the cap emptied lists it to `syncMaxItems`
   * and stores it all, and polls store past the cap, so a user with 1,000 connectors churned the cache's synced cap
   * every day (A1 #8, #9).
   */
  syncKeepCut: boolean;
  /**
   * On in the default (D322). With `sync`, each source keeps a vocabulary sketch of what the sync listed from it (a
   * Bloom filter of its terms, 128 B to 4 KB, `sketch.ts`), kept after the cap trims the items; a lookup over more
   * sources than it searches adds, per source, log2(1 + the request's terms the sketch holds, weighted by how few
   * sources hold each) to routing (`RouteRequest.boost`, beside `routeLocalHits`). A sketch match routes a search but
   * does not make a source used (`Sync.engage`).
   */
  routeSketch: boolean;
  /**
   * On in the default (D323). With `sync`: a source a lookup of the user's routed to on evidence of its items (a name
   * it mentioned, `routeLocalHits`) is used (`Sync.engage`, the 64 most recent a user); if the cap cut its copy, it
   * is read again from the top (two pages a tick, up to half `syncMaxItems`), and the user's trim keeps used sources'
   * newest items first, up to half the cap in all, so the copy of a source the user uses becomes whole and answers
   * from the index (D264). With 1,000 connectors the cap is filled by the newest items across all of them, and the
   * user's own mailbox kept a handful.
   */
  syncEngagedDeep: boolean;
  /**
   * On in the default, a week (D356; 0: off, every source swept daily). With `sync` and `verifyDelivery`: a source
   * the user does not use (not `Sync.engage`d, D320) whose connector can fetch an item by ref is swept (re-listed whole
   * for deletes) this often (ms) instead of every `syncSweepMs`. In return, a copy of a source's items that a sweep the
   * trial skipped left unvouched for longer than `syncSweepMs`, or that the last sweep did not list, is in doubt
   * (`doubted`): every delivery or citation re-reads it first (D126; strict for asks, D211), and one the re-read does
   * not confirm (a null that proves nothing, an error) is not delivered and makes the source's sweep due at the next
   * tick. At 1,000 sources the daily sweep was ~1,100 listing calls a user a day (D324).
   */
  syncUnusedSweepMs: number;
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
   * Every item about to be delivered (a packet or an `ask` answer, from the slow path or the reader's
   * push) whose source signalled a change after the copy was read (`Sync.signalledSince`, with
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
  /** With `compactAsk`: each item of an ask's answer at most this many bytes. */
  askItemBytes: number;
  /** The ranked candidates whose facts the lab's candidate dump holds (`onCandidates`), best first. */
  decideCandidates: number;
  /** Probe parts switched off, for ablations: "day", "people", "org", "topic", "seats", "clash". */
  probeOff: string[];
  /** Cost reserved per judge call before the real cost is known: about its worst case at the cap (D45). */
  estimatedCallUsd: number;
  /**
   * Characters of an event the engine reads (the head; the rest is ignored). The protocol accepts up to 1,000,000,
   * and redaction, tokenizing and usage checks are linear in it: without this, one large tool result costs every
   * session on the process milliseconds of CPU, and the cue it yields is no better than the head's.
   */
  maxEventChars: number;
  /**
   * On in the default (D205; part `freshness`): an item this session was handed (a packet taken, an ask's answer)
   * that is stored again with other words (a sync poll, a notice carrying items, a re-read) is sent once more as an
   * "updated:" packet, once per revision, queued for the agent's next take. A change notice for a source a session
   * holds a handed copy from polls it at once in the background (no request waits on it), so the packet is usually
   * queued before the next request. Off: the agent keeps the version it was handed until a lookup happens to deliver
   * the new one.
   */
  revisionNotice: boolean;
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
  /**
   * With `cardsLean`: how old (days, by its date or its start) an unconstrained item may be and still be read. 7 since
   * D244 (30 before): a new user's enrichment cost 58% less ($0.0208 to $0.0088, 22 calls to 8) with hidden facts
   * surfaced 313 to 321 and decoys 127 to 129 (train1-6, seeds 41-42, paid reader; docs/research/cl-cl3.md).
   */
  cardsLeanDays: number;
  /**
   * On in the default (D482, promoted by D483; F2, docs/research/f2-quality.md). The card queue is read best first
   * rather than as it filled (`orderQueue`, cards.ts): items with constraint wording first, then events ahead, mail
   * from people the user writes to and items of the last three days, so a new user's first requests meet cards for
   * the items most likely to bear on them. Once every waiting item is read the cards are the same (the funnel reads
   * the same with it on and off); with four card calls made per new user, Pi raised +9.0 points more hidden facts
   * (+6.6..+11.4, n 1,536, train, seeds 41–48, cards made in-run by Haiku).
   */
  cardsOrder: boolean;
  /**
   * With `cards` (N4, D521, D522; docs/research/n4-agents.md): how many card calls one user may have in flight
   * (`CardEnricher.lanes`; 1: one batch at a time). One lane reads a new user's backfill of about sixteen calls in
   * about sixteen call times, and requests in that window meet cards for part of the items. With more lanes a full
   * batch still waiting behind a call in flight is sent beside it: the same batches and the same calls, read sooner.
   * At the moment one lane has made four calls, four lanes raised +4.3 points more hidden facts on Pi (+1.0..+7.8,
   * n 784, train, seeds 45–48, cards made in-run by Haiku); two lanes +2.4 (−0.8..+5.7). Measured with a call cap
   * standing in for time (K lanes given K times the calls), not with requests interleaved in real time.
   */
  cardsLanes: number;
  /**
   * On in the default (D320). With `cards` and `sync`, for a user with more than 32 synced sources: a synced item is
   * read by the card model only when its source is one the user's lookups use (`Sync.engage`), or it names a name the
   * user's lookups named. The rest stay unread, uncovered, until their source is used, when its held items are read.
   * With 1,000 connectors most of what the sync stores is from sources the user never asks about, and each was carded
   * (30x a five-source user's card calls, A1).
   */
  cardsSourceAware: boolean;
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
  /**
   * D192 (on in the default; reopens D134): with `verifyDelivery`, no doubted candidate is re-read beside the reader's
   * call (`checkAhead`); a delivery re-reads only the items it cites, after the reader named them (`verifyItems`).
   */
  readerVerifyAfter: boolean;
  /**
   * D193 (on in the default): with `readerPush`, an ask in the same request as the push (no newer user message), read
   * against that same request (not an action of its own), reuses the push's reading instead of a call of its own: the
   * push's verdicts on the items both pools hold, unchanged in content, lead the answer; an item the push did not read
   * keeps its rule order. A push that gave no verdict (gated, failed) leaves the ask to read as usual; one still out
   * past the ask's wait leaves the ask answered without the reader, with no call.
   */
  readerReuse: boolean;
  /**
   * D240 (on in the default): with `askReader`, the reader's reply stops at the first entry the model says is not
   * about the request's own thing (`READER_STOP`). Binding entries come first, so what is cut is the look-alikes after
   * the first one, which it would only reject: half the output tokens, about 250 ms less per reading.
   */
  readerStopEarly: boolean;
  /**
   * `pushCandidates` (D236, promoted by D237; CL6 H19 "the agent is the reader"): with `readerPush`, the push makes no
   * reader call, and neither does an `ask`. The push hands the agent the first `pushCandidates` items of the pool the
   * reader would have read (the ask's order, `askReaderPool` deep, bulk mail out; none when no pooled item passes
   * `readerGate`'s constraint test), each a focused excerpt of `compactItemBytes` (at most 2,000), after a fixed line
   * of Eden's own framing them as items that may bear on the request, to be checked against its who, what and when
   * first (`CANDIDATES_LEAD`). 0 is the reader's push and asks (D95–D99).
   */
  pushCandidates: number;
  /**
   * On in the default (D375, D376, A25; part `parties`; `parties.ts`): `checkAction` holds a call that adds a party
   * (an email address, a sort code, an account number, an IBAN, in any field but amounts, dates, titles, subjects and
   * descriptions) found only in what Eden's own packets and answers showed this session: not in the user's request,
   * and no correspondent of the user's (`ItemCache.isCorrespondent`). The finding asks the agent to confirm with the
   * user; the same call made again proceeds. No model, no source call; the session keeps digests of its packets'
   * identifiers (`MAX_PACKET_PARTIES`).
   */
  partyCheck: boolean;
  /**
   * D301 (A9, on in the default; docs/research/a9-ahead.md): plan-conflict proactivity. With the
   * push and the sync on, each session keeps its last `PLAN_REQUESTS` acting requests (those the push ran for); an
   * item the sync then stores (a poll, a notice's payload) that would have been among such a request's candidates
   * (`pushCandidates`' rule: the first of its pool, the pool holding something constraint-like) is queued for the
   * agent's next take as a packet naming that request (`PLAN_LEAD`), whatever the agent asks then. Once per item per
   * session; checked at the take, so its card can count; no source or model call.
   */
  planConflict: boolean;
  /**
   * `askNudge` (D316, promoted by D317; A12, `settle.ts`): with `pushCandidates`, when no candidate the
   * push hands holds every kind of anchor the request names (one of its people or things, and one of its days when it
   * names a day), the packet's fixed line adds `ASK_NUDGE`: the items may not settle who, what or when, so call
   * `ask_context` before answering. An ask in the same request then also lists the push pool's items past those handed
   * (its 6th to 15th) that hold one of the request's anchors, in at most half its `maxItems` seats (the answer still
   * cites at most `maxItems`). Inert with `pushCandidates` 0 (the config check's parents are booleans only, so
   * `{pushCandidates: 0, askNudge: true}` is accepted and does nothing; the `reader` and `candidates` parts set both).
   * Pi, train, 91 templates × seeds 41–44, Sonnet-graded: hidden raised +9.2 points (+6.0..+12.6), concerns
   * unchanged, +0.3 asks and +$0.04–0.07 per 1,000 tasks a kind, no connector call (docs/research/a12-quality.md).
   */
  askNudge: boolean;
  /**
   * D460 (M5, docs/research/m5-nudge-narrow.md; promoted by D461, on in the default, part `nudge`): a narrower
   * `askNudge`. The nudge fires only when, besides
   * leaving the request unsettled, the push pool past the handed candidates holds an item (not bulk mail) that names
   * one of the request's anchors: what the ask's deeper look would list. With nothing anchored past the handed items
   * an ask has nothing deeper to show, and at $0 (train 41–44) the planted fact was already handed in 322 of the 421
   * hidden tasks the nudge fired on; this cuts the fires to 202 hidden (34 of 43 with the fact deep in the pool kept)
   * and 423 → 231 control. Needs `askNudge`. Pi, train 41–44, short and over days, against the current nudge, every
   * hidden answer Sonnet-graded: targeted-template hidden +2.1 points (−1.3..+5.5), all hidden +0.7 (−1.8..+3.4),
   * asks −0.062 a task, −$0.005 per 1,000 tasks and −0.06 s a task (each interval below zero), concerns 0 both.
   */
  askNudgeDeep: boolean;
  /**
   * D400 (A30, docs/research/a30-token-gap.md; promoted by D404: 2 in the default, part `fewer`; 0 = off): with
   * `pushCandidates`, when the request names an anchor (a person, thing or day) and the handed candidates settle it
   * (`settle.ts`, `askNudge`'s test), the push hands only the first `pushCandidatesSettled` of them, extended through
   * the first candidate that settles the request. Why: on Pi under the house rules the agent bill's gap to the agent
   * alone is the packet's own tokens written to the prompt cache (D271, D395); a settled request may need fewer.
   * Pi, train seeds 41–42, short and over days: hidden +5.8 points (−0.6..+12.3) against 5, mix $/1k −0.008 short
   * (−0.023..+0.007) and −0.013 over days (−0.024..−0.001); funnel 314/273 unchanged.
   */
  pushCandidatesSettled: number;
  /**
   * The push check (I3, D500; compare-first reply, D527; opened pushes checked, D823; promoted by D828, part `check`;
   * docs/research/p2-push-check.md): with `pushCandidates` and a `checker` dependency (a budgeted model call on the
   * reader's model, `push-check.ts`; none without a model key, and the part is inert), a push whose pool passes the
   * candidates' constraint-like gate asks the model once, over the pool's head, which items change what the assistant
   * should do for the request; the candidates are the pool's items it names, in the pool's order (bulk mail out), the
   * first `pushCandidates` of them, and a pool it names none of sends no packet (the default's silence). A refusal,
   * an error, an unreadable reply or a reply later than `pushCheckWaitMs` leaves the unchecked candidates; a late
   * reply still serves a second pass. Pi (Haiku agent): hidden +4.7 points, +$0.18–0.21 per 1,000 tasks, +1.1 s a
   * task; with a Sonnet agent the total bill falls $0.86 per 1,000 tasks (D825, D826).
   */
  pushCheck: boolean;
  /** How long the push waits for its check before it hands the default's candidates (ms). */
  pushCheckWaitMs: number;
  /** The characters of each item's most relevant parts the check reads (200, D501; at most `READER_ITEM_CHARS`). */
  pushCheckItemChars: number;
  /**
   * How many of the pool's items, from its first, the check reads (at most `CHECK_MAX_ITEMS`); when it answers, only
   * those can be candidates.
   */
  pushCheckItems: number;
  /**
   * O3 (D702, promoted by D710; docs/research/o3-push-open.md, o3-pointer.md): with `pushCandidates`, the push also
   * runs for a message whose verb is on no list but which does not open as a question, a
   * remark or a statement (`isOpenRequest`). The candidates make no model call, so the verb lists (`isImperative`,
   * kept for the reader's paid push and the check's) guard nothing there; the candidates' own gate (a
   * constraint-like item in the pool) still decides whether a packet goes. An opened message is not kept as an
   * acting request for plan alerts (D301).
   */
  pushOpen: boolean;
  /**
   * M3 (D908; a trial, 0 = off; docs/research/m3-arch.md §7f): with a `constraintTag` dependency (a small item tagger:
   * the probability an item states a constraint rather than an all-clear), a pooled item counts as constraint-like
   * only when it passes the existing test (`constraintLike`) **and** its tag probability is at least this threshold:
   * a veto, so fewer look-alike packets go. Unwired, or a tagger that throws, vetoes nothing.
   */
  constraintTag: number;
  /**
   * M3 (D908 rule 1; a trial, 0 = off; docs/research/m3-arch.md §7f): with a `supersede` dependency (a small pair model:
   * the probability that one item replaces another), a handed candidate that a newer item of the push pool holding one
   * of the request's anchors replaces, with probability at least this, is handed as that newer item instead.
   */
  pushSupersede: number;
  /**
   * P2 (D820, promoted by D828, part `indirect`; docs/research/p2-push-check.md): the push also starts for a request
   * phrased as a need, a plan, a wish or a question about acting ("I need to pay …", "We should move …", "I want you
   * to book …", "Should I book …?", a request after a first clause of context), read as the imperative after its
   * lead-in (`indirectRest`, `pushStart`), and the open shape refuses pasted log lines and chatter openers
   * (`isOpenRequest`'s strict form). The push's lookup reads the message from where the request starts.
   */
  pushIndirect: boolean;
  /**
   * D342 (A17, promoted under D112; on in the default, part `freshness`): with `revisionNotice`, an "updated:" line
   * names the times and dates (clock times, day and month, weekdays) the session was shown for the item in earlier
   * versions that the new version no longer has: "(changed at its source …; no longer: 09:30)". Over a day the update
   * reached the agent and its recap still named the old time; this says outright which one no longer stands. No
   * model, no call.
   */
  revisionDiff: boolean;
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
  probeOff: [],
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
  syncPollWidth: 8,
  syncBackfillLanes: 8,
  syncIngestTurns: true,
  syncKick: true,
  syncKickLanes: 32,
  syncKickRetryMs: 1_500,
  syncLocalComplete: true,
  pushCutBehind: true,
  askBehind: true,
  askBehindWaitMs: 0,
  sourceYield: true,
  sourceYieldRun: 4,
  sourceYieldHalfLifeMs: 7 * 24 * 3_600_000,
  sourceYieldPolls: true,
  sourceYieldEarn: true,
  sourceYieldRare: 2,
  sourceYieldNames: 4,
  sourceYieldEngage: true,
  routeLocalHits: true,
  syncKeepCut: true,
  routeSketch: true,
  syncEngagedDeep: true,
  syncUnusedSweepMs: 7 * 24 * 3_600_000,
  syncMaxUsersPerTenant: 1_000,
  syncLocalAll: true,
  syncPush: true,
  syncPushMaxStaleMs: 24 * 3_600_000,
  verifyDelivery: true,
  verifyTimeoutMs: 1_500,
  cards: true,
  cardsEconomy: true,
  cardItems: 1,
  askItemBytes: 320,
  decideCandidates: 64,
  maxEventChars: 32_000,
  revisionNotice: true,
  compactAsk: true,
  askDedup: true,
  compactParts: true,
  intent: true,
  cardsLean: true,
  cardsLeanDays: 7,
  cardsOrder: true,
  cardsLanes: 4,
  cardsSourceAware: true,
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
  readerVerifyAfter: true,
  readerReuse: true,
  readerStopEarly: true,
  pushCandidates: 5,
  partyCheck: true,
  planConflict: true,
  askNudge: true,
  askNudgeDeep: true,
  pushCandidatesSettled: 2,
  pushCheck: true,
  pushCheckWaitMs: 1_500,
  pushCheckItemChars: 200,
  pushCheckItems: 15,
  pushOpen: true,
  constraintTag: 0,
  pushSupersede: 0,
  pushIndirect: true,
  revisionDiff: true,
};

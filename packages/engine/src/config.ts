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
   * With no model's say, a request about a subject it names ("my Lisbon flight", "the Smeg kettle") is grounded in
   * the context around it: the items about the named thing (its entity a whole word of the title, or of the text
   * beside another of the request's terms), the timed items of a day the request moves it to, and a companion the
   * context needs beside it — an item sharing a term of the request's and one of the subject's, or two of the
   * subject's (the shop's returns policy beside the order that leaks). Bound as every ground: `contradicts`, bulk
   * mail, `maxItemsPerInjection` (`Partner.subject`).
   */
  groundSubject: boolean;
  /**
   * `companions` (D1977): once a request's subject items are chosen — the grounded subject, the sources' sure
   * pick, the fallback — a bounded second pass hands the injection the companions a delivered item pulls: what
   * holds a strong link to a chosen one — the same identifier `sameRef` reads, or two of its letter terms, or one
   * of them beside a term of the request's — from the lookup's own candidates and the cache it filled (the deck
   * for the meeting, the invoice's bill in another system); with `companionSearch` the pass also asks the sources
   * once more on the picks' terms, bounded and counted with the lookup's calls. Every bound the subject's own
   * companions keep still
   * applies: `contradicts`, bulk mail, delivered/`sameRef` and near-duplicate suppression, `alreadyHas`,
   * `maxItemsPerInjection`; an item naming an identifier its linked item does not is a look-alike, never a
   * companion (`Partner.companions`).
   */
  companions: boolean;
  /**
   * `companionSearch` (D1984): the companion pass's bounded re-search — a companion the request's own words never
   * fetched sits outside the cache (the return policy beside the leaking order, the board pack beside the meeting),
   * so once the picks are chosen the pass asks the sources once more on the picks' own terms: at most this many
   * sources, one search call each, counted with the lookup's `sourceCalls`, their finds stored and then read back
   * through the cache and the same `linked` gate every companion takes; a source the sync reads is skipped (its
   * copy, or a poll in flight's, is the cache's already). 0: cache and candidates only, as before
   * (`Partner.companions`).
   */
  companionSearch: number;
  /**
   * `companionSearchMs` (D1984): serving never waits on the companion re-search — finds not back inside this
   * window still settle behind, stored for the next read. Bounds only the wait, not the call (`Partner.companions`).
   */
  companionSearchMs: number;
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
   * The tenant's pace per connector (S1-P1), shared by the tenant's users on a process: the operator's fleet-wide
   * figure divided by processes and machines, in calls a minute. Only background calls (the sync's reserved
   * listings) are held by it — a lookup's own poll, search or fetch is never held — while the connector's own
   * 429 pushes the whole tenant's background calls back, not one user's. 0: per (user, source) pacing only.
   */
  tenantCallsPerMin: number;
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
   * A static per-connector-kind routing prior (D2015, Q7(b) of docs/research/weak-points-1111.md): this many
   * pseudo-observations reshape a cold source's usefulness draw before anything is learned — the kinds
   * `SOURCE_KIND_PRIOR` lists (mail, calendar, contacts) draw from a strong posterior, every other kind from a weak
   * one (`source-prior.ts`), so a new user's first lookups search the connectors that usually answer them instead of
   * a flat draw over all of them. 0: off, a flat Beta(1,1) for every source as before. The prior yields to each
   * source's own `used`/`shown` within its first few routed calls.
   */
  sourceKindPrior: number;
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
   * On in the default (D1060, promoted by D1062; H2's D1053; docs/research/h2-requests-fix.md). With `cards` and
   * `intent`: the card prompt's first
   * example reply shows the requests list (`CARD_FORM_REQUESTS`), and a batch whose reply still left it out is asked
   * once more for its requests only (`requestMessages`, through the enricher's `Budget`). The shipped prompt left the
   * list out of about a quarter of its replies, and every item of such a batch got no requests. Pi (held-out
   * families): hidden +4.1 points (+0.5..+7.7), concerns level; funnel decoys +11 of 608 accepted by D1061.
   */
  cardsRequestsFix: boolean;
  /**
   * On in the default (F2, D1193; docs/research/f2-card-state.md). With `cards`: the card prompt asks each card for
   * its `state` (in force, lifted, met or superseded; `CARD_FORM_STATE`), judged by the card model in the same call,
   * and keeps a none card that says a constraint was lifted, met or superseded. Old cards have no state (unknown).
   */
  cardsState: boolean;
  /**
   * On in the default (F2, D1193). With `cards` and `cardsState`: the push's pool (`pushGate`) leaves out an item
   * carded none whose state says a constraint was lifted, met or superseded (`CLEARED_STATES`). An item with no state,
   * or a card of another kind, stays.
   */
  pushStateFilter: boolean;
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
   * F1 (docs/research/f1-intent-bridge.md; promoted by D1153): a request written in another language is given the
   * English words its own words mean (`glossOf`, gloss.ts: a glossary written once by a model, read with no model and
   * no call), and the push's and an ask's lookup search with them beside the request's own words, lexically and in the
   * intent index. An English request is searched as written. reworded's 36 non-English templates, seeds 41–44 (push
   * check served by subagents): hidden delivered 88 → 112 of 144, look-alikes 45 → 49, neutral 50 → 21 (English
   * originals 53); +13% check calls on non-English requests, 12–23 µs a request, +29 MB RSS.
   */
  requestGloss: boolean;
  /**
   * Phrasing expansion on explicit asks (D2029): each content word of the question stands for one OR-group — the
   * index's terms sharing its stem plus its phrasing family (`ASK_FAMILY`) — and coverage is counted per group at
   * its rarest variant's idf. Explicit `ask` calls only; the engine's own reader-push reads keep exact words, so the
   * proactive false-fire rate is untouched.
   */
  askExpand: boolean;
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
   * D1252 (F11; rejected, kept off; 0 = off): with `pushCheck`, a push the check left silent (it answered and named
   * nothing) hands up to this many items of its own pool (no bulk mail, pool order) that name one of the request's
   * anchors (a person or thing it names, or its day: `settle.ts`'s `anchored`), under `LOOKUP_LEAD`: for reference, a
   * check found none that changes the request. No new connector or model call. D1250 measured the agent searching its
   * connectors on 28 of 32 silent turns and on 3 of 40 after a packet: this gives a silent turn the records the agent
   * would look up. D300 (answer-ahead, rejected) was the same records beside every candidates packet, before the check
   * made silence common.
   */
  pushLookup: number;
  /**
   * D1252's second arm (F11; rejected, kept off; needs `pushLookup`): when no record in the silent push's pool names
   * one of the request's anchors, the pool's first `pushLookup` items (no bulk mail) go out under the same lead. Round
   * 3 of D1252: the lookup packet stopped the agent's search on 14 of 15 silent turns it reached, and the 17 it did not
   * reach (nothing anchored in the pool) all searched.
   */
  pushLookupAny: boolean;
  /**
   * D1252's third arm (F11; rejected, kept off; needs `pushLookup`): the lookup packet's lead also says the records are
   * background for the request's details, not a reason to warn the user (`LOOKUP_QUIET`), since the check already
   * found none that changes the request. For the hedges the reference records drew in round 4 ("check that the
   * discount is approved, I found no record of it").
   */
  pushLookupQuiet: boolean;
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
   * `pushDaySeats` (G1, D1400–D1402; 3 in the default, part `days`; 0 = off): a plan with a day is an action on that
   * day, with no model. (1) The request's days are read past `timeWindow` (`days.ts`): a bare day of the month ("on
   * the 20th", "Monday the 9th") and, through the glossary, a weekday in another language. (2) A turn that starts no
   * push, that the turn gate does not read as chatter, and that names a coming day (a window of at most three)
   * starts an opened one; such a push is checked only when one of its day seats is itself constraint-like. (3) Up to
   * this many items on a day the request names take seats in the push's pool right after the first `pushCandidates`,
   * where the push check reads them: events starting that day, items whose text spans it ("26 Oct – 6 Nov", "until
   * 2 November") and items that write the date, bulk mail out; windows of more than three days get none. A seat is
   * handed only when the check names it: with no answer the push hands the pool as it stood before the seats, and a
   * day-started push hands nothing. Served by subagents,
   * dev20 seeds 41–42, single-shot: hidden raised +2.5 points (+0.3..+5.0), look-alikes handed and neutral concerns
   * within their intervals, checked pushes +7% (docs/research/g1-facts.md).
   */
  pushDaySeats: number;
  /**
   * How many of the pool's items, from its first, the check reads (at most `CHECK_MAX_ITEMS`); when it answers, only
   * those can be candidates.
   */
  pushCheckItems: number;
  /**
   * On in the default (G2, D1450; docs/research/g2-decoys.md). With `pushCheck` and a checker, a proactive packet a
   * rule path made for a request (the no-model conflict and grounding tests, which queue before the check answers)
   * is not handed out when that request's push check read every item in it and said yes to none. The observe
   * already waits for the push, so no wait is added, and there is no call. A check that did not answer, read another
   * copy of an item or was for another request holds nothing back; an explicit ask lists as before (D1452).
   */
  packetHeedsCheck: boolean;
  /**
   * F5 (D1180, promoted on subagent evidence; docs/research/f5-rule-sheet.md): the push check also reads the user's
   * rule sheet, at most this many of their active constraint cards (`SHEET_MAX_CARDS` at most; 0 off), each its
   * statement, kind, span, source and item title, as a cached block after the instructions (`SHEET_HEAD`). A rule the
   * reply names brings its item into the packet after the pool's named items, within `pushCandidates`. Expired cards
   * (an end before the user's day), `none` and `preference` cards are left out, newest items first. A user with more
   * active rules than this gets no sheet (D1183: a newest slice of a heavy user's rules speaks on neutral requests).
   */
  pushCheckSheet: number;
  /**
   * F5 (D1180, with `pushCheckSheet`): a pool item on the sheet is sent as its title and its rule's number instead of
   * its text: the cached sheet line stands in for part of the uncached pool (cost).
   */
  pushCheckSheetRefs: boolean;
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
   * Q4.2 (docs/research/weak-points-1111.md; o3-push-open §5, screened and not built): on a request the push opened
   * by shape rather than a listed verb, a packet goes only when a constraint-like item is among those handed — the
   * pool holding one is not enough. Screened: −25% of the neutral packets `pushOpen` adds for −8% of its added
   * facts. Opt-in: a privacy-strict tenant takes it for the added silence (Q4.3). Inert when `pushOpen` is off.
   */
  pushOpenConstraint: boolean;
  /**
   * P2 (D820, promoted by D828, part `indirect`; docs/research/p2-push-check.md): the push also starts for a request
   * phrased as a need, a plan, a wish or a question about acting ("I need to pay …", "We should move …", "I want you
   * to book …", "Should I book …?", a request after a first clause of context), read as the imperative after its
   * lead-in (`indirectRest`, `pushStart`), and the open shape refuses pasted log lines and chatter openers
   * (`isOpenRequest`'s strict form). The push's lookup reads the message from where the request starts.
   */
  pushIndirect: boolean;
  /**
   * M13 (D1010, promoted by the owner's D1014, part `gate`; docs/research/m13-gate.md): the turn gate
   * (`turn-gate.ts`), a local model over hashed character n-grams that reads any language, decides the push's start
   * beside `pushStart`: a rule start stands unless the gate's score is under its veto, and the gate adds a start where
   * the rule has none. A start keeps the rule's request text when the rule read one (a lead-in's imperative), else the
   * whole message. No model call: local CPU, loaded once a process; with no readable weights `pushStart` decides alone
   * (fail open).
   */
  pushGate: boolean;
  /**
   * `pushAsk` (D1985, promoted on the v0.3.0 broad benchmark; part `ask`): a turn that asks, that no push started
   * for — the gate reads it `ask` or `qact`, or it has a question's shape (`asksQuestion`) — starts an `opened`
   * push: the question is itself the lookup's request, and the candidates' own constraint-like gate decides
   * whether anything goes, as for every started push. The benchmark's decisive correlation was that a turn with
   * no packet scores 17% where an injected one scores 85%: most of the 16% of question turns the gate stays
   * silent on were questions `ASKS_OWN`'s narrow shape and `pushStart` do not name, and ones whose rule start
   * the gate vetoed. A turn the gate reads as chatter starts none; with no gate the question shape alone
   * decides, as `pushStart` alone would (fail open).
   */
  pushAsk: boolean;
  /**
   * D342 (A17, promoted under D112; on in the default, part `freshness`): with `revisionNotice`, an "updated:" line
   * names the times and dates (clock times, day and month, weekdays) the session was shown for the item in earlier
   * versions that the new version no longer has: "(changed at its source …; no longer: 09:30)". Over a day the update
   * reached the agent and its recap still named the old time; this says outright which one no longer stands. No
   * model, no call.
   */
  revisionDiff: boolean;
  /**
   * F3 (D1131, in the default at 2 h; 0 = off): while a user is active (`syncActiveMs`), the sync's tick runs a
   * complete background poll of each warm synced source whose last complete poll is older than this (ms), whatever
   * its learned rate says. A quiet source is otherwise trusted for up to `syncMaxStaleMs` (6 h), so a silent edit
   * there went out as the pre-edit copy (D1126). No request waits for it, and the request path's own polls mostly
   * stop (its sources are current); its price is connector calls per active user-hour (COST-MODEL §Hosting (b)). A
   * source that notifies (`syncPush`) is never polled by it, nor one not marked first-party or flat-rate
   * (`Source.callPriced` false; absent counts as priced, D1133) unless `syncActivePollPriced`.
   */
  syncActivePollMs: number;
  /**
   * F3 (D1132, in the default), with `syncActivePollMs`: a floor poll of a source that brings in nothing new doubles
   * that source's interval, up to four times the floor (2 h to 8 h); anything new stored from the source, by any
   * read, sets it back to the floor. A quiet source is then polled about a quarter as often, one that changes as
   * before.
   */
  syncActivePollBackoff: boolean;
  /**
   * D1132, D1133, with `syncActivePollMs`: the deployment's opt-in (an operator setting in `EDEN_ENGINE_CONFIG`, one
   * for every tenant the server runs) to floor polls of sources not marked first-party or flat-rate
   * (`Source.callPriced` true, or absent: unknown counts as priced). Off: those sources keep their learned rate.
   */
  syncActivePollPriced: boolean;
  /**
   * D1747 (in the default at 40; 0 = no cap), with `syncActivePollMs`: the most floor polls a user's unused sources
   * (not `engage`d) get per floor interval, a refilling allowance; past it one with no complete poll for 24 h goes
   * first, then the likeliest to have changed by their learned rate, and the rest wait for a later tick (an unused
   * source's staleness bound becomes about 24 h, the weekly sweep past the allowance). Used sources keep the floor.
   * A user with up to 40 connectors never reaches it; at a thousand first-party connectors the floor alone made about
   * a thousand calls an active user-day (call-causes, D1746), and 81-84 with the cap.
   */
  syncActivePollCap: number;
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
  groundSubject: true,
  companions: true,
  companionSearch: 4,
  companionSearchMs: 400,
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
  tenantCallsPerMin: 0,
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
  sourceKindPrior: 20,
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
  cardsRequestsFix: true,
  cardsState: true,
  pushStateFilter: true,
  intentHits: 12,
  intentMinCoverage: 0.2,
  intentMinMatched: 1,
  intentByKind: true,
  intentCardCoverage: 0.1,
  intentCardHits: 4,
  intentWeight: 1,
  intentSeats: 1,
  requestGloss: true,
  askExpand: true,
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
  pushLookup: 0,
  pushLookupAny: false,
  pushLookupQuiet: false,
  pushCandidatesSettled: 2,
  pushCheck: true,
  pushCheckWaitMs: 1_500,
  pushCheckItemChars: 200,
  pushCheckItems: 15,
  packetHeedsCheck: true,
  pushDaySeats: 3,
  pushCheckSheet: 80,
  pushCheckSheetRefs: true,
  pushOpen: true,
  pushOpenConstraint: false,
  pushIndirect: true,
  pushGate: true,
  pushAsk: true,
  revisionDiff: true,
  syncActivePollMs: 7_200_000,
  syncActivePollBackoff: true,
  syncActivePollPriced: false,
  syncActivePollCap: 40,
};

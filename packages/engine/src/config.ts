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
   * Every item about to be delivered (a packet or an `ask` answer, from the slow path, the reader's push or the
   * action firewall) whose source signalled a change after the copy was read (`Sync.signalledSince`, with
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
   * The action firewall (`checkAction`, `firewall.ts`; docs/research/econ-firewall.md): an agent's tool call is checked
   * before it runs, with no model and no source call, against what is held: the request and the call's structured
   * arguments (their days, times, amounts, names and references) read as one cue through the conflict test, the cards
   * and the calendar. A finding is returned as data; otherwise `proceed`. Off: `checkAction` always proceeds.
   */
  actionCheck: boolean;
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
   * `pushChecked` (trial, D246, CL4 H8): when the push read the user's request and flagged nothing, a short note goes
   * to the agent in the data envelope: Eden read the user's connected sources for this request and nothing in them
   * bears on it (after a packet for the same request: nothing beyond it). Only when every source the push searched
   * answered (D127) and its reading gave a verdict, or found no candidate to read. Meant to spare the agent an
   * `ask_context` call and a model turn on requests Eden has nothing for. Needs `readerPush`.
   */
  pushChecked: boolean;
  /**
   * `pushCovered` (trial, D250, CL4 H13): a packet the push queued ends with a line saying Eden read the user's sources
   * for this request and the items above are what bears on it, so the agent can answer from it in one call.
   */
  pushCovered: boolean;
  /**
   * `askFromPush` (trial, D247, CL4 H9): an ask in the push's request (the same match as `readerReuse`) ranks on the
   * index the push's search filled, with no search of its own: no live call, no on-demand poll. Its answer still reads
   * (or reuses) the reader and re-reads what it cites as usual.
   */
  askFromPush: boolean;
  /**
   * `pushVerifyAhead` (trial, D249, CL4): once the push has read the request, the doubted copies among the items it
   * ranked first (what an ask in the request would most likely cite) are re-read in the background, so the ask's strict
   * re-reads (D211) reuse them instead of waiting on connector calls. Costs those re-reads on requests with no ask.
   */
  pushVerifyAhead: boolean;
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
  actionCheck: false,
  revisionNotice: true,
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
  readerVerifyAfter: true,
  readerReuse: true,
  pushChecked: false,
  pushCovered: false,
  askFromPush: false,
  pushVerifyAhead: false,
};

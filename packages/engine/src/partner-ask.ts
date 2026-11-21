/**
 * `PartnerAsk` (D2023): the partner's ask path, split out of `partner-verdict.ts` as it passed five thousand
 * lines — `ask` and its reader (`readAsk`), the push's ask-side work (`pushAgain`, `askLater`, `behindStatuses`,
 * `keepUndo`) and the frames both name (`lookupFrame`, `candidateFrame`). The verdict core it and the push share
 * stays in `partner-verdict.ts`; `ContextPartner` extends this class (the class chain and the R3 split:
 * `partner-core.ts`, `partner-delivery.ts`, `partner-check.ts`, `partner-verdict.ts`, `partner-freeze.ts`).
 */
import { createHash } from "node:crypto";
import type { SourceMap } from "@eden/graph";
import type { Budget, Model, Reservation } from "@eden/llm";
import {
  itemId,
  MAX_QUESTION_CHARS,
  scopeKey,
  type AskRequest,
  type AskResponse,
  type ContextItem,
  type Injection,
  type InjectionMode,
  type Scope,
} from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import type { WorkerPool } from "@eden/primitives";
import {
  PlanError,
  PlannedSource,
  type CountedPlanCalls,
  type FanoutOutcome,
  reachedSource,
  sharedKey,
  type SharedCalls,
  type QueryPlanner,
  type SearchQuery,
  type Source,
  type SourceResolver,
} from "@eden/sources";
import { nearDuplicate, sanitizedId, type CacheHit, type ItemCache, type Sketch } from "./cache";
import type { EngineConfig } from "./config";
import { assess, frameOf, namesRef, unmeasuredLimit, type Frame, type Verdict } from "./conflict";
import { cardKey, cardVerdict, requestActions, type Card, type CardEnricher } from "./cards";
import { glossOf } from "./gloss";
import { intentCut, intentReach, intentTerms, keepIntents, stemWord } from "./intent";
import {
  READER_MAX_ITEMS,
  readerFocus,
  readerItem,
  readerNote,
  type AskReader,
  type ReaderInput,
  type ReaderRead,
  type ReaderKind,
  type ReaderVerdict,
} from "./reader";
import {
  CHECK_MAX_ITEMS,
  checkKey,
  itemMark,
  SHEET_MAX_CARDS,
  sheetText,
  type PushCheckRead,
  type PushChecker,
  type SheetCard,
} from "./push-check";
import { actionClass, classTies, matchesClass, type ActionClass } from "./consequence";
import { sourcePriors } from "./source-prior";
import type { Evidence } from "./source-yield";
import { ProbeEconomy, type ProbeKind } from "./economy";
import { judgeMessages, parseJudge } from "./judge";
import { namesParticipant, participantWords, startDay, startMs, timeWindow, titleNames } from "./grounding";
import {
  absenceSpan,
  ASKS_OWN,
  ASKS_WHO,
  cleanEntities,
  daysNamed,
  isAction,
  isImperative,
  pushStart,
  MORE_VERBS,
  LEADING,
  isScheduling,
  isSubject,
  mentionsAny,
  mentionWords,
  orgsOf,
  overlaps,
  requestedSpan,
  rolesOf,
  settled,
  startMinutes,
  textMinutes,
  topicOf,
} from "./probes";
import { type TurnGate, turnGate } from "./turn-gate";
import type { Facts } from "./decide";
import { Ledger, type LedgerEntry } from "./ledger";
import { PartnerCheck } from "./partner-check";
import {
  ASK_BEHIND,
  CHECK_KEPT,
  MAX_CHECKS,
  PLAN_REQUESTS,
  RARE_SHARE,
  UPDATED,
  buildCue,
  bulkMail,
  focusOf,
  isPersonName,
  rebuildVocab,
  renderedCount,
  settledOf,
  shownKey,
  versionOf,
  within,
  type CheckOutcome,
  type Cue,
  type KeptCheck,
  type PacketFrame,
  type Scored,
  type Session,
} from "./partner";
import {
  ASK_LATE_LEAD,
  ASK_NUDGE,
  CANDIDATES_LEAD,
  LOOKUP_HEAD_LEAD,
  LOOKUP_LEAD,
  LOOKUP_QUIET,
  LOOKUP_USE,
  renderPacket,
} from "./render";
import { datedText, dayKeys } from "./days";
import { dayFactsClass, dayFactsOf } from "./day-facts";
import {
  anchored,
  aliasExpand,
  anchorsOf,
  hasDay,
  namedDays,
  namesDay,
  namesEntity,
  namesRequestDay,
  settledCut,
  settles,
  type Anchors,
} from "./settle";
import { distinctTermIds, head, isStopword, PERSISTABLE_KINDS, termIds } from "./text";
import { sketchTerms, termHashes } from "./sketch";
import type { SpanSink } from "./spans";
import type { ShadowRecord, ShadowSink, Trace, TraceSink, UsageSink } from "./trace";
import {
  ASK_ITEM_BYTES,
  ASKS_BLOCKERS,
  honestAnswer,
  ITEM_GONE,
  localDay,
  MAX_CANDIDATE_BYTES,
  MIN_OWN_READ_MS,
  NO_READ,
  PartnerVerdict,
  READER_POOL_CAP,
  sameEntry,
  SEARCHING,
  userCacheKey,
} from "./partner-verdict";
import type { AskInternal, ReaderReport, ReadOpts, SearchedLive, SourceStatus, Undo } from "./partner-verdict";

export abstract class PartnerAsk extends PartnerVerdict {
  /**
   * `readerPushBehind`: once the poll the push did not wait for is done, and only if it stored something, the push is
   * ranked again on the refreshed index and read once more (`again`: no second search, no further re-read). A pool the
   * poll left as it was reads as the same reader input, a cache hit with no call. Nothing runs for a closed session or
   * for a request the user has since followed with another. Never throws.
   */
  private pushAgain(
    s: Session,
    request: AskRequest,
    internal: AskInternal,
    polled: Promise<boolean>,
    searched: SearchedLive,
    prev: Injection | null,
  ): void {
    const work = polled
      .then(async (fresh) => {
        if (!fresh || s.closed || this.sessions.get(s.key) !== s) return;
        if (internal.request !== undefined && internal.request !== s.requests) return;
        // The calls were the first reading's; the second makes none (nor any plan) of its own.
        const { plans: _plans, ...rest } = searched;
        const again = { ...rest, calls: 0, ...(rest.syncCalls !== undefined ? { syncCalls: 0 } : {}) };
        await this.ask(request, {
          push: true,
          request: internal.request,
          turn: internal.turn,
          // The first pass's `open` carries over: a refreshed push of an opened request is still an opened push
          // (pushOpenConstraint, D2011) — the poll finding new items must not hand what the first pass refused.
          open: internal.open,
          again: { searched: again, prev },
        });
      })
      .catch(() => {});
    this.addBehind(s, work);
  }

  /**
   * `askBehind` (D430): once the work an explicit ask stopped waiting for is done, and only if it stored something,
   * the ask is ranked again on the refreshed index (`internal.late`: no second search) and what it would now cite that
   * its answer did not is queued for the agent's next take. Nothing runs for a closed session or once the user has
   * sent another request. Never throws.
   */
  private askLater(
    s: Session,
    request: AskRequest,
    polled: Promise<boolean>,
    searched: SearchedLive,
    cited: readonly string[],
  ): void {
    const asked = s.requests;
    const work = polled
      .then(async (fresh) => {
        if (!fresh || s.closed || this.sessions.get(s.key) !== s || s.requests !== asked) return;
        // The calls were the answer's; the follow-up makes none (nor any plan) of its own.
        const { plans: _plans, ...rest } = searched;
        const again = { ...rest, calls: 0, ...(rest.syncCalls !== undefined ? { syncCalls: 0 } : {}) };
        await this.ask(request, { late: { searched: again, cited: new Set(cited), request: asked } });
      })
      .catch(() => {});
    this.addBehind(s, work);
  }

  /**
   * `askBehind` (D430): each chosen source's status once the ask stops waiting. A copy answered here that was cut or
   * not current gives its live search's outcome once that has settled (D127: a timeout or error is named), "local"
   * once its poll made it current, "error" when the work behind is done and its poll did not make it current
   * ("timeout" for a cut copy that was not searched), and "searching" (not answered: the answer says so, never an
   * all-clear) while that work runs.
   */
  private behindStatuses(
    s: Session,
    searched: SearchedLive,
    cut: ReadonlyMap<string, string>,
    settled: boolean,
  ): SourceStatus[] {
    const pending = new Set(searched.behindLocal ?? []);
    const now = this.now();
    const sv = this.sync!.view(s.scope);
    return (searched.sources ?? []).map((x) => {
      if (!pending.has(x.sourceId)) return x;
      const done = cut.get(x.sourceId);
      if (done !== undefined) return { sourceId: x.sourceId, status: done };
      const whole = sv.complete(x.sourceId);
      if (whole && sv.current(x.sourceId, now)) return x;
      if (!settled) return { sourceId: x.sourceId, status: SEARCHING };
      // The work is done and the copy is still not current: its poll failed or was skipped after failures (the
      // 2026-11-05 audit's false all-clear: never "local" or "stale"), or a cut copy got no live search (too little of
      // the deadline left, D148) and answered nothing older than its cut.
      return { sourceId: x.sourceId, status: whole ? "error" : "timeout" };
    });
  }

  /**
   * `readerPushBehind`: records what `injection`'s delivery marked in `s` (`was`: each item's ledger entry before it),
   * so `withdraw` can undo it. An item the delivery left unmarked has nothing to undo.
   */
  private keepUndo(
    s: Session,
    injection: Injection,
    scored: Scored[],
    was: Map<string, LedgerEntry | undefined>,
  ): void {
    const undo: Undo = new Map();
    for (const x of scored) {
      const set = s.ledger.entry(x.item.id);
      const before = was.get(x.item.id);
      if (!set || sameEntry(set, before)) continue;
      undo.set(x.item.id, { was: before, set, sketch: x.sketch });
    }
    if (undo.size > 0) this.undoable.set(injection, undo);
  }
  async ask(request: AskRequest, internal: AskInternal = {}): Promise<AskResponse> {
    const t0 = performance.now();
    const thawing = this.deps.cache.ready(request); // D325, as in `observe`.
    if (thawing) await thawing;
    const spans = this.spans;
    const root = spans?.open("ask", 0, { async: true });
    const s = this.session(request);
    // An ask is a sighting too (D2005): an ask-only integration (an MCP client) never sends `observe`, and its
    // user's backfill still starts at their first question.
    this.seen(s.scope);
    // An ask-only session (an MCP client) never runs observe, which keeps the session vocabulary bounded.
    if (s.vocab.size > this.config.maxSessionTerms) rebuildVocab(s, this.config.maxSessionTerms);
    const question = sanitizeForStore(request.question);
    // `itemId` (D2022, A2): an earlier citation's id asks for that item itself — the parts bearing on the question
    // in full, where an answer's items are cut at `askItemBytes`. The item comes from the cache — a cited item is
    // held — and a copy a sweep or signal doubted is re-read as an ordinary answer would check it. No search, no
    // model, nothing charged; a session's tally is untouched.
    if (request.itemId !== undefined) {
      const at = this.now();
      const item = this.deps.cache.get(s.scope, request.itemId, at);
      if (item === null) {
        if (root) spans!.close(root, { item: 0 });
        return { answer: ITEM_GONE, citations: [], usedModel: false, costUsd: 0, latencyMs: performance.now() - t0 };
      }
      const itemCue: Cue = {
        text: question,
        entities: [],
        key: "",
        id: "item",
        time: null,
        at,
        raw: question,
        offset: this.deps.cache.offsetOf(s.scope),
      };
      if (root) itemCue.span = root.id;
      // The same freshness check an ordinary answer applies (the review): a copy a sweep or signal doubted is
      // re-read before it is served, and one the sources no longer hold answers as gone.
      const held = await this.verifyItems(s, [{ item, score: 0, matched: 0, sketch: null }], itemCue);
      const latencyMs = performance.now() - t0;
      if (root) spans!.close(root, { item: held.length === 0 ? 0 : 1 });
      if (held.length === 0 || s.closed) {
        return { answer: ITEM_GONE, citations: [], usedModel: false, costUsd: 0, latencyMs };
      }
      // `held` carries the copy the re-read confirmed — a changed one, where `item` is the superseded copy in hand.
      const fresh = held[0]!.item;
      const focus = focusOf(itemCue);
      const answer = renderPacket([fresh], {
        maxBytes: ASK_ITEM_BYTES + 1_024,
        focus,
        itemBytes: ASK_ITEM_BYTES,
        self: this.deps.cache.selfOf(s.scope),
        ...(this.config.compactParts ? { split: true } : {}),
      });
      return { answer, citations: this.cited([fresh]), usedModel: false, costUsd: 0, latencyMs };
    }
    // `requestGloss` (F1, D1153): a request in another language also searches with the English its words mean, ahead
    // of its own words so the cue's term cap keeps them. The request itself (`raw`) is left as written.
    const gloss = this.config.requestGloss ? glossOf(question) : "";
    const ids = distinctTermIds(gloss ? `${gloss}\n${question}` : question, s.vocab);
    const at = this.now();
    const offset = this.deps.cache.offsetOf(s.scope);
    // `pushDaySeats` (G1, D1400): the request's days read past `timeWindow`: a bare day of the month given its month
    // (`datedText`), and the glossary's English beside the request, so a weekday in another language is a day too.
    // Read in place of the cue's own reading, which would be thrown away (D1933).
    const time =
      this.config.pushDaySeats > 0
        ? timeWindow(datedText(gloss ? `${question}\n${gloss}` : question, at, offset), at, offset)
        : undefined;
    const cue = buildCue(question, ids, s.vocab, at, offset, this.config.probes, time);
    if (gloss) cue.gloss = gloss;
    if (root) cue.span = root.id;
    const limit = request.maxItems ?? 5;
    // `readerPushBehind`: the push reads the index as it stands while the sync's poll runs behind (the agent's asks
    // wait for it only with `askBehind` off, D430). Its second reading, once the poll has stored something, reuses the
    // first one's search.
    const behind =
      internal.push === true &&
      internal.again === undefined &&
      this.config.readerPushBehind &&
      this.config.syncPollBehind &&
      this.config.syncOnDemand;
    // `askBehind` (D430): an explicit ask's lookup runs behind as the push's does, and the ask waits for that work only
    // `askBehindWaitMs`. Its follow-up (`internal.late`) reuses the first search and starts none.
    const askBehind =
      !internal.push &&
      internal.again === undefined &&
      internal.late === undefined &&
      this.config.askBehind &&
      this.config.pushCutBehind &&
      this.config.syncLocalComplete &&
      this.config.syncPollBehind &&
      this.config.syncOnDemand &&
      this.sync !== null;
    if (askBehind) cue.cutStatus = new Map();
    let searched =
      internal.again?.searched ??
      internal.late?.searched ??
      (await this.searchLive(s, cue, this.config.askSources, behind || askBehind));
    // Whether the work behind the ask was done when it answered; false leaves a follow-up for what it stores.
    let settled = true;
    if (askBehind && searched.behindLocal?.length) {
      const waiting = spans?.open("ask.wait", cue.span, { async: true });
      // No work behind at all (no poll, no search started) is settled: each such copy is then named, never "local".
      settled = cue.polled ? (await within(cue.polled, this.config.askBehindWaitMs)) !== null : true;
      if (waiting) spans!.close(waiting, { settled });
      searched = { ...searched, sources: this.behindStatuses(s, searched, cue.cutStatus!, settled) };
    }
    const { calls: sourceCalls, plans, probed, local, syncCalls } = searched;
    // `intent`: what the question would change, by the requests written for each item (no model, no call).
    const intentFound = this.intentFinds(s, cue);
    const extra = [...intentFound.keys()];
    const ranking = spans?.open("rank", cue.span);
    const scored = this.rank(s, cue, {
      ignoreLedger: true,
      probed: extra.length > 0 ? [...(probed ?? []), ...extra] : probed,
      // `askExpand` (D2029): explicit asks only — the push's own reads stay on the exact-word path.
      expand: this.config.askExpand && internal.push !== true,
    });
    if (ranking) spans!.close(ranking, { candidates: scored.length });
    // Only anchored intent hits are fused in (`anchoredIntents`); every hit still withholds the guard's line.
    const intents = this.anchoredIntents(s, cue, intentFound);
    // The candidates' facts (`decide.ts`), for the lab's dump.
    const facts = this.deps.onCandidates
      ? this.factsOf(s, cue, scored, "ask", { probed: new Set(probed ?? []), bridged: new Set(), carded: new Map() })
      : [];
    const grounding = spans?.open("ground", cue.span);
    // What the question's people and days ground comes first (D44); a named day's other events only through it, so
    // a question about a topic is not padded with that day's calendar.
    const onDay = (x: Scored) =>
      cue.time?.days.has(startDay(x.item, cue.offset) ?? "") === true || x.dayCls !== undefined;
    const grounded = this.grounded(
      s,
      cue,
      scored.filter((x) => x.score >= this.config.candidateScore || onDay(x)),
      "ask",
    ).items;
    if (grounding) spans!.close(grounding, { grounded: grounded.length });
    const lexical = [
      ...grounded,
      ...scored.filter((x) => x.score >= this.config.candidateScore && !grounded.includes(x)),
    ];
    const fused = intents.size > 0 ? this.fuseIntent(lexical, scored, intents) : lexical;
    // The stale sibling answers the ask no better than the current record, so it sorts after everything that
    // is not stale: demoted past the cap it still reaches the widened pool for `askReader` to see it there.
    const staleOf = this.staleSibling(s, cue, cue.entities, fused);
    const stale = (x: Scored) => this.staleSelf(x.item, cue) || staleOf(x.item);
    const order = [...fused.filter((x) => !stale(x)), ...fused.filter(stale)];
    let chosen = order.slice(0, limit);
    // `askReader` (D95): one budgeted model call reads the widened pool; the items it says bind lead, with its bearing.
    // An explicit ask waits `askReaderWaitMs` for it; the push waits for the reading itself (the observe that started
    // it stops waiting at `readerPushWaitMs`), bounded by the reader's call and the session's close.
    const readOpts: ReadOpts = {
      push: internal.push === true,
      ...(internal.request !== undefined ? { request: internal.request } : {}),
    };
    // `pushCandidates` (D236, D237): no reader call, on the push or on an ask (the agent reads the candidates).
    const candidating = this.config.pushCandidates > 0;
    // `askBehind`'s follow-up (`internal.late`) reads nothing: it makes no call of its own, model or source (D430).
    const reading =
      this.config.askReader && this.deps.reader && !candidating && internal.late === undefined
        ? await this.readAsk(
            s,
            cue,
            [...order, ...scored],
            chosen,
            limit,
            internal.push ? Infinity : this.config.askReaderWaitMs,
            {
              push: internal.push === true,
              ...(internal.request !== undefined ? { request: internal.request } : {}),
            },
          )
        : null;
    if (reading) chosen = reading.chosen;
    // `askNudge` (D316, D317): an ask in the request a nudged packet went out for also lists the push pool's items past
    // those handed that hold one of the request's anchors (its current copies). They take at most half the answer's
    // seats (rounded up), from the end, and never the ask's own first: the answer still cites at most `maxItems` (the
    // protocol's bound) and keeps its best match for the question (none are added at `maxItems` 1).
    if (!internal.push && this.config.askNudge && s.nudged?.request === s.requests) {
      const { anchors, deeper } = s.nudged;
      const have = new Set(chosen.map((x) => x.item.id));
      const extra: Scored[] = [];
      const seats = Math.min(Math.ceil(limit / 2), limit - 1);
      for (const id of deeper) {
        if (extra.length >= seats) break;
        if (have.has(id)) continue;
        const item = this.deps.cache.get(s.scope, id, this.now());
        if (item && !bulkMail(item) && anchored(item, anchors))
          extra.push({ item, score: 0, matched: 0, sketch: null });
      }
      chosen = [...chosen.slice(0, Math.max(0, limit - extra.length)), ...extra];
    }
    // `askBehind` (D430): the follow-up of an ask that answered before its sources were read. What it would cite now
    // that the answer did not, and the agent has not been handed, goes out as a packet for the next take, re-checked
    // like any delivery; nothing for a closed session or a request the user has since followed with another.
    if (internal.late) {
      const { cited, request: asked } = internal.late;
      // Only what the sources still being read could have brought (the answer's own sources answered it), re-read as
      // strictly as the answer was (D211): an item the answer left out as not re-checked is not handed over as news.
      const reading = new Set(searched.behindLocal ?? []);
      const fresh = chosen.filter(
        (x) => reading.has(x.item.sourceId) && !cited.has(x.item.id) && s.ledger.isFresh(x.item.id, s.turn),
      );
      const was = new Map(fresh.map((x) => [x.item.id, s.ledger.entry(x.item.id)] as const));
      const current = () => !s.closed && s.requests === asked;
      const strict = { unconfirmed: new Map<string, number>(), unswept: new Map<string, number>() };
      let checked = fresh.length > 0 && current() ? await this.verifyItems(s, fresh, cue, strict) : [];
      // As the push (audit A11): an item handed out during the re-reads is not marked twice.
      checked = checked.filter((x) => {
        const now = s.ledger.entry(x.item.id);
        return now === undefined || sameEntry(was.get(x.item.id), now);
      });
      const frame = {
        lead: ASK_LATE_LEAD,
        itemBytes: this.config.compactItemBytes,
        maxBytes: this.config.maxInjectionBytes,
      };
      const injection =
        checked.length > 0 && current()
          ? this.deliver(s, checked, "proactive", `${ASK_BEHIND}${cue.id}`, cue, undefined, frame)
          : null;
      if (injection) {
        // Undoable, so a packet the agent has not taken when the user's next request comes is withdrawn whole.
        this.keepUndo(s, injection, checked, was);
        s.pending.push(injection);
      }
      const latencyMs = Math.round(performance.now() - t0);
      this.trace(s, {
        sessionId: s.id,
        turn: s.turn,
        event: "ask",
        decision: injection ? "sources" : "silent",
        reason: "ask behind",
        latencyMs,
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: injection ? injection.citations.map((c) => c.itemId) : [],
      });
      if (root) spans!.close(root, { session: s.id, turn: s.turn, decision: "ask-behind", delivered: !!injection });
      return { answer: "", citations: [], usedModel: false, costUsd: 0, latencyMs };
    }
    // `readerPush`: the ask was the engine's own, for the user's request. What the reader flagged goes to the agent as
    // a proactive packet (queued, taken before its next model request); nothing else is answered or handed out.
    if (internal.push) {
      // `pushOpen` (D702): a message the verb lists do not know is not kept as an acting request: a plan alert
      // (D301) quotes the request it is about, and an opened message may be a remark.
      if (this.config.planConflict && internal.again === undefined && !internal.open) this.noteActed(s, cue);
      // `readerPushKinds`: only the kinds pushed unasked (a "changes" bearing is the reader's least precise).
      const pushes = new Set<string>(this.config.readerPushKinds);
      // `pushCandidates` (D236): the pool's top, for the agent to judge, in place of the reader's flags.
      const gate = candidating ? this.pushGate(s, cue, [...order, ...scored], internal.byDay === true) : null;
      // `pushCheck` (D500, D828): one budgeted call over the pool, only when the gate would hand candidates. With no
      // checker wired (no model key) no await is added: the push's timing (which turn it lands in) stays as it was.
      const check =
        gate && this.config.pushCheck && this.deps.checker
          ? await this.checkPush(s, cue, gate, internal.request)
          : null;
      if (check && s.closed) {
        // The session closed while the check ran: its call was paid for, so it is traced on its own.
        if (check?.called) this.traceCheck(s, check, t0);
        return {
          answer: "",
          citations: [],
          usedModel: false,
          costUsd: 0,
          latencyMs: Math.round(performance.now() - t0),
        };
      }
      const candidates = gate ? this.candidatesOf(s, cue, gate, check) : null;
      const flagged = candidates
        ? candidates.items
        : reading
          ? chosen.filter((x) => reading.notes.has(x.item.id) && pushes.has(reading.kinds.get(x.item.id) ?? ""))
          : [];
      // A reading that lands after a newer user message answers a request the agent has moved past: not queued.
      const latest = internal.request === undefined || internal.request === s.requests;
      // `readerPushBehind`'s second reading, on the index the poll refreshed: the packet the first queued from the
      // older copies, if the agent has not taken it, gives way to this one (its items count as undelivered here). One
      // the agent has taken stays taken: only what is new to it, or what the poll changed since, goes out again.
      const prev = internal.again?.prev;
      // A candidates pass replaces the first packet only with candidates of its own (CL6 review).
      const replacing = !!prev && (reading?.read || (candidates?.items.length ?? 0) > 0) && !s.closed && latest;
      // The first packet's items count as undelivered for this reading while it is still queued. It is withdrawn only
      // after the re-reads below, in the same step as its replacement is queued: withdrawn before them, a take while a
      // re-read was on the wire found neither packet, and the push's context reached the agent a request late (audit
      // A5); a candidates pass with nothing left to deliver keeps it.
      const withdrawn = new Set<string>(
        replacing && s.pending.includes(prev!) ? prev!.citations.map((c) => c.itemId) : [],
      );
      const fresh = flagged.filter(
        (x) =>
          withdrawn.has(x.item.id) ||
          s.ledger.isFresh(x.item.id, s.turn) ||
          (internal.again !== undefined && s.ledger.revised(x.item.id, versionOf(x.item), s.turn)),
      );
      // The re-reads come first (`verifyItems`, which may wait on a connector), then the delivery, so a user message
      // that arrives meanwhile still keeps the packet out: nothing is marked delivered that is not queued.
      // As `deliverChecked` (audit A11): an item whose ledger entry changed over the re-reads' await was handed out
      // meanwhile (this event's slow path, a fast path), and `deliver` marks without testing again; it is left out. An
      // entry gone meanwhile was swept, not handed out: kept.
      const was = new Map(fresh.map((x) => [x.item.id, s.ledger.entry(x.item.id)] as const));
      let checked = fresh.length > 0 && !s.closed && latest ? await this.verifyItems(s, fresh, cue) : [];
      checked = checked.filter((x) => {
        const now = s.ledger.entry(x.item.id);
        return now === undefined || sameEntry(was.get(x.item.id), now);
      });
      const still = internal.request === undefined || internal.request === s.requests;
      // `pushOpenConstraint` (Q4.2, opt-in; o3-push-open §5, screened and not built): on a request the push opened
      // by shape rather than a listed verb, a packet goes only when a constraint-like item is among those it would
      // hand — the pool holding one is not enough, and a constraint the agent already took does not count (its copy
      // left `fresh` in the ledger step above). A `pushLookup` packet is reference, not candidates, and an item the
      // push check itself named counts: the model already judged it against the request.
      // An item the push check named counts: the model already judged it against the request. A named rule stands
      // for the card, still the item's at any revision; a `yes` stands for the copy read — a revision the re-reads
      // found is another item (`itemMark`'s id and content hash, as `packetHeedsCheck`).
      const approved = (x: Scored): boolean => {
        if (check === null) return false;
        if (check.rules?.has(x.item.id) === true) return true;
        if (check.yes?.has(x.item.id) !== true) return false;
        const mark = check.marks?.get(x.item.id);
        return (
          mark === undefined ||
          mark === itemMark(readerItem(x.item, readerFocus(cue.raw), undefined, this.config.pushCheckItemChars))
        );
      };
      const delivering =
        checked.length > 0 &&
        !s.closed &&
        still &&
        !(
          candidates !== null &&
          candidates.lookup === undefined &&
          internal.open === true &&
          this.config.pushOpenConstraint &&
          gate !== null &&
          !checked.some((x) => this.constraintLike(x, gate.cards) || approved(x))
        );
      if (replacing && (delivering || !candidates)) {
        const at = s.pending.indexOf(prev!);
        if (at >= 0) {
          s.pending.splice(at, 1);
          // The agent never got it: what its delivery marked is undone before this reading delivers.
          this.withdraw(s, prev!);
        } else if (withdrawn.size > 0) {
          // The agent took it during the re-reads: its items are delivered after all, and go again only if revised.
          checked = checked.filter(
            (x) =>
              !withdrawn.has(x.item.id) ||
              s.ledger.isFresh(x.item.id, s.turn) ||
              s.ledger.revised(x.item.id, versionOf(x.item), s.turn),
          );
        }
      }
      // A first reading whose poll runs behind may be withdrawn by the second: its ledger entries are kept to restore.
      const undo = behind ? new Map(checked.map((x) => [x.item.id, s.ledger.entry(x.item.id)])) : null;
      const injection =
        delivering && checked.length > 0
          ? candidates
            ? this.deliver(
                s,
                checked,
                "proactive",
                `candidates:${cue.id}`,
                cue,
                undefined,
                candidates.lookup
                  ? this.lookupFrame(candidates.lookup)
                  : this.candidateFrame(candidates.unsettled !== undefined),
              )
            : this.deliver(s, checked, "proactive", `reader:${cue.id}`, cue)
          : null;
      if (injection && undo) this.keepUndo(s, injection, checked, undo);
      if (injection) s.pending.push(injection);
      // `askNudge` (D316, D317): the ask the nudge asks for, in this request, may look past what was handed. A settled
      // packet (a `readerPushBehind` second pass replacing a nudged one) ends that look: the agent was not nudged.
      if (injection && candidates && !candidates.unsettled) s.nudged = undefined;
      if (injection && candidates?.unsettled && internal.request !== undefined) {
        const handed = new Set(candidates.items.map((x) => x.item.id));
        s.nudged = {
          request: internal.request,
          anchors: candidates.unsettled,
          deeper: candidates.pool.filter((x) => !handed.has(x.item.id)).map((x) => x.item.id),
        };
      }
      const latencyMs = Math.round(performance.now() - t0);
      // Most of the reader's spend with `readerPush` is this read (a later ask over the same input is cached): its
      // trace carries it, since this response goes to no caller.
      const costUsd = reading?.costUsd ?? 0;
      this.trace(s, {
        sessionId: s.id,
        turn: internal.turn ?? s.turn,
        event: "user_message",
        decision: "reader-push",
        reason: cue.id,
        latencyMs,
        // The push's lookup runs beside the event's own slow path over the same words but asks `askSources`, not
        // `lookupSources`, so it is partly new calls: `searchLive` counts only the calls a connector received (a search
        // that joined the slow path's in flight, or was answered by the fan-out's cache, is none), and a harness
        // summing `sourceCalls` over a task counts what its connectors were sent. Plans and sync use stay off.
        sourceCalls,
        modelCalls: (reading?.called ? 1 : 0) + (check?.called ? 1 : 0),
        costUsd: costUsd + (check?.costUsd ?? 0),
        ...(reading ? { readerCalls: reading.called ? 1 : 0, readerCostUsd: reading.costUsd } : {}),
        ...(candidates ? { candidates: true } : {}),
        ...(check ? { checkCalls: check.called ? 1 : 0, checkCostUsd: check.costUsd } : {}),
        itemIds: injection ? injection.citations.map((c) => c.itemId) : [],
      });
      const turn = internal.turn ?? s.turn;
      if (root) spans!.close(root, { session: s.id, turn, decision: "reader-push", delivered: !!injection });
      if (behind && cue.polled) this.pushAgain(s, request, internal, cue.polled, searched, injection);
      return { answer: "", citations: [], usedModel: reading?.called === true, costUsd, latencyMs };
    }
    // `verifyDelivery`: what the answer cites is re-read first when a signal doubted its copy; gone items are left out,
    // and so are doubted ones no re-read confirmed (D211), named in the answer.
    const unconfirmed = new Map<string, number>();
    const unswept = new Map<string, number>();
    const checked = await this.verifyItems(s, chosen, cue, { unconfirmed, unswept });
    const items = checked.map((x) => x.item);
    const rendering = spans?.open("render", cue.span);
    const answering = this.answering(s, cue);
    if (reading?.notes.size) answering.note = (item) => reading.notes.get(item.id);
    const packet = items.length ? renderPacket(items, answering) : "";
    // D127: "nothing" is said only when the sources the ask chose answered; one that failed is named, in the text
    // (an MCP caller sees only the text) and in `sources`.
    const answer = honestAnswer(
      packet,
      searched.sources,
      searched.unresolved === true,
      // The session closing during the re-reads leaves nothing checked either (D127): not an all-clear.
      searched.closed === true || s.closed,
      unconfirmed,
      unswept,
    );
    if (rendering) spans!.close(rendering, { items: items.length });
    if (this.deps.onCandidates) {
      this.dump(
        s,
        "ask",
        facts,
        // By id: a re-read copy (`verifyDelivery`) is another object for the same item.
        scored.filter((x) => items.some((i) => i.id === x.item.id)),
        items.length > 0 ? "answer" : "",
        order.map((x) => x.item.id),
      );
    }
    const usedModel = reading?.called === true;
    // What the ask spent: the reader's call (0 when its verdict was cached, joined or late).
    const costUsd = reading?.costUsd ?? 0;
    if (items.length && !s.closed) {
      const injection = this.deliver(
        s,
        items.map((item) => ({ item, score: 1, matched: 0, sketch: null })),
        "answer",
        "ask",
        cue,
        packet,
      );
      // The answer is handed out as it is returned: its items are noted as shown now.
      this.handOut(s, injection);
      // An explicit ask's answer carries its topic too: its items arrive with no sketch, but a follow-up's
      // `carry` still reads what was handed (D1976).
      for (const item of items) this.recordDelivered(s, item, null);
      if (this.config.partyCheck) this.notePacketParties(s, answer, injection.citations);
      // A packet still queued for the agent whose every item this answer says in full is not handed out again; one it
      // covers only in part stays queued (its other items are news). Removed, never `withdraw`n: the agent now has
      // each of its items, so what its delivery marked stands.
      // Only what the answer's text rendered: an item its size cap cut was not said (audit A5).
      const cited = new Set(items.slice(0, renderedCount(items, injection.text)).map((i) => i.id));
      for (let k = s.pending.length - 1; k >= 0; k--) {
        const queued = s.pending[k]!.citations;
        // An "updated:" packet goes only when the answer rendered its items' new version (`watchCopies`, D205): an
        // item cited but cut from the answer was not said.
        if (s.pending[k]!.reason.startsWith(UPDATED)) continue;
        if (queued.length > 0 && queued.every((c) => cited.has(c.itemId))) s.pending.splice(k, 1);
      }
    }
    const latencyMs = Math.round(performance.now() - t0);
    this.trace(s, {
      sessionId: s.id,
      turn: s.turn,
      event: "ask",
      decision: "answer",
      reason: cue.id,
      latencyMs,
      sourceCalls,
      modelCalls: reading?.called ? 1 : 0,
      costUsd,
      ...(reading ? { readerCalls: reading.called ? 1 : 0, readerCostUsd: reading.costUsd } : {}),
      itemIds: items.map((i) => i.id),
      ...(plans ? { plans } : {}),
      ...(local !== undefined ? { localSources: local, syncCalls: syncCalls ?? 0 } : {}),
    });
    if (root) spans!.close(root, { session: s.id, turn: s.turn, decision: "answer", delivered: items.length > 0 });
    if (askBehind && !settled && cue.polled) {
      this.askLater(
        s,
        request,
        cue.polled,
        searched,
        items.map((i) => i.id),
      );
    }
    return {
      answer,
      citations: this.cited(items),
      usedModel,
      costUsd,
      latencyMs,
      ...(searched.sources ? { sources: searched.sources } : {}),
    };
  }
  /**
   * `askReader` (D95, `reader.ts`): the reader's verdict on an ask about an action, over the first `askReaderPool`
   * distinct candidates of `ranked` (the ask's pool in its order, then the rest it scored). The items it says bind
   * lead the answer, at most `limit`, the usual `chosen` fill what is left. Null when the reader is not asked; `read`
   * false when it gave no verdict within `waitMs` (fail open: `chosen` as is; Infinity waits for the verdict, with no
   * timer). A late call reports `called` false and no cost: the call this read started is traced as "reader-late" when
   * it lands.
   */
  private async readAsk(
    s: Session,
    cue: Cue,
    ranked: readonly Scored[],
    chosen: Scored[],
    limit: number,
    waitMs: number,
    opts: ReadOpts = {},
  ): Promise<{
    chosen: Scored[];
    notes: Map<string, string>;
    kinds: Map<string, ReaderKind>;
    read: boolean;
    called: boolean;
    costUsd: number;
  } | null> {
    const reader = this.deps.reader!;
    const acts = (raw: string) => isImperative(raw, MORE_VERBS);
    const request = acts(cue.raw) ? cue.raw : s.request && acts(s.request.raw) ? s.request.raw : undefined;
    if (!request && !ASKS_BLOCKERS.test(cue.raw)) return null;
    const pool: Scored[] = [];
    const seen = new Set<string>();
    const cap = Math.max(0, Math.min(this.config.askReaderPool, READER_POOL_CAP));
    for (const x of ranked) {
      if (pool.length >= cap) break;
      if (seen.has(x.item.id)) continue;
      seen.add(x.item.id);
      pool.push(x);
    }
    // Whether the reader is shown every candidate the ask has (none cut by the pool's cap or the prompt's), so a
    // rejection of all of them is a reading of everything found (D114).
    let readsAll =
      pool.length <= READER_MAX_ITEMS &&
      ranked.every((x) => seen.has(x.item.id)) &&
      chosen.every((x) => seen.has(x.item.id));
    const t0 = performance.now();
    const report = (outcome: ReaderReport["outcome"], flagged: ReaderReport["flagged"] = []) =>
      this.deps.onReader?.({
        sessionId: s.id,
        checked: pool.length,
        pool: pool.map((x) => x.item.id),
        flagged,
        outcome,
        waitedMs: Math.round(performance.now() - t0),
      });
    if (pool.length === 0) {
      report("none");
      return null;
    }
    const main = request ?? cue.raw;
    const focus = readerFocus(main, cue.raw);
    const cards =
      this.config.cards && this.deps.cards
        ? this.deps.cards.cardsOf(
            s.scope,
            pool.map((x) => x.item.id),
            cue.arrived ?? this.now(),
          )
        : new Map();
    // `readerGate`: no call when none of the request's own candidates could constrain it: no card of a constraint kind
    // (or a state change or a thing done) and no constraint wording. Bulk mail never counts.
    if (this.config.readerGate && !pool.some((x) => this.constraintLike(x, cards))) {
      report("gated");
      return null;
    }
    // `readerReuse` (D193): an ask in the push's request reads the push's verdict, with no call of its own.
    const reuseAt = performance.now();
    const reused = opts.push ? null : await this.reusePush(s, pool, main, waitMs);
    // The session can close while the ask waits on the push's verdict: no call for it (audit A5).
    if (s.closed) return null;
    // The ask's own read, when there was nothing to reuse, waits only what is left of its wait.
    const readWaitMs = Number.isFinite(waitMs) ? waitMs - (performance.now() - reuseAt) : waitMs;
    // The likely deliveries are re-read while the reader reads (`verifyDelivery`): the delivery then waits on no call.
    // Only once the reader will read (D134): an empty pool or a gated ask has no reading to overlap, and its delivery
    // re-reads what it actually cites (`verifyItems`), so a re-read started ahead there is a connector call wasted.
    // `readerVerifyAfter` (D192) starts none here: only what the reader names and a delivery cites is re-read.
    if (!this.config.readerVerifyAfter && !reused) this.checkAhead(s, pool);
    const input: ReaderInput = {
      request: main,
      ...(request && cue.raw !== request ? { question: cue.raw } : {}),
      items: pool.map((x) => readerItem(x.item, focus, cards.get(x.item.id), this.config.askReaderItemChars)),
      today: localDay(this.now(), this.deps.cache.offsetOf(s.scope)),
      // Sticky routing to the provider that holds the user's cached prefix, as the judge, answer and cards calls do.
      cacheKey: userCacheKey(s.scope),
      ...(this.config.readerStopEarly ? { stopEarly: true } : {}),
    };
    // Who makes the call, for the accounting: a read that finds a verdict cached, or a call another read started
    // (an ask joining its push), makes none. Known before the read, for when this ask's wait runs out first.
    const fresh =
      !reused && reader.peek(s.scope, s.key, input) === undefined && !reader.inFlight(s.scope, s.key, input);
    // A paid call this ask could not wait for (the push's verdict came null with almost none of the wait left) is not
    // started: it would only buy a cached verdict (wave-1 review). A cached or joined verdict is still read.
    const tooLate = fresh && Number.isFinite(waitMs) && readWaitMs < Math.min(MIN_OWN_READ_MS, waitMs / 4);
    const starts = fresh && !tooLate;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reading: Promise<ReaderRead> = reused
      ? Promise.resolve(reused === "late" ? NO_READ : { ...NO_READ, verdict: reused.verdict })
      : tooLate
        ? Promise.resolve(NO_READ)
        : reader.read(s.scope, s.key, input, s.abort.signal);
    // The push's reading, for a later ask in the same request (`readerReuse`): its pool's items and their content.
    if (opts.push && this.config.readerReuse) {
      s.pushRead = {
        request: opts.request ?? s.requests,
        main,
        hashes: new Map(input.items.map((it) => [it.id, it.hash])),
        verdict: reading.then(
          (r) => r.verdict,
          () => null,
        ),
      };
    }
    let got: ReaderRead | "late";
    try {
      // An explicit ask stops waiting at `waitMs`; the push (Infinity) waits for the reading, with no timer left
      // pending, bounded by the reader's call and the session's close.
      got = tooLate
        ? "late"
        : reused
          ? reused === "late"
            ? "late"
            : await reading
          : Number.isFinite(waitMs)
            ? await Promise.race([
                reading,
                new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), Math.max(0, readWaitMs)))),
              ])
            : await reading;
    } catch {
      got = NO_READ;
    } finally {
      clearTimeout(timer);
    }
    // A late call is not this ask's to report (its `costUsd` 0, `called` false, so `AskResponse.usedModel` is false):
    // when the call this ask started lands, it gets a "reader-late" trace of its own with its cost, so a harness that
    // sums traces counts each call once. Emitted even if the session has closed by then: the call was paid for. A
    // read that joined another's call (`starts` false) leaves that call to the read that started it. A read the budget
    // refused, a cached one and a joined one made no call.
    if (got === "late" && starts) {
      const turn = s.turn;
      void reading.then(
        (r) => {
          if (!r.called) return;
          this.trace(s, {
            sessionId: s.id,
            turn,
            event: "ask",
            decision: "reader-late",
            reason: cue.id,
            latencyMs: Math.round(performance.now() - t0),
            sourceCalls: 0,
            modelCalls: 1,
            costUsd: r.costUsd,
            readerCalls: 1,
            readerCostUsd: r.costUsd,
            itemIds: [],
          });
        },
        () => undefined,
      );
    }
    const costUsd = got === "late" ? 0 : got.costUsd;
    const called = got === "late" ? false : got.called;
    const unchanged = {
      chosen,
      notes: new Map<string, string>(),
      kinds: new Map<string, ReaderKind>(),
      read: false,
      called,
      costUsd,
    };
    if (got === "late" || got.verdict === null) {
      report(got === "late" ? "late" : got.overBudget ? "budget" : "none");
      return unchanged;
    }
    const verdict = got.verdict;
    // A reused verdict read the push's pool: it read every candidate here only if each was in that pool, unchanged.
    if (reused && reused !== "late" && !reused.all) readsAll = false;
    const byId = new Map(pool.map((x) => [x.item.id, x]));
    const notes = new Map<string, string>();
    const kinds = new Map<string, ReaderKind>();
    const lead: Scored[] = [];
    for (const b of verdict.bears) {
      const x = byId.get(b.id);
      if (!x || lead.includes(x) || lead.length >= limit) continue;
      lead.push(x);
      notes.set(b.id, readerNote(b.kind, b.why));
      kinds.set(b.id, b.kind);
    }
    report(
      "read",
      verdict.bears.filter((b) => notes.has(b.id)).map((b) => ({ id: b.id, kind: b.kind })),
    );
    // `askReaderDrop`: what the reader read and rejected by name leaves the answer (never what it flagged).
    const rejected = this.config.askReaderDrop ? new Set(verdict.rejected ?? []) : new Set<string>();
    let rest = chosen.filter((x) => !lead.includes(x) && !rejected.has(x.item.id));
    // A drop that would leave the answer empty is made only when the reader read every candidate (D114): otherwise
    // the empty answer ("Nothing in the connected sources") would be a false all-clear over items it never read (D93).
    if (lead.length === 0 && rest.length === 0 && !readsAll) rest = chosen.filter((x) => !lead.includes(x));
    return {
      chosen: [...lead, ...rest].slice(0, limit),
      notes,
      kinds,
      read: true,
      called,
      costUsd,
    };
  }
  /** `pushLookup` (D1252): the records a silent push hands, framed as reference and cut as candidates are. */
  private lookupFrame(kind: "named" | "head"): PacketFrame {
    const lead = kind === "head" ? LOOKUP_HEAD_LEAD : LOOKUP_LEAD;
    // `pushLookupQuiet`: the last sentence says the records are background, not a reason to warn.
    return {
      ...this.candidateFrame(),
      lead: this.config.pushLookupQuiet ? lead.replace(LOOKUP_USE, LOOKUP_QUIET) : lead,
    };
  }

  /** `pushCandidates` (D236): how the candidates' packet is framed and cut. */
  private candidateFrame(nudge = false): PacketFrame {
    // At most the pool's items (`candidatesOf`), each at most `MAX_CANDIDATE_BYTES`: the packet's size is bounded too.
    const k = Math.min(this.config.pushCandidates, this.config.askReaderPool, READER_POOL_CAP);
    const each = Math.min(this.config.compactItemBytes, MAX_CANDIDATE_BYTES);
    return {
      lead: nudge ? `${CANDIDATES_LEAD} ${ASK_NUDGE}` : CANDIDATES_LEAD,
      itemBytes: each,
      // Room for every candidate's excerpt and its `- [source] title: ` line, beyond the usual packet's cap.
      maxBytes: Math.max(this.config.maxInjectionBytes, 400 + k * (each + 120)),
    };
  }
}

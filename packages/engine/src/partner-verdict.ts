/**
 * The partner's verdict slice (R3, D2021): everything between "an item exists" and "it is worth showing".
 * `PartnerVerdict extends PartnerCheck` — the class chain is
 * `ContextPartner extends PartnerAsk extends PartnerVerdict extends PartnerCheck extends PartnerDelivery extends
 * PartnerCore` (the ask itself lives one step up, in `partner-ask.ts`, D2023).
 *
 * Two request paths share this machinery, which is why it sits below both rather than in either:
 *
 * - the push path (observe → pushGate/checkPush): the gate, the sheet of candidates, the behind-status queue and
 *   the plan-conflict alert, ending in `deliverChecked` / `enqueueCards`;
 * - the ask path (`ask` → `readAsk` in `partner-ask.ts`): anchor expansion, the rare-term and card finds, live
 *   source search (`engageSources`, `probe`, `consequence`), then `charge`/`settle` accounting.
 *
 * Both end at `verdict` — the grounded judgement (`frame`, `factsOf`, `contradicts`, `confident`, `carry`, `acts`,
 * `conflicts`, `companions` and friends) that decides what a packet may claim. Nothing here calls back into the
 * observe/session shell above it; what it needs of the partner's own state lives on `PartnerCheck` and below.
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

export interface PartnerDeps {
  sources: SourceResolver;
  sourceMap: SourceMap;
  cache: ItemCache;
  budget: Budget;
  /** Null runs the engine with no model at all: fast and source paths only. */
  model: Model | null;
  config?: Partial<EngineConfig>;
  /**
   * The turn gate for `pushGate` (D1014): omitted, the shipped weights (`turnGate()`, read once a process); null, no
   * gate, so `pushStart` decides alone (what a missing or unreadable weights file gives).
   */
  turnGate?: TurnGate | null;
  onTrace?: TraceSink;
  /** Whether the agent used each injection, once known (D293): content-free, for an integrator's digest. */
  onUsage?: UsageSink;
  now?: () => number;
  /**
   * A timer on `now`'s clock (`SyncDeps.after`), for `syncKick`'s waits. Absent: `setTimeout`, right when `now` is
   * the wall clock; pass one with any other `now`.
   */
  after?: (ms: number, fn: () => void) => () => void;
  /**
   * A worker pool (`WorkerPool` started on `GATE_MODULE`) that redacts lookup results off the event loop (D26). The
   * partner builds its source fan-out itself, so redaction before anything is held can never be swapped out.
   */
  gatePool?: Pick<WorkerPool, "runOrInline">;
  /**
   * Decides what each lookup sends to each connector, learned per (tenant, user, connector)
   * (docs/plans/query-planner.md). Absent: every connector gets the cue's terms and entities as before.
   */
  planner?: QueryPlanner;
  /** Receives the planner's shadow lookups when `planner.mode` is "shadow". */
  onShadow?: ShadowSink;
  /**
   * Receives each finished span (`spans.ts`): every phase of every event, with wall and CPU time, content-free. With
   * neither this nor `config.spans`, no span is made: each phase costs one null check.
   */
  onSpan?: SpanSink;
  /**
   * Implication cards (`cards.ts`, `config.cards`): made in the background from items entering the cache, matched at
   * request time with no model. Absent, or the flag off: no card is made or read.
   */
  cards?: CardEnricher;
  /**
   * The ask-time model reader (`reader.ts`, `config.askReader`): its own model, budget and per-user, per-session cache
   * of verdicts. Absent, or the flag off: no call is made.
   */
  reader?: AskReader;
  /**
   * A lab hook (`hidden-funnel.ts`): what the reader did for each ask, content-free (item ids, kinds, counts, timing).
   */
  onReader?: ReaderSink;
  /**
   * A debug hook for the lab (docs/research/econ-decide.md): each no-model decision's candidates with their facts
   * (`decide.ts`) and what was delivered. Ids and numbers only, no content. Absent: no facts are computed for it.
   */
  onCandidates?: CandidateSink;
  /**
   * A lab hook (`hidden-funnel.ts --pool-dump`, D269): each `pushCandidates` pass's pool and what it handed, ids and
   * flags only. Apart from `onReader`, whose consumers count reader readings.
   */
  onPushPool?: PushPoolSink;
  /**
   * Tests only (D1927's differential test): the partner's sync adds every listed item's words again at every store,
   * as before D1927 (`SyncOptions.resketchForTests`). No config sets it; never set by a server or the lab.
   */
  syncResketchForTests?: boolean;
  /**
   * The push check's model call (`push-check.ts`, `pushCheck`, D500, in the default since D828), with its own budget.
   * Absent (no model key), or the flag off: no call is made and the default's candidates go.
   */
  checker?: PushChecker;
}

/** One `pushCandidates` pass (`PartnerDeps.onPushPool`): no content, no model call. */
export interface PushPoolReport {
  sessionId: string;
  /** The push's pool in order (the ids the reader would have read). */
  pool: string[];
  /** Per pool item, `readerGate`'s constraint test (cards included). */
  constraintLike: boolean[];
  /** The candidates handed (none when no pooled item is constraint-like). */
  handed: string[];
  /** `askNudge` (D316): whether the handed candidates leave the request unsettled (the packet then nudges an ask). */
  unsettled?: boolean;
  /**
   * When the request's anchors were read (`askNudge` or `pushCandidatesSettled`), per pool item whether it holds one
   * of them (`anchored`), and what kinds the request names: flags only, for the lab's trigger screens (M5).
   */
  anchored?: boolean[];
  anchorKinds?: { entities: number; day: boolean };
  /**
   * `pushCheck` (D500): what the pass's check did ("yes": it answered; "none": no call, the gate found nothing
   * constraint-like; "late", "failed": the default's candidates went) and, when it answered, per pool item whether it
   * said the item changes the action (all false: the push sent no packet).
   */
  check?: "yes" | "none" | "late" | "failed";
  checked?: boolean[];
  /**
   * This pass made the check's model call and had its answer within the wait: not a pass that read a kept answer,
   * or whose call ran past `pushCheckWaitMs` (traced "check-late" when it lands).
   */
  checkCalled?: boolean;
  /** `pushLookup` (D1252): `handed` is reference records naming the request's anchors, or (`head`) the pool's head. */
  lookup?: "named" | "head";
  /** `pushCheckSheet` (F5): the item ids of the rule sheet the check read, in its order (ids only, for the lab). */
  sheet?: string[];
}

export type PushPoolSink = (report: PushPoolReport) => void;

/** One no-model decision's candidates, for `PartnerDeps.onCandidates`. */
export interface CandidateDump {
  sessionId: string;
  turn: number;
  /** Where the decision was made: the fast path or the lookup. */
  path: "fast" | "lookup" | "served" | "ask";
  candidates: { id: string; facts: Facts }[];
  delivered: string[];
  /**
   * How the rule paths decided (`sure`, `grounded-<how>`, `fallback`, `corrected`, or empty for silence).
   */
  how: string;
  /** The ask's pool before its cut to the item limit: what the rule paths would cite, in their order (path "ask"). */
  pool?: string[];
}

export type CandidateSink = (dump: CandidateDump) => void;

/** What the reader did for one ask (`PartnerDeps.onReader`): ids, kinds and counts, no content. */
export interface ReaderReport {
  sessionId: string;
  /** Items it was given, the items it said bear (with their kind), and whether it answered in time. */
  checked: number;
  /** The ids it was given, in order. */
  pool: string[];
  flagged: { id: string; kind: ReaderKind }[];
  /**
   * "read" (a verdict, from a call or the cache), "late" (the wait ran out), "budget" (the reader's `Budget` refused
   * the call: a session or day cap), "none" (no pool, a failed or unreadable call), "gated" (`readerGate`).
   */
  outcome: "read" | "late" | "budget" | "none" | "gated";
  waitedMs: number;
}

export type ReaderSink = (report: ReaderReport) => void;

/**
 * The `item` ask's answer cap in code units (D2022, A2): the cited item's parts in full — an answer's excerpts
 * stop at `askItemBytes` — bounded so one item's answer stays a packet, not a dump.
 */
export const ASK_ITEM_BYTES = 16_000;

/** The `item` ask's answer when the cited id holds nothing (evicted, dropped or never cited). */
export const ITEM_GONE = "That item is no longer held: it left the user's sources or was never cited here.";

/** Terms a follow-up's `carry` may add to its cue: its own terms plus the previous request's and the delivered
 * items'. */
export const CARRY_TERMS = 3;

/**
 * Output caps for the two model calls. Reasoning models (the default GLM among them) spend part of the cap thinking
 * before they answer; at 60 tokens the judge's verdict was cut off most of the time (D45). The caps bound spend, which
 * is billed on tokens used: a verdict is a few tokens plus low-effort reasoning.
 */
export const JUDGE_MAX_TOKENS = 512;

/** Probes a user's cache remembers (`ItemCache.rememberProbe`): enough for the people and days of their week. */
export const PROBE_MEMO = 256;

/** Consequence-probe finds a lookup ranks (`consequenceProbe`): its own and its class's earlier ones still cached. */
export const MAX_CONSEQUENCE = 8;

/** What a lookup's probes found: the calls they made, their finds, and the consequence probe's (`consequence`). */
export interface ProbeOut {
  calls: number;
  kept: string[];
  consequence?: { cls: ActionClass; ids: string[] };
}

/** One probe query (`Partner.probe`'s `send`): its kind, sources, words or day, and what to do with live answers. */
export type ProbeSend = (
  kind: ProbeKind,
  sources: Source[],
  text: string,
  window?: SearchQuery["window"],
  keep?: boolean,
  onAnswer?: (sourceId: string, page: ContextItem[]) => void,
) => Promise<ContextItem[]>;

/** How a probe run differs from a lookup's own (`Partner.probe`). */
export interface ProbeOpts {
  /** Source calls it may make (default `probeCalls`). */
  budget?: number;
  /** Synced sources whose copy is current (`sync`, D57): they answer from the local index, at no call. */
  local?: ReadonlySet<string> | null;
  /** The lookup's deadline (`performance.now()` time, D140); absent: `sourceTimeoutMs` from when the probes start. */
  deadlineAt?: number;
  /** `routeLocalHits` (D265): the lookup's local evidence per source, for the probes' routing. */
  boost?: ReadonlyMap<string, number>;
}

/** `intent`'s reciprocal-rank constant: rank 0 scores 1/k (the usual 60 flattens a five-item list to a tie). */
export const ASK_FUSE_K = 2;

/** Each cue's frame (`conflict.ts`), read once and dropped with the cue. */
export const FRAMES = new WeakMap<Cue, Frame>();

/** A request's names as the rule paths read them: its people cleaned, addresses left out, and their words. */
export interface CueNames {
  /** `cleanEntities(cue.entities)` with no address. */
  names: string[];
  /** `mentionWords(names)`, for `mentionsAny`. */
  words: string[][];
}

/**
 * Each cue's names, read once and dropped with the cue (D1920): the conflict, away and fallback paths and `about`
 * cleaned the entities again for every candidate (`cleanEntities` was 0.8% of the pipeline bench on its own).
 */
export const CUE_NAMES = new WeakMap<Cue, CueNames>();

export const NO_NAMES: CueNames = { names: [], words: [] };

export function cueNames(cue: Cue): CueNames {
  let n = CUE_NAMES.get(cue);
  if (!n) {
    const names = cleanEntities(cue.entities).filter((e) => !e.includes("@"));
    CUE_NAMES.set(cue, (n = { names, words: mentionWords(names) }));
  }
  return n;
}

/** Requests that act on someone, where an item they take part in is context (D44). */
export const ACTING = new Set<string>(["scheduling", "communication", "task", "travel"]);

/**
 * A request about meeting someone (moving plans, running late, "still on for lunch?"): only an event with them is the
 * item it is about, never another thread they are on (D44).
 */
export const ABOUT_MEETING =
  /\b(meet(ing)?|plans?|push|reschedul\w*|postpone|cancel|still on|running late|late|lunch|coffee|dinner|drinks|call|catch(ing)? up|slot|1:1)\b/i;

/** Words of a request that only say when or ask about the calendar: with nothing else, it is a listing (D44). */
export const TIME_WORD =
  /^(|calendar|schedule|diary|agenda|plans?|busy|free|happening|booked|today|tonight|tomorrow|yesterday|week|weekend|next|coming|upcoming|morning|afternoon|evening|(mon|tues|wednes|thurs|fri|satur|sun)day|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|\d{1,2}(st|nd|rd|th)?)$/;

/**
 * Words that make a request act on someone, for grounding alone (D44): the situation labels (`situation.ts`) stay as
 * they were, since the source map learns per label.
 */
export const ACTS_ON = /\b(write|note|thank|chase|ping|tell|intro(duce)?)\b/i;

/** A question about the calendar itself: then every event on the day it names is the answer (D44). */
export const ASKS_SCHEDULE = /\b(calendar|schedule|diary|agenda|plans?|busy|free|on for|happening|booked)\b/i;

/** A request asking whether a day it names is open ("free then?", "a clash at that time"): its events answer. */
export const ASKS_FREE = /\b(free|clash|clashing|conflict\w*|busy|double.?book\w*|overlap\w*)\b/i;

/** A clash ask: not a day listing, but a question about one time (D1979). */
export const ASKS_CLASH = /\b(clash|clashing|conflict\w*|double.?book\w*|overlap\w*)\b/i;

/** A wh-question about a thing of the user's own ("When is my physio appointment?", D1980; `probes.ts`). */
/** "that time", "then": the ask's span lives in the turn it answers, not in its own words (D1979). */
export const ANAPHORIC_TIME = /\b(that time|then|that slot|same time)\b/i;

/**
 * Identifier-shaped numbers a text carries: three digits or more, or thousands-separated ("2,300" → "2300"), never
 * part of a code (the digits of "TP1357" stay letters' own). Four-digit years are not identifiers — a year pins the
 * item's date, `requestYear` reads those.
 */
export const ID_NUMBERS = /(?<![\p{L}\p{N}])(?:\d{1,3}(?:,\d{3})+|\d{3,})(?![\p{L}\p{N}])/gu;

export const YEARS = /\b(?:19|20)\d{2}\b/g;

/**
 * The years a document is *of*: its `meta.start` year and the year in its title; the text's years only when
 * the title names none. A later date in the body — a deadline, an offer's expiry — is not the record's own
 * year, so an old notice that mentions one is not read as newer than the current one.
 */
export const docYears = (item: ContextItem): number[] => {
  const titled = item.title.match(YEARS)?.map(Number) ?? [];
  const started = item.meta?.start !== undefined ? [Number(item.meta.start.slice(0, 4))] : [];
  const body = titled.length === 0 ? (item.text.match(YEARS)?.map(Number) ?? []) : [];
  return [...new Set([...titled, ...started, ...body])];
};

/**
 * The words a document writes to say it is itself dead: a bracketed or capitalized marker in its title
 * ("[OLD]", "(superseded)", "— EXPIRED"), a staleness word in its title, or a phrase in its opening lines
 * declaring it superseded, replaced, expired, withdrawn or out of date. A bare "old" is not one: it is a
 * word of names and places ("Old Town", "old friends") too often to condemn a document on. What it was
 * about may still be asked for — `asksOld` is the request's say for that.
 */
// The words a rule document is written in: an item carrying two or more is the policy of the matter a
// pick already names (the fare rules beside the booking), not a look-alike of it.
const POLICY_WORDS = new Set([
  "policy",
  "policies",
  "fare",
  "fares",
  "fee",
  "fees",
  "penalty",
  "penalties",
  "cancellation",
  "cancellations",
  "refund",
  "refunds",
  "surcharge",
  "surcharges",
  "eligibility",
  "charge",
  "charges",
]);

// A rule document reads as one on its own words, before any pick: two or more of the policy vocabulary.
const ruleDoc = (words: ReadonlySet<string>) => [...words].filter((t) => POLICY_WORDS.has(t)).length >= 2;

const STALE_TAG = /[\[(（【]\s*(?:old|superseded|expired|outdated|out[- ]of[- ]date|previous|archived|void)\b/i;
const STALE_CAPS = /\b(?:OLD|SUPERSEDED|EXPIRED|OUTDATED|VOID)\b/;
const STALE_TITLE = /\b(?:superseded|withdrawn|obsolete|outdated)\b|^\s*cancell?ed\b/i;
const STALE_DECLARED =
  /\b(?:superseded by|has been superseded|has been replaced by|no longer valid|was withdrawn|has been withdrawn|out of date)\b/i;
/** How far into a document its own death notice is read (`STALE_DECLARED`): the preamble where it is written. */
const STALE_CHARS = 400;
/** The request names the old version or a stale state itself: the stale copy is then the answer, not a look-alike. */
const ASKS_OLD =
  /\b(?:old|previous|earlier|former|prior|original|superseded?|expired?|outdated|out[- ]of[- ]date|obsolete|last year(?:'s)?|used to|before the (?:new|change|update|revision|renewal)|cancell?ed|cancell?ation)\b/i;
const MONTHS3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A month name ("Jan", "September") as a capturing regex fragment — `partner`'s `TIME_OR_DATE` uses it too. */
export const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|" +
  "nov(?:ember)?|dec(?:ember)?)";
/**
 * The words that lead a document's own expiry ("expires", "valid until", "offer ends", "closing date"):
 * each followed by the date it runs out. A bare "until" or "ends" is no lead — a meeting "ends on Friday"
 * is an occurrence's time, not a record's death; nor is past-tense "expired" one — "your passport expired
 * on 30 Sep" reports the subject's state, and the notice itself is the current record.
 */
const EXPIRY_LEAD =
  /\b(?:expires?|expiry|valid(?:ity)?\s+(?:until|through|to|till)|offer ends|ends on|closing(?:\s+date)?|available (?:until|through|to)|runs (?:until|out on)|last day)\s*:?\s*/gi;
/**
 * The date an `EXPIRY_LEAD` match's tail writes: ISO, day-month(-year), month-day(-year), or month-year.
 * Groups: 1-3 ISO; 4 day, 5 month, 6 year; 7 month, 8 day, 9 year; 10 month, 11 year (`MONTH` captures).
 */
const EXPIRY_DATE = new RegExp(
  String.raw`(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)?(?!\d)\s+(?:of\s+)?(?:${MONTH})\b\s*,?\s*(\d{4})?|(?:${MONTH})\b\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)\s*,?\s*(\d{4})?|(?:${MONTH})\b\s*,?\s*(\d{4})?`,
  "y",
);
/** The expiry a document declares, as the latest end it names (ms): its last deadline is when it dies. */
const expiryOf = (item: ContextItem, writtenAt: number): number | null => {
  const lower = `${item.title} ${item.text.slice(0, 1_500)}`.toLowerCase();
  let latest: number | null = null;
  for (const m of lower.matchAll(EXPIRY_LEAD)) {
    EXPIRY_DATE.lastIndex = m.index + m[0].length;
    const d = EXPIRY_DATE.exec(lower);
    if (d === null) continue;
    let y = Number(d[1] ?? d[6] ?? d[9] ?? d[11]);
    const month = d[2] !== undefined ? Number(d[2]) - 1 : MONTHS3.indexOf((d[5] ?? d[7] ?? d[10])!.slice(0, 3));
    let day = Number(d[3] ?? d[4] ?? d[8] ?? 0);
    if (d[10] !== undefined) day = 0; // month-year alone: the month is the deadline
    if (month < 0 || month > 11 || day > 31) continue;
    if (!y) {
      // No year written: the first such date on or after the day it was written is the one it means
      // ("expires 15 March" in a mail of December is next March). A bare month is its own end:
      // "offer ends November" written mid-November runs out this November, not next year's.
      y = new Date(writtenAt).getUTCFullYear();
      const ref = day === 0 ? Date.UTC(y, month + 1, 0) : Date.UTC(y, month, day);
      if (ref < writtenAt - 86_400_000) y++;
    }
    const end = day === 0 ? Date.UTC(y, month + 1, 0) + 86_400_000 : Date.UTC(y, month, day) + 86_400_000;
    if (latest === null || end > latest) latest = end;
  }
  return latest;
};
/**
 * A document whose title names its own date, or `meta.start` (its day): the range it is *of*, as
 * `[lo, hi)` milliseconds. The title's full dates (day-month-year) and month-years ("March 2026") first; a
 * bare year is the whole year; a date with no year is read in the year it was written (or the year before
 * when that month is still ahead). The body's dates never date the record — an expiry it mentions is not
 * the record's own time (`docYears`'s rule, D1982). Null when nothing dates it.
 */
export const docSpan = (item: ContextItem, written: number): [number, number] | null => {
  let lo = Infinity;
  let hi = 0;
  const stretch = (a: number, b: number) => {
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  };
  if (item.meta?.start !== undefined) {
    const t = Date.parse(item.meta.start);
    if (!Number.isNaN(t)) stretch(t, t + 86_400_000);
  }
  for (const m of item.title.matchAll(DOC_DATE)) {
    let y = Number(m[1] ?? m[6] ?? m[9] ?? m[11]);
    const month =
      m[2] !== undefined
        ? Number(m[2]) - 1
        : MONTHS3.indexOf((m[5] ?? m[7] ?? m[10] ?? m[12])!.slice(0, 3).toLowerCase());
    let day = Number(m[3] ?? m[4] ?? m[8] ?? 0);
    // A month alone — year'd ("March 2026") or set off by a separator ("— September") — is the month's range.
    if (m[10] !== undefined || m[12] !== undefined) day = 0;
    if (month < 0 || month > 11 || day > 31) continue;
    if (!y) {
      // No year written: the nearest year's date — a "September statement" updated in November is this
      // September's (which would otherwise outrank the current November revision), and "renews on
      // 8 November" written three days earlier is the coming one, not last year's.
      y = new Date(written).getUTCFullYear();
      const half = (365.25 * 86_400_000) / 2;
      const d = Date.UTC(y, month, day || 1);
      if (d - written > half) y--;
      else if (written - d > half) y++;
    }
    day === 0
      ? stretch(Date.UTC(y, month, 1), Date.UTC(y, month + 1, 1))
      : stretch(Date.UTC(y, month, day), Date.UTC(y, month, day + 1));
  }
  if (hi === 0) {
    // No full or month date: a bare year in the title is the record's year.
    for (const y of item.title.match(YEARS)?.map(Number) ?? []) stretch(Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1));
  }
  if (hi === 0) {
    // The title names no date at all: the body's years stand in, as `docYears` reads them (a later expiry
    // in the text is not the record's year — but it is all the date the record carries).
    for (const y of item.text.match(YEARS)?.map(Number) ?? []) stretch(Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1));
  }
  return hi === 0 ? null : [lo, hi];
};
/**
 * Every date form `docSpan` reads of a title: ISO, "13 November 2026", "November 13, 2026", "March 2026".
 * Groups: 1-3 ISO; 4 day, 5 month, 6 year; 7 month, 8 day, 9 year; 10 month, 11 year (`MONTH` captures).
 */
const DOC_DATE = new RegExp(
  String.raw`\b(\d{4})-(\d{1,2})-(\d{1,2})|\b(\d{1,2})(?:st|nd|rd|th)?(?!\d)\s+(?:of\s+)?(?:${MONTH})\b\s*,?\s*(\d{4})?|\b(?:${MONTH})\b\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)\s*,?\s*(\d{4})?|\b(?:${MONTH})\b\s*,?\s*(\d{4})|[-–—:(|]\s*(${MONTH})\b(?!\s*,?\s*\d)`,
  "gi",
);
/** What `staleSelf` and `staleIds` read of an item once: whether it declares itself dead, and its own expiry. */
const staleOf = (item: ContextItem, written: number): { declared: boolean; expiry: number | null } => {
  let r = staleMemo.get(item);
  if (r === undefined) {
    r = {
      declared:
        STALE_TAG.test(item.title) ||
        STALE_CAPS.test(item.title) ||
        STALE_TITLE.test(item.title) ||
        STALE_DECLARED.test(item.text.slice(0, STALE_CHARS)),
      // Resolved once, against the write time first seen: a yearless deadline that has already
      // passed does not roll into next year on every later request.
      expiry: expiryOf(item, written),
    };
    staleMemo.set(item, r);
  }
  return r;
};
const staleMemo = new WeakMap<ContextItem, { declared: boolean; expiry: number | null }>();
/** A month name in the request's own words ("balance on 30 September?") — like a literal year, it dates the ask. */
const MONTH_NAME = new RegExp(String.raw`\b(?:${MONTH})\b`, "i");

/** A number followed by a measure or money word is a quantity ("650 GBP", "30 days"), not an identifier. */
export const QUANTITY = /^\s*(?:GBP|USD|EUR|pence|kg|km|miles?|%|days?|weeks?|months?|years?|people|of us)\b/i;

/**
 * Whether an item bearing these identifier numbers and another item are the same fact. Numbers on both sides that
 * share nothing say different things however alike the words read ("order 881 has shipped" against "order 874 was
 * delivered"); no numbers either side, or any shared one, keeps the near-duplicate read as it was.
 */
export const sameRef = (refs: ReadonlySet<string>, item: ContextItem): boolean => {
  if (refs.size === 0) return true;
  const have = itemRefs(item);
  if (have.size === 0) return true;
  for (const id of refs) if (have.has(id)) return true;
  return false;
};

/** A request that moves something onto a named day: the day's other timed items are the clash it would make. */
export const MOVES = /\b(move|moved|reschedul\w*|postpone|push|switch\w*|change)\b/i;
/** The request claims a thing for the user: "my flight", "our booking". */
const FIRST_PERSON = /\b(?:my|mine|our|ours)\b/i;
/** The mark of a document handed on from its holder: "Fwd:" / "FW:" — also behind a reply's "Re:" — say the
 * thing it names is someone else's. A bare "Re:" is a thread's own reply, not a hand-off. */
const FORWARDED = /^\s*(?:(?:re|fwd?|fw)\s*:\s*)*fwd?\s*:/i;
/** A forwarded title declaring a named party's thing: "Fwd: Sam Okoro's flight to Lisbon" — owner, then the thing. */
const OWNED_BY = /\b([\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+){0,2})['’]s\s+([\p{L}\p{N}]+)/gu;

/**
 * An entity used as a setting or topic, not the subject ("novels set in Delhi", "books about Rome"): the word
 * before its first mention tells them apart — "my Lisbon flight" names the subject, "in Delhi" names a place
 * it is about. `to`/`for`/`from` stay subject words ("the flight to Lisbon", "a refund for the kettle").
 */
export const SETTING_WORDS = new Set(["in", "about", "around", "like", "near", "called", "named"]);

export const wordBefore = (raw: string, entity: string): string => {
  const i = raw.toLowerCase().indexOf(entity.toLowerCase());
  if (i < 0) return "";
  return raw.slice(0, i).trim().split(/\s+/).pop()?.toLowerCase() ?? "";
};

/** Content words of a text: lowercase word characters minus the stop-words (`subject` compares these). */
export const contentWords = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) if (!isStopword(m[0])) out.push(m[0]);
  return out;
};

/** The words a text writes capitalized, lowercased for matching: proper names a bare lowercase read loses. */
export const capitalWords = (text: string): Set<string> =>
  new Set((text.match(/\p{Lu}[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase()));

export const idNumbers = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const m of text.matchAll(ID_NUMBERS)) {
    const n = m[0].replaceAll(",", "");
    if (/^(19|20)\d{2}$/.test(n)) continue;
    // A number named as money or a measure ("£2,400", "GBP 2,400", "650 GBP", "3 laptops" beside a noun), spoken
    // as a time ("at 1400", "by 900") or a model number ("737 MAX") is an amount the request states, not the
    // identifier an item must share.
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (/[\u00a3$\u20ac]\s*$/.test(before) || /\b(?:GBP|USD|EUR|at|by|until|from|around|about)\s*$/i.test(before))
      continue;
    const after = text.slice(m.index + m[0].length);
    if (QUANTITY.test(after) || /^\s+[A-Z]{2,}\b/.test(after)) continue;
    out.add(n);
  }
  return out;
};

/**
 * The features the pool passes extract from an item, computed once each. `contradicts`, `companions`, the stale
 * reads and the pick bookkeeping each re-ran their regexes over `${title} ${text}` — `linked` scanned one item's
 * text four times — per candidate, per request. The WeakMap keeps a feature alive only as long as the item object
 * is (the same pattern as `staleMemo`), and items are immutable once stored. The text itself is not kept: a packed
 * item's `text` decodes on read under a bounded memo (`packed-text.ts`), and a pinned concat would hold every
 * scanned item's whole decoded body for the item's life — the extracted feature is the small part.
 */
const ITEM_FEATURES = new WeakMap<
  ContextItem,
  { words?: string[]; caps?: Set<string>; refs?: Set<string>; years?: Set<number> }
>();
const itemText = (item: ContextItem): string => `${item.title} ${item.text}`;
const itemFeatures = (item: ContextItem) => {
  let f = ITEM_FEATURES.get(item);
  if (f === undefined) {
    f = {};
    ITEM_FEATURES.set(item, f);
  }
  return f;
};
const itemWords = (item: ContextItem): string[] => (itemFeatures(item).words ??= contentWords(itemText(item)));
const itemCaps = (item: ContextItem): Set<string> => (itemFeatures(item).caps ??= capitalWords(itemText(item)));
const itemRefs = (item: ContextItem): Set<string> => (itemFeatures(item).refs ??= idNumbers(itemText(item)));
const itemYears = (item: ContextItem): Set<number> =>
  (itemFeatures(item).years ??= new Set((itemText(item).match(YEARS) ?? []).map(Number)));

/**
 * The year a request speaks from: a year it names, else the year of a day it names — never later than now, since a
 * day ahead does not make this year's items last year's. A request naming no year or day has no reference year:
 * most facts are written in a past year, so an undated request must not declare them stale. An item dated only
 * earlier is last year's look-alike, not what the request means (D1970).
 */
export function requestYear(cue: Cue): number | null {
  // A 19xx/20xx number that prices something is no year the request names ("£1,950" is an amount — the same
  // money context `idNumbers` drops). No preposition filter: "at 2023" and "by 2023" name years as readily as
  // clock times, and a spurious year only weakens the floor where a dropped one loses records.
  const named: number[] = [];
  YEARS.lastIndex = 0;
  for (const m of cue.raw.matchAll(YEARS)) {
    const before = cue.raw.slice(Math.max(0, m.index - 8), m.index);
    if (/[£$€]\s*$/.test(before) || /\b(?:GBP|USD|EUR)\s*$/i.test(before)) continue;
    named.push(Number(m[0]));
  }
  for (const d of cue.time?.days ?? []) {
    const y = Number(d.slice(0, 4)) || 0;
    if (y > 0) named.push(y);
  }
  if (named.length === 0) return null; // no year or day named: nothing to be stale against
  // The earliest year named is the look-alike floor: a request that names two years asks across them both —
  // "how did 2023 compare with 2024" wants the earlier side's records, not 2024's alone (D2061). A day ahead
  // still makes this year's items no older, so the floor is capped at now either way.
  return Math.min(Math.min(...named), new Date(cue.at).getUTCFullYear());
}

/**
 * When an item's title qualifies a name the request uses by a parenthesised word — "Jordan Pike (Contoso)",
 * "Jordan Pike (Northwind)" — that qualifier: the organisation or role the item ties the name to.
 */
export function qualifierOf(entity: string, title: string): string | null {
  const esc = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\b${esc}\\s*\\(([^)]+)\\)`, "i").exec(title);
  return m === null ? null : m[1]!.trim().toLowerCase();
}

/** What an injection was built from, kept until it is handed out and usage tracking starts. */
/**
 * What a push packet's delivery marked (`readerPushBehind`): per item it marked, the ledger entry before and after,
 * and the sketch it added to the session's near-duplicate memory.
 */
export type Undo = Map<string, { was: LedgerEntry | undefined; set: LedgerEntry; sketch: Sketch | null }>;

/** How one source an ask chose fared (D127; `AskResponse.sources`). */
export type SourceStatus = NonNullable<AskResponse["sources"]>[number];

/** The statuses of a source that answered (D127): the connector, the fan-out's held result, or the synced index. */
export const ANSWERED = new Set(["ok", "cached", "stale", "local"]);

/** `askBehind` (D430): a source whose poll or live search was still running when the ask answered. */
export const SEARCHING = "searching";

/**
 * `sourceYield` (D505, D603): a cut copy an ask did not search: its source's run of unused live reads is spent, or
 * nothing of the source has ever been used, and the request has no name or rare word for it.
 */
export const UNSEARCHED = "unsearched";

/** How the answer names a status that did not answer (`unreached`). */
export const STATUS_WORDS: Record<string, string> = {
  error: "failed",
  timeout: "timed out",
  open: "failing, skipped",
  busy: "busy",
  limited: "rate-limited",
  // The connector's own 429 (D212): the same words as our own limit's skip; to the agent both mean "try later".
  throttled: "rate-limited",
};

/** `pushCandidates` (D236): the most of an item a candidate's excerpt says, whatever `compactItemBytes` is set to. */
export const MAX_CANDIDATE_BYTES = 2_000;

/** A model call's span attributes: tokens, cost and whether it was cut off. Counts only. */
export function modelAttrs(res: {
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  truncated?: boolean;
}) {
  return {
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUsd: res.costUsd,
    truncated: res.truncated === true,
  };
}

/**
 * An ask's answer text (D127): `packet` (empty when no item answers), with the sources the ask chose that did not
 * answer named. An empty answer reads "Nothing in the connected sources." only when every chosen source answered (or
 * none was chosen); otherwise it says which could not be reached and that this is not an all-clear. Source ids are the
 * operator's names for its connectors, not source text. Items left out because a change signal doubted them and no
 * re-read confirmed them (`unconfirmed`, by source, D211) are named too: an answer short of them is not an all-clear.
 */
export function honestAnswer(
  packet: string,
  sources: readonly SourceStatus[] | undefined,
  unresolved = false,
  closed = false,
  unconfirmed?: ReadonlyMap<string, number>,
  unswept?: ReadonlyMap<string, number>,
): string {
  const told = reachAnswer(packet, sources, unresolved, closed);
  const notes: string[] = [];
  const list = (m: ReadonlyMap<string, number>) => [...m].map(([id, n]) => `${id} (${n})`).join(", ");
  if (unconfirmed && unconfirmed.size > 0) {
    const why = "their source reported changes and they could not be re-checked";
    notes.push(`Left out items from ${list(unconfirmed)}: ${why}`);
  }
  // D356: a source swept weekly whose copies no listing has seen for a day; nothing was reported about them.
  if (unswept && unswept.size > 0) {
    const why = "no recent listing of their source confirms them and they could not be re-checked";
    notes.push(`Left out items from ${list(unswept)}: ${why}`);
  }
  if (notes.length === 0) return told;
  const left = notes.join(". ");
  // An answer that would read as an all-clear says it is not one.
  if (told === "Nothing in the connected sources.")
    return `Nothing confirmed in the connected sources. ${left}, so this is not an all-clear.`;
  return `${told}\n${left}.`;
}

/** `honestAnswer` without the unconfirmed items: the packet and the sources that did not answer (D127). */
export function reachAnswer(
  packet: string,
  sources: readonly SourceStatus[] | undefined,
  unresolved: boolean,
  closed: boolean,
): string {
  if (closed) {
    const none = "The session ended before the sources were searched, so this is not an all-clear.";
    return packet ? `${packet}\n${none}` : none;
  }
  if (unresolved) {
    const none = "Could not reach the connected sources (they could not be listed), so this is not an all-clear.";
    return packet ? `${packet}\n${none}` : none;
  }
  // `askBehind` (D430): sources still being read when the ask answered are named apart from those that failed.
  const reading = (sources ?? []).filter((x) => x.status === SEARCHING);
  // `sourceYield` (D505): cut copies the ask did not search are named apart too: nothing failed.
  const skipped = (sources ?? []).filter((x) => x.status === UNSEARCHED);
  const missed = (sources ?? []).filter(
    (x) => !ANSWERED.has(x.status) && x.status !== SEARCHING && x.status !== UNSEARCHED,
  );
  const told = unreached(packet, sources ?? [], missed);
  if (reading.length === 0 && skipped.length === 0) return told;
  const some = (xs: readonly SourceStatus[]) =>
    `${xs
      .slice(0, 3)
      .map((x) => x.sourceId)
      .join(", ")}${xs.length > 3 ? ` and ${xs.length - 3} more` : ""}`;
  const notes: string[] = [];
  if (reading.length > 0)
    notes.push(`Still reading ${some(reading)}: anything there that fits follows as a later packet`);
  if (skipped.length > 0) {
    // True of both rules that skip a read (the source's run, and a source with nothing used yet, D603): neither
    // skips a source the request names. The run rule can skip one the request's common words touch, so the line
    // says "names", not "points there" (review of the D603 merge).
    notes.push(`Not searched past what is held of ${some(skipped)}: nothing in the request names it`);
  }
  if (told === "Nothing in the connected sources.") {
    const head = reading.length > 0 ? "Nothing found yet." : "Nothing found in what was searched.";
    return `${head} ${notes.join(". ")}, so this is not an all-clear${reading.length > 0 ? " yet" : ""}.`;
  }
  return `${told}\n${notes.join(". ")}.`;
}

/** `reachAnswer`'s text for the sources that did not answer (`missed`), as D127 words it. */
export function unreached(packet: string, sources: readonly SourceStatus[], missed: readonly SourceStatus[]): string {
  if (missed.length === 0) return packet || "Nothing in the connected sources.";
  const names = missed.map((x) => `${x.sourceId} (${STATUS_WORDS[x.status] ?? x.status})`).join(", ");
  if (packet) return `${packet}\nCould not reach ${names}: this answer may be missing what they hold.`;
  const answered = sources.filter((x) => ANSWERED.has(x.status)).map((x) => x.sourceId);
  if (answered.length === 0) return `Could not reach ${names}, so this is not an all-clear: nothing was checked.`;
  return `Nothing in ${answered.join(", ")}. Could not reach ${names}, so this is not an all-clear.`;
}

/** A search's span attributes: how many sources answered each way. */
export function outcomeAttrs(outcomes: readonly FanoutOutcome[]): Record<string, number> {
  const out: Record<string, number> = { sources: outcomes.length };
  for (const o of outcomes) out[o.status] = (out[o.status] ?? 0) + 1;
  return out;
}

/** A card's match against a request (`cardVerdict`), with its span's length for ranking. */
export interface CardFind {
  violated: boolean;
  tied: "name" | "word" | null;
  /** Days the card's span covers (Infinity when open or none): a narrower span says more about the day asked. */
  spanDays: number;
}

/** The head of a request matched against the intent index (`intent`): where its action and objects are named. */
export const INTENT_QUERY_CHARS = 400;

/** An item the intent index found for a request (`intent`): its place among the hits, and how its requests matched. */
export interface IntentFind {
  rank: number;
  coverage: number;
  matched: number;
}

/** Card finds a lookup ranks at most (`cards`). */
export const MAX_CARD_FINDS = 6;

/** Violated first, then tied by a name, then by a word, then the narrower span. */
export function cardRank(f: CardFind): number {
  const span = Number.isFinite(f.spanDays) ? Math.max(0, 1 - f.spanDays / 400) : 0;
  return (f.violated ? 8 : 0) + (f.tied === "name" ? 4 : f.tied === "word" ? 2 : 0) + span;
}

export function spanDays(c: { start?: string; end?: string }): number {
  if (!c.start || !c.end) return Infinity;
  return (Date.parse(c.end) - Date.parse(c.start)) / 86_400_000 + 1;
}

export const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** What `searchLive` returns: the calls it made and what the lookup's ranking reads from them. */
export type SearchedLive = Awaited<ReturnType<PartnerVerdict["searchLive"]>>;

/** `ask`'s second argument, for the engine's own asks (`readerPush`); an embedder's ask passes none. */
export interface AskInternal {
  push?: boolean;
  /** The session's request count when the push's request was counted: a later request makes it stale. */
  request?: number;
  /** The session's turn when the push's request was counted: the push's trace reports it (audit A11). */
  turn?: number;
  /** `pushOpen` (D702): the push started on the message's shape (`isOpenRequest`), not on a listed verb. */
  open?: boolean;
  /** `pushDaySeats`: only the request's day started this push (`namesComingDay`). */
  byDay?: boolean;
  /** `readerPushBehind`'s second reading: the first one's search, and the packet it queued. */
  again?: { searched: SearchedLive; prev: Injection | null };
  /**
   * `askBehind` (D430): the follow-up of an explicit ask that answered before its sources were read: the ask's search,
   * the ids its answer cited, and the session's request count when it was asked.
   */
  late?: { searched: SearchedLive; cited: ReadonlySet<string>; request: number };
}

/** `readAsk`'s options: whether it reads for the push, and the push's request. */
export interface ReadOpts {
  push?: boolean;
  /** The push's request (`AskInternal.request`), recorded with its reading for `readerReuse`. */
  request?: number;
}

/** No reading: no verdict, no call, nothing spent. */
export const NO_READ: ReaderRead = { verdict: null, costUsd: 0, called: false, overBudget: false };

export const sameEntry = (a: LedgerEntry | undefined, b: LedgerEntry | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.turn === b.turn && a.version === b.version);

/** An opaque per-user key for provider sticky routing (prompt-cache reuse): a hash, never the ids themselves. */
export const userCacheKey = (scope: Scope) =>
  `eden-${createHash("sha256").update(scopeKey(scope)).digest("hex").slice(0, 24)}`;

/** Whether a request names days and nothing but days and calendar words: a listing of the days answers it (D44). */
export function onlyTime(cue: Cue): boolean {
  return (
    (cue.time?.days.size ?? 0) > 0 && cue.entities.length === 0 && cue.text.split(" ").every((w) => TIME_WORD.test(w))
  );
}

/** The text the intent index is searched with: the request's head, after its gloss when it has one (`requestGloss`). */
export const intentQuery = (cue: Cue) =>
  cue.gloss ? `${cue.gloss}\n${cue.raw.slice(0, INTENT_QUERY_CHARS)}` : cue.raw.slice(0, INTENT_QUERY_CHARS);

/** The cue's time on the user's wall clock, read as UTC: its ISO day is the user's day. */
export const localNow = (cue: Cue) => cue.at + cue.offset * 60_000;

/** A question about what could stop or change an act, and the usual ways to ask whether something is fine to do. */
export const ASKS_BLOCKERS =
  /\b(?:block(?:s|ed|ing|er|ers)?|constrain(?:s|t|ts)?|rules?|limits?|holds?|approvals?|policy|policies|availab(?:le|ility)|allowed|permitted|conflicts?|clash(?:es)?|freezes?|frozen|restrictions?|ok(?:ay)? to|safe to|fine to|go ahead)\b/i;

/** The most candidates an ask's reader reads, whatever `askReaderPool` says. */
export const READER_POOL_CAP = READER_MAX_ITEMS;

/** `pushCandidates` (D236): the push's pool and, per item, whether it is constraint-like. */
export interface PushGate {
  pool: Scored[];
  like: boolean[];
  /** The pool's cards, as `pushPool` read them — `candidatesOf`'s constraint test needs them for ruled items too. */
  cards: ReadonlyMap<string, Card>;
  /** `pushDaySeats`: the pool's items seated for the request's day; handed only when the check names them. */
  seats?: Set<string>;
  /** `pushDaySeats`: the pool before the seats, and whether a push with no check answer hands its candidates. */
  before?: Scored[];
  unchecked?: boolean;
}

/** `pushDaySeats`: the fewest words of a turn that starts the push by its day, and how far ahead that day may be. */
export const DAY_START_WORDS = 4;

export const DAY_START_AHEAD = 62;

/** `pushDaySeats`: the longest window of days (the request's) whose items are seated. */
export const DAY_SEAT_DAYS = 3;

/** Below this much of an ask's wait left (or a quarter of it, if less), the ask starts no reader call of its own. */
export const MIN_OWN_READ_MS = 250;

/** A strict (ask) verification's outcomes worth one more read, and how many such reads run at once (D211). */
export const RETRIED: ReadonlySet<CheckOutcome> = new Set<CheckOutcome>(["flaked", "skipped"]);

export const STRICT_RETRY_LANES = 2;

export const CHECK_REUSE_MS = 30_000;

/** A lookup with less of its deadline left than this sends no live search (D140): no call could answer in time. */
export const MIN_SEARCH_MS = 50;

/** The user's day as YYYY-MM-DD, at their offset from UTC (minutes). */
export function localDay(at: number, offsetMin: number): string {
  return new Date(at + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** The entities an item's mentions record keeps, its first of `PERSISTABLE_KINDS`. */

/** `routeSketch`: a request's terms matched against the sources' sketches, at most (its first). */
export const MAX_SKETCH_TERMS = 16;

/** Two routing boosts summed per source; either may be absent. */
export function addBoosts(
  a: Map<string, number> | undefined,
  b: Map<string, number> | undefined,
): Map<string, number> | undefined {
  if (!a || !b) return a ?? b;
  const out = new Map(a);
  for (const [id, x] of b) out.set(id, (out.get(id) ?? 0) + x);
  return out;
}

/** `routeLocalHits`: the user's best local matches for a request that routing counts per source (D265). */
export const LOCAL_ROUTE_HITS = 40;

/**
 * A user's sources by id, the first of any repeated id (as `Array.find` gave): a lookup maps routed ids back to sources
 * through it, which was a scan of every source per routed one (quadratic for a user with 1,000 connectors, D261).
 */
export function sourcesById(all: readonly Source[]): Map<string, Source> {
  const byId = new Map<string, Source>();
  for (const x of all) if (!byId.has(x.id)) byId.set(x.id, x);
  return byId;
}

export abstract class PartnerVerdict extends PartnerCheck {
  /** Work a lookup left running behind its answer (`syncPollBehind`), for harnesses to wait on. */
  protected addBehind(s: Session, work: Promise<void>): void {
    const all = s.behind ? Promise.all([s.behind, work]).then(() => {}) : work;
    const tracked: Promise<void> = all.finally(() => {
      if (s.behind === tracked) s.behind = null;
    });
    s.behind = tracked;
  }

  /**
   * The user's first sighting by a serving route (`observe` does the same for a first event): their sources are
   * tracked and — with `syncKick` — the backfill starts now, not at the first request or a `session_start` the
   * integrator may never send (D2005, o4-new-user). Routes that only thaw (`ready`: a forget broadcasts it to
   * every worker, so a worker that never served the user must not start their backfill) are not sightings.
   * O(1), no I/O; `track` is idempotent, so later calls cost nothing.
   */
  seen(scope: Scope): void {
    // A sighting before the user's thaw tracks after it settles: `ready` resolves once the owner's restore ran,
    // so `track` meets the sync state the blob restored — never a fresh empty one whose existing record the
    // restore would then skip (and a restored user, already warm, is not kicked again). The deferred call goes
    // to `seenNow`, not `seen`: re-entering `ready` would fetch the shared store a second time on a miss or an
    // outage. A whole-user `forget` that lands while the thaw waits is not undone by this sighting.
    const thawing = this.deps.cache.ready(scope);
    if (thawing !== null) {
      const key = scopeKey(scope);
      void thawing.then(
        () => {
          if (!this.forgotten.has(key)) this.seenNow(scope);
        },
        () => {},
      );
      return;
    }
    this.seenNow(scope);
  }

  /**
   * `pushCandidates` (D236): the push's pool and its constraint-like gate. The pool `readAsk` would read (the first
   * `askReaderPool` distinct items of `ranked`) in its own order; per item, `readerGate`'s constraint test, cards
   * included. A pool with no constraint-like item gives no candidates, as `readerGate` would read none. `byDay`: the
   * push was started by the request's day alone (`pushDaySeats`).
   */
  protected pushGate(s: Session, cue: Cue, ranked: readonly Scored[], byDay = false): PushGate {
    const at = cue.arrived ?? this.now();
    const { pool, cards } = this.pushPool(s, ranked, at);
    // `pushDaySeats` (G1, D1400, D1402): items on a day the request names, whatever their words, seated after the
    // first `pushCandidates` so the check reads them. They are handed only when the check names them
    // (`candidatesOf`): a push with no check hands the pool's other items, as before. Seats go to the best of the
    // day's items outside the first `pushCandidates`, those the pool's tail already holds included: they move up
    // rather than being pushed past the cap by the others.
    const head = Math.min(pool.length, Math.max(0, this.config.pushCandidates));
    const seated = this.daySeats(s, cue, new Set(pool.slice(0, head).map((x) => x.item.id)));
    if (seated.length === 0 && !byDay) return { pool, like: pool.map((x) => this.constraintLike(x, cards)), cards };
    // The pool as it stood, and its own gate: what a push with no check answer hands (`candidatesOf`), so a seat never
    // opens a hand-out no model judged. A push only the day started has no such hand-out at all.
    const before = pool.slice();
    const unchecked = !byDay && before.some((x) => this.constraintLike(x, cards));
    const seats = new Set(seated.map((x) => x.item.id));
    if (seated.length > 0) {
      const cap = Math.max(0, Math.min(this.config.askReaderPool, READER_POOL_CAP));
      const rest = pool.slice(head).filter((x) => !seats.has(x.item.id));
      pool.splice(head, pool.length - head, ...seated, ...rest);
      pool.length = Math.min(pool.length, cap);
      // The cards of the items seated from outside the pool (one lookup an item, as the pool's own).
      const fresh = seated.filter((x) => !cards.has(x.item.id)).map((x) => x.item.id);
      const enricher = this.config.cards ? this.deps.cards : undefined;
      if (enricher && fresh.length > 0) for (const [id, c] of enricher.cardsOf(s.scope, fresh, at)) cards.set(id, c);
    }
    const all = pool.map((x) => this.constraintLike(x, cards));
    // A push only the day started (`namesComingDay`) is checked only when one of its seats is itself
    // constraint-like: the day's own evidence, not a pool the request's words happened to fill (D1401).
    const quiet = byDay && !pool.some((x, i) => seats.has(x.item.id) && all[i] === true);
    const like = quiet ? all.map(() => false) : all;
    return { pool, like, seats, before, unchecked, cards };
  }

  /**
   * `pushDaySeats` (G1, D1400): whether a turn of at least `DAY_START_WORDS` words names a day from today on, within
   * `DAY_START_AHEAD` days, in a window the seats take (`DAY_SEAT_DAYS`): read as the push's lookup reads it
   * (`datedText`, the glossary's English beside the turn). Bounded input; nothing is stored, so the turn is read as
   * written. The word count comes first: most turns end there.
   */
  protected namesComingDay(said: string, at: number, offset: number): boolean {
    const text = head(said, MAX_QUESTION_CHARS);
    let words = 0;
    for (const m of text.matchAll(/\S+/g)) if (m && ++words >= DAY_START_WORDS) break;
    if (words < DAY_START_WORDS) return false;
    const gloss = this.config.requestGloss ? glossOf(text) : "";
    const read = gloss ? `${text}\n${gloss}` : text;
    const days = timeWindow(datedText(read, at, offset), at, offset)?.days;
    // Only a window whose items can be seated: a longer one, or a period with no day, would start a push that by
    // construction hands nothing.
    if (!days || days.size === 0 || days.size > DAY_SEAT_DAYS) return false;
    const today = new Date(at + offset * 60_000).toISOString().slice(0, 10);
    const last = new Date(at + offset * 60_000 + DAY_START_AHEAD * 86_400_000).toISOString().slice(0, 10);
    for (const d of days) if (d >= today && d <= last) return true;
    return false;
  }

  /**
   * `pushDaySeats` (G1, D1400): the items on a day the request names that the pool does not hold yet, bulk mail out,
   * at most `pushDaySeats`. None for a request that names no day or a window of more than three (a week's listing
   * is not a seat), or with the switch off.
   */
  private daySeats(s: Session, cue: Cue, have: ReadonlySet<string>, all?: Map<number, number>, weak = false): Scored[] {
    const k = this.config.pushDaySeats;
    const days = cue.time?.days;
    if (k <= 0 || !days || days.size === 0 || days.size > DAY_SEAT_DAYS) return [];
    return this.deps.cache
      .dated(s.scope, days, (item) => have.has(item.id) || bulkMail(item), this.now(), k, cue.offset, all, weak)
      .map((h) => ({ item: h.item, matched: 0, score: 0, sketch: h.sketch, doc: h.doc, dayCls: h.dayCls }));
  }

  /**
   * The lookup's day seats (D1978): the push's `daySeats` applied to the scored pool of a request that names a
   * day, so an availability ask on it ("is Thursday free?", "do I have a clash then?") finds the day's items
   * however they write it — `meta.start`, a span, a written date or weekday, a recurrence. `dayCls` marks every
   * scored item that sits on a named day, for `eligible`'s `onNamedDay` and `grounded`'s day filters.
   */
  private seatDays(s: Session, cue: Cue, scored: Scored[]): void {
    const days = cue.time?.days;
    if (!days || days.size === 0) return;
    const all = new Map<number, number>();
    const seats = this.daySeats(s, cue, new Set(scored.map((x) => x.item.id)), all, true);
    const want = dayKeys(days);
    const clsOf = (item: ContextItem): number | undefined => {
      const f = dayFactsOf(item.title, item.text);
      if (f === 0) return item.meta?.start !== undefined && days.has(item.meta.start.slice(0, 10)) ? 0 : undefined;
      const c = dayFactsClass(f, days, want, item.updatedAt ?? this.now());
      return c > 0 ? c : undefined;
    };
    for (const x of scored) {
      const c = x.doc !== undefined ? all.get(x.doc) : undefined;
      const cls = c ?? clsOf(x.item);
      if (cls !== undefined) x.dayCls = cls;
    }
    for (const seat of seats) scored.push(seat);
  }

  /**
   * `pushCheck` (D500): the push check's answer for this pool, or null (off, unwired, no constraint-like item or no
   * request text). Waits at most `pushCheckWaitMs`; a check
   * that answers later is kept on the session, so a second pass over the same pool (`readerPushBehind`) reads it
   * with no call. The call runs on the session's signal: it ends with the session, not with the wait.
   */
  protected async checkPush(s: Session, cue: Cue, gate: PushGate, forRequest?: number): Promise<PushCheckRead | null> {
    const checker = this.deps.checker;
    if (!this.config.pushCheck || !checker) return null;
    const like = gate.like.some(Boolean);
    if (!like) return null;
    const request = sanitizeForStore(cue.raw);
    if (!request.trim()) return null;
    const today = localDay(this.now(), this.deps.cache.offsetOf(s.scope));
    const sheet = this.sheetOf(s, cue, today);
    const focus = readerFocus(cue.raw);
    const read = gate.pool.slice(0, Math.min(this.config.pushCheckItems, CHECK_MAX_ITEMS));
    const input = {
      request,
      items: read.map((x) => readerItem(x.item, focus, undefined, this.config.pushCheckItemChars)),
      today,
      ...(sheet.length > 0 ? { sheet, ...(this.config.pushCheckSheetRefs ? { sheetRefs: true } : {}) } : {}),
      cacheKey: userCacheKey(s.scope),
    };
    const key = checkKey(input);
    const ids = sheet.map((c) => c.id);
    const withSheet = (r: PushCheckRead): PushCheckRead => (ids.length > 0 ? { ...r, sheet: ids } : r);
    // A kept answer read this sheet too: a card landing or expiring between passes asks again.
    const asked =
      sheet.length > 0
        ? `${input.today}\n${request}\n${createHash("sha256").update(sheetText(sheet)).digest("hex").slice(0, 16)}`
        : `${input.today}\n${request}`;
    const checks: Map<string, KeptCheck> = (s.pushChecks ??= new Map());
    // A settled check of this request that read every item of this pool, unchanged, answers it with no call: a second
    // pass (`readerPushBehind`) often only reorders the pool or drops an item.
    const items = input.items.slice(0, CHECK_MAX_ITEMS);
    for (const kept of checks.values()) {
      const yes = kept.settled?.yes;
      if (!yes || kept.asked !== asked || !items.every((it) => kept.marks.get(it.id) === itemMark(it))) continue;
      // An answer that named its most (5) may have left out items a fresh read of a smaller pool would name.
      if (yes.size >= 5 && items.length < kept.marks.size) continue;
      return withSheet({
        yes: new Set(items.filter((it) => yes.has(it.id)).map((it) => it.id)),
        ...(kept.settled?.rules ? { rules: kept.settled.rules } : {}),
        marks: kept.marks,
        costUsd: 0,
        called: false,
        overBudget: false,
      });
    }
    let kept = checks.get(key);
    const fresh = !kept;
    if (!kept) {
      const entry: KeptCheck = {
        asked,
        ...(forRequest !== undefined ? { request: forRequest } : {}),
        marks: new Map(items.map((it) => [it.id, itemMark(it)])),
        read: checker.check(s.scope, s.key, input, s.abort.signal),
      };
      void entry.read.then((r) => (entry.settled = r));
      kept = entry;
      checks.set(key, entry);
      while (checks.size > CHECK_KEPT) checks.delete(checks.keys().next().value as string);
    }
    const running = kept.read;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), this.config.pushCheckWaitMs);
    });
    try {
      const got = await Promise.race([running, late]);
      // A check this pass did not start (a second pass reading the first's) cost this pass nothing.
      if (got)
        return withSheet(
          fresh ? { ...got, marks: kept.marks } : { ...got, costUsd: 0, called: false, marks: kept.marks },
        );
      // Past the wait: the call goes on behind; the pass that started it traces it when it settles ("check-late"),
      // even after the session closed (the call was paid for), so traces sum to the calls made.
      if (fresh) {
        const t0 = performance.now();
        const requestAt = forRequest ?? s.requests;
        void running.then(
          (r) => {
            if (r.called) this.traceCheck(s, r, t0);
            void this.deliverLateCheck(s, cue, gate, r, requestAt);
          },
          () => undefined,
        );
      }
      return withSheet({ yes: null, costUsd: 0, called: false, overBudget: false, late: true });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `pushCheckSheet` (F5): the user's rule sheet, at most `pushCheckSheet` of their constraint cards made before the
   * request (no `none` or `preference` card, none whose span ended before `today`), one a statement (the newest
   * item's), newest items first; only items still cached, no bulk mail. No model call and no source call: the card
   * store and the cache, both the user's own.
   */
  private sheetOf(s: Session, cue: Cue, today: string): SheetCard[] {
    const n = Math.min(this.config.pushCheckSheet, SHEET_MAX_CARDS);
    const cards = this.deps.cards;
    if (n <= 0 || !this.config.cards || !cards) return [];
    const ids = cards.carded(s.scope);
    if (ids.length === 0) return [];
    const now = this.now();
    const rows: { id: string; card: Card; item: ContextItem; at: number }[] = [];
    for (const [id, card] of cards.cardsOf(s.scope, ids, cue.arrived ?? now)) {
      if (card.kind === "none" || card.kind === "preference") continue;
      if (card.end !== undefined && card.end < today) continue;
      const item = this.deps.cache.get(s.scope, id, now);
      if (!item || bulkMail(item)) continue;
      rows.push({ id, card, item, at: item.updatedAt ?? 0 });
    }
    rows.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const out: SheetCard[] = [];
    const said = new Set<string>();
    for (const { id, card, item } of rows) {
      const statement = sanitizeForStore(card.statement);
      const key = statement.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || said.has(key)) continue;
      said.add(key);
      // A heavy user's rules do not fit: the newest `n` of them speak on neutral requests more than main does
      // (F5 §11d, D1183), so the check reads the pool alone, as without a sheet.
      if (out.length >= n) return [];
      out.push({
        id,
        kind: card.kind,
        statement,
        title: sanitizeForStore(item.title),
        source: sanitizeForStore(item.sourceId),
        ...(card.start ? { start: card.start } : {}),
        ...(card.end ? { end: card.end } : {}),
      });
    }
    return out;
  }

  /**
   * `pushCheckLate` (D2082): a check that answered past `pushCheckWaitMs` still serves the request it read — while
   * that request stays the session's latest, the items it named that no delivery carried go out on the session's
   * `pending` queue, so the agent takes them at its next event instead of a paid-for answer serving nothing
   * (lh10: 98% of check calls settled late). An item already delivered is left out (`isFresh`), copies are
   * re-verified on the wire (`deliverChecked`), and a session that closed or moved to a newer request gets nothing.
   */
  private async deliverLateCheck(
    s: Session,
    cue: Cue,
    gate: PushGate,
    r: PushCheckRead,
    requestAt: number,
  ): Promise<void> {
    try {
      if (!r.yes?.size || s.closed || s.requests !== requestAt) return;
      // The check's answer goes through the same filters the in-time push applies (`candidatesOf`: look-alikes,
      // stale siblings, bulk mail, the candidates cap) — a named item the rules would have kept out stays out —
      // and an item already delivered is left out (`isFresh`).
      const undelivered = this.candidatesOf(s, cue, gate, r).items.filter((x) => s.ledger.isFresh(x.item.id, s.turn));
      if (undelivered.length === 0) return;
      // `deliverChecked`'s re-reads take a moment: what the ledger held before them, so a discarded packet's
      // marks can be undone the way `withdraw` undoes a replaced one's.
      const was = new Map(undelivered.map((x) => [x.item.id, s.ledger.entry(x.item.id)] as const));
      // The candidates' own frame: `build` marks every item it cites, so a packet cut by the ordinary byte cap
      // would suppress items its text never carried.
      const each = Math.min(this.config.compactItemBytes, MAX_CANDIDATE_BYTES);
      const k = Math.min(this.config.pushCandidates, this.config.askReaderPool, READER_POOL_CAP);
      const injection = await this.deliverChecked(s, undelivered, "proactive", `candidates:${cue.id}`, cue, was, {
        lead: CANDIDATES_LEAD,
        itemBytes: each,
        maxBytes: Math.max(this.config.maxInjectionBytes, 400 + k * (each + 120)),
      });
      if (injection === null) return;
      if (s.closed || s.requests !== requestAt) {
        // A session that closed or moved to a newer request during the re-reads gets no packet — and keeps the
        // marks undone too: the agent never saw the items, so they stay deliverable to what it asks next.
        const undo: Undo = new Map();
        for (const x of undelivered) {
          const set = s.ledger.entry(x.item.id);
          const before = was.get(x.item.id);
          if (!set || sameEntry(set, before)) continue;
          undo.set(x.item.id, { was: before, set, sketch: x.sketch });
        }
        if (undo.size > 0) {
          this.undoable.set(injection, undo);
          this.withdraw(s, injection);
        }
        return;
      }
      s.pending.push(injection);
    } catch {
      // Best-effort: a late check's delivery must never break the session it serves.
    }
  }

  /** `pushCheck` (D500): a check's call that no push trace carries (late, or its session closed), traced alone. */
  protected traceCheck(s: Session, r: PushCheckRead, t0: number): void {
    this.trace(s, {
      sessionId: s.id,
      turn: s.turn,
      event: "user_message",
      decision: "check-late",
      reason: "push check",
      latencyMs: Math.round(performance.now() - t0),
      sourceCalls: 0,
      modelCalls: 1,
      costUsd: r.costUsd,
      checkCalls: 1,
      checkCostUsd: r.costUsd,
      itemIds: [],
    });
  }

  /**
   * `pushCandidates` (D236): the push's candidates for the agent to judge, with no model call: the gate's pool, bulk
   * mail out, the first `pushCandidates` of them; none when no pooled item is constraint-like. (Constraint-like items
   * first lost 27 points of hidden facts live: D236.) With a `pushCheck` answer (D500), the pool's items it named
   * instead, in the pool's order, and none when it named none.
   */
  protected candidatesOf(
    s: Session,
    cue: Cue,
    gate: PushGate,
    check: PushCheckRead | null = null,
  ): { items: Scored[]; pool: Scored[]; unsettled?: Anchors; lookup?: "named" | "head" } {
    const { like } = gate;
    // A check that names nothing sends no packet (D500, silent, D828): that is how the push stays silent on a request
    // with nothing to add.
    const yes = check?.yes ?? null;
    const pool = gate.pool;
    const reported = pool;
    // `pushCheckSheet` (F5): the items of the sheet's rules the check named, after the pool's (current copies only).
    const ruled = yes && check?.rules?.size ? this.ruledItems(s, check.rules, pool) : [];
    if (reported.length === 0 && ruled.length === 0) return { items: [], pool };
    // `pushDaySeats`: a seat is the check's to name. With no answer (no checker, a late or failed check) the push
    // hands what it would have handed with no seats: the pool as it stood, behind that pool's own gate.
    // A look-alike that contradicts the request's anchors (another identifier's, last year's, another
    // organisation's) leaves the pool the push can hand (D1970).
    const open = (yes === null && gate.before ? gate.before : reported).filter(
      (x) => !bulkMail(x.item) && !this.contradicts(x, cue),
    );
    // Last year's look-alike beside this year's record about the named thing: when the pool's entity-anchored
    // items carry a newer record, one dated only earlier is the stale sibling — the same rule `linked` keeps
    // between a companion and its pick, applied between the pool's own items (the request need not name a year:
    // `requestYear` has nothing to be stale against, so `contradicts` never saw it). `staleSibling` covers the
    // document that itself reads stale too: declared superseded or expired, its deadline past.
    // The rule applies per request entity, not across the whole request: a request naming two subjects never
    // lets one's newer record date the other's, and when the check ruled on the pool only items it approved
    // date anything — a newer record it rejected must not suppress the older one it handed.
    const approved =
      yes === null ? () => true : (x: Scored) => yes.has(x.item.id) || ruled.some((r) => r.item.id === x.item.id);
    const staleOf = this.staleSibling(s, cue, cue.entities, open, (x) => x.entity === true && approved(x));
    const staleSibling = (x: Scored) => this.staleSelf(x.item, cue) || (x.entity === true && staleOf(x.item));
    const current = open.filter((x) => !staleSibling(x));
    const gated = gate.unchecked ?? like.some(Boolean);
    let items = yes
      ? [...current.filter((x) => yes.has(x.item.id)), ...ruled].slice(0, this.config.pushCandidates)
      : gated
        ? current
            // A gated push still hands only what is actually tied: one shared word ("Thursday") is filler that
            // ranked high on a common term, never an answer (D1970).
            .filter((x) => x.matched >= 2 || x.entity === true)
            .slice(0, this.config.pushCandidates)
        : [];
    // `pushLookup` (D1252): the check answered and named nothing (a non-null empty answer: this pass's call, a reused
    // or a late one read by `readerPushBehind`'s second pass; a failed, late-unread or unwired check is null), so the
    // push would be silent; the pool's records that name the request's anchors go out for reference instead, or with
    // `pushLookupAny` the pool's head when none does (`lookupHead`: its lead must not claim they name the request).
    let lookup = false;
    let lookupHead = false;
    // Only on the session's first request: later ones carry the session's own context, and there the records saved
    // the agent almost no search but stayed in its transcript (D1252's days run: agent $ +0.015/1k, −0.08 calls).
    if (yes && yes.size === 0 && this.config.pushLookup > 0 && s.requests <= 1) {
      const a = this.requestAnchors(s.scope, cue.entities, cue);
      // Only plain records: a constraint-like item here is one the check read and judged not to change the request
      // (a look-alike), and handed as reference the agent raised it anyway (round 5: the ISA look-alike on 4 of 4
      // control seeds). What the agent looks up on a silent turn is the meeting, the contact, the thread.
      const flagged = new Set(reported.filter((x, i) => like[i]).map((x) => x.item.id));
      const plain = current.filter((x) => !flagged.has(x.item.id));
      const named = plain.filter((x) => anchored(x.item, a));
      lookupHead = named.length === 0 && this.config.pushLookupAny;
      items = (lookupHead ? plain : named).slice(0, this.config.pushLookup);
      lookup = items.length > 0;
    }
    // `askNudge` (D316): the handed items hold none that names every kind of anchor the request has.
    let unsettled: Anchors | undefined;
    let anchors: Anchors | undefined;
    const fewer = this.config.pushCandidatesSettled;
    if ((this.config.askNudge || fewer > 0) && items.length > 0 && !lookup) {
      anchors = this.requestAnchors(s.scope, cue.entities, cue);
      const handed = items.map((x) => x.item);
      if (!settles(handed, anchors)) {
        if (this.config.askNudge && (!this.config.askNudgeDeep || this.anchoredPast(pool, items, anchors)))
          unsettled = anchors;
      } else if (fewer > 0) {
        // `pushCandidatesSettled` (D400, D404): a request its anchors settle gets fewer candidates, never losing the
        // first one that settles it.
        items = items.slice(0, settledCut(handed, anchors, fewer));
      }
    }
    // The arguments are built only when the lab's hook is wired (an optional call evaluates none otherwise).
    const read = anchors;
    this.deps.onPushPool?.({
      sessionId: s.id,
      pool: reported.map((x) => x.item.id),
      constraintLike: reported.length > like.length ? [...like, ...reported.slice(like.length).map(() => false)] : like,
      handed: items.map((x) => x.item.id),
      ...(this.config.askNudge ? { unsettled: unsettled !== undefined } : {}),
      ...(read
        ? {
            anchored: reported.map((x) => anchored(x.item, read)),
            anchorKinds: { entities: read.entities.length, day: hasDay(read) },
          }
        : {}),
      ...(this.config.pushCheck && this.deps.checker
        ? {
            // What the check said: an answer naming nothing is still "yes".
            check: yes ? "yes" : !check ? "none" : check.late ? "late" : "failed",
            ...(yes ? { checked: reported.map((x) => yes.has(x.item.id)) } : {}),
            ...(check?.called ? { checkCalled: true } : {}),
            ...(check?.sheet ? { sheet: [...check.sheet] } : {}),
          }
        : {}),
      // `pushLookup` (D1252): `handed` is reference records, not checked candidates.
      ...(lookup ? { lookup: lookupHead ? "head" : "named" } : {}),
    });
    return {
      items,
      pool,
      ...(unsettled ? { unsettled } : {}),
      ...(lookup ? { lookup: lookupHead ? "head" : "named" } : {}),
    };
  }

  /** `pushCheckSheet` (F5): the cached items a check's named rules stand for, not already in the pool, no bulk mail. */
  private ruledItems(s: Session, ids: ReadonlySet<string>, pool: readonly Scored[]): Scored[] {
    const inPool = new Set(pool.map((x) => x.item.id));
    const now = this.now();
    const out: Scored[] = [];
    for (const id of ids) {
      if (inPool.has(id)) continue;
      const item = this.deps.cache.get(s.scope, id, now);
      if (item && !bulkMail(item)) out.push({ item, score: 0, matched: 0, sketch: null });
    }
    return out;
  }

  /**
   * `askNudgeDeep` (D460, D461): whether the pool past the handed candidates holds an item the ask's deeper look would
   * list (not bulk mail, holding one of the request's anchors), judged on the pool's copies as ranked.
   */
  private anchoredPast(pool: readonly Scored[], handed: readonly Scored[], anchors: Anchors): boolean {
    const ids = new Set(handed.map((x) => x.item.id));
    return pool.some((x) => !ids.has(x.item.id) && !bulkMail(x.item) && anchored(x.item, anchors));
  }

  /**
   * A request's anchors (D2009): its entities expanded through the user's alias table (`aliasExpand`), so a person
   * asked for by full name anchors to items naming them by surname and vice versa.
   */
  private requestAnchors(scope: Scope, entities: readonly string[], cue: Cue): Anchors {
    return anchorsOf(
      aliasExpand(this.deps.cache.aliasTable(scope), entities),
      cue.time?.days ?? null,
      cue.raw,
      cue.offset,
    );
  }

  /** `planConflict` (D301): the request the push ran for, kept so items stored later are checked against it. */
  protected noteActed(s: Session, cue: Cue): void {
    if (s.closed) return;
    const acted = (s.acted ??= []);
    acted.push(cue);
    if (acted.length > PLAN_REQUESTS) acted.shift();
    const key = scopeKey(s.scope);
    let set = this.acting.get(key);
    if (!set) this.acting.set(key, (set = new Set()));
    set.add(s);
  }

  /**
   * `readerReuse` (D193): the push's verdict for an ask made in the same request (no newer user message), cut
   * to the ask's pool: its bearings and rejections on items the push read with the same content. `all` says whether
   * the push read every candidate of this pool. "late" when the push's reading is not in within `waitMs`; null when
   * there is nothing to reuse (no push in this request, or it gave no verdict), and the ask reads as usual.
   */
  protected async reusePush(
    s: Session,
    pool: readonly Scored[],
    main: string,
    waitMs: number,
  ): Promise<{ verdict: ReaderVerdict; all: boolean } | "late" | null> {
    if (!this.config.readerReuse || !this.config.readerPush) return null;
    const prior = s.pushRead;
    // Only an ask read against the push's own request: one that acts on its own is another request.
    if (!prior || prior.request !== s.requests || prior.main !== main) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const v = await Promise.race([
      prior.verdict,
      new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), Math.max(0, waitMs)))),
    ]).finally(() => clearTimeout(timer));
    if (v === "late") return "late";
    if (!v) return null;
    // An item the push flagged whose copy changed since it read it (the push's own re-read, D192, or another): its
    // bearing was of the old copy, so the ask reads the current one with a call of its own.
    const now = new Map(pool.map((x) => [x.item.id, cardKey(x.item)]));
    if (v.bears.some((b) => now.has(b.id) && now.get(b.id) !== prior.hashes.get(b.id))) return null;
    const same = new Set(pool.filter((x) => prior.hashes.get(x.item.id) === cardKey(x.item)).map((x) => x.item.id));
    return {
      verdict: {
        bears: v.bears.filter((b) => same.has(b.id)),
        rejected: (v.rejected ?? []).filter((id) => same.has(id)),
        checked: same.size,
      },
      all: same.size === pool.length,
    };
  }

  /**
   * `intent` (D87): an ask's pool with its intent hits fused in. The pool (its rule paths' order) and the intent hits
   * (their requests' order) are fused by weighted reciprocal rank, 1/(k+rank) for the pool and `intentWeight`/(k+rank)
   * for the intent list, ties in the pool's order. An item in both lists is kept once and scores both.
   */
  protected fuseIntent(pool: Scored[], scored: readonly Scored[], intents: ReadonlyMap<string, IntentFind>): Scored[] {
    const k = ASK_FUSE_K;
    const w = this.config.intentWeight;
    const fused = new Map<Scored, { score: number; first: number }>();
    pool.forEach((x, i) => fused.set(x, { score: 1 / (k + i), first: i }));
    for (const x of scored) {
      const f = intents.get(x.item.id);
      if (!f) continue;
      const add = w / (k + f.rank);
      const e = fused.get(x);
      if (e) e.score += add;
      else fused.set(x, { score: add, first: pool.length + f.rank });
    }
    const order = [...fused].sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first).map(([x]) => x);
    return order;
  }

  /**
   * Drops everything held for a user, or for one of their sources (a revoked connector): cached items, source-map
   * rows, and the user's live sessions (their windows and queued injections hold content). In-flight lookups are
   * aborted, and their results discarded.
   */
  /** Users a whole-user `forget` dropped, so a sighting deferred behind their thaw does not track them again. */
  protected override readonly forgotten = new Set<string>();

  /**
   * The newest record (`docSpan`) an item already handed in this session carries, among those sharing a
   * request entity (whole content words of one in the delivery's kept terms): the reference a stale
   * same-entity sibling is judged against once the newer record has itself left the pool (delivered is
   * not fresh, so it stops ranking) — without it last year's notice goes out a turn after this year's did.
   */
  private deliveredEntitySpans(s: Session, cue: Cue): Map<string, [number, number]> {
    const entities = cleanEntities(cue.entities)
      .map((e) => (e.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !isStopword(w)))
      .filter((words) => words.length > 0);
    const out = new Map<string, [number, number]>();
    for (const d of s.delivered ?? []) {
      for (const words of entities) {
        if (!words.every((w) => d.terms.includes(w))) continue;
        const key = words.join(" ");
        const span = d.span ?? null;
        if (span === null) {
          // Deliveries recorded before spans were kept still date their entity by `years`.
          let n = 0;
          for (const y of d.years) if (y > n) n = y;
          if (n > 0 && (out.get(key)?.[0] ?? 0) < Date.UTC(n, 0, 1))
            out.set(key, [Date.UTC(n, 0, 1), Date.UTC(n + 1, 0, 1)]);
          continue;
        }
        const have = out.get(key);
        if (have === undefined || span[0] > have[0]) out.set(key, span);
      }
    }
    return out;
  }

  /**
   * Whether the item itself reads stale: it declares its own death ("[OLD]", "(superseded)", "no longer
   * valid") or the deadline it names is already past. When the request asks for an old or previous state
   * the stale copy is the answer (`ASKS_OLD`), so nothing counts as stale.
   */
  protected staleSelf(item: ContextItem, cue: Cue): boolean {
    // A request that names its own year asks for that year's record: whatever state it is in now is the
    // answer. The year is the raw text's alone — "today" resolving to a day of this year is no exemption.
    if (ASKS_OLD.test(cue.raw)) return false;
    const r = staleOf(item, item.updatedAt ?? cue.at);
    // A dated ask looks up the period's records, so a deadline since passed is no staleness; a record that
    // declares itself dead is dead whatever day the ask names, though (D2060) — "Cancelled: Hotel Alfama"
    // is no more the booking "move my Lisbon flight on 12 November" wants than it is an undated ask's.
    if (cue.raw.match(YEARS) !== null || MONTH_NAME.test(cue.raw)) return r.declared;
    return r.declared || (r.expiry !== null && r.expiry <= cue.at);
  }

  /**
   * The stale-sibling predicate for a request's entities (D1982, generalized to `docSpan`): an item dated
   * earlier than the newest record the pool (or a delivered item, `deliveredEntitySpans`) carries for
   * every entity it anchors to — last year's notice beside this year's, the January statement beside
   * March's — and an item that declares itself dead or whose named deadline has passed. A request naming
   * its own year asks for that year's record, so the sibling rule is for the yearless case only; a timed
   * item (`meta.start`) is a dated occurrence, not a record, and never the stale sibling.
   * `peers` are the items a newer record may be found among (the same pool `stale` runs on), `approve` the
   * pass's own gate on which of them may date anything (a newer record a check rejected must not suppress
   * the older one it handed).
   */
  protected staleSibling(
    s: Session,
    cue: Cue,
    entities: readonly string[],
    peers: readonly Scored[],
    approve: (x: Scored) => boolean = () => true,
  ): (item: ContextItem) => boolean {
    const phrases = entities.map((e) => (e.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !isStopword(w)));
    const anchorsPer = entities.map((e) => this.requestAnchors(s.scope, [e], cue));
    const anchoredOf = (item: ContextItem) =>
      entities
        .map((e, i) =>
          phrases[i]!.length > 0 && (titleNames([e], item) === "whole" || namesEntity(item, anchorsPer[i]!)) ? i : -1,
        )
        .filter((i) => i >= 0);
    const yearless = cue.raw.match(YEARS) === null && !MONTH_NAME.test(cue.raw);
    const deliveredSpans = yearless ? this.deliveredEntitySpans(s, cue) : new Map<string, [number, number]>();
    // Per entity, the newest start among the pool's approved, anchored, not-self-stale records: a newer
    // record itself declared dead cannot make anything its sibling.
    const newestE = entities.map((e, i) => {
      if (!yearless) return -Infinity;
      let n = -Infinity;
      const d = cleanEntities([e])[0] !== undefined ? deliveredSpans.get(phrases[i]!.join(" ")) : undefined;
      if (d !== undefined) n = d[0];
      for (const x of peers)
        if (approve(x) && !this.staleSelf(x.item, cue) && anchoredOf(x.item).includes(i)) {
          const span = docSpan(x.item, x.item.updatedAt ?? cue.at);
          if (span !== null && span[0] > n) n = span[0];
        }
      return n;
    });
    return (item: ContextItem) => {
      if (item.meta?.start !== undefined) return false;
      if (!yearless || ASKS_OLD.test(cue.raw)) return false;
      const span = docSpan(item, item.updatedAt ?? cue.at);
      if (span === null) return false;
      const an = anchoredOf(item);
      return an.length > 0 && an.every((i) => span[1] <= newestE[i]!);
    };
  }

  /**
   * Whether the candidate contradicts the request rather than answering it, on the anchors that pin a request down
   * (D1970): its identifier numbers disagree with the one the request names (invoice 4390 against "invoice 4471"),
   * it is dated only in years before the request's own (last year's booking or renewal, a hold since lifted), or it
   * ties a name the request uses to a name it did not ("Jordan Pike (Contoso)" for "Jordan Pike from Northwind").
   * Checked wherever a no-model path hands an item, so a look-alike fails at the gate the agent never sees.
   */
  protected contradicts(x: Scored, cue: Cue): boolean {
    const want = idNumbers(cue.raw);
    if (want.size > 0) {
      const have = itemRefs(x.item);
      if (have.size > 0 && ![...want].some((n) => have.has(n))) return true;
    }
    const ref = requestYear(cue);
    if (ref !== null) {
      const years = itemYears(x.item);
      if (years.size > 0 && Math.max(...years) < ref) return true;
    }
    const names = cueNames(cue).names;
    for (const e of names) {
      const qualifier = qualifierOf(e, x.item.title);
      if (
        qualifier !== null &&
        // Only a request that names a second thing asks a qualifier to disambiguate: "Dana Lee (CEO)" answers
        // "email Dana Lee" as well as "Dana Lee (Northwind)" does when no organisation was named at all.
        cue.entities.some((o) => o.toLowerCase() !== e.toLowerCase()) &&
        !cue.entities.some((o) => {
          const other = o.toLowerCase();
          return qualifier.includes(other) || other.includes(qualifier);
        })
      )
        return true;
    }
    // Two-word names the request uses, by first word, with possessives folded away ("Lee's" → "lee", "Logistics'"
    // → "logistics"): a title whose second word completes one of the request's pairs is that person or vendor,
    // not a look-alike — and "introduce Sarah Chen to Sarah Cole" keeps the item of either Sarah.
    const pairs = new Map<string, { first: string; seconds: Set<string> }>();
    for (const e of names) {
      const w = e.trim().split(/\s+/);
      if (w.length < 2) continue;
      const key = w[0]!.toLowerCase();
      const entry = pairs.get(key) ?? { first: w[0]!, seconds: new Set<string>() };
      entry.seconds.add(w[1]!.toLowerCase().replace(/['’]s?$/, ""));
      pairs.set(key, entry);
    }
    for (const { first, seconds } of pairs.values()) {
      const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const other = new RegExp(`\\b${esc}\\s+(\\p{Lu}[\\p{L}'’.-]+)`, "u").exec(x.item.title);
      if (other === null) continue;
      const second = other[1]!.toLowerCase().replace(/['’]s?$/, "");
      if (!seconds.has(second)) return true;
    }
    // A thing a forwarded document declares a named party's, when the request claims that thing for the
    // user (D2060): "Fwd: Sam Okoro's flight to Lisbon" is not the booking "move my flight" acts on. The
    // forward mark is what makes the owner a third party — "Kai Nihalani's appointment" on the user's own
    // calendar is the user's own, however the request phrases it. The owner the request itself names is
    // no look-alike ("reschedule Sam's flight"), nor is a bare possessive at the title's end ("Brunch at
    // Rosa's"), which names no owned thing.
    if (FIRST_PERSON.test(cue.raw) && FORWARDED.test(x.item.title)) {
      const raw = cue.raw.toLowerCase();
      OWNED_BY.lastIndex = 0;
      for (const m of x.item.title.matchAll(OWNED_BY)) {
        const owner = m[1]!.toLowerCase();
        if (raw.includes(owner) || owner.split(/\s+/).some((p) => raw.includes(p))) continue;
        if (raw.includes(m[2]!.toLowerCase())) return true;
      }
    }
    return false;
  }

  protected confident(s: Session, scored: Scored[], cue: Cue): Scored[] {
    // One pass that stops at the cap: every test judges one item alone, so stopping early returns what filtering all
    // and then slicing returned. The cheap tests run first; `cleared` (the conflict test, about half the fast path's
    // CPU in pipeline.bench) and `beyondName` run only on what survives them, and only until the cap is reached.
    const cap = Math.min(this.config.maxItemsPerInjection, this.config.confidentItems);
    const staleOf = this.staleSibling(s, cue, cue.entities, scored);
    const sure: Scored[] = [];
    for (const x of scored) {
      if (sure.length >= cap) break;
      if (x.score < this.config.confidentScore || x.matched < this.config.minMatchedTerms) continue;
      // Bulk mail is never pushed without a model's say: a newsletter arriving is no reason to speak.
      if (bulkMail(x.item)) continue;
      // Nor, with `quietSettled`, an item that only says things stand as expected (`settled`); nor, with
      // `groundAway`, an absence on other days than the request names (`awayElsewhere`).
      if (this.config.quietSettled && settledOf(x.item)) continue;
      if (this.awayElsewhere(x.item, cue)) continue;
      // Nor, with `quietClear`, one about what the request names whose decisive value does not conflict with it.
      if (this.cleared(x, cue)) continue;
      // Nor a look-alike: another identifier's, last year's or another organisation's item (D1970).
      if (this.contradicts(x, cue)) continue;
      // Nor the copy that reads stale: it declares itself superseded, the deadline it names has passed, or a
      // newer record about the same thing sits beside it.
      if (this.staleSelf(x.item, cue) || staleOf(x.item)) continue;
      // Nor, with `quietNameOnly`, one only a name ties to the request.
      if (!this.beyondName(x, cue)) continue;
      sure.push(x);
    }
    return sure;
  }

  /**
   * With no model's say, what the request's people and days ground (D44), from the item's structure rather than the
   * words it shares with the request:
   * - an item a person the request names takes part in (`namesParticipant`), when the request acts on someone
   *   (scheduling, writing to them, a task) or arrives from outside; on a named day or, for "the next", the earliest
   *   upcoming such item, else the best scored, nearer in time first;
   * - events on a day the request names that share a name with it ("a call on 12 November" from Globex Ventures
   *   finds "Globex <> Robin" that day), or, when the user asks what is on their calendar, every event that day.
   * Bulk mail is never grounded. Empty when nothing is.
   */
  protected grounded(
    s: Session,
    cue: Cue,
    candidates: Scored[],
    eventKind: string,
    bridged: ReadonlySet<string> = new Set(),
    cls?: ActionClass,
    carded: ReadonlyMap<string, CardFind> = new Map(),
  ): { items: Scored[]; how: string } {
    const none = { items: [] as Scored[], how: "" };
    const acts = this.acts(s, cue, eventKind);
    // A look-alike that contradicts the request's anchors is not grounded either (D1970), nor the copy that
    // reads stale beside the current one.
    const staleOf = this.staleSibling(s, cue, cue.entities, candidates);
    const pool = candidates.filter(
      (x) => !bulkMail(x.item) && !this.contradicts(x, cue) && !this.staleSelf(x.item, cue) && !staleOf(x.item),
    );
    const time = cue.time;
    // A `dayCls` seat counts as on the day beside a timed `meta.start` day (D1978) — except a bare-weekday one
    // (class 3), which only a clash's overlap test may hand (D1979).
    const onDay = (x: Scored) =>
      time !== null && (time.days.has(startDay(x.item, cue.offset) ?? "") || (x.dayCls !== undefined && x.dayCls <= 2));
    const upcoming = (x: Scored) => startMs(x.item) >= cue.at;
    // Items whose start lives only in text sort after the timed ones (NaN compares false); their day seat holds.
    const soonest = (a: Scored, b: Scored) =>
      (startMs(a.item) || Number.POSITIVE_INFINITY) - (startMs(b.item) || Number.POSITIVE_INFINITY);
    // A run that starts the sentence may carry the verb with it ("Email Dana Lee"): try it without its first word too.
    const people = cue.entities
      .flatMap((e) => {
        const w = e.trim().split(/\s+/);
        return w.length >= 3 ? [e, w.slice(1).join(" ")] : [e];
      })
      .filter((e) => e.includes("@") || e.trim().split(/\s+/).length >= 2);
    const meeting = ABOUT_MEETING.test(cue.raw);
    // Who is named is not enough to say which item: a meeting needs an event with them; anything else needs the
    // item to hold a word of the request beyond the person's name (the topic).
    const nameWords = (p: string) => p.trim().split(/\s+/).length;
    const fits = (x: Scored, p: string) => (meeting ? startDay(x.item) !== null : x.matched > nameWords(p));
    const withPerson = acts ? pool.filter((x) => people.some((p) => namesParticipant(p, x.item) && fits(x, p))) : [];
    // With probes on: an action on a named day at a named time, and an event already there near that time, is a clash
    // the agent should see before it acts, whoever the event is with.
    const clash = this.config.probes && !this.config.probeOff.includes("clash");
    let range: { from: number; to: number } | null = null;
    if (clash && time && time.days.size > 0 && (isScheduling(cue.raw) || ASKS_CLASH.test(cue.raw))) {
      range = requestedSpan(cue.raw);
      // "a clash at that time?" names no span — the time it means is the one the last turns just said (D1979).
      if (range === null && ANAPHORIC_TIME.test(cue.raw)) {
        for (const line of [...s.window].reverse().slice(0, 6)) {
          range = requestedSpan(line);
          if (range) break;
        }
      }
    }
    if (range && time) {
      // An event in the time asked for, other than the one the request is about (D48). Its minutes come from
      // `meta.start`, or from the clock its own text writes ("Thursday 16:15-17:00", D1979).
      const near = (x: Scored) => {
        const m = startMinutes(x.item) ?? textMinutes(x.item);
        return m !== null && overlaps(x.item, m, range) && !isSubject(x.item, cue.raw);
      };
      // A dated item (meta.start) is a clash only on its own day; a weekday in its text is just how it
      // says when it happens, not which week's ("Thursday" next week is not this Thursday's clash).
      const onDay = (x: Scored) => {
        const sd = startDay(x.item, cue.offset);
        return sd === null ? x.dayCls !== undefined : time.days.has(sd);
      };
      const clashes = pool.filter((x) => onDay(x) && near(x)).sort(soonest);
      if (clashes.length > 0) {
        // What the request is about still belongs beside the clash the move would make — but the clash is the
        // answer: the clashing items come first, so subject records can never crowd them out of the cap (D1984).
        const subjectItems = pool.filter((x) => isSubject(x.item, cue.raw));
        const seen = new Set(clashes.map((x) => x.item.id));
        const items = [...clashes, ...subjectItems.filter((x) => !seen.has(x.item.id))].slice(0, this.max());
        return { items, how: "clash" };
      }
    }
    // With `groundConflict`: what would change the action (or the answer), tied to what the request names or asks
    // (`conflict.ts`): a hold over the day it acts on, a limit below its amount, a thing done already (D49).
    if (this.config.groundConflict) {
      const hits = this.conflicts(cue, pool, bridged, cls);
      if (hits.length > 0) return { items: hits.slice(0, this.max()), how: "conflict" };
      // `cards`: an item whose card the request violates (a freeze over its day, an expiry before it, a limit under
      // its amount, a standing constraint on what it names), read by the model when the item arrived. At most
      // `cardItems`, the best tied first: a card is a model's reading, and one wrong one is noise.
      const byCard = pool
        .filter((x) => carded.get(x.item.id)?.violated)
        .sort((a, b) => cardRank(carded.get(b.item.id)!) - cardRank(carded.get(a.item.id)!))
        .slice(0, this.config.cardItems);
      if (byCard.length > 0) return { items: byCard, how: "card" };
    }
    // With `groundAway`: a person the request names, away on a day it names ("ask Jamie to feed the cat next weekend"
    // and Jamie's "away on Skye 6–9 Nov"), whatever the words: the agent should know before it asks them (D48).
    if (this.config.groundAway && time && time.days.size > 0) {
      const { words } = cueNames(cue);
      const away = pool.filter((x) => {
        const span = absenceSpan(x.item, cue.at);
        return (
          span !== null && [...time.days].some((d) => d >= span.from && d <= span.to) && mentionsAny(words, x.item)
        );
      });
      if (away.length > 0) return { items: away.slice(0, this.max()), how: "away" };
    }
    if (this.config.groundOccasion) {
      const occasion = this.occasion(cue, pool, eventKind, acts, meeting);
      if (occasion.items.length > 0) return occasion;
    }
    if (withPerson.length > 0) {
      const dated = withPerson.filter(onDay);
      if (dated.length > 0) return { items: [dated[0]!], how: "person-day" };
      if (time?.next) {
        const next = withPerson.filter(upcoming).sort(soonest);
        if (next.length > 0) return { items: [next[0]!], how: "person-next" };
      }
      // Equal scores: the one nearer in time (a meeting this week over one in March); undated items keep their order.
      const near = (x: Scored) => Math.abs((startMs(x.item) || cue.at) - cue.at);
      const byPerson = [...withPerson].sort((a, b) => b.score - a.score || near(a) - near(b));
      return { items: byPerson.slice(0, 1), how: "person" };
    }
    // `groundSubject` (D1976): a request about a subject it names gets the context around it, not the best match alone.
    // An availability ask on a named day is not about the subject but about the day: `time-free` answers it below.
    const asksFree =
      time !== null &&
      time.days.size > 0 &&
      (eventKind === "user_message" || eventKind === "ask") &&
      ((onlyTime(cue) && ASKS_SCHEDULE.test(cue.raw)) || (/\?\s*$/.test(cue.raw) && ASKS_FREE.test(cue.raw)));
    if (
      this.config.groundSubject &&
      !asksFree &&
      cue.entities.length > 0 &&
      (acts || /\?\s*$/.test(cue.raw) || isAction(cue.raw))
    ) {
      const subject = this.subject(s, cue, pool);
      if (subject.length > 0) return { items: subject.slice(0, this.max()), how: "subject" };
    }
    // A wh-question about a thing of the user's own (D1980): "When is my physio appointment?" names its subject
    // in no entity ("physio" is no name) — the item the question is about answers it.
    if (ASKS_OWN.test(cue.raw) && (eventKind === "user_message" || eventKind === "ask")) {
      const subject = pool.filter((x) => {
        if (!isSubject(x.item, cue.raw)) return false;
        if (!time || time.days.size === 0) return true;
        const sd = startDay(x.item, cue.offset);
        return sd === null ? x.dayCls !== undefined : time.days.has(sd);
      });
      if (subject.length > 0) return { items: subject.slice(0, this.max()), how: "subject" };
    }
    if (!time) return none;
    const events = pool.filter((x) => (time.days.size > 0 ? onDay(x) : time.next && upcoming(x)));
    // A title that holds a name the request uses whole ("Priya Raman talk"); one shared uncommon word ("Globex" for
    // "Globex Ventures") only from an arriving message naming a day, where the sender's name is what the event is filed
    // under ("your next payment" from Globex names no day, and no event). A
    // first name alone ("Elena" in "Robin / Elena 1:1") names the event only when the request is about meeting them:
    // "the agenda with Elena this week" asks for something other than the 1:1.
    const whole = meeting ? cue.entities : cue.entities.filter((e) => nameWords(e) >= 2);
    const named = events
      .filter((x) => {
        if (titleNames(whole, x.item) === "whole") return true;
        return eventKind === "external" && time.days.size > 0 && titleNames(cue.entities, x.item) === "word";
      })
      .sort(soonest);
    if (named.length > 0) {
      return { items: time.next && time.days.size === 0 ? [named[0]!] : named.slice(0, this.max()), how: "time-named" };
    }
    // The whole day only for a question about the calendar and nothing else ("what's on my calendar on Sunday?"): any
    // other word, even a lowercase first name ("the agenda with sam this week"), says the day's events are not all
    // that is asked.
    if (
      (eventKind === "user_message" || eventKind === "ask") &&
      time.days.size > 0 &&
      ((onlyTime(cue) && ASKS_SCHEDULE.test(cue.raw)) || (/\?\s*$/.test(cue.raw) && ASKS_FREE.test(cue.raw)))
    ) {
      // "Is Thursday morning free?": the day's events are the answer however the rest of the request reads
      // (D44). A clash/conflict ask is not that listing: it asks about one time, and with no span resolved
      // to check against ("at that time" naming none yet) it stays silent rather than handing the day (D1978).
      if (!ASKS_CLASH.test(cue.raw)) {
        return { items: events.sort(soonest).slice(0, this.max()), how: "time-free" };
      }
    }
    return none;
  }

  /**
   * `subject` (D1976): a request about a subject it names ("my Lisbon flight", "the Smeg kettle") gets the context
   * around it, not the best match alone: the items about the named thing, the timed items of a day the request
   * moves it to (the train Saturday a new flight would clash with), and a companion the context needs beside the
   * subject (the booking's change policy, the shop's returns window). Single-word entities anchor here — the
   * whole-word title/text match, a date or a second shared term, and `contradicts`/bulk mail/`maxItemsPerInjection`
   * bound it the way every ground is bound.
   */
  private subject(s: Session, cue: Cue, pool: Scored[]): Scored[] {
    // Entities the request uses as its subject, not its setting ("my Lisbon flight", never "novels set in Delhi");
    // a stop-word the extractor keeps ("The Smeg") is not part of the name.
    const entities = cue.entities
      .map((e) =>
        e
          .trim()
          .split(/\s+/)
          .filter((w) => !isStopword(w.toLowerCase()))
          .join(" "),
      )
      .filter((e) => e.length > 0 && !SETTING_WORDS.has(wordBefore(cue.raw, e)));
    if (entities.length === 0) return [];
    const anchors = this.requestAnchors(s.scope, entities, cue);
    const entityWords = Math.max(1, ...entities.map((e) => e.trim().split(/\s+/).length));
    const dated = (item: ContextItem) => namedDays(itemText(item)).length > 0;
    // About the named thing: the entity a whole word of its title or of its text, and the item a dated record or
    // one also holding another of the request's terms — a bare mention is a lookalike until a second term binds it.
    const subject = pool.filter(
      (x) =>
        (titleNames(entities, x.item) === "whole" || namesEntity(x.item, anchors)) &&
        (dated(x.item) || x.matched > entityWords),
    );
    if (subject.length === 0) return [];
    // The newest dated record a pick carries is the one the request means: an item about the named thing
    // dated only earlier is the stale sibling — last year's renewal notice beside this year's — a sibling,
    // not a pick, the same rule `linked` applies when a chosen item's companions are found, and the same
    // `staleSibling` keeps in the push pool (per entity: a request naming two subjects never lets one's
    // newer record date the other's, D1982).
    const year = docYears;
    const staleOf = this.staleSibling(s, cue, entities, subject);
    const anchorsPer = entities.map((e) => this.requestAnchors(s.scope, [e], cue));
    const anchoredOf = (item: ContextItem) =>
      entities
        .map((e, i) =>
          (e.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !isStopword(w)).length > 0 &&
          (titleNames([e], item) === "whole" || namesEntity(item, anchorsPer[i]!))
            ? i
            : -1,
        )
        .filter((i) => i >= 0);
    const picks = subject.filter((x) => !this.staleSelf(x.item, cue) && !staleOf(x.item));
    // The year a companion is judged against is per anchored entity of the picks, so a pick on another
    // subject's year cannot keep this one's stale sibling alive.
    const pickYearsE = entities.map(() => new Set<number>());
    for (const x of picks) for (const i of anchoredOf(x.item)) for (const y of year(x.item)) pickYearsE[i]!.add(y);
    const subjectYears = new Set(picks.flatMap((x) => year(x.item)));
    if (picks.length === 0) return [];
    const out = [...picks];
    const has = new Set(out.map((x) => x.item.id));
    const add = (x: Scored) => {
      if (!has.has(x.item.id)) {
        has.add(x.item.id);
        out.push(x);
      }
    };
    // The day the request moves it to: the day's other timed items are the clash it would make — never a day the
    // subject's items sit on, the one it moves from (a move naming both days finds those too). The day it moves
    // from is one the request names that a subject's item also names — the booking's other days ("back Sunday 15
    // Nov") are not it.
    const requestNamed = namedDays(cue.raw);
    const fromDays =
      cue.time !== null && cue.time.days.size > 0 && MOVES.test(cue.raw)
        ? namedDays(picks.map((x) => itemText(x.item)).join(" ")).filter((f) =>
            requestNamed.some((r) => r.day === f.day && r.month === f.month),
          )
        : [];
    const onFromDay = (item: ContextItem) => {
      const on = startDay(item, cue.offset);
      const d = on === null ? null : /^\d{4}-(\d{2})-(\d{2})$/.exec(on);
      return (
        (d !== null && fromDays.some((f) => f.day === Number(d[2]) && f.month === Number(d[1]) - 1)) ||
        namesDay(itemText(item), fromDays)
      );
    };
    if (fromDays.length > 0 || (cue.time !== null && cue.time.days.size > 0 && MOVES.test(cue.raw))) {
      for (const x of pool) if (!onFromDay(x.item) && namesRequestDay(x.item, anchors)) add(x);
    }
    // A companion the subject's context needs beside it: a term of the request's and one of the subject's (the
    // returns policy that answers "can I still get a refund"), or two of the subject's (the booking's change
    // policy — the request may share no word with it at all).
    const subjectTerms = new Set<string>();
    for (const x of picks) for (const t of itemWords(x.item)) subjectTerms.add(t);
    const requestTerms = new Set(cue.text.split(" ").filter(Boolean));
    // Shared terms count on letters only: a bare number ("5") binds two items on nothing.
    const companion = (item: ContextItem) => {
      // The dead copy and the older sibling are never the companion either (`staleSibling`'s same rule).
      if (this.staleSelf(item, cue) || staleOf(item)) return false;
      // A document naming a different year than the picks' is that topic's sibling, not its companion —
      // last year's renewal notice beside this year's (the same rule `linked` keeps).
      const ys = year(item);
      const relevant =
        anchoredOf(item).length > 0 ? new Set(anchoredOf(item).flatMap((i) => [...pickYearsE[i]!])) : subjectYears;
      if (ys.length > 0 && relevant.size > 0 && !ys.some((y) => relevant.has(y))) return false;
      let shared = 0;
      let req = false;
      for (const t of itemWords(item)) {
        if (subjectTerms.has(t)) {
          if (/\p{L}/u.test(t)) shared++;
        } else if (requestTerms.has(t)) req = true;
      }
      return shared >= 2 || (shared >= 1 && req);
    };
    for (const x of pool) if (!has.has(x.item.id) && !onFromDay(x.item) && companion(x.item)) add(x);
    // Companions the request's own words never ranked in (a policy sharing nothing but the subject's terms).
    const vocab = this.deps.cache.peekVocab(s.scope);
    if (vocab !== undefined && out.length < this.max()) {
      const q = termIds([...subjectTerms].join(" "), vocab, false);
      const query: number[] = [];
      for (let i = 0; i < q.n; i++) if (!isStopword(vocab.term(q.ids[i]!))) query.push(q.ids[i]!);
      if (query.length > 0) {
        for (const h of this.deps.cache.search(s.scope, query, query.length, 12, this.now())) {
          if (out.length >= this.max()) break;
          if (
            has.has(h.item.id) ||
            bulkMail(h.item) ||
            !s.ledger.isFresh(h.item.id, s.turn) ||
            s.delivered.some((d) => nearDuplicate(d.sketch, h.sketch) && sameRef(d.refs, h.item)) ||
            // A copy `rank` folded away is no more welcome as a companion (the same near-duplicate fold).
            out.some(
              (o) =>
                nearDuplicate(o.sketch, h.sketch) &&
                startDay(o.item, cue.offset) === startDay(h.item, cue.offset) &&
                sameRef(itemRefs(h.item), o.item),
            ) ||
            this.alreadyHas(s, h.item, h.doc, vocab)
          ) {
            continue;
          }
          const x: Scored = { item: h.item, matched: h.matched, score: h.coverage, sketch: h.sketch, doc: h.doc };
          if (this.contradicts(x, cue) || !companion(h.item)) continue;
          add(x);
        }
      }
    }
    return out;
  }

  /**
   * `companions` (D1977): once a request's subject items are chosen — the grounded subject, the sources' sure
   * pick, the fallback — a bounded second pass hands the injection what a delivered item pulls: its companions,
   * the items holding a strong link to a chosen one — the same identifier `sameRef` reads (`idNumbers`), or two
   * of its rare letter terms, or one of them beside a term of the request's. The pass reads the lookup's own
   * candidates and the cache the request's words never ranked in; with `companionSearch` it then asks the
   * sources once more on the picks' own terms — one bounded call each, counted with the lookup's `sourceCalls` —
   * so a companion the request's phrasing could not fetch still links in: the deck for the meeting, the thread's
   * other mail, the invoice's bill in another system. Every bound the subject's own companions keep still applies:
   * `contradicts`, bulk mail, delivered/`sameRef` and near-duplicate suppression, `alreadyHas`, and
   * `maxItemsPerInjection`. An item naming an identifier the item it links to does not is a look-alike (last
   * year's invoice beside this one's), never a companion.
   */
  private async withCompanions(
    s: Session,
    cue: Cue,
    chosen: Scored[],
    scored: readonly Scored[],
    was: Map<string, LedgerEntry | undefined>,
    onCalls?: (calls: number) => void,
  ): Promise<Scored[]> {
    // Ledger entries at selection time, like `deliverChecked`'s own `was`: the pass's await hands the event loop to
    // the request's fast path, which may deliver (and mark) one of these meanwhile — it is dropped at delivery.
    for (const x of chosen) if (!was.has(x.item.id)) was.set(x.item.id, s.ledger.entry(x.item.id));
    return [...chosen, ...(await this.companions(s, cue, chosen, scored, was, onCalls))];
  }

  private async companions(
    s: Session,
    cue: Cue,
    chosen: readonly Scored[],
    scored: readonly Scored[],
    was: Map<string, LedgerEntry | undefined>,
    onCalls?: (calls: number) => void,
  ): Promise<Scored[]> {
    const room = this.max() - chosen.length;
    if (!this.config.companions || chosen.length === 0 || room < 0 || s.closed) return [];
    // Terms and identifiers per pick: a candidate must link to one pick on that pick's own evidence — a union
    // over every pick's words would let a wrong-numbered invoice in on another pick's identifier pass.
    const picks = chosen.map((x) => ({
      src: x.item.sourceId,
      refs: itemRefs(x.item),
      terms: new Set(itemWords(x.item)),
      caps: itemCaps(x.item),
      years: itemYears(x.item),
    }));
    const requestTerms = new Set(cue.text.split(" ").filter(Boolean));
    // Words of an entity the request names ("Acme Supplies", "Jordan Pike", "Lisbon") bind nothing here: every
    // look-alike of the named thing — the vendor's promo mail, the near-namesake's card, the other event in that
    // city — shares exactly those. A companion links on what the item is about: an identifier, its topic words.
    const entityTerms = new Set<string>();
    const entityPhrases: string[][] = [];
    for (const e of cleanEntities(cue.entities)) {
      // Stopwords drop out of both sides' term sets, so the shared-name check counts only the name's
      // content words ("The North Face" links on "north face").
      const words = (e.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !isStopword(w));
      if (words.length >= 1) entityPhrases.push(words);
      for (const w of words) entityTerms.add(w);
    }
    // A link term is a real word: a fragment ("s" of "client's"), a bare digit, a clock or day word, an entity
    // the request names, and the redaction placeholder sanitize left in the text bind nothing.
    const term = (t: string) =>
      // A two-letter code of a letter and a digit (the "q3" of a board pack) binds like a word; a fragment does not.
      (t.length >= 3 || (t.length === 2 && /\p{L}/u.test(t) && /\p{N}/u.test(t))) &&
      /\p{L}/u.test(t) &&
      !TIME_WORD.test(t) &&
      !entityTerms.has(t) &&
      t !== "redacted";
    // The link to a chosen item: a shared identifier, two shared topic terms, or one beside a term of the
    // request's (the shop's returns policy beside the order that leaks). Numbers count per pair: an item
    // carrying an identifier the linked item does not is a sibling, not a companion.
    const linked = (item: ContextItem, needReq = false): boolean => {
      const n = itemRefs(item);
      const candidateYears = itemYears(item);
      // A Set: a word the item repeats counts once, so "shared two" is two different words of the pick's.
      const own = new Set(itemWords(item).filter(term));
      const ownAll = new Set(itemWords(item));
      const isPolicy = ruleDoc(own);
      for (const p of picks) {
        // A document of a different year is that topic's sibling, not its companion — last year's renewal
        // notice beside this year's (their day numbers can agree by chance).
        if (candidateYears.size > 0 && p.years.size > 0 && ![...candidateYears].some((y) => p.years.has(y))) continue;
        let shareNumber = false;
        for (const id of n)
          if (p.refs.has(id)) {
            shareNumber = true;
            break;
          }
        if (!shareNumber && p.refs.size > 0 && n.size > 0) continue;
        if (shareNumber) return true;
        // A rule document of the pick's own matter — the fare rules beside the booking they govern —
        // links on one shared term. It asks for no request word: a policy's own words are common by
        // nature, and the pick already names the matter. Another party's policy is not its rules —
        // Lufthansa's beside the TAP booking shares "booking" alone — so a proper name both carry
        // (the carrier) must bind it; rarity over the small request-time cache would misread a word
        // common in the unfetched corpus as rare.
        if (isPolicy && [...own].some((t) => p.terms.has(t)) && [...itemCaps(item)].some((c) => p.caps.has(c)))
          return true;
        // Only a rare word binds: "Nadia" or "lunch" sit on most of the user's items, so another event named
        // with them is a look-alike; "Globex" or a project name few items hold is the item's own topic. The
        // cache index holds raw words, so a word whose stem differs ("meeting" -> "meet") looks absent under
        // the stem — and absent reads rare; either form being common is evidence enough to say it is not.
        const sharedWords = new Set<string>();
        for (const t of own)
          if (
            p.terms.has(t) &&
            this.deps.cache.isRare(s.scope, t, RARE_SHARE) &&
            this.deps.cache.isRare(s.scope, stemWord(t), RARE_SHARE)
          )
            sharedWords.add(t);
        // A proper name written capitalized on both sides binds beside request evidence even when it is not
        // rare: the rare-word bar exists for words anyone could use (the shop's name is on most of its mail),
        // and a name like "Lakeland" is exactly the link a returns policy has to the order that leaks. It
        // never feeds the two-words-alone rule — common capitalized words ("Perfect", "Reply") are noise.
        const ownCaps = itemCaps(item);
        const sharedCaps = new Set<string>();
        for (const t of ownAll)
          if (
            !sharedWords.has(t) &&
            t.length >= 2 &&
            !TIME_WORD.test(t) &&
            !entityTerms.has(t) &&
            t !== "redacted" &&
            ownCaps.has(t) &&
            p.caps.has(t)
          )
            sharedCaps.add(t);
        // A name the request names, carried whole on both sides — the mail the meeting's sender sent — is a
        // link of its own; a first-name fragment of a multi-word entity is not.
        let entityShared = false;
        for (const e of entityPhrases) if (e.every((w) => ownAll.has(w) && p.terms.has(w))) entityShared = true;
        // A request word that isn't one of the counted link words is a second reason beside the link.
        const req = [...own].some((t) => requestTerms.has(t) && !sharedWords.has(t) && !sharedCaps.has(t));
        // A hit the re-search fetched from beyond the scored pool and the cache must tie to the request
        // (shared link words alone are what any mail of one sender shares), or across sources — a document
        // of another kind that shares two of the pick's rare words is not sender noise (D1984).
        if (sharedWords.size + sharedCaps.size >= 1 && (req || entityShared)) return true;
        if (sharedWords.size >= 2 && (!needReq || item.sourceId !== p.src)) return true;
      }
      return false;
    };
    const has = new Set(chosen.map((x) => x.item.id));
    const vocab = this.deps.cache.peekVocab(s.scope);
    const staleOf = this.staleSibling(s, cue, cue.entities, [...chosen, ...scored]);
    const out: Scored[] = [];
    // One rule document may ride beside the packet the pick cap already closed: the fare rules belong
    // next to the booking they govern whether or not a slot is free — the cap counts picks, not the
    // rules that constrain them (D2058). The allowance is spent only when a rule document actually
    // rides beside the cap — one admitted inside it holds a normal slot like any companion, and a
    // decrement there would spend the allowance twice and close the passes on free slots.
    let policyRoom = 1;
    const take = (x: Scored, strictLink = false): void => {
      const pol = ruleDoc(new Set(itemWords(x.item).filter(term)));
      if (out.length >= room + (pol ? policyRoom : 0)) return;
      if (has.has(x.item.id) || bulkMail(x.item) || !s.ledger.isFresh(x.item.id, s.turn)) return;
      if (s.delivered.some((d) => nearDuplicate(d.sketch, x.sketch) && sameRef(d.refs, x.item))) return;
      // A near-duplicate of a chosen one — the same occasion on another day, the same note a quarter on — is a
      // sibling, not a companion: a link that is the item itself read once more adds nothing.
      if (
        [...chosen, ...out].some(
          (o) =>
            (nearDuplicate(o.sketch, x.sketch) ||
              // Two timed items — the lunch last week beside the lunch asked about — are the occasion's
              // recurrences, not a companion (the thread's other mail, the meeting's deck have no start).
              (o.item.meta?.start !== undefined &&
                x.item.meta?.start !== undefined &&
                startDay(o.item, cue.offset) !== startDay(x.item, cue.offset))) &&
            sameRef(itemRefs(x.item), o.item),
        )
      )
        return;
      if (vocab !== undefined && x.doc !== undefined && this.alreadyHas(s, x.item, x.doc, vocab)) return;
      if (this.contradicts(x, cue) || this.staleSelf(x.item, cue) || staleOf(x.item) || !linked(x.item, strictLink))
        return;
      if (pol && out.length >= room) policyRoom--;
      has.add(x.item.id);
      // Its ledger entry at selection time, like `deliverChecked`'s `was`: a delivery that lands during the
      // pass's await (this request's own fast path) already handed it out.
      was.set(x.item.id, s.ledger.entry(x.item.id));
      out.push(x);
    };
    // What the request's own words already ranked: a companion is often a candidate scored under them.
    for (const x of scored) take(x);
    // Companions the request's words never ranked in: the cache searched for the chosen items' terms.
    if (vocab !== undefined && out.length < room + policyRoom) {
      const q = termIds([...new Set(picks.flatMap((p) => [...p.terms]))].join(" "), vocab, false);
      const query: number[] = [];
      for (let i = 0; i < q.n; i++) if (!isStopword(vocab.term(q.ids[i]!))) query.push(q.ids[i]!);
      if (query.length > 0)
        for (const h of this.deps.cache.search(s.scope, query, query.length, 12, this.now()))
          take({ item: h.item, matched: h.matched, score: h.coverage, sketch: h.sketch, doc: h.doc });
    }
    // `companionSearch` (D1984): a companion the request's own words never fetched sits outside the cache, so the
    // picks' terms ask the sources once more — one search call per source, capped at `companionSearch` sources and
    // counted with the lookup's `sourceCalls`. What they return is stored, then read back through the cache and
    // the same `take` gate every companion takes: the pool still decides, and silence-by-default holds.
    if (vocab !== undefined && out.length < room + policyRoom && this.config.companionSearch > 0 && !s.closed) {
      // The query a source gets is link vocabulary, not record prose: the picks' terms that pass `term` (real
      // words and letter+digit codes) plus the picks' refs — a companion two records share only by a number
      // still reaches its connector — sanitized like any text that leaves the engine: a connector sees a
      // pick's topic words, never a secret the gate already stripped.
      const subjectText = sanitizeForStore(
        [...[...new Set(picks.flatMap((p) => [...p.terms]))].filter(term), ...picks.flatMap((p) => [...p.refs])]
          .slice(0, 32)
          .join(" "),
      );
      const all = await this.deps.sources(s.scope).catch(() => [] as Source[]);
      // A source the sync reads is never re-searched: a current copy already sits in the cache the first pass
      // searched, and a poll in flight reads its boundary off what is stored — a re-search's finds, held early,
      // would fake that boundary (`sync.isWarm`).
      const sv = this.sync?.view(s.scope);
      const toSearch = all.filter((x) => !(sv?.isWarm(x.id) ?? false)).slice(0, this.config.companionSearch);
      if (subjectText.length > 0 && toSearch.length > 0) {
        const readMark = this.sync?.mark() ?? 0;
        const span = cue.span
          ? this.spans?.open("search.behind", cue.span, { async: true, sources: toSearch.length })
          : undefined;
        const turn = s.turn;
        const started = performance.now();
        let madeEarly = 0;
        let made = 0;
        let serving = true;
        // One call per source, stored as it settles (as `searchCutBehind` does for asks): a connector slower
        // than `companionSearchMs` never hides what the others already answered. Only a page that reached its
        // source is stored — a fan-out cache page was stored by the search that fetched it, under its own
        // read mark; putting it again would mark an older copy freshly read over a newer one.
        const searching = Promise.all(
          toSearch.map((x) =>
            this.fanout
              .search(
                [span ? this.traced(x, span.id) : x],
                { scope: s.scope, text: subjectText, entities: [], limit: 8 },
                {
                  timeoutMs: this.config.sourceTimeoutMs,
                  signal: s.abort.signal,
                },
              )
              .then(([o]) => {
                if (!o || !reachedSource(o)) return o;
                made++;
                if (serving) madeEarly++;
                if (!s.closed) this.store(s, o.items, span?.id ?? cue.span ?? 0, false, readMark);
                return o;
              }),
          ),
        );
        const finished = searching
          .then((results) => {
            const outcomes = results.filter((o): o is FanoutOutcome => o !== undefined);
            this.noteLiveRead(s, cue, outcomes);
            if (span) this.spans!.close(span, outcomeAttrs(outcomes));
            // Calls that answered inside the wait counted with the lookup's `sourceCalls` already; the rest
            // get a trace of their own, as a search behind does.
            const late = made - madeEarly;
            if (late > 0) {
              this.trace(s, {
                sessionId: s.id,
                turn,
                event: "search",
                decision: "skipped",
                reason: "companion search behind",
                latencyMs: Math.round(performance.now() - started),
                sourceCalls: late,
                modelCalls: 0,
                costUsd: 0,
                itemIds: [],
              });
            }
            return true;
          })
          .catch(() => {
            if (span) this.spans!.close(span, {});
            return false;
          });
        // Serving never waits on the re-search: what has not answered inside `companionSearchMs` still settles
        // behind, its finds stored for the next read.
        await Promise.race([
          finished,
          new Promise<boolean>((r) => setTimeout(() => r(false), this.config.companionSearchMs)),
        ]);
        serving = false;
        onCalls?.(madeEarly);
        const q = termIds(subjectText, vocab, false);
        const query: number[] = [];
        for (let i = 0; i < q.n; i++) if (!isStopword(vocab.term(q.ids[i]!))) query.push(q.ids[i]!);
        // Any shared subject term reads a hit back; what a hit must still prove is the link (`take`). A page
        // that only refreshed existing items' dates still counts — a corrected date can be the link.
        if (madeEarly > 0 && query.length > 0)
          for (const h of this.deps.cache.search(s.scope, query, query.length, 12, this.now()))
            take({ item: h.item, matched: h.matched, score: h.coverage, sketch: h.sketch, doc: h.doc }, true);
      }
    }
    return out;
  }

  /**
   * `carry`: a user message that names nothing of its own (no entity, at most two content terms) is a follow-up
   * on the request before it — "and the cable?", "who is he again?", "is that time free instead?". Its cue
   * takes the last request's terms and entity words, the content terms of the items that request's answer
   * delivered, and its named days when it names none, so the lookup reads what it is about. A cue with an entity
   * or three terms of its own stands on its own.
   */
  protected carry(s: Session, cue: Cue): void {
    const last = s.lastUser;
    if (!last || cue.entities.length > 0 || s.turn - last.turn > 6) return;
    const own = cue.text ? cue.text.split(" ") : [];
    if (own.length > 2) return;
    // Only a question-shaped follow-up reads the request before it: a bare statement this sparse is chatter
    // about its own words, not a pointer back.
    if (!/\?\s*$/.test(cue.raw)) return;
    // A stop-word-only message that is not question-shaped ("and him", "about it") never reaches here —
    // `wantsLookup` drops it as chatter. A question ("who is he again?") does, when a recent request is here
    // to carry (`carryQuestions`); with no own terms it anchors entirely on the request before it.
    const have = new Set(own);
    const extra: string[] = [];
    // What the last request's answer delivered carries its topic first: "order", "shipped", "arrives" live on the
    // item handed, not in the request's words, so a sparse question otherwise shares only its own term with the
    // sibling it asks after ("and the cable?" next to the other order). Bounded to the items sent since that
    // request; the just-delivered item itself stays out through the delivered suppression above (`sameRef`).
    // Kept few: every term the cue adds costs the candidates' coverage, so the cap must leave a follow-up's
    // match a share.
    // The last request's named person is what a follow-up points back at ("Who is he again?"), so the name's
    // words go ahead of the delivered items' and the request's other terms: within the same cap, half a name
    // ("leo" without "park") matches the right person nowhere and everything mentioning a first name.
    for (const e of last.entities) {
      for (const w of e.toLowerCase().split(/\s+/)) {
        if (extra.length >= CARRY_TERMS) break;
        if (!have.has(w)) {
          have.add(w);
          extra.push(w);
        }
      }
    }
    for (const d of s.delivered) {
      // At or after the request's turn: a packet handed out a turn late (an intervening tool or agent event)
      // still belongs to the answer the follow-up follows.
      if (d.turn < last.turn) continue;
      for (const t of d.terms) {
        if (extra.length >= CARRY_TERMS) break;
        if (!have.has(t)) {
          have.add(t);
          extra.push(t);
        }
      }
      if (extra.length >= CARRY_TERMS) break;
    }
    for (const t of last.terms) {
      if (extra.length >= CARRY_TERMS) break;
      if (!have.has(t)) {
        have.add(t);
        extra.push(t);
      }
    }
    if (extra.length > 0) cue.text = `${cue.text} ${extra.join(" ")}`.trim();
    // A pronoun-person follow-up ("Who is he again?", D1983) names nobody: its question words are noise, so the
    // carried name is the whole query and joins the entities the name-paths match on.
    if (ASKS_WHO.test(cue.raw) && last.entities.length > 0) {
      // "who is he" asks after a person: of the last request's names only the person-shaped ones (two
      // words, or an address) can answer it — "Leo Park from Acme" leaves Acme's own record out.
      const people = last.entities.filter(isPersonName);
      const named = people.length > 0 ? people : last.entities;
      cue.entities = [...named];
      cue.text = named.join(" ").toLowerCase();
      // The name is now the cue's identity: rebuild key and id as a hash of the full carried name list, so a
      // who-ask after a different person is no repeat of this one and reads its own cache — "Who is he?" and
      // "Who is she?" start as the same empty key, and no name list is long enough to truncate a digest.
      cue.key = `who:${createHash("sha256")
        .update(
          cue.entities
            .map((e) => e.toLowerCase())
            .sort()
            .join("|"),
        )
        .digest("hex")
        .slice(0, 24)}`;
      cue.id = `cue:${createHash("sha256").update(cue.key).digest("hex").slice(0, 10)}`;
    }
    cue.time ??= last.time;
  }

  /**
   * Whether a request acts on someone (scheduling, writing to them, a task) or arrives from outside.
   */
  private acts(s: Session, cue: Cue, eventKind: string): boolean {
    return eventKind === "external" || eventKind === "ask" || ACTING.has(s.situation) || ACTS_ON.test(cue.raw);
  }

  /**
   * The conflict ground's finds (`groundConflict`, D49): candidates about what the request names, tied beyond a name,
   * that `conflict.ts` says conflict with it, with the conflicting consequence finds (`bridged`).
   */
  private conflicts(cue: Cue, pool: Scored[], bridged: ReadonlySet<string>, cls: ActionClass | undefined): Scored[] {
    const hits = pool.filter(
      (x) => this.about(x, cue) && this.beyondName(x, cue) && this.verdict(x.item, cue) === "conflict",
    );
    // A consequence find that conflicts (`bridged`) is about the request by its class's words: for a class whose
    // constraints bind everyone (a change freeze, the user's own passport), whoever it names; for one whose bind one
    // party, when the request names no one or the find names someone it does: a legal hold on another client's
    // records is not this one's. The class's words are a tie beyond a name, so `quietNameOnly` does not gate it.
    const { names, words } = cueNames(cue);
    for (const x of pool) {
      if (!bridged.has(x.item.id) || hits.includes(x)) continue;
      if (cls?.scope === "general" || names.length === 0 || mentionsAny(words, x.item)) hits.push(x);
    }
    return hits;
  }

  /**
   * With `groundAway`, whether an item says someone is away only on days other than the ones the request names: no
   * reason, with no model's say, to raise it (the person is there then).
   */
  private awayElsewhere(item: ContextItem, cue: Cue): boolean {
    const time = cue.time;
    if (!this.config.groundAway || !time || time.days.size === 0) return false;
    const span = absenceSpan(item, cue.at);
    if (span === null || [...time.days].some((d) => d >= span.from && d <= span.to)) return false;
    // An item that names a day the request names is about that day too ("Offsite Fri 6 Nov … Sam is away 9-10 Nov").
    return !daysNamed(item, cue.at).some((d) => time.days.has(d)) && !time.days.has(startDay(item, cue.offset) ?? "");
  }

  /**
   * Each candidate's facts (`decide.ts`), as the rule paths read them, for the lab's candidate dump (`onCandidates`):
   * computed only when a harness wires it. CPU only; at most `decideCandidates` candidates, best scored first.
   */
  protected factsOf(
    s: Session,
    cue: Cue,
    scored: Scored[],
    eventKind: string,
    ctx: {
      probed?: ReadonlySet<string>;
      bridged?: ReadonlySet<string>;
      carded?: ReadonlyMap<string, CardFind>;
    } = {},
  ): { x: Scored; facts: Facts }[] {
    const top = scored[0]?.score ?? 0;
    const days = cue.time?.days;
    const hasDays = days !== undefined && days.size > 0;
    const { words } = cueNames(cue);
    const people = cue.entities.filter((e) => e.includes("@") || e.trim().split(/\s+/).length >= 2);
    const acts = this.acts(s, cue, eventKind);
    const imperative = isImperative(cue.raw);
    const question = /\?\s*$/.test(cue.raw);
    const frame = this.frame(cue);
    const b = (v: boolean) => (v ? 1 : 0);
    return scored.slice(0, this.config.decideCandidates).map((x, rank) => {
      const item = x.item;
      const card = ctx.carded?.get(item.id);
      const day = startDay(item, cue.offset);
      const at = startMs(item);
      const span = hasDays ? absenceSpan(item, cue.at) : null;
      const verdict = this.verdict(item, cue);
      const beyondName = this.beyondName(x, cue);
      const about = this.about(x, cue);
      const unmeasured = unmeasuredLimit(frame, item);
      // Read once: the away test and the fact itself ask the same question.
      const named = mentionsAny(words, item);
      const facts: Facts = {
        score: x.score,
        matched: x.matched,
        rank,
        relScore: top > 0 ? x.score / top : 0,
        entity: b(x.entity === true),
        beyond: x.beyond ?? -1,
        beyondName: b(beyondName),
        about: b(about),
        conflict: b(verdict === "conflict"),
        clear: b(verdict === "clear"),
        conflictHit: b(
          verdict === "conflict" && about && beyondName && !bulkMail(item) && !settledOf(item) && !unmeasured,
        ),
        bulk: b(bulkMail(item)),
        settled: b(settledOf(item)),
        awayElsewhere: b(this.awayElsewhere(item, cue)),
        onNamedDay: b(hasDays && days!.has(day ?? "")),
        namesDay: b(hasDays && daysNamed(item, cue.at).some((d) => days!.has(d))),
        dated: b(day !== null),
        upcoming: b(day !== null && at >= cue.at),
        awayOnDay: b(span !== null && [...days!].some((d) => d >= span.from && d <= span.to) && named),
        probed: b(ctx.probed?.has(item.id) === true),
        bridged: b(ctx.bridged?.has(item.id) === true),
        carded: b(card !== undefined),
        cardViolated: b(card?.violated === true),
        cardByName: b(card?.tied === "name"),
        participant: b(people.some((p) => namesParticipant(p, item))),
        mentions: b(named),
        namesRef: b(namesRef(frame, item)),
        unmeasured: b(unmeasured),
        ageDays: day !== null ? Math.log1p(Math.abs(at - cue.at) / 86_400_000) : 0,
        acts: b(acts),
        imperative: b(imperative),
        question: b(question),
        hasDays: b(hasDays),
        external: b(cue.external === true),
      };
      return { x, facts };
    });
  }

  /** The lab's candidate dump (`onCandidates`), when it is wired: ids and numbers, no content. */
  protected dump(
    s: Session,
    path: CandidateDump["path"],
    facts: { x: Scored; facts: Facts }[],
    delivered: readonly Scored[],
    how: string,
    pool?: string[],
  ): void {
    const sink = this.deps.onCandidates;
    if (!sink) return;
    sink({
      sessionId: s.id,
      turn: s.turn,
      path,
      candidates: facts.map((f) => ({ id: f.x.item.id, facts: f.facts })),
      delivered: delivered.map((x) => x.item.id),
      how,
      ...(pool ? { pool } : {}),
    });
  }

  /** The request's frame (`conflict.ts`), read once per cue. */
  private frame(cue: Cue): Frame {
    let f = FRAMES.get(cue);
    if (!f) {
      const names = cleanEntities(cue.entities).filter((e) => !e.includes("@"));
      // The user's wall clock, so "today" and a date's nearest year are their own (D44), as `cue.time.days` are.
      FRAMES.set(cue, (f = frameOf(cue.raw, cue.time?.days ?? null, localNow(cue), names, this.config.conflictVocab)));
    }
    return f;
  }

  /** What an item says about the request's frame: conflict, clear or none (`conflict.ts` `assess`). */
  private verdict(item: ContextItem, cue: Cue, ties?: ReadonlySet<string>): Verdict {
    return assess(this.frame(cue), item, localNow(cue), ties);
  }

  /**
   * Whether an item is about what the request names: a person or organisation it names, a reference it names
   * ("INV-5842"), or two of its terms. A conflict or a clearance is only read from such an item.
   */
  private about(x: Scored, cue: Cue): boolean {
    if (x.matched >= 2 || namesRef(this.frame(cue), x.item)) return true;
    return mentionsAny(cueNames(cue).words, x.item);
  }

  /**
   * With `quietNameOnly`, whether something besides a name ties an item to the request: a word of the request beyond
   * its names and time words, a day it names (the item's own, or one its text names), or a reference it names. A
   * passing mention ("Leila says hi by the way") ties every item of Leila's by her name alone, and no item by anything
   * else: with no model to ask, nothing is pushed. True when the flag is off.
   */
  private beyondName(x: Scored, cue: Cue): boolean {
    if (!this.config.quietNameOnly || x.beyond === undefined || x.beyond > 0) return true;
    // A message arriving from someone is their act, and a request to act on someone ("Book a table for me and Sam",
    // "Send Priya a hamper") is the user's: what bears on that person bears on the act (D44). Neither is a mention.
    if (cue.external || this.imperative(cue)) return true;
    const days = cue.time?.days;
    if (days && days.size > 0) {
      if (days.has(startDay(x.item, cue.offset) ?? "") || daysNamed(x.item, cue.at).some((d) => days.has(d)))
        return true;
    }
    return namesRef(this.frame(cue), x.item);
  }

  /** Whether a request is in the imperative; with `conflictVocab`, by its wider verbs too (`MORE_VERBS`). */
  private imperative(cue: Cue): boolean {
    return isImperative(cue.raw, this.config.conflictVocab ? MORE_VERBS : undefined);
  }

  /** With `quietClear`, whether an item is about the request and says its decisive value does not conflict. */
  private cleared(x: Scored, cue: Cue): boolean {
    return this.config.quietClear && this.about(x, cue) && this.verdict(x.item, cue) === "clear";
  }

  private max(): number {
    return this.config.maxItemsPerInjection;
  }

  /**
   * `groundOccasion`: with no model's say, the event a request means by what its title says, the way people name
   * one: by the occasion and who it is with ("dinner with Elena", "push coffee with Kofi"), by the occasion and the
   * day ("where are we having lunch on Monday?"), or, for a message from someone about meeting ("running late, still
   * ok to meet?"), by the event that names them. An event's title holds the request's occasion word (a word of the
   * request other than a name, a date or a stopword) and every word of a name it uses, a first name alone included;
   * or, for a question, the occasion word on a day the request names; or, for a meeting message, the person's name.
   * The one on a day the request names wins, else the soonest still to come (with no day named, a past one is never
   * taken). A named day no such event is on grounds nothing. Only for a request that asks or acts.
   */
  private occasion(
    cue: Cue,
    pool: Scored[],
    eventKind: string,
    acts: boolean,
    meeting: boolean,
  ): { items: Scored[]; how: string } {
    const none = { items: [] as Scored[], how: "" };
    const asks = acts || /\?\s*$/.test(cue.raw) || isAction(cue.raw);
    if (!asks) return none;
    const time = cue.time;
    const names = cleanEntities(cue.entities)
      .filter((e) => !e.includes("@"))
      .map((e) => e.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((w) => w.length > 0 && w.every((x) => !TIME_WORD.test(x)));
    const inNames = new Set(names.flat());
    const kinds = (cue.raw.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).filter(
      (w) => !inNames.has(w) && !isStopword(w) && !TIME_WORD.test(w) && !LEADING.has(w),
    );
    const titleWordsOf = (x: Scored) => new Set(x.item.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const events = pool.filter((x) => startDay(x.item) !== null);
    const onDay = (x: Scored) => time !== null && time.days.has(startDay(x.item, cue.offset) ?? "");
    const pick = (xs: Scored[], how: string, many = false) => {
      const dated = xs.filter(onDay).sort((a, b) => startMs(a.item) - startMs(b.item));
      if (dated.length > 0) return { items: many ? dated.slice(0, this.max()) : [dated[0]!], how: `${how}-day` };
      // A day the request names that no such event is on: the request may be about a new one ("an invite for drinks
      // Saturday"), or where one is going ("move my dinner to Friday"). Which is not for words to say: no ground.
      if (time !== null && time.days.size > 0) return none;
      const next = xs.filter((x) => startMs(x.item) >= cue.at).sort((a, b) => startMs(a.item) - startMs(b.item));
      return next.length > 0 ? { items: [next[0]!], how } : none;
    };
    const named = (t: Set<string>) => names.some((n) => n.every((w) => t.has(w)));
    // An occasion word that is a participant's name is a person the cue did not read as one (lowercase, "with elena").
    const kind = (x: Scored, t: Set<string>) => {
      const people = participantWords(x.item);
      return kinds.some((w) => t.has(w) && !people.has(w));
    };
    const withName = events.filter((x) => {
      const t = titleWordsOf(x);
      return named(t) && kind(x, t);
    });
    if (withName.length > 0) {
      const r = pick(withName, "occasion-person");
      if (r.items.length > 0) return r;
    }
    // By occasion and day alone only for a question about it: an action on a day's occasion ("send the pack before
    // next week's board meeting") is about the action, and the occasion standing as planned is no news.
    if (time !== null && time.days.size > 0 && names.length === 0 && /\?\s*$/.test(cue.raw)) {
      const r = pick(
        events.filter((x) => onDay(x) && kind(x, titleWordsOf(x))),
        "occasion",
        true,
      );
      if (r.items.length > 0) return r;
    }
    if (eventKind === "external" && meeting && names.length > 0) {
      return pick(
        events.filter((x) => named(titleWordsOf(x))),
        "occasion-sender",
      );
    }
    return none;
  }

  /**
   * With no model's say, the best candidate alone, if it is strong enough: several distinct query terms and a score
   * of at least `fallbackScore` (coverage plus the entity bonus, D36). An asking request gets every one of the
   * first three that stands up to it at half that score, since it names more than one fact (D1970).
   */
  private fallback(unsure: Scored[], cue?: Cue): Scored[] {
    const top = unsure[0];
    const c = this.config;
    if (!top || c.fallbackMatchedTerms <= 0 || (c.quietSettled && settledOf(top.item))) return [];
    if (cue && this.awayElsewhere(top.item, cue)) return [];
    if (cue && this.cleared(top, cue)) return [];
    // `fallbackAsks`: a request that asks (a question, or an action) needs an item two of its terms, not three, and
    // half the fallback score: what it asks for is what it means, and a fact that names it is the answer. A
    // question about the world at large ("a good stretch for back pain") names nothing of the user's, and words
    // like "good" or "week" match anything, so the item still needs the two terms its words earn.
    const asks = cue !== undefined && c.fallbackAsks && (/\?\s*$/.test(cue.raw) || isAction(cue.raw));
    const { names: named, words } = asks ? cueNames(cue) : NO_NAMES;
    if (asks) {
      // Every one of the first three that stands up to the request, not only the first that does: a request names
      // more than one fact ("pay the Acme invoice" wants the invoice and the hold on it), and the top one may be
      // about something else. A request that names nothing of the user's still needs two shared terms and half the
      // bar — one common word alone is not evidence (D1970). Look-alikes that contradict it are not handed.
      const hits = unsure
        .slice(0, 3)
        .filter(
          (x) =>
            (named.length === 0 || (/\?\s*$/.test(cue!.raw) && x.matched >= 2) || mentionsAny(words, x.item)) &&
            !bulkMail(x.item) &&
            x.matched >= 2 &&
            x.score >= c.fallbackScore * 0.5 &&
            !(c.quietSettled && settledOf(x.item)) &&
            !this.contradicts(x, cue!) &&
            !this.staleSelf(x.item, cue!) &&
            !this.awayElsewhere(x.item, cue!) &&
            !this.cleared(x, cue!) &&
            this.beyondName(x, cue!),
        )
        .slice(0, Math.min(this.config.maxItemsPerInjection, this.config.confidentItems));
      // "Who is he?" asks for the person, not the threads about them: where a hit is the record of the named one —
      // its title is just their name — the mails merely naming them are not the answer.
      if (hits.length > 1 && named.length > 0 && /\bwho\b/i.test(cue!.raw)) {
        const record = hits.filter((x) => named.some((n) => x.item.title.trim().toLowerCase() === n.toLowerCase()));
        if (record.length > 0) return record;
      }
      if (hits.length > 0) return hits;
    }
    const strong =
      !bulkMail(top.item) &&
      top.matched >= c.fallbackMatchedTerms &&
      top.score >= c.fallbackScore &&
      !(cue && this.contradicts(top, cue)) &&
      !(cue && this.staleSelf(top.item, cue));
    return strong && (!cue || this.beyondName(top, cue)) ? [top] : [];
  }

  /**
   * Routes, searches the chosen sources live, caches what they return and records which entities they hold. Returns
   * the sources called and the planner's plans for this lookup alone: a session can run an ask and a slow path at once,
   * so plans are never kept on the session where the other could read them.
   */
  protected async searchLive(
    s: Session,
    cue: Cue,
    limit: number,
    behind = false,
  ): Promise<{
    calls: number;
    plans?: Trace["plans"];
    probed?: string[];
    looked?: string[];
    consequence?: { cls: ActionClass; ids: string[] };
    /** With `sync`: sources answered from the local index, and listing calls of on-demand polls (in `calls`). */
    local?: number;
    syncCalls?: number;
    /**
     * How each source this lookup chose fared (D127): the fan-out's status, or "local" for one answered from the
     * synced index. A sync poll that failed leaves its source not current, so it is searched live and its status is
     * that search's; probes are extra queries beside a chosen source's own search, which gives the source's status.
     */
    sources?: SourceStatus[];
    /** The user's sources could not be resolved at all: nothing was searched, which is not an empty result. */
    unresolved?: true;
    /** The session ended before the search ran: nothing was searched, which is not an empty result either (D127). */
    closed?: true;
    /**
     * `askBehind` (D430): the chosen sources answered from a copy that was not whole (cut) or not current when the
     * lookup ran, whose poll or live search runs behind. Their "local" status stands only once that work is done.
     */
    behindLocal?: string[];
  }> {
    // Before any call: what this lookup stores was read under it, so a signal while it runs doubts it (D133).
    const readMark = this.sync?.mark() ?? 0;
    let unresolved = false;
    const all = await this.deps.sources(s.scope).catch((): Source[] => {
      unresolved = true;
      return [];
    });
    if (unresolved) return { calls: 0, sources: [], unresolved: true };
    if (s.closed) return { calls: 0, sources: [], closed: true };
    if (all.length === 0) return { calls: 0, sources: [] };
    // `routeLocalHits` (D265): which sources hold the request's best local matches, for routing. Only past the
    // lookup's own width: with as few sources as it searches, every one is searched whatever the order.
    const wide = all.length > Math.min(limit, this.config.lookupSources);
    const localHits = this.config.routeLocalHits && wide ? this.localRouteHits(s, cue) : undefined;
    const boost = addBoosts(
      localHits,
      // `routeSketch` (D322): the sources whose sketches hold the request's rarer terms, read or trimmed.
      this.config.routeSketch && wide ? this.sketchRouteHits(s, cue) : undefined,
    );
    // `sourceKindPrior` (D2015): a cold user's draw favours the kinds a person's requests usually land in.
    const priors = sourcePriors(all, this.config.sourceKindPrior, this.config.sourceKindPriorExtra);
    // One deadline for the whole lookup (D140): the on-demand poll, the live search, the planner's cascade and the
    // probes share it. An ask with `askBehind` off waits for its poll, so a poll and a search with deadlines of their
    // own could hold the reader back twice `sourceTimeoutMs` (a listing that hangs, then the search that follows it).
    const deadlineAt = performance.now() + this.config.sourceTimeoutMs;
    const left = () => Math.max(0, deadlineAt - performance.now());
    // The background sync (D57): a source whose synced copy is current answers from the user's local index, at no
    // call; with `syncOnDemand`, a stale one is polled first (one listing call, rather than its search and probes).
    let local: Set<string> | null = null;
    let syncCalls = 0;
    let preRanked: ReturnType<SourceMap["route"]> | null = null;
    let pollable: Set<string> | null = null;
    let cutBehind: Set<string> | undefined;
    let probeLocal: Set<string> | null | undefined;
    // `sourceYield` (D505): the warm copies whose unused live reads are spent: no probe, no cut-copy poll, and on a
    // lookup that does not wait for its poll no search behind. A lookup that waits for its poll still searches a spent
    // cut copy with the rest (more reads, never fewer facts).
    const spent = this.spentSources(s, cue, all, boost);
    if (this.sync) {
      // `syncPollWidth` (D263): over that many sources, only the best routed are polled. The lookup is routed once,
      // here, before its poll, and searches the head of the same ranking, so every source it searches was polled
      // (two routes would draw apart: an ask then answered unpolled stale copies as "nothing", review of D263). Under
      // the width nothing changes: the route runs after the poll, as before, and draws as before.
      const width = this.config.syncOnDemand ? this.config.syncPollWidth : 0;
      if (width > 0 && all.length > width) {
        preRanked = this.deps.sourceMap.route({
          scope: s.scope,
          entities: cue.entities,
          situation: s.situation,
          sourceIds: all.map((x) => x.id),
          limit: Math.max(width, limit),
          ...(boost ? { boost } : {}),
          ...(priors ? { priors } : {}),
        });
        pollable = new Set(preRanked.map((r) => r.sourceId));
      }
      if (this.config.syncOnDemand) {
        const signal = AbortSignal.any([s.abort.signal, AbortSignal.timeout(left())]);
        const freshening = this.spans?.open("sync.freshen", cue.span, { async: true });
        const tally = { fresh: 0 };
        // A spent copy the cap cut is not polled either: it is answered as held and named "unsearched". A whole copy
        // keeps its poll (a listing is no live read, and without it an ask would call the copy failed).
        const sync = this.sync;
        const sv = sync.view(s.scope);
        const skipPoll =
          spent && this.config.sourceYieldPolls ? (id: string) => spent.has(id) && !sv.complete(id) : null;
        const toPoll = all.filter((x) => (!pollable || pollable.has(x.id)) && !(skipPoll && skipPoll(x.id)));
        const polled = this.sync.freshen(s.scope, toPoll, signal, tally, s.abort.signal).then((calls) => {
          if (freshening) this.spans!.close(freshening, { calls, fresh: tally.fresh, ...(behind ? { behind } : {}) });
          return calls;
        });
        // `syncPollBehind`: the poll is not waited for. This lookup answers from the index as it stands (every warm
        // synced source, current or not); if the poll stores anything, the lookup is made again once it is done
        // (`afterPoll`). The agent's ask waits for it only with `askBehind` off (D430); on, it runs behind too.
        if (behind) {
          // The poll's listing calls are in no lookup's trace (this one's is out before they are counted, and a
          // follow-up runs only when the poll stored something), so the poll gets a trace of its own when it settles:
          // "skipped", not "silent" (it decided nothing), and emitted even if the session has closed by then, as a
          // late reader call is ("reader-late"): the calls were made. A poll that only waited on another's made none.
          const turn = s.turn;
          const started = performance.now();
          cue.polled = polled
            .then((calls) => {
              if (calls > 0) {
                this.trace(s, {
                  sessionId: s.id,
                  turn,
                  event: "sync",
                  decision: "skipped",
                  reason: "sync poll behind",
                  latencyMs: Math.round(performance.now() - started),
                  sourceCalls: calls,
                  modelCalls: 0,
                  costUsd: 0,
                  itemIds: [],
                  syncCalls: calls,
                });
              }
              return tally.fresh > 0;
            })
            .catch(() => false);
        } else syncCalls = await polled; // `freshen` stops waiting at the deadline itself (D140, D283)
        if (s.closed) return { calls: syncCalls, syncCalls, sources: [], closed: true };
      }
      // `pushCutBehind` (D405): on a lookup that does not wait for its poll, a cut copy answers here too and is
      // searched behind (below); a follow-up reads what that search stored and starts none of its own.
      if (behind && this.config.pushCutBehind && this.config.syncLocalComplete) {
        cutBehind = new Set();
        local = this.localOf(s, all, behind, cutBehind);
        // The probes keep D264: they search a cut copy live and are not waited for (`probeGraceMs`).
        probeLocal = this.localOf(s, all, behind);
      } else local = this.localOf(s, all, behind);
      // A spent copy answers the probes from what is held too.
      if (spent && spent.size > 0) {
        const base = probeLocal === undefined ? local : probeLocal;
        probeLocal = new Set([...(base ?? []), ...spent]);
      }
    }
    // `askBehind` (D430): which copies answered here before they were whole or current (read once the route is known).
    const now0 = this.now();
    const svNow = this.sync?.view(s.scope);
    const notYet =
      cue.cutStatus && local && svNow
        ? (id: string) => local!.has(id) && (cutBehind?.has(id) === true || !svNow.current(id, now0))
        : null;
    const routing = this.spans?.open("route", cue.span);
    const ranked =
      preRanked?.slice(0, limit) ??
      this.deps.sourceMap.route({
        scope: s.scope,
        entities: cue.entities,
        situation: s.situation,
        sourceIds: all.map((x) => x.id),
        limit,
        ...(boost ? { boost } : {}),
        ...(priors ? { priors } : {}),
      });
    if (routing) this.spans!.close(routing, { sources: ranked.length, local: local?.size ?? 0, syncCalls });
    const byId = sourcesById(all);
    const routed = ranked.map((r) => byId.get(r.sourceId)!).filter(Boolean);
    // A source routed on evidence of its items (a name it mentioned, the request's words among its held items), not on
    // the prior's draw or its sketch alone: what `cardsSourceAware` and `syncEngagedDeep` count as one the user uses.
    // A sketch match routes a search but engages no source: counted, it doubled the card calls at 1,000 sources for
    // no more hidden facts (a13-scale.md).
    this.engageSources(
      s,
      cue,
      ranked
        .filter((r) => r.entityHits > 0 || (localHits?.get(r.sourceId) ?? 0) > 0)
        // `sourceYieldEngage` (D601): a source this request reads nothing live of has not earned a deep copy, a
        // daily sweep or the card model either.
        .filter((r) => !(this.config.sourceYieldEarn && this.config.sourceYieldEngage && spent?.has(r.sourceId)))
        .map((r) => r.sourceId),
    );
    // Only the sources not answered locally are searched live; the local ones answer the same query below.
    const found = local ? routed.filter((x) => !local.has(x.id)) : routed;
    // Serving through the planner only in "serve" mode; in "shadow" the lookup is served as without one.
    const planner = this.deps.planner?.mode === "serve" ? this.deps.planner : undefined;
    // Wrapped per lookup (cheap: no state of its own). The fan-out admits each lookup per source id as before (breaker,
    // concurrency, one rate token); every extra call the planner makes takes its own rate token through `permit`, and
    // a shape's query answered recently comes from the fan-out's cache (`planCalls`), at no call.
    // A request about nothing but a time ("what's on my calendar on Sunday?") is sent as a listing of those days, with
    // no words: a calendar that filters by text and time together would find nothing for "calendar sunday" (D44).
    // Any other request keeps its words and no window: its days may be the new slot, not the item it is about.
    // A listing goes only to sources that list by time (a calendar): with no words, any other would return nothing, or
    // everything. With none such, the request is sent with its words as any other.
    const days = cue.time ? [...cue.time.days].sort() : [];
    const listers = onlyTime(cue) ? routed.filter((x) => x.listsByTime === true) : [];
    const listing = listers.length > 0;
    const window = listing
      ? {
          start: days[0]!,
          end: new Date(Date.parse(days.at(-1)!) + 86_400_000).toISOString().slice(0, 10),
          offsetMinutes: cue.offset,
        }
      : undefined;
    // The planner's cascade sends only the calls that can still answer by `deadlineAt`. A listing goes to each source
    // as it is: the planner's shapes are ways of sending words, and it has none.
    const spans = this.spans;
    const searchSpan = spans?.open("search", cue.span, { async: true, listing });
    // With spans on, each call a source answers is a child span of this search (`traced`).
    const sendTo = searchSpan ? (xs: Source[]) => xs.map((x) => this.traced(x, searchSpan.id)) : (xs: Source[]) => xs;
    // With `probeShare`: what the planner and the probes of this lookup send alike is sent once (`SharedCalls`).
    const shared: SharedCalls | undefined = this.config.probeShare ? new Map() : undefined;
    // A planned source's calls, as counted where they reach the connector (`made`), by its index in `chosen`.
    const planned: CountedPlanCalls[] = [];
    const chosen =
      planner && !listing
        ? sendTo(found).map((x) => {
            const via = this.fanout.planCalls(x, shared);
            planned.push(via);
            return new PlannedSource(x, planner, () => this.fanout.permit(s.scope, x.id), via, deadlineAt);
          })
        : listing
          ? sendTo(listers.filter((x) => !local?.has(x.id)))
          : sendTo(found);
    // Probes (`probe`) go out with the lookup, not after it: the slow path waits for the slower of the two, not both.
    // A probe that fails is no probe; a session that closes mid-search leaves it to finish on its own (it checks).
    // The lookup's own search starts first: the fan-out admits a call when it starts (a per-source concurrency slot),
    // and probes started before it could take the slots and leave the request itself skipped as busy.
    const query: SearchQuery = {
      scope: s.scope,
      text: listing ? "" : cue.text,
      entities: cue.entities,
      limit: 8,
      ...(window ? { window } : {}),
    };
    // A poll that used up the deadline leaves no time to search: each chosen source answers from the page the fan-out
    // holds for this query ("cached", or "stale" as a cut-off call would get), else is a timeout with no call. No rate
    // token, concurrency slot or breaker failure is spent on a call that could not answer (the probes' 50 ms).
    const searching =
      left() < MIN_SEARCH_MS
        ? Promise.resolve(
            chosen.map(
              (x): FanoutOutcome =>
                this.fanout.held(x.id, query) ?? { sourceId: x.id, status: "timeout", items: [], latencyMs: 0 },
            ),
          )
        : // What the poll left of the lookup's deadline (D140).
          this.fanout.search(chosen, query, { timeoutMs: left(), signal: s.abort.signal });
    const settled = searching.catch(() => null);
    // As the lookup's own search (D140, D148): with under `MIN_SEARCH_MS` left, no call that could not answer is sent.
    if (spent && cue.cutStatus && cutBehind) {
      // An ask names a copy it did not search (D127): never "local" for a cut copy.
      for (const id of spent) if (cutBehind.has(id)) cue.cutStatus.set(id, UNSEARCHED);
    }
    if (cutBehind && cutBehind.size > 0 && !cue.followUp && left() >= MIN_SEARCH_MS) {
      const behindOf = (listing ? listers : routed).filter((x) => cutBehind!.has(x.id) && !spent?.has(x.id));
      // Sent as the lookup's own search would be: through the planner's cascade (its shapes find what the request's
      // words alone miss), its calls counted where they reach the connector.
      const via: (CountedPlanCalls | undefined)[] = [];
      const behindChosen =
        planner && !listing
          ? sendTo(behindOf).map((x) => {
              const calls = this.fanout.planCalls(x, shared);
              via.push(calls);
              return new PlannedSource(x, planner, () => this.fanout.permit(s.scope, x.id), calls, deadlineAt);
            })
          : sendTo(behindOf);
      if (behindOf.length > 0) this.searchCutBehind(s, cue, behindChosen, via, query, deadlineAt, readMark);
    } else if (cue.cutStatus && cutBehind) {
      // `askBehind` (D430): no search behind was sent (too little of the deadline left, D148), so nothing is reading
      // these copies: "timeout" at once, never "searching" (whose answer promises what follows).
      for (const id of cutBehind) if (!cue.cutStatus.has(id)) cue.cutStatus.set(id, "timeout");
    }
    const probed: ProbeOut = { calls: 0, kept: [] };
    const probing = this.config.probes
      ? this.probe(s, cue, routed, all, listing, probed, settled, shared, {
          local: probeLocal === undefined ? local : probeLocal,
          deadlineAt,
          ...(boost ? { boost } : {}),
        }).catch(() => {})
      : null;
    // The same query answered by the synced sources from the local index (D57): no call, nothing to store.
    const answeredHere = local
      ? this.localAnswer(
          s,
          new Set((listing ? listers : routed).filter((x) => local!.has(x.id)).map((x) => x.id)),
          listing ? "" : cue.text,
          8,
          window,
        ).map((i) => i.id)
      : [];
    const outcomes = await searching;
    this.noteLiveRead(s, cue, outcomes);
    if (searchSpan) spans!.close(searchSpan, outcomeAttrs(outcomes));
    const plans = planner
      ? chosen.flatMap((x) => {
          const last = (x as PlannedSource).last;
          return last ? [{ sourceId: x.id, shapes: last.shapes, calls: last.calls, found: last.found }] : [];
        })
      : undefined;
    // The calls the connectors received: not a source answered by the fan-out's cache, one that joined another
    // lookup's call in flight (the slow path and `readerPush`'s ask search the same words at once), or one a guard
    // refused. A planned source counts the shape calls it sent that reached the connector (a cascade sends two).
    let made = 0;
    for (let k = 0; k < outcomes.length; k++) {
      const via = planned[k];
      made += via ? via.made : reachedSource(outcomes[k]!) ? 1 : 0;
    }
    // Each source the lookup chose, as it fared (D127): a listing goes to the sources that list by time, anything else
    // to every routed one; a synced source answered here from the local index, the rest by the fan-out's outcome.
    const statusOf = new Map(outcomes.map((o) => [o.sourceId, o.status]));
    const sources: SourceStatus[] = (listing ? listers : routed).map((x) => ({
      sourceId: x.id,
      status: local?.has(x.id) ? "local" : (statusOf.get(x.id) ?? "error"),
    }));
    const behindLocal = notYet ? sources.filter((x) => notYet(x.sourceId)).map((x) => x.sourceId) : undefined;
    const result = {
      calls: made + syncCalls,
      sources,
      ...(plans ? { plans } : {}),
      ...(this.sync ? { local: local?.size ?? 0, syncCalls } : {}),
      ...(behindLocal ? { behindLocal } : {}),
    };
    if (s.closed) return result; // Forgotten or ended mid-search: keep nothing.
    // One shadow lookup per session at a time: shadowing must not pile up work behind a slow connector.
    if (this.deps.planner?.mode === "shadow" && !s.shadowing) {
      const shadowSpan = spans?.open("shadow", cue.span, { async: true });
      s.shadowing = this.shadowLookup(s, found, cue, outcomes).finally(() => {
        s.shadowing = undefined;
        if (shadowSpan) spans!.close(shadowSpan);
      });
    }
    for (let k = 0; k < outcomes.length; k++) {
      const o = outcomes[k]!;
      // One source's items at a time, yielding between: storing a lookup's items (tokenizing, indexing, sketching) is
      // ~80 µs each, and other users' events should not wait behind all of them at once.
      if (k > 0) await yieldToLoop();
      if (s.closed) return result;
      // Mentions are recorded for items new to the cache or changed, so an item many lookups return is not counted
      // each time (that let one item dominate routing, and was ~10% of server CPU). They are written with the put,
      // before the next yield: a session closing in between must not leave items cached whose mentions never land.
      this.store(s, o.items, cue.span ?? 0, false, readMark);
    }
    if (probing) {
      const graceSpan = spans?.open("probes.grace", cue.span, { async: true });
      // The lookup waits at most `probeGraceMs` past its own search for the probes: a slow probe must not hold up
      // what the lookup found. One still running finishes on its own and caches what it finds for later turns; this
      // lookup ranks what the probes found by then, and counts the calls they had sent.
      const grace = this.config.probeGraceMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([probing, new Promise<void>((done) => (timer = setTimeout(done, grace)))]);
      clearTimeout(timer);
      if (graceSpan) spans!.close(graceSpan);
      // What the request's own search returned, beside the probes' finds: an item both found is twice supported.
      const looked = [...outcomes.flatMap((o) => o.items.map((i) => i.id)), ...answeredHere];
      // What the lookup's own search found too is not a probe's contribution (`probeYield`).
      if (this.config.probeYield) this.economy.claimed(s.scope, looked);
      return {
        ...result,
        calls: result.calls + probed.calls,
        probed: probed.kept.slice(0, 20),
        looked,
        ...(probed.consequence ? { consequence: probed.consequence } : {}),
      };
    }
    return result;
  }

  /**
   * `sourceYield` (D505): the user's warm synced copies this request skips live reads of (no probe, no cut-copy
   * poll, no search behind; a lookup that waits for its poll still searches a spent cut copy): a source whose own run
   * of reads with nothing used has reached `sourceYieldRun` (never for a request that names an entity the source
   * mentioned), or, with `sourceYieldEarn` (D600, D603), one with no item ever used that the request has no strong
   * evidence for. Only a warm copy: it answers from what is held, where a source with no copy would answer nothing.
   * Null when the switch is off or no source is spent.
   */
  private spentSources(
    s: Session,
    cue: Cue,
    all: readonly Source[],
    boost: ReadonlyMap<string, number> | undefined,
  ): Set<string> | null {
    const c = this.config;
    // `sourceYieldEarn` (D600) acts from a user's first request: nothing has been read yet, and nothing has earned.
    if (!this.yields || !this.sync || (!c.sourceYieldEarn && this.yields.size(s.scope) === 0)) return null;
    const now = this.now();
    const evidence = this.evidenceFor(s, cue, boost);
    const sv = this.sync.view(s.scope);
    let out: Set<string> | null = null;
    for (const x of all) {
      const kind = evidence(x.id);
      const run = this.yields.run(s.scope, x.id, now);
      const limit = kind === 2 ? 0 : c.sourceYieldRun;
      // Half a read of slack: a run decays from the moment of its last read, so 4 reads read 3.999 a minute later.
      const spent =
        (limit > 0 && run > limit - 0.5) || (c.sourceYieldEarn && kind < 2 && !this.yields.hasYielded(s.scope, x.id));
      if (spent && sv.isWarm(x.id)) (out ??= new Set()).add(x.id);
    }
    return out;
  }

  /**
   * `sourceYield` (D505): what the request has for a source: 2, it names an entity the source's items mentioned (the
   * source map); 1, its words are among the source's held items or in its sketch (`boost`); 0, nothing. With
   * `sourceYieldEarn` (D600) a word of the request that few of the user's sources hold counts as a name (2), and
   * with `sourceYieldNames` (D601) a name many of them mention counts only for a source with an item used.
   */
  private evidenceFor(s: Session, cue: Cue, boost: ReadonlyMap<string, number> | undefined): (id: string) => Evidence {
    let named: Set<string> | undefined;
    return (id) => {
      if (!named) {
        named = new Set();
        // `sourceYieldNames` (D601): a name more sources than that mention says little about any one of them; it
        // stays evidence for a source that has had an item used (the user's own mailbox names most people).
        const common = this.config.sourceYieldEarn ? this.config.sourceYieldNames : 0;
        for (const e of cue.entities) {
          const holders = this.deps.sourceMap.sourcesFor(s.scope, e);
          const weak = common > 0 && holders.length > common;
          for (const m of holders) if (!weak || this.yields?.hasYielded(s.scope, m.sourceId)) named.add(m.sourceId);
        }
        if (this.config.sourceYieldEarn && this.config.sourceYieldRare > 0 && this.sync) {
          const terms = sketchTerms(`${cue.text} ${cue.entities.join(" ")}`).slice(0, MAX_SKETCH_TERMS);
          const rare = this.sync.rareHolders(s.scope, terms.map(termHashes), this.config.sourceYieldRare);
          for (const id of rare) named.add(id);
        }
      }
      return named.has(id) ? 2 : (boost?.get(id) ?? 0) > 0 ? 1 : 0;
    };
  }

  /**
   * `sourceYield` (D505): books a live read against each source that answered one, once a source a turn: the push,
   * its probes and an ask of the same turn often join one call. Only an answer counts ("ok": the connector was
   * called and replied): a failure, a timeout or a guard's refusal says nothing about what the source holds, and a
   * page from the fan-out's cache was no call. Only a warm copy's source: no other is ever skipped, so its run
   * would count reads the rule cannot act on.
   */
  private noteLiveRead(s: Session, cue: Cue, outcomes: readonly FanoutOutcome[]): void {
    if (!this.yields || !this.sync || s.closed) return;
    if (s.liveReads?.turn !== s.turn) s.liveReads = { turn: s.turn, ids: new Set() };
    const seen = s.liveReads.ids;
    const fresh: string[] = [];
    for (const o of outcomes) {
      if (o.status !== "ok" || seen.has(o.sourceId) || !this.sync.isWarm(s.scope, o.sourceId)) continue;
      seen.add(o.sourceId);
      fresh.push(o.sourceId);
    }
    if (fresh.length === 0) return;
    this.yields.read(s.scope, fresh, this.now());
  }

  /**
   * `pushCutBehind` (D405): the live search D264 makes of cut copies, run behind a lookup that answered them from the
   * index. Same query, same deadline, same fan-out (breaker, rate, a call in flight joined). What it returns is stored
   * as the lookup's own finds are, and it joins `cue.polled`: if it stored anything new, the lookup's follow-up and
   * the push's second reading run on the index it refreshed. Its calls get a trace of their own when it settles, as a
   * poll behind does. Never throws.
   */
  private searchCutBehind(
    s: Session,
    cue: Cue,
    sources: Source[],
    via: readonly (CountedPlanCalls | undefined)[],
    query: SearchQuery,
    deadlineAt: number,
    readMark: number,
  ): void {
    const turn = s.turn;
    const started = performance.now();
    const span = this.spans?.open("search.behind", cue.span, { async: true, sources: sources.length });
    const opts = { timeoutMs: Math.max(0, deadlineAt - performance.now()), signal: s.abort.signal };
    // `askBehind` (D430): one source at a time (the same calls as one fan-out), each stored as it settles and its
    // outcome noted only then, so an ask that stops waiting ranks every source it calls answered on what it found.
    const each = cue.cutStatus;
    let early = 0;
    const searching = each
      ? Promise.all(
          sources.map((x) =>
            this.fanout.search([x], query, opts).then(([o]) => {
              if (!s.closed) early += this.store(s, o!.items, cue.span ?? 0, false, readMark);
              each.set(o!.sourceId, o!.status);
              return { ...o!, items: [] };
            }),
          ),
        )
      : this.fanout.search(sources, query, opts);
    // On the ask's path the outcomes come back with no items: each page was stored above as its source answered.
    const work = searching
      .then(async (outcomes) => {
        let made = 0;
        for (let k = 0; k < outcomes.length; k++) made += via[k] ? via[k]!.made : reachedSource(outcomes[k]!) ? 1 : 0;
        this.noteLiveRead(s, cue, outcomes);
        if (span) this.spans!.close(span, outcomeAttrs(outcomes));
        if (made > 0) {
          this.trace(s, {
            sessionId: s.id,
            turn,
            event: "search",
            decision: "skipped",
            reason: "cut search behind",
            latencyMs: Math.round(performance.now() - started),
            sourceCalls: made,
            modelCalls: 0,
            costUsd: 0,
            itemIds: [],
          });
        }
        let fresh = early;
        for (let k = 0; k < outcomes.length; k++) {
          if (k > 0) await yieldToLoop();
          if (s.closed) return false;
          fresh += this.store(s, outcomes[k]!.items, cue.span ?? 0, false, readMark);
        }
        return fresh > 0;
      })
      .catch(() => false);
    const before = cue.polled;
    cue.polled = before ? Promise.all([before, work]).then(([a, b]) => a || b) : work;
  }

  /**
   * The checks a request implies but does not ask for (`probes.ts`): its people, their organisations and its topic as
   * short queries, and the day an action names listed from sources that list by time. Their items are cached as the
   * lookup's are; the ids found for people, organisations and the day are returned for this lookup alone to rank and
   * seat with the judge (never kept on the session, where a later turn or a concurrent ask would see them). At most
   * `probeCalls` source calls, all within one `sourceTimeoutMs` deadline: the day, the people and the topic go out
   * together, the organisation after the people it is read from.
   */
  private async probe(
    s: Session,
    cue: Cue,
    found: Source[],
    all: Source[],
    listed: boolean,
    out: ProbeOut,
    searched: Promise<unknown>,
    shared?: SharedCalls,
    opts: ProbeOpts = {},
  ): Promise<void> {
    // Before the probes' calls: what they store was read under it (D133).
    const readMark = this.sync?.mark() ?? 0;
    const lanes = new Map<string, Promise<unknown>>();
    const budget = opts.budget ?? this.config.probeCalls;
    const local = opts.local ?? null;
    const spans = this.spans;
    const probesSpan = spans?.open("probes", cue.span, { async: true });
    // Calls the consequence probe made (outside `budget`).
    let extra = 0;
    const deadline = opts.deadlineAt ?? performance.now() + this.config.sourceTimeoutMs;
    const kept = out.kept;
    const send = async (
      kind: ProbeKind,
      sources: Source[],
      text: string,
      window?: SearchQuery["window"],
      keep = true,
      onAnswer?: (sourceId: string, page: ContextItem[]) => void,
    ): Promise<ContextItem[]> => {
      if (!spans) return sendOne(kind, sources, text, window, keep, onAnswer, 0);
      const sp = spans.open(`probe.${kind}`, probesSpan!.id, { async: true, sources: sources.length });
      const callsBefore = out.calls;
      try {
        return await sendOne(kind, sources, text, window, keep, onAnswer, sp.id);
      } finally {
        spans.close(sp, { calls: out.calls - callsBefore });
      }
    };
    const sendOne = async (
      kind: ProbeKind,
      sources: Source[],
      text: string,
      window: SearchQuery["window"] | undefined,
      keep: boolean,
      onAnswer: ((sourceId: string, page: ContextItem[]) => void) | undefined,
      parent: number,
    ): Promise<ContextItem[]> => {
      // Synced sources whose copy is current answer from the local index (D57), at no call and outside `probeCalls`.
      let here: ContextItem[] = [];
      if (local) {
        const mine = new Set(sources.filter((x) => local.has(x.id)).map((x) => x.id));
        sources = sources.filter((x) => !local.has(x.id));
        if (mine.size > 0) {
          here = this.localAnswer(s, mine, text, window ? 20 : 5, window);
          if (keep) for (const i of here) if (!kept.includes(i.id)) kept.push(i.id);
        }
        if (sources.length === 0) return here;
      }
      const ids = sources.map((x) => x.id);
      const key = `${text}|${window ? `${window.start}/${window.end}` : ""}|${ids.join(",")}`;
      // Probed recently by this user (any of their sessions): its finds at no call, while every one is still cached.
      const hits = this.deps.cache.probeHits(s.scope, key, this.config.probeMemoMs, this.now());
      if (hits) {
        if (keep) for (const h of hits) if (!kept.includes(h.item.id)) kept.push(h.item.id);
        return [...here, ...hits.map((h) => h.item)];
      }
      // The probe economy (`economy.ts`): a source whose answer to this query has likely not changed, or where this
      // kind of probe has not been yielding, is not called; its last answer, while still cached, stands in.
      const asked = `${text}|${window ? `${window.start}/${window.end}` : ""}`;
      const reused: ContextItem[] = [];
      let live = sources;
      if (this.config.probeFresh || this.config.probeYield) {
        live = [];
        const now = this.now();
        for (const source of sources) {
          const unchanged =
            this.config.probeFresh &&
            this.economy.changeChance(s.scope, source.id, asked, now) < this.config.probeFreshFloor;
          const idle =
            !unchanged &&
            this.config.probeYield &&
            !this.economy.worth(s.scope, kind, source.id, this.config.probeYieldFloor);
          const last = unchanged || idle ? this.economy.lastIds(s.scope, source.id, asked) : null;
          const held = last ? this.deps.cache.hits(s.scope, last, now) : [];
          // Unchanged but no longer cached: asked again, since nothing stands in for it.
          if (!idle && (!unchanged || !last || held.length < last.length)) {
            live.push(source);
            continue;
          }
          for (const h of held) reused.push(h.item);
        }
        if (keep) for (const i of reused) if (!kept.includes(i.id)) kept.push(i.id);
      }
      // The consequence probe is bounded by its own `consequenceSources`, on top of `probeCalls`: it must never take
      // the calls an organisation probe, sent after the people it is read from, would need.
      const own = kind === "consequence";
      const to = own ? live : live.slice(0, Math.max(0, budget - (out.calls - extra)));
      if (to.length === 0 || s.closed || deadline - performance.now() < 50) return [...here, ...reused];
      out.calls += to.length;
      if (own) extra += to.length;
      // A day's listing is the whole day (a busy one has more than a search's page); a query, its first page.
      const query = {
        scope: s.scope,
        text,
        entities: text ? [text] : [],
        // Shared with the planner's queries (`probeShare`), its page size: either may answer for the other.
        limit: window ? 20 : shared ? 8 : 5,
        ...(window ? { window } : {}),
      };
      const attempt = async (source: Source): Promise<FanoutOutcome | null> => {
        const left = deadline - performance.now();
        if (s.closed || left < 50) return null;
        // The planner sent the same query to this source in this lookup: its answer, at no call.
        const sk = shared && !window ? sharedKey(source.id, query) : "";
        const had = sk ? shared!.get(sk) : undefined;
        if (had) {
          const items = await had.catch(() => null);
          if (items) return { sourceId: source.id, status: "cached", items, latencyMs: 0 };
        }
        const run = this.fanout.search([parent ? this.traced(source, parent) : source], query, {
          timeoutMs: left,
          signal: s.abort.signal,
        });
        if (sk) {
          const answered = new Set(["ok", "cached", "stale"]);
          shared!.set(
            sk,
            run.then(([o]) => (o && answered.has(o.status) ? o.items : null)),
          );
        }
        const [o] = await run;
        return o ?? null;
      };
      // One probe call per source at a time, in this lookup: with the lookup's own call, that is two, the fan-out's
      // starting concurrency per source. One skipped as busy anyway (another lookup of the user's holds the slots)
      // is tried once more when the lookup's own search is done.
      const one = (source: Source) => {
        const run = (lanes.get(source.id) ?? Promise.resolve()).then(async () => {
          const o = await attempt(source);
          if (o?.status !== "busy") return o;
          await searched;
          return attempt(source);
        });
        lanes.set(
          source.id,
          run.catch(() => null),
        );
        return run;
      };
      const outcomes = (await Promise.all(to.map(one))).filter((o): o is FanoutOutcome => o !== null);
      this.noteLiveRead(s, cue, outcomes);
      // A page of the probe's own size from each source, even when the call was the planner's (8 items): more would
      // crowd the probes' seats with the judge (live, the judge passed fewer planted items with them).
      const items = outcomes.flatMap((o) => o.items.slice(0, window ? 20 : 5));
      const whole = window ? 20 : 5;
      // A call the fan-out did not make (busy, limited, open, answered from its cache, joined in flight, past the
      // deadline) is no call.
      const unmade = to.length - outcomes.filter(reachedSource).length;
      out.calls -= unmade;
      if (own) extra -= unmade;
      // A consequence probe's answers are always recorded: which of its terms each source was asked, and when, is
      // what rotates them and what its later lookups recall (`consequence`).
      const learn = this.config.probeFresh || this.config.probeYield || this.config.consequenceProbe;
      if (!s.closed && learn) {
        const now = this.now();
        for (const o of outcomes) {
          if (o.status !== "ok") continue;
          const page = o.items.slice(0, whole);
          this.economy.answered(s.scope, o.sourceId, asked, page, now, kind === "consequence");
          onAnswer?.(o.sourceId, page);
          // A name of several words teaches how the source searches them (`consequenceProbe` picks its query by it).
          if (this.config.consequenceProbe && (kind === "person" || kind === "second" || kind === "org")) {
            const words = text
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 1);
            this.economy.observeForm(s.scope, o.sourceId, words, page);
          }
          if (!this.config.probeYield) continue;
          // New to the user's cache (read before it is stored): what this call alone brought.
          const fresh = page.filter((i) => this.deps.cache.fetchedAt(s.scope, i.id) === undefined).map((i) => i.id);
          this.economy.called(s.scope, kind, o.sourceId, fresh);
        }
      }
      if (!s.closed) {
        const kept = whole > 5 && !window ? outcomes.flatMap((o) => o.items.slice(0, whole)) : items;
        this.store(s, kept, parent, false, readMark);
      }
      if (keep) for (const i of items) if (!kept.includes(i.id)) kept.push(i.id);
      // Only a complete answer is remembered: a source that failed or timed out is asked again next time.
      if (outcomes.length === to.length && live.length === to.length && outcomes.every((o) => o.status === "ok")) {
        this.deps.cache.rememberProbe(
          s.scope,
          key,
          [...items, ...reused].map((i) => i.id),
          PROBE_MEMO,
          this.now(),
        );
      }
      return [...here, ...items, ...reused];
    };
    const c = this.config;
    const off = new Set(c.probeOff);
    // An action on a named day: what is already that day is what it may clash with. Runs of consecutive days, each
    // listed whole: one span over separate days would page out the days asked for.
    const days = cue.time ? [...cue.time.days].sort() : [];
    const windows: SearchQuery["window"][] = [];
    if (
      !off.has("day") &&
      !listed &&
      days.length > 0 &&
      days.length <= 7 &&
      (isScheduling(cue.raw) || ASKS_FREE.test(cue.raw) || (onlyTime(cue) && ASKS_SCHEDULE.test(cue.raw)))
    ) {
      const next = (d: string) => new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);
      for (let i = 0; i < days.length;) {
        let j = i;
        while (j + 1 < days.length && days[j + 1] === next(days[j]!)) j++;
        windows.push({ start: days[i]!, end: next(days[j]!), offsetMinutes: cue.offset });
        i = j + 1;
      }
    }
    const listers = all.filter((x) => x.listsByTime === true);
    // A person or organisation goes to the sources most likely to hold them, by the source map's own record of which
    // sources mention which names (any source may, not only the lookup's): three per name, not every source.
    const byId = sourcesById(all);
    const allIds = all.map((x) => x.id);
    // `sourceKindPrior` (D2015): the same cold-user prior as the lookup's own route.
    const priors = sourcePriors(all, this.config.sourceKindPrior, this.config.sourceKindPriorExtra);
    const routeFor = (name: string, limit = c.probePeopleSources) =>
      this.deps.sourceMap
        .route({
          scope: s.scope,
          entities: [name],
          situation: s.situation,
          sourceIds: allIds,
          limit,
          ...(opts.boost ? { boost: opts.boost } : {}),
          ...(priors ? { priors } : {}),
        })
        .map((r) => byId.get(r.sourceId)!)
        .filter(Boolean);
    const people = off.has("people") ? [] : cue.entities.slice(0, 2);
    // `probeTopicAlone`: the topic only for a request that names no one (with people, their probes find what the topic
    // would: held-out funnels returned as many planted items without it, at fewer calls).
    const topic =
      off.has("topic") || (c.probeTopicAlone && people.length > 0) ? "" : topicOf(cue.text.split(" "), cue.entities);
    // The organisations of the request's people, from what came back for them; what is said of someone's
    // organisation (a hold, a policy) applies to them.
    const byPeople = (async () => {
      // The request's first person to `probePeopleSources` sources, a second to `probeSecondSources`. With
      // `probeYield`, the first goes to every source, best first, and the user's own yields drop the sources where
      // their person probes find nothing: which sources hold a user's people is learned, not guessed at three.
      const wide = c.probeYield ? all.length : c.probePeopleSources;
      const first = await Promise.all(
        people.map((q, i) =>
          send(i === 0 ? "person" : "second", routeFor(q, i === 0 ? wide : c.probeSecondSources), q),
        ),
      );
      const reading = off.has("org") ? undefined : spans?.open("orgs", probesSpan!.id);
      const orgs = off.has("org") ? [] : orgsOf(people, first.flat()).slice(0, 1);
      if (reading) spans!.close(reading, { orgs: orgs.length });
      for (const org of orgs) {
        if (!cue.entities.includes(org)) await send("org", routeFor(org), org);
      }
    })();
    // `probeRoles`: someone named by their relation ("my manager"), to the lookup's best two sources.
    const roles = c.probeRoles && !off.has("roles") ? rolesOf(cue.raw) : [];
    // `consequenceProbe`: a request that acts, of an action class (`consequence.ts`), asks its class's constraint
    // vocabulary of the sources best for that class: what would stop the action, in words the request never uses.
    // An imperative or an arriving message, not `isAction` or `ACTS_ON` (which match "tell", "ping" anywhere): a
    // question that mentions a release ("did Sam tell you whether the release went out?") is no release.
    const acts = isImperative(cue.raw) || cue.external === true;
    const cls = c.consequenceProbe && !off.has("consequence") ? actionClass(cue.raw, acts) : null;
    await Promise.all([
      ...windows.map((w) => send("day", listers, "", w)),
      byPeople,
      ...roles.map((r) => send("role", found.slice(0, 2), r)),
      // The topic's finds share the request's words, and rank on them; the others get seats of their own.
      ...(topic ? [send("topic", found.slice(0, this.config.probeTopicSources), topic, undefined, false)] : []),
      // Last: a source's probe calls go one at a time, and the request's own probes go first.
      ...(cls ? [this.consequence(s, cls, all, found, send, out)] : []),
    ]);
    if (probesSpan) spans!.close(probesSpan, { calls: out.calls });
  }

  /**
   * The consequence probe (`consequenceProbe`, `consequence.ts`): the request's action class's constraint vocabulary,
   * to the `consequenceSources` sources best for that class. With `probeYield`, best is learned per user (the upper
   * bound of what that class's probes have yielded at each source, an untried source first); without, the lookup's own
   * routing. A source learned to search any word gets every term in one query; one learned to need every word gets one
   * term, the next not yet asked (`nextTerm`), so a run of lookups of the class covers its vocabulary at one call each.
   * Its finds that hold a class term, with those its class's earlier queries found that are still cached, are this
   * lookup's consequence finds (never kept on the session).
   */
  private async consequence(
    s: Session,
    cls: ActionClass,
    all: Source[],
    found: Source[],
    send: ProbeSend,
    out: ProbeOut,
  ): Promise<void> {
    // One arm per source for every class: where a user's notices, policies and alerts live (their mail, a chat's
    // channels, a shared drive) is the same whatever the action.
    const kind: ProbeKind = "consequence";
    const now = this.now();
    const joined = cls.terms.join(" ");
    const ids = new Set<string>();
    const take = (items: ContextItem[]) => {
      for (const i of items) if (matchesClass(cls, `${i.title}\n${i.text}`)) ids.add(i.id);
    };
    // The user's cache first, at no call: an item an earlier lookup or probe brought in that holds a class term. The
    // sources such items came from are where the user's constraints of this kind are written (a #legal channel, a
    // calendar of freeze windows): they are asked first, while no yield is learned.
    const where = new Map<string, number>();
    const vocab = this.deps.cache.peekVocab(s.scope);
    const t = vocab ? termIds(joined, vocab, false) : null;
    const cached =
      t && t.n > 0 ? this.deps.cache.search(s.scope, Array.from(t.ids.subarray(0, t.n)), t.n, 12, now) : [];
    for (const h of cached) where.set(h.item.sourceId, (where.get(h.item.sourceId) ?? 0) + 1);
    const order = [...found, ...all.filter((x) => !found.includes(x))];
    const ranked = order
      .map((x, i) => ({
        x,
        i,
        b: this.config.probeYield ? this.economy.bound(s.scope, kind, x.id) : 1,
        w: where.get(x.id) ?? 0,
      }))
      .sort((a, b) => b.b - a.b || b.w - a.w || a.i - b.i)
      .map((r) => r.x);
    await Promise.all(
      ranked.slice(0, this.config.consequenceSources).map(async (source) => {
        // Every term at once only where the source is known to search any word; one term works everywhere.
        const text = this.economy.formOf(s.scope, source.id) === "any" ? joined : this.nextTerm(s, cls, source.id, now);
        if (!text) return;
        // What a source answers to every term at once teaches how it searches (`ProbeEconomy.observeForm`).
        const learn = (id: string, page: ContextItem[]) => {
          if (text === joined) this.economy.observeForm(s.scope, id, cls.terms, page, true);
        };
        const got = await send(kind, [source], text, undefined, false, learn);
        take(got);
      }),
    );
    if (s.closed) return;
    // This lookup's own finds first (the bound below keeps the first), then the cache's.
    take(cached.map((h) => h.item));
    // What the class's queries found at earlier lookups, at any source, while still cached: a freeze found when the
    // last release was asked for still stands in the way of this one.
    for (const source of all) {
      for (const q of [joined, ...cls.terms]) {
        const last = this.economy.lastIds(s.scope, source.id, `${q}|`);
        if (last) take(this.deps.cache.hits(s.scope, last, now).map((h) => h.item));
      }
    }
    if (ids.size > 0) out.consequence = { cls, ids: [...ids].slice(0, MAX_CONSEQUENCE) };
  }

  /**
   * The class term to ask a source that needs every word: the first never asked there, else the one asked longest
   * ago once its answer may have changed (past `probeMemoMs`); null when every term was asked recently.
   */
  private nextTerm(s: Session, cls: ActionClass, sourceId: string, now: number): string | null {
    let best: string | null = null;
    let bestAt = Infinity;
    for (const t of cls.terms) {
      const at = this.economy.askedAt(s.scope, sourceId, `${t}|`);
      if (at === null) return t;
      if (at < bestAt) [best, bestAt] = [t, at];
    }
    return best !== null && now - bestAt >= this.config.probeMemoMs ? best : null;
  }

  /**
   * Caches sanitized items, read under `readMark` (`Sync.mark` when their read began), and records the entity mentions
   * of those new to the cache or changed.
   */
  protected store(s: Session, items: ContextItem[], parent: number, synced: boolean, readMark: number): number {
    const spans = this.spans;
    const putting = items.length > 0 ? spans?.open("cache.put", parent, { items: items.length }) : undefined;
    const added = this.deps.cache.put(s.scope, items, this.now(), true, synced, readMark);
    if (putting) spans!.close(putting, { added: added.length });
    // An item seen again unchanged keeps its card alive; one evicted by the same put is not carded at all.
    if (this.config.cards)
      this.deps.cards?.touch(
        s.scope,
        items.map((i) => i.id),
      );
    this.enqueueCards(s.scope, added);
    this.recordMentions(s.scope, added, parent);
    return added.length;
  }

  /** `cards`: what is new to the cache (looked up or synced) is read for constraints in the background, off-path. */
  protected enqueueCards(scope: Scope, added: ContextItem[], defer?: (item: ContextItem) => boolean): void {
    if (this.config.cards && this.deps.cards && added.length > 0) this.deps.cards.enqueue(scope, added, defer);
  }

  /**
   * `cardsSourceAware` (D320), `syncEngagedDeep` (D323): the sources a lookup searched (or answered from the index)
   * are the user's in use (`Sync.engage`). With `cardsSourceAware`, the first time one is, its held synced items are
   * read by the card model, and the request's names are noted as the user's people.
   */
  private engageSources(s: Session, cue: Cue, searched: readonly string[]): void {
    const sync = this.sync;
    const cards = this.config.cardsSourceAware && this.config.cards && this.deps.cards !== undefined;
    if (!sync || (!cards && !this.config.syncEngagedDeep && !(this.config.syncUnusedSweepMs > 0))) return;
    if (cards && cue.entities.length > 0) {
      sync.notePeople(
        s.scope,
        cue.entities.map((e) => e.toLowerCase()),
      );
    }
    const fresh = sync.engage(s.scope, searched);
    // Whatever the user's source count now: items deferred while it was past `SOURCE_AWARE_MIN` are read (the review: a
    // count that fell to 32 first left them unread for good).
    if (!cards || fresh.length === 0) return;
    const now = this.now();
    const held: ContextItem[] = [];
    for (const id of fresh) {
      for (const itemId of sync.syncedIds(s.scope, id)) {
        const item = this.deps.cache.get(s.scope, itemId, now);
        if (item) held.push(item);
      }
    }
    this.enqueueCards(s.scope, held);
  }

  /**
   * A query answered from the user's synced items of the given sources (D57), as their live search would answer it
   * but with no call: at most `limit` per source, holding every word of the query (`syncLocalAll`: a mail or chat
   * search) or ranked on any; a listing (a window and no words) is the events that start on its days, soonest first.
   */
  private localAnswer(
    s: Session,
    sourceIds: ReadonlySet<string>,
    text: string,
    limit: number,
    window?: SearchQuery["window"],
  ): ContextItem[] {
    const cache = this.deps.cache;
    const now = this.now();
    const capped = (hits: CacheHit[]) => {
      const per = new Map<string, number>();
      return hits.filter((h) => {
        const k = per.get(h.item.sourceId) ?? 0;
        if (!sourceIds.has(h.item.sourceId) || k >= limit) return false;
        per.set(h.item.sourceId, k + 1);
        return true;
      });
    };
    if (window && !text.trim()) {
      const days = new Set<string>();
      const end = Date.parse(window.end);
      for (let t = Date.parse(window.start); t < end && days.size < 31; t += 86_400_000) {
        days.add(new Date(t).toISOString().slice(0, 10));
      }
      return capped(cache.timed(s.scope, days, now, 400)).map((h) => h.item);
    }
    const vocab = cache.peekVocab(s.scope);
    if (!vocab) return [];
    // The query's words, stopwords out, each once (in the session's vocabulary, so the user's never grows from a
    // query); a word no synced item holds matches nothing when every word is needed.
    const q = termIds(text, s.vocab, true);
    const words = new Set<string>();
    for (let i = 0; i < q.n; i++) {
      const w = s.vocab.term(q.ids[i]!);
      if (!isStopword(w)) words.add(w);
    }
    const ids: number[] = [];
    for (const w of words) {
      const id = vocab.lookup(w);
      if (id >= 0) ids.push(id);
      else if (this.config.syncLocalAll) return [];
    }
    const all = this.config.syncLocalAll;
    return cache.searchIn(s.scope, ids, ids.length, limit, sourceIds, all, now).map((h) => h.item);
  }

  /**
   * Ref notices' reads that landed (D347), noted as recent re-reads in each live session of the user
   * (`Session.checks`, as `check` keeps its own): a pool a session built before they landed holds the older copies, and
   * `verifyItems` then applies these outcomes to them (a changed item goes out as the cache now holds it). Called for
   * changed copies only, before their doubt is lifted: one walk of that user's sessions per changed ref
   * (`userSessions`; a walk of the whole process's sessions was refs × sessions on a busy process).
   */
  protected noteRefReads(scope: Scope, landed: readonly { id: string; outcome: CheckOutcome; mark: number }[]): void {
    if (landed.length === 0) return;
    const sessions = this.userSessions.get(scopeKey(scope));
    if (!sessions) return;
    const now = this.now();
    for (const s of sessions) {
      if (s.closed) continue;
      const checks = (s.checks ??= new Map());
      for (const { id, outcome, mark } of landed) {
        checks.delete(id);
        checks.set(id, { at: now, mark, outcome: Promise.resolve(outcome), settled: outcome });
      }
      while (checks.size > MAX_CHECKS) checks.delete(checks.keys().next().value as string);
    }
  }

  /**
   * `verifyDelivery`: re-reads, by ref and in parallel, each item in doubt (`doubted`). A changed copy is stored
   * (already redacted by the fan-out) and replaces the item; one its source no longer has is dropped from the cache and
   * left out; one that could not be checked stays as held.
   * Each re-read is a connector call, traced as a "verify" decision (`sourceCalls`). Never throws.
   *
   * `strict` (an ask's citations, D211): a doubted item whose re-read failed with a plain error is read once more, and
   * one still not confirmed is left out, counted by source in `strict.unconfirmed` for the answer to name. An ask's
   * answer is taken as what the sources hold now, so a copy a signal doubted and nothing confirmed is not cited (one
   * ask in 360 cited a deleted item that way in RealUse-1 part D). A source with no fetch tool, or whose null proves
   * nothing, is cited as held. A copy only a sweep could vouch for (`unswept`, D356) is cited only if a re-read
   * confirms it; one left out is counted in `strict.unswept`, named in the answer with its own reason.
   */
  protected async verifyItems(
    s: Session,
    scored: Scored[],
    cue: Cue,
    strict?: { unconfirmed: Map<string, number>; unswept: Map<string, number> },
  ): Promise<Scored[]> {
    if (!this.config.verifyDelivery || scored.length === 0) return scored;
    const now = this.now();
    // Doubted now, or re-read just before (`checkAhead`): that re-read made the cached copy current, but the copy in
    // hand is the one the pool was built from, so its outcome still applies.
    const recent = (id: string) => {
      const held = s.checks?.get(id);
      return held !== undefined && now - held.at <= CHECK_REUSE_MS;
    };
    const doubted = new Set<string>();
    // `syncUnusedSweepMs` (D356): copies only the sweep could vouch for, delivered only if a re-read confirms them.
    const unswept = new Set<string>();
    for (const x of scored) {
      if (this.unswept(s.scope, x.item)) unswept.add(x.item.id);
      if (unswept.has(x.item.id) || this.doubted(s, x.item)) doubted.add(x.item.id);
    }
    const due = scored.filter((x) => recent(x.item.id) || doubted.has(x.item.id));
    if (due.length === 0) return scored;
    const t0 = performance.now();
    // The calls of the re-reads this delivery started, counted by them: the engine-wide counter's change over the
    // awaits took in other sessions' and tenants' re-reads, and could go negative (audit A11's fuzz).
    const made = { calls: 0 };
    // The re-reads' wait as its own span (A18): counts only, under the delivery or ask that waits on it.
    const verifying = this.spans?.open("verify", cue.span, { async: true, due: due.length });
    const outcomes = new Map(
      await Promise.all(due.map(async (x) => [x.item.id, await this.check(s, x.item, made)] as const)),
    );
    let rounds = 1;
    if (strict && !s.closed) {
      // One more read (`check` reuses no failure) for a plain error, often one bad call, and for a read our own guard
      // skipped while the others held the source's slots; two at a time, the fan-out's starting concurrency per source.
      const again = due.filter((x) => doubted.has(x.item.id) && RETRIED.has(outcomes.get(x.item.id)!));
      for (let k = 0; k < again.length && !s.closed; k += STRICT_RETRY_LANES) {
        const batch = again.slice(k, k + STRICT_RETRY_LANES);
        const read = await Promise.all(batch.map(async (x) => [x.item.id, await this.check(s, x.item, made)] as const));
        for (const [id, o] of read) outcomes.set(id, o);
        rounds++;
      }
    }
    this.trace(s, {
      sessionId: s.id,
      turn: s.turn,
      event: "verify",
      decision: "verify",
      reason: cue.id,
      latencyMs: Math.round(performance.now() - t0),
      // Calls this delivery waited on that were made for it (a re-read started ahead is counted where it began).
      sourceCalls: made.calls,
      modelCalls: 0,
      costUsd: 0,
      itemIds: due.map((x) => x.item.id),
    });
    if (verifying) {
      let skipped = 0;
      for (const o of outcomes.values()) if (o === "skipped") skipped++;
      this.spans!.close(verifying, { calls: made.calls, rounds, skipped, strict: !!strict });
    }
    if (s.closed) return [];
    const after = this.now();
    return scored.flatMap((x) => {
      const o = outcomes.get(x.item.id);
      if (o === "gone") return [];
      // A removal that landed while the other re-reads ran (audit A5): the item is gone whatever its own outcome said.
      if (this.deps.cache.isHeldGone(s.scope, x.item.id, after)) return [];
      // An unswept copy no re-read confirmed (a null that proves nothing, an error, a skip): the sweep it was waiting
      // for is due now, and until it or a re-read vouches for the copy, it is not delivered nor cited.
      if (unswept.has(x.item.id) && o !== "confirmed" && o !== "changed") {
        // Only a null (the source could not say) is left to the sweep; an error or our own guard's skip is not worth
        // a whole listing: the next delivery re-reads it (the review).
        if (o === "unverifiable") this.sync?.sweepSoon(s.scope, x.item.sourceId);
        if (strict) strict.unswept.set(x.item.sourceId, (strict.unswept.get(x.item.sourceId) ?? 0) + 1);
        return [];
      }
      if (strict && doubted.has(x.item.id) && (o === "failed" || o === "flaked")) {
        strict.unconfirmed.set(x.item.sourceId, (strict.unconfirmed.get(x.item.sourceId) ?? 0) + 1);
        return [];
      }
      if (o !== "changed") return [x];
      // The copy in hand is the one the re-read found superseded: with no current copy cached (evicted meanwhile, not
      // removed), nothing is cited, and a strict ask names it as not re-checked, not an all-clear (D127).
      const copy = this.deps.cache.get(s.scope, x.item.id, after);
      if (copy) return [{ ...x, item: copy }];
      if (strict) strict.unconfirmed.set(x.item.sourceId, (strict.unconfirmed.get(x.item.sourceId) ?? 0) + 1);
      return [];
    });
  }

  /** `deliver`, after `verifyItems`: null when every item was found gone, or the session closed meanwhile. */
  private async deliverChecked(
    s: Session,
    scored: Scored[],
    mode: InjectionMode,
    reason: string,
    cue: Cue,
    was?: Map<string, LedgerEntry | undefined>,
    frame?: PacketFrame,
  ): Promise<Injection | null> {
    // The items were ranked against the ledger before the re-reads' await; a delivery during it (the next request's
    // fast path from the cache) may have handed some out since, and `build` marks without testing again: an item
    // whose ledger entry changed over the await is left out (audit A11's fuzz, default seed 2577; core seed 704). An
    // entry gone meanwhile was swept (past the cooldown, or past `MAX_LEDGER_ITEMS`), not handed out: kept (review).
    const held = was ?? new Map(scored.map((x) => [x.item.id, s.ledger.entry(x.item.id)] as const));
    const verified = await this.verifyItems(s, scored, cue);
    const kept = verified.filter((x) => {
      const now = s.ledger.entry(x.item.id);
      return now === undefined || sameEntry(held.has(x.item.id) ? held.get(x.item.id) : now, now);
    });
    if (kept.length === 0 || s.closed) return null;
    return this.deliver(s, kept, mode, reason, cue, undefined, frame);
  }

  /**
   * The planner's lookup beside a served one (shadow mode): it learns, and reports what it found, but nothing it
   * returns is cached, delivered or recorded as a mention, and it must never change serving:
   * - it runs only for connectors that served this lookup normally (not ones skipped as open, busy or limited, or
   *   that failed), so it adds no load to a struggling connector;
   * - its calls draw on a separate, smaller rate bucket (`permitShadow`), so serving's budget is never spent on it;
   * - a rate-limit error it sees is fed back to the limit, as serving's are;
   * - like serving, it starts no call its timeout would cut off.
   * Records carry sanitized item ids, the same ids serving's items get.
   */
  private async shadowLookup(s: Session, sources: Source[], cue: Cue, served: FanoutOutcome[]): Promise<void> {
    const planner = this.deps.planner;
    const sink = this.deps.onShadow;
    if (!planner) return;
    const turn = s.turn;
    const signal = AbortSignal.any([s.abort.signal, AbortSignal.timeout(this.config.sourceTimeoutMs)]);
    // As in serving: no call is started that this timeout would cut off.
    const deadlineAt = performance.now() + this.config.sourceTimeoutMs;
    const query = { scope: s.scope, text: cue.text, entities: cue.entities, limit: 8 };
    const healthy = new Set(["ok", "cached", "stale"]);
    await Promise.all(
      sources.map(async (source) => {
        const outcome = served.find((o) => o.sourceId === source.id);
        if (!outcome || !healthy.has(outcome.status)) return;
        const servedItemIds = outcome.items.map((i) => i.id);
        const record = (r: Partial<ShadowRecord>): void => {
          if (!sink || s.closed) return;
          try {
            sink({
              sessionId: s.id,
              turn,
              sourceId: source.id,
              status: "ok",
              shapes: [],
              calls: 0,
              itemIds: [],
              servedItemIds,
              ...r,
            });
          } catch {
            // A broken sink never breaks a lookup.
          }
        };
        const permit = () => this.fanout.permitShadow(s.scope, source.id);
        if (!permit()) return record({ status: "limited" });
        try {
          const r = await planner.search(source, query, signal, permit, undefined, deadlineAt);
          record({ shapes: r.shapes, calls: r.calls, itemIds: r.items.map((i) => sanitizedId(i)) });
        } catch (e) {
          this.fanout.rateLimited(s.scope, source.id, String(e));
          const partial = e instanceof PlanError ? e.partial : { shapes: [], calls: 1, items: [] };
          record({
            status: "error",
            shapes: partial.shapes,
            calls: partial.calls,
            itemIds: partial.items.map((i) => sanitizedId(i)),
          });
        }
      }),
    );
  }

  /** The slow path (`lookup`), under its own span when spans are on: its phases are that span's children. */
  protected async slowPath(
    s: Session,
    cue: Cue,
    t0: number,
    eventKind: string,
    served = false,
  ): Promise<Injection | null> {
    const spans = this.spans;
    if (!spans) return this.lookup(s, cue, t0, eventKind, served);
    const sp = spans.open("slow", cue.span, { async: true, served });
    cue.span = sp.id;
    let injection: Injection | null = null;
    try {
      injection = await this.lookup(s, cue, t0, eventKind, served);
      return injection;
    } finally {
      // The path that delivered (sources, grounded-…, fallback, model): the reason's fixed prefix, no cue id.
      spans.close(sp, {
        delivered: injection !== null,
        ...(injection ? { how: injection.reason.split(":")[0]! } : {}),
      });
    }
  }

  /** Which candidates a lookup may deliver or seat with the judge: scored above `candidateScore`, or tied otherwise. */
  private eligible(
    scored: Scored[],
    cue: Cue,
    probed: ReadonlySet<string>,
    bridged: ReadonlySet<string>,
    carded: ReadonlyMap<string, CardFind> = new Map(),
    intents: ReadonlyMap<string, IntentFind> = new Map(),
  ): Scored[] {
    // An event on a day the request names is a candidate whatever it scores on words (D44) — and since D1978,
    // an item whose day lives in its text as well (`dayCls` covers/names).
    const onNamedDay = (x: Scored) =>
      cue.time?.days.has(startDay(x.item, cue.offset) ?? "") === true || x.dayCls !== undefined;
    // A consequence find that does not conflict is no candidate: it shares nothing with the request but its class.
    // An intent hit (`intent`) is: its requests say the request is one it would change. The rule paths still read
    // its own words (its lexical score and terms are unchanged), so it is delivered with no model's say only where a
    // structural verdict (the conflict test, a violated card) binds it.
    return scored.filter(
      (x) =>
        x.score >= this.config.candidateScore ||
        onNamedDay(x) ||
        probed.has(x.item.id) ||
        bridged.has(x.item.id) ||
        carded.has(x.item.id) ||
        intents.has(x.item.id),
    );
  }

  /**
   * `routeLocalHits` (D265): for each source, log2(1 + how many of the request's best matches in the user's own index
   * it holds), from one search of the cache (no call); undefined when the user has nothing cached or nothing matches.
   */
  private localRouteHits(s: Session, cue: Cue): Map<string, number> | undefined {
    const cache = this.deps.cache;
    const vocab = cache.peekVocab(s.scope);
    if (!vocab) return undefined;
    const q = termIds(`${cue.text} ${cue.entities.join(" ")}`, vocab, false);
    const query: number[] = [];
    for (let i = 0; i < q.n; i++) if (!isStopword(vocab.term(q.ids[i]!))) query.push(q.ids[i]!);
    if (query.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const h of cache.search(s.scope, query, query.length, LOCAL_ROUTE_HITS, this.now())) {
      counts.set(h.item.sourceId, (counts.get(h.item.sourceId) ?? 0) + 1);
    }
    if (counts.size === 0) return undefined;
    for (const [id, n] of counts) counts.set(id, Math.log2(1 + n));
    return counts;
  }

  /** `routeSketch` (D322): each source's match of the request's terms against its vocabulary sketch (no call). */
  private sketchRouteHits(s: Session, cue: Cue): Map<string, number> | undefined {
    if (!this.sync) return undefined;
    const terms = sketchTerms(`${cue.text} ${cue.entities.join(" ")}`).slice(0, MAX_SKETCH_TERMS);
    return this.sync.sketchScores(s.scope, terms.map(termHashes));
  }

  /** The sources whose synced copy is current (`sync`, D57), which answer from the local index; null when none. */
  private localOf(s: Session, all: readonly Source[], behind = false, cut?: Set<string>): Set<string> | null {
    if (!this.sync) return null;
    const now = this.now();
    // `pushCutBehind` (D405): `cut` collects the warm cut copies admitted here, whose live search runs behind.
    const sv = this.sync.view(s.scope);
    if (cut) {
      const local = new Set<string>();
      for (const x of all) {
        if (!sv.isWarm(x.id)) continue;
        local.add(x.id);
        if (!sv.complete(x.id)) cut.add(x.id);
      }
      return local.size > 0 ? local : null;
    }
    // `behind`: a warm copy answers while its poll runs (`syncPollBehind`), never one still in its backfill; so does a
    // warm copy past `syncPollWidth` that the lookup did not poll (D263). An ask passes `behind` only with `askBehind`
    // (D430), which then names such a copy's status itself (`behindStatuses`); without it a stale copy it did not poll
    // is searched live (D127), within the probes' call budget.
    // With `syncLocalComplete`, only a copy that holds the whole source answers for it (D264): one the user's cap cut
    // is searched live, or a lookup would miss what is older than the cut.
    const whole = (id: string) => !this.config.syncLocalComplete || sv.complete(id);
    const ok = (id: string) => whole(id) && (sv.current(id, now) || (behind && sv.isWarm(id)));
    const local = new Set(all.filter((x) => ok(x.id)).map((x) => x.id));
    return local.size > 0 ? local : null;
  }

  private async lookup(s: Session, cue: Cue, t0: number, eventKind: string, served = false): Promise<Injection | null> {
    // The turn that triggered the lookup. Traces report it, not the turn current when the lookup finishes: later
    // events may arrive meanwhile, and evals attribute deliveries by this field.
    const turn = s.turn;
    let modelCalls = 0;
    let costUsd = 0;
    let sourceCalls = 0;
    let plans: Trace["plans"];
    let local: number | undefined;
    let syncCalls: number | undefined;
    const done = (decision: Trace["decision"], reason: string, items: ContextItem[] = []) =>
      this.trace(s, {
        sessionId: s.id,
        turn,
        event: eventKind,
        decision,
        reason,
        latencyMs: Math.round(performance.now() - t0),
        sourceCalls,
        modelCalls,
        costUsd,
        itemIds: items.map((i) => i.id),
        ...(plans ? { plans } : {}),
        ...(local !== undefined ? { localSources: local, syncCalls: syncCalls ?? 0 } : {}),
      });
    try {
      let probedIds: string[] | undefined;
      let lookedIds: string[] | undefined;
      let consequence: { cls: ActionClass; ids: string[] } | undefined;
      ({
        calls: sourceCalls,
        plans,
        probed: probedIds,
        looked: lookedIds,
        consequence,
        local,
        syncCalls,
        // Poll-behind needs the poll: without `syncOnDemand` nothing would bring a stale copy current, so it is
        // searched live as before.
      } = await this.searchLive(
        s,
        cue,
        this.config.lookupSources,
        this.config.syncPollBehind && this.config.syncOnDemand,
      ));
      if (s.closed) return null;
      const spans = this.spans;
      // This lookup's probe finds, its own (never another turn's or a concurrent ask's).
      const consIds = new Set(consequence?.ids ?? []);
      // `cards`: cached items whose implication card bears on the request's actions (no model, no call).
      const carding = this.config.cards && this.deps.cards ? spans?.open("cards.match", cue.span) : undefined;
      const carded = this.cardFinds(s, cue);
      if (carding) spans!.close(carding, { found: carded.size });
      // `intent`: cached items whose requests (written with their cards) match the request's words (no model).
      const intending = this.config.intent && this.deps.cards ? spans?.open("intent.match", cue.span) : undefined;
      const intentFound = this.intentFinds(s, cue);
      if (intending) spans!.close(intending, { found: intentFound.size });
      const extra = [...consIds, ...carded.keys(), ...intentFound.keys()];
      const ranking = spans?.open("rank", cue.span);
      const scored = this.rank(s, cue, {
        probed: extra.length > 0 ? [...(probedIds ?? []), ...extra] : probedIds,
      });
      if (ranking) spans!.close(ranking, { candidates: scored.length });
      // The day's own items sit beside the word-found ones (D1978), marked `dayCls` for `eligible`/`grounded`.
      this.seatDays(s, cue, scored);
      // Only anchored intent hits are eligible as such, take seats or tie the judge (`anchoredIntents`).
      const intents = this.anchoredIntents(s, cue, intentFound);
      // A consequence find counts only where the conflict test, tied by its class's words, says it conflicts with the
      // request (`consequenceProbe`): a freeze over the day a release is asked for, not one last month; and not a
      // limit on an amount the request does not state ("travel over £500 needs pre-approval" for printer paper).
      const ties = consequence ? classTies(consequence.cls) : undefined;
      const conflicting = consIds.size > 0 ? spans?.open("conflict", cue.span) : undefined;
      const bridged = new Set(
        consIds.size > 0
          ? scored
              .filter(
                (x) =>
                  consIds.has(x.item.id) &&
                  !unmeasuredLimit(this.frame(cue), x.item) &&
                  this.verdict(x.item, cue, ties) === "conflict",
              )
              .map((x) => x.item.id)
          : [],
      );
      if (conflicting) spans!.close(conflicting, { bridged: bridged.size });
      const confiding = spans?.open("confident", cue.span);
      let sure = this.confident(s, scored, cue);
      if (confiding) spans!.close(confiding, { sure: sure.length });
      // "Who is he?" (D1982) asks for the person's own record — `carry` made the name the cue's entities: when the
      // pool holds an item whose title IS that name, it alone answers; everything only mentioning the person
      // ("Leo Park shared a photo album") is context, not the record.
      if (ASKS_WHO.test(cue.raw) && (eventKind === "user_message" || eventKind === "ask")) {
        const who = cleanEntities(cue.entities)
          .filter(isPersonName)
          .map((e) => e.toLowerCase());
        if (who.length > 0) {
          const record = scored.filter((x) => who.includes(x.item.title.trim().toLowerCase()));
          if (record.length > 0) sure = record;
        }
      }
      const probedSet = new Set(probedIds ?? []);
      const factsNow = () => this.factsOf(s, cue, scored, eventKind, { probed: probedSet, bridged, carded: carded });
      // The rule paths decide when no model does.
      const noModelSay = !this.deps.model;
      const dumped = (path: CandidateDump["path"], items: readonly Scored[], how: string, say = noModelSay) => {
        if (this.deps.onCandidates && say) this.dump(s, path, factsNow(), items, items.length > 0 ? how : "");
      };
      // `served`: the request was answered already (a follow-up behind a delivery, `afterPoll`). The live search adds
      // only what is sure, or with no model what the request's structure grounds: never the fallback's best guess or
      // a judge call, which would have had that delivery among their candidates.
      if (served) {
        // A follow-up (`afterPoll`) decides as with no model whatever is configured: its judge call would be the
        // event's second (docs/COST-MODEL.md).
        const ruled =
          this.deps.model && !cue.followUp
            ? []
            : sure.length > 0
              ? sure
              : this.grounded(
                  s,
                  cue,
                  this.eligible(scored, cue, new Set(probedIds ?? []), bridged, carded, intents),
                  eventKind,
                  bridged,
                  consequence?.cls,
                  carded,
                ).items;
        // A follow-up corrects: an item the agent was given whose words its poll changed goes out again, as it now
        // reads, whatever it scores (the agent holds the superseded copy).
        const corrected = cue.followUp ? scored.filter((x) => x.revised && !ruled.includes(x)) : [];
        const was = new Map<string, LedgerEntry | undefined>();
        const items = await this.withCompanions(s, cue, [...ruled, ...corrected], scored, was, (n) => {
          sourceCalls += n;
        });
        dumped(
          "served",
          items,
          ruled.length > 0 ? (sure.length > 0 ? "sure" : "grounded") : "corrected",
          noModelSay || cue.followUp === true,
        );
        if (items.length === 0) {
          done("silent", "served");
          return null;
        }
        done(
          "sources",
          `after-served:${cue.id}`,
          items.map((x) => x.item),
        );
        return await this.deliverChecked(s, items, "proactive", `sources:${cue.id}`, cue, was);
      }
      // `judgeContested`: only when more than one item scored as sure (which is meant is then the judge's call), what
      // scores as sure is judged with the rest in the same call.
      const contested = this.config.judgeContested && sure.length > 1;
      const judgeSure = contested && this.deps.model !== null;
      if (sure.length > 0 && !judgeSure) {
        const was = new Map<string, LedgerEntry | undefined>();
        const items = await this.withCompanions(s, cue, sure, scored, was, (n) => {
          sourceCalls += n;
        });
        dumped("lookup", items, "sure");
        done(
          "sources",
          cue.id,
          items.map((x) => x.item),
        );
        return await this.deliverChecked(s, items, "proactive", `sources:${cue.id}`, cue, was);
      }
      // An event on a day the request names is a candidate whatever it scores on words (D44).
      const onNamedDay = (x: Scored) =>
        cue.time?.days.has(startDay(x.item, cue.offset) ?? "") === true || x.dayCls !== undefined;
      const probed = new Set(probedIds ?? []);
      const eligible = this.eligible(scored, cue, probed, bridged, carded, intents);
      // With probes on, up to three of the probes' finds join the judge's candidates beyond the best scored: found for
      // the request's people, organisations or day, they share few of its words and would otherwise never be seen.
      const top = judgeSure
        ? [...sure, ...eligible.filter((x) => !sure.includes(x))].slice(0, this.config.judgeCandidates)
        : eligible.slice(0, this.config.judgeCandidates);
      // A conflicting consequence find takes the first of those seats: nothing else would bring it to the judge.
      const probeSeats =
        this.config.probes && !this.config.probeOff.includes("seats")
          ? [
              ...eligible.filter((x) => bridged.has(x.item.id) && !top.includes(x)).slice(0, 1),
              ...eligible.filter((x) => probed.has(x.item.id) && !bridged.has(x.item.id) && !top.includes(x)),
            ].slice(0, 3)
          : [];
      // A carded item the request violates takes a seat of its own: it shares no word with the request, so nothing
      // else would bring it before the judge (`cards`).
      const cardSeat = eligible
        .filter((x) => carded.get(x.item.id)?.violated && !top.includes(x) && !probeSeats.includes(x))
        .sort((a, b) => cardRank(carded.get(b.item.id)!) - cardRank(carded.get(a.item.id)!))
        .slice(0, 1);
      // `intent`: the best intent hits the lexical order left out take seats of their own (`intentSeats`), for the
      // judge to read: their requests say the request is one they would change, though they share few of its words.
      const intentSeats = this.deps.model
        ? eligible
            .filter(
              (x) => intents.has(x.item.id) && !top.includes(x) && !probeSeats.includes(x) && !cardSeat.includes(x),
            )
            .sort((a, b) => intents.get(a.item.id)!.rank - intents.get(b.item.id)!.rank)
            .slice(0, this.config.intentSeats)
        : [];
      const seats = [...cardSeat, ...intentSeats, ...probeSeats];
      const unsure = [...top, ...seats];
      // A probe that brought in what is seated for the judge did its part, whatever the judge then makes of it: the
      // judge rules on relevance, the probe only on finding (`probeYield`).
      if (this.config.probeYield && !s.closed) {
        this.economy.reached(
          s.scope,
          unsure.map((x) => x.item.id),
        );
      }
      if (unsure.length === 0) {
        dumped("lookup", [], "");
        done("silent", "no candidates");
        return null;
      }
      // With no model to judge: what the request's people and days ground first (D44), then D36's fallback.
      const noModel = async (why: string, reasonPrefix: string): Promise<Injection | null> => {
        // What scored as sure is delivered as it would have been with no judge to ask: a failing or unaffordable
        // model is never worse than none (D41).
        if (judgeSure) {
          const was = new Map<string, LedgerEntry | undefined>();
          const items = await this.withCompanions(s, cue, sure, scored, was, (n) => {
            sourceCalls += n;
          });
          dumped("lookup", items, "sure", true);
          done(
            "sources",
            cue.id + reasonPrefix,
            items.map((x) => x.item),
          );
          return await this.deliverChecked(s, items, "proactive", `sources:${cue.id}`, cue, was);
        }
        // Grounding reads every candidate, not only the judge's few: a day's events rank after every word match.
        const grounding = spans?.open("ground", cue.span, { candidates: eligible.length });
        const grounded = this.grounded(s, cue, eligible, eventKind, bridged, consequence?.cls, carded);
        if (grounding) spans!.close(grounding, { grounded: grounded.items.length });
        if (grounded.items.length > 0) {
          const was = new Map<string, LedgerEntry | undefined>();
          const items = await this.withCompanions(s, cue, grounded.items, scored, was, (n) => {
            sourceCalls += n;
          });
          dumped("lookup", items, `grounded-${grounded.how}`, true);
          done(
            "sources",
            `grounded-${grounded.how}${reasonPrefix}:${cue.id}`,
            items.map((x) => x.item),
          );
          return await this.deliverChecked(s, items, "proactive", `grounded-${grounded.how}:${cue.id}`, cue, was);
        }
        const falling = spans?.open("fallback", cue.span);
        const items = this.fallback(unsure, cue);
        if (falling) spans!.close(falling, { picked: items.length > 0 });
        dumped("lookup", items, "fallback", true);
        if (items.length > 0) {
          const was = new Map<string, LedgerEntry | undefined>();
          const sent = await this.withCompanions(s, cue, items, scored, was, (n) => {
            sourceCalls += n;
          });
          done(
            "sources",
            `fallback${reasonPrefix}:${cue.id}`,
            sent.map((x) => x.item),
          );
          return await this.deliverChecked(s, sent, "proactive", `fallback:${cue.id}`, cue, was);
        }
        done("silent", why);
        return null;
      };
      // `judgeTied`: a judge shown only candidates the request is barely tied to (one common word each: "nice",
      // "week", "calendar") says "none" almost always, so the call is not made and the lookup ends silent. A candidate
      // is tied by a probe's find, a day the request names, two of its words, or one word few of the user's items hold.
      // A consequence find that conflicts with the request (`bridged`) is tied by its class's words, which the
      // request never uses: without this, the judge never sees the constraint the probe was sent to find.
      const tiedBy =
        (rare: ReturnType<PartnerVerdict["rareTerms"]>) =>
        (x: Scored): boolean =>
          probed.has(x.item.id) ||
          bridged.has(x.item.id) ||
          carded.get(x.item.id)?.violated === true ||
          intents.has(x.item.id) ||
          onNamedDay(x) ||
          x.matched >= 2 ||
          this.holdsAny(s, x, rare);
      if (this.deps.model && this.config.judgeTied) {
        const tying = spans?.open("judge.tied", cue.span);
        const tied = tiedBy(this.rareTerms(s, cue));
        const any = unsure.some(tied);
        if (tying) spans!.close(tying, { tied: any });
        if (!any) {
          done("silent", "judge: untied");
          return null;
        }
      }
      const reservation = this.deps.model ? this.charge(s) : null;
      if (!this.deps.model || !reservation) return noModel(this.deps.model ? "no model budget" : "no model", "");
      const candidates = unsure.map((x) => x.item);
      let res: Awaited<ReturnType<Model["chat"]>>;
      const building = spans?.open("judge.build", cue.span, { candidates: candidates.length });
      const messages = judgeMessages(
        s.window.join("\n"),
        candidates,
        this.config.probes,
        this.config.compactInjection ? focusOf(cue) : undefined,
        { windowChars: this.config.judgeWindowChars, itemBytes: this.config.judgeItemBytes },
      );
      if (building) spans!.close(building, { chars: messages.reduce((n, m) => n + m.content.length, 0) });
      const calling = spans?.open("model", cue.span, { async: true, role: "judge" });
      try {
        res = await this.deps.model.chat({
          messages,
          cacheKey: userCacheKey(s.scope),
          maxTokens: JUDGE_MAX_TOKENS,
          reasoning: "low",
          json: true,
          signal: s.abort.signal,
        });
      } catch {
        if (calling) spans!.close(calling, { error: true });
        this.settle(reservation, 0);
        if (s.closed) return null;
        // A failing model (bad key, spend limit, outage) is treated as no model, never worse than none (D41). The
        // reason keeps the cause, so a broken key does not look like a healthy keyless server in traces.
        return noModel("model error", ":model-error");
      }
      if (calling) spans!.close(calling, modelAttrs(res));
      modelCalls = 1;
      costUsd = res.costUsd;
      this.settle(reservation, res.costUsd);
      if (s.closed) return null;
      const parsing = spans?.open("judge.parse", cue.span);
      const picked = parseJudge(res.text, candidates.length)
        .slice(0, this.config.maxItemsPerInjection)
        .map((i) => unsure[i]!);
      if (parsing) spans!.close(parsing, { picked: picked.length });
      // A verdict cut off at the token cap is no verdict: the no-model path decides, as for a failing call (D41,
      // D45), rather than reading the cut-off text as "none".
      if (picked.length === 0 && res.truncated) return noModel("model truncated", ":model-truncated");
      if (picked.length === 0) {
        done("silent", "model: none");
        return null;
      }
      const was = new Map<string, LedgerEntry | undefined>();
      const sent = await this.withCompanions(s, cue, picked, scored, was, (n) => {
        sourceCalls += n;
      });
      done(
        "model",
        cue.id,
        sent.map((x) => x.item),
      );
      return await this.deliverChecked(s, sent, "proactive", `model:${cue.id}`, cue, was);
    } catch {
      // A failing source map or cache never escapes as an unhandled rejection; the lookup just ends silent.
      done("silent", "error");
      return null;
    }
  }

  /**
   * `cards`: the user's cached items whose implication card (`cards.ts`) bears on the request: an action of the
   * request's, and a party it names when the card binds one. Only cards made before the request arrived count: the
   * enrichment runs in the background, so a card made during this lookup lands at a later one (D4). No model, no call:
   * a classification by fixed lexicons and a pass over the user's carded items (at most `maxCardsPerUser` twice).
   */
  private cardFinds(s: Session, cue: Cue): Map<string, CardFind> {
    const out = new Map<string, CardFind>();
    const enricher = this.deps.cards;
    if (!this.config.cards || !enricher) return out;
    const actions = requestActions(cue.raw);
    if (actions.size === 0) return out;
    const now = this.now();
    const ids = enricher.carded(s.scope).filter((id) => this.deps.cache.get(s.scope, id, now) !== null);
    const frame = this.frame(cue);
    for (const [id, card] of enricher.cardsOf(s.scope, ids, cue.arrived ?? now)) {
      const m = cardVerdict(card, frame, actions);
      if (m) out.set(id, { ...m, spanDays: spanDays(card) });
    }
    // Bounded: the best matches only, so a user with many constraint cards never floods the candidates.
    return new Map([...out].sort((a, b) => cardRank(b[1]) - cardRank(a[1])).slice(0, MAX_CARD_FINDS));
  }

  /**
   * `intent` (D87, docs/research/edge-intent.md): the user's cached items whose requests, written by the card call in
   * the background, best match the request, best first: item id → its place (0-based) and match. A hit holds at least
   * `intentMinMatched` of the request's terms and `intentMinCoverage` of their idf; at most `intentHits` items
   * (`keepIntents`, intent.ts; `intentByKind` treats constraint-carded hits apart, D200). Only requests made before the
   * request arrived count (as for cards). No model, no call: one BM25 search over the user's requests (at most four
   * per carded item).
   */
  protected intentFinds(s: Session, cue: Cue): Map<string, IntentFind> {
    const enricher = this.deps.cards;
    if (!this.config.cards || !this.config.intent || !enricher) return new Map();
    const now = this.now();
    const c = this.config;
    // The request as written (redacted), not its content terms: the requests the model wrote are whole sentences in
    // the user's words, verbs included ("approve", "book"), which the cue's terms may leave out.
    const cut = intentCut(c);
    const text = intentQuery(cue);
    const accept = (id: string) => this.deps.cache.get(s.scope, id, now) !== null;
    const found = enricher.intentFinds(s.scope, text, cue.arrived ?? now, c.intentHits, accept);
    // `intentByKind`: a second, deeper search for the carded pass only (`intentReach`, intent.ts, says why apart).
    const reach = intentReach(cut);
    const deep = reach > 0 ? enricher.intentFinds(s.scope, text, cue.arrived ?? now, reach, accept) : found;
    return keepIntents(found, cut, deep);
  }

  /**
   * `intent`: the hits (`intentFinds`) that count as intent hits: eligible, a judge seat (`intentSeats`), a tie
   * (`judgeTied`), fused into an ask. The model writes an item's requests from the item's own text, so an inbound
   * message can word itself to be matched by most requests ("reply to the email", "approve the payment"). A hit counts
   * only when its item also holds a card, whose words the anchor check tied to the item (`anchored`), or when its
   * requests hold one of the request's rare words (fewer than `judgeTiedShare` of the user's items hold it, or none):
   * a request in words common to the user's mail ("reply", "email", "meeting") is no anchor, a name, a thing or a
   * verb the mail rarely uses is ("savings", "laptop"). Any other hit stays a candidate as the ranking found it.
   * Re-ranked from 0. No model, no call.
   */
  protected anchoredIntents(s: Session, cue: Cue, found: ReadonlyMap<string, IntentFind>): Map<string, IntentFind> {
    const out = new Map<string, IntentFind>();
    const enricher = this.deps.cards;
    if (found.size === 0 || !enricher) return out;
    const before = cue.arrived ?? this.now();
    const cards = enricher.cardsOf(s.scope, found.keys(), before);
    const rare = new Set<string>();
    for (const w of intentQuery(cue)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (w.length < 3 || isStopword(w)) continue;
      if (this.deps.cache.isRare(s.scope, w, this.config.judgeTiedShare)) rare.add(stemWord(w));
    }
    for (const [id, f] of found) {
      const carded = (cards.get(id)?.kind ?? "none") !== "none";
      const tied = () => intentTerms(enricher.requestsOf(s.scope, id, before).join("\n")).some((t) => rare.has(t));
      if (carded || tied()) out.set(id, { ...f, rank: out.size });
    }
    return out;
  }

  /**
   * The request's words (cue and entities, stopwords out) that fewer than `judgeTiedShare` of the user's items hold:
   * a name, a reference, a place, rather than words common to their mail. Ids in the user's cache vocabulary; a word
   * no cached item holds has no id and so ties nothing (`judgeTied`).
   */
  private rareTerms(s: Session, cue: Cue): number[] {
    const vocab = this.deps.cache.peekVocab(s.scope);
    if (!vocab) return [];
    const q = termIds(`${cue.text} ${cue.entities.join(" ")}`, vocab, false);
    const out: number[] = [];
    for (let i = 0; i < q.n; i++) {
      const id = q.ids[i]!;
      const word = vocab.term(id);
      if (isStopword(word) || out.includes(id)) continue;
      if (this.deps.cache.isRare(s.scope, word, this.config.judgeTiedShare)) out.push(id);
    }
    return out;
  }

  /** Whether the cached item `x` was ranked from holds one of `terms` (whole terms, the cache's index). */
  private holdsAny(s: Session, x: Scored, terms: readonly number[]): boolean {
    if (x.doc === undefined) return false;
    for (const id of terms) if (this.deps.cache.containsAll(s.scope, x.doc, [id], 1)) return true;
    return false;
  }

  private charge(s: Session, usd = this.config.estimatedCallUsd): Reservation | null {
    return this.deps.budget.reserve(scopeKey(s.scope), s.key, usd);
  }

  /**
   * Books a call's real cost against the session and day it was charged to. A session that ended mid-call already
   * dropped its tally (`close`), so only the user's day is corrected; a new session reusing the id is not touched.
   */
  private settle(r: Reservation, actualUsd: number): void {
    this.deps.budget.settle(r, actualUsd);
  }

  /**
   * How an ask's answer is rendered. Not compacted, it says each item whole; `compactAsk` cuts each item to what
   * bears on the question as a packet's are, and `askDedup` says an item this session already showed by what is new
   * in it, or by its title alone.
   */
  protected answering(s: Session, cue: Cue): Parameters<typeof renderPacket>[1] {
    const shown = this.config.askDedup ? s.shown : undefined;
    const compact = this.config.compactAsk;
    const dense = compact && this.config.densePacket;
    return {
      maxBytes: 4_000,
      ...(compact
        ? {
            focus: focusOf(cue),
            itemBytes: this.config.askItemBytes,
            // No `year`: an answer's dates stay as the source wrote them, as they did whole ("9 Oct 2026").
            self: this.deps.cache.selfOf(s.scope),
            dense,
          }
        : {}),
      ...(shown ? { shownBefore: (item: ContextItem) => shown.get(shownKey(item)) } : {}),
      ...(this.config.compactParts ? { split: true } : {}),
    };
  }

  /**
   * `source` with each call it answers recorded as a span under `parent` (spans on only): a `source.search` or
   * `source.fetch` span per call that reaches the connector, so a planner's several calls and a probe's are each seen.
   * The connector id, the page size and whether it failed: never the query. A call the fan-out answers from its cache
   * never reaches this, and has no span.
   */
  private traced(source: Source, parent: number): Source {
    const spans = this.spans!;
    const fetch = source.fetch?.bind(source);
    return {
      id: source.id,
      kind: source.kind,
      description: source.description,
      ...(source.listsByTime !== undefined ? { listsByTime: source.listsByTime } : {}),
      ...(source.notifies !== undefined ? { notifies: source.notifies } : {}),
      ...(source.callPriced !== undefined ? { callPriced: source.callPriced } : {}),
      ...(source.fetchReportsGone !== undefined ? { fetchReportsGone: source.fetchReportsGone } : {}),
      ...(source.fetchesById !== undefined ? { fetchesById: source.fetchesById } : {}),
      // A listing (the sync, D57) is traced by the sync itself (`sync.list`): passed through as it is.
      ...(source.list ? { list: source.list.bind(source) } : {}),
      // One `then`, no async frame of its own: a source call is the most frequent span (tracing overhead).
      search: (query, signal) => {
        const sp = spans.open("source.search", parent, { async: true, source: source.id, window: !!query.window });
        const failed = (e: unknown): never => {
          spans.close(sp, { error: true });
          throw e;
        };
        let pending: Promise<ContextItem[]>;
        try {
          pending = source.search(query, signal);
        } catch (e) {
          return Promise.reject(e).catch(failed);
        }
        return pending.then((page) => {
          if (page && typeof page === "object") spans.page(page, sp.id);
          spans.close(sp, { items: Array.isArray(page) ? page.length : 0 });
          return page;
        }, failed);
      },
      ...(fetch
        ? {
            fetch: async (ref: string, scope: Scope, signal: AbortSignal) => {
              const sp = spans.open("source.fetch", parent, { async: true, source: source.id });
              try {
                const item = await fetch(ref, scope, signal);
                // The fan-out gates `[item]`, a new array: the item names the call.
                if (item) spans.page(item, sp.id);
                spans.close(sp, { items: item ? 1 : 0 });
                return item;
              } catch (e) {
                spans.close(sp, { error: true });
                throw e;
              }
            },
          }
        : {}),
    };
  }
}

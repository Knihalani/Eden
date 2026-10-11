import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { assembleNotes, listUnderHeading, splitNumberedItems } from "./assemble";
import { noteSleepActivity, scheduleIncrementalSleep } from "./sleep";
import { ChunkStore } from "./chunk-store";
import { retrieveNarrativeChunks } from "./chunk-retrieve";
import * as howtoRetrieve from "./howto-retrieve";
import { IclIndex, retrieveIcl } from "./icl-index";
import { routeMemory } from "./memory-router";
import { memoryConsent } from "./memory-consent";
import { opaqueId, scrubMemoryText } from "./memory-scrub";
import { type MemoryLaneKind } from "./memory-lanes";
import {
  INTENT_TTL_MS,
  overturnable,
  ruleIdentity,
  ruleRefs,
  rulesIn,
  withoutExcludedWording,
  type Rule,
  type RuleRef,
} from "./memory-policy";
import { isIclExemplar, objectAsserted, SemanticStore } from "./semantic-store";
import { stripPastes, withoutInstructions, type TextSource } from "./memory-authority";
import { applyProvenanceLabel, isUntyped, stripPacketLabel } from "./memory-provenance";
import { logMemoryNotes } from "./memory-log";
import { legacySlot } from "./memory-residual";
import { counteredKeys, isForget, recordSupersession, validText, type Invalidation } from "./memory-validity";
import { memoryNow } from "./memory-clock";
import { appendPending, claimSeqs, compareRecency, takePending, ulid, type DiskRow } from "./memory-ids";
import { markStoreFormat, readableStore, storeFor } from "./memory-repo";
import { firedClasses, triggeredRows } from "./memory-triggers";
import { writeRuleIndex } from "./memory-rule-index";
import { childSessionName, memorySessionName } from "./memory-session";
import {
  attachPlaceCues,
  hookLane,
  isNoopCue,
  parseRuleTime,
  placePathsFrom,
  stripMemoryPacket,
  writeAliasTags,
  WRITE_ALIASES,
  MEMORY_PACKET_MARK,
  MEMORY_PACKET_MARKS,
  PACKET_BYTE_CAP,
} from "./memory-sota";
import { placeTurnTails, WrapTurns, type InjectOptions } from "./memory-wrap";

export { childSessionName, memorySessionName };

export { injectedPackets, type InjectOptions } from "./memory-wrap";

export {
  attachPlaceCues,
  isNoopCue,
  packNotes,
  placePathsFrom,
  goldFirstNotes,
  PACKET_BULLET_MAX,
  PACKET_BYTE_CAP,
} from "./memory-sota";
/**
 * Tokens with M32: Harbor prompt Δ 150854 → 178613 (+27759) and total +26941 are agent traces.
 * No 89-task claim. No dual-API.
 */
export const PROCEDURE_TOKEN_CAP = 300;
export const PROCEDURE_CHAR_CAP = PROCEDURE_TOKEN_CAP * 4;
export const FACT_CHAR_CAP = PROCEDURE_CHAR_CAP;
export {
  EXPERIENCE_RETRIEVE_K,
  EXPERIENCE_RETRIEVE_K_MAX,
  EXPERIENCE_SLICE_CHAR_CAP,
  EXPERIENCE_SLICE_TOKEN_CAP,
} from "./experience-retrieve";
export { logMemoryNotes, memoryLogEnabled } from "./memory-log";
export { applyProvenanceLabel, relativeMemoryAge } from "./memory-provenance";
export { sleep } from "./sleep";
export const MEMORY_MARK = MEMORY_PACKET_MARK,
  memoryInjectSwallows = { n: 0 };

function sentenceParts(t: string): string[] {
  return t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

export function encodeLane(text: string): MemoryLaneKind {
  const t = String(text ?? "").trim();
  return !t
    ? "chat"
    : isIclExemplar(t)
      ? "icl"
      : t.length > 400 || (sentenceParts(t).length >= 2 && t.length >= 150)
        ? "narrative"
        : "chat";
}

function rankKindBoost(r: MemoryRecord): number {
  const k = String(r.kind ?? "");
  return k === "constraint" ? 50 : k === "procedure" ? 40 : k === "fact" || k === "preference" ? 25 : 0;
}

/** Notes as retrieval hands them on: each body capped and labelled with its kind and source. */
function labelledNotes(recs: MemoryRecord[]): MemoryRecord[] {
  try {
    return recs.map((r) => ({ ...r, text: applyProvenanceLabel(r, capMemoryBody(r, stripPacketLabel(r.text).body)) }));
  } catch {
    return recs;
  }
}

function capMemoryBody(r: MemoryRecord, body: string): string {
  const text = String(body ?? "");
  if (r.lane === "icl" || isIclExemplar(text)) return text;
  if (r.kind === "procedure") {
    const cap = Math.min(PROCEDURE_CHAR_CAP, Math.max(240, PACKET_BYTE_CAP - 180));
    return text.length <= cap ? text : text.slice(-cap);
  }
  return /\d+[.)]\s+\S/.test(text) || text.length <= FACT_CHAR_CAP ? text : text.slice(0, FACT_CHAR_CAP);
}

function omitConflictingIdentity(text: string, store: SemanticStore): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  const parts = sentenceParts(raw),
    units = parts.length ? parts : [raw],
    kept: string[] = [];
  for (const s of units) {
    try {
      const fact = objectAsserted(s);
      if (fact) {
        const live = store.get(fact.s, fact.p);
        if (live && live.o.trim().toLowerCase() !== fact.o.trim().toLowerCase()) continue;
        if (store.supersededObject(fact.o)) continue;
      }
    } catch {}
    kept.push(s);
  }
  return kept.join(" ").trim();
}

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;
/**
 * A row (A4 §1). On disk its time is `t`, and its validity `invalid_at` (the `seq` of the row that superseded it,
 * A4 §3.1), `invalid_by` (that row's id, while it waits in `pending.jsonl` for its seq) and `valid_until`.
 */
export type MemoryRecord = {
  id: string;
  text: string;
  kind: MemoryKind;
  tags?: string[];
  /** When the row was written (`memoryNow`); absent on rows written before P0.3, whose time was never kept. */
  at: number;
  /** The store's order (A4 §1); absent until the store lock gives it one, and on rows written before P0.3. */
  seq?: number;
  ep?: string;
  sal?: number;
  lane?: MemoryLaneKind;
  invalidAt?: number;
  invalidBy?: string;
  validUntil?: number;
  heat?: number;
  /** The transcript line the row came from, when there is one (A4 §1 `src_uuid`). */
  srcUuid?: string;
  /** The `promptId` of the turn the row was said in: a rewind that abandons the turn takes the row back (A4 §3.3). */
  promptId?: string;
  /** D9: the rules the row states, by key. */
  rules?: RuleRef[];
};

/** Whether a newer row has superseded this one (A4 §3.1). */
export function superseded(r: Pick<MemoryRecord, "invalidAt" | "invalidBy">): boolean {
  return typeof r.invalidAt === "number" || typeof r.invalidBy === "string";
}

/** Whether a row is in force: not superseded, and not past its `valid_until` (an intent's 7 days, D9). */
export function isLiveRow(r: MemoryRecord, now = memoryNow()): boolean {
  return !superseded(r) && !(typeof r.validUntil === "number" && Number.isFinite(r.validUntil) && r.validUntil <= now);
}

/** Whether two statements give one subject different values, so the newer supersedes the older (A4 §3.1). */
function contradicts(a: string, b: string): boolean {
  try {
    const one = objectAsserted(a),
      two = objectAsserted(b);
    const value = (o: string) => o.replace(/\s+/g, " ").toLowerCase();
    return !!one && !!two && one.s === two.s && one.p === two.p && value(one.o) !== value(two.o);
  } catch {
    return false;
  }
}

/** The subject a copula statement gives a value to (`s`, `p`), or undefined. */
function copulaKey(text: string): string | undefined {
  try {
    const asserted = objectAsserted(text);
    return asserted ? `${asserted.s}\0${asserted.p}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Of the retrieved rows giving one subject a value, the newest. A row the user did not type is an episode (A4 §3.0):
 * it competes with no statement, so a newer tool result or assistant claim never displaces what the user said.
 */
function liveCopulaLatest<T extends { rec: MemoryRecord }>(rows: T[]): T[] {
  const byKey = new Map<string, T>(),
    rest: T[] = [];
  for (const row of rows) {
    let a: ReturnType<typeof objectAsserted>;
    try {
      a = isUntyped(row.rec) ? undefined : objectAsserted(row.rec.text);
    } catch {
      a = undefined;
    }
    if (!a) {
      rest.push(row);
      continue;
    }
    const k = `${a.s}\0${a.p}`,
      prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, row);
      continue;
    }
    if (compareRecency(row.rec, prev.rec) >= 0) byKey.set(k, row);
  }
  return [...byKey.values(), ...rest];
}

export type ObserveOptions = {
  keepLiveIdentity?: boolean;
  deferSleep?: boolean;
  /**
   * The messages are a conversation read again (the hook reads its transcript at every event): what they say was
   * encoded when it was new, so they never re-learn a superseded value (`restated`).
   */
  reread?: boolean;
};

export type MemoryOptions = {
  dir?: string;
  project?: string;
  session?: string;
  cwd?: string;
  child?: boolean;
  /**
   * `dir` is one repo's store (D1, `memory-repo.ts`): every session and subagent of the repo writes its rows there.
   * The session still labels its rows (`ep`) and its gist, but has no directory of its own.
   */
  perRepo?: boolean;
};

type Compiled = { rec: MemoryRecord; needles: string[]; scorable: boolean };

const STOP = new Set([
  "the",
  "of",
  "is",
  "a",
  "an",
  "on",
  "to",
  "and",
  "in",
  "for",
  "this",
  "that",
  "with",
  "from",
  "into",
  "about",
  "these",
  "then",
  "still",
  "has",
  "out",
  "please",
  "how",
  "should",
  "what",
  "why",
  "was",
  "are",
  "you",
  "your",
  "its",
  "our",
  "not",
  "never",
  "use",
  "used",
  "just",
  "last",
  "week",
  "down",
  "look",
  "next",
  "need",
  "before",
  "merge",
  "prefers",
  "user",
  "memory",
  "ran",
  "fact",
  "such",
  "or",
  "no",
  "app",
  "where",
  "who",
  "whom",
  "whose",
  "does",
  "did",
  "which",
  "when",
]);

/** `relevant` scores a row of at most 12 needles; a longer one (a tool result, a narrative) never ranks there. */
const SCORABLE_NEEDLES = 12;

/**
 * A row with its needles, computed on first use: a narrative row can be tens of KB and most paths never ask. Whether
 * `relevant` can score it reads only as far as its 13th needle.
 */
function compileNeedles(rec: MemoryRecord): Compiled {
  let needles: string[] | undefined;
  let scorable: boolean | undefined;
  return {
    rec,
    get needles() {
      return (needles ??= [...new Set(needleWords(rec))]);
    },
    get scorable() {
      return (scorable ??= needles ? needles.length <= SCORABLE_NEEDLES : fewNeedles(rec));
    },
  };
}

function isNeedle(word: string): boolean {
  return (
    word.length >= 3 &&
    !STOP.has(word) &&
    !/^\d+$/.test(word) &&
    !/^[a-z]\d[a-z]$/.test(word) &&
    !/^[a-z]{3,}\d+[a-z]$/.test(word)
  );
}

/** A row's needles, with repeats: its tags, then its text's words. */
function* needleWords(rec: MemoryRecord): Generator<string> {
  for (const tag of rec.tags ?? []) if (isNeedle(tag)) yield tag;
  for (const [word] of rec.text.toLowerCase().matchAll(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g))
    if (isNeedle(word)) yield word;
}

/** Whether a row has at most `SCORABLE_NEEDLES` distinct needles, read no further than the next one. */
function fewNeedles(rec: MemoryRecord): boolean {
  const seen = new Set<string>();
  for (const word of needleWords(rec)) if (seen.add(word).size > SCORABLE_NEEDLES) return false;
  return true;
}

export function queryHay(text: string): Set<string> {
  return new Set(((s) => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(text));
}

const TOOL_ROLES = new Set(["tool", "function"]),
  TOOL_BLOCKS = new Set(["tool_result", "tool_use", "function_call", "function_result"]);

function convBlob(list: unknown[]): string {
  if (list.length === 1) {
    const o = list[0] as Record<string, unknown> | undefined;
    if (TOOL_ROLES.has(String(o?.role ?? "").toLowerCase())) return "";
    if (typeof o?.content === "string" && !(o.reasoning_content || o.thinking || o.reasoning)) return o.content;
  }
  const parts: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>,
      c = o.content ?? o.llmContent,
      role = String(o.role ?? "").toLowerCase();
    if (TOOL_ROLES.has(role)) continue;
    if (typeof c === "string" && c) parts.push(c);
    else if (
      Array.isArray(c) ||
      Array.isArray(o.parts) ||
      (c && typeof c === "object" && Array.isArray((c as Record<string, unknown>).parts))
    ) {
      for (const b of Array.isArray(c)
        ? c
        : Array.isArray(o.parts)
          ? (o.parts as unknown[])
          : ((c as Record<string, unknown>).parts as unknown[])) {
        if (b && typeof b === "object") {
          const type = String((b as Record<string, unknown>).type || "").toLowerCase();
          if (TOOL_BLOCKS.has(type)) continue;
          const t = ["text", "content", "llmContent", "value"]
            .map((k) => (b as Record<string, unknown>)[k])
            .find((v) => typeof v === "string" && v);
          if (t) parts.push(t as string);
        }
      }
    }
    const r = o.reasoning_content ?? o.thinking ?? o.reasoning;
    if (typeof r === "string" && r) parts.push(r);
  }
  return parts.join("\n");
}

/** The text of the last message the user sent, packets aside: what the cue is read from. */
function lastUserText(list: unknown[]): string {
  const m = Array.isArray(list)
    ? list.findLast((x) => {
        if (!x || typeof x !== "object") return false;
        const role = String((x as { role?: unknown }).role ?? "").toLowerCase();
        if (role === "system") return false;
        const text = convBlob([x]).trim();
        const packet = MEMORY_PACKET_MARKS.some((mark) => text.startsWith(mark));
        return !!text && !packet && (role === "user" || role === "human");
      })
    : undefined;
  return m && typeof m === "object" ? convBlob([m]).trim() : "";
}

/**
 * The user's own words in the last message: the `src: "user"` text of `encode` when the caller split the prompt by
 * D12 (`promptMessages`, with recent tool results), else the message without its marked pastes, fences and quotes.
 */
function typedText(list: unknown[], encode?: unknown[]): string {
  if (!encode?.length) return stripPastes(lastUserText(list));
  return encode
    .filter((m) => (m as { src?: unknown } | undefined)?.src === "user")
    .map((m) => convBlob([m]))
    .join("\n");
}

export function cueFor(list: unknown[]): string {
  const raw = lastUserText(list);
  if (!raw) return "";
  const paras = raw
      .split(/\n\n/)
      .map((p) => p.trim())
      .filter(Boolean),
    ask = (p: string) => p.length <= 280 || /[?？]$/.test(p);
  return ask(paras.at(-1)!) ? paras.at(-1)! : ask(paras[0]!) ? paras[0]! : paras.at(-1)!;
}

const CHAT = new RegExp(
  String.raw`^(ok|okay|thanks|thank you|got it|sure|yeah|yep|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|` +
    String.raw`nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|` +
    String.raw`yup|thx|ttyl|smh|wfm|idc|ngl|fr|ikr|meh|ugh|welp|yikes|oops|huh)\b`,
  "i",
);
const ACK_PREFIX = new RegExp(
  String.raw`^(?:(?:please\s+remember|remember(?:\s+that)?|got it|understood` +
    String.raw`(?:[,']?\s*I'?ll follow that)?|for reference|fyi|heads up|one rule(?:\s+for\s+this\s+repo)?|` +
    String.raw`going forward)[:,!.]?\s+)+`,
  "i",
);
const SPEAKER_LABEL = /^([A-Z][A-Za-z0-9 /._-]{1,32}:)(?=\s)/;

function extractDurable(blob: string): string[] {
  const seen = new Set<string>(),
    out: string[] = [];
  let whole = blob.trim().replace(/\s+/g, " ").replace(ACK_PREFIX, "");
  if (SPEAKER_LABEL.test(whole) && whole.endsWith("?") && /[.!]/.test(whole.slice(0, -1)))
    whole = whole.replace(/\s+[^.!?]+\?\s*$/, "").trim();
  const listed = listUnderHeading(blob),
    labeledWhole = !listed && SPEAKER_LABEL.test(whole) && whole.length <= 800 && !whole.endsWith("?"),
    numberedWhole = /^\d+[.)]\s+\S/.test(whole),
    label = listed ? undefined : whole.match(SPEAKER_LABEL)?.[1];
  const chunks = listed
    ? listed
    : labeledWhole
      ? [whole]
      : numberedWhole
        ? splitNumberedItems(whole)
        : blob
            .replace(ACK_PREFIX, "")
            .split(/(?:(?<=\n)|(?<=[.!?])(?<!\d\.))\s+/)
            .flatMap((p) => p.split(/(?<=\d\.)\s+(?=[A-Z])/));
  for (const raw of chunks) {
    let t = raw
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^(i think|i believe|i guess|maybe|perhaps|tbh|imo)\s+/i, "")
      .replace(ACK_PREFIX, "");
    if (
      t.length < 8 ||
      t.length > (labeledWhole ? 800 : 400) ||
      t.startsWith("{") ||
      t.startsWith("[") ||
      t.startsWith("http") ||
      t.startsWith("#") ||
      /^(const|let|import |export |function )\b/.test(t) ||
      MEMORY_PACKET_MARKS.some((mark) => t.includes(mark)) ||
      t.includes("Eden Know:") ||
      CHAT.test(t) ||
      /qx\d+z/i.test(t)
    )
      continue;
    if (label && !SPEAKER_LABEL.test(t)) t = `${label} ${t}`;
    const rem = /\b(?:don'?t|do not|never)\s+remember\b/i.test(t) ? null : t.match(/\bremember(?: that)?\s+(.+)/i);
    if (rem) t = rem[1]!.trim();
    t = t.replace(/^[.\s]+|[.\s]+$/g, "");
    if (SPEAKER_LABEL.test(t)) {
      const sp = new Set(
        ((s) => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(
          (t.match(SPEAKER_LABEL)?.[1] || "").replace(/:$/, ""),
        ),
      );
      if (
        !((s) => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(t).some(
          (w) => !sp.has(w) && (w.length >= 5 || /^\d/.test(w)) && !STOP.has(w),
        )
      )
        continue;
    }
    if (t.length >= 8 && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/**
 * A statement that pins itself, unless it says not to remember: "remember that …", or D9's explicit policy (`never`
 * or `always` on an action class). An intent never pins (D9). A text with no rule on an action class keeps the legacy
 * reading, where any "always …" pins.
 */
function pinsItself(text: string, rules: readonly Rule[] = rulesIn(text)): boolean {
  if (/\b(?:don'?t|do not|never)\s+remember\b/i.test(text)) return false;
  if (rules.length && rules.every((rule) => rule.kind === "intent")) return false;
  if (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(text)) return true;
  return rules.length ? rules.some((rule) => rule.kind === "policy" && rule.explicit) : /\balways\s+\S/i.test(text);
}

/**
 * What a restatement is matched by: a copula's subject, or a rule's own text (D9), so a rule typed again after it was
 * overturned is learned again (`restated`).
 */
function restatementKey(text: string): string | undefined {
  return copulaKey(text) ?? (rulesIn(text).length ? `rule:${text.toLowerCase()}` : undefined);
}

/** The legacy store's rule words, for a rule on no action class ("always explain plainly"). */
const LEGACY_RULE = /\b(prefer|never |always |don'?t |do not |must |from now on)\b/i;

const TEXT_SOURCES = new Set<string>(["user", "paste", "tool", "agent"]);

/** A message as `observe` encodes it: its role, its source (A6 §2.1) and its text, whitespace collapsed. */
/** Where a message came from, when the caller knows: its transcript line, that line's time and turn (A4 §3.3). */
type MessageOrigin = { at?: number; srcUuid?: string; promptId?: string };

type ObservedItem = { role: string; src?: TextSource; untyped: boolean; text: string; origin: MessageOrigin };

/**
 * A message's source: the one its caller marks (`src`), else `agent` for the assistant's text; a user message with
 * no mark (another host, an import) has no known source. Text the user did not type loses its instructions and its
 * claims for the user before it is stored (A6 §2.3, §2.6).
 */
function observedItem(message: unknown): ObservedItem {
  const fields =
    message && typeof message === "object"
      ? (message as { role?: unknown; src?: unknown; at?: unknown; uuid?: unknown; promptId?: unknown })
      : {};
  const role = String(fields.role || "user");
  const marked =
    typeof fields.src === "string" && TEXT_SOURCES.has(fields.src) ? (fields.src as TextSource) : undefined;
  const src = marked ?? (role === "assistant" ? "agent" : undefined);
  const untyped = src !== undefined && src !== "user";
  const raw = convBlob([message]).trim();
  const origin: MessageOrigin = {
    ...(finite(fields.at) === undefined ? {} : { at: finite(fields.at) }),
    ...(typeof fields.uuid === "string" && fields.uuid ? { srcUuid: fields.uuid } : {}),
    ...(typeof fields.promptId === "string" && fields.promptId ? { promptId: fields.promptId } : {}),
  };
  const text = (untyped ? withoutInstructions(raw) : raw).trim().replace(/\s+/g, " ");
  return { role, src, untyped, text, origin };
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * A store file's row as a record: A4 §1's `t`, `seq`, `invalid_at`, `invalid_by`, `valid_until`, `src_uuid` and
 * `prompt_id` mapped in.
 */
function fromDisk(parsed: unknown): MemoryRecord | undefined {
  if (Array.isArray(parsed)) return { id: parsed[0], text: parsed[1], at: parsed[2], kind: "episode" };
  if (!parsed || typeof parsed !== "object") return undefined;
  const { t, seq, invalid_at, invalid_by, valid_until, src_uuid, prompt_id, ...rest } = parsed as Record<
    string,
    unknown
  >;
  const rec = { ...rest, kind: rest.kind || "fact" } as MemoryRecord;
  const at = finite(t),
    order = finite(seq),
    invalidAt = finite(invalid_at),
    validUntil = finite(valid_until);
  if (at !== undefined) rec.at = at;
  if (order !== undefined) rec.seq = order;
  if (invalidAt !== undefined) rec.invalidAt = invalidAt;
  if (typeof invalid_by === "string") rec.invalidBy = invalid_by;
  if (validUntil !== undefined) rec.validUntil = validUntil;
  if (typeof src_uuid === "string") rec.srcUuid = src_uuid;
  if (typeof prompt_id === "string") rec.promptId = prompt_id;
  return rec;
}

/** A record as its store file holds it. A row written before P0.3 that is a bare episode keeps its compact form. */
function toDisk(r: MemoryRecord): DiskRow | [string, string] {
  const { at, seq, invalidAt, invalidBy, validUntil, srcUuid, promptId, ...rest } = r;
  const bare = !r.tags && !r.lane && !r.ep && !r.heat && !r.sal && invalidAt === undefined && invalidBy === undefined;
  if (r.kind === "episode" && bare && at === undefined && seq === undefined && validUntil === undefined)
    return [r.id, r.text];
  return {
    ...rest,
    kind: r.kind === "fact" ? undefined : r.kind,
    t: at,
    seq,
    invalid_at: invalidAt,
    invalid_by: invalidBy,
    valid_until: validUntil,
    src_uuid: srcUuid,
    prompt_id: promptId,
  };
}

/** One store file's rows, the last line of an id winning. */
export function storeRows(path: string): MemoryRecord[] {
  return load(path).map((c) => c.rec);
}

function load(path: string): Compiled[] {
  const out: Compiled[] = [],
    idx = new Map<string, number>();
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const t of raw.split("\n")) {
    try {
      const rec = fromDisk(JSON.parse(t));
      if (rec?.id && rec.text) {
        const c = compileNeedles(rec),
          at = idx.get(rec.id);
        if (at != null) out[at] = c;
        else (idx.set(rec.id, out.length), out.push(c));
      }
    } catch {}
  }
  return out;
}

/**
 * `kept` with the store's `seq` when it has one, superseded if either copy is: validity only ever moves from live to
 * superseded, so a stale copy cannot undo another process's supersession.
 */
function withValidity(kept: MemoryRecord, stored: MemoryRecord, other: MemoryRecord): MemoryRecord {
  const merged = { ...kept, seq: stored.seq ?? other.seq };
  const invalidAt = [stored.invalidAt, other.invalidAt].filter((v): v is number => typeof v === "number");
  if (invalidAt.length) {
    merged.invalidAt = Math.min(...invalidAt);
    delete merged.invalidBy;
  } else merged.invalidBy = stored.invalidBy ?? other.invalidBy;
  if (merged.invalidBy === undefined) delete merged.invalidBy;
  return merged;
}

/** The record to keep for a row two writers hold: this process's, with the stored copy's seq and validity merged. */
function mergeRow(disk: MemoryRecord | undefined, mine: MemoryRecord): MemoryRecord {
  return disk ? withValidity(mine, disk, mine) : mine;
}

/**
 * Settles pending rows into a store file under its lock: new ids are appended; a pending copy of a stored row brings
 * its seq and validity. A pending row got its seq late, after rows written later, so time decides between it and a
 * stored row giving its subject another value (`supersedeByTime`). Every `invalid_by` naming a row with a seq then
 * becomes that seq. Throws when the lock stays taken.
 */
function settleIntoStore(root: string, path: string, rows: readonly MemoryRecord[]): void {
  withFileLock(`${path}.lock`, () => {
    const byId = new Map(load(path).map((c) => [c.rec.id, c.rec]));
    // A pending copy of a row the store already holds brings only its seq and validity: the stored row may have
    // changed since (sleep's rewrites), and the copy is older.
    for (const row of rows) {
      const stored = byId.get(row.id);
      byId.set(row.id, stored ? withValidity(stored, stored, row) : row);
    }
    const stored = [...byId.values()];
    supersedeByTime(root, stored, new Set(rows.map((row) => row.id)));
    writeStore(path, resolveSupersessions(stored));
  });
}

/**
 * Of two live typed rows giving one subject different values, one of them settled, the later supersedes the other,
 * and older text giving the old value is stale (D31), as when a writer supersedes (`invalidateSameCopula`).
 */
function supersedeByTime(root: string, stored: readonly MemoryRecord[], settled: ReadonlySet<string>): void {
  const live = () => stored.filter((r) => !superseded(r) && !isUntyped(r));
  for (const row of live().filter((r) => settled.has(r.id)))
    for (const other of live()) {
      if (other === row || superseded(row) || !contradicts(row.text, other.text)) continue;
      const [older, newer] = (other.at ?? 0) > (row.at ?? 0) ? [row, other] : [other, row];
      older.invalidBy = newer.id;
      const slot = legacySlot(older);
      if (slot && legacySlot(newer)) recordSupersession(root, slot, newer.at);
    }
}

/** `invalid_by` → `invalid_at` wherever the superseding row has its seq. */
function resolveSupersessions(rows: MemoryRecord[]): MemoryRecord[] {
  const seqs = new Map(rows.flatMap((r) => (typeof r.seq === "number" ? [[r.id, r.seq] as const] : [])));
  return rows.map((r) => {
    const seq = r.invalidBy === undefined ? undefined : seqs.get(r.invalidBy);
    if (seq === undefined) return r;
    const { invalidBy: _resolved, ...rest } = r;
    return { ...rest, invalidAt: seq };
  });
}

function writeStore(path: string, rows: readonly MemoryRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, rows.map((r) => JSON.stringify(toDisk(r))).join("\n") + (rows.length ? "\n" : ""));
  try {
    chmodSync(path, 0o600);
  } catch {}
}

/**
 * Sleep's half of A4 §1: the rows writers left in `pending.jsonl` get their `seq` and go into their stores. A store
 * that cannot be written keeps them pending for the next sleep.
 */
export function settlePendingRows(root: string): void {
  const taken = takePending(root);
  if (!taken) return;
  let stored = true;
  for (const [store, rows] of taken.byStore) {
    const name = memorySessionName(store);
    if (store && !name) continue;
    try {
      settleIntoStore(
        root,
        join(root, name ?? "", "memories.jsonl"),
        rows.flatMap((row) => fromDisk(row) ?? []),
      );
    } catch {
      stored = false;
    }
  }
  if (stored) taken.done();
}

const STATUS_OBJECT = new RegExp(
  String.raw`\b(?:failing|broken|down|flaky|crashing|hanging|erroring|working|ready|live|dead|ok|fine|` +
    String.raw`slow|errors?|offline|unavailable)\b`,
  "i",
);

export const PACKET_CHAT_K_MIN = 6,
  PACKET_CHAT_K_MAX = 10,
  PACKET_CHAT_K_DEFAULT = PACKET_CHAT_K_MIN;

export function memoryRetrieveCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_CAP);
  return !Number.isFinite(raw) || raw <= 0
    ? PACKET_CHAT_K_MIN
    : Math.min(PACKET_CHAT_K_MAX, Math.max(PACKET_CHAT_K_MIN, Math.floor(raw)));
}

export function memoryStoreCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_STORE_CAP);
  return !Number.isFinite(raw) || raw <= 0 ? 2000 : Math.floor(raw);
}

function mergeNarrativeLane(
  lexical: MemoryRecord[],
  text: string,
  cap: number,
  dir: string,
  compiled: MemoryRecord[] = [],
): MemoryRecord[] {
  const q = String(text ?? "").trim();
  if (!q) return lexical;
  const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0))),
    hits = retrieveNarrativeChunks(dir, q, { k, fallback: compiled }),
    chat = lexical.filter((l) => l.lane !== "narrative" && !(l.tags ?? []).includes("chunk"));
  if (!hits.length) return chat.length ? chat : lexical;
  const chunks: MemoryRecord[] = [];
  for (const hit of hits) {
    const body = String(hit?.text ?? "").trim();
    if (body)
      chunks.push({
        id: hit.id || `chunk:${hit.src || "anon"}:${chunks.length}`,
        text: body,
        kind: "episode",
        lane: "narrative",
        tags: ["chunk"],
        at: Number.isFinite(hit.t) ? hit.t : 0,
      });
  }
  if (!chunks.length) return chat.length ? chat : lexical;
  const out: MemoryRecord[] = [];
  for (const c of [...chunks, ...chat]) {
    if (out.length >= cap) break;
    if (out.some((p) => p.id === c.id)) continue;
    out.push(c);
  }
  return out;
}

function mergeIclLane(text: string, cap: number, dir: string, compiled: MemoryRecord[] = []): MemoryRecord[] {
  const q = String(text ?? "").trim();
  if (!q) return [];
  const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0))),
    hits = retrieveIcl(dir, q, { k, fallback: compiled });
  if (!hits.length) return [];
  const out: MemoryRecord[] = [],
    seen = new Set<string>();
  for (const hit of hits) {
    if (out.length >= cap) break;
    const body = String(hit?.text ?? "").trim(),
      id = hit.id || `icl:${out.length}`;
    if (!body || seen.has(id) || seen.has(body.toLowerCase())) continue;
    seen.add(id);
    seen.add(body.toLowerCase());
    out.push({ id, text: body, kind: "fact", lane: "icl", tags: ["icl"], at: Number.isFinite(hit.t) ? hit.t : 0 });
  }
  return out;
}

function howtoProcedureRecord(view: ReturnType<typeof howtoRetrieve.retrieveHowTo>[number]): MemoryRecord {
  const cue = typeof view.cue === "string" ? view.cue.trim() : "",
    files: string[] = [],
    add = (f: unknown) => {
      if (typeof f === "string" && f.trim() && !files.includes(f.trim())) files.push(f.trim());
    };
  if (Array.isArray(view.files)) for (const f of view.files) add(f);
  if (!files.length && Array.isArray(view.steps)) {
    for (const s of view.steps) {
      if (Array.isArray(s?.files)) for (const f of s.files) add(f);
      const args = s?.args;
      if (args) for (const k of ["path", "file", "filepath", "filename"] as const) add(args[k]);
    }
  }
  let verify = typeof view.verify === "string" ? view.verify.trim() : "";
  if (!verify && Array.isArray(view.steps)) {
    for (let i = view.steps.length - 1; i >= 0; i--) {
      const args = view.steps[i]?.args;
      if (!args) continue;
      for (const k of ["command", "cmd", "script"] as const) {
        const v = args[k];
        if (typeof v === "string" && v.trim()) {
          verify = v.trim();
          break;
        }
      }
      if (verify) break;
    }
  }
  let text = cue;
  if (files.length) text = text ? `${text} → ${files.join(" ")}` : files.join(" ");
  if (verify) text = text ? `${text} · verify: ${verify}` : `verify: ${verify}`;
  return { id: view.id, kind: "procedure", tags: ["howto", "procedure"], text, at: view.t };
}

function mergeHowtoLane(lexical: MemoryRecord[], text: string, cap: number, dir: string): MemoryRecord[] {
  const q = String(text ?? "").trim();
  if (!q || !/\bflake\b/i.test(q)) return lexical;
  const views = howtoRetrieve.retrieveHowTo(dir, q);
  if (!views.length) return lexical;
  const rec = howtoProcedureRecord(views[0]!);
  if (!/unknown:/i.test(rec.text)) rec.text = `${rec.text} · unknown: flake`;
  const kept = lexical.filter((l) => l.id !== rec.id).slice(0, Math.max(0, cap - 1));
  return [...kept, rec];
}

export class AgentMemory {
  readonly dir: string;
  readonly session?: string;
  readonly child: boolean;
  /** The wrap's turns and the messages it has encoded (`memory-wrap.ts`). */
  readonly turns = new WrapTurns();
  private scrubSession?: string;
  private scrubCwd?: string;
  /** The subdirectory the rows live in: the session's, or none in a per-repo store. */
  private readonly subdir: string;
  private readonly perRepo: boolean;
  private compiled: Compiled[];
  private path: string;
  private batch = 0;
  private dirty = false;
  private seenLower = new Set<string>();
  /** `seenLower` without end punctuation: an episode is not stored twice for a final period. */
  private seenKeys = new Set<string>();
  /** Every row's text exactly: a text a row already holds has passed the gate, which `observe` need not run again. */
  private stored = new Set<string>();
  private post: Map<string, Compiled[]> | null = null;
  /** The live rule rows (D9 keys), which triggers deliver; built with `post`. */
  private ruleRows: MemoryRecord[] = [];
  private knownIds = new Set<string>();
  /** Rows this process wrote that no store file holds yet. */
  private unsaved = new Set<string>();
  /** Rows this process left in `pending.jsonl`: sleep writes them, so this process never does. */
  private pended = new Set<string>();
  /** Rows this process superseded since it last wrote them. */
  private changed = new Set<string>();
  private sem?: SemanticStore;

  constructor(opts: MemoryOptions = {}) {
    this.scrubSession = typeof opts.session === "string" && opts.session ? opts.session : undefined;
    const cwdOpt = typeof opts.cwd === "string" && opts.cwd.trim() ? opts.cwd.trim() : undefined;
    const proj = typeof opts.project === "string" && opts.project.trim() ? opts.project.trim() : undefined;
    const pathy = !!proj && (proj.includes("/") || proj.includes("\\") || /^[A-Za-z]:/.test(proj));
    this.scrubCwd = cwdOpt || (pathy ? proj : undefined);
    mkdirSync((this.dir = opts.dir || join(homedir(), ".eden", "memory")), { recursive: true });
    const session = memorySessionName(opts.session);
    this.session = session;
    this.child = opts.child === true;
    this.subdir = opts.perRepo ? "" : (session ?? "");
    this.perRepo = opts.perRepo === true;
    if (this.perRepo && !this.sealed && memoryConsent() === "on")
      try {
        markStoreFormat(this.dir);
      } catch {}
    if (this.subdir) mkdirSync(join(this.dir, this.subdir), { recursive: true });
    this.path = join(this.dir, this.subdir, "memories.jsonl");
    this.compiled = load(this.path);
    this.knownIds = new Set(this.compiled.map((c) => c.rec.id));
    this.rebuildSeen();
  }

  /**
   * A per-repo store in a format this code does not know (EXECUTION §9): neither read nor written. Checked at every
   * use, so a long-lived process (the wrap) stops when a newer writer changes the format.
   */
  get sealed(): boolean {
    return this.perRepo && !readableStore(this.dir);
  }

  /** The consent this store runs under: `off` when it is sealed. */
  private consent(): ReturnType<typeof memoryConsent> {
    return this.sealed ? "off" : memoryConsent();
  }

  get jsonlDir(): string {
    return join(this.dir, this.subdir);
  }

  /** The memory root that holds context windows (A4 §1 `<root>/windows/`): above a per-repo store, else the store. */
  get windowsRoot(): string {
    return this.perRepo ? dirname(dirname(this.dir)) : this.dir;
  }

  /** The repo key of a per-repo store (D1), which prefixes the ledger's cids; none for another store. */
  get repoKey(): string | undefined {
    return this.perRepo ? basename(this.dir) : undefined;
  }

  private semantic(): SemanticStore {
    return (this.sem ??= new SemanticStore(this.dir));
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec);
  }

  /** A text as the store keeps it (`persistText`): secrets redacted, the session and paths scrubbed. */
  storableText(text: string): string {
    return this.persistText(text);
  }

  /** Every stored row passes here: D13's gate and the identifier scrub (`scrubMemoryText`). */
  private persistText(text: string): string {
    return scrubMemoryText(String(text ?? ""), { session: this.scrubSession, cwd: this.scrubCwd });
  }

  /** Stores one row. `origin` names the transcript line it came from, whose time is the row's (A4 §3.3). */
  remember(
    text: string,
    opts: {
      kind?: MemoryKind;
      tags?: string[];
      id?: string;
      pin?: boolean;
      lane?: MemoryLaneKind;
      origin?: MessageOrigin;
    } = {},
  ): MemoryRecord {
    const { at = memoryNow(), srcUuid, promptId } = opts.origin ?? {};
    const rec: MemoryRecord = {
      id: opts.id || ulid(at),
      text: this.persistText(String(text || "").trim()),
      kind: opts.kind || "fact",
      tags: (opts.tags || []).map((t) => String(t).toLowerCase()),
      at,
      ...(opts.lane ? { lane: opts.lane } : {}),
      ...(this.session ? { ep: opaqueId(this.session) } : {}),
      ...(srcUuid ? { srcUuid } : {}),
      ...(promptId ? { promptId } : {}),
    };
    try {
      if (this.consent() !== "on") return rec;
    } catch {
      return rec;
    }
    const untyped = isUntyped(rec);
    // D9: text the user did not type states no rule (A4 §3.0), and only a rule row carries its rules' keys. An episode
    // (the diary, D6) is never a pin: a prompt's own episode would otherwise brief a rule its rule row no longer holds.
    const stated = untyped ? [] : rulesIn(rec.text);
    const rules = rec.kind === "constraint" ? stated : [];
    const pin = !untyped && rec.kind !== "episode" && (opts.pin === true || pinsItself(rec.text, stated));
    if (pin && !rec.tags!.includes("pin")) rec.tags!.push("pin");
    rec.tags = writeAliasTags(rec.tags!, rec.text).filter((t) => {
      if (t.length < 3 || STOP.has(t) || /^\d+$/.test(t)) return false;
      if (t === "pin" || WRITE_ALIASES[t] || (opts.tags || []).some((x) => String(x).toLowerCase() === t)) return true;
      return Object.values(WRITE_ALIASES).some((a) => a.includes(t));
    });
    if (!rec.tags.length) delete rec.tags;
    try {
      const until = parseRuleTime(rec.text)?.until;
      if (typeof until === "number") rec.validUntil = until;
    } catch {}
    if (rules.length) {
      rec.rules = ruleRefs(rules);
      if (rules.every((rule) => rule.kind === "intent"))
        rec.validUntil = Math.min(rec.validUntil ?? Infinity, rec.at + INTENT_TTL_MS);
    }
    try {
      const fact = untyped ? undefined : objectAsserted(rec.text);
      if (fact && !STATUS_OBJECT.test(fact.o)) this.semantic().put(fact.s, fact.p, fact.o, rec.at);
    } catch {}
    const c = compileNeedles(rec),
      i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    try {
      this.invalidateSameCopula(rec);
    } catch {}
    try {
      this.supersedeRules(rec);
    } catch {}
    this.compiled.push(c);
    this.knownIds.add(rec.id);
    this.unsaved.add(rec.id);
    this.post = null;
    this.noteSeen(rec.text);
    return (this.flush(true), rec);
  }

  /**
   * Statements the user asked Eden to keep (`eden memory remember`, D11), each one row in the user's own words
   * (`src:user`): a rule row when it states a D9 rule, else of the kind given (a fact by default). The store is
   * written once for them all.
   */
  rememberTyped(statements: readonly { text: string; kind?: MemoryKind }[]): MemoryRecord[] {
    this.batch++;
    try {
      return statements.map(({ text, kind }) =>
        this.remember(text, {
          kind: rulesIn(this.persistText(text)).length ? "constraint" : kind || "fact",
          tags: ["src:user"],
        }),
      );
    } finally {
      this.batch--;
      this.flush(false);
    }
  }

  /**
   * L8 (A4 §3.1): a typed statement supersedes a rule row of an earlier prompt only by stating outright a policy of
   * the opposite polarity on its key, or by revoking it ("you can merge PRs yourself now"), and only when it counters
   * every rule the row states (`counteredKeys`). An intent supersedes no policy: "don't squash yet" leaves "always
   * squash" standing.
   */
  private supersedeRules(incoming: MemoryRecord): void {
    if (isUntyped(incoming)) return;
    const countered = new Set(counteredKeys(incoming.text));
    if (!countered.size) return;
    for (const c of this.compiled) {
      const row = c.rec;
      if (row.id === incoming.id || superseded(row) || isUntyped(row) || !row.rules?.length) continue;
      // A row of the same prompt is never overturned by it: "Don't merge PRs. Always merge PRs from dependabot."
      const samePrompt = (row.at ?? 0) >= incoming.at || (!!row.promptId && row.promptId === incoming.promptId);
      if (samePrompt || !row.rules.every((rule) => countered.has(ruleIdentity(rule)) && overturnable(rule))) continue;
      row.invalidBy = incoming.id;
      this.changed.add(row.id);
    }
  }

  /**
   * A newer statement of a copula's subject supersedes its older values (A4 §3.1), whatever list numbers they carry,
   * and when both are slots, older text giving the old value is stale (D31, `recordSupersession`). Only what the user
   * typed supersedes: a tool result or the assistant's text is an episode (A4 §3.0, A6 §2.1).
   */
  private invalidateSameCopula(incoming: MemoryRecord): void {
    if (isUntyped(incoming) || !copulaKey(incoming.text)) return;
    for (const c of this.compiled) {
      if (c.rec.id === incoming.id || superseded(c.rec) || !contradicts(c.rec.text, incoming.text)) continue;
      c.rec.invalidBy = incoming.id;
      this.changed.add(c.rec.id);
      const old = legacySlot(c.rec);
      if (old && legacySlot(incoming)) recordSupersession(this.dir, old, incoming.at);
    }
  }

  /**
   * A6 §3: the rows a typed forget leaves with nothing to say go to history, invalid at the store's next `seq` with
   * no successor (A4 §3.1). So reading the transcript again never learns them anew, and only a later typed statement
   * does (`restated`). A row that also says something else keeps it: at delivery it loses only the sentences naming
   * the value, as other sessions' rows and gists do, to the validity log the caller wrote.
   */
  forget(records: readonly Invalidation[]): void {
    const forgets = records.filter(isForget);
    if (!forgets.length) return;
    const named = this.compiled.filter((c) => !superseded(c.rec) && !validText(c.rec.text, 0, forgets));
    if (!named.length) return;
    const seq = claimSeqs(this.dir, 1) ?? Math.max(0, ...this.compiled.map((c) => c.rec.seq ?? 0));
    for (const c of named) {
      c.rec.invalidAt = seq;
      this.changed.add(c.rec.id);
    }
    this.post = null;
    this.flush(true);
  }

  /**
   * A4 §3.3: a rewind takes back what the abandoned turns said. Their rows go to history, invalid at the store's
   * next `seq` with no successor, as a forget's do. A row whose text the current branch says again (`restated`)
   * stays: the restatement found it already stored and wrote no row of its own.
   */
  abandon(promptIds: readonly string[], restated: readonly string[] = []): void {
    const gone = new Set(promptIds);
    const taken = this.compiled.filter((c) => c.rec.promptId && gone.has(c.rec.promptId) && !superseded(c.rec));
    if (!taken.length) return;
    const said = restated.map((text) => this.persistText(text).replace(/\s+/g, " ").toLowerCase());
    const named = taken.filter((c) => !said.some((text) => text.includes(c.rec.text.toLowerCase())));
    if (!named.length) return;
    const seq = claimSeqs(this.dir, 1) ?? Math.max(0, ...this.compiled.map((c) => c.rec.seq ?? 0));
    for (const c of named) {
      c.rec.invalidAt = seq;
      this.changed.add(c.rec.id);
    }
    this.post = null;
    this.flush(true);
  }

  private rebuildSeen() {
    this.seenLower = new Set();
    this.seenKeys = new Set();
    this.stored = new Set();
    this.post = null;
    for (const c of this.compiled) this.noteSeen(c.rec.text);
  }

  private noteSeen(text: string): void {
    const lower = text.toLowerCase();
    this.seenLower.add(lower);
    this.seenKeys.add(lower.replace(/[.!?]+$/g, ""));
    this.stored.add(text);
  }

  /**
   * The postings `relevant` ranks from: the live rows it can score (P0.6). A row of more than 12 needles never
   * ranks, so it neither fills the candidate pool nor counts in a term's df, and it is never tokenized whole: a
   * store's tool results made this index the Submit's cost that grew with the session. A live rule row with D9 keys
   * is a policy or an intent, which its classes' triggers deliver and word overlap never does (D18): it is kept
   * apart, in `ruleRows`.
   */
  private ensureIndex() {
    if (this.post) return;
    const post = new Map<string, Compiled[]>();
    const ruleRows: MemoryRecord[] = [];
    for (const c of this.compiled) {
      if (!isLiveRow(c.rec)) continue;
      if (c.rec.rules?.length) ruleRows.push(c.rec);
      else if (c.scorable)
        for (const w of c.needles) {
          let arr = post.get(w);
          if (!arr) post.set(w, (arr = []));
          arr.push(c);
        }
    }
    this.post = post;
    this.ruleRows = ruleRows;
  }

  /**
   * The policies and intents the classes the user's own words fire deliver (A4 §5.1 step 4b, `memory-triggers.ts`):
   * `own` is the text D12 left the user, without pasted spans or spans copied from a recent tool result.
   */
  private triggered(own: string): MemoryRecord[] {
    try {
      const classes = firedClasses(own);
      if (!classes.length) return [];
      this.ensureIndex();
      return labelledNotes(triggeredRows(this.ruleRows, classes));
    } catch {
      return [];
    }
  }

  /** Encodes messages (`ObserveOptions`). */
  observe(messages: unknown[], opts: ObserveOptions = {}): MemoryRecord[] {
    try {
      if (this.consent() !== "on") return [];
    } catch {
      return [];
    }
    this.batch++;
    try {
      const list = (Array.isArray(messages) ? messages : []).filter(
          (m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system",
        ),
        out: MemoryRecord[] = [],
        items = list.map(observedItem).filter((i) => i.text),
        srcTags = (it: ObservedItem): string[] => (it.src ? [`src:${it.src}`] : []),
        batchLive = new Map<string, string>(),
        lanes = items.map((it) => encodeLane(it.text)),
        durables = items.map((it, i) => (lanes[i] === "icl" || lanes[i] === "narrative" ? [] : this.durables(it.text))),
        // Where the user last typed a statement about each subject: the only place a restatement can be.
        lastTyped = new Map<string, string>();
      durables.forEach((texts, i) => {
        if (items[i]!.untyped) return;
        texts.forEach((text, j) => {
          const key = restatementKey(text);
          if (key) lastTyped.set(key, `${i}:${j}`);
        });
      });
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!,
          plain = stripMemoryPacket(it.text),
          // A re-read message a row already holds is stored as it is (the gate is idempotent), and is skipped below.
          safe = this.stored.has(plain) ? plain : this.persistText(plain),
          lane = lanes[i]!;
        if (lane === "icl" || lane === "narrative") {
          let text = safe;
          if (lane === "narrative" && opts.keepLiveIdentity)
            try {
              text = omitConflictingIdentity(text, this.semantic());
            } catch {}
          if (text && !this.seenLower.has(text.toLowerCase())) {
            const rec = this.remember(text, {
              kind: lane === "narrative" || it.untyped ? "episode" : "fact",
              lane,
              tags: srcTags(it),
              origin: it.origin,
            });
            out.push(rec);
            try {
              if (lane === "narrative") new ChunkStore(this.dir).put(text, { src: rec.id, t: rec.at });
              else new IclIndex(this.dir).put(text, { src: rec.id, t: rec.at });
            } catch {}
          }
          continue;
        }
        const before = out.length;
        let coveredChars = 0,
          skippedIdentity = false;
        for (const [j, text] of durables[i]!.entries()) {
          try {
            const fact = it.untyped ? undefined : objectAsserted(text);
            if (fact) {
              const store = this.semantic(),
                live = store.get(fact.s, fact.p);
              if (opts.keepLiveIdentity) {
                const obj = fact.o.trim().toLowerCase(),
                  slot = `${fact.s}\0${fact.p}`,
                  fromBatch = batchLive.get(slot);
                if (!(fromBatch && fromBatch !== obj)) {
                  if (live && live.o.trim().toLowerCase() !== obj) {
                    skippedIdentity = true;
                    continue;
                  }
                  if (store.supersededObject(fact.o)) {
                    skippedIdentity = true;
                    continue;
                  }
                }
              }
              if (!STATUS_OBJECT.test(fact.o)) {
                store.put(fact.s, fact.p, fact.o, memoryNow());
                batchLive.set(`${fact.s}\0${fact.p}`, fact.o.trim().toLowerCase());
              }
            }
          } catch {}
          const lastTypedHere = lastTyped.get(restatementKey(text) ?? "") === `${i}:${j}`;
          const learnAgain = !opts.reread && this.restated(text, lastTypedHere);
          if (this.seenLower.has(text.toLowerCase()) && !learnAgain) continue;
          // A4 §3.0: text the user did not type is an episode, never a fact, a rule or a pin.
          const asQuestion = /^\s*(?:what|which|who|where|when|why|how)\b/i.test(text),
            rules = it.untyped || asQuestion ? [] : rulesIn(text),
            pin = !it.untyped && pinsItself(text, rules);
          let kind: MemoryKind =
            it.untyped || asQuestion
              ? "episode"
              : pin || rules.length
                ? "constraint"
                : LEGACY_RULE.test(withoutExcludedWording(text))
                  ? "constraint"
                  : new RegExp(
                        String.raw`\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|` +
                          String.raw`standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|` +
                          String.raw`deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b`,
                        "i",
                      ).test(text) ||
                      (/\bflake\b/i.test(text) && /\.[A-Za-z]{1,12}\b/.test(text))
                    ? "episode"
                    : "fact";
          if (kind === "fact" && !asQuestion && !pin)
            try {
              if (!objectAsserted(text)) kind = "episode";
            } catch {
              kind = "episode";
            }
          out.push(this.remember(text, { kind, pin, tags: srcTags(it), origin: it.origin }));
          coveredChars += text.length;
        }
        try {
          if (!skippedIdentity && !isNoopCue(it.text) && !CHAT.test(it.text.trim()) && safe.length >= 8) {
            let identityTurn = false;
            try {
              identityTurn = !!objectAsserted(safe);
            } catch {}
            if (
              !(opts.keepLiveIdentity && identityTurn) &&
              (out.length === before || coveredChars / Math.max(1, safe.length) < 0.85)
            ) {
              const key = safe.replace(/[.!?]+$/g, "").toLowerCase();
              if (
                !this.seenLower.has(safe.toLowerCase()) &&
                !out.some((r) => r.text.replace(/[.!?]+$/g, "").toLowerCase() === key) &&
                !this.seenKeys.has(key)
              )
                out.push(this.remember(safe, { kind: "episode", tags: srcTags(it), origin: it.origin }));
            }
          }
        } catch {}
      }
      return out;
    } finally {
      this.batch--;
      this.flush(false);
      if (!opts.deferSleep) this.noteActivity();
    }
  }

  /** A message's durable statements as rows hold them: "X instead of Y" as X alone, the store's redaction applied. */
  private durables(text: string): string[] {
    return extractDurable(text).map((raw) => {
      let said = raw;
      try {
        const asserted = objectAsserted(said);
        if (asserted && /\b(?:instead of|rather than)\b/i.test(said))
          said = asserted.p === "uses" ? `Use ${asserted.o}.` : `The ${asserted.s} is ${asserted.o}.`;
      } catch {}
      return this.persistText(said);
    });
  }

  /**
   * A statement whose text only superseded rows hold, said again: only a later typed statement re-learns a value
   * (A4 §3.1, D12). A batch can hold old statements too, so a restatement must be the last statement the user typed
   * about its subject in the batch; the assistant's or a tool's echo never is, and neither is anything in a batch the
   * caller marks a re-read (`observe`).
   */
  private restated(text: string, lastTypedHere: boolean): boolean {
    if (!lastTypedHere) return false;
    const lower = text.toLowerCase();
    const holding = this.compiled.filter((c) => c.rec.text.toLowerCase() === lower);
    return holding.length > 0 && holding.every((c) => superseded(c.rec));
  }

  private flush(mark: boolean) {
    if (mark) this.dirty = true;
    if (this.batch || !this.dirty) return;
    this.persist();
  }

  /**
   * Writes the store (A4 §1). The rows this process wrote first get their `seq`, under the store lock. When that
   * lock is not free within 50 ms, or the store file's own lock stays taken, they go to `pending.jsonl` for sleep
   * instead of being lost (A1 D11). A row another process also holds is merged, never replaced (`mergeRow`).
   */
  private persist() {
    try {
      if (this.consent() !== "on") return;
    } catch {
      return;
    }
    if (!this.sequence()) this.pend(this.rowsIn(this.unsaved));
    try {
      withFileLock(`${this.path}.lock`, () => {
        try {
          const mine = new Set(this.compiled.map((c) => c.rec.id)),
            byId = new Map<string, Compiled>();
          for (const c of load(this.path)) {
            // A row this process left pending is in the store once a sleep has given it its seq.
            this.pended.delete(c.rec.id);
            if (mine.has(c.rec.id) || !this.knownIds.has(c.rec.id)) byId.set(c.rec.id, c);
          }
          for (const c of this.compiled) {
            const merged = mergeRow(byId.get(c.rec.id)?.rec, c.rec);
            byId.set(c.rec.id, merged === c.rec ? c : compileNeedles(merged));
          }
          this.compiled = [...byId.values()];
          for (const c of this.compiled) this.knownIds.add(c.rec.id);
        } catch {}
        this.trimToStoreCap();
        const resolved = resolveSupersessions(this.compiled.map((c) => c.rec));
        this.compiled = this.compiled.map((c, i) => (resolved[i] === c.rec ? c : compileNeedles(resolved[i]!)));
        const written = this.compiled.filter((c) => !this.pended.has(c.rec.id)).map((c) => c.rec);
        writeStore(this.path, written);
        try {
          unlinkSync(`${this.path}.wal`);
        } catch {}
        // The guard's lookup by class (A4 §1, A7 §5): a repo store's rule rows, beside it.
        if (this.perRepo)
          try {
            writeRuleIndex(this.dir, written);
          } catch {}
      });
      this.unsaved.clear();
      // A row waiting in pending.jsonl that this process has since superseded waits again, as it is now.
      this.pend(this.rowsIn(this.changed).filter((r) => this.pended.has(r.id)));
      this.changed.clear();
      this.rebuildSeen();
      this.dirty = false;
    } catch {
      this.pend(this.rowsIn(new Set([...this.unsaved, ...this.changed])));
    }
  }

  private rowsIn(ids: ReadonlySet<string>): MemoryRecord[] {
    return this.compiled.map((c) => c.rec).filter((r) => ids.has(r.id));
  }

  /** Gives the rows this process wrote their `seq` (A4 §1); false when the store lock was not free in time. */
  private sequence(): boolean {
    const waiting = this.compiled.map((c) => c.rec).filter((r) => this.unsaved.has(r.id) && r.seq === undefined);
    if (!waiting.length) return true;
    const first = claimSeqs(this.dir, waiting.length);
    if (first === undefined) return false;
    waiting.forEach((r, i) => (r.seq = first + i));
    return true;
  }

  /**
   * Leaves rows to sleep, in `pending.jsonl`, with the store they belong to: new rows no store file holds yet, and
   * rows this process superseded when it could not write them. Sleep merges them into the store (`mergeRow`).
   */
  private pend(rows: readonly MemoryRecord[]): void {
    const disk = rows.map(toDisk).filter((row): row is DiskRow => !Array.isArray(row));
    if (!disk.length || !appendPending(this.dir, this.subdir, disk)) return;
    for (const r of rows) {
      if (this.unsaved.delete(r.id)) this.pended.add(r.id);
      this.changed.delete(r.id);
    }
  }

  private trimToStoreCap(): void {
    const cap = memoryStoreCap();
    if (!Number.isFinite(cap) || cap <= 0 || this.compiled.length <= cap) return;
    const pinned = (r: MemoryRecord) => (r.tags ?? []).includes("pin") || r.kind === "constraint",
      keep = this.compiled.filter((c) => pinned(c.rec)),
      rest = this.compiled.filter((c) => !pinned(c.rec)).sort((a, b) => compareRecency(a.rec, b.rec));
    this.compiled = keep.concat(rest.slice(Math.max(0, rest.length - Math.max(0, cap - keep.length))));
    this.post = null;
  }

  relevant(text: string, cap = memoryRetrieveCap()): MemoryRecord[] {
    const hay = queryHay(text);
    try {
      this.ensureIndex();
      const ranked = [...hay]
        .filter((t) => t.length >= 3 && !STOP.has(t))
        .map((t) => ({ t, df: this.post!.get(t)?.length ?? 0 }))
        .filter((x) => x.df > 0)
        .sort((a, b) => a.df - b.df);
      const poolCap = Math.max(cap * 6, 30),
        seen = new Set<Compiled>(),
        pool: Compiled[] = [];
      for (const { t, df } of ranked) {
        if (df >= 80 && pool.length) break;
        for (const c of this.post!.get(t) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          pool.push(c);
          if (pool.length >= poolCap) break;
        }
        if (df >= 80 || pool.length >= poolCap) break;
      }
      const scored: { rec: MemoryRecord; n: number; rare: number }[] = [];
      for (const c of pool) {
        let n = 0,
          rare = 0;
        for (const x of c.needles)
          if (hay.has(x)) {
            n++;
            rare += 1 / Math.max(1, this.post?.get(x)?.length ?? 1);
          }
        if (
          n &&
          c.needles.length <= SCORABLE_NEEDLES &&
          !c.needles.some((x) => !hay.has(x) && /^[a-z]+\d+[a-z]$/.test(x)) &&
          !/\b(?:is|are)\s+not\b|\bunrelated\b|\bred herring\b/i.test(c.rec.text)
        )
          scored.push({ rec: c.rec, n, rare });
      }
      return liveCopulaLatest(scored)
        .sort(
          (a, b) =>
            b.n + rankKindBoost(b.rec) - (a.n + rankKindBoost(a.rec)) ||
            b.rare - a.rare ||
            compareRecency(b.rec, a.rec),
        )
        .slice(0, Math.max(0, Math.floor(Number(cap) || 0)))
        .map((x) => x.rec);
    } catch {
      return [];
    }
  }

  notesFor(text = "", k = memoryRetrieveCap()): MemoryRecord[] {
    const cap = Math.max(0, Math.floor(Number(k) || 0)),
      route = routeMemory(text);
    let recs: MemoryRecord[] =
      route === "icl-index"
        ? mergeIclLane(
            text,
            cap,
            this.dir,
            this.compiled.map((c) => c.rec),
          )
        : this.relevant(text, k);
    if (route !== "icl-index") {
      if (route === "gist-chunk")
        recs = mergeNarrativeLane(
          recs,
          text,
          cap,
          this.dir,
          this.compiled.map((c) => c.rec),
        );
      recs = mergeHowtoLane(recs, text, cap, this.dir);
    }
    const kept = recs.map((n) => {
      const raw = String(n.text ?? "");
      if (!/\b(?:instead of|rather than)\b/i.test(raw)) return n;
      try {
        const fact = objectAsserted(raw.replace(/^\[[^\]]+\]\s+/, ""));
        if (!fact) return n;
        return { ...n, text: fact.p === "uses" ? `${fact.s} uses ${fact.o}.` : `The ${fact.s} is ${fact.o}.` };
      } catch {
        return n;
      }
    });
    return labelledNotes(kept);
  }

  /**
   * The notes a message list's cue retrieves, ranked and labelled, before any packing; then the list is observed
   * (`observeCue`). The policies and intents the user's last message fires come first (`triggered`), then the lexical
   * path's notes, which a no-op cue gets none of. Nothing is retrieved when the list already carries a packet. The hook
   * and `inject` (`memory-wrap.ts`) select, shape and word them (`memory-delivery.ts`, `memory-hook-packet.ts`). Fails
   * open: a throw is counted in `memoryInjectSwallows` and recalls nothing. `encode` replaces what is encoded when
   * the caller knows more of its sources than the cue shows (the hook splits a prompt's pasted spans off, D12).
   */
  recall(messages: unknown[], encode?: unknown[]): MemoryRecord[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      if (this.consent() === "off") return [];
    } catch {
      return [];
    }
    try {
      const cue = attachPlaceCues(cueFor(list), placePathsFrom(list)),
        blob = convBlob(list);
      let packet: MemoryRecord[] = [];
      if (!MEMORY_PACKET_MARKS.some((mark) => blob.includes(mark))) {
        let silent = false;
        try {
          if (cue && isNoopCue(cue)) silent = true;
          else if (hookLane(cue) === "none") silent = true;
        } catch {}
        packet = !silent && cue ? this.notesFor(cue) : [];
        try {
          if (packet.length && cue && routeMemory(cue) === "sf-assemble") packet = assembleNotes(packet, this.dir);
        } catch {}
        // A trigger hit is STRONG evidence (A7 §4), so it leads, whatever the lexical path makes of the cue.
        const triggered = this.triggered(typedText(list, encode));
        packet = [...triggered, ...packet.filter((note) => !triggered.some((rule) => rule.id === note.id))];
        if (packet.length)
          try {
            logMemoryNotes(packet);
          } catch {}
      }
      this.observeCue(list, cue, encode ?? list);
      return packet;
    } catch {
      memoryInjectSwallows.n++;
      return [];
    }
  }

  /**
   * Stores a message list (or `encode`, see `recall`) unless its cue is a no-op or a question: what `recall` stores
   * after retrieving.
   */
  observeCue(
    messages: unknown[],
    cue = attachPlaceCues(cueFor(messages), placePathsFrom(messages)),
    encode: unknown[] = messages,
  ): void {
    try {
      if (cue && !isNoopCue(cue) && !/^(?:what|which|who|where|when|why|how)\b/i.test(cue.trim()))
        this.observe(encode, { deferSleep: true });
    } catch {}
  }

  /**
   * The messages with each turn's packet at the tail of its human message (D29, `memory-wrap.ts`): what the wrap
   * sends upstream. Encodes what the list adds. Fails open: a throw is counted in `memoryInjectSwallows` and the list
   * is returned as it came.
   */
  inject(messages: unknown[], opts?: InjectOptions): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      if (this.consent() === "off") return list;
      return placeTurnTails(this, list, opts);
    } catch {
      memoryInjectSwallows.n++;
      return list;
    }
  }

  /**
   * `inject` on a request body's `messages` (OpenAI) or `contents` (Gemini), with the paths the body names as place
   * cues. Its system prompt is the host's text, not memory (D12).
   */
  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    const key = Array.isArray(body.contents) && !Array.isArray(body.messages) ? "contents" : "messages",
      list = Array.isArray(body[key]) ? (body[key] as unknown[]) : [];
    try {
      const next = this.inject(list, { paths: placePathsFrom(body) });
      return next === list ? body : { ...body, [key]: next };
    } catch {
      memoryInjectSwallows.n++;
      return body;
    }
  }

  /** Whether memory may be written: `EDEN_MEMORY` is on, not read-only or off. */
  writable(): boolean {
    try {
      return this.consent() === "on";
    } catch {
      return false;
    }
  }

  /** Notes a turn's activity on the sleep clock and schedules the incremental sleep, as `observe` does by default. */
  noteActivity(): void {
    try {
      noteSleepActivity(this);
    } catch {}
    try {
      scheduleIncrementalSleep(this, { session: this.session });
    } catch {}
  }

  quiet(fn: () => void) {
    this.batch++;
    const sem = this.semantic();
    sem.beginBatch();
    try {
      fn();
    } finally {
      try {
        sem.endBatch();
      } catch {}
      this.batch--;
      this.flush(false);
    }
  }

  dropWhere(pred: (r: MemoryRecord) => boolean): void {
    this.compiled = this.compiled.filter((c) => !pred(c.rec));
    this.post = null;
    this.flush(true);
  }

  rewriteWhere(pred: (r: MemoryRecord) => string | undefined): void {
    let dirty = false;
    this.compiled = this.compiled.map((c) => {
      const next = pred(c.rec);
      if (typeof next !== "string" || next === c.rec.text) return c;
      dirty = true;
      return compileNeedles({ ...c.rec, text: next });
    });
    if (dirty) ((this.post = null), this.flush(true));
  }

  patchWhere(fn: (r: MemoryRecord) => MemoryRecord | undefined): void {
    let dirty = false;
    this.compiled = this.compiled.map((c) => {
      let next: MemoryRecord | undefined;
      try {
        next = fn(c.rec);
      } catch {
        return c;
      }
      if (!next || next === c.rec) return c;
      dirty = true;
      return compileNeedles(next);
    });
    if (dirty) ((this.post = null), this.flush(true));
  }

  close() {
    this.flush(false);
  }

  async sleep(opts?: { session?: string }): Promise<void> {
    try {
      const { consolidate } = await import("./sleep");
      consolidate(this, { session: opts?.session ?? this.session, mode: "full" });
    } catch {}
  }
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;

export function processMemory(): AgentMemory {
  if (process.argv.some((a) => a.endsWith(".test.ts"))) {
    return openMemory({ dir: join(tmpdir(), "eden-m-" + Math.random().toString(36).slice(2)) });
  }
  const dir =
      process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined),
    root = dir || join(homedir(), ".eden", "memory"),
    parent = memorySessionName(process.env.EDEN_MEMORY_SESSION) ?? memorySessionName(process.env.EDEN_MEMORY_PARENT),
    childId = memorySessionName(process.env.EDEN_MEMORY_CHILD);
  const session = childId ? childSessionName(parent, childId) : parent,
    child = !!childId,
    // D1: the wrap remembers in the store of the repo it runs in, the store the hook reads.
    store = storeFor(root);
  if (proc && (proc.dir !== store || proc.session !== session || proc.child !== child)) {
    try {
      proc.close();
    } catch {}
    proc = undefined;
  }
  return (proc ??= openMemory({ dir: store, session, child, perRepo: true }));
}

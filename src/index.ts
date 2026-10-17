import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
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
import { applyProvenanceLabel, isCited, isUntyped, noteKindToken, stripPacketLabel } from "./memory-provenance";
import type { FailedCitation } from "./memory-citations";
import type { MinedFact } from "./memory-repo-facts";
import { logMemoryNotes } from "./memory-log";
import { legacySlot, residualSentences, restatesNote } from "./memory-residual";
import { parentScope, rowScope, type EncodePlace } from "./memory-place";
import {
  cuedSlots,
  DEFAULT_SCOPES,
  mayStateSlot,
  noteSlots,
  slotRefs,
  slotsIn,
  typedValue,
  type SlotId,
  type SlotRef,
  type SlotStatement,
} from "./memory-slots";
import {
  counteredKeys,
  isForget,
  readInvalidations,
  recordSlotChanges,
  recordSupersession,
  validText,
  type Invalidation,
  type SlotChange,
} from "./memory-validity";
import { memoryNow } from "./memory-clock";
import { appendPending, claimSeqs, compareRecency, takePending, ulid, type DiskRow } from "./memory-ids";
import { markStoreFormat, readableStore, storeFor } from "./memory-repo";
import type { ActionClass } from "./memory-classes";
import { firedClasses, triggeredRows } from "./memory-triggers";
import {
  CONTEXT_PARTS,
  PART_MASS,
  queryHay,
  RARE_DF,
  REFERENCE_WEIGHT,
  type CuePart,
  type SituationCue,
} from "./memory-cue";
import {
  cueTerms,
  promptTerms,
  rankable,
  rowFields,
  rowTerms,
  STOP,
  termScore,
  type Corpus,
  type RowFields,
} from "./memory-bm25f";
import {
  candidateRows,
  DeltaIndex,
  PostingsView,
  rowDigest,
  Snapshot,
  writeSnapshot,
  type Indexed,
  type RowFilter,
} from "./memory-postings";
import { identifierTokens, isEpisode, sharesIdentifier } from "./memory-gate";
import {
  readSilence,
  readTau,
  RELATIVE_CUT,
  SEED_NEGATIVES,
  silentNorm,
  R1_NORM,
  tauOf,
  trimSilence,
  TRUSTED_SILENCE,
  writeTau,
  type TauRecord,
} from "./memory-tau";
import { writeRuleIndex } from "./memory-rule-index";
import { readUserRules, withUserGlobal } from "./memory-user-global";
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

/**
 * The kind prior `relevant` ranks with, on every path (D17: never more than one match): a thousandth of the legacy
 * prior (at most 0.05), under what any matched word adds to a BM25F score, so it orders rows of equal evidence only.
 */
function kindPrior(r: MemoryRecord): number {
  return rankKindBoost(r) / 1000;
}

/**
 * A row stating a value instead of another ("The database is sqlite instead of postgres") as the value it asserts
 * ("The database is sqlite."): the replaced name is no memory to give.
 */
function assertedOnly(n: MemoryRecord): MemoryRecord {
  const raw = String(n.text ?? "");
  if (!/\b(?:instead of|rather than)\b/i.test(raw)) return n;
  try {
    const fact = objectAsserted(raw.replace(/^\[[^\]]+\]\s+/, ""));
    if (!fact) return n;
    return { ...n, text: fact.p === "uses" ? `${fact.s} uses ${fact.o}.` : `The ${fact.s} is ${fact.o}.` };
  } catch {
    return n;
  }
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
  /** The other sessions that typed a rule row's text again, word for word (D9's recurrence, `memory-pins.ts`). */
  eps?: string[];
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
  /** D7: the slots the row states, by key (A4 §3.1). */
  slots?: SlotRef[];
  /** How many times the user typed the row's value again, which wrote no row of its own (A4 §3.2). */
  reps?: number;
  /** A4 §3.2: the row superseded another value of its slot at its own scope (a correction). */
  corrected?: 1;
  /** Where in the repo the row is true (A4 §1, D3): a scope of its catalog. Absent is the repo root, `""`. */
  scope?: string;
  /** D8: the repo files a mined slot row cites, relative to the repo's top (`memory-citations.ts`). */
  cite?: string[];
};

/** Whether a newer row has superseded this one (A4 §3.1). */
export function superseded(r: Pick<MemoryRecord, "invalidAt" | "invalidBy">): boolean {
  return typeof r.invalidAt === "number" || typeof r.invalidBy === "string";
}

/** Whether a row is in force: not superseded, and not past its `valid_until` (an intent's 7 days, D9). */
export function isLiveRow(r: MemoryRecord, now = memoryNow()): boolean {
  return !superseded(r) && !(typeof r.validUntil === "number" && Number.isFinite(r.validUntil) && r.validUntil <= now);
}

/**
 * Whether two rows are about one place: the same scope, or either written before P3.2 placed encoded rows (A4 §3.2:
 * a value at one scope never supersedes another scope's).
 */
function samePlace(a: Pick<MemoryRecord, "scope">, b: Pick<MemoryRecord, "scope">): boolean {
  return a.scope === undefined || b.scope === undefined || a.scope === b.scope;
}

/** Whether a row may set or end a slot: its keys name it, or its text names it (`mayStateSlot`), read cheaply. */
function mayHoldSlot(row: MemoryRecord, slot: SlotId): boolean {
  return row.slots ? row.slots.some((ref) => ref.k === slot) : mayStateSlot(row.text, slot);
}

/** Whether a slot statement is of one of D7's root slots (`default_scope: root`). */
function isRootSlot({ slot }: { slot: SlotId }): boolean {
  return DEFAULT_SCOPES[slot] === "root";
}

/** The value a row sets for a slot, if it sets one (`noteSlots`). */
function slotValue(row: MemoryRecord, slot: SlotId): string | undefined {
  if (!mayHoldSlot(row, slot)) return undefined;
  return noteSlots(row).find((ref) => ref.k === slot && ref.v !== undefined)?.v;
}

/** Whether row `a` was written after row `b`: by time, then by id (ULIDs sort by time). */
function newerThan(a: MemoryRecord, b: MemoryRecord): boolean {
  return (a.at ?? 0) > (b.at ?? 0) || ((a.at ?? 0) === (b.at ?? 0) && a.id > b.id);
}

/** Whether slot keys end a value: they set the slot otherwise, or invalidate the value (A4 §3.1). */
function endsValue(refs: readonly SlotRef[], slot: SlotId, value: string): boolean {
  return refs.some((ref) => ref.k === slot && (ref.v !== undefined ? ref.v !== value : !!ref.x?.includes(value)));
}

/** Whether slot keys set a slot to a value. */
function setsValue(refs: readonly SlotRef[], slot: SlotId, value: string): boolean {
  return refs.some((ref) => ref.k === slot && ref.v === value);
}

/**
 * Whether newer typed rows at a row's place end all it says of its slots (`supersedeSlots`): every value it sets,
 * or, for a retraction, every value it retracts, set again.
 */
function slotsEnded(row: MemoryRecord, others: readonly MemoryRecord[]): boolean {
  const own = noteSlots(row);
  const newer = others
    .filter((other) => samePlace(other, row) && newerThan(other, row))
    .filter((other) => own.some((ref) => mayHoldSlot(other, ref.k)))
    .map(noteSlots);
  const sets = own.filter((ref) => ref.v !== undefined);
  if (sets.length) return sets.every((ref) => newer.some((refs) => endsValue(refs, ref.k, ref.v!)));
  const retracted = own.flatMap((ref) => (ref.x ?? []).map((old) => [ref.k, old] as const));
  return retracted.length > 0 && retracted.every(([slot, old]) => newer.some((refs) => setsValue(refs, slot, old)));
}

/** The scopes below `scope` that hold their own value of a slot (D31: `stale_for` spares them). */
function overridingScopes(rows: readonly MemoryRecord[], slot: SlotId, scope: string | undefined): string[] {
  if (scope === undefined) return [];
  const below = (other: string) => other !== scope && (scope === "" || other.startsWith(`${scope}/`));
  const scopes = rows.flatMap((row) =>
    row.scope !== undefined && below(row.scope) && slotValue(row, slot) !== undefined ? [row.scope] : [],
  );
  return [...new Set(scopes)].sort();
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
 * Of the retrieved rows giving one subject a value at one scope, the newest. A row the user did not type is an
 * episode (A4 §3.0): it competes with no statement, so a newer tool result or assistant claim never displaces what
 * the user said. A prompt stored whole as an episode ("The database is postgres. Reply with just OK.") never
 * displaces the keyed fact (D7) it states, nor does an episode displace one either way; a newer fact the user typed
 * does (A4 §3.1: the newest statement is the value). Two scopes' values are two items (A4 §2): which one a cue sees is
 * visibility's (D5's override, P3.5).
 */
/** Whether `row` is an episode and `other` a keyed fact (D7): the episode gives way (`liveCopulaLatest`). */
function episodeOfKeyed(row: MemoryRecord, other: MemoryRecord): boolean {
  return noteKindToken(row) === "episode" && !row.slots?.length && !!other.slots?.length;
}

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
    const k = `${row.rec.scope ?? "\0"}\0${a.s}\0${a.p}`,
      prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, row);
      continue;
    }
    const [rowGives, prevGives] = [episodeOfKeyed(row.rec, prev.rec), episodeOfKeyed(prev.rec, row.rec)];
    if (prevGives || (!rowGives && compareRecency(row.rec, prev.rec) >= 0)) byKey.set(k, row);
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
  /** Where the hook's window is working (A4 §2, `memory-place.ts`): the scope each row it encodes is stored at. */
  place?: EncodePlace;
};

/** Which rows a reader may see (A4 §2's visibility, `memory-place.ts`); every row by default. */
export type { RowFilter };
const EVERY_ROW: RowFilter = () => true;

/** A store row and its BM25F fields (`memory-bm25f.ts`), computed on first use: most paths never ask. */
type Compiled = Indexed & { readonly rankable: boolean };

function compileRow(rec: MemoryRecord): Compiled {
  let fields: RowFields | undefined;
  let ranks: boolean | undefined;
  return {
    rec,
    get fields() {
      return (fields ??= rowFields(rec));
    },
    get rankable() {
      return (ranks ??= rankable(rec));
    },
  };
}

/** Every scope: a reader that cannot tell which scopes its rows may be at reads them all. */
const everyScope = () => true;

/** Whether the lexical path ranks a row: live, no rule row (D18), and rankable at its length (`memory-bm25f.ts`). */
function indexable(c: Compiled): boolean {
  return !c.rec.rules?.length && isLiveRow(c.rec) && c.rankable;
}

export { queryHay };

/**
 * What a turn adds to its messages' cue (`recall`). `situation` is its situation cue (A7 §3, `memory-cue.ts`): its
 * parts rank the lexical path's rows, and a continuation, whose prompt carries nothing to match, is answered from the
 * proposal it accepts: the proposal's classes and slots, and rows sharing an identifier-shaped token with the agent's
 * last message (STRONG, A7 §4). `typed` is the user's own words when the caller split them off but encodes nothing.
 */
export interface RecallCue {
  situation?: SituationCue;
  typed?: string;
}

/** A cue part as `relevant` reads it: its terms, its weight against a default-mode prompt, and its mass limit. */
interface HayPart {
  part: CuePart;
  hay: ReadonlySet<string>;
  weight: number;
  mass: number;
}

/** A word of an identifier that is itself identifier-shaped: a dotted name (`api.ts`) or letters with digits. */
function identifierWord(word: string): boolean {
  return word.includes(".") || (/\d/.test(word) && /[a-z]/.test(word));
}

/**
 * The parts `relevant` scores, in the index's terms (`memory-bm25f.ts`, R1's tokenizer): the prompt's identifier-split
 * words alone without a situation cue (A7 §3's `q_prompt`: `vitest.config.ts` gives vitest.config, vitest and config;
 * one shared part admits nothing below τ_repo, A7 §4); with one, the context parts' identifier-split tokens too,
 * `q_prev` read for its rare words (df ≤ 50 among the rows the reader sees, A7 §4) and the identifier-shaped words of
 * its STRONG tokens (`memory-cue.ts`), not their plain parts ("apps", "web" of `apps/web/lib/api.ts` must be rare to
 * count).
 */
function hayParts(text: string, cue: SituationCue | undefined, corpus: Corpus): HayPart[] {
  const prompt = promptTerms(text);
  if (!cue) return [{ part: "prompt", hay: prompt, weight: 1, mass: Infinity }];
  const weight = (part: CuePart) => cue.weights[part] / REFERENCE_WEIGHT;
  const spared = cueTerms([...cue.strong].flatMap((token) => [...queryHay(token)].filter(identifierWord)));
  const rare = (token: string) => spared.has(token) || corpus.df(token) <= RARE_DF;
  const context = CONTEXT_PARTS.map((part): HayPart => ({
    part,
    hay: part === "prev" ? new Set([...cueTerms(cue.parts.prev)].filter(rare)) : cueTerms(cue.parts[part]),
    weight: weight(part),
    mass: PART_MASS,
  }));
  return [{ part: "prompt" as const, hay: prompt, weight: weight("prompt"), mass: Infinity }, ...context].filter(
    (part) => part.hay.size && part.weight > 0,
  );
}

/**
 * A row's scores against the parts (A7 §3, D17): each part's BM25F over the terms it shares with the row, the rarest up
 * to its mass. `score` weighs each part by the turn mode (the ranking, A7 §3); `sum` is the parts' scores unweighted,
 * which the gate reads against τ_repo (A7 §4: "the gate sees the per-part scores as well as the sum"). τ starts at R1's
 * strict point, measured on a cue of the prompt, the previous turn and the paths taken together (R1 M7). And the parts
 * that give the row MEDIUM evidence (A7 §4): a rare plain word of the prompt (df ≤ 50 among the rows the reader sees; a
 * commoner one is WEAK, which ranks only) or any word of a context part (`q_prev`'s are rare already).
 */
function situatedScore(fields: RowFields, parts: readonly HayPart[], corpus: Corpus) {
  const terms = rowTerms(fields);
  const medium = new Set<CuePart>();
  let score = 0;
  let sum = 0;
  for (const part of parts) {
    const hits = [...part.hay]
      .filter((term) => terms.has(term))
      .sort((a, b) => corpus.df(a) - corpus.df(b))
      .slice(0, part.mass);
    if (!hits.length) continue;
    if (part.part !== "prompt" || corpus.df(hits[0]!) <= RARE_DF) medium.add(part.part);
    const own = hits.reduce((total, term) => total + termScore(term, fields, corpus), 0);
    score += part.weight * own;
    sum += own;
  }
  return { score, sum, medium };
}

/**
 * A7 §4's STRONG evidence on the lexical path: an identifier-shaped token the row shares with the prompt, or, on a
 * continuation, with the agent's last message only (A7 §2: a continuation is answered from `q_prev`).
 */
function strongEvidence(rec: MemoryRecord, prompt: ReadonlySet<string>, cue: SituationCue | undefined): boolean {
  const own = identifierTokens(rec.text);
  return sharesIdentifier(own, cue?.mode === "continuation" ? cue.strong : prompt);
}

/**
 * Whether A7 §4's MEDIUM path admits a row without STRONG evidence: its BM25F sum reaches τ_repo on MEDIUM evidence
 * (WEAK never admits), from two different cue parts when it is an episode (`isEpisode`: one the user did not type, or
 * a prompt stored as an episode). A continuation admits on STRONG evidence only (A7 §2).
 */
function mediumAdmits(rec: MemoryRecord, sum: number, medium: ReadonlySet<CuePart>, tau: number, mode?: string) {
  if (mode === "continuation" || !medium.size || sum < tau) return false;
  return !isEpisode(rec) || medium.size >= 2;
}

/** A candidate as A7 §4's gate reads it (`AgentMemory.evidenced`): its ranking score and its gate sum. */
interface Evidenced {
  rec: MemoryRecord;
  score: number;
  sum: number;
  medium: ReadonlySet<CuePart>;
  strong: boolean;
}

const topSum = (rows: readonly { sum: number }[]) => rows.reduce((max, row) => Math.max(max, row.sum), 0);

/** What the lexical path's gate saw on its last call (`AgentMemory.relevant`): the hook logs it (A5 wide events). */
export interface GateTrace {
  /** τ_repo (`memory-tau.ts`). */
  tau: number;
  /** Candidates with MEDIUM evidence or STRONG; 0 makes the prompt a silence prompt (A7 §4). */
  evidenced: number;
  /** The top gate sum among them (`situatedScore`). */
  top: number;
  /** Rows admitted: on STRONG evidence, and on the MEDIUM path. */
  strong: number;
  medium: number;
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

/** A message's durable statements; `lines` is its text with line breaks kept, where a heading's list ends its items. */
function extractDurable(blob: string, lines = blob): string[] {
  const seen = new Set<string>(),
    out: string[] = [];
  let whole = blob.trim().replace(/\s+/g, " ").replace(ACK_PREFIX, "");
  if (SPEAKER_LABEL.test(whole) && whole.endsWith("?") && /[.!]/.test(whole.slice(0, -1)))
    whole = whole.replace(/\s+[^.!?]+\?\s*$/, "").trim();
  const listed = listUnderHeading(lines),
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

/** How many other sessions a row records as having typed it again (`eps`): D9 needs one. */
const RECURRING_SESSIONS = 8;

/** The legacy store's rule words, for a rule on no action class ("always explain plainly"). */
const LEGACY_RULE = /\b(prefer|never |always |don'?t |do not |must |from now on)\b/i;

const TEXT_SOURCES = new Set<string>(["user", "paste", "tool", "agent"]);

/** A message as `observe` encodes it: its role, its source (A6 §2.1) and its text, whitespace collapsed. */
/** Where a message came from, when the caller knows: its transcript line, that line's time and turn (A4 §3.3). */
type MessageOrigin = { at?: number; srcUuid?: string; promptId?: string };

/** `text` has its whitespace collapsed; `lines` keeps its line breaks (a heading's list reads them). */
type ObservedItem = {
  role: string;
  src?: TextSource;
  untyped: boolean;
  text: string;
  lines: string;
  origin: MessageOrigin;
};

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
  const lines = (untyped ? withoutInstructions(raw) : raw).trim().replace(/[^\S\n]+/g, " ");
  return { role, src, untyped, text: lines.replace(/\s+/g, " "), lines, origin };
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
  const bare =
    !r.tags &&
    !r.lane &&
    !r.ep &&
    !r.heat &&
    !r.sal &&
    r.scope === undefined &&
    invalidAt === undefined &&
    invalidBy === undefined;
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
        const c = compileRow(rec),
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
      if (other === row || superseded(row) || !samePlace(row, other) || !contradicts(row.text, other.text)) continue;
      const [older, newer] = (other.at ?? 0) > (row.at ?? 0) ? [row, other] : [other, row];
      older.invalidBy = newer.id;
      const slot = legacySlot(older);
      if (slot && legacySlot(newer)) recordSupersession(root, slot, newer.at, undefined, older.scope);
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

/** Appends rows that left the store's hot path to its diary (`trimToStoreCap`), as the store writes them. */
function appendDiary(dir: string, rows: readonly MemoryRecord[]): void {
  if (!rows.length) return;
  try {
    const path = join(dir, DIARY_FILE);
    appendFileSync(path, rows.map((r) => JSON.stringify(toDisk(r))).join("\n") + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {}
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

/** D33's hot-path row cap, and the file the rows past it go to (`trimToStoreCap`). */
const STORE_CAP = 20_000;
export const DIARY_FILE = "diary.jsonl";

export const PACKET_CHAT_K_MIN = 6,
  PACKET_CHAT_K_MAX = 10,
  PACKET_CHAT_K_DEFAULT = PACKET_CHAT_K_MIN;

export function memoryRetrieveCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_CAP);
  return !Number.isFinite(raw) || raw <= 0
    ? PACKET_CHAT_K_MIN
    : Math.min(PACKET_CHAT_K_MAX, Math.max(PACKET_CHAT_K_MIN, Math.floor(raw)));
}

/** The rows a store keeps on the hot path (D33: the newest 20k until SQLite, P6.1); `EDEN_MEMORY_STORE_CAP` sets it. */
export function memoryStoreCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_STORE_CAP);
  return !Number.isFinite(raw) || raw <= 0 ? STORE_CAP : Math.floor(raw);
}

function mergeNarrativeLane(
  lexical: MemoryRecord[],
  text: string,
  cap: number,
  dir: string,
  compiled: MemoryRecord[] = [],
  hidden: ReadonlySet<string> = new Set(),
): MemoryRecord[] {
  const q = String(text ?? "").trim();
  if (!q) return lexical;
  const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0))),
    hits = retrieveNarrativeChunks(dir, q, { k, fallback: compiled }).filter((hit) => !hidden.has(hit.src ?? "")),
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

function mergeIclLane(
  text: string,
  cap: number,
  dir: string,
  compiled: MemoryRecord[] = [],
  hidden: ReadonlySet<string> = new Set(),
): MemoryRecord[] {
  const q = String(text ?? "").trim();
  if (!q) return [];
  const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0))),
    hits = retrieveIcl(dir, q, { k, fallback: compiled }).filter((hit) => !hidden.has(hit.src ?? ""));
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

/**
 * The overwrite route's assembly where a reader's place is known (A4 §3.2): each scope's notes on their own, and
 * never with the semantic store's live values, which hold no scope, so a value at one scope never overturns another's.
 */
function assembleWithin(notes: MemoryRecord[]): MemoryRecord[] {
  const byScope = new Map<string | undefined, MemoryRecord[]>();
  for (const note of notes) byScope.set(note.scope, [...(byScope.get(note.scope) ?? []), note]);
  return [...byScope.values()].flatMap((group) => assembleNotes(group));
}

/**
 * The texts a store holds (A4 §3.2), which `observe` checks a text against: `lower`, every row's text lowercased, and
 * again as `<scope>\0<text>` (the scope `\0` where it is unknown); `keys`, the same without end punctuation (an
 * episode is not stored twice for a final period); `exact`, every text as written (a text a row already holds has
 * passed the gate, which `observe` need not run again).
 */
interface Seen {
  lower: Set<string>;
  keys: Set<string>;
  exact: Set<string>;
}

function noteText(seen: Seen, text: string, scope: string | undefined): void {
  const lower = text.toLowerCase();
  const key = lower.replace(/[.!?]+$/g, "");
  for (const [set, value] of [
    [seen.lower, lower],
    [seen.keys, key],
  ] as const)
    set.add(value).add(`${scope ?? "\0"}\0${value}`);
  seen.exact.add(text);
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
  private readonly place?: EncodePlace;
  private compiled: Compiled[];
  private path: string;
  private batch = 0;
  private dirty = false;
  /** The texts the store holds (`Seen`), read from the rows when first asked: a Submit writing nothing never asks. */
  private seenTexts: Seen | null = null;
  /** The live rule rows (D9 keys), which triggers deliver; read from the rows when first asked. */
  private ruleRows: MemoryRecord[] | null = null;
  /** The rows by id, for the postings snapshot's ordinals; read when first asked. */
  private rowsById: Map<string, Compiled> | null = null;
  /** The rows the postings snapshot does not hold, indexed (`DeltaIndex`); kept until the rows change. */
  private deltaIndex: DeltaIndex<Compiled> | null = null;
  /** What the lexical path's gate saw on the last `relevant` call (`GateTrace`); undefined before one or on a throw. */
  lastGate: GateTrace | undefined;
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
    this.place = opts.place;
    if (this.perRepo && !this.sealed && memoryConsent() === "on")
      try {
        markStoreFormat(this.dir);
      } catch {}
    if (this.subdir) mkdirSync(join(this.dir, this.subdir), { recursive: true });
    this.path = join(this.dir, this.subdir, "memories.jsonl");
    this.compiled = load(this.path);
    this.knownIds = new Set(this.compiled.map((c) => c.rec.id));
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

  /** The session's own `ep`, which each row it writes carries (A4 §7 tells sessions apart by it). */
  get episode(): string | undefined {
    return this.session ? opaqueId(this.session) : undefined;
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
      scope?: string;
      /** The text's slots this row keys: one part of a statement split by its slots' default scopes. */
      keys?: readonly SlotId[];
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
      ...(this.episode ? { ep: this.episode } : {}),
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
    // D7: a typed statement of a slot is keyed by it (A4 §3.1); a rule row and an episode state none (D6).
    const read = untyped || rec.kind === "episode" || rules.length ? [] : slotsIn(rec.text);
    const slots = opts.keys ? read.filter(({ slot }) => opts.keys!.includes(slot)) : read;
    const parts = opts.scope === undefined && !opts.keys && !opts.id ? this.scopeParts(rec.text, slots) : undefined;
    if (parts) return this.rememberParts(text, opts, parts);
    const root = rules.length > 0 || (slots.length > 0 && slots.every(isRootSlot));
    const scope = opts.scope ?? this.encodedScope(rec.text, root, slots);
    if (scope !== undefined) rec.scope = scope;
    if (slots.length) rec.slots = slotRefs(slots);
    const visible = opts.id ? undefined : this.restatedSlots(rec);
    if (visible) return visible;
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
      // The semantic store keys a value by its subject, with no scope: only a row of unknown place puts there, so it
      // never tombstones another scope's value (A4 §3.2). A slot's subject is the slot's (`objectAsserted`, R3 E8).
      const fact = untyped || rec.scope !== undefined ? undefined : objectAsserted(rec.text);
      if (fact && !STATUS_OBJECT.test(fact.o)) this.semantic().put(fact.s, fact.p, fact.o, rec.at);
    } catch {}
    return this.add(rec);
  }

  /** Adds a row to the store: it supersedes what it overturns (A4 §3.1), and is written. */
  private add(rec: MemoryRecord): MemoryRecord {
    const c = compileRow(rec),
      i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    try {
      this.invalidateSameCopula(rec);
    } catch {}
    try {
      this.supersedeSlots(rec);
    } catch {}
    try {
      this.supersedeRules(rec);
    } catch {}
    this.compiled.push(c);
    this.knownIds.add(rec.id);
    this.unsaved.add(rec.id);
    this.indexChanged();
    this.noteSeen(rec.text, rec.scope);
    return (this.flush(true), rec);
  }

  /**
   * D8: slot values the repo's files state (`memory-citations.ts` decides which), each a `src:tool` row keyed by its
   * slot at its folder's scope, citing its files. Like a typed statement, it supersedes the older values of its slot
   * at its scope (A4 §3.2). The store is written once for them all.
   */
  citeFacts(facts: readonly (MinedFact & { text: string })[]): MemoryRecord[] {
    if (!facts.length || this.consent() !== "on") return [];
    this.batch++;
    try {
      return facts.map((fact) => {
        const at = memoryNow();
        return this.add({
          id: ulid(at),
          text: this.persistText(fact.text),
          kind: "fact",
          tags: ["src:tool"],
          at,
          scope: fact.scope,
          slots: [{ k: fact.slot, v: fact.value }],
          cite: [...fact.files],
        });
      });
    } finally {
      this.batch--;
      this.flush(false);
    }
  }

  /**
   * D31: a failed citation invalidates the fact (`memory-citations.ts`). At its scope, the rows giving its slot the
   * value it cited lose that value: the mined rows always; when the files say for sure that the value is gone (`sure`),
   * also the typed rows typed no later than their last reading that still said it, and text carrying the value turns
   * `stale_for` there and below, but for the descendants that hold their own value (`recordSlotChanges`). A row with
   * nothing else to say of its slots goes to history with no successor (A4 §3.1).
   */
  endCitations(failed: readonly FailedCitation[]): void {
    if (!failed.length || this.consent() !== "on") return;
    const live = this.compiled.filter((c) => !superseded(c.rec));
    const gone: Compiled[] = [];
    const changes: SlotChange[] = [];
    for (const { citation, sure } of failed) {
      const ending = live.filter(({ rec }) => {
        const vouched = isCited(rec) || (sure && !isUntyped(rec) && (rec.at ?? 0) <= citation.checked);
        return (rec.scope ?? "") === citation.scope && vouched && slotValue(rec, citation.slot) === citation.value;
      });
      if (!ending.length) continue;
      const keepsOther = (rec: MemoryRecord) =>
        noteSlots(rec).some((ref) => ref.v !== undefined && !(ref.k === citation.slot && ref.v === citation.value));
      gone.push(...ending.filter(({ rec }) => !keepsOther(rec)));
      if (!sure) continue;
      const except = overridingScopes(
        live.map((c) => c.rec),
        citation.slot,
        citation.scope,
      );
      const typed = typedValue(ending[0]!.rec.text, citation.slot, citation.value);
      changes.push({ slot: citation.slot, value: citation.value, typed, scope: citation.scope, except });
    }
    recordSlotChanges(this.dir, changes);
    this.toHistory(gone);
  }

  /**
   * Statements the user asked Eden to keep (`eden memory remember`, D11), each one row in the user's own words
   * (`src:user`): a rule row when it states a D9 rule, else of the kind given (a fact by default), at the scope given
   * (the repo root by default). The store is written once for them all.
   */
  rememberTyped(statements: readonly { text: string; kind?: MemoryKind; scope?: string }[]): MemoryRecord[] {
    this.batch++;
    try {
      return statements.map(({ text, kind, scope }) =>
        this.remember(text, {
          kind: rulesIn(this.persistText(text)).length ? "constraint" : kind || "fact",
          tags: ["src:user"],
          scope,
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
   * A newer statement of a copula's subject supersedes its older values at its scope (A4 §3.1–3.2), whatever list
   * numbers they carry, and when both are slots, older text giving the old value is stale (D31, `recordSupersession`).
   * Only what the user typed supersedes: a tool result or the assistant's text is an episode (A4 §3.0, A6 §2.1).
   */
  private invalidateSameCopula(incoming: MemoryRecord): void {
    if (isUntyped(incoming) || incoming.slots || !copulaKey(incoming.text)) return;
    for (const c of this.compiled) {
      if (c.rec.id === incoming.id || superseded(c.rec) || !samePlace(c.rec, incoming)) continue;
      if (noteSlots(c.rec).length) continue;
      if (!contradicts(c.rec.text, incoming.text)) continue;
      c.rec.invalidBy = incoming.id;
      this.changed.add(c.rec.id);
      const old = legacySlot(c.rec);
      if (old && legacySlot(incoming)) recordSupersession(this.dir, old, incoming.at, undefined, c.rec.scope);
    }
  }

  /**
   * D7's `default_scope` for a statement of root and working slots ("we use pnpm and vitest" typed in apps/web): its
   * root slots and its working slots, when they go to two scopes; else none, and it is one row.
   */
  private scopeParts(text: string, slots: readonly SlotStatement[]): SlotStatement[][] | undefined {
    const root = slots.filter(isRootSlot);
    const working = slots.filter((stated) => !isRootSlot(stated));
    if (!this.place || !root.length || !working.length) return undefined;
    const apart = this.encodedScope(text, true, root) !== this.encodedScope(text, false, working);
    return apart ? [working, root] : undefined;
  }

  /** A statement split by its slots' default scopes: one row per part, the same text keyed at each part's scope. */
  private rememberParts(
    text: string,
    opts: Parameters<AgentMemory["remember"]>[1],
    parts: readonly SlotStatement[][],
  ): MemoryRecord {
    this.batch++;
    try {
      const rows = parts.map((part) => this.remember(text, { ...opts, keys: part.map(({ slot }) => slot) }));
      return rows[0]!;
    } finally {
      this.batch--;
      this.flush(false);
    }
  }

  /**
   * D7's `default_scope` (A4 §3.2): where an encoded row goes (`rowScope`), and a root slot naming no scope goes to the
   * working scope when that scope already has its own row of the slot. None where the place is unknown.
   */
  private encodedScope(text: string, root: boolean, slots: readonly SlotStatement[]): string | undefined {
    if (!this.place) return undefined;
    const scope = rowScope(text, root, this.place);
    const working = this.place.working();
    if (scope !== "" || !slots.length || !root || !working) return scope;
    const own = slots.some(({ slot }) => this.slotRows(slot).some((row) => row.scope === working));
    return own ? working : scope;
  }

  /** The live typed rows that set a slot's value, newest first. */
  private slotRows(slot: SlotId): MemoryRecord[] {
    return this.compiled
      .map((c) => c.rec)
      .filter((row) => !superseded(row) && slotValue(row, slot) !== undefined)
      .sort((a, b) => compareRecency(b, a));
  }

  /**
   * The row whose value of a slot is visible at a scope (A4 §3.2, D5): the newest at the scope itself, else at the
   * nearest ancestor that has one. A row of unknown scope is visible everywhere.
   */
  private visibleSlot(slot: SlotId, scope: string | undefined): MemoryRecord | undefined {
    const rows = this.slotRows(slot);
    if (scope === undefined) return rows[0];
    for (let at: string | undefined = scope; at !== undefined; at = parentScope(at)) {
      const own = rows.find((row) => (row.scope ?? at) === at);
      if (own) return own;
    }
    return undefined;
  }

  /**
   * A4 §3.2's equal write: a typed fact whose every slot sets the value already visible at its scope writes no row;
   * each visible row counts the restatement (`reps`) and is returned in its place. D30's `restate` and `confirm`
   * events are P5.1's.
   */
  private restatedSlots(rec: MemoryRecord): MemoryRecord | undefined {
    const refs = rec.slots ?? [];
    if (rec.kind !== "fact" || !refs.length || refs.some((ref) => ref.v === undefined || ref.x?.length)) return;
    const visible = refs.map((ref) => this.visibleSlot(ref.k, rec.scope));
    if (visible.some((row, at) => !row || slotValue(row, refs[at]!.k) !== refs[at]!.v)) return;
    for (const row of new Set(visible as MemoryRecord[])) {
      row.reps = (row.reps ?? 0) + 1;
      this.changed.add(row.id);
    }
    this.flush(true);
    return visible[0];
  }

  /**
   * A4 §3.1–3.2 by key: a typed slot statement supersedes, at its own scope, every older value it sets otherwise or
   * invalidates (`use A not B`, a retraction, which has no successor). A row goes to history once every value it
   * sets is gone (a retraction row, once each value it retracts is set again), so a row stating two slots keeps the
   * one still true. Each value it ends is logged as D31's `stale_for` at the row's scope, but for the descendants
   * that hold their own value of the slot (`recordSlotChanges`).
   */
  private supersedeSlots(incoming: MemoryRecord): void {
    const refs = incoming.slots ?? [];
    if (!refs.length) return;
    // A mined row (D8) is keyed like a typed one: either supersedes the other's older value (A4 §3.2).
    const typed = this.compiled
      .map((c) => c.rec)
      .filter((row) => !superseded(row) && (!isUntyped(row) || isCited(row)));
    const rows = typed.filter((row) => refs.some((ref) => mayHoldSlot(row, ref.k)));
    const ended = new Map<string, SlotChange>();
    const end = (slot: SlotId, value: string, scope: string | undefined, typed: string) => {
      const key = `${slot}\0${value}\0${scope ?? "\0"}`;
      if (!ended.has(key)) ended.set(key, { slot, value, typed, ...(scope === undefined ? {} : { scope }) });
    };
    for (const row of rows) {
      if (row === incoming || !samePlace(row, incoming) || !newerThan(incoming, row)) continue;
      const own = noteSlots(row);
      const lost = own.filter((ref) => ref.v !== undefined && endsValue(refs, ref.k, ref.v));
      for (const ref of lost) end(ref.k, ref.v!, row.scope, typedValue(row.text, ref.k, ref.v!));
      if (!lost.length && !own.some((ref) => ref.x?.some((old) => setsValue(refs, ref.k, old)))) continue;
      if (slotsEnded(row, [...typed.filter((other) => other !== row), incoming])) {
        row.invalidBy = incoming.id;
        this.changed.add(row.id);
      }
      if (lost.length && row.scope === incoming.scope) incoming.corrected = 1;
    }
    for (const ref of refs)
      for (const old of ref.x ?? []) end(ref.k, old, incoming.scope, typedValue(incoming.text, ref.k, old));
    const live = typed.filter((row) => !superseded(row));
    const changes = [...ended.values()].map((change) => ({
      ...change,
      except: overridingScopes(live, change.slot, change.scope),
    }));
    recordSlotChanges(this.dir, changes, incoming.at);
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
    this.toHistory(this.compiled.filter((c) => !superseded(c.rec) && !validText(c.rec.text, 0, forgets)));
  }

  /**
   * A6 §3 `eden memory forget --all-in <scope>`: every keyed row of the scope (a row stating D9 rules or D7 slots)
   * goes to history, as a forget's do. Returns how many.
   */
  forgetScope(scope: string): number {
    const keyed = this.compiled.filter(
      (c) => !superseded(c.rec) && (c.rec.rules?.length || noteSlots(c.rec).length) && (c.rec.scope ?? "") === scope,
    );
    this.toHistory(keyed);
    return keyed.length;
  }

  /** Rows taken back with no successor: invalid at the store's next `seq` (A4 §3.1), and the store written. */
  private toHistory(rows: readonly Compiled[]): void {
    if (!rows.length) return;
    const seq = claimSeqs(this.dir, 1) ?? Math.max(0, ...this.compiled.map((c) => c.rec.seq ?? 0));
    for (const c of rows) {
      c.rec.invalidAt = seq;
      this.changed.add(c.rec.id);
    }
    this.indexChanged();
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
    this.toHistory(taken.filter((c) => !said.some((text) => text.includes(c.rec.text.toLowerCase()))));
  }

  /** Forgets everything read from the rows, after another process's rows were merged in. */
  private rebuildSeen() {
    this.seenTexts = null;
    this.indexChanged();
  }

  /** Forgets what retrieval read from the rows (the rule rows, the rows by id), after a row changed. */
  private indexChanged(): void {
    this.ruleRows = null;
    this.rowsById = null;
    this.deltaIndex = null;
  }

  /** The texts the store holds (`Seen`), read from the rows once. */
  private seen(): Seen {
    if (this.seenTexts) return this.seenTexts;
    const seen: Seen = (this.seenTexts = { lower: new Set(), keys: new Set(), exact: new Set() });
    for (const c of this.compiled) noteText(seen, c.rec.text, c.rec.scope);
    return seen;
  }

  private noteSeen(text: string, scope: string | undefined): void {
    if (this.seenTexts) noteText(this.seenTexts, text, scope);
  }

  /**
   * Whether a row already holds a text (lowercased; in `keys`, without its closing stop) where it would be stored
   * (A4 §3.2): at its scope, or at no known scope, which is every scope's. Where the place is unknown, any row.
   */
  private seenAt(value: string, scope: string | undefined, set = this.seen().lower): boolean {
    const lower = value.toLowerCase();
    if (scope === undefined) return set.has(lower);
    return set.has(`${scope}\0${lower}`) || set.has(`\0\0${lower}`);
  }

  /** The scope `remember` stores a typed text at, read before it is stored (`encodedScope`). */
  private scopeFor(text: string, untyped: boolean): string | undefined {
    if (!this.place) return undefined;
    const rules = untyped ? [] : rulesIn(text);
    const slots = untyped || rules.length ? [] : slotsIn(text);
    const root = rules.length > 0 || (slots.length > 0 && slots.every(isRootSlot));
    return this.encodedScope(text, root, slots);
  }

  /**
   * The live rule rows (D9 keys): each a policy or an intent, which its classes' triggers deliver and word overlap
   * never does (D18), so the lexical path never ranks one.
   */
  private liveRules(): MemoryRecord[] {
    return (this.ruleRows ??= this.compiled.filter((c) => c.rec.rules?.length && isLiveRow(c.rec)).map((c) => c.rec));
  }

  /** The row of an id, as this process holds it. */
  private rowOf(id: string): Compiled | undefined {
    return (this.rowsById ??= new Map(this.compiled.map((c) => [c.rec.id, c]))).get(id);
  }

  /**
   * The index as a reader sees it (`memory-postings.ts`): the snapshot's postings of the scopes it may see, and the
   * rows the snapshot does not hold (written since, or with no `seq`), indexed here.
   */
  private postingsView(snapshot: Snapshot | undefined, visible: RowFilter): PostingsView<Compiled> {
    return new PostingsView(snapshot, this.delta(snapshot), (id) => this.rowOf(id), visible.scopes ?? everyScope);
  }

  /** The rows a snapshot does not hold by id (every row without one), indexed once per snapshot. */
  private delta(snapshot: Snapshot | undefined): DeltaIndex<Compiled> {
    const version = snapshot?.header.id;
    if (this.deltaIndex && this.deltaIndex.snapshot === version) return this.deltaIndex;
    return (this.deltaIndex = new DeltaIndex(version, this.outside(snapshot)));
  }

  /**
   * How many rows wait for a new snapshot: the indexable rows it does not hold; those it holds whose text, tags or
   * keys changed since its build (`rowDigest`); and those it holds that left the store or were taken back, whose words
   * it should no longer keep. All of them when a part of it cannot be read, so it is written again.
   */
  private waiting(snapshot: Snapshot | undefined): number {
    if (!snapshot) return this.outside(undefined).length;
    try {
      snapshot.verify();
      const built = snapshot.digests();
      let waiting = 0;
      for (const c of this.compiled) {
        const digest = built.get(c.rec.id);
        if (digest === undefined ? indexable(c) : digest !== rowDigest(c.rec)) waiting++;
      }
      for (const id of built.keys()) {
        const c = this.rowOf(id);
        if (!c || c.rec.rules?.length || !isLiveRow(c.rec)) waiting++;
      }
      return waiting;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /** The indexable rows a snapshot does not hold by id: every one, without a snapshot. */
  private outside(snapshot: Snapshot | undefined): Compiled[] {
    const held = new Set(snapshot?.ids() ?? []);
    return this.compiled.filter((c) => !held.has(c.rec.id) && indexable(c));
  }

  /**
   * Writes the store's postings snapshot (`memory-postings.ts`) when at least `minDelta` indexable rows wait outside
   * the current one (every row, when there is none): the light sleep passes `SNAPSHOT_DELTA`, so a small store is
   * indexed in process; the idle sleeper and `eden memory remember` pass 1. Returns whether it wrote one.
   */
  refreshPostings(minDelta = 1): boolean {
    const dir = dirname(this.path);
    const snapshot = Snapshot.open(dir);
    try {
      if (this.consent() !== "on" || this.sealed) return false;
      if (this.waiting(snapshot) < Math.max(1, minDelta)) return false;
      writeSnapshot(
        dir,
        this.compiled.filter(indexable).sort((a, b) => compareRecency(a.rec, b.rec)),
      );
      return true;
    } catch {
      return false;
    } finally {
      snapshot?.close();
    }
  }

  /**
   * τ_repo's refit (A7 §4, heavy sleep; `memory-tau.ts`): the silence set replayed against the store as a cue-less
   * prompt sees it (every scope), each prompt's top MEDIUM-path sum over the store's mean idf, and the smallest
   * normalized threshold that keeps them all silent. A logged prompt is replayed from the typed row its turn stored,
   * without that turn's rows; one no row stores (a question, never stored) is left out. Prompts a STRONG identifier
   * answers are counted apart: no τ silences them. The fit is used once `TRUSTED_SILENCE` prompts, pooled with the
   * other repos' logged prompts, back it; until then R1's point is. Writes `tau.json`; returns the record, or undefined
   * when the store cannot be refit (memory not on, no indexed row).
   */
  refitTau(): TauRecord | undefined {
    const dir = dirname(this.path);
    if (this.consent() !== "on" || this.sealed) return undefined;
    const snapshot = Snapshot.open(dir);
    try {
      const view = this.postingsView(snapshot, EVERY_ROW);
      const mean = view.meanIdf();
      if (!(mean > 0)) return undefined;
      const silence = readSilence(dir);
      trimSilence(dir);
      const typed = new Map<string, MemoryRecord>();
      for (const c of this.compiled) if (c.rec.promptId && !isUntyped(c.rec)) typed.set(c.rec.promptId, c.rec);
      const logged = silence.empty.flatMap((id) => (typed.has(id) ? [typed.get(id)!] : []));
      const replay = (text: string, turn?: string) => this.silenceTop(text, view, turn);
      const seeds = SEED_NEGATIVES.map((text) => replay(text));
      const own = logged.map((row) => replay(row.text, row.promptId));
      const scores = own.filter((top) => !top.strong).map((top) => top.score / mean);
      const pooled = [...seeds.filter((top) => !top.strong).map((top) => top.score / mean), ...scores];
      const others = this.siblingTaus();
      for (const other of others) pooled.push(...other.scores);
      const n = seeds.length + own.length + silence.acks + others.reduce((sum, other) => sum + other.logged, 0);
      const fit = silentNorm(pooled);
      const trusted = fit !== undefined && n >= TRUSTED_SILENCE;
      const rec: TauRecord = {
        v: 1,
        norm: trusted ? fit : R1_NORM,
        source: trusted ? "fit" : "r1",
        ...(fit === undefined ? {} : { fit }),
        n,
        strong: [...seeds, ...own].filter((top) => top.strong).length,
        meanIdf: mean,
        scores,
        logged: own.length + silence.acks,
        at: memoryNow(),
      };
      writeTau(dir, rec);
      return rec;
    } catch {
      return undefined;
    } finally {
      snapshot?.close();
    }
  }

  /**
   * A silence prompt's replay (`refitTau`): the top BM25F sum the MEDIUM path would admit at τ = 0 (a cue-less prompt,
   * so an episode the user did not type never reaches it), and whether a STRONG identifier admits a row. `turn` is the
   * `prompt_id` of the turn that stored the prompt: its own rows are left out.
   */
  private silenceTop(text: string, view: PostingsView<Compiled>, turn?: string) {
    const rows = this.evidenced(text, undefined, view, EVERY_ROW).filter((row) => !turn || row.rec.promptId !== turn);
    const medium = rows.filter((row) => !row.strong && mediumAdmits(row.rec, row.sum, row.medium, 0));
    return { score: topSum(medium), strong: rows.some((row) => row.strong) };
  }

  /** The last refits of the user's other repos' stores (the siblings of this one), for the pooled silence set. */
  private siblingTaus(): { scores: number[]; logged: number }[] {
    const dir = dirname(this.path);
    if (!this.perRepo) return [];
    try {
      return readdirSync(dirname(dir))
        .map((name) => join(dirname(dir), name))
        .filter((other) => other !== dir)
        .flatMap((other) => {
          const rec = readTau(other);
          return rec ? [{ scores: rec.scores ?? [], logged: rec.logged ?? 0 }] : [];
        });
    } catch {
      return [];
    }
  }

  /**
   * The policies and intents the classes the user's own words fire deliver (A4 §5.1 step 4b, `memory-triggers.ts`):
   * `own` is the text D12 left the user, without pasted spans or spans copied from a recent tool result. A per-repo
   * store's rules sit beside the rules the user keeps for all projects (D11), which a repo row of the same rule gives
   * way to.
   */
  private triggered(own: string, visible: RowFilter): MemoryRecord[] {
    return this.triggeredBy(firedClasses(own), visible);
  }

  /** The policies and intents the classes deliver (`triggered`), each class's best `PER_CLASS`. */
  private triggeredBy(classes: readonly ActionClass[], visible: RowFilter): MemoryRecord[] {
    try {
      if (!classes.length) return [];
      const global = this.perRepo ? (readUserRules(this.windowsRoot) as MemoryRecord[]) : [];
      const invalid = global.length ? readInvalidations(this.dir) : [];
      const rows = withUserGlobal(this.liveRules().filter(visible), global, invalid);
      return labelledNotes(triggeredRows(rows, classes));
    } catch {
      return [];
    }
  }

  /**
   * A4 §5.1 step 4a: the slots the user's own words cue (`cuedSlots`), looked up by key: at each scope the reader
   * sees, the newest live row that keys the slot, typed or mined (D8). A keyed hit is STRONG evidence (A7 §4).
   */
  private keyed(own: string, visible: RowFilter): MemoryRecord[] {
    const slots = cuedSlots(own);
    if (!slots.length) return [];
    const newest = new Map<string, MemoryRecord>();
    for (const { rec } of this.compiled) {
      if (!isLiveRow(rec) || (isUntyped(rec) && !isCited(rec)) || !visible(rec)) continue;
      for (const slot of slots) {
        if (slotValue(rec, slot) === undefined) continue;
        const key = `${rec.scope ?? ""}\0${slot}`;
        const known = newest.get(key);
        if (!known || compareRecency(rec, known) > 0) newest.set(key, rec);
      }
    }
    return labelledNotes([...new Set(newest.values())].map(assertedOnly));
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
        // Rows whose place is known are scoped: the unscoped semantic store takes none of their values (`remember`).
        placed = !!this.place?.repo(),
        batchLive = new Map<string, string>(),
        lanes = items.map((it) => encodeLane(it.text)),
        durables = items.map((it, i) =>
          lanes[i] === "icl" || lanes[i] === "narrative" ? [] : this.durables(it.text, it.lines),
        ),
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
          safe = this.seen().exact.has(plain) ? plain : this.persistText(plain),
          lane = lanes[i]!;
        if (lane === "icl" || lane === "narrative") {
          let text = safe;
          if (lane === "narrative" && opts.keepLiveIdentity)
            try {
              text = omitConflictingIdentity(text, this.semantic());
            } catch {}
          if (text && !this.seen().lower.has(text.toLowerCase())) {
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
          // D7: a statement of a slot is a fact keyed by it (A4 §3.1). A retraction's "don't" is no rule word: it
          // states a slot, not a rule ("we don't use yarn anymore"); a statement that also sets a value beside a rule
          // word stays a rule row with its keys ("we use pnpm, never npm").
          const slots = it.untyped ? [] : slotsIn(text);
          const slotted = slots.length > 0;
          const retraction = slotted && slots.every((stated) => stated.value === undefined);
          try {
            const fact = it.untyped || placed ? undefined : objectAsserted(text);
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
          if (this.seenAt(text, this.scopeFor(text, it.untyped)) && !learnAgain) {
            if (!it.untyped && !opts.reread) this.noteRuleSaidAgain(text, it.origin.srcUuid);
            continue;
          }
          // A4 §3.0: text the user did not type is an episode, never a fact, a rule or a pin.
          const asQuestion = /^\s*(?:what|which|who|where|when|why|how)\b/i.test(text),
            rules = it.untyped || asQuestion ? [] : rulesIn(text),
            pin = !it.untyped && pinsItself(text, rules);
          let kind: MemoryKind =
            it.untyped || asQuestion
              ? "episode"
              : pin || rules.length
                ? "constraint"
                : LEGACY_RULE.test(withoutExcludedWording(text)) && !retraction
                  ? "constraint"
                  : slotted
                    ? "fact"
                    : new RegExp(
                          String.raw`\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|` +
                            String.raw`standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|` +
                            String.raw`deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b`,
                          "i",
                        ).test(text) ||
                        (/\bflake\b/i.test(text) && /\.[A-Za-z]{1,12}\b/.test(text))
                      ? "episode"
                      : "fact";
          if (kind === "fact" && !asQuestion && !pin && !slotted)
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
              const at = this.place && rowScope(safe, false, this.place);
              if (
                !this.seenAt(safe, at) &&
                !out.some((r) => r.text.replace(/[.!?]+$/g, "").toLowerCase() === key) &&
                !this.seenAt(key, at, this.seen().keys)
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

  /**
   * A message's durable statements as rows hold them: "X instead of Y" as X alone, the store's redaction applied. A
   * slot statement keeps its words: its keys hold what it invalidates (A4 §3.1).
   */
  private durables(text: string, lines?: string): string[] {
    return extractDurable(text, lines).map((raw) => {
      let said = raw;
      try {
        const asserted = slotsIn(said).length ? undefined : objectAsserted(said);
        if (asserted && /\b(?:instead of|rather than)\b/i.test(said))
          said = asserted.p === "uses" ? `Use ${asserted.o}.` : `The ${asserted.s} is ${asserted.o}.`;
      } catch {}
      return this.persistText(said);
    });
  }

  /**
   * D9's recurrence of a rule typed again word for word, which the store keeps as one row: each row stating it records
   * the session that said it again (`eps`), so sleep counts both sessions (`memory-pins.ts`). A transcript line read
   * again (a re-read, or a fork's copy of its parent's line, which keeps its uuid) is no new statement.
   */
  private noteRuleSaidAgain(text: string, srcUuid: string | undefined): void {
    const ep = this.episode;
    const lower = text.toLowerCase();
    if (!ep) return;
    let noted = false;
    for (const { rec: row } of this.compiled) {
      if (!row.rules?.length || row.text.toLowerCase() !== lower || !row.ep || row.ep === ep) continue;
      if (row.eps?.includes(ep) || superseded(row) || (srcUuid && row.srcUuid === srcUuid)) continue;
      row.eps = [...(row.eps ?? []), ep].slice(-RECURRING_SESSIONS);
      this.changed.add(row.id);
      noted = true;
    }
    if (noted) this.flush(true);
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
            byId.set(c.rec.id, merged === c.rec ? c : compileRow(merged));
          }
          this.compiled = [...byId.values()];
          for (const c of this.compiled) this.knownIds.add(c.rec.id);
        } catch {}
        this.trimToStoreCap();
        const resolved = resolveSupersessions(this.compiled.map((c) => c.rec));
        this.compiled = this.compiled.map((c, i) => (resolved[i] === c.rec ? c : compileRow(resolved[i]!)));
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

  /**
   * D33: the store holds its newest `memoryStoreCap()` rows (20k by default), pins and constraints always. An older
   * row leaves the hot path for `diary.jsonl` beside the store, which no hook reads (the diary on disk is unbounded;
   * P6.1's store takes it in). Runs under the store's lock; a store write that then fails can leave a row in the
   * diary twice, so the diary is read by id.
   */
  private trimToStoreCap(): void {
    const cap = memoryStoreCap();
    if (!Number.isFinite(cap) || cap <= 0 || this.compiled.length <= cap) return;
    const pinned = (r: MemoryRecord) => (r.tags ?? []).includes("pin") || r.kind === "constraint",
      keep = this.compiled.filter((c) => pinned(c.rec)),
      rest = this.compiled.filter((c) => !pinned(c.rec)).sort((a, b) => compareRecency(a.rec, b.rec));
    const leaving = Math.max(0, rest.length - Math.max(0, cap - keep.length));
    appendDiary(
      dirname(this.path),
      rest.slice(0, leaving).map((c) => c.rec),
    );
    this.compiled = keep.concat(rest.slice(leaving));
    this.indexChanged();
  }

  /**
   * The lexical path (A4 §5.1 steps 4c and 6, D17): BM25F over a bounded candidate set from the store's postings
   * snapshot and the rows written since (`memory-postings.ts`), for every reader alike, then A7 §4's gate. A row is
   * admitted on STRONG evidence (`strongEvidence`), or on the MEDIUM path when its gate sum reaches τ_repo
   * (`mediumAdmits`, `memory-tau.ts`) and its score is at least 0.7 of the MEDIUM path's top score (D17's relative cut,
   * on the ranking as R1 cut it); then ranked by its score, the kind prior, and recency. A snapshot that cannot be
   * read (cut short, or rewritten by hand) is set aside: the rows are indexed in process.
   */
  relevant(text: string, cap = memoryRetrieveCap(), visible = EVERY_ROW, cue?: SituationCue): MemoryRecord[] {
    this.lastGate = undefined;
    const snapshot = Snapshot.open(dirname(this.path));
    try {
      return this.ranked(text, cap, visible, cue, snapshot);
    } catch {
      try {
        return snapshot ? this.ranked(text, cap, visible, cue, undefined) : [];
      } catch {
        return [];
      }
    } finally {
      snapshot?.close();
    }
  }

  private ranked(
    text: string,
    cap: number,
    visible: RowFilter,
    cue: SituationCue | undefined,
    snapshot: Snapshot | undefined,
  ): MemoryRecord[] {
    const view = this.postingsView(snapshot, visible);
    const tau = tauOf(dirname(this.path), view.meanIdf());
    // An episode restating the prompt whole (the prompt typed before, stored) is never delivered (D26's residual, A4
    // §5.1 step 7): it sets no top.
    const said = residualSentences([text]);
    const echo = (rec: MemoryRecord) => noteKindToken(rec) === "episode" && restatesNote(rec, said);
    // Of the rows giving one subject a value, the newest (A4 §5.1 step 5's supersession), before the gate's cut.
    const rows = liveCopulaLatest(this.evidenced(text, cue, view, visible).filter((row) => !echo(row.rec)));
    const passing = rows.filter((row) => row.strong || mediumAdmits(row.rec, row.sum, row.medium, tau, cue?.mode));
    // A4 §5.1 step 6: the cut is the MEDIUM path's; a STRONG row is admitted alone and sets no top.
    const top = passing.reduce((max, row) => (row.strong ? max : Math.max(max, row.score)), 0);
    const admitted = passing.filter((row) => row.strong || row.score >= RELATIVE_CUT * top);
    const strong = admitted.filter((row) => row.strong).length;
    this.lastGate = { tau, evidenced: rows.length, top: topSum(rows), strong, medium: admitted.length - strong };
    return admitted
      .sort((a, b) => b.score + kindPrior(b.rec) - (a.score + kindPrior(a.rec)) || compareRecency(b.rec, a.rec))
      .slice(0, Math.max(0, Math.floor(Number(cap) || 0)))
      .map((x) => x.rec);
  }

  /**
   * The candidates with A7 §4 evidence for a cue (see `relevant`), each with its BM25F sum, the parts that give it
   * MEDIUM evidence and whether it has STRONG: rows with neither have only WEAK words, which never admit.
   */
  private evidenced(text: string, cue: SituationCue | undefined, view: PostingsView<Compiled>, visible: RowFilter) {
    const parts = hayParts(text, cue, view);
    const hay = new Set(parts.flatMap((part) => [...part.hay]));
    const promptIds = identifierTokens(text);
    const pool = candidateRows(
      [...hay].map((term) => view.rowsOf(term)),
      (c) => indexable(c) && visible(c.rec),
    );
    const rows: Evidenced[] = [];
    for (const c of pool) {
      if (
        c.fields.body.some((x) => !hay.has(x) && /^[a-z]+\d+[a-z]$/.test(x)) ||
        /\b(?:is|are)\s+not\b|\bunrelated\b|\bred herring\b/i.test(c.rec.text)
      )
        continue;
      const { score, sum, medium } = situatedScore(c.fields, parts, view);
      const strong = strongEvidence(c.rec, promptIds, cue);
      if (strong || medium.size) rows.push({ rec: c.rec, score, sum, medium, strong });
    }
    return rows;
  }

  notesFor(text = "", k = memoryRetrieveCap(), visible: RowFilter = EVERY_ROW, cue?: SituationCue): MemoryRecord[] {
    const cap = Math.max(0, Math.floor(Number(k) || 0)),
      route = routeMemory(text),
      all = this.compiled.map((c) => c.rec),
      // The lanes' own indexes name each hit's row (`src`): a row the reader may not see is no hit.
      lane = () => ({ rows: all.filter(visible), hidden: new Set(all.flatMap((r) => (visible(r) ? [] : [r.id]))) });
    let recs: MemoryRecord[];
    if (route === "icl-index") {
      const { rows, hidden } = lane();
      recs = mergeIclLane(text, cap, this.dir, rows, hidden);
    } else {
      recs = this.relevant(text, k, visible, cue);
      if (route === "gist-chunk") {
        const { rows, hidden } = lane();
        recs = mergeNarrativeLane(recs, text, cap, this.dir, rows, hidden);
      }
      recs = mergeHowtoLane(recs, text, cap, this.dir).filter(visible);
    }
    return labelledNotes(recs.map(assertedOnly));
  }

  /**
   * The notes a message list's cue retrieves, ranked and labelled, before any packing; then the list is observed
   * (`observeCue`). The policies and intents the user's last message fires come first (`triggered`), then the lexical
   * path's notes, which a no-op cue gets none of. Nothing is retrieved when the list already carries a packet. The hook
   * and `inject` (`memory-wrap.ts`) select, shape and word them (`memory-delivery.ts`, `memory-hook-packet.ts`). Fails
   * open: a throw is counted in `memoryInjectSwallows` and recalls nothing. `encode` replaces what is encoded when
   * the caller knows more of its sources than the cue shows (the hook splits a prompt's pasted spans off, D12).
   * `cue` adds the turn's situation (`RecallCue`).
   */
  recall(messages: unknown[], encode?: unknown[], visible: RowFilter = EVERY_ROW, cue: RecallCue = {}): MemoryRecord[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      if (this.consent() === "off") return [];
    } catch {
      return [];
    }
    try {
      const { situation, typed } = cue;
      const text = attachPlaceCues(cueFor(list), placePathsFrom(list)),
        blob = convBlob(list);
      let packet: MemoryRecord[] = [];
      if (!MEMORY_PACKET_MARKS.some((mark) => blob.includes(mark))) {
        // A continuation's prompt ("yes, do it") is chatter by its words: its cue is the proposal it accepts.
        const proposal = situation?.mode === "continuation" ? situation.proposal : undefined;
        let silent = false;
        if (proposal === undefined)
          try {
            silent = (!!text && isNoopCue(text)) || hookLane(text) === "none";
          } catch {}
        packet = !silent && text ? this.notesFor(text, memoryRetrieveCap(), visible, situation) : [];
        try {
          if (packet.length && text && routeMemory(text) === "sf-assemble")
            packet = visible === EVERY_ROW ? assembleNotes(packet, this.dir) : assembleWithin(packet);
        } catch {}
        // A trigger hit is STRONG evidence (A7 §4), so it leads, whatever the lexical path makes of the cue.
        const own = typed ?? typedText(list, encode);
        const said = proposal === undefined ? own : `${own}\n${proposal}`;
        const strong = [...this.triggered(said, visible), ...this.keyed(said, visible)];
        packet = [...strong, ...packet.filter((note) => !strong.some((first) => first.id === note.id))];
        if (packet.length)
          try {
            logMemoryNotes(packet);
          } catch {}
      }
      this.observeCue(list, text, encode ?? list);
      return packet;
    } catch {
      memoryInjectSwallows.n++;
      return [];
    }
  }

  /**
   * A subagent's candidates at SubagentStart (A4 §5.3, `memory-spawn.ts`): the policies and intents of the classes its
   * task and type fit, then what the lexical path finds for its scope's paths. It encodes nothing: SubagentStart
   * carries no text. Fails open like `recall`.
   */
  taskNotes(paths: readonly string[], classes: readonly ActionClass[], visible: RowFilter = EVERY_ROW): MemoryRecord[] {
    try {
      if (this.consent() === "off") return [];
      const triggered = this.triggeredBy(classes, visible);
      const scoped = paths.length ? this.notesFor(paths.join(" "), memoryRetrieveCap(), visible) : [];
      return [...triggered, ...scoped.filter((note) => !triggered.some((rule) => rule.id === note.id))];
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
    this.indexChanged();
    this.flush(true);
  }

  rewriteWhere(pred: (r: MemoryRecord) => string | undefined): void {
    let dirty = false;
    this.compiled = this.compiled.map((c) => {
      const next = pred(c.rec);
      if (typeof next !== "string" || next === c.rec.text) return c;
      dirty = true;
      return compileRow({ ...c.rec, text: next });
    });
    if (dirty) (this.indexChanged(), this.flush(true));
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
      return compileRow(next);
    });
    if (dirty) (this.indexChanged(), this.flush(true));
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

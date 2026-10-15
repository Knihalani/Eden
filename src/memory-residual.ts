/**
 * D26's residual filter (A4 §5.1 step 7): what the conversation already states is dropped (R3). The same test reads
 * D27's shadow set (`memory-shadow.ts`), the instruction files in the window.
 * - An episode or rule: its content-token Jaccard with one sentence of the residual is ≥ 0.6, the two of the same
 *   polarity ("Do not run the migrations" does not state "Run the migrations": content words drop "not").
 * - A slot (D7, P3.3): one of its value's names, asserted (not in a question, no negation before it in its clause:
 *   "not npm", "no longer use postgres"), and one of the slot's aliases in one sentence, or the sentence uses the
 *   value (D7's bare `use V`, "Use pnpm, not npm") when the value's name is in exactly one slot's class and is no
 *   everyday word. A fact's or gist's sentence is read for the slots it states (`slotsIn`); one of no D7 slot that the
 *   legacy copula reader parses keeps that reading, its subject's words standing for aliases.
 * - A legacy row can hold several sentences (a whole prompt, a gist). The residual drops a row whose every sentence
 *   it states (`isResidualNote`): its texts are the conversation's, whose short sentences ("label:") carry too few
 *   content words to strip a row's sentence by. The shadow set's files state items one per line, so it drops each
 *   sentence it states and keeps the rest, as validity drops invalid ones (`unsaidText`).
 *
 * The residual is what the conversation already says: the current prompt, the last 2 typed prompts before it and
 * the assistant text between them, parsed from the complete transcript lines in its last 256 KB. Tool results,
 * attachments, meta lines, non-human submits (D24) and anything before a compaction never count.
 *
 * The same read gives the Submit its other views of the recent conversation (A4 §5.1 step 1): the tool results the
 * paste rule compares the prompt with (A6 §2.1), and the agent's newest message, for when `qprev.json` is older.
 */
import { toolResultText } from "./memory-authority";
import { noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { commonWord, slotAliases, slotsIn, slotsOfName, valueNames, type SlotStatement } from "./memory-slots";
import { contentWords, STATUS_WORDS, tailLines, textOf, typedPrompt, type TranscriptLine } from "./memory-transcript";
import { objectAsserted } from "./semantic-store";
import { MEMORY_PACKET_MARKS } from "./memory-sota";

const TAIL_BYTES = 256 * 1024;
const TYPED_PROMPTS = 2;
const JACCARD = 0.6;
/** The tool results before a prompt that the paste rule reads (A6 §2.1: the last 10 tool calls). */
const RECENT_TOOL_RESULTS = 10;

/** What the conversation just said, from one read of the transcript's tail (see the header). */
export interface RecentConversation {
  /** D26's residual, newest first: the current prompt, the last 2 typed prompts, the assistant text between. */
  residual: string[];
  /** A7 §3's `q_turn`: the typed prompt before the current one, or "" (the current one's line may be written already,
   * R0 F8). */
  previousTyped: string;
  /**
   * The packets Eden gave the turn before the current prompt (transcript `hook_additional_context` attachments since
   * the previous typed prompt), newest first: what A7 §3 strips from `q_prev`.
   */
  delivered: string[];
  /** The tail's last 10 tool results, oldest first. */
  toolResults: string[];
  /** The tail's newest assistant text, and its line's time (epoch ms; 0 when the line has none). */
  lastAssistant?: { text: string; t: number };
  /**
   * The context size the newest assistant `message.usage` reports (input, cache creation and cache read tokens):
   * logged beside the transcript's bytes so A4 §4's distances can be refit (A5 `re-eligibility`).
   */
  contextTokens?: number;
}

/**
 * The text of an Eden packet a hook returned, if the line is one: Claude Code saves a hook's context as a
 * `hook_additional_context` attachment (R0 F5).
 */
function edenPacket(line: TranscriptLine): string | undefined {
  const attachment = line.type === "attachment" ? (line.attachment as Record<string, unknown> | undefined) : undefined;
  if (attachment?.type !== "hook_additional_context") return undefined;
  const content = attachment.content;
  const text = (Array.isArray(content) ? content : [content]).filter((part) => typeof part === "string").join("\n");
  return MEMORY_PACKET_MARKS.some((mark) => text.trimStart().startsWith(mark)) ? text : undefined;
}

/** A line's `message.usage` as one context size, when it has one. */
function usageTokens(line: TranscriptLine): number | undefined {
  const usage = (line.message as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  return count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
}

/** The tail's last tool results, its newest assistant text and its context size (see `RecentConversation`). */
function latest(
  lines: readonly TranscriptLine[],
): Pick<RecentConversation, "toolResults" | "lastAssistant" | "contextTokens"> {
  const toolResults: string[] = [];
  let lastAssistant: RecentConversation["lastAssistant"];
  let contextTokens: number | undefined;
  const done = () => toolResults.length >= RECENT_TOOL_RESULTS && lastAssistant && contextTokens !== undefined;
  for (let at = lines.length - 1; at >= 0 && !done(); at--) {
    const line = lines[at]!;
    if (line.isSidechain === true) continue;
    const tool = toolResults.length < RECENT_TOOL_RESULTS ? toolResultText(line) : undefined;
    if (tool) toolResults.unshift(tool);
    if (line.type !== "assistant") continue;
    contextTokens ??= usageTokens(line);
    if (lastAssistant) continue;
    const text = textOf((line.message as { content?: unknown } | undefined)?.content)?.trim();
    const t = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    if (text) lastAssistant = { text, t: Number.isFinite(t) ? t : 0 };
  }
  return {
    toolResults,
    ...(lastAssistant ? { lastAssistant } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}

/**
 * What the conversation just said (see the header). `typedPrompts` is how many typed prompts back D26's residual
 * reaches: 2 for a window's own turn, every one since the last compaction for a fork subagent, whose context is its
 * parent's whole conversation (A4 §5.3).
 */
export function recentConversation(
  transcriptPath: string,
  prompt: string,
  typedPrompts = TYPED_PROMPTS,
): RecentConversation {
  const current = prompt.trim();
  const residual = current ? [prompt] : [];
  let previousTyped = "";
  let typed = 0;
  let sawCurrent = false;
  const lines = transcriptPath ? tailLines(transcriptPath, TAIL_BYTES) : [];
  const delivered: string[] = [];
  const { toolResults, lastAssistant, contextTokens } = latest(lines);
  for (let at = lines.length - 1; at >= 0 && typed < typedPrompts; at--) {
    const line = lines[at]!;
    if (line.isSidechain === true) continue;
    if (line.isCompactSummary === true || line.subtype === "compact_boundary") break;
    const packet = previousTyped ? undefined : edenPacket(line);
    if (packet) delivered.push(packet);
    if (line.type === "assistant") {
      const text = textOf((line.message as { content?: unknown } | undefined)?.content)?.trim();
      if (text) residual.push(text);
      continue;
    }
    const text = typedPrompt(line);
    if (text === undefined) continue;
    if (text === current && !sawCurrent) {
      sawCurrent = true;
      continue;
    }
    residual.push(text);
    typed++;
    if (!previousTyped) previousTyped = text;
  }
  return {
    residual,
    previousTyped,
    delivered,
    toolResults,
    ...(lastAssistant ? { lastAssistant } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}

function contentTokens(text: string): Set<string> {
  return new Set(contentWords(text));
}

const SENTENCE_BREAK = /(?<=[.!?])\s+|\n+/;

/** A text's sentences, trimmed, as the residual splits them. */
export function sentencesOf(text: string): string[] {
  return text
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Words that make a sentence negative: content words drop them, so Jaccard alone would read "Do not X" as "X". */
const NEGATIVE = /\b(?:not|no|never|don'?t|doesn'?t|isn'?t|aren'?t|won'?t|can'?t|cannot|shouldn'?t|mustn'?t|avoid)\b/;

/**
 * A sentence the window already holds, from the residual (D26) or the shadow set (D27): its content tokens, its
 * polarity, and its lowercased text, which D7's negation and bare `use V` are read from.
 */
export interface Said {
  tokens: Set<string>;
  negative: boolean;
  lower: string;
}

function heldSentence(sentence: string): Said {
  const lower = sentence.toLowerCase();
  return { tokens: contentTokens(sentence), negative: NEGATIVE.test(lower), lower };
}

/** The sentences of texts the window holds, each with its tokens; a sentence with no content word is left out. */
export function residualSentences(texts: readonly string[]): Said[] {
  return texts
    .flatMap(sentencesOf)
    .map(heldSentence)
    .filter((sentence) => sentence.tokens.size > 0);
}

/**
 * Whether one held sentence says a text: the same polarity ("Never force-push" does not say "Always force-push"), and
 * content-token Jaccard ≥ 0.6.
 */
function saidIn(text: Said, sentences: readonly Said[]): boolean {
  return sentences.some(({ tokens: sentence, negative }) => {
    if (negative !== text.negative) return false;
    let shared = 0;
    for (const token of text.tokens) if (sentence.has(token)) shared++;
    return shared / (text.tokens.size + sentence.size - shared) >= JACCARD;
  });
}

/** A fact of no D7 slot, as the legacy copula reader states it: its subject's words and its value. */
interface LegacySlot {
  subject: string;
  value: string;
}

/**
 * The slot a sentence states through the legacy copula reader: a slot-shaped value, one or two tokens and not a
 * status word (D7: a value outside a slot's value class is a single capitalized or identifier-shaped token not in the
 * status lexicon).
 */
function copulaSlot(sentence: string): LegacySlot | undefined {
  let fact: ReturnType<typeof objectAsserted>;
  try {
    fact = objectAsserted(sentence);
  } catch {}
  const value = fact?.o.trim().replace(/[.!?]+$/, "");
  if (!fact || !value || !/^[\w@./+-]+(?: [\w@./+-]+)?$/.test(value)) return undefined;
  if (STATUS_WORDS.has(value.toLowerCase())) return undefined;
  return { subject: fact.s, value };
}

/**
 * A fact read as a slot of its own subject: one whose text the legacy copula reader parses with a slot-shaped value
 * (`copulaSlot`). Since P3.3 a D7 slot's subject is the slot's own label (`objectAsserted`). Any other row is read as
 * an episode.
 */
export function legacySlot(note: ProvenanceNote): LegacySlot | undefined {
  if (noteKindToken(note) !== "fact") return undefined;
  return copulaSlot(stripPacketLabel(String(note.text ?? "")).body);
}

/** Clause breaks within a sentence: D7's `use A, not B` puts B in a clause of its own. */
const CLAUSE_BREAK = /[,;:()—]|\s-\s/;
/**
 * A question asserts nothing: it ends with "?", or opens with a question word or an auxiliary and has no clause break
 * ("When installing packages, use pnpm." is an instruction).
 */
const QUESTION =
  /^(?:what|which|who|whom|whose|where|when|why|how|do|does|did|is|are|was|were|should|can|could|would|will|shall)\b/;
/** Words that, before a value in its clause, say the clause does not assert it (D7: `not`, retractions). */
const NEGATION =
  /\b(?:not|no longer|never|don'?t|doesn'?t|isn'?t|aren'?t|instead of|rather than|without|dropp(?:ed|ing))\b/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a sentence asserts a value: it is not a question, and the value occurs as whole words in a clause with no
 * negation before it. With `bare`, the clause must use it (D7's bare `use V`, `use A not B`, `use A for B`), which
 * states V's slot without its subject.
 */
function asserts(lower: string, value: string, bare: boolean): boolean {
  const sentence = lower.trim();
  if (sentence.endsWith("?") || (QUESTION.test(sentence) && !CLAUSE_BREAK.test(sentence))) return false;
  const found = new RegExp(`(?<![a-z0-9])${escapeRegExp(value.toLowerCase())}(?![a-z0-9])`);
  return lower.split(CLAUSE_BREAK).some((clause) => {
    const at = clause.search(found);
    if (at < 0) return false;
    const before = clause.slice(0, at);
    return !NEGATION.test(before) && (!bare || /\b(?:use|uses|using)\s+(?:the\s+)?$/.test(before));
  });
}

/**
 * D26's slot rule for a fact of no D7 slot (`statesKeyedSlot` reads D7's): one sentence holds the value, asserted,
 * and one of its subject's words, which stand for its aliases. D7's bare `use V` also states it, the value taken to
 * name one slot, the row's.
 */
function statesSlot(slot: LegacySlot, sentences: readonly Said[]): boolean {
  const value = contentTokens(slot.value);
  const subject = contentTokens(slot.subject);
  if (!value.size) return false;
  return sentences.some((sentence) => {
    if (![...value].every((token) => sentence.tokens.has(token))) return false;
    const named = [...subject].some((token) => sentence.tokens.has(token));
    return asserts(sentence.lower, slot.value, !named);
  });
}

/** Whether a held sentence names a text as whole words (lowercase). */
function namedIn(lower: string, text: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(text.toLowerCase())}(?![a-z0-9])`).test(lower);
}

/**
 * D26's slot rule on D7's keys (see the header): a held sentence asserts one of the value's names beside one of the
 * slot's aliases, or uses it bare when the name is in exactly one slot's class and is no everyday word.
 */
function statesKeyedSlot({ slot, value }: SlotStatement, sentences: readonly Said[]): boolean {
  if (value === undefined) return false;
  const names = valueNames(slot, value);
  return sentences.some(({ lower }) => {
    const aliased = slotAliases(slot).some((alias) => namedIn(lower, alias));
    return names.some((name) => {
      if (!namedIn(lower, name)) return false;
      if (aliased) return asserts(lower, name, false);
      return slotsOfName(name).length === 1 && !commonWord(name) && asserts(lower, name, true);
    });
  });
}

/** Kinds whose sentences can state a slot: facts, and the gists that summarize them. */
const SLOT_KINDS = new Set(["fact", "gist"]);

/** Whether one sentence of a note is stated: the slot rule for a slot-shaped sentence of a slot kind, else Jaccard. */
function statedSentence(sentence: string, slotKind: boolean, held: readonly Said[]): boolean {
  const keyed = slotKind ? slotsIn(sentence).filter((stated) => stated.value !== undefined) : [];
  if (keyed.length) return keyed.every((stated) => statesKeyedSlot(stated, held));
  const slot = slotKind ? copulaSlot(sentence) : undefined;
  if (slot) return statesSlot(slot, held);
  const text = heldSentence(sentence);
  return text.tokens.size > 0 && saidIn(text, held);
}

/**
 * A note's text without what the window already states (D26's residual, D27's shadow set): "" when it states all of
 * it, the text itself when it states none, else the note's other sentences under its label. A whole body within
 * Jaccard ≥ 0.6 of one sentence is stated; otherwise sentence by sentence, a fact's or gist's slot-shaped sentences by
 * the slot rule and the rest by Jaccard. A sentence with no content word goes with the rest.
 */
export function unsaidText(note: ProvenanceNote, held: readonly Said[]): string {
  const text = String(note.text ?? "");
  if (!held.length) return text;
  const { label, body } = stripPacketLabel(text);
  const whole = heldSentence(body);
  if (!whole.tokens.size) return text;
  if (!slotsIn(body).length && !copulaSlot(body) && saidIn(whole, held)) return "";
  const slotKind = SLOT_KINDS.has(noteKindToken(note) ?? "");
  const sentences = sentencesOf(body);
  const kept = sentences.filter((sentence) => !statedSentence(sentence, slotKind, held));
  if (kept.length === sentences.length) return text;
  return kept.some((sentence) => contentTokens(sentence).size) ? `${label}${kept.join(" ")}` : "";
}

/** D26: whether the residual states all of a note, read sentence by sentence (`unsaidText`). */
export function isResidualNote(note: ProvenanceNote, sentences: readonly Said[]): boolean {
  const body = stripPacketLabel(String(note.text ?? "")).body;
  return contentTokens(body).size > 0 && !unsaidText(note, sentences);
}

/**
 * D26's residual filter (A4 §5.1 step 7): a bullet the conversation already states is dropped (R3).
 * - An episode or rule bullet: its content-token Jaccard with one sentence of the residual is ≥ 0.6.
 * - A slot bullet: its value and its subject co-occur in one sentence. Until P3.3's slot keys and aliases, a slot
 *   is a fact row with a slot-shaped value (`legacySlot`), and its subject's words stand for its aliases; any other
 *   row is read as an episode.
 *
 * The residual is what the conversation already says: the current prompt, the last 2 typed prompts before it and
 * the assistant text between them, parsed from the complete transcript lines in its last 256 KB. Tool results,
 * attachments, meta lines, non-human submits (D24) and anything before a compaction never count.
 */
import { noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { contentWords, STATUS_WORDS, tailLines, textOf, typedPrompt } from "./memory-transcript";
import { objectAsserted } from "./semantic-store";

const TAIL_BYTES = 256 * 1024;
const TYPED_PROMPTS = 2;
const JACCARD = 0.6;

/** What the conversation just said, from one read of the transcript's tail (see the header). */
export interface RecentConversation {
  /** D26's residual, newest first: the current prompt, the last 2 typed prompts, the assistant text between. */
  residual: string[];
  /** A7 §3's `q_turn`: the typed prompt before the current one, or "" (the current one's line may be written already,
   * R0 F8). */
  previousTyped: string;
}

export function recentConversation(transcriptPath: string, prompt: string): RecentConversation {
  const current = prompt.trim();
  const residual = current ? [prompt] : [];
  let previousTyped = "";
  let typed = 0;
  let sawCurrent = false;
  const lines = transcriptPath ? tailLines(transcriptPath, TAIL_BYTES) : [];
  for (let at = lines.length - 1; at >= 0 && typed < TYPED_PROMPTS; at--) {
    const line = lines[at]!;
    if (line.isSidechain === true) continue;
    if (line.isCompactSummary === true || line.subtype === "compact_boundary") break;
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
  return { residual, previousTyped };
}

function contentTokens(text: string): Set<string> {
  return new Set(contentWords(text));
}

/** The residual's sentences, as content-token sets. */
const SENTENCE_BREAK = /(?<=[.!?])\s+|\n+/;

export function residualSentences(texts: readonly string[]): Set<string>[] {
  return texts
    .flatMap((text) => text.split(SENTENCE_BREAK))
    .map(contentTokens)
    .filter((tokens) => tokens.size > 0);
}

function saidIn(tokens: Set<string>, sentences: readonly Set<string>[]): boolean {
  return sentences.some((sentence) => {
    let shared = 0;
    for (const token of tokens) if (sentence.has(token)) shared++;
    return shared / (tokens.size + sentence.size - shared) >= JACCARD;
  });
}

/**
 * Whether a bullet's text is one the residual already says: content-token Jaccard ≥ 0.6 with one sentence, or, for
 * a bullet of several sentences, so for each of them (a stored row can hold a whole prompt).
 */
export function isResidual(text: string, sentences: readonly Set<string>[]): boolean {
  const body = stripPacketLabel(String(text ?? "")).body;
  const tokens = contentTokens(body);
  if (!tokens.size) return false;
  if (saidIn(tokens, sentences)) return true;
  const parts = body
    .split(SENTENCE_BREAK)
    .map(contentTokens)
    .filter((part) => part.size > 0);
  return parts.length > 1 && parts.every((part) => saidIn(part, sentences));
}

/**
 * A row read as a slot until P3.3's keys: a fact the legacy copula reader parses whose value is slot-shaped, one or
 * two tokens and not a status word (D7: a value outside a slot's value class is a single capitalized or
 * identifier-shaped token not in the status lexicon). Any other row is read as an episode.
 */
export function legacySlot(note: ProvenanceNote): { subject: string; value: string } | undefined {
  const body = stripPacketLabel(String(note.text ?? "")).body;
  if (noteKindToken(note) !== "fact") return undefined;
  let fact: ReturnType<typeof objectAsserted>;
  try {
    fact = objectAsserted(body);
  } catch {}
  const value = fact?.o.trim().replace(/[.!?]+$/, "");
  if (!fact || !value || !/^[\w@./+-]+(?: [\w@./+-]+)?$/.test(value)) return undefined;
  if (STATUS_WORDS.has(value.toLowerCase())) return undefined;
  return { subject: fact.s, value };
}

/** D26 by the row's kind: the slot rule for a slot (`legacySlot`), Jaccard for everything else. */
export function isResidualNote(note: ProvenanceNote, sentences: readonly Set<string>[]): boolean {
  const slot = legacySlot(note);
  if (!slot) return isResidual(stripPacketLabel(String(note.text ?? "")).body, sentences);
  const value = contentTokens(slot.value);
  const subject = contentTokens(slot.subject);
  if (!value.size) return false;
  return sentences.some(
    (sentence) => [...value].every((token) => sentence.has(token)) && [...subject].some((t) => sentence.has(t)),
  );
}

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
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { objectAsserted } from "./semantic-store";
import { isNonHumanSubmit } from "./memory-turn";

const TAIL_BYTES = 256 * 1024;

/** D7's status lexicon: words that describe a state ("auth is failing"), never a slot's value. */
const STATUS = new Set(
  "broken down failing flaky slow fixed working done weird annoying wrong fine ok good bad new old".split(" "),
);
const TYPED_PROMPTS = 2;
const JACCARD = 0.6;

const STOPWORDS = new Set(
  (
    "a an the and or but so then to of in on at for with by from as is are was were be been it its this that these " +
    "those i we you he she they me us my our your their do does did not no can could should would will shall may " +
    "just now please there here what which who when where why how all any some if than too very also into about"
  ).split(" "),
);

type Line = Record<string, unknown>;

/** The complete JSON lines of a file's last `TAIL_BYTES`. */
function tailLines(path: string): Line[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((text) => {
      try {
        const line: unknown = JSON.parse(text);
        return line && typeof line === "object" ? [line as Line] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}

function textBlocks(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => (block as { type?: unknown })?.type === "tool_result")) return undefined;
  return content
    .flatMap((block) => {
      const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

/** A typed prompt's text (R6 §1.2), or undefined for any other user line. */
function typedPrompt(line: Line): string | undefined {
  if (line.isMeta === true || line.isCompactSummary === true || line.origin) return undefined;
  const text = textBlocks((line.message as { content?: unknown } | undefined)?.content)?.trim();
  if (!text || /^(?:<command-|<local-command-|\[Request interrupted)/.test(text) || isNonHumanSubmit(text)) {
    return undefined;
  }
  return text;
}

/** The texts D26 reads as already said, newest first (see the header). */
export function residualTexts(transcriptPath: string, prompt: string): string[] {
  const texts = prompt.trim() ? [prompt] : [];
  let typed = 0;
  const lines = transcriptPath ? tailLines(transcriptPath) : [];
  for (let at = lines.length - 1; at >= 0 && typed < TYPED_PROMPTS; at--) {
    const line = lines[at]!;
    if (line.isSidechain === true) continue;
    if (line.isCompactSummary === true || line.subtype === "compact_boundary") break;
    if (line.type === "assistant") {
      const text = textBlocks((line.message as { content?: unknown } | undefined)?.content)?.trim();
      if (text) texts.push(text);
    } else if (line.type === "user") {
      const text = typedPrompt(line);
      if (text === undefined) continue;
      texts.push(text);
      typed++;
    }
  }
  return texts;
}

/** A7 §3's `q_turn`: the typed prompt before the current one in this window, or "" (the current one's line may be
 * written already, R0 F8). */
export function previousTypedPrompt(transcriptPath: string, prompt: string): string {
  const current = prompt.trim();
  const lines = transcriptPath ? tailLines(transcriptPath) : [];
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at]!;
    if (line.isSidechain === true) continue;
    if (line.isCompactSummary === true || line.subtype === "compact_boundary") break;
    if (line.type !== "user") continue;
    const text = typedPrompt(line);
    if (text !== undefined && text !== current) return text;
  }
  return "";
}

function contentTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  );
}

/** The residual's sentences, as content-token sets. */
export function residualSentences(texts: readonly string[]): Set<string>[] {
  return texts
    .flatMap((text) => text.split(/(?<=[.!?])\s+|\n+/))
    .map(contentTokens)
    .filter((tokens) => tokens.size > 0);
}

/** Whether a bullet's text is one the residual already says: content-token Jaccard ≥ 0.6 with one sentence. */
export function isResidual(text: string, sentences: readonly Set<string>[]): boolean {
  const tokens = contentTokens(stripPacketLabel(String(text ?? "")).body);
  if (!tokens.size) return false;
  return sentences.some((sentence) => {
    let shared = 0;
    for (const token of tokens) if (sentence.has(token)) shared++;
    return shared / (tokens.size + sentence.size - shared) >= JACCARD;
  });
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
  if (STATUS.has(value.toLowerCase())) return undefined;
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

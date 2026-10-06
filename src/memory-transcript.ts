/**
 * What the memory hook's delivery steps share: reading the complete JSON lines at the end of a Claude Code
 * transcript, telling a typed prompt from the other user lines, and the word lists the steps compare with.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isNonHumanSubmit } from "./memory-turn";

export type TranscriptLine = Record<string, unknown>;

/** Function words: never content, never evidence (A7 §4's WEAK), never part of a key. */
export const FUNCTION_WORDS = new Set(
  (
    "a an the and or but so then to of in on at for with by from as is are was were be been it its this that these " +
    "those i we you he she they me us my our your their them do does did not no can could should would will shall " +
    "may just now please there here what which who when where why how all any some more most other such than very " +
    "also only into about have has had"
  ).split(" "),
);

/** D7's status lexicon: words that describe a state ("auth is failing"), never a slot's value. */
export const STATUS_WORDS = new Set(
  "broken down failing flaky slow fixed working done weird annoying wrong fine ok good bad new old".split(" "),
);

/** The content words of a text: lowercased letters and digits, without function words or single characters. */
export function contentWords(text: string): string[] {
  return (
    String(text ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).filter((word) => word.length > 1 && !FUNCTION_WORDS.has(word));
}

/** The complete JSON lines in a file's last `bytes`; [] when it cannot be read. */
export function tailLines(path: string, bytes: number): TranscriptLine[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((text) => {
      try {
        const line: unknown = JSON.parse(text);
        return line && typeof line === "object" ? [line as TranscriptLine] : [];
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

/** A message's text blocks, or undefined for a tool result. */
export function textOf(content: unknown): string | undefined {
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

/** A typed prompt's text (R6 §1.2, A6 §2.1's `user` lines), or undefined for any other line. */
export function typedPrompt(line: TranscriptLine): string | undefined {
  if (line.type !== "user" || line.isMeta === true || line.isCompactSummary === true || line.origin) return undefined;
  const text = textOf((line.message as { content?: unknown } | undefined)?.content)?.trim();
  if (!text || /^(?:<command-|<local-command-|\[Request interrupted)/.test(text) || isNonHumanSubmit(text)) {
    return undefined;
  }
  return text;
}

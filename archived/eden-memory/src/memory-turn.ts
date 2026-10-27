/**
 * Turn mode of a UserPromptSubmit (A7 §2): which submits get no packet, and how the situation cue weighs its parts
 * (`memory-cue.ts`, A7 §3).
 *
 * - `nonhuman` (D24): a task notification, a peer or teammate message, or a session cron firing. No packet, and
 *   the human-turn counter does not advance.
 * - `ack`: chatter after a report ("thanks", or "continue" when the agent proposed nothing). No packet.
 * - `continuation`: "yes, do it", or a short reply to a proposal. The cue's weight moves to the agent's last message
 *   (`q_prev`), and it injects only on STRONG evidence from it (A7 §4).
 * - `debug`: error-shaped text, a failure or a stack trace. Its weights favour the paths and the agent's last message;
 *   its gotcha lane is P4.5's.
 * - `how-to`: a procedure is asked for ("how do I", "set up"). Default weights; its procedure lane is P4.6's.
 * - `question`: ends with `?` or opens with a WH-word. Default weights.
 * - `imperative`: A7's default.
 *
 * Of several, the first in that order wins: a failure is the most specific cue a prompt carries.
 * There is no payload `origin` field (R0 F30), so a non-human submit is recognized by its text.
 */
import { createHash } from "node:crypto";

export type TurnMode = "nonhuman" | "ack" | "continuation" | "debug" | "how-to" | "question" | "imperative";

/**
 * The openers of non-human submits (D24). A peer message's transcript line opens with a one-line preamble before
 * its `<agent-message>` (R0 F34), so the preamble may precede the tag.
 */
const NONHUMAN = new RegExp(
  String.raw`^(Another Claude session sent a message:\s*)?` +
    String.raw`<(task-notification|agent-message|cross-session-message|teammate-message)\b`,
);

/** Which D24 rule a non-human submit matched: its opening tag (`preamble` when R0 F34's line came first), or a cron. */
export type NonHumanKind = { kind: string; preamble?: true };

const ACK = ["ok", "thanks", "cool", "nice", "great", "got it", "sounds good"];
const CONTINUE = ["continue", "keep going", "next", "go on"];
const GO_AHEAD = ["yes", "do it", "go ahead", "proceed"];
/** Longest phrases first, so "go ahead" is read before "go". */
const PHRASES = [...ACK, ...CONTINUE, ...GO_AHEAD].sort((a, b) => b.length - a.length);

/**
 * A trailing question, or an offer to act: the previous assistant message proposed something (A7 §2). "I can" offers
 * an action, not what the agent perceives or concludes ("I can see the bug", "I can confirm it passes": reports).
 */
const PROPOSAL = new RegExp(
  String.raw`\b(?:shall I|want me to|should I|next,? I['’]ll|` +
    String.raw`I can(?!['’]t|not|\s+(?:now\s+)?(?:see|tell|confirm|verify|reproduce|find|spot|imagine|understand)\b))\b`,
  "i",
);

/** A7 §2's error-shaped text: an `ERR_*` code, a `…Error` or `…Exception` name, a stack-trace line. */
const ERROR_SHAPE = new RegExp(
  String.raw`\bERR_[A-Z0-9_]+\b|\b[A-Z]\w*(?:Error|Exception)\b|^\s*at \S.*:\d+(?::\d+)?\)?\s*$|` +
    String.raw`\bTraceback \(most recent call last\)|\bpanic:`,
  "m",
);
/** A7 §2's words of failure: it names "failing", "broken" and "error", each read as its word family ("fails"). */
const FAILURE = /\b(?:fail(?:s|ed|ing|ures?)?|broken|breaks|errors?|exceptions?|crash(?:es|ed|ing)?|stack ?traces?)\b/i;
/** A7 §2's how-to detector. */
const HOW_TO = /\bhow (?:do|can|should|would) (?:i|we|you)\b|\bhow to\b|\brun the tests?\b|\bset(?:ting)? up\b/i;
/** A7 §2's question detector: a trailing `?`, or a WH-word first. */
const QUESTION = /\?\s*$|^\s*(?:what|which|who|whom|whose|when|where|why|how)\b/i;

/**
 * A7 §2's reply filler: words that do not count toward a short reply's "≤ 4 content tokens". It is kept apart from
 * the delivery steps' wider `FUNCTION_WORDS` (memory-transcript.ts) because it decides which replies are
 * continuations; changing it would change those turns.
 */
const REPLY_FILLER = new Set(
  "a an the and or but so then to of in on at for with it its this that is are be me you i we us please just now".split(
    " ",
  ),
);

/** The same 16 hex characters for the same prompt text, so cron prompts are kept as hashes, never as text. */
export function promptHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

/** D24: a submit no human typed. `cronHashes` are the prompt hashes of the window's last Stop `session_crons`. */
export function isNonHumanSubmit(prompt: string, cronHashes: readonly string[] = []): boolean {
  return nonHumanKind(prompt, cronHashes) !== undefined;
}

/** The D24 rule a submit matched, or undefined for a human one. Text-free, so a wide event can hold it. */
export function nonHumanKind(prompt: string, cronHashes: readonly string[] = []): NonHumanKind | undefined {
  const tag = NONHUMAN.exec(prompt.trimStart());
  if (tag) return tag[1] ? { kind: tag[2]!, preamble: true } : { kind: tag[2]! };
  return cronHashes.length > 0 && cronHashes.includes(promptHash(prompt)) ? { kind: "cron" } : undefined;
}

export function isProposal(assistant: string): boolean {
  return assistant.trimEnd().endsWith("?") || PROPOSAL.test(assistant);
}

/** The sentences of an assistant message that propose: an offer to act, or a question (what "yes" accepts). */
export function proposalSentences(assistant: string): string[] {
  const sentences = String(assistant ?? "").split(/(?<=[.!?])\s+|\n+/);
  return sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence && isProposal(sentence));
}

/** The prompt read as A7 §2's chatter phrases, or undefined when any word is not one. */
function chatterPhrases(prompt: string): string[] | undefined {
  let rest = prompt
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const said: string[] = [];
  while (rest) {
    const phrase = PHRASES.find((candidate) => rest === candidate || rest.startsWith(`${candidate} `));
    if (!phrase) return undefined;
    said.push(phrase);
    rest = rest.slice(phrase.length).trim();
  }
  return said.length ? said : undefined;
}

function contentTokens(prompt: string): number {
  const words = prompt.toLowerCase().match(/[a-z0-9][a-z0-9'._/-]*/g) ?? [];
  return words.filter((word) => !REPLY_FILLER.has(word)).length;
}

export function turnMode(
  prompt: string,
  context: { previousAssistant?: string; cronHashes?: readonly string[] } = {},
): TurnMode {
  if (isNonHumanSubmit(prompt, context.cronHashes)) return "nonhuman";
  const proposal = isProposal(context.previousAssistant ?? "");
  const said = chatterPhrases(prompt);
  // A7 §2 counts tokens, so "got it, thanks" is 3 and "sounds good, got it, thanks" is 5.
  if (said && said.join(" ").split(" ").length <= 3) {
    if (said.some((phrase) => GO_AHEAD.includes(phrase))) return "continuation";
    if (said.some((phrase) => CONTINUE.includes(phrase))) return proposal ? "continuation" : "ack";
    return "ack";
  }
  if (proposal && contentTokens(prompt) <= 4) return "continuation";
  if (ERROR_SHAPE.test(prompt) || FAILURE.test(prompt)) return "debug";
  if (HOW_TO.test(prompt)) return "how-to";
  return QUESTION.test(prompt) ? "question" : "imperative";
}

/** Whether a mode is answered: every human mode but chatter. A continuation is answered on STRONG evidence only. */
export function isAnswered(mode: TurnMode): boolean {
  return mode !== "nonhuman" && mode !== "ack";
}

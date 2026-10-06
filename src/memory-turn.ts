/**
 * Turn mode of a UserPromptSubmit (A7 §2), as far as P0.2 needs it: which submits get no packet.
 *
 * - `nonhuman` (D24): a task notification, a peer or teammate message, or a session cron firing. No packet, and
 *   the human-turn counter does not advance.
 * - `ack`: chatter after a report ("thanks", or "continue" when the agent proposed nothing). No packet.
 * - `continuation`: "yes, do it", or a short reply to a proposal. It may inject only on STRONG evidence from the
 *   previous assistant message; that cue part arrives with the situation cue (P4.1), so until then: no packet.
 * - `imperative`: A7's default, which goes to retrieval. P4.1 tells `question`, `debug` and `how-to` apart.
 *
 * There is no payload `origin` field (R0 F30), so a non-human submit is recognized by its text.
 */
import { createHash } from "node:crypto";

export type TurnMode = "nonhuman" | "ack" | "continuation" | "imperative";

/**
 * The openers of non-human submits (D24). A peer message's transcript line opens with a one-line preamble before
 * its `<agent-message>` (R0 F34), so the preamble may precede the tag.
 */
const NONHUMAN = new RegExp(
  String.raw`^(?:Another Claude session sent a message:\s*)?` +
    String.raw`<(?:task-notification|agent-message|cross-session-message|teammate-message)\b`,
);

const ACK = ["ok", "thanks", "cool", "nice", "great", "got it", "sounds good"];
const CONTINUE = ["continue", "keep going", "next", "go on"];
const GO_AHEAD = ["yes", "do it", "go ahead", "proceed"];
/** Longest phrases first, so "go ahead" is read before "go". */
const PHRASES = [...ACK, ...CONTINUE, ...GO_AHEAD].sort((a, b) => b.length - a.length);

/** A trailing question, or an offer to act: the previous assistant message proposed something (A7 §2). */
const PROPOSAL = /\b(?:shall I|want me to|should I|next,? I['’]ll|I can(?!['’]t|not))\b/i;

/** Words that carry no content when counting a reply's content tokens. */
const FUNCTION_WORDS = new Set(
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
  return NONHUMAN.test(prompt.trimStart()) || (cronHashes.length > 0 && cronHashes.includes(promptHash(prompt)));
}

export function isProposal(assistant: string): boolean {
  return assistant.trimEnd().endsWith("?") || PROPOSAL.test(assistant);
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
  return words.filter((word) => !FUNCTION_WORDS.has(word)).length;
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
  return proposal && contentTokens(prompt) <= 4 ? "continuation" : "imperative";
}

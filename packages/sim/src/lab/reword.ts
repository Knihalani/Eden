/**
 * P2 (weak point Q6, docs/research/weak-points-1111.md; docs/research/p2-push-check.md): the train requests reworded
 * into the indirect forms users also write ("Should I book …?", "I need to pay …", "We should move …", "I want you to
 * …"). The world, the planted item, the decoy and every RNG draw are the original suite's: only the request's words
 * change, so cards and intent requests (keyed by item content) replay, and a task pairs with its original by seed,
 * variant and template.
 *
 * Each template takes one form, chosen by a hash of its name, so a suite holds every form and a rerun holds the same
 * ones. A request that does not open with its verb ("When you do Mum's order …", "Dan's last day was Friday, please
 * remove …", "I can't make …") is left as written and counted as not reworded (`rewordOf` returns null).
 */
import { createHash } from "node:crypto";

/** The indirect forms. Each is a lead-in to the imperative's verb, lower-cased; `ask` forms end in a question mark. */
export const REWORD_FORMS = [
  { name: "need", lead: "I need to", ask: false },
  { name: "should-i", lead: "Should I", ask: true },
  { name: "we-should", lead: "We should", ask: false },
  { name: "want-you", lead: "I want you to", ask: false },
  { name: "id-like", lead: "I'd like to", ask: false },
  { name: "lets", lead: "Let's", ask: false },
  { name: "can-i", lead: "Can I", ask: true },
  { name: "have-to", lead: "I have to", ask: false },
  { name: "is-it-ok", lead: "Is it OK to", ask: true },
  { name: "we-need", lead: "We need to", ask: false },
] as const;
export type RewordForm = (typeof REWORD_FORMS)[number]["name"];

/** The form a template takes: a hash of its name, so every seed and variant of a template reads the same form. */
export function formOf(template: string): RewordForm {
  const h = createHash("sha256").update(`p2-reword\n${template}`).digest();
  return REWORD_FORMS[h.readUInt32BE(0) % REWORD_FORMS.length]!.name;
}

/** Openers dropped before the verb: the lead-in replaces them ("Can you message Mum …" → "I need to message Mum …"). */
const OPENER = /^(?:(?:please|pls|hey|hi|ok|okay|so)[,!]?\s+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/i;
/** First words that are not the request's verb: the request is left as written. */
const NOT_VERB = /^(?:when|what|where|which|who|why|how|if|i|i'm|i've|i'd|i'll|we|it|the|this|my|our|[\p{L}]+['’]s)$/iu;

/**
 * The request in `form`, or null when it does not open with its verb. "Book the Golf in for its MOT." with `should-i`
 * reads "Should I book the Golf in for its MOT?"; with `need`, "I need to book the Golf in for its MOT."
 */
export function rewordOf(text: string, form: RewordForm): string | null {
  const f = REWORD_FORMS.find((x) => x.name === form);
  if (!f) throw new Error(`unknown reword form ${form}`);
  const rest = text.trim().replace(OPENER, "");
  const first = rest.split(/\s+/, 1)[0] ?? "";
  if (!first || NOT_VERB.test(first.replace(/[,.;:!?]+$/, ""))) return null;
  // The verb lower-cased; "RSVP" and other all-capital words keep their case.
  const verb = first === first.toUpperCase() ? first : first[0]!.toLowerCase() + first.slice(1);
  let body = `${verb}${rest.slice(first.length)}`;
  if (f.ask) body = `${body.replace(/[.!?\s]+$/, "")}?`;
  return `${f.lead} ${body}`;
}

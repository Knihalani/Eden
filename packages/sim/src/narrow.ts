/**
 * The narrowed question the ask experiments give an agent (docs/research/smart-askctx.md). An agent's `ask_context`
 * is often shorter than the user's request and worded differently: "Globex discount approval?" for "Approve the 15%
 * discount Globex asked for on the renewal." No suite carries the agent's own questions, so one is made from the
 * request, deterministically, as "<main name> <object> <action noun>?". A simulation assumption, labelled as such in
 * every report:
 *
 * - the action: the request's leading verb (past a polite or question opener), as a noun where English has a common
 *   one ("approve" -> "approval"), else the verb itself;
 * - the main name: the request's first capitalised phrase that is not its opening word, a weekday, a month or "I";
 * - the object: the first plain word after the verb's article or possessive ("the order" -> "order"), when it differs.
 *
 * Days, amounts and the rest of the request are dropped, as an agent's narrow question drops them. The word lists are
 * English function words and verb nominalisations, written without reading any suite's planted items.
 */

/** Words a request opens with before its verb: politeness, question openers, the subject. */
const OPENERS = new Set(
  (
    "please can could would will should is it fine ok okay if i we you someone us me do does what what's whats how " +
    "when where which who best way to the a an let's lets just quickly also go ahead and need"
  ).split(" "),
);
/** Common verb nominalisations; any other verb stands as itself. */
const NOUNS: Record<string, string> = {
  approve: "approval",
  book: "booking",
  reserve: "reservation",
  pay: "payment",
  confirm: "confirmation",
  invite: "invitation",
  sign: "signature",
  renew: "renewal",
  submit: "submission",
  accept: "acceptance",
  remind: "reminder",
  set: "setup",
  schedule: "scheduling",
  give: "access",
  raise: "request",
  restart: "restart",
  rerun: "rerun",
  "re-run": "rerun",
  ship: "release",
  take: "time off",
  transfer: "transfer",
  move: "move",
  send: "send",
  order: "order",
  reply: "reply",
  text: "message",
  email: "email",
  forward: "forward",
  draft: "draft",
  offer: "offer",
  ask: "request",
  pick: "choice",
  get: "trip",
};
const DAYS =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|i|i'm|i've|i'll)$/i;
const DETERMINERS = new Set("the a an my our their his her your this that these those".split(" "));
/** Words that are never an object: prepositions, pronouns, quantities. */
const NOT_OBJECT = /^(to|for|from|with|of|on|in|at|by|me|us|them|him|her|it|up|off|out|some|any|anything|\W.*|\d.*)$/i;

export function narrowQuestion(request: string): string {
  const words = request
    .slice(0, 500)
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}£$€#]+|[^\p{L}\p{N}%]+$/gu, ""))
    .filter((w) => w.length > 0);
  let v = 0;
  while (v < words.length - 1 && OPENERS.has(words[v]!.toLowerCase())) v++;
  // A request that opens with something else ("Tyrell Bio says ... Please pay it") acts at its first known verb.
  if (!((words[v]?.toLowerCase() ?? "") in NOUNS)) {
    const k = words.findIndex((w) => w.toLowerCase() in NOUNS);
    if (k >= 0) v = k;
  }
  const verb = (words[v] ?? "").toLowerCase();
  const action = NOUNS[verb] ?? verb;
  // The first capitalised phrase that is not the verb: consecutive capitalised words, at most three.
  let name = "";
  for (let i = 0; i < words.length && !name; i++) {
    const w = words[i]!;
    if (i === v || !/^\p{Lu}/u.test(w) || DAYS.test(w) || OPENERS.has(w.toLowerCase())) continue;
    const run = [words[i]!];
    for (let j = i + 1; j < words.length && run.length < 3 && /^\p{Lu}/u.test(words[j]!) && !DAYS.test(words[j]!); j++)
      run.push(words[j]!);
    name = run.join(" ").replace(/'s$/, "");
  }
  let object = "";
  for (let i = v + 1; i < Math.min(words.length, v + 6) && !object; i++) {
    const w = words[i]!;
    if (DETERMINERS.has(w.toLowerCase()) || /^[£$€\d]/.test(w)) continue;
    if (NOT_OBJECT.test(w) || /^\p{Lu}/u.test(w)) break;
    object = w.toLowerCase().replace(/'s$/, "");
  }
  const parts = [name, object && object !== action ? object : "", action].filter((p) => p.length > 0);
  return `${parts.join(" ")}?`;
}

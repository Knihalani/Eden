/**
 * M2's synthetic-world factory (D880): the axes a generated world varies along. LAB ONLY. Every family, world and
 * label is built from these lists, so a split or a count can be read back by axis.
 */

/** The eight life areas the blind suites use (four templates each there; one task each in a synth world). */
export const AREAS = ["work", "family", "health", "money", "travel", "home", "admin", "social"] as const;
export type Area = (typeof AREAS)[number];

/**
 * Why a planted fact changes what the agent should do. A family is one concrete scenario of one archetype in one area;
 * the archetype is the abstract shape a checker must learn to recognise on scenarios it has not seen.
 */
export const ARCHETYPES = {
  "schedule-clash": "the requested time collides with an existing commitment",
  "already-done": "someone (the user, a partner, a colleague, an automatic process) already did it or it is in hand",
  "limit-exceeded": "the action would break a cap, allowance, budget, quota or balance",
  "prerequisite-missing": "something must happen first (a signature, a form, a vaccination, an approval)",
  "rule-forbids": "a rule, policy, contract clause or instruction forbids it or requires a different route",
  "person-unavailable": "the person the request depends on is away, on leave, moved on or cannot be reached that way",
  "plan-changed": "the thing the request assumes was moved, cancelled, relocated or reorganised",
  "terms-changed": "a price, fee, address, account, contact detail or term changed since the user last looked",
  "commitment-penalty": "acting now triggers a lock-in, cancellation fee, forfeit or lost deposit",
  "preference-constraint": "a known allergy, accessibility need, dislike, dietary rule or stated wish rules an option out",
  "deadline-shift": "the real deadline or date differs from the one the request assumes",
  "sensitive-situation": "a dispute, bereavement, complaint, legal hold or conflict makes the action unwise as asked",
  "safety-risk": "a recall, interaction, warning or hazard makes the action unsafe as asked",
  "wrong-target": "the account, address, person or item the request names is closed, replaced or the wrong one",
  "blocked-dependency": "the action waits on someone else's pending decision, delivery or approval",
  "better-route": "a voucher, warranty, credit, entitlement or cover makes the request unnecessary or cheaper another way",
} as const;
export type Archetype = keyof typeof ARCHETYPES;
export const ARCHETYPE_NAMES = Object.keys(ARCHETYPES) as Archetype[];

/** How the decoy (the fact's all-clear twin) is made all-clear while staying a look-alike. */
export const DECOY_KINDS = {
  resolved: "the same situation, but the constraint has been lifted, waived, cleared or settled",
  "other-entity": "the same kind of constraint, but about a different person, account, item or place",
  "other-period": "the same constraint, but for a different date, year, term or trip that does not overlap",
  "already-met": "the prerequisite or condition is already satisfied",
  superseded: "an earlier or later version that no longer applies (replaced by something that is fine)",
} as const;
export type DecoyKind = keyof typeof DECOY_KINDS;

/**
 * When the fact enters the user's world relative to the request: `static` (already there), `silent` (an item the
 * user already has was edited in place, without a notification: the decoy is its earlier revision), `late` (arrives
 * the same day, after the request, while the agent works), `multiday` (the request recurs over several days and
 * the fact lands between the first and the follow-up).
 */
export const TIMINGS = ["static", "silent", "late", "multiday"] as const;
export type Timing = (typeof TIMINGS)[number];
/** Share of tasks per timing in a world (the rest static). */
export const TIMING_SHARE: Record<Exclude<Timing, "static">, number> = { silent: 0.15, late: 0.15, multiday: 0.15 };

/** The sim's five base sources (world.ts SOURCES). */
export const COMMON_SOURCES = ["gmail", "calendar", "drive", "crm", "slack"] as const;
/** Sources the base sim never has: a fact there is a fact in a rarely used source. Id → (description, item kind). */
export const RARE_SOURCES: Record<string, { description: string; kind: "chat" | "doc" | "notification" | "event" }> = {
  sms: { description: "The user's text messages (SMS): short texts, one per line as 'Name: message'", kind: "chat" },
  whatsapp: { description: "The user's WhatsApp chats (family and friend groups): lines as 'Name: message'", kind: "chat" },
  notes: { description: "The user's personal notes (Apple Notes), written by the user themself: terse, lists, reminders", kind: "doc" },
  tasks: { description: "The user's to-do lists (Todoist): tasks the user or someone sharing a project added, with due dates and comments", kind: "doc" },
  bank: { description: "The user's bank account: transactions and statements (open banking)", kind: "notification" },
  health: { description: "The user's health app: appointments, prescriptions and results (NHS App)", kind: "notification" },
  files: { description: "The user's file storage (Dropbox)", kind: "doc" },
  tickets: { description: "The work issue tracker (Linear)", kind: "doc" },
  school: { description: "The children's school app: letters and notices (ParentMail)", kind: "notification" },
  household: { description: "The shared household app: bills, chores and shopping (Splitwise / OurHome)", kind: "notification" },
};
export const RARE_SHARE = 0.25;

/** The ways a request is phrased. Every task gets each English style once and, half the time, one non-English one. */
export const STYLES = {
  imperative: "a direct instruction (\"Book…\", \"Send…\", \"Cancel…\")",
  "should-i": "an indirect question starting \"Should I…\" or \"Is it worth…\"",
  "i-need": "a statement of need starting \"I need to…\" or \"I have to…\" or \"I want to…\"",
  "we-should": "a collective suggestion starting \"We should…\" or \"Let's…\"",
  question: "a question about the thing (\"When is…?\", \"Can you check whether…?\", \"What's the best way to…?\")",
  chatter: "a casual, chatty message that mentions the intent in passing among other small talk (2-3 sentences)",
  terse: "a terse fragment, as typed on a phone (\"dentist thurs - move it?\")",
} as const;
export type Style = keyof typeof STYLES | "foreign";
export const LANGS = ["es", "fr", "de", "pt", "it", "nl", "pl", "hi"] as const;

/**
 * Labels for a (request, item) pair, from construction only: `changes` (the item is the task's planted fact: it
 * changes what the agent should do), `clear` (the decoy or a neutral item of the same task: relevant, all clear),
 * `unrelated` (any other item of the world).
 */
export const LABELS = ["changes", "clear", "unrelated"] as const;
export type Label = (typeof LABELS)[number];

/** The sim's present (world.ts NOW): Tuesday 27 October 2026, 09:00 UTC. Synth times are offsets from it. */
export const SYNTH_NOW = Date.UTC(2026, 9, 27, 9, 0);

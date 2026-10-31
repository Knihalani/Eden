/**
 * The action firewall's reading of a tool call (`actionCheck`; docs/research/econ-firewall.md). An agent's words can
 * miss what Eden delivered; its actions carry their specifics in structured arguments (the day a table is booked for,
 * the amount paid, who a document is shared with). Before the call runs, its arguments are read as words, with dates
 * written out as the conflict test and the calendar read them, and checked with the request against what is held.
 *
 * Nothing here calls a model or a source, and nothing in the arguments is followed: they are data, matched by fixed,
 * linear patterns over a bounded head.
 */
import { createHash, randomUUID } from "node:crypto";
import { sanitizeForStore } from "@eden/redact";
import { datesIn } from "./conflict";
import { orgLabel } from "./kg";

/** Characters of one argument value read: a long email body's head says what it commits to. */
const VALUE_CHARS = 400;
/** Characters of a whole call read. */
const ACTION_CHARS = 2_000;
/** Characters of a call's arguments, as JSON, its key reads (`actionKey`): calls differing only past them are one. */
const KEY_CHARS = 100_000;
/** Fields nested deeper than this are not read (a call's arguments are flat in practice). */
const MAX_DEPTH = 3;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** An ISO date, with an optional time and zone: "2026-10-29", "2026-10-29T19:00", "2026-10-29 19:00:00Z". */
const ISO = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

/**
 * ISO dates written out as a person writes them ("Thursday 29 October 2026 at 19:00"), the form the engine's day and
 * time readers (`timeWindow`, `requestedSpan`, the conflict test's dates) understand. The time is the user's own, as
 * an action tool's parameters ask for it: a zone suffix is dropped, not converted.
 */
export function writtenDates(text: string): string {
  return text.replace(ISO, (whole, y: string, m: string, d: string, hh?: string, mm?: string) => {
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return whole;
    const at = new Date(Date.UTC(Number(y), month - 1, day));
    if (at.getUTCDate() !== day) return whole;
    const date = `${WEEKDAYS[at.getUTCDay()]} ${day} ${MONTHS[month - 1]} ${y}`;
    return hh !== undefined && Number(hh) < 24 && Number(mm) < 60 ? `${date} at ${hh}:${mm}` : date;
  });
}

/** A parameter name as words: "party_size" is "party size", "dueDate" is "due date". */
const words = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();

/**
 * An argument's value as the secret gate reads it beside its key. Read as words ("password hunter2"), a secret the
 * gate knows only by its key's name is no longer one, so each argument is gated as `"key": value` first: a value
 * the gate redacts there and not alone (it was a secret by its key) is replaced whole; one it redacts alone too is
 * kept, as the later gate over the whole text will redact it the same way.
 */
function gated(key: string, value: unknown, text: string): string {
  let pair: string;
  try {
    pair = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  } catch {
    pair = `${JSON.stringify(key)}: ${JSON.stringify(text)}`;
  }
  if (sanitizeForStore(pair) === pair) return text;
  return sanitizeForStore(text) === text ? "[REDACTED]" : text;
}

/**
 * A tool call read as words: the tool's name, then each argument as "name value", dates written out (`writtenDates`).
 * A date and a time given apart ("date": "2026-10-31", "time": "19:30") are joined ("on Saturday 31 October 2026 at
 * 19:30"), so the time is read as the day's. Bounded: `VALUE_CHARS` per value, `ACTION_CHARS` in all.
 */
export function actionText(tool: string, input: unknown, options: { prose?: boolean } = {}): string {
  const prose = options.prose ?? true;
  const parts: string[] = [words(tool.slice(0, 100))];
  if (typeof input === "string") {
    parts.push(input.slice(0, VALUE_CHARS));
  } else if (input && typeof input === "object") {
    const flat: [string, string][] = [];
    const walk = (key: string, v: unknown, depth: number) => {
      if (flat.length >= 32 || depth > MAX_DEPTH || v === null || v === undefined || v === "") return;
      if (Array.isArray(v)) {
        const items = v.slice(0, 16).filter((x) => typeof x !== "object" || x === null);
        if (items.length) flat.push([key, gated(key, items, items.map(String).join(", "))]);
        for (const x of v.slice(0, 16)) if (x && typeof x === "object") walk(key, x, depth + 1);
      } else if (typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 32)) walk(k, x, depth + 1);
      } else if (prose || !PROSE.test(key)) {
        flat.push([key, gated(key, v, String(v))]);
      }
    };
    walk("", input, 0);
    const date = flat.find(([k]) => /^(date|day|on)$/i.test(k));
    const time = flat.find(([k]) => /^(time|at)$/i.test(k));
    const joined = date && time && /^\d{4}-\d{2}-\d{2}$/.test(date[1].trim()) && /^\d{1,2}:\d{2}$/.test(time[1].trim());
    for (const [k, v] of flat) {
      if (joined && (k === date[0] || k === time[0])) continue;
      parts.push(`${words(k)} ${v.slice(0, VALUE_CHARS)}`.trim());
    }
    if (joined) parts.push(`on ${date[1].trim()}T${time[1].trim().padStart(5, "0")}`);
  }
  return writtenDates(parts.join("\n").slice(0, ACTION_CHARS));
}

/** Parameters that set when a call's commitment happens: a booking's or an event's start. */
const WHEN = /^(?:start|start_?time|starts?_?at|time|when|at|datetime|date_?time|begin|from)$/i;

/**
 * Whether a call commits the user at a time (a parameter that says when it starts): only such a call can clash with
 * the calendar. An email that mentions Saturday at 7pm books nothing then.
 */
export function setsTime(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return Object.entries(input as Record<string, unknown>).some(
    ([k, v]) => WHEN.test(k) && (typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined),
  );
}

/**
 * Free-text fields: what the agent writes (an email's body, a booking's notes), not what the call commits to. The
 * cue the firewall checks is read without them (`actionText` with `prose: false`): a long body ties every item that
 * shares its words. They are read to see whether the call already accounts for a finding (`accounts`).
 */
const PROSE = /^(?:body|text|content|message|description|notes?|comments?|summary|html|markdown)$/i;

/**
 * Families of decisive words: what a finding says that changes the action (an allergy, an absence, a thing done, a
 * hold, an expiry, a move, a confidentiality, an approval rule, someone gone), each with the words a call that took it
 * into account would use. Matched as word starts, lower case.
 */
const FAMILIES: { item: RegExp; call: RegExp }[] = [
  {
    item: /\b(?:allerg|anaphyla|intoleran|coeliac|celiac|vegan|vegetarian|gluten)/,
    call: /\b(?:allerg|anaphyla|intoleran|coeliac|celiac|vegan|vegetarian|gluten|dairy-free|nut-free)/,
  },
  {
    item: /\b(?:on leave|annual leave|parental leave|sick leave|out of (?:the )?office|is away|i'm away|off sick)/,
    call: /\b(?:leave|away|out of (?:the )?office|ooo|absen|covering|cover for)/,
  },
  {
    item: /\b(?:already|was paid|been paid|payment sent|was sent on|been sent|been submitted|paid in full)/,
    call: /\b(?:already|duplicate|been paid|was paid|paid on|previously)/,
  },
  {
    item: /\b(?:freeze|frozen|embargo|on hold|suspended|blocked|paused|no production)/,
    call: /\b(?:freeze|frozen|embargo|on hold|suspend|block|paus)/,
  },
  { item: /\b(?:expire|expired|expires|lapsed|lapses)/, call: /\b(?:expir|lapse|renew)/ },
  {
    item: /\b(?:moved|rescheduled|postponed|new address|moved in|now at)/,
    call: /\b(?:moved|reschedul|postpon|new address|new time)/,
  },
  { item: /\b(?:confidential|internal only|strictly internal)/, call: /\b(?:confidential|internal only|nda|redact)/ },
  {
    item: /\b(?:approval|pre-?approv|sign-?off|countersign|threshold|policy)/,
    call: /\b(?:approval|pre-?approv|sign-?off|countersign|threshold|policy)/,
  },
  {
    item: /\b(?:no longer|left the company|has left|departed|deactivated|offboarded)/,
    call: /\b(?:no longer|has left|departed|successor)/,
  },
];

/**
 * Whether a call already takes a finding into account: a family of decisive words the item uses (`FAMILIES`), used by
 * the call's own arguments and not by the request (a booking whose notes say "one guest has coeliac disease", an
 * email that says "while Sam is on leave"). Then the agent knows, and the finding would only repeat it. A call that
 * names the same invoice or person without such a word ("approve INV-4006" against "INV-4006 was paid") does not.
 */
export function accounts(itemText: string, callText: string, requestText: string): boolean {
  const item = itemText.slice(0, 3_000).toLowerCase();
  const call = callText.toLowerCase();
  const request = requestText.toLowerCase();
  return FAMILIES.some((f) => f.item.test(item) && f.call.test(call) && !f.call.test(request));
}

/**
 * What makes a span a constraint on the days it covers: someone away, a freeze or hold, a closure, a pause. A thing
 * done on a day ("the payment was sent on Tuesday 27 Oct") constrains nothing on that day.
 */
const UNAVAILABLE =
  /\b(?:leave|away|out of (?:the )?office|ooo|off sick|holiday|vacation|travell?ing|abroad|no signal|offline|jury|freeze|frozen|embargo|on hold|closed|unavailable|not available|suspend|block|paus|no (?:[a-z-]+ ){0,2}(?:changes|deploys|releases|hiring|headcount|public)|until)/;

/** Notices that bind no one ("Please do not reply to this email"). */
const BOILERPLATE = /\b(?:do not rep|don't rep|no-?reply|unsubscribe|notification (?:settings|preferences))/;

/** Whether a sentence names a party: as written, or squashed ("tyrellbio" for an address at tyrellbio.com). */
function namesIn(sentence: string, name: string): boolean {
  if (sentence.includes(name)) return true;
  return !name.includes(" ") && name.length >= 5 && sentence.replace(/[^a-z0-9]/g, "").includes(name);
}

/** The organisations a call writes to, by the domains of the addresses in it ("tyrellbio" for aiko@tyrellbio.com). */
export function domainsOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.slice(0, 4_000).matchAll(/[\w.+-]{1,64}@([\w-]{1,63}(?:\.[\w-]{1,63}){1,4})/g)) {
    const label = orgLabel(m[1]!);
    if (label) out.add(label);
  }
  return [...out];
}

/** An expiry or a deadline: a limit day in such a sentence before the day a call acts on binds it. */
const EXPIRY = /\b(?:expir|lapse|valid (?:to|until)|deadline|no later than)/;
/** A limit on an amount, in a currency or a percentage ("over £25,000", "up to 10%"). */
const AMOUNT_LIMIT =
  /\b(?:above|over|exceeds?|exceeding|more than|in excess of|up to|at most|maximum|max|no more than|capped at|cap of|limit of|threshold of)\s?([£€$])?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m)?\b\s?(%)?/g;

/**
 * Whether a sentence limits an amount below one the call commits, in the same unit, and shares a word of four letters
 * or more with the call (`ties`): "purchase orders above £25,000" for a £48,000 purchase order, not "travel over £500"
 * for an £80,000 deal.
 */
function overLimit(
  sentence: string,
  amounts: readonly { unit: string; value: number }[],
  ties: ReadonlySet<string>,
): boolean {
  const words = sentence.match(/[a-z][a-z0-9'-]{3,}/g) ?? [];
  if (!words.some((w) => ties.has(w) || ties.has(w.replace(/s$/, "")))) return false;
  for (const m of sentence.matchAll(AMOUNT_LIMIT)) {
    const unit = m[4] ?? m[1];
    if (!unit) continue;
    const scale = m[3] === "k" ? 1_000 : m[3] === "m" ? 1_000_000 : 1;
    const limit = Number(m[2]!.replace(/,/g, "")) * scale;
    if (amounts.some((a) => a.unit === unit && a.value > limit)) return true;
  }
  return false;
}
/**
 * Statements that bind a party the call names, whenever they were made: a prohibition or a suspension, a thing done
 * already or by mistake, a plan moved, an absence, a confidentiality or a recusal. "I can't do anything before 19:00"
 * is not among them ("can't" alone says too little), nor a "please do not" cut off before what it forbids.
 */
const BINDS_PARTY = new RegExp(
  [
    "\\b(?:confidential|strictly internal|internal only|recused|(?:do not|don't|must not) [a-z]",
    "nobody should|no one should|not allowed|prohibited|suspended",
    "already (?:been |paid|sent)|by mistake|nothing (?:further|more) (?:is )?owed|was paid|been paid",
    "push(?:ed)? (?:[a-z']+ ){0,3}to|moved to|rescheduled|postponed|jury service|on leave|out of (?:the )?office)",
  ].join("|"),
);
/** A diet or an allergy binds a party only for what they will eat or be given (a table, an order, a gift). */
const DIET = /\b(?:allerg|anaphyla|intoleran|coeliac|celiac|vegan|vegetarian|no-gifts?)/;
const FOOD =
  /\b(?:restaurant|table|dinner|lunch|breakfast|brunch|meal|menu|food|cater|chocolate|cake|hamper|gift|flowers|wine|drinks|order)/;

/**
 * Whether a conflict the conflict test read is tied to the call by its structure, not only by shared words: a span in
 * which someone or something is unavailable covers a day the call acts on; an expiry or deadline it states falls
 * between now and that day; it limits an amount below one the call commits, in the same unit and on the call's topic;
 * or it binds a party the call names (`BINDS_PARTY`, or a diet or allergy when the call is food or a gift, `call`;
 * `names`, lower case: people, and organisations by name or by the domain of an address the call writes to). A name
 * and a weak blocking word alone ("Leila: I can't do anything before 19:00 that day") are no tie. Every check is
 * linear in the item's head.
 */
export function structuralTie(
  itemText: string,
  frame: {
    days: string[];
    named: boolean;
    amounts: readonly { unit: string; value: number }[];
    wordTies?: ReadonlySet<string>;
  },
  names: readonly string[],
  now: number,
  call = "",
): boolean {
  const food = FOOD.test(call.toLowerCase());
  const text = itemText
    .slice(0, 3_000)
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-");
  const today = new Date(now).toISOString().slice(0, 10);
  const last = frame.days.at(-1) ?? today;
  // The item names a party the call names (its sender's signature, its subject): its binding statements are theirs.
  const party = names.some((n) => n.length > 2 && namesIn(text, n));
  for (const sentence of text.split(/[.!?;\n]+\s|\n+/)) {
    if (BOILERPLATE.test(sentence)) continue;
    const { spans, limits } = datesIn(sentence, now);
    const over = (sp: { from: string; to: string }) => frame.days.some((d) => d >= sp.from && d <= sp.to);
    if (frame.named && UNAVAILABLE.test(sentence) && spans.some(over)) return true;
    if (EXPIRY.test(sentence) && limits.some((l) => l >= today && l <= last)) return true;
    if (frame.amounts.length > 0 && overLimit(sentence, frame.amounts, frame.wordTies ?? new Set())) return true;
    if (party && (BINDS_PARTY.test(sentence) || (food && DIET.test(sentence)))) return true;
  }
  return false;
}

/**
 * A call's identity within a session: the tool and its arguments (key order ignored), read through the secret gate
 * first (`sanitizeForStore`), as everything Eden keeps is: the session keeps this digest, and a digest of a raw token
 * is a test of a guess at it. Two calls differing only in a secret are one call. A call the firewall answered with a
 * finding and the agent then makes again unchanged is the agent's informed choice: it proceeds.
 */
export function actionKey(tool: string, input: unknown): string {
  // What JSON cannot hold is written so it still tells calls apart: an in-process caller can pass a BigInt or a
  // cycle, and a constant fallback ("[object Object]") would make every such call to a tool a repeat of the first.
  const stable = (v: unknown, depth = 0, seen: object[] = []): unknown => {
    if (typeof v === "bigint") return `${v}n`;
    if (depth > MAX_DEPTH || v === null || typeof v !== "object") return v;
    if (seen.includes(v)) return "[cycle]";
    const path = [...seen, v];
    if (Array.isArray(v)) return v.slice(0, 64).map((x) => stable(x, depth + 1, path));
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, stable(x, depth + 1, path)]),
    );
  };
  let body = "";
  try {
    body = JSON.stringify(stable(input)) ?? "";
  } catch {
    // A value whose own toJSON throws: a key no other call shares, so the call is never taken for a repeat.
    body = randomUUID();
  }
  return createHash("sha256")
    .update(`${tool}\u0000${sanitizeForStore(body.slice(0, KEY_CHARS))}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * The grounds a finding may stand on: what the request's and the call's structure says would change the action (a
 * clash in the calendar at the time it books, a conflict the conflict test reads, the graph's or a card's, someone
 * away on the day). Never "an item about the same thing" (the fallback, a person's latest thread, a day's events):
 * those inform a reply, but holding an action needs a reason.
 */
export const FIREWALL_GROUNDS: ReadonlySet<string> = new Set(["clash", "conflict", "graph", "card", "away"]);

/** Findings a session remembers (their calls' keys), so a call made again after a finding proceeds. */
export const MAX_CHECKED = 32;

/**
 * Folding echoes out of a packet (`densePacket`): one occurrence, one line.
 *
 * A user's sources keep several copies of the same occurrence: the calendar event, the invitation mail for it, the
 * reply that booked it ("Perfect, booked Hoppers for Friday 19:00"), the airline's confirmation beside the flight on
 * the calendar. A packet that cites all three spends most of its bytes saying one thing three times. An item is an
 * echo of one ranked above it in the packet when both pin the same weekday and time (an occurrence anchor: "Monday 2
 * Nov, 18:00", "Monday at 18:00", "@ Monday 2 Nov 18:00") and it adds nothing the user's own items make rare: every
 * word it holds that the kept items and the request do not is common in the user's items ("perfect", "booked"), and
 * there are few of them. A number, a time or an amount it adds keeps it, and so does a word that says the
 * occurrence changed or is constrained ("moved", "cancelled", "instead", "not before", "leave by"): an update is not
 * an echo. No model; the anchor is read from the text, so it works across connectors that format events alike.
 */
import type { ContextItem } from "@eden/protocol";
import { messageParts } from "./render";
import { isStopword } from "./text";

/** At most this many words new to the packet, all of them common, for an item to be an echo. */
const ECHO_NOVEL = 8;
const WEEKDAY =
  "(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs?|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\b\\.?,?";
/**
 * A weekday, an optional date and year, and a time ("Monday 2 Nov 2026, 18:00", "Fri at 19:00", "Mon 2 Nov ⋅
 * 18:00"). Every quantifier is bounded and the pieces cannot overlap, so a scan is linear.
 */
const ANCHOR = new RegExp(
  `\\b${WEEKDAY}(?: \\d{1,2}(?:st|nd|rd|th)?(?: [a-z]{3,9}\\.?)?(?:,? \\d{4})?,?)?(?: (?:at|@|⋅|from|-|–))? (\\d{1,2})[:.](\\d{2})\\b`,
  "gi",
);
/** "18:00–19:30": the end of a range says how long, not which occurrence; it is read as the start alone. */
const RANGE = /(\d{1,2}[:.]\d{2}) ?[–-] ?\d{1,2}[:.]\d{2}/g;
const TOKEN = /\d{1,2}:\d{2}|[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
/** A change or a constraint: an item saying one is never folded into the occurrence it changes. */
const CHANGE =
  /\b(mov(e|ed|ing)|resched\w*|postpon\w*|cancel\w*|delay\w*|instead|chang(e|ed|ing)|updated?|no longer|not|never|cannot|unable|only|until|before|after|by|latest|earliest|leave|late|early|push(ed)?)\b|n['’]t\b/i;
/** Field names and subject markers: the shape of an item, not what it says. */
const LABELS = new Set(["when", "where", "attendees", "invitation", "re", "fw", "fwd", "accepted", "subject"]);
const SHORT_DAY: Record<string, string> = {};
for (const d of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
  for (const k of [d, d.slice(0, 3), d.slice(0, 4)]) SHORT_DAY[k] = d.slice(0, 3);
}

export interface FoldOptions {
  /** The request's words (lowercased): the agent has them. */
  focus: ReadonlySet<string>;
  /** The current year: dropped from day-and-month dates, as compaction does ("Wed 4 Nov 2026" is "Wed 4 Nov"). */
  year?: number;
  /** The user's own name (`ItemCache.selfOf`): on most of their items, never news. */
  self?: string | null;
  /** Whether a word is rare in the user's items (a name, a place, a constraint) rather than common to many. */
  rare: (word: string) => boolean;
}

/**
 * The items to show, in their order: each one that echoes an item kept above it (same occurrence, nothing rare to
 * add) left out. The first item is always kept. A packet with no occurrence on two items has no echo: it is returned
 * as it is (the same array).
 */
export function foldEchoes<T extends { item: ContextItem }>(xs: T[], o: FoldOptions): T[] {
  if (xs.length < 2) return xs;
  const owns = xs.map((x) => ownOf(x.item, o.self, o.year));
  const texts = owns.map((w) => w.own);
  // Each item's anchors are read once with its own text (D1920): the same items are folded packet after packet.
  const pinned = owns.map((w) => (w.anchors ??= anchorsOf(w.own)));
  // An echo shares an anchor with an item above it: with no anchor on two items there is none, and no item's words
  // need reading (the costly part). Most packets pin no occurrence twice.
  if (!repeats(pinned)) return xs;
  const selfWords = new Set((o.self ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  const words = new Set<string>();
  const anchors = new Set<string>();
  const kept: T[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const said = texts[i]!;
    const mine = pinned[i]!;
    const tokens = tokensOf(said).filter((w) => !selfWords.has(w));
    const novel = tokens.filter((w) => !words.has(w) && !o.focus.has(w));
    const names = namesOf(said);
    const echo =
      kept.length > 0 &&
      mine.some((a) => anchors.has(a)) &&
      !CHANGE.test(said) &&
      novel.length <= ECHO_NOVEL &&
      novel.every((w) => !/\d/.test(w) && !names.has(w) && !o.rare(w));
    if (!echo) kept.push(x);
    for (const w of tokens) words.add(w);
    for (const a of mine) anchors.add(a);
  }
  return kept;
}

/** Whether one anchor is on two items (`anchorsOf` gives each item's anchors once). */
function repeats(pinned: string[][]): boolean {
  const seen = new Set<string>();
  for (const mine of pinned) {
    for (const a of mine) {
      if (seen.has(a)) return true;
      seen.add(a);
    }
  }
  return false;
}

/** What folding reads of an item for one `self` and `year`. */
interface Own {
  text: string;
  title: string;
  self: string | null | undefined;
  year: number | undefined;
  /** The item's title and its own message's parts (no headers, no quoted thread), as compaction reads them. */
  own: string;
  /** `anchorsOf(own)`, read on first use and shared: never changed by a reader. */
  anchors?: string[];
}

/** An item's `Own` for these arguments: the one held when its text and title are as they were read. */
function ownOf(item: ContextItem, self?: string | null, year?: number): Own {
  const was = OWN.get(item);
  if (was && was.text === item.text && was.title === item.title && was.self === self && was.year === year) {
    return was;
  }
  const parts = messageParts(item.text, undefined, year, self, { title: item.title });
  const own = [item.title, ...parts.filter((p) => !p.header && !p.quoted).map((p) => p.text)].join("\n");
  const read: Own = { text: item.text, title: item.title, self, year, own };
  OWN.set(item, read);
  return read;
}

/**
 * `ownOf` per item object, for the arguments it was read with: the same items are delivered again and again, and
 * reading a message's parts is most of folding's cost. Held weakly, so an entry goes with its item (a cache's stored
 * copy, which belongs to one user); an item whose text or title changed in place is read again, anchors and all.
 */
const OWN = new WeakMap<ContextItem, Own>();

/** The occurrences a text pins: "mon|18:00" for each weekday-and-time it names. */
export function anchorsOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ANCHOR)) {
    const day = m[1]!.toLowerCase().slice(0, 3);
    out.add(`${day}|${m[2]!.padStart(2, "0")}:${m[3]}`);
  }
  return [...out];
}

/**
 * The words a text capitalises inside a sentence (lowercased): names and places ("booked St. John", "with Dana"),
 * which say which occurrence, however often the user's items hold them. A sentence's first word, a subject's marker
 * ("Re:", "Invitation:"), weekdays and months are not names.
 */
function namesOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    for (const m of line.replace(SUBJECT_MARK, "").matchAll(NAME)) {
      const w = m[0].toLowerCase().replace(/['’]s$/, "");
      if (!SHORT_DAY[w] && !MONTHS.has(w)) out.add(w);
    }
  }
  return out;
}

const SUBJECT_MARK = /^((re|fwd?|invitation|updated invitation|accepted):\s*)+/i;
// A capitalised word after a word, a comma or a dash in the same sentence: not one that starts it.
const NAME = /(?<=[\p{L}\p{N},;)–—-] )\p{Lu}[\p{L}'’-]*/gu;
// Month names, whole or short ("May" alone is a month here: a person named May is named with a surname, too).
const MONTHS = new Set(
  "jan january feb february mar march apr april may jun june jul july aug august sep sept september oct october nov november dec december".split(
    " ",
  ),
);

/** Distinct content words, times as one word, weekdays as their first three letters. */
function tokensOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.replace(RANGE, "$1").toLowerCase().matchAll(TOKEN)) {
    let w = m[0].replace(/['’]s$/, "");
    if (/^\d:\d{2}$/.test(w)) w = `0${w}`;
    w = SHORT_DAY[w] ?? w;
    if ((w.length < 2 && !/\d/.test(w)) || isStopword(w) || LABELS.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

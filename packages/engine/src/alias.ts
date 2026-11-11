/**
 * `aliasTerms` (P3, D833; a trial, off; docs/research/p3-baselines.md §3): the other written forms of an item's dates
 * and first names, indexed with the item so a request that writes them another way finds it. No model, nothing stored:
 * the forms are derived from the item's own text each time it is indexed (`ItemCache.index`), so a thaw, a reindex or
 * a restart derives them again.
 *
 * - Dates: "Thu 10 Dec", "Sun 08 Nov", "Dec 10" also index `thursday`, `december`, `10` (a day number unpadded), so
 *   "Thursday 10 December" or "Sunday 8 November" matches on every word. Only inside a day-and-month date: a bare "08"
 *   or "Dec" elsewhere is left as written.
 * - First names: "Alexander" also indexes `alex`, "Rebecca" `becky` and `becca`, and an unambiguous nickname the item
 *   writes ("Becky") its full forms, so a request naming the person the other way finds the item. Capitalised names
 *   only, and only the reverse forms that are not also ordinary words ("Will", "Bill", "Pat" are left alone).
 *
 * The query is never changed, so an item holding only the other form scores as one holding the request's word, and
 * every search (ranked, every-word, probes) sees it the same way.
 */

const MONTHS: Record<string, string> = {
  jan: "january",
  feb: "february",
  mar: "march",
  apr: "april",
  may: "may",
  jun: "june",
  jul: "july",
  aug: "august",
  sep: "september",
  sept: "september",
  oct: "october",
  nov: "november",
  dec: "december",
};
const DAYS: Record<string, string> = {
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
};

// Whole month and weekday words only ("Decided 3" and "sat 3" before a non-month are not dates).
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|" +
  "nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY =
  "(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
/** "[Thu[,]] 10[th] Dec[ember]" and "[Thu[,]] Dec[ember] 10[th]": a day and a month, an optional weekday before. */
const DAY_MONTH = new RegExp(`\\b(?:${WEEKDAY}\\.?,?\\s+)?0?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "gi");
const MONTH_DAY = new RegExp(`\\b(?:${WEEKDAY}\\.?,?\\s+)?${MONTH}\\.?\\s+0?(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");

/** Full first names and the nicknames they are also written as. */
const NICKNAMES: Record<string, readonly string[]> = {
  alexander: ["alex", "sasha"],
  alexandra: ["alex", "sasha", "lexi"],
  rebecca: ["becky", "becca", "bex"],
  robert: ["rob", "bob", "bobby", "robbie"],
  william: ["will", "bill", "billy", "liam"],
  elizabeth: ["liz", "beth", "lizzie", "eliza"],
  katherine: ["kate", "kath", "katie", "kat"],
  catherine: ["kate", "cath", "cathy", "katie"],
  jennifer: ["jen", "jenny"],
  michael: ["mike", "mick", "mikey"],
  christopher: ["chris", "kit"],
  christine: ["chris", "chrissie"],
  nicholas: ["nick", "nicky"],
  nicola: ["nicky", "nikki"],
  jonathan: ["jon", "jonny"],
  benjamin: ["ben", "benji"],
  daniel: ["dan", "danny"],
  danielle: ["dani"],
  samuel: ["sam", "sammy"],
  samantha: ["sam", "sammy"],
  thomas: ["tom", "tommy"],
  james: ["jim", "jimmy", "jamie"],
  joseph: ["joe", "joey"],
  josephine: ["jo", "josie"],
  joanna: ["jo"],
  matthew: ["matt"],
  andrew: ["andy", "drew"],
  anthony: ["tony", "ant"],
  edward: ["ed", "eddie", "ted"],
  richard: ["rich", "rick", "richie"],
  margaret: ["maggie", "meg", "peggy"],
  patricia: ["pat", "patty", "trish"],
  victoria: ["vicky", "tori"],
  stephen: ["steve"],
  steven: ["steve"],
  timothy: ["tim"],
  gregory: ["greg"],
  jessica: ["jess", "jessie"],
  deborah: ["deb", "debbie"],
  susan: ["sue", "susie"],
  nathaniel: ["nate", "nat"],
  natalie: ["nat"],
  zachary: ["zach", "zac"],
  abigail: ["abby", "abi"],
  frederick: ["fred", "freddie"],
  theodore: ["theo", "ted"],
  isabella: ["izzy", "bella"],
  isabel: ["izzy"],
  eleanor: ["ellie", "nell"],
  charlotte: ["charlie", "lottie"],
  charles: ["charlie", "chuck"],
  henry: ["harry", "hal"],
  lawrence: ["larry", "laurie"],
  raymond: ["ray"],
  ronald: ["ron", "ronnie"],
  donald: ["don", "donnie"],
  kenneth: ["ken", "kenny"],
  gerald: ["gerry"],
  oliver: ["ollie"],
  olivia: ["liv", "livvy"],
  sophia: ["sophie"],
  philip: ["phil"],
  phillip: ["phil"],
  peter: ["pete"],
  david: ["dave", "davey"],
  gabriel: ["gabe"],
  gabriella: ["gabby", "ella"],
  emily: ["em", "emmy"],
  amanda: ["mandy"],
  rosemary: ["rosie"],
  georgina: ["georgie", "gina"],
  francesca: ["fran", "frankie"],
  francis: ["frank", "fran"],
  harriet: ["hattie"],
  leonard: ["leo", "len", "lenny"],
  vincent: ["vince", "vinny"],
  benedict: ["ben"],
  matilda: ["tilly", "tilda"],
  imogen: ["immy"],
  penelope: ["penny"],
  dominic: ["dom"],
  sebastian: ["seb", "bash"],
  cameron: ["cam"],
  maximilian: ["max"],
  maxwell: ["max"],
  johnathan: ["john"],
  jacqueline: ["jackie"],
  louisa: ["lou"],
  louise: ["lou"],
  lucinda: ["lucy"],
};

/** Nicknames that are also ordinary words or common short forms of several names: never read back to a full name. */
const AMBIGUOUS = new Set([
  "will",
  "bill",
  "pat",
  "sam",
  "ben",
  "jo",
  "ray",
  "don",
  "sue",
  "rob",
  "rich",
  "kit",
  "nat",
  "em",
  "ed",
  "ted",
  "ant",
  "hal",
  "max",
  "lou",
  "frank",
  "dom",
  "cam",
  "bash",
  "kat",
  "deb",
  "chuck",
  "fred",
  "nell",
  "ella",
  "len",
]);

const REVERSE = (() => {
  const out = new Map<string, Set<string>>();
  for (const [full, nicks] of Object.entries(NICKNAMES)) {
    for (const n of nicks) {
      if (AMBIGUOUS.has(n)) continue;
      let s = out.get(n);
      if (!s) out.set(n, (s = new Set()));
      s.add(full);
    }
  }
  return out;
})();

/** A capitalised word, read whole (a name starts upper case; "will" the verb does not). */
const NAME = /\b[A-Z][a-z]{1,15}\b/g;

/** How much of an item's text is read for its forms: a long body's head carries its header, dates and names. */
const ALIAS_CHARS = 4_000;
/** At most this many forms an item: bounds what one item adds to the index. */
const MAX_FORMS = 48;

/**
 * The other forms of the dates and first names `text` writes, space-joined (empty when there are none). A form the
 * text already holds as written is not repeated.
 */
export function aliasTerms(text: string): string {
  const head = text.length > ALIAS_CHARS ? text.slice(0, ALIAS_CHARS) : text;
  const lower = head.toLowerCase();
  const forms = new Set<string>();
  const add = (w: string | undefined) => {
    if (w && forms.size < MAX_FORMS && !wordIn(lower, w)) forms.add(w);
  };
  for (const m of head.matchAll(DAY_MONTH)) {
    add(m[1] ? DAYS[key(m[1], DAYS)] : undefined);
    add(String(Number(m[2])));
    add(MONTHS[key(m[3]!, MONTHS)]);
  }
  for (const m of head.matchAll(MONTH_DAY)) {
    add(m[1] ? DAYS[key(m[1], DAYS)] : undefined);
    add(MONTHS[key(m[2]!, MONTHS)]);
    add(String(Number(m[3])));
  }
  for (const m of head.matchAll(NAME)) {
    const w = m[0].toLowerCase();
    for (const n of NICKNAMES[w] ?? []) add(n);
    for (const f of REVERSE.get(w) ?? []) add(f);
  }
  return [...forms].join(" ");
}

/** The table's key for a written weekday or month ("Thurs" → "thurs", "September" → "sep"). */
function key(written: string, table: Record<string, string>): string {
  const w = written.toLowerCase().replace(/\.$/, "");
  if (w in table) return w;
  for (const k of [w.slice(0, 5), w.slice(0, 4), w.slice(0, 3)]) if (k in table) return k;
  return w;
}

/** Whether `lower` holds `w` as a whole word. */
function wordIn(lower: string, w: string): boolean {
  let at = lower.indexOf(w);
  while (at >= 0) {
    const before = at === 0 ? "" : lower[at - 1]!;
    const after = lower[at + w.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    at = lower.indexOf(w, at + 1);
  }
  return false;
}

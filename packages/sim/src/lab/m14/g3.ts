/**
 * G3 (M14, D1020): a third world generator, programmatic and template-driven, with no model call. LAB ONLY. Where M2
 * and G2 are written by language models, G3's text comes from compositional templates (a subject, an archetype's fact
 * and twin, a decoy kind) rendered through programmatic formats: plain and forwarded email with headers, quoted
 * replies, SMS lines, raw iCalendar, CRM field dumps, PDF-extracted text with hard breaks and hyphenation, terse app
 * alerts and notes, each world with its own date style, and OCR-style character noise on some worlds. The facts are
 * short and plain, the background often long: the opposite of the length cue (D908). Output is M2's SynthWorld schema
 * with construction labels.
 *
 *   bun packages/sim/src/lab/m14/g3.ts --n 400 --out .local/m14/g3/worlds.jsonl
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Rng } from "../../rng";
import { validateWorld, type SynthItem, type SynthTask, type SynthWorld } from "../synth/schema";
import { RARE_SOURCES, SYNTH_NOW, type Archetype, type Area } from "../synth/taxonomy";

const DAY = 86_400_000;
const HOUR = 3_600_000;

// -----------------------------------------------------------------------------------------------------------------
// Vocabulary. Names and places are G3's own lists (not the sim's names.ts), drawn from many regions.

const FIRST = `Aisha Bram Chiara Dev Elif Femi Gwen Hiro Ines Jonas Kavya Lars Mei Nuno Olu Priya Quinn Rafa Sian Tomasz
Uma Vik Wren Xavi Yara Zoltan Ama Bjorn Cleo Dara Esme Fintan Gita Hamid Ilse Jae Kofi Leila Mateo Nell Oisin Pita Rhea
Saoirse Tariq Ulla Vesna Wim Yusuf Zara`.split(/\s+/);
const LAST = `Achebe Brennan Castillo Dimitrov Eklund Fofana Gallagher Haddad Ivanova Jensen Kowalczyk Lindqvist Mbeki
Nakamura Okafor Pereira Quigley Rossi Sandoval Tanaka Ueda Varga Wojcik Xu Yilmaz Zielinski Abara Brodie Chaudhry
Delacroix Esposito Farouk Gunn Holloway Iyer Juarez Kaur Lockhart Moreau Novak Ostrowski Petrov Reyes Sato Thorne
Underwood Vance Whitlock`.split(/\s+/);
const ORGS =
  `Kestrel Dental|Brightwater Lettings|Northgate Motors|Halcyon Travel|Pinecrest Clinic|Oakline Energy|Riverbank
Primary|Copperfield Insurance|Lumen Broadband|Ashgrove Council|Meridian Bank|Fernway Logistics|Stonebridge Legal|Vela
Air|Tidewater Hotels|Greenleaf Grocers|Bluefin Software|Harbour Physio|Juniper Accounting|Atlas Removals`
    .replace(/\n/g, " ")
    .split("|");
const PLACES =
  `Lisbon|Galway|Leeds|Kraków|Porto|Bruges|Dundee|Nantes|Malmö|Bath|Cork|Utrecht|Seville|Bologna|Hobart|Quebec
City|Pune|Accra|Tallinn|Ghent`
    .replace(/\n/g, " ")
    .split("|");

interface Subject {
  area: Area;
  obj: string;
  verb: string;
  done: string;
  source: string;
}
/**
 * What a request is about: an object and the verb the user asks for; `{who}`, `{org}`, `{place}`, `{amount}`
 * fill in.
 */
const SUBJECTS: Subject[] = [
  { area: "work", obj: "the quarterly review with {org}", verb: "schedule", done: "scheduled", source: "calendar" },
  { area: "work", obj: "invoice {ref} to {org}", verb: "send", done: "sent", source: "gmail" },
  { area: "work", obj: "the contract renewal with {org}", verb: "sign off", done: "signed off", source: "crm" },
  { area: "work", obj: "the team offsite in {place}", verb: "book", done: "booked", source: "drive" },
  { area: "work", obj: "the supplier payment to {org}", verb: "approve", done: "approved", source: "tickets" },
  { area: "family", obj: "{kid}'s school trip to {place}", verb: "pay for", done: "paid for", source: "school" },
  { area: "family", obj: "{kid}'s swimming lessons", verb: "sign up for", done: "signed up for", source: "gmail" },
  { area: "family", obj: "the birthday party for {kid}", verb: "book", done: "booked", source: "whatsapp" },
  { area: "family", obj: "the visit to Grandma {last}", verb: "arrange", done: "arranged", source: "sms" },
  { area: "health", obj: "the appointment at {org}", verb: "book", done: "booked", source: "health" },
  { area: "health", obj: "the repeat prescription", verb: "order", done: "ordered", source: "health" },
  { area: "health", obj: "the physio session with {who}", verb: "confirm", done: "confirmed", source: "calendar" },
  { area: "money", obj: "the transfer of {amount} to savings", verb: "make", done: "made", source: "bank" },
  { area: "money", obj: "the {amount} payment to {org}", verb: "pay", done: "paid", source: "bank" },
  { area: "money", obj: "the household bills split with {who}", verb: "settle", done: "settled", source: "household" },
  { area: "travel", obj: "the flight to {place}", verb: "book", done: "booked", source: "gmail" },
  { area: "travel", obj: "the hotel in {place}", verb: "reserve", done: "reserved", source: "gmail" },
  { area: "travel", obj: "the train to {place}", verb: "buy tickets for", done: "bought tickets for", source: "notes" },
  { area: "home", obj: "the boiler service", verb: "book", done: "booked", source: "gmail" },
  { area: "home", obj: "the sofa delivery from {org}", verb: "schedule", done: "scheduled", source: "gmail" },
  {
    area: "home",
    obj: "the broadband switch to {org}",
    verb: "go ahead with",
    done: "gone ahead with",
    source: "files",
  },
  { area: "home", obj: "the window cleaner", verb: "book", done: "booked", source: "household" },
  { area: "admin", obj: "the passport renewal", verb: "submit", done: "submitted", source: "drive" },
  { area: "admin", obj: "the parking permit", verb: "renew", done: "renewed", source: "gmail" },
  { area: "admin", obj: "the car service at {org}", verb: "book", done: "booked", source: "notes" },
  { area: "admin", obj: "the tax return", verb: "file", done: "filed", source: "files" },
  { area: "social", obj: "dinner with {who} in {place}", verb: "book", done: "booked", source: "whatsapp" },
  { area: "social", obj: "the book club evening", verb: "host", done: "hosted", source: "slack" },
  { area: "social", obj: "the RSVP for {who}'s wedding", verb: "send", done: "sent", source: "gmail" },
  { area: "social", obj: "drinks with {who}", verb: "set up", done: "set up", source: "sms" },
];

/**
 * An archetype's fact and its twin. `fact` changes the request; `decoy` is all clear under the named decoy kind. Both
 * are short and plain; formats and noise come later. Placeholders: {obj}, {who}, {org}, {date}, {date2}, {past},
 * {amount}, {small}, {big}, {ref}, {ref2}, {place2}, {kid}.
 */
const ARCH: Record<Archetype, { kind: string; fact: string[]; decoy: string[] }> = {
  "schedule-clash": {
    kind: "other-period",
    fact: [
      "{who} has the {clash} booked for {date}, same time, and needs you there.",
      "Reminder: {clash} — {date}, all afternoon. You're down as attending.",
    ],
    decoy: [
      "{who} has the {clash} booked for {date2}, same time, and needs you there.",
      "Reminder: {clash} — {date2}, all afternoon. You're down as attending.",
    ],
  },
  "already-done": {
    kind: "other-entity",
    fact: [
      "Confirmation {ref}: {who} has already {done} {obj} for {date}. No further action needed.",
      "fyi i already {done} {obj} yesterday, ref {ref} - {who}",
    ],
    decoy: [
      "Confirmation {ref}: {who} has {done} {other} for {date}. No further action needed.",
      "fyi i already {done} {other} yesterday, ref {ref} - {who}",
    ],
  },
  "limit-exceeded": {
    kind: "resolved",
    fact: [
      "Available balance: {small}. Pending: {amount} ({obj}) would take you over your limit.",
      "Budget left this month for this: {small}. Anything above that needs sign-off.",
    ],
    decoy: [
      "Available balance: {big} after this week's top-up. Plenty for {obj}.",
      "Budget left this month for this: {big}. Go ahead as planned.",
    ],
  },
  "prerequisite-missing": {
    kind: "already-met",
    fact: [
      "We still haven't received the signed consent form for {obj}. We can't process it until it arrives.",
      "Outstanding item before {obj}: photo ID not yet verified (case {ref}).",
    ],
    decoy: [
      "We've received the signed consent form for {obj}. Nothing else is needed.",
      "Photo ID verified for {obj} (case {ref}). All checks complete.",
    ],
  },
  "rule-forbids": {
    kind: "other-entity",
    fact: [
      "Policy update: {obj} must now be requested through the portal and approved by finance; direct requests are refused.",
      "House rule from {who}: nothing for {obj} goes ahead without a second signature.",
    ],
    decoy: [
      "Policy update: {other} must now be requested through the portal and approved by finance; direct requests are refused.",
      "House rule from {who}: nothing for {other} goes ahead without a second signature.",
    ],
  },
  "person-unavailable": {
    kind: "other-period",
    fact: [
      "Out of office: {who} is away from {past2} until {after}, with no access to email or phone.",
      "{who} on leave {past2} – {after}. Urgent matters to the front desk only.",
    ],
    decoy: [
      "Out of office: {who} was away from {longago} until {longago2}, with no access to email or phone.",
      "{who} on leave {longago} – {longago2}. Urgent matters to the front desk only.",
    ],
  },
  "plan-changed": {
    kind: "resolved",
    fact: [
      "Change notice: {obj} has moved from {date} to {date2}.",
      "Update: {obj} is cancelled for {date}; {org} will contact you to rearrange.",
    ],
    decoy: [
      "Notice: {obj} stays on {date} as planned; earlier rumours of a move were wrong.",
      "Update: {obj} is confirmed for {date}; {org} looks forward to seeing you.",
    ],
  },
  "terms-changed": {
    kind: "resolved",
    fact: [
      "From {past}, {org} has new bank details (account ending {ref2}). Payments to the old account will be returned.",
      "Price change: {obj} now costs {amount2} from {past}, up from {amount}.",
    ],
    decoy: [
      "{org} confirms its bank details are unchanged (account ending {ref}). Pay as usual.",
      "Price check: {obj} still costs {amount}; no change this year.",
    ],
  },
  "commitment-penalty": {
    kind: "other-period",
    fact: [
      "Your current plan with {org} has a minimum term until {after}; changing before then costs {amount2} in early exit fees.",
      "Note: a {amount2} deposit is forfeited if {obj} changes after {past}.",
    ],
    decoy: [
      "Your plan with {org} passed its minimum term on {longago}; you can change any time without fees.",
      "Note: the deposit rule for {obj} ended on {longago}.",
    ],
  },
  "preference-constraint": {
    kind: "other-entity",
    fact: [
      "Remember {who} is severely allergic to nuts and can't do anywhere that can't guarantee it.",
      "{who} uses a wheelchair now; we need step-free access for {obj}.",
    ],
    decoy: [
      "Remember {who2} is severely allergic to nuts — but {who2} isn't coming this time.",
      "{who2} uses a wheelchair; not relevant for {obj}, {who2} is away.",
    ],
  },
  "deadline-shift": {
    kind: "other-period",
    fact: [
      "Deadline correction: {obj} is due by {soon}, not {date} as first stated.",
      "Heads up — cut-off for {obj} brought forward to {soon}.",
    ],
    decoy: [
      "Last year's deadline for {obj} was {longago}; this year's date is {date} as stated.",
      "Archive: the {lastyear} cut-off for {obj} was brought forward. No change this year.",
    ],
  },
  "sensitive-situation": {
    kind: "resolved",
    fact: [
      "Please hold all contact and payments to {org}: there is an open complaint (ref {ref}) under review.",
      "{who}'s family had a bereavement this week; let's not push {obj} on them right now.",
    ],
    decoy: [
      "The complaint with {org} (ref {ref}) is closed and settled. Normal contact can resume.",
      "{who}'s family are doing fine now and asked us to carry on with {obj}.",
    ],
  },
  "safety-risk": {
    kind: "other-entity",
    fact: [
      "Product recall: model {ref} used for {obj} may overheat. Stop using it and do not book further use.",
      "Safety alert from {org}: the venue for {obj} failed its fire inspection; events suspended.",
    ],
    decoy: [
      "Product recall: model {ref2} (not yours) may overheat. Other models unaffected.",
      "Safety notice from {org}: a different venue failed its fire inspection; {obj}'s venue passed.",
    ],
  },
  "wrong-target": {
    kind: "other-entity",
    fact: [
      "Account {ref} at {org} was closed on {past}; use account {ref2} for {obj}.",
      "{who} has moved: the old address on file for {obj} is no longer valid.",
    ],
    decoy: [
      "Account {ref2} at {org} was closed on {past}; account {ref} for {obj} is unaffected.",
      "{who2} has moved: the old address on file is no longer valid. ({who} hasn't.)",
    ],
  },
  "blocked-dependency": {
    kind: "already-met",
    fact: [
      "Still waiting on {who} to approve {obj}. Please don't proceed until they reply.",
      "{obj}: pending sign-off from {org}. Status: AWAITING DECISION.",
    ],
    decoy: ["{who} has approved {obj}. You can proceed.", "{obj}: sign-off from {org} received. Status: APPROVED."],
  },
  "better-route": {
    kind: "other-period",
    fact: [
      "You have a {amount} credit with {org}, valid until {after}, which covers {obj}.",
      "Your warranty covers {obj} until {after}: no charge if booked through {org}.",
    ],
    decoy: ["Your {amount} credit with {org} expired on {longago}.", "Your warranty for {obj} ended on {longago}."],
  },
};
const CLASHES = [
  "parents' evening",
  "dentist",
  "all-hands meeting",
  "hospital check-up",
  "board meeting",
  "school play",
];

// -----------------------------------------------------------------------------------------------------------------
// Dates, money and rendering formats.

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = [
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
const ordinal = (n: number) =>
  n % 10 > 3 || [11, 12, 13].includes(n % 100) ? "th" : ["th", "st", "nd", "rd"][n % 10]!;
const DATE_STYLES = [
  (d: Date) => `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`,
  (d: Date) => `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`,
  (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}`,
  (d: Date) => d.toISOString().slice(0, 10),
  (d: Date) => `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`,
  (d: Date) => `the ${d.getUTCDate()}${ordinal(d.getUTCDate())} of ${MONTH[d.getUTCMonth()]}`,
];
const CURRENCY = ["£", "$", "€", "", "A$"];

type Fmt = "mail" | "fwd" | "reply" | "sms" | "ics" | "crm" | "pdf" | "alert" | "note" | "ticket";
const FMT_FOR: Record<string, Fmt[]> = {
  gmail: ["mail", "fwd", "reply"],
  calendar: ["ics"],
  drive: ["pdf", "note"],
  slack: ["sms"],
  crm: ["crm"],
  sms: ["sms"],
  whatsapp: ["sms"],
  notes: ["note"],
  tasks: ["note", "ticket"],
  bank: ["alert"],
  health: ["alert"],
  files: ["pdf"],
  tickets: ["ticket"],
  school: ["alert", "pdf"],
  household: ["alert"],
};
const KIND_OF: Record<string, SynthItem["kind"]> = {
  gmail: "mail",
  calendar: "event",
  drive: "doc",
  slack: "chat",
  crm: "deal",
  ...Object.fromEntries(Object.entries(RARE_SOURCES).map(([k, v]) => [k, v.kind])),
};

function wrapPdf(text: string, rng: Rng, org: string): string {
  const width = rng.int(55, 85);
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/)) {
    if (line.length + w.length + 1 > width) {
      if (w.length > 8 && rng.chance(0.5)) {
        const cut = rng.int(3, w.length - 3);
        out.push(`${line} ${w.slice(0, cut)}-`.trim());
        line = w.slice(cut);
        continue;
      }
      out.push(line);
      line = w;
    } else line = `${line} ${w}`.trim();
  }
  out.push(line);
  return `${org.toUpperCase()}\n\n${out.join("\n")}\n\nPage 1 of ${rng.int(1, 3)}`;
}

const OCR: Record<string, string> = { l: "1", O: "0", o: "0", I: "l", e: "c", S: "5", B: "8", a: "a", i: "í" };
function ocr(text: string, rng: Rng): string {
  return [...text].map((c) => (OCR[c] && rng.chance(0.04) ? OCR[c] : c)).join("");
}

// -----------------------------------------------------------------------------------------------------------------
// One world.

export function g3World(index: number): SynthWorld | undefined {
  const rng = new Rng(31_000 + index);
  const dateStyle = rng.pick(DATE_STYLES);
  const cur = rng.pick(CURRENCY);
  const noisy = rng.chance(0.3);
  const me = { first: rng.pick(FIRST), last: rng.pick(LAST) };
  const email =
    `${me.first}.${me.last}@${rng.pick(["mailbox.example", "post.example", "inbox.example"])}`.toLowerCase();
  const people = rng.sample(FIRST, 10).map((f) => {
    const l = rng.pick(LAST);
    return {
      full: `${f} ${l}`,
      email: `${f}.${l}@example.org`.toLowerCase(),
      relation: rng.pick(["friend", "family", "colleague", "service"]),
      role: "",
    };
  });
  const kids = rng.sample(FIRST, 2);
  const items: SynthItem[] = [];
  let n = 0;
  const money = (x: number) => (cur === "" ? `${x.toFixed(2)} EUR` : `${cur}${x.toLocaleString("en-GB")}`);
  const day = (d: number) => dateStyle(new Date(SYNTH_NOW + d * DAY));

  const render = (source: string, title: string, body: string, who: string, at: number, start?: number): SynthItem => {
    const fmt = rng.pick(FMT_FOR[source] ?? ["note"]);
    const whoEmail = `${who.split(" ")[0]}.${who.split(" ")[1] ?? "x"}@example.org`.toLowerCase();
    const when = new Date(at).toUTCString().replace(" GMT", "");
    let text = body;
    if (fmt === "mail")
      text = `From: ${who} <${whoEmail}>\nTo: ${me.first} ${me.last} <${email}>\nDate: ${when}\nSubject: ${title}\n\nHi ${me.first},\n\n${body}\n\nBest,\n${who.split(" ")[0]}`;
    else if (fmt === "fwd")
      text = `FYI see below\n\n---------- Forwarded message ---------\nFrom: ${who} <${whoEmail}>\nDate: ${when}\nSubject: ${title}\n\n${body}`;
    else if (fmt === "reply")
      text = `thanks, noted\n\nOn ${when}, ${who} <${whoEmail}> wrote:\n${body
        .split(/(?<=\.) /)
        .map((l) => `> ${l}`)
        .join("\n")}`;
    else if (fmt === "sms")
      text = body
        .split(/(?<=[.!?]) /)
        .map((l) => `${who.split(" ")[0]}: ${l}`)
        .join("\n");
    else if (fmt === "ics") {
      const s = new Date(start ?? at + 2 * DAY).toISOString().replace(/[-:]/g, "").slice(0, 15);
      text = `BEGIN:VEVENT\nUID:${rng.int(10000, 99999)}@cal.example\nDTSTART:${s}Z\nSUMMARY:${title}\nORGANIZER;CN=${who}:mailto:${whoEmail}\nDESCRIPTION:${body.replace(/\n/g, "\\n").replace(/,/g, "\\,")}\nSTATUS:CONFIRMED\nEND:VEVENT`;
    } else if (fmt === "crm")
      text = `Record: ${title}\nOwner: ${me.first[0]}${me.last[0]}\nContact: ${who}\nStage: ${rng.pick(["Open", "Negotiation", "Active", "Review"])}\nLast activity: ${day(Math.round((at - SYNTH_NOW) / DAY))}\nNotes: ${body}`;
    else if (fmt === "pdf") text = wrapPdf(`${title}. ${body}`, rng, rng.pick(ORGS));
    else if (fmt === "alert")
      text = `${rng.pick(ORGS).toUpperCase()} | ${title.toUpperCase()} | ${body} | ${day(Math.round((at - SYNTH_NOW) / DAY))}`;
    else if (fmt === "ticket")
      text = `#${rng.int(100, 999)} ${title}\nstatus: open · assignee: ${(who.split(" ")[0] ?? who).toLowerCase()}\n\n${body}`;
    else text = `- ${body.toLowerCase()}`;
    if (noisy && rng.chance(0.4)) text = ocr(text, rng);
    const it: SynthItem = {
      id: `i${++n}`,
      source,
      kind: KIND_OF[source]!,
      title: title.slice(0, 200),
      text: text.slice(0, 4_000),
      at,
    };
    if (it.kind === "event") it.meta = { start: new Date(start ?? at + 2 * DAY).toISOString() };
    return it;
  };

  // Background: mundane templated items, many long (newsletters, minutes, statements), some one line.
  const BG = [
    () => [
      `${rng.pick(ORGS)} newsletter`,
      `This month at ${rng.pick(ORGS)}: ${Array.from({ length: rng.int(4, 9) }, () => rng.pick(["new opening hours from next week", "our customer survey results are in", "meet the team behind the scenes", "five tips for a calmer winter", "member discounts on selected items", "a thank-you to everyone who joined the open day", "our app has a new look", "parking around the site is changing"])).join(". ")}. Unsubscribe at any time.`,
    ],
    () => [
      `Receipt ${rng.int(1000, 9999)}`,
      `Thank you for your purchase of ${money(rng.int(4, 120))} at ${rng.pick(ORGS)}.`,
    ],
    () => [
      `Minutes: ${rng.pick(["residents' meeting", "team sync", "PTA meeting", "club committee"])}`,
      `Present: ${rng
        .sample(people, 4)
        .map((p) => p.full)
        .join(
          ", ",
        )}. ${Array.from({ length: rng.int(3, 7) }, () => rng.pick(["Agreed to revisit the noticeboard design", "Treasurer reported accounts in order", "AOB: lost property box is full", "Next meeting date to be circulated", "Thanks to volunteers for the autumn fair", "Action: tidy shared drive folders"])).join(". ")}.`,
    ],
    () => [
      `${rng.pick(people).full.split(" ")[0]}`,
      rng.pick([
        "lol yes",
        "see you there!",
        "can you send me that recipe?",
        "did you watch it last night",
        "running 5 late",
      ]),
    ],
    () => [
      `Statement ready`,
      `Your ${rng.pick(["monthly", "quarterly"])} statement for account ending ${rng.int(1000, 9999)} is ready to view.`,
    ],
    () => [
      `Delivery update`,
      `Your parcel ${rng.int(100000, 999999)} from ${rng.pick(ORGS)} was delivered to a safe place.`,
    ],
  ];
  const bgSources = ["gmail", "gmail", "slack", "drive", "whatsapp", "bank", "notes", "calendar"];
  for (let b = 0; b < rng.int(9, 13); b++) {
    const [title, body] = rng.pick(BG)();
    const d = -rng.int(1, 60);
    items.push(
      render(rng.pick(bgSources), title!, body!, rng.pick(people).full, SYNTH_NOW + d * DAY - rng.int(0, 8) * HOUR),
    );
  }

  const subjects = rng.sample(SUBJECTS, 4);
  const archetypes = rng.sample(Object.keys(ARCH) as Archetype[], 4);
  const tasks: SynthTask[] = [];
  subjects.forEach((s, k) => {
    const arch = archetypes[k]!;
    const a = ARCH[arch];
    const who = rng.pick(people).full;
    const who2 = rng.pick(people.filter((p) => p.full !== who)).full;
    const org = rng.pick(ORGS);
    const ref = `${rng.pick(["AB", "QX", "RT", "KM", "ZP"])}-${rng.int(1000, 9999)}`;
    const ref2 = `${rng.int(1000, 9999)}`;
    const target = rng.int(3, 20);
    const amount = rng.int(40, 900);
    // Every slot is drawn once per task, so the request, the fact, its twin and the neutrals name the same things.
    const slots: Record<string, string> = {
      other: rng.pick(SUBJECTS.filter((x) => x !== s)).obj,
      clash: rng.pick(CLASHES),
      who2,
      who,
      org,
      kid: kids[k % 2]!,
      last: rng.pick(LAST),
      place2: rng.pick(PLACES),
      place: rng.pick(PLACES),
      ref2,
      ref,
      amount2: money(Math.round(amount * 0.4)),
      amount: money(amount),
      small: money(Math.round(amount * 0.3)),
      big: money(amount * 4),
      date2: day(target + rng.int(9, 30)),
      date: day(target),
      soon: day(Math.max(1, target - rng.int(2, 5))),
      past2: day(-rng.int(1, 4)),
      past: day(-rng.int(5, 30)),
      after: day(target + rng.int(3, 20)),
      longago2: day(-rng.int(60, 80)),
      longago: day(-rng.int(100, 300)),
      lastyear: "2025",
      done: s.done,
      obj: s.obj,
    };
    const fill1 = (t: string) => t.replace(/\{(\w+)\}/g, (m, k: string) => slots[k] ?? m);
    const fill = (t: string) => fill1(fill1(t));
    // Placeholders inside the subject itself ({org} in "the appointment at {org}") fill on a second pass.
    const v = rng.int(0, a.fact.length - 1);
    const factBody = fill(a.fact[v]!);
    const decoyBody = fill(a.decoy[v]!);
    const title = fill(rng.pick([`Re: ${s.obj}`, s.obj, `${org} — update`, `Update ${ref}`, `Note`]));
    const obj = fill(s.obj);
    const tFact = SYNTH_NOW - rng.int(1, 14) * DAY - rng.int(0, 10) * HOUR;
    const tDecoy = SYNTH_NOW - rng.int(1, 30) * DAY - rng.int(0, 10) * HOUR;
    const decoySource = rng.chance(0.7) ? s.source : rng.pick(Object.keys(FMT_FOR));
    const decoy = render(decoySource, title, decoyBody, who, tDecoy);
    const fact = render(s.source, title, factBody, who, tFact, SYNTH_NOW + target * DAY);
    const neutrals = [
      render(
        s.source,
        `Reminder: ${obj}`,
        `Just a reminder about ${obj} on ${day(target)}.`,
        who,
        SYNTH_NOW - rng.int(1, 20) * DAY,
      ),
      render(
        rng.pick(["gmail", "notes", "whatsapp"]),
        `${obj}`,
        rng.pick([
          `Thanks for asking about ${obj}. Happy to help with anything else.`,
          `ok sounds good re ${obj} 👍`,
          `Added ${obj} to the shared list.`,
        ]),
        who,
        SYNTH_NOW - rng.int(1, 20) * DAY,
      ),
    ];
    if (fact.text === decoy.text) return;
    items.push(decoy, fact, ...neutrals);
    const tid = `t${tasks.length + 1}`;
    const d = day(target);
    const reqs = [
      `${s.verb[0]!.toUpperCase()}${s.verb.slice(1)} ${obj} for ${d}.`,
      `can u ${s.verb} ${obj} ${d}`,
      `Please go ahead and ${s.verb} ${obj}, thanks.`,
      `${obj} - ${s.verb} it?`,
      `Quick one between other things: the printer's jammed again, and I'd like to ${s.verb} ${obj} on ${d}. Also remind me to call ${rng.pick(people).full.split(" ")[0]}.`,
    ];
    tasks.push({
      id: tid,
      family: `g3-${SUBJECTS.indexOf(s)}-${arch}`,
      area: s.area,
      archetype: arch,
      timing: "static",
      decoyKind: a.kind,
      rare: s.source in RARE_SOURCES,
      detail: factBody.slice(0, 500),
      fact: fact.id,
      decoy: decoy.id,
      neutrals: neutrals.map((x) => x.id),
      requests: reqs.map((text, j) => ({
        id: `${tid}r${j + 1}`,
        style: `g3-${j}`,
        lang: "en",
        text,
        at: SYNTH_NOW + j * 60_000,
      })),
    });
  });
  const sources = Object.fromEntries(
    [...new Set(items.map((i) => i.source))]
      .filter((x) => x in RARE_SOURCES)
      .map((x) => [x, RARE_SOURCES[x]!.description]),
  );
  const { world, problems } = validateWorld({
    v: 1,
    id: `sw-g3-${String(index).padStart(4, "0")}`,
    split: "test",
    persona: { ...me, email, city: rng.pick(PLACES), job: "", household: "" },
    people,
    sources,
    items,
    tasks,
    gen: { model: "g3-templates", usd: 0, calls: 0, seed: index },
  });
  return world && !problems.filter((p) => !/wrong weekday/.test(p)).length ? world : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string, d: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1]! : d;
  };
  const out = opt("out", ".local/m14/g3/worlds.jsonl");
  const worlds = Array.from({ length: Number(opt("n", "400")) }, (_, i) => g3World(i)).filter((w) => !!w);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, worlds.map((w) => JSON.stringify(w) + "\n").join(""));
  console.log(`${worlds.length} worlds, ${worlds.reduce((s, w) => s + w.tasks.length, 0)} tasks → ${out}`);
}

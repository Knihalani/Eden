/**
 * Tuning suite dev20b (F8, a dev20 tuning set; not held out: tune on it), written by an isolated author. Its flavour
 * is family and health: parental and carer's leave, co-parenting rotas, babysitters, a pet's vaccinations and meds,
 * prescriptions, pregnancy, physio and post-operative limits, nursery fees and a Junior ISA, child passports and car
 * seats, a carer's visits, school applications and consent, and children's parties with allergies or diets.
 *
 * 40 templates, five in each life area (work, family, health, money, travel, home, admin, social, in that order).
 * Each is a request the user types (it does not name the hidden context), the consideration a good answer raises, a
 * planted item stating it (variant `hidden`) and a near-miss look-alike that does not apply (`control`); `neutral`
 * plants nothing. Request and detail are the same in every variant.
 *
 * Counts, from the comment above each template: overlap none 28, name 10, topic-word 2. Decoys (a) 13, (b) 14,
 * (c) 13. Phrasing: 12 imperatives, 18 plans or statements, 10 questions. Languages: English 30, Italian 2, Hindi in
 * Latin script 2, Dutch, Indonesian, Czech, Danish, Romanian, Tagalog 1 each. Anchored 14. Rare 12: notes 2,
 * whatsapp 2, bank 1, health 2, school 2, trips 1, residents 1, tasks 1. Silent 10: calendar 3, drive 3, notes 1,
 * residents 1, tasks 1, trips 1. The other 28: gmail 11 (7 notifications, 4 mails), calendar 7, drive 5, slack 4,
 * crm 1. World knowledge 11: kennels-overdue-vaccines, grapefruit-cleanse-statin, sauna-day-pregnant-sister,
 * junior-isa-over-allowance, dubai-passport-validity, tenerife-hire-car-no-extras, japan-packing-codeine,
 * ferry-dog-rabies-wait, baby-passport-missing-certificate, nut-desserts-for-guest, lechon-for-halal-relatives.
 *
 * World time is Tuesday 27 October 2026, 09:00 UTC. Weekdays checked with Date.UTC: Tue 14 Jul, Thu 13 Aug,
 * Sat 15 Aug, Sun 16 Aug, Wed 2 Sep, Fri 18 Sep, Thu 1 Oct, Fri 2 Oct, Sat 3 Oct, Mon 5 Oct, Tue 6 Oct, Fri 9 Oct,
 * Mon 12 Oct, Wed 14 Oct, Thu 15 Oct, Fri 16 Oct, Mon 19 Oct, Tue 20 Oct, Wed 21 Oct, Thu 22 Oct, Fri 23 Oct,
 * Sat 24 Oct, Sun 25 Oct, Mon 26 Oct, Wed 28 Oct, Thu 29 Oct, Fri 30 Oct, Sat 31 Oct, Sun 1 Nov, Mon 2 Nov,
 * Tue 3 Nov, Thu 5 Nov, Sat 7 Nov, Sun 8 Nov, Mon 9 Nov, Tue 10 Nov, Wed 11 Nov, Thu 12 Nov, Sat 14 Nov,
 * Sun 15 Nov, Mon 16 Nov, Wed 18 Nov, Thu 19 Nov, Fri 20 Nov, Sat 21 Nov, Sun 22 Nov, Fri 27 Nov, Sat 28 Nov,
 * Sun 29 Nov, Thu 3 Dec, Fri 4 Dec, Fri 18 Dec, Sat 19 Dec, Mon 21 Dec, Sat 26 Dec, Fri 15 Jan 2027,
 * Mon 15 Feb 2027.
 */
import { itemId } from "@eden/protocol";
import { addRareSources, RARE_SOURCES } from "../rare-sources";
import { Rng } from "../rng";
import { chatText, emailBody, emailText, type Who } from "../text";
import type { ItemKind, Person, World } from "../world";
import type { HiddenTask } from "./hidden-context";

/** A UTC instant in 2026 (month is 1-based), so the dates in this file read as written. */
const at = (month: number, day: number, h = 9, min = 0, year = 2026) => Date.UTC(year, month - 1, day, h, min);

/** One item to plant: everything but the id and ref, which the suite assigns. */
interface Plant {
  sourceId: string;
  kind: ItemKind;
  title: string;
  text: string;
  updatedAt: number;
  meta?: Record<string, string>;
}

interface Spec {
  text: string;
  detail: string;
  hidden: Plant;
  decoy: Plant;
  /**
   * Silent-change templates only (DEV20B_SILENT): the planted item as it read before someone edited it at the
   * source without telling anyone (same sourceId, kind and title as `hidden`, an earlier updatedAt, the old detail).
   * The suite plants `hidden` (the edited copy); a days harness can plant `before` first and swap in `hidden`
   * with no notice. Omit for every other template.
   */
  before?: Plant;
}

/**
 * What a template gets: `r` for every draw that shapes the task (people, numbers), and two forked streams for the
 * prose of the hidden item and of the decoy. Both items are always built, so the draws on `r` are identical across
 * variants and the three suites describe the same people and numbers.
 */
interface Ctx {
  r: Rng;
  ta: Rng;
  tb: Rng;
  user: Person;
  colleagues(k: number): Person[];
  clients(k: number): Person[];
  role(role: string, fallback: [string, string]): Person;
}

const bot = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });

const people = (user: Person, ws: Who[]) =>
  ws
    .filter((w) => w.email !== user.email)
    .map((w) => `${w.full} <${w.email}>`)
    .join("; ");

/** A person-written email, with the greeting, signature and quirks text.ts gives real mail. */
function mail(
  c: Ctx,
  t: Rng,
  m: { from: Who; when: number; title: string; body: string[]; corporate?: boolean },
): Plant {
  const body = emailBody(t, { from: m.from, to: c.user, at: m.when, body: m.body, corporate: m.corporate ?? false });
  return {
    sourceId: "gmail",
    kind: "mail",
    title: m.title,
    text: emailText(m.from, c.user, m.when, body),
    updatedAt: m.when,
    meta: { people: people(c.user, [m.from, c.user]) },
  };
}

/** An automated email: no greeting or signature, a reference and a footer, as service mail has. */
function notice(c: Ctx, t: Rng, m: { from: Who; when: number; title: string; body: string }): Plant {
  const footer = t.pick([
    "This is an automated message. Replies to this address are not read. Manage your preferences | Privacy notice",
    "Please do not reply to this email. For help, visit our website or sign in to your account. Terms | Privacy",
    "You are receiving this because you have an account with us. Update your contact preferences at any time.",
  ]);
  return {
    sourceId: "gmail",
    kind: "notification",
    title: m.title,
    text: emailText(
      m.from,
      c.user,
      m.when,
      `${m.body}\n\nReference: ${t.token("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8)}\n\n${footer}`,
    ),
    updatedAt: m.when,
  };
}

/** A Slack channel excerpt: an unrelated line before the message that matters, as a search hit usually shows. */
function chat(t: Rng, channel: string, lines: { who: Person; text: string; when: number }[], bystander: Person): Plant {
  const chatter = t.pick([
    "is the wifi on 3 dropping for anyone else or just me",
    "fire alarm test at 11, don't panic",
    "lost a black umbrella in the kitchen, shout if you've seen it",
    "all-hands moved to 4pm today btw",
  ]);
  const first = lines[0]!.when - t.int(5, 45) * 60_000;
  const all = [
    { who: bystander.full, text: chatter, at: first },
    ...lines.map((l) => ({ ...l, who: l.who.full, at: l.when })),
  ];
  return {
    sourceId: "slack",
    kind: "chat",
    title: `#${channel}`,
    text: chatText(all),
    updatedAt: lines[lines.length - 1]!.when,
    meta: { people: lines.map((l) => `${l.who.full} <${l.who.email}>`).join("; ") },
  };
}

/** A calendar entry. The date line is written by the template, so it can avoid the request's own date wording. */
function event(m: { title: string; start: number; when: string; where: string; notes: string; edited: number }): Plant {
  return {
    sourceId: "calendar",
    kind: "event",
    title: m.title,
    text: `When: ${m.when}\nWhere: ${m.where}\n\n${m.notes}`,
    updatedAt: m.edited,
    meta: { start: new Date(m.start).toISOString() },
  };
}

/** A document in Drive / Notion. */
const doc = (title: string, text: string, edited: number): Plant => ({
  sourceId: "drive",
  kind: "doc",
  title,
  text: `${title}\n\n${text}`,
  updatedAt: edited,
});

/** The client's company, with a stand-in for a pool member that has none. */
const orgOf = (p: Person) => p.org ?? p.company ?? "Globex";

/** A client at another company than `p`, so a decoy about "the same kind of rule" names a different customer. */
function otherClient(c: Ctx, p: Person): Person {
  const found = c.clients(6).find((q) => orgOf(q) !== orgOf(p));
  if (found) return found;
  const org = orgOf(p) === "Hooli" ? "Initech" : "Hooli";
  return {
    id: "p-lee-brennan",
    first: "Lee",
    last: "Brennan",
    full: "Lee Brennan",
    email: `lee.brennan@${org.toLowerCase()}.com`,
    relation: "client",
    org,
    company: org,
  };
}

/** The user's home address in this suite's items (the world gives the user none). */

/**
 * An item in one of the rarely used connectors (RARE_SOURCES in ../rare-sources.ts: notes, whatsapp, bank, health,
 * school, trips, residents, tasks). Use the connector's kind; write the text the way that app shows it.
 */
const rare = (
  sourceId: string,
  title: string,
  text: string,
  updatedAt: number,
  meta?: Record<string, string>,
): Plant => {
  const src = RARE_SOURCES[sourceId];
  if (!src) throw new Error(`not a rare source: ${sourceId}`);
  return { sourceId, kind: src.kind, title, text, updatedAt, ...(meta ? { meta } : {}) };
};

/** A CRM contact record with a notes line, as the CRM shows one. */
const crmContact = (p: Person, note: string, edited: number): Plant => ({
  sourceId: "crm",
  kind: "contact",
  title: p.full,
  text:
    `Contact: ${p.full}\nTitle: ${p.title ?? "Operations Lead"}\nCompany: ${orgOf(p)}\nEmail: ${p.email}\n` +
    `Lifecycle: customer\nNotes: ${note}`,
  updatedAt: edited,
});

/** A WhatsApp thread as the app exports it: one line per message. */
const wa = (title: string, lines: [string, string, number][], edited: number): Plant =>
  rare("whatsapp", title, chatText(lines.map(([who, text, when]) => ({ who, text, at: when }))), edited);

// AUTHOR: write the 40 templates here. Each one is preceded by one labelled comment line of this exact shape:
// overlap: none|name|topic-word · decoy: (a) resolved/expired/superseded|(b) other entity or date|(c) condition met ·
// phrasing: imperative|plan|statement|question · source: <sourceId> (<kind>) · anchored: yes|no · silent: yes|no ·
// rare: yes|no · knowledge: yes|no · language: <English|German|…>
const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  // overlap: name · decoy: (b) other entity or date · phrasing: imperative · source: crm (contact) · anchored: no ·
  // silent: no · rare: no · knowledge: no · language: English
  {
    name: "client-workshop-before-leave",
    build: (c) => {
      const p = c.clients(1)[0]!;
      const q = otherClient(c, p);
      const cover = c.r.pick(["Hannah Moreau", "Tobias Grant", "Leah Okoye"]);
      const lead = (t: Rng) =>
        t.pick(["Prefers Teams over Zoom.", "Copy procurement on order forms.", "Quiet in August."]);
      return {
        text: `Schedule a two-hour handover workshop with ${p.first} on Thursday 19 November.`,
        detail:
          `${p.full} (${orgOf(p)}) starts parental leave on Monday 16 November until mid-February; ${cover} covers ` +
          `the account, so a workshop on 19 November needs ${cover} or an earlier date.`,
        hidden: crmContact(
          p,
          `${lead(c.ta)} Parental leave from Mon 16 Nov to Mon 15 Feb 2027; while away, route everything to ${cover}.`,
          at(10, 22, 15, 10),
        ),
        decoy: crmContact(
          q,
          `${lead(c.tb)} Parental leave from Mon 16 Nov to Mon 15 Feb 2027; while away, route everything to ${cover}.`,
          at(10, 22, 15, 10),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: drive (doc) · anchored: no ·
  // silent: yes · rare: no · knowledge: no · language: English
  {
    name: "early-standup-phased-return",
    build: (c) => {
      const [col, other] = c.colleagues(2);
      const plan = (hours: string, t: Rng) =>
        `Agreed with HR and Occupational Health on 20 Oct.\nReturn date: Mon 2 Nov\n` +
        `Hours, first four weeks: ${hours}, Mon-Thu, remote on Fridays\nWeeks 5-6: 09:30-16:30\n` +
        `${t.pick(["Line manager to check in fortnightly.", "Desk assessment booked for the first Tuesday."])}\n` +
        `Review: Fri 27 Nov`;
      return {
        text: "I'm going to move our daily standup to 8:15 starting next week.",
        detail:
          `${col!.full} returns on Monday 2 November on a phased plan working only 10:00-15:00 (no meetings before ` +
          `10:00) for the first four weeks, so an 8:15 standup would exclude them.`,
        hidden: doc(
          `Return-to-work plan — ${col!.full}`,
          plan("10:00-15:00 (no meetings before 10:00: medication makes early starts hard)", c.ta),
          at(10, 26, 16, 40),
        ),
        before: doc(`Return-to-work plan — ${col!.full}`, plan("08:00-13:00", c.ta), at(10, 20, 11, 5)),
        decoy: doc(
          `Return-to-work plan — ${other!.full}`,
          `Phased return completed on Fri 18 Sep; back on full contracted hours since. ` +
            `${c.tb.pick(["Closed by HR.", "No further review needed."])}`,
          at(9, 18, 12, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: drive (doc) · anchored: no · silent: no ·
  // rare: no · knowledge: no · language: Italian
  {
    name: "friday-retro-flexible-hours",
    build: (c) => {
      const [a, b, d] = c.colleagues(3);
      const sheet = (bLine: string, t: Rng) =>
        `Agreed flexible working arrangements (HR-approved)\n` +
        `- ${a!.full}: compressed hours, off alternate Mondays\n- ${b!.full}: ${bLine}\n` +
        `- ${d!.full}: home-based Wednesdays\n${t.pick(["Core hours otherwise 10:00-16:00.", "Ask HR before changing."])}`;
      return {
        text: "Posso mettere la retrospettiva del team venerdì alle 16?",
        detail:
          `${b!.full} has an approved flexible-working agreement finishing at 14:30 on Fridays (school pickup), so a ` +
          `Friday 16:00 retrospective would miss them.`,
        hidden: doc(
          "Working patterns — product squad",
          sheet("finishes 14:30 on Fridays for school pickup (from 1 Oct)", c.ta),
          at(10, 1, 10, 0),
        ),
        decoy: doc(
          "Working patterns — product squad",
          sheet("starts 07:30 Mon-Thu, usual hours on Fridays (from 1 Oct)", c.tb),
          at(10, 1, 10, 0),
        ),
      };
    },
  },
  // overlap: name · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: slack (chat) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "one-to-one-carers-leave",
    build: (c) => {
      const [col, cover, by] = c.colleagues(3);
      return {
        text: `Move my 1:1 with ${col!.first} to Friday afternoon.`,
        detail:
          `${col!.full} is on carer's leave Thursday 29 and Friday 30 October (their dad's hospital discharge), back ` +
          `Monday 2 November, so a Friday 1:1 won't happen.`,
        hidden: chat(
          c.ta,
          "team",
          [
            {
              who: col!,
              text:
                `heads up: I'm on carer's leave Thu 29 + Fri 30 Oct, dad's being discharged and I need to settle him ` +
                `in. Back Mon 2 Nov, ${cover!.first} has my on-call`,
              when: at(10, 26, 17, 5),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "team",
          [
            {
              who: col!,
              text: "back from carer's leave as of this morning, dad's home and doing well. thanks for covering all",
              when: at(10, 12, 9, 20),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: calendar (event) · anchored: yes ·
  // silent: no · rare: no · knowledge: no · language: English
  {
    name: "demo-on-diwali-monday",
    build: (c) => {
      const [col, other] = c.colleagues(2);
      return {
        text: "Let's run the sprint demo for everyone on Monday the 9th.",
        detail:
          `${col!.full} is out of office Monday 9 and Tuesday 10 November for Diwali, so a whole-team demo on the ` +
          `9th would miss them.`,
        hidden: event({
          title: `${col!.full} — OOO (Diwali)`,
          start: at(11, 9, 0, 0),
          when: "Mon 9 Nov - Tue 10 Nov (all day)",
          where: "—",
          notes: `Annual leave approved. ${c.ta.pick(["With family in Leicester.", "Off Slack, phone for emergencies."])}`,
          edited: at(10, 14, 13, 0),
        }),
        decoy: event({
          title: `${other!.full} — OOO`,
          start: at(11, 12, 0, 0),
          when: "Thu 12 Nov (all day)",
          where: "—",
          notes: `Annual leave approved. ${c.tb.pick(["Moving house.", "Off Slack, phone for emergencies."])}`,
          edited: at(10, 14, 13, 0),
        }),
      };
    },
  },
  // ── family ──
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: calendar (event) · anchored: yes ·
  // silent: yes · rare: no · knowledge: no · language: English
  {
    name: "swim-class-earlier",
    build: (c) => {
      const stage = c.r.int(3, 5);
      const ev = (when: string, start: number, edited: number, t: Rng) =>
        event({
          title: `Maya — Swim class (Stage ${stage})`,
          start,
          when,
          where: "Hornsey Road Baths",
          notes:
            `Arrive 10 min early to change. ${t.pick(["Bring goggles and a float.", "Hair tie!"])} ` +
            `Swim school moved the Wednesday groups this half.`,
          edited,
        });
      return {
        text: "Tomorrow I'm doing the pool run after work.",
        detail:
          `Maya's swimming class tomorrow (Wednesday 28 October) was moved to 16:00-16:45 (was 17:45), so going ` +
          `after work would miss it.`,
        hidden: ev("Wed 28 Oct, 16:00-16:45", at(10, 28, 16, 0), at(10, 25, 19, 30), c.ta),
        before: ev("Wed 28 Oct, 17:45-18:30", at(10, 28, 17, 45), at(9, 2, 8, 0), c.ta),
        decoy: ev("Sat 31 Oct, 09:00-09:45", at(10, 31, 9, 0), at(10, 25, 19, 30), c.tb),
      };
    },
  },
  // overlap: name · decoy: (a) resolved/expired/superseded · phrasing: plan · source: drive (doc) · anchored: no ·
  // silent: yes · rare: no · knowledge: no · language: English
  {
    name: "legoland-on-swapped-weekend",
    build: (c) => {
      const co = c.r.pick(["Dan", "Rob", "Chris"]);
      const rota = (mid: string, t: Rng) =>
        `Maya's weekends (Fri pickup from school, Sun 6pm handover)\n` +
        `Sat 31 Oct - Sun 1 Nov: here\nSat 7 - Sun 8 Nov: at ${co}'s\n${mid}\n` +
        `Sat 21 - Sun 22 Nov: at ${co}'s\nSat 28 - Sun 29 Nov: here\n` +
        `${t.pick(["Half-term split already agreed.", "Christmas: alternate years, 2026 here."])}`;
      return {
        text: "Thinking of taking Maya to Legoland on Saturday the 14th.",
        detail:
          `The co-parenting rota now has Maya at ${co}'s on Saturday 14 - Sunday 15 November (weekends swapped on ` +
          `22 October), so the 14th isn't the user's weekend.`,
        hidden: doc(
          "Co-parenting rota — autumn 2026",
          rota(`Sat 14 - Sun 15 Nov: at ${co}'s (swapped with 21-22, agreed 22 Oct)`, c.ta),
          at(10, 22, 21, 15),
        ),
        before: doc("Co-parenting rota — autumn 2026", rota("Sat 14 - Sun 15 Nov: here", c.ta), at(9, 2, 20, 0)),
        decoy: doc(
          "Co-parenting rota — summer 2026",
          `Maya's weekends (ended 31 Aug; replaced by the autumn rota)\nSat 15 - Sun 16 Aug: at ${co}'s (swapped)\n` +
            `${c.tb.pick(["Holiday fortnight: 1-14 Aug here.", "Camp week paid by both."])}`,
          at(8, 16, 18, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: whatsapp (chat) · anchored: no ·
  // silent: no · rare: yes · knowledge: no · language: English
  {
    name: "rossis-table-grandparents",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      return {
        text: "Book a table for six at Rossi's for Sunday lunch on the 8th.",
        detail:
          `Mum and Dad are staying 7-10 November and Auntie Pat and Uncle Ray are joining, which makes eight, so a ` +
          `table for six is too small.`,
        hidden: wa(
          "Family",
          [
            [
              mum.first,
              "Right, train booked! Dad and me arrive Sat 7th about 3, home again Tue 10th",
              at(10, 24, 18, 2),
            ],
            [
              mum.first,
              `${c.ta.pick(["And", "Oh and"])} Auntie Pat and Uncle Ray want to come down for the weekend too, so ` +
                `with yours that makes eight of us for meals!`,
              at(10, 24, 18, 4),
            ],
          ],
          at(10, 24, 18, 4),
        ),
        decoy: wa(
          "Family",
          [
            [mum.first, "Right, train booked! Dad and me arrive Fri 18 Dec, home again Mon 21st", at(10, 24, 18, 2)],
            [
              mum.first,
              `${c.tb.pick(["And", "Oh and"])} Auntie Pat and Uncle Ray want to come for Christmas too, so with ` +
                `yours that makes eight of us!`,
              at(10, 24, 18, 4),
            ],
          ],
          at(10, 24, 18, 4),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: gmail (mail) · anchored: no · silent: no ·
  // rare: no · knowledge: no · language: Dutch
  {
    name: "dinner-without-babysitter",
    build: (c) => {
      const sitter = bot("Chloe Bennett", "chloe.bennett98@gmail.com");
      return {
        text: "Kun je voor zaterdagavond om acht uur een tafel voor twee reserveren?",
        detail:
          "The babysitter, Chloe Bennett, cancelled for Saturday 31 October, so dinner for two that evening needs " +
          "other childcare first.",
        hidden: mail(c, c.ta, {
          from: sitter,
          when: at(10, 26, 21, 40),
          title: "Saturday",
          body: [
            "I'm really sorry but I can't babysit on Saturday 31st anymore.",
            "My exam got moved to the Monday and I need to revise all weekend.",
            "Could you ask someone else? Really sorry to let you down.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: sitter,
          when: at(10, 26, 21, 40),
          title: "Saturday",
          body: [
            "Saturday 31st is all fine, I'll be there from 7:30.",
            "Is Maya still going to bed at 8:30 or is it later on weekends now?",
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: gmail (notification) · anchored: yes ·
  // silent: no · rare: no · knowledge: yes · language: English
  {
    name: "kennels-overdue-vaccines",
    build: (c) => {
      const vet = bot("Riverside Veterinary Clinic", "reminders@riversidevets.co.uk");
      const age = c.r.int(3, 8);
      return {
        text: "Planning to drop the dog at the boarding place Friday.",
        detail:
          "Biscuit's annual booster and kennel-cough vaccination are overdue (due 3 October); boarding kennels " +
          "refuse dogs without current vaccinations (kennel cough often needed some days before), so check first.",
        hidden: notice(c, c.ta, {
          from: vet,
          when: at(10, 20, 7, 0),
          title: "Vaccination reminder: Biscuit",
          body:
            `Patient: Biscuit (Cocker Spaniel, ${age}y)\nDue: annual booster (DHP + Lepto L4) and kennel cough ` +
            `(intranasal)\nStatus: OVERDUE since 3 Oct 2026\nBook online or call 020 7263 4410.`,
        }),
        decoy: notice(c, c.tb, {
          from: vet,
          when: at(10, 20, 7, 0),
          title: "Vaccination record updated: Biscuit",
          body:
            `Patient: Biscuit (Cocker Spaniel, ${age}y)\nGiven 12 Oct 2026: annual booster (DHP + Lepto L4) and ` +
            `kennel cough (intranasal)\nNext due: Oct 2027.`,
        }),
      };
    },
  },
  // ── health ──
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: health (notification) ·
  // anchored: no · silent: no · rare: yes · knowledge: yes · language: English
  {
    name: "grapefruit-cleanse-statin",
    build: (c) => {
      const qty = c.r.pick([28, 56]);
      return {
        text: "I'm going to start a juice cleanse on Monday, mostly grapefruit.",
        detail:
          "The user takes simvastatin 40mg (repeat issued 21 October); grapefruit raises simvastatin levels and the " +
          "risk of muscle damage, so a grapefruit cleanse should be checked with the GP or pharmacist first.",
        hidden: rare(
          "health",
          "Repeat prescription issued",
          `NHS App · Prescriptions\nSimvastatin 40mg tablets: take ONE at night\nQuantity: ${qty}\n` +
            `Status: issued to Boots, Holloway Road · 21 Oct 2026\nNext request due: 16 Nov 2026\n` +
            `${c.ta.pick(["Also on your list: cetirizine 10mg (when required)", "Medication review due: Mar 2027"])}`,
          at(10, 21, 11, 30),
        ),
        decoy: rare(
          "health",
          "Medication stopped",
          `NHS App · Prescriptions\nSimvastatin 40mg tablets: STOPPED on 14 Jul 2026 after review with your GP\n` +
            `Current repeat medication: none\n${c.tb.pick(["Contact the practice with questions.", "Review: Jul 2027"])}`,
          at(7, 14, 10, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: drive (doc) · anchored: no ·
  // silent: no · rare: no · knowledge: no · language: Czech
  {
    name: "charity-10k-knee-rehab",
    build: (c) => {
      const physio = c.r.pick(["Joanna Pierce", "Marek Doyle", "Siobhan Kerr"]);
      return {
        text: "Můžu si 15. listopadu zaběhnout tu charitativní desítku?",
        detail:
          "The physio programme for the right knee bars running, jumping and impact until 4 December, so a 10k on " +
          "15 November is off.",
        hidden: doc(
          "Physio programme — right knee (Active Balance Physiotherapy)",
          `Physio: ${physio}\nDiagnosis: patellar tendinopathy, right\nPhase 2 (until Fri 4 Dec): NO running, ` +
            `jumping or impact. Cycling and swimming fine.\nDaily: isometric holds 5 x 45s, step-downs 3 x 15\n` +
            `Next review: Thu 3 Dec ${c.ta.pick(["08:30", "17:15"])}`,
          at(10, 19, 18, 0),
        ),
        decoy: doc(
          "Physio programme — right knee (Active Balance Physiotherapy)",
          `Physio: ${physio}\nDischarged 20 Oct: no restrictions, back to full activity.\n` +
            `Keep the step-downs twice a week. ${c.tb.pick(["Well done!", "Re-book if it flares."])}`,
          at(10, 20, 18, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: whatsapp (chat) · anchored: yes ·
  // silent: no · rare: yes · knowledge: yes · language: English
  {
    name: "sauna-day-pregnant-sister",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const friend = c.role("friend", ["Leila", "Haddad"]);
      const due = c.r.pick(["12 May", "19 May", "26 May"]);
      const scan = (who: Person, t: Rng) =>
        wa(
          who.full,
          [
            [
              who.first,
              `12 week scan this morning!!! 🥹 ${t.pick(["everything looks perfect", "all looks good"])}`,
              at(10, 26, 12, 10),
            ],
            [
              who.first,
              `due ${due}. don't say anything to anyone yet, we're telling Mum at Christmas`,
              at(10, 26, 12, 11),
            ],
          ],
          at(10, 26, 12, 11),
        );
      return {
        text: "Book my sister and me a thermal spa day on the 7th.",
        detail:
          `${sis.full} is newly pregnant (12-week scan on 26 October, due in May); saunas, steam rooms and hot ` +
          `tubs are advised against in pregnancy, so the spa day needs a pregnancy-safe package.`,
        hidden: scan(sis, c.ta),
        decoy: scan(friend, c.tb),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: calendar (event) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "agency-checkin-therapy-slot",
    build: (c) => {
      const n = c.r.int(4, 9);
      return {
        text: "Set up the quarterly check-in with the agency for Thursday 5pm.",
        detail:
          "The user has a recurring therapy session (Dr Amara Lewis, CBT) on Thursdays 17:00-17:50 with a 24-hour " +
          "cancellation fee, so a Thursday 5pm check-in clashes.",
        hidden: event({
          title: "Session — Dr Amara Lewis",
          start: at(10, 29, 17, 0),
          when: "Thu 29 Oct, 17:00-17:50 (repeats weekly)",
          where: c.ta.pick(["Willow Counselling, 14 Canonbury Lane", "Video (link in confirmation)"]),
          notes: `CBT session ${n} of 12. Under 24h notice to move: full fee (£85).`,
          edited: at(10, 15, 9, 0),
        }),
        decoy: event({
          title: "Session — Dr Amara Lewis",
          start: at(10, 29, 17, 0),
          when: "Thu 29 Oct, 17:00-17:50 — CANCELLED",
          where: c.tb.pick(["Willow Counselling, 14 Canonbury Lane", "Video (link in confirmation)"]),
          notes: `Therapist on leave. CBT session ${n} of 12 now Thu 5 Nov.`,
          edited: at(10, 23, 9, 0),
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: health (notification) · anchored: no ·
  // silent: no · rare: yes · knowledge: no · language: English
  {
    name: "sofa-lifting-after-hernia-op",
    build: (c) => {
      const kg = c.r.pick([5, 10]);
      return {
        text: "Tomorrow I'm helping my brother move his sofa and fridge.",
        detail:
          `The user had a hernia repair on 20 October; discharge advice is no lifting over ${kg} kg or straining for ` +
          `six weeks, so carrying a sofa and fridge tomorrow is out.`,
        hidden: rare(
          "health",
          "Discharge summary",
          `NHS App · Documents\nWhittington Hospital, Day Surgery Unit\nProcedure: laparoscopic inguinal hernia ` +
            `repair (left), 20 Oct 2026\nAdvice: no heavy lifting (over ${kg} kg) or straining for 6 weeks. ` +
            `${c.ta.pick(["Short walks daily.", "Paracetamol as needed."])} Drive only once you can do an emergency stop.`,
          at(10, 20, 16, 30),
        ),
        decoy: rare(
          "health",
          "Discharge summary",
          `NHS App · Documents\nWhittington Hospital, Minor Ops\nProcedure: excision of skin lesion (back), 20 Oct ` +
            `2026\nAdvice: keep the dressing dry for 48 hours; stitches out at the practice in 10 days. ` +
            `${c.tb.pick(["No other restrictions.", "Paracetamol as needed."])}`,
          at(10, 20, 16, 30),
        ),
      };
    },
  },
  // ── money ──
  // overlap: topic-word · decoy: (c) condition met · phrasing: imperative · source: bank (notification) ·
  // anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "washer-over-family-limit",
    build: (c) => {
      const used = c.r.int(720, 900);
      const recent = (t: Rng) =>
        `Recent: Tesco £${t.int(40, 99)}.20 · Clarks £54.00 · TfL £12.40 · ${t.pick(["Boots £8.99", "Waitrose £31.75"])}`;
      return {
        text: "Pay for the £649 washer on the shared card tonight.",
        detail:
          `The family card ending 4417 has £${used} of its £1,000 monthly limit used (resets 1 November), so a ` +
          `£649 purchase tonight would be declined.`,
        hidden: rare(
          "bank",
          "Spending limit alert",
          `Joint account (Family) · card ending 4417\nYou've used £${used} of your £1,000 monthly limit on this ` +
            `card. It resets on 1 Nov.\n${recent(c.ta)}`,
          at(10, 26, 19, 12),
        ),
        decoy: rare(
          "bank",
          "Spending limit updated",
          `Joint account (Family) · card ending 4417\nYour monthly limit on this card is now £3,000 (£${used} ` +
            `used this month).\n${recent(c.tb)}`,
          at(10, 26, 19, 12),
        ),
      };
    },
  },
  // overlap: name · decoy: (c) condition met · phrasing: imperative · source: gmail (notification) · anchored: no ·
  // silent: no · rare: no · knowledge: no · language: English
  {
    name: "nursery-paid-twice",
    build: (c) => {
      const fee = c.r.int(1050, 1450);
      const nursery = bot("Little Acorns Day Nursery", "accounts@littleacorns-nursery.co.uk");
      return {
        text: "Send Little Acorns this month's fees by bank transfer this afternoon.",
        detail:
          `Little Acorns now collects fees by Direct Debit; November's £${fee}.00 is collected on Monday 2 November, ` +
          `so paying by transfer as well would pay twice.`,
        hidden: notice(c, c.ta, {
          from: nursery,
          when: at(10, 16, 8, 0),
          title: "Change to how fees are collected",
          body:
            `From November all fees are collected by Direct Debit (GoCardless) on the first working day of the ` +
            `month. Your mandate is active. November: £${fee}.00, collected Mon 2 Nov. Please cancel any standing ` +
            `order and do not pay by bank transfer, to avoid paying twice.`,
        }),
        decoy: notice(c, c.tb, {
          from: nursery,
          when: at(10, 16, 8, 0),
          title: "Direct Debit now available",
          body:
            `You can now pay fees by Direct Debit (GoCardless) if you prefer. This is optional: bank transfer ` +
            `remains fine as usual. November: £${fee}.00, due by Fri 30 Oct.`,
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: gmail (notification) · anchored: no ·
  // silent: no · rare: no · knowledge: yes · language: English
  {
    name: "junior-isa-over-allowance",
    build: (c) => {
      const paid = c.r.pick([6800, 7200, 7500]);
      const provider = bot("Oakfield Investments", "statements@oakfield-invest.co.uk");
      return {
        text: "I'll top up our daughter's investment pot with another three grand.",
        detail:
          `£${paid} has already gone into Maya's Junior ISA this tax year; the Junior ISA allowance is £9,000, so ` +
          `another £3,000 would breach it (only £${9000 - paid} more fits).`,
        hidden: notice(c, c.ta, {
          from: provider,
          when: at(10, 19, 6, 30),
          title: "Contribution received",
          body:
            `Junior Stocks & Shares ISA (M. ${c.user.last})\nPayment received: £${c.ta.pick([200, 250])}.00 on 19 Oct\n` +
            `Subscriptions this tax year (6 Apr 2026 - 5 Apr 2027): £${paid.toLocaleString("en-GB")}.00`,
        }),
        decoy: notice(c, c.tb, {
          from: provider,
          when: at(10, 19, 6, 30),
          title: "Contribution received",
          body:
            `Stocks & Shares ISA (${c.user.full})\nPayment received: £${c.tb.pick([200, 250])}.00 on 19 Oct\n` +
            `Subscriptions this tax year (6 Apr 2026 - 5 Apr 2027): £${paid.toLocaleString("en-GB")}.00`,
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: gmail (notification) · anchored: yes ·
  // silent: no · rare: no · knowledge: no · language: Indonesian
  {
    name: "hospital-bill-insurer-paid",
    build: (c) => {
      const excess = c.r.pick([50, 60, 100]);
      const billing = bot("Highgate Private Hospital", "patient.accounts@highgateprivate.co.uk");
      return {
        text: "Bisa tolong bayarin tagihan rumah sakit itu hari ini?",
        detail:
          `The insurer settled £${380 - excess} on 23 October; the revised statement says only the £${excess} excess ` +
          `is due, so paying the original £380 would overpay.`,
        hidden: notice(c, c.ta, {
          from: billing,
          when: at(10, 24, 10, 15),
          title: "Revised statement — outpatient account",
          body:
            `Your insurer (AXA Health) settled £${380 - excess}.00 on 23 Oct. Balance now due: £${excess}.00 ` +
            `(policy excess). Please disregard the statement of 9 Oct showing £380.00.`,
        }),
        decoy: notice(c, c.tb, {
          from: billing,
          when: at(10, 24, 10, 15),
          title: "Revised statement — outpatient account",
          body:
            `Your insurer (AXA Health) has declined the claim (outpatient limit reached). The balance of £380.00 ` +
            `from the statement of 9 Oct remains due.`,
        }),
      };
    },
  },
  // overlap: topic-word · decoy: (a) resolved/expired/superseded · phrasing: question · source: gmail (notification) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: Hindi (Latin script)
  {
    name: "duplicate-benefit-claim",
    build: (c) => {
      const hmrc = bot("HM Revenue & Customs", "noreply@notifications.hmrc.gov.uk");
      return {
        text: "Noah ke liye child benefit claim karna hai, form bhar doge?",
        detail:
          "HMRC already acknowledged a Child Benefit claim for Noah on 14 October (decision within 12 weeks, " +
          "backdated); a second claim would duplicate it and slow it down.",
        hidden: notice(c, c.ta, {
          from: hmrc,
          when: at(10, 14, 12, 0),
          title: "We've received your Child Benefit claim",
          body:
            `We have received your claim for Noah ${c.user.last}. We'll write within 12 weeks. Payments can be ` +
            `backdated up to 3 months, so you do not need to claim again.`,
        }),
        decoy: notice(c, c.tb, {
          from: hmrc,
          when: at(9, 2, 12, 0),
          title: "Your Child Benefit claim has been withdrawn",
          body: `As you asked, we have withdrawn the claim for Noah ${c.user.last}. You can make a new claim at any time.`,
        }),
      };
    },
  },
  // ── travel ──
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: notes (doc) · anchored: no · silent: no ·
  // rare: yes · knowledge: yes · language: English
  {
    name: "dubai-passport-validity",
    build: (c) => {
      const mine = c.r.int(1000, 9999);
      const hers = c.r.int(1000, 9999);
      const list = (exp: string, t: Rng) =>
        `Passports\nMe: ••${mine}, exp 03/2031\nMaya: ••${hers}, exp ${exp} (child, 5yr)\n` +
        `${t.pick(["Kept in the blue folder, top drawer.", "Photos for renewals: the booth at the post office."])}`;
      return {
        text: "Planning the February half-term trip to Dubai with the kids.",
        detail:
          "Maya's passport expires 14 April 2027; the UAE requires six months' validity on entry, so it is not " +
          "valid for a February 2027 trip: renew it first.",
        hidden: rare("notes", "Passports", list("14/04/2027", c.ta), at(6, 2, 20, 0)),
        decoy: rare("notes", "Passports", list("14/04/2031", c.tb), at(6, 2, 20, 0)),
      };
    },
  },
  // overlap: name · decoy: (c) condition met · phrasing: imperative · source: trips (doc) · anchored: no ·
  // silent: yes · rare: yes · knowledge: yes · language: English
  {
    name: "tenerife-hire-car-no-extras",
    build: (c) => {
      const conf = c.r.int(10000, 99999);
      const trip = (travellers: string, t: Rng) =>
        `TripIt · Tenerife, December\nFlights: BA2714 LGW → TFS Sat 19 Dec 07:15; return Sat 26 Dec 14:30\n` +
        `Villa Las Palmeras, Adeje · 7 nights · confirmation ${conf}\nTravellers: ${travellers}\nCar: not booked\n` +
        `${t.pick(["Pool heating requested.", "Key box at the gate."])}`;
      return {
        text: "Book the cheapest hire car in Tenerife, no extras.",
        detail:
          "The Tenerife trip (19-26 December) now lists Maya (6) and baby Noah as travellers; Spanish law requires " +
          "child seats, so 'no extras' would leave out a legally required baby seat and booster.",
        hidden: rare("trips", "Tenerife, December", trip("you, Maya (6), Noah (11 months)", c.ta), at(10, 23, 22, 0)),
        before: rare("trips", "Tenerife, December", trip("you", c.ta), at(9, 18, 21, 0)),
        decoy: rare("trips", "Tenerife, December", trip("you, Jamie Fox", c.tb), at(10, 23, 22, 0)),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: question · source: gmail (notification) ·
  // anchored: no · silent: no · rare: no · knowledge: yes · language: Italian
  {
    name: "japan-packing-codeine",
    build: (c) => {
      const boots = bot("Boots Pharmacy", "prescriptions@boots.co.uk");
      const n = c.r.pick([56, 100]);
      return {
        text: "Mi prepari la lista delle cose da mettere in valigia per il Giappone?",
        detail:
          `The user has a fresh prescription of co-codamol 30/500 (codeine) x${n}; Japan restricts codeine ` +
          `medicines, so carrying it needs the import rules checked (possibly a Yunyu Kakunin-sho) and the ` +
          `prescription letter packed.`,
        hidden: notice(c, c.ta, {
          from: boots,
          when: at(10, 22, 14, 5),
          title: "Your prescription is ready to collect",
          body: `Co-codamol 30mg/500mg tablets x${n}\nCollect from: Boots, Holloway Road, within 14 days.`,
        }),
        decoy: notice(c, c.tb, {
          from: boots,
          when: at(10, 22, 14, 5),
          title: "Your prescription is ready to collect",
          body: `Omeprazole 20mg capsules x${n}\nCollect from: Boots, Holloway Road, within 14 days.`,
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: calendar (event) · anchored: yes · silent: no ·
  // rare: no · knowledge: yes · language: English
  {
    name: "ferry-dog-rabies-wait",
    build: (c) => {
      const batch = c.r.int(100000, 999999);
      const ev = (when: string, start: number, t: Rng) =>
        event({
          title: "Vet — Biscuit: rabies jab + microchip scan",
          start,
          when,
          where: "Riverside Veterinary Clinic, 41 Junction Road",
          notes: `Nobivac Rabies (batch ${batch}). ${t.pick(["Ask about worming tablets.", "Bring the vaccination card."])}`,
          edited: start,
        });
      return {
        text: "We'll take the dog over to Brittany on 2 November.",
        detail:
          "Biscuit had his first rabies vaccination on 20 October; entering the EU needs a 21-day wait after the " +
          "primary rabies jab (until 10 November) plus an Animal Health Certificate, so he can't travel on 2 November.",
        hidden: ev("Tue 20 Oct, 10:30-10:50", at(10, 20, 10, 30), c.ta),
        decoy: ev("Thu 13 Aug, 10:30-10:50", at(8, 13, 10, 30), c.tb),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: calendar (event) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: Danish
  {
    name: "malaga-flight-moved-earlier",
    build: (c) => {
      const ref = c.r.token("ABCDEFGHJKLMNPQRSTUVWXYZ", 6);
      return {
        text: "Hvornår skal vi køre hjemmefra for at nå flyet til Malaga på lørdag?",
        detail:
          "The Saturday 31 October flight to Málaga (EZY8013 from Gatwick) now departs 06:40, not 09:15, so they " +
          "need to leave around three hours earlier than planned.",
        hidden: event({
          title: "Flight EZY8013 LGW → AGP",
          start: at(10, 31, 6, 40),
          when: "Sat 31 Oct, 06:40-10:25",
          where: "London Gatwick North Terminal",
          notes:
            `easyJet schedule change 23 Oct: now departs 06:40 (was 09:15). Bag drop closes 40 min before. ` +
            `Booking ${ref}. ${c.ta.pick(["2 adults, 2 children.", "Seats 14A-D."])}`,
          edited: at(10, 23, 18, 0),
        }),
        decoy: event({
          title: "Flight EZY8013 LGW → AGP",
          start: at(10, 31, 9, 15),
          when: "Sat 31 Oct, 09:15-13:00",
          where: "London Gatwick North Terminal",
          notes:
            `easyJet: the schedule change of 23 Oct was reversed, original 09:15 reinstated. Booking ${ref}. ` +
            `${c.tb.pick(["2 adults, 2 children.", "Seats 14A-D."])}`,
          edited: at(10, 25, 18, 0),
        }),
      };
    },
  },
  // ── home ──
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: residents (doc) · anchored: yes ·
  // silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "nanny-keypad-rotation",
    build: (c) => {
      const block = c.r.pick(["Block A", "Block B", "Block C"]);
      const body = (line: string, t: Rng) =>
        `Notice to all residents, ${block}\n${line}\nYour PIN is in the portal under My Building > Access. ` +
        `${t.pick(["Please update any cleaners, carers or contractors.", "Please pass it on to anyone who visits."])}`;
      return {
        text: "Tomorrow the new nanny starts; I'll text her the door code.",
        detail:
          "The building's entrance keypad PINs change at 07:00 on Wednesday 28 October and the old one stops " +
          "working, so the nanny needs the updated PIN from the residents' portal.",
        hidden: rare(
          "residents",
          "Entrance keypad PINs",
          body(
            "Main entrance and car-park gate PINs change at 07:00 on Wed 28 Oct (quarterly rotation). Old PINs stop working then.",
            c.ta,
          ),
          at(10, 26, 16, 0),
        ),
        before: rare(
          "residents",
          "Entrance keypad PINs",
          body("Main entrance and car-park gate PINs next change in January 2027 (quarterly rotation).", c.ta),
          at(10, 2, 16, 0),
        ),
        decoy: rare(
          "residents",
          "Bike store fobs",
          body("Bike store fobs are being replaced on Wed 28 Oct; old fobs stop working at 07:00.", c.tb),
          at(10, 26, 16, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: tasks (doc) · anchored: no · silent: yes ·
  // rare: yes · knowledge: no · language: English
  {
    name: "stair-gates-landlord-says-no",
    build: (c) => {
      const landlord = c.role("landlord", ["Steve", "Hargreaves"]);
      const task = (note: string, t: Rng) =>
        `Todoist · Home · due Fri 30 Oct\nNotes: ${note}\nSubtasks: ☐ measure banister ☐ order x2 ` +
        `${t.pick(["(Argos)", "(John Lewis)"])}`;
      return {
        text: "Going to screw the stair gates into the hallway wall this weekend.",
        detail:
          `The landlord (${landlord.full}) said no drilling or fixings in the hall (lath-and-plaster with wiring ` +
          `through it; tenancy clause 14): only pressure-fit gates are allowed.`,
        hidden: rare(
          "tasks",
          "Baby-proofing: ask landlord about fixings",
          task(
            `${landlord.first} replied 24 Oct: NO drilling or fixings in the hall, it's the original lath-and-plaster ` +
              `with the electrics running through. Tenancy clause 14. Pressure-fit ones only.`,
            c.ta,
          ),
          at(10, 24, 13, 0),
        ),
        before: rare(
          "tasks",
          "Baby-proofing: ask landlord about fixings",
          task(`emailed ${landlord.first} 21 Oct, waiting to hear back`, c.ta),
          at(10, 21, 9, 0),
        ),
        decoy: rare(
          "tasks",
          "Baby-proofing: ask landlord about fixings",
          task(
            `${landlord.first} replied 24 Oct: fine to put fixings in the hall, just fill the holes at the end.`,
            c.tb,
          ),
          at(10, 24, 13, 0),
        ),
      };
    },
  },
  // overlap: name · decoy: (a) resolved/expired/superseded · phrasing: plan · source: notes (doc) · anchored: no ·
  // silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "cat-meds-weekend-away",
    build: (c) => {
      const mg = c.r.pick(["2.5", "5"]);
      return {
        text: "We're away Friday to Monday, so I'll leave Pepper extra food.",
        detail:
          `Pepper now needs Felimazole ${mg} mg twice a day, given by hand (vet change of 21 October); three nights ` +
          `with only extra food means missed doses, so someone has to come in.`,
        hidden: rare(
          "notes",
          "Pepper — meds",
          `Felimazole ${mg} mg TWICE a day, ~8am and ~8pm, by hand in a bit of pâté. Vet changed it 21 Oct (levels ` +
            `too high). Don't skip: missed doses make the thyroid spike. ${c.ta.pick(["Recheck bloods in 3 weeks.", "Tablets in the cupboard by the kettle."])}`,
          at(10, 21, 19, 0),
        ),
        before: rare(
          "notes",
          "Pepper — meds",
          `Felimazole ${mg} mg once a day in the morning feed. Vet review 21 Oct.`,
          at(9, 18, 19, 0),
        ),
        decoy: rare(
          "notes",
          "Pepper — antibiotics",
          `Synulox twice a day with food, 7 days. Finished 9 Oct ✔ ${c.tb.pick(["No need to go back.", "All clear."])}`,
          at(10, 9, 19, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: gmail (mail) ·
  // anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "timer-on-capped-boiler",
    build: (c) => {
      const eng = bot("Gary Lund", "gary@lundgas.co.uk");
      const ppm = c.r.int(150, 300);
      return {
        text: "Could you set the heating to come on at 6am tomorrow?",
        detail:
          `The gas engineer capped off the boiler as unsafe (carbon monoxide spillage, ${ppm} ppm) until a part is ` +
          `fitted on Monday 2 November; it must not be switched back on, so timed heating won't work.`,
        hidden: mail(c, c.ta, {
          from: eng,
          when: at(10, 26, 17, 30),
          title: "Boiler — DO NOT USE",
          body: [
            "As discussed on site, I've capped off the boiler and labelled it DO NOT USE.",
            `The flue was spilling carbon monoxide (${ppm} ppm at the case).`,
            "Please don't relight it or switch the supply back on. The heat exchanger is on order and I'll fit it Monday 2 Nov.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: eng,
          when: at(10, 15, 17, 30),
          title: "Boiler — all sorted",
          body: [
            "New heat exchanger fitted and the flue gas analysis is clear.",
            `Earlier CO reading (${ppm} ppm) is gone; the boiler is safe to use again.`,
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: calendar (event) · anchored: no ·
  // silent: yes · rare: no · knowledge: no · language: English
  {
    name: "carpet-fitters-carer-visit",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const carer = c.r.pick(["Bernadette", "Grace", "Olena"]);
      const ev = (when: string, start: number, edited: number, t: Rng) =>
        event({
          title: `${mum.first} — Home Instead personal care visit`,
          start,
          when,
          where: "Home",
          notes:
            `Carer: ${carer}. Needs access to Mum's ground-floor bedroom and bathroom (hoist by the bed). ` +
            `${t.pick(["Agency asks for clear walkways.", "Key safe by the back door."])}`,
          edited,
        });
      return {
        text: "Tomorrow I'm having the carpet fitters in at ten to do the whole downstairs.",
        detail:
          `Mum's carer (${carer}, Home Instead) now visits Wednesday 28 October 09:45-10:45 (moved from 14:00) and ` +
          `needs her ground-floor bedroom and bathroom, which clashes with the fitters at ten.`,
        hidden: ev("Wed 28 Oct, 09:45-10:45", at(10, 28, 9, 45), at(10, 26, 18, 0), c.ta),
        before: ev("Wed 28 Oct, 14:00-15:00", at(10, 28, 14, 0), at(10, 5, 9, 0), c.ta),
        decoy: ev("Thu 29 Oct, 09:45-10:45", at(10, 29, 9, 45), at(10, 26, 18, 0), c.tb),
      };
    },
  },
  // ── admin ──
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: school (mail) · anchored: no ·
  // silent: no · rare: yes · knowledge: no · language: English
  {
    name: "secondary-forms-deadline",
    build: (c) => {
      const teacher = c.role("Maya's teacher", ["Mrs", "Daley"]);
      return {
        text: "I'll sort out Maya's secondary forms over the Christmas holidays.",
        detail:
          "Applications for Maya's Year 7 place close at 11:59pm on Saturday 31 October on the council portal; " +
          "waiting until Christmas would make the application late.",
        hidden: rare(
          "school",
          "Transfer to Year 7 — deadline",
          `Dear Year 6 Parents and Carers,\nApplications for Year 7 places for September 2027 must be made on the ` +
            `council's eAdmissions portal by 11:59pm on Sat 31 Oct. Late applications are only considered after ` +
            `on-time ones. ${c.ta.pick(["Our open evening slides are on the website.", "Please ask the office if stuck."])}\n${teacher.full}, Year 6`,
          at(10, 19, 15, 30),
        ),
        decoy: rare(
          "school",
          "Reception 2027 — applications",
          `Dear Parents and Carers,\nApplications for Reception places for September 2027 open on Sun 1 Nov and ` +
            `close on Fri 15 Jan. ${c.tb.pick(["Siblings get priority.", "Please ask the office if stuck."])}\n${teacher.full}`,
          at(10, 19, 15, 30),
        ),
      };
    },
  },
  // overlap: name · decoy: (c) condition met · phrasing: question · source: gmail (notification) · anchored: yes ·
  // silent: no · rare: no · knowledge: no · language: English
  {
    name: "gp-registration-pending",
    build: (c) => {
      const gp = bot("Parkside Medical Centre", "parkside.registrations@nhs.net");
      return {
        text: "Can you get Maya seen at the new GP for her cough?",
        detail:
          "Maya's registration at Parkside Medical Centre isn't confirmed yet (up to 10 working days from 19 " +
          "October), so for now she has to use the old practice or NHS 111.",
        hidden: notice(c, c.ta, {
          from: gp,
          when: at(10, 19, 15, 0),
          title: "Registration update",
          body:
            `We have received the registration for Maya ${c.user.last}. Registrations take up to 10 working days. ` +
            `Until we confirm, please continue to use your current practice or NHS 111.`,
        }),
        decoy: notice(c, c.tb, {
          from: gp,
          when: at(10, 19, 15, 0),
          title: "Registration update",
          body: `Registration complete: Maya ${c.user.last} is now registered with us. Appointments can be booked online.`,
        }),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: imperative · source: school (mail) · anchored: no ·
  // silent: no · rare: yes · knowledge: no · language: English
  {
    name: "residential-needs-deposit",
    build: (c) => {
      const dep = c.r.pick([40, 45, 50]);
      return {
        text: "Email the office Maya's permission slip for the trip, that's it.",
        detail:
          `The Kingswood residential (18-20 November) needs the consent form plus the medical and dietary form and ` +
          `a £${dep} deposit on ParentPay by Friday 30 October; the slip alone doesn't hold Maya's place.`,
        hidden: rare(
          "school",
          "Year 6 residential — Kingswood",
          `Kingswood, Wed 18 - Fri 20 Nov. To secure Maya's place we need three things by Fri 30 Oct: the signed ` +
            `consent form, the medical & dietary form, and the £${dep} deposit on ParentPay. Places are not held ` +
            `without the deposit. ${c.ta.pick(["Kit list to follow.", "Questions to Mr Patel."])}`,
          at(10, 20, 15, 0),
        ),
        decoy: rare(
          "school",
          "Year 6 museum visit",
          `Natural History Museum, Thu 5 Nov. For Maya to go we only need the signed consent form, no cost. ` +
            `${c.tb.pick(["Packed lunch please.", "Back by 3:15."])}`,
          at(10, 20, 15, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: gmail (mail) ·
  // anchored: yes · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "baby-passport-missing-certificate",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      return {
        text: "Apply for the baby's first passport online this weekend.",
        detail:
          "Mum still has Noah's full birth certificate (she'll bring it at Christmas); a first child passport " +
          "application needs the original full birth certificate, so it can't be completed this weekend.",
        hidden: mail(c, c.ta, {
          from: mum,
          when: at(10, 23, 20, 10),
          title: "Noah's certificate",
          body: [
            "I've still got Noah's long birth certificate, the one with both parents on, from the family tree folder.",
            "I'll bring it down when we come at Christmas.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: mum,
          when: at(10, 23, 20, 10),
          title: "Noah's certificate",
          body: [
            "Popped Noah's long birth certificate back through your door on Saturday.",
            "It's in the blue folder on the hall table.",
          ],
        }),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: plan · source: drive (doc) · anchored: yes ·
  // silent: yes · rare: no · knowledge: no · language: English
  {
    name: "st-judes-tour-moved",
    build: (c) => {
      const places = c.r.int(1, 2);
      const sheet = (jude: string, other: string, t: Rng) =>
        `For Maya, September 2027\n1. St Jude's (C of E): ${jude}\n2. Highbury Grove: ${other}\n` +
        `3. Ashmount: tour done 6 Oct\n${t.pick(["Distance: all under 1.5 miles.", "Ask about the music scholarship."])}`;
      return {
        text: "I'll take Thursday morning off for the St Jude's open morning.",
        detail:
          "St Jude's moved its tour for prospective families to Wednesday 11 November at 09:30 (it was Thursday 12 " +
          "November), so Thursday morning off would miss it.",
        hidden: doc(
          "Year 7 shortlist",
          sheet(
            `tour for prospective families Wed 11 Nov 09:30, ${places} booked (moved by the school from Thu 12 Nov)`,
            "Fri 20 Nov 09:15",
            c.ta,
          ),
          at(10, 25, 20, 0),
        ),
        before: doc(
          "Year 7 shortlist",
          sheet(`tour for prospective families Thu 12 Nov 09:30, ${places} booked`, "Fri 20 Nov 09:15", c.ta),
          at(10, 6, 20, 0),
        ),
        decoy: doc(
          "Year 7 shortlist",
          sheet(
            `tour for prospective families Thu 12 Nov 09:30, ${places} booked`,
            "Wed 18 Nov 09:15 (moved by the school from Fri 20 Nov)",
            c.tb,
          ),
          at(10, 25, 20, 0),
        ),
      };
    },
  },
  // ── social ──
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: slack (chat) · anchored: no ·
  // silent: no · rare: no · knowledge: yes · language: English
  {
    name: "nut-desserts-for-guest",
    build: (c) => {
      const [col, by] = c.colleagues(2);
      return {
        text: "I'm going to do Nutella crêpes and a frangipane tart for the party Saturday.",
        detail:
          `Arjun (${col!.full}'s son), coming to Maya's party, is anaphylactic to tree nuts; Nutella (hazelnut) and ` +
          `frangipane (almond) are both unsafe, so the desserts need changing.`,
        hidden: chat(
          c.ta,
          "parents",
          [
            {
              who: col!,
              text:
                "Arjun is SO excited for Maya's 7th this weekend 🎉 just flagging he's anaphylactic to tree nuts " +
                "(carries an EpiPen), sorry to be that parent!",
              when: at(10, 26, 12, 40),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "parents",
          [
            {
              who: col!,
              text:
                "Arjun is SO excited for Maya's 7th this weekend 🎉 and good news, he passed his oral food " +
                "challenge in August, cleared for all nuts now 🙌",
              when: at(10, 26, 12, 40),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: gmail (mail) ·
  // anchored: no · silent: no · rare: no · knowledge: yes · language: Tagalog
  {
    name: "lechon-for-halal-relatives",
    build: (c) => {
      const cousin = bot("Marites Santos", "marites.santos@yahoo.com");
      const adults = c.r.int(16, 20);
      return {
        text: "I-book mo na yung lechon para sa reunion natin sa Sabado, mga 20 katao.",
        detail:
          "Tito Tariq and Tita Noor's family, who eat halal only, are coming on Saturday 7 November; lechon is " +
          "roast pork, so they need a halal alternative (e.g. chicken or lamb) or a separate dish.",
        hidden: mail(c, c.ta, {
          from: cousin,
          when: at(10, 25, 9, 30),
          title: "Headcount for the 7th",
          body: [
            `Final headcount for the 7th: ${adults} adults plus the little ones.`,
            "Big news: Tito Tariq and Tita Noor are flying in from Davao with the boys!",
            "They're strict halal now, just so you know for the food.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: cousin,
          when: at(10, 25, 9, 30),
          title: "Headcount for the 7th",
          body: [
            `Final headcount for the 7th: ${adults} adults plus the little ones.`,
            "Sad news: Tito Tariq and Tita Noor can't come after all, their flight from Davao was cancelled.",
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: calendar (event) · anchored: yes ·
  // silent: yes · rare: no · knowledge: no · language: Hindi (Latin script)
  {
    name: "naming-ceremony-earlier",
    build: (c) => {
      const venue = c.r.pick(["Clissold House, Stoke Newington", "The Old School Rooms, Highgate"]);
      const ev = (when: string, start: number, edited: number, note: string, t: Rng) =>
        event({
          title: "Isla's naming day",
          start,
          when,
          where: venue,
          notes: `${note} ${t.pick(["Smart casual.", "Lunch after, kids welcome."])}`,
          edited,
        });
      return {
        text: "Sunday ko Jamie ki beti ka naamkaran hai, main 11 baje pahunchunga.",
        detail:
          "Isla's naming ceremony on Sunday 1 November now starts at 10:30 sharp (moved from 11:30), so arriving at " +
          "11 would miss it.",
        hidden: ev(
          "Sun 1 Nov, 10:30-12:00",
          at(11, 1, 10, 30),
          at(10, 25, 21, 0),
          "Ceremony 10:30 sharp (celebrant has a second booking).",
          c.ta,
        ),
        before: ev("Sun 1 Nov, 11:30-13:00", at(11, 1, 11, 30), at(10, 3, 12, 0), "Ceremony at 11:30.", c.ta),
        decoy: ev("Sun 1 Nov, 11:30-13:00", at(11, 1, 11, 30), at(10, 25, 21, 0), "Ceremony at 11:30.", c.tb),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: question · source: slack (chat) · anchored: no ·
  // silent: no · rare: no · knowledge: no · language: Romanian
  {
    name: "playdate-pickup-by-five",
    build: (c) => {
      const [col, by] = c.colleagues(2);
      return {
        text: "Îmi poți pune în calendar să trec după Maya joi pe la 6 seara?",
        detail:
          `${col!.full} asked for pickup from Thursday's playdate (29 October) by 17:00, as they leave at 17:15 for ` +
          `football, so 6pm is too late.`,
        hidden: chat(
          c.ta,
          "parents",
          [
            {
              who: col!,
              text: "playdate at ours Thu 29th 👍 one thing, can pickup be by 5? we leave at 5:15 for Ollie's football",
              when: at(10, 26, 15, 20),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "parents",
          [
            {
              who: col!,
              text: "playdate at ours Tue 3 Nov 👍 pickup whenever suits, we're in all evening",
              when: at(10, 26, 15, 20),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: name · decoy: (c) condition met · phrasing: imperative · source: slack (chat) · anchored: yes ·
  // silent: no · rare: no · knowledge: no · language: English
  {
    name: "olivia-no-gifts",
    build: (c) => {
      const [col, by] = c.colleagues(2);
      return {
        text: "Buy a present for Olivia's party, about £15, something crafty.",
        detail:
          `${col!.full}'s invitation for Olivia's 6th (Saturday 7 November) asks for no gifts, a £5 donation to ` +
          `Great Ormond Street instead.`,
        hidden: chat(
          c.ta,
          "parents",
          [
            {
              who: col!,
              text:
                "Olivia's turning 6 on Sat 7th 🎈 invites are in book bags. we're doing no gifts this year, if " +
                "you'd like to, a £5 donation to Great Ormond Street instead!",
              when: at(10, 22, 13, 0),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "parents",
          [
            {
              who: col!,
              text: "Olivia's turning 6 on Sat 7th 🎈 invites are in book bags. she's into Lego and craft stuff atm",
              when: at(10, 22, 13, 0),
            },
          ],
          by!,
        ),
      };
    },
  },
];

/** Templates whose request names one person, thing or date the planted item words differently. */
export const DEV20B_ANCHORED: readonly string[] = [
  "demo-on-diwali-monday",
  "swim-class-earlier",
  "kennels-overdue-vaccines",
  "sauna-day-pregnant-sister",
  "washer-over-family-limit",
  "hospital-bill-insurer-paid",
  "ferry-dog-rabies-wait",
  "nanny-keypad-rotation",
  "timer-on-capped-boiler",
  "gp-registration-pending",
  "baby-passport-missing-certificate",
  "st-judes-tour-moved",
  "naming-ceremony-earlier",
  "olivia-no-gifts",
];
/** Templates whose planted item (both variants) sits in a rare source (RARE_SOURCES). */
export const DEV20B_RARE: readonly string[] = [
  "rossis-table-grandparents",
  "grapefruit-cleanse-statin",
  "sauna-day-pregnant-sister",
  "sofa-lifting-after-hernia-op",
  "washer-over-family-limit",
  "dubai-passport-validity",
  "tenerife-hire-car-no-extras",
  "nanny-keypad-rotation",
  "stair-gates-landlord-says-no",
  "cat-meds-weekend-away",
  "secondary-forms-deadline",
  "residential-needs-deposit",
];
/** Templates whose fact is a silent edit at the source (their Spec has `before`). */
export const DEV20B_SILENT: readonly string[] = [
  "early-standup-phased-return",
  "swim-class-earlier",
  "legoland-on-swapped-weekend",
  "tenerife-hire-car-no-extras",
  "nanny-keypad-rotation",
  "stair-gates-landlord-says-no",
  "cat-meds-weekend-away",
  "carpet-fitters-carer-visit",
  "st-judes-tour-moved",
  "naming-ceremony-earlier",
];
/** Templates whose request is not in English (name the language in the template's comment). */
export const DEV20B_NON_ENGLISH: readonly string[] = [
  "friday-retro-flexible-hours",
  "dinner-without-babysitter",
  "charity-10k-knee-rehab",
  "hospital-bill-insurer-paid",
  "duplicate-benefit-claim",
  "japan-packing-codeine",
  "malaga-flight-moved-earlier",
  "lechon-for-halal-relatives",
  "naming-ceremony-earlier",
  "playdate-pickup-by-five",
];
/** Templates whose request is indirect or a question ("Should I…", "I need to…", "We should…", "Can we…?"). */
export const DEV20B_INDIRECT: readonly string[] = [
  "early-standup-phased-return",
  "friday-retro-flexible-hours",
  "demo-on-diwali-monday",
  "swim-class-earlier",
  "legoland-on-swapped-weekend",
  "dinner-without-babysitter",
  "kennels-overdue-vaccines",
  "grapefruit-cleanse-statin",
  "charity-10k-knee-rehab",
  "sofa-lifting-after-hernia-op",
  "junior-isa-over-allowance",
  "hospital-bill-insurer-paid",
  "duplicate-benefit-claim",
  "dubai-passport-validity",
  "japan-packing-codeine",
  "ferry-dog-rabies-wait",
  "malaga-flight-moved-earlier",
  "nanny-keypad-rotation",
  "stair-gates-landlord-says-no",
  "cat-meds-weekend-away",
  "timer-on-capped-boiler",
  "carpet-fitters-carer-visit",
  "secondary-forms-deadline",
  "gp-registration-pending",
  "st-judes-tour-moved",
  "nut-desserts-for-guest",
  "naming-ceremony-earlier",
  "playdate-pickup-by-five",
];
/** Templates whose request is a question (a subset of DEV20B_INDIRECT). */
export const DEV20B_QUESTION: readonly string[] = [
  "friday-retro-flexible-hours",
  "dinner-without-babysitter",
  "charity-10k-knee-rehab",
  "hospital-bill-insurer-paid",
  "duplicate-benefit-claim",
  "japan-packing-codeine",
  "malaga-flight-moved-earlier",
  "timer-on-capped-boiler",
  "gp-registration-pending",
  "playdate-pickup-by-five",
];
/**
 * Templates whose fact connects to the request only through world knowledge (a drug and alcohol, asbestos and a
 * drill).
 */
export const DEV20B_KNOWLEDGE: readonly string[] = [
  "kennels-overdue-vaccines",
  "grapefruit-cleanse-statin",
  "sauna-day-pregnant-sister",
  "junior-isa-over-allowance",
  "dubai-passport-validity",
  "tenerife-hire-car-no-extras",
  "japan-packing-codeine",
  "ferry-dog-rabies-wait",
  "baby-passport-missing-certificate",
  "nut-desserts-for-guest",
  "lechon-for-halal-relatives",
];
/** Templates whose request shares no word with the planted item (overlap: none). */
export const DEV20B_NO_OVERLAP: readonly string[] = [
  "early-standup-phased-return",
  "friday-retro-flexible-hours",
  "demo-on-diwali-monday",
  "swim-class-earlier",
  "rossis-table-grandparents",
  "dinner-without-babysitter",
  "kennels-overdue-vaccines",
  "grapefruit-cleanse-statin",
  "charity-10k-knee-rehab",
  "sauna-day-pregnant-sister",
  "agency-checkin-therapy-slot",
  "sofa-lifting-after-hernia-op",
  "junior-isa-over-allowance",
  "hospital-bill-insurer-paid",
  "dubai-passport-validity",
  "japan-packing-codeine",
  "ferry-dog-rabies-wait",
  "malaga-flight-moved-earlier",
  "nanny-keypad-rotation",
  "stair-gates-landlord-says-no",
  "timer-on-capped-boiler",
  "carpet-fitters-carer-visit",
  "secondary-forms-deadline",
  "baby-passport-missing-certificate",
  "nut-desserts-for-guest",
  "lechon-for-halal-relatives",
  "naming-ceremony-earlier",
  "playdate-pickup-by-five",
];

/** Each silent-change template's `before` item, for a days harness (same RNG draws as the planting function). */
export function dev20bBefore(world: World, seed: number): { template: string; before: Plant }[] {
  return build(world, seed).flatMap(({ name, spec }) => (spec.before ? [{ template: name, before: spec.before }] : []));
}

/** Build every template's spec, in order, with the suite's own streams (no world change). */
function build(world: World, seed: number): { name: string; spec: Spec }[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 2002);
  const by = (rel: string) => world.people.filter((p) => p.relation === rel);
  const pools = { colleague: by("colleague"), client: by("client") };
  // Never run out: a pool too small for k distinct people repeats, and an empty one falls back to a stand-in.
  const draw = (pool: Person[], k: number, stand: Person): Person[] => {
    if (pool.length === 0) return Array.from({ length: k }, () => stand);
    const out = r.sample(pool, Math.min(k, pool.length));
    while (out.length < k) out.push(r.pick(pool));
    return out;
  };
  const standIn = (first: string, last: string, relation: Person["relation"], org?: string): Person => ({
    id: `p-${first}-${last}`.toLowerCase(),
    first,
    last,
    full: `${first} ${last}`,
    email: `${first}.${last}@${org ? `${org.toLowerCase().replace(/\W+/g, "")}.com` : "gmail.com"}`.toLowerCase(),
    relation,
    org,
    company: org,
  });
  const relationOf = (role: string): Person["relation"] =>
    role === "friend" || role === "best friend" ? "friend" : role === "mum" || role === "sister" ? "family" : "service";
  return TEMPLATES.map((t) => {
    const ta = r.fork();
    const tb = r.fork();
    const ctx: Ctx = {
      r,
      ta,
      tb,
      user: world.user,
      colleagues: (k) => draw(pools.colleague, k, standIn("Alex", "Morgan", "colleague", world.user.company)),
      clients: (k) => draw(pools.client, k, standIn("Jordan", "Blake", "client", "Globex")),
      role: (role, [first, last]) =>
        world.people.find((p) => p.role === role) ?? standIn(first, last, relationOf(role)),
    };
    return { name: t.name, spec: t.build(ctx) };
  });
}

/**
 * Plant one item per template (the real one for `hidden`, the decoy for `control`, nothing for `neutral`) and return
 * the tasks. The rare sources and their filler are added in every variant, so the three see the same connectors.
 */
export function plantDev20b(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  addRareSources(world, seed);
  const suite = variant === "hidden" ? "dev20b" : `dev20b-${variant}`;
  const tasks: HiddenTask[] = [];
  for (const { name, spec } of build(world, seed)) {
    if (variant !== "neutral") {
      const p = variant === "hidden" ? spec.hidden : spec.decoy;
      // The same ref in hidden and control, of the base world's shape (`<kind>-<index>`): a ref naming the template or
      // marking the item as planted would tell the agent.
      const ref = `${p.kind}-${world.items.length}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    tasks.push({ id: `w${seed}:${suite}:${name}`, template: name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}

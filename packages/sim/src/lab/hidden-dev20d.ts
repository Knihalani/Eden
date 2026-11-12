/**
 * Tuning suite dev20d (F8, a dev20 tuning set; not held out: tune on it), written by an isolated author. Its flavour
 * is travel and social life: client dinners and conferences abroad, airport pick-ups and family trips, dives before a
 * flight and jabs before a trip, travel vouchers and expiring points, terminal and timetable changes, house-sitting
 * and heating while away, visas and passport validity, surprise parties and RSVPs.
 *
 * 40 templates, five in each life area (work, family, health, money, travel, home, admin, social, in that order).
 * Each is a request the user types (it does not name the hidden context), the consideration a good answer raises, a
 * planted item stating it (variant `hidden`) and a near-miss look-alike that does not apply (`control`); `neutral`
 * plants nothing. Request and detail are the same in every variant.
 *
 * Counts, from the comment above each template:
 * - overlap: 27 none, 8 name, 5 topic-word.
 * - decoy kinds: 13 (a) resolved/expired/superseded, 14 (b) other entity or date, 13 (c) condition met.
 * - phrasing: 12 imperative, 16 plan, 2 statement, 10 question (28 indirect).
 * - languages: 30 English; 10 not: Spanish (2), Italian, German, Japanese, Korean, Russian, Greek, Arabic, Vietnamese.
 * - anchored: 14. Rare: 12 (bank 2, notes 2, school 2, trips 2, health 1, residents 1, tasks 1, whatsapp 1).
 * - silent edits: 10 (calendar 3, drive 2, trips 2, notes 1, residents 1, tasks 1).
 * - sources of the other 28: calendar 8, gmail notification 7, gmail mail 5, drive 3, slack 3, crm 2.
 * - world knowledge (10): quarterly-review-friday-slot (Auckland is UTC+13), red-sea-last-dives (no flying within
 *   18-24 h of diving), japan-timezone-routine (basal insulin across nine time zones), alpine-company-trip (ACL
 *   reconstruction and skiing), highland-ascent-tomorrow (rest after a joint steroid injection), us-domestic-carry-on
 *   (Basic Economy allows no full-size cabin bag), kennel-stay-seville (kennels need kennel cough vaccine two weeks
 *   ahead), new-york-entry-authorisation (an ESTA is tied to the old passport), bali-document-validity (Indonesia's
 *   six months' validity), late-party-saturday (tinidazole and alcohol for 72 h).
 *
 * World time is Tuesday 27 October 2026, 09:00 UTC. Weekdays checked with Date.UTC: Sun 9 Feb 2025, Fri 14 Feb 2025,
 * Mon 17 Nov 2025, Fri 28 Nov 2025; Mon 2 Mar 2026, Sat 25 Jul 2026, Thu 16 Jul 2026, Sat 24 Oct, Mon 26 Oct, Tue 27
 * Oct, Wed 28 Oct, Thu 29 Oct, Fri 30 Oct, Sat 31 Oct, Mon 2 Nov, Tue 3 Nov, Wed 4 Nov, Thu 5 Nov, Fri 6 Nov, Mon 9
 * Nov, Thu 12 Nov, Fri 13 Nov, Sat 14 Nov, Sun 15 Nov, Mon 16 Nov, Tue 17 Nov, Wed 18 Nov, Thu 19 Nov, Fri 20 Nov,
 * Sat 21 Nov, Mon 23 Nov, Wed 25 Nov, Fri 27 Nov, Wed 2 Dec, Thu 3 Dec, Mon 7 Dec, Tue 8 Dec, Wed 9 Dec, Fri 11 Dec,
 * Sat 12 Dec, Mon 14 Dec (all 2026); Mon 4 Jan, Mon 1 Feb, Fri 12 Feb, Sat 13 Mar, Fri 30 Apr, Mon 14 Jun, Fri 18 Jun
 * 2027.
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
   * Silent-change templates only (DEV20D_SILENT): the planted item as it read before someone edited it at the
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

// The 40 templates. Each is preceded by its labels (wrapped at " · anchored:" to keep within 120 columns):
// overlap: none|name|topic-word · decoy: (a) resolved/expired/superseded|(b) other entity or date|(c) condition met
//   · phrasing: imperative|plan|statement|question · source: <sourceId> (<kind>) · anchored: yes|no · silent: yes|no
//   · rare: yes|no · knowledge: yes|no · language: <English|German|…>
const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ---------------------------------------------------------------- work
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: crm (deal)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "delegation-dinner-booking",
    build: (c) => {
      const [client] = c.clients(1) as [Person];
      const org = orgOf(client);
      const other = otherClient(c, client);
      const size = c.r.int(5, 8);
      const record = (t: Rng, o: string, champ: Person, dates: string, notes: string, edited: string): string =>
        [
          `Account: ${o}`,
          `Owner: ${c.user.full}`,
          `Champion: ${champ.full}`,
          `On-site: ${dates}`,
          `Catering notes: ${notes}`,
          `Next step: ${t.pick(["confirm meeting rooms", "send the agenda", "share parking and badge info"])}`,
          `Last activity: ${edited}`,
        ].join("\n");
      return {
        text: "Book somewhere nice for dinner with the visiting delegation on the 4th.",
        detail:
          `${org}'s party of ${size} is on site Wed 4 Nov: two of them keep halal, ${client.full} is strictly ` +
          `coeliac, and ${org}'s policy is no alcohol at hosted meals, so the restaurant has to suit all three.`,
        hidden: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — On-site visit`,
          text: record(
            c.ta,
            org,
            client,
            `Wed 4 Nov – Thu 5 Nov 2026, party of ${size} from ${org} HQ`,
            `two of the group keep halal; ${client.first} is coeliac (strict, no shared fryers); ${org} policy: no ` +
              `alcohol at hosted meals`,
            "2026-10-22",
          ),
          updatedAt: at(10, 22, 15, 10),
        },
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${orgOf(other)} — On-site visit`,
          text: record(
            c.tb,
            orgOf(other),
            other,
            `Wed 2 Dec – Thu 3 Dec 2026, party of ${size - 2} from ${orgOf(other)} HQ`,
            `${other.first} is vegetarian; one nut allergy (severe)`,
            "2026-10-19",
          ),
          updatedAt: at(10, 19, 11, 40),
        },
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: calendar (event)
  //   · anchored: yes · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "conference-panel-departure",
    build: (c) => {
      const [mod] = c.colleagues(1) as [Person];
      const panel = (when: string, start: number, edited: number, t: Rng): Plant =>
        event({
          title: "Panel: Scaling support ops — Stage 4 (Web Summit)",
          start,
          when,
          where: "Altice Arena, Lisbon — speakers' entrance on Rua do Bojador",
          notes:
            `Moderator: ${mod.full}. Speakers to the green room 45 min before. ` +
            t.pick(["Slides as 16:9 PDF to the AV desk.", "Lapel mic, no slides.", "Bring the clicker."]),
          edited,
        });
      return {
        text: "Thinking of flying out next Wednesday evening for my talk.",
        detail:
          "The Web Summit panel was quietly moved from Thu 5 Nov 11:00 to Wed 4 Nov 15:30 Lisbon time, so " +
          "flying out on Wednesday evening misses it; fly Tuesday 3 Nov or first thing Wednesday.",
        hidden: panel("Wed 4 Nov 2026, 15:30–16:15 (Lisbon, WET)", at(11, 4, 15, 30), at(10, 23, 16, 5), c.ta),
        decoy: panel("Thu 5 Nov 2026, 11:00–11:45 (Lisbon, WET)", at(11, 5, 11), at(10, 6, 10, 20), c.tb),
        before: panel("Thu 5 Nov 2026, 11:00–11:45 (Lisbon, WET)", at(11, 5, 11), at(10, 6, 10, 20), c.ta),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: question · source: slack (chat)
  //   · anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "quarterly-review-friday-slot",
    build: (c) => {
      const [lead, other, by] = c.colleagues(3) as [Person, Person, Person];
      return {
        text: `Can we do the quarterly review with ${lead.first}'s team Friday at 4pm?`,
        detail:
          `${lead.full} and the squad now work from the Auckland office (NZDT, UTC+13): Friday 16:00 in London ` +
          "is 05:00 on Saturday for them, so the slot needs to move (early morning UK works).",
        hidden: chat(
          c.ta,
          "general",
          [
            {
              who: lead,
              text:
                "heads up all: from Mon 26th I'm working out of our Auckland office until mid-Feb, and the rest " +
                "of the platform squad is coming with me 🥝 calendars updating to NZ hours",
              when: at(10, 23, 10, 12),
            },
          ],
          by,
        ),
        decoy: chat(
          c.tb,
          "general",
          [
            {
              who: other,
              text: "heads up: from Mon 26th I'm working out of the Dublin office until Christmas, same hours as ever",
              when: at(10, 23, 10, 12),
            },
          ],
          by,
        ),
      };
    },
  },
  // overlap: topic-word · decoy: (c) condition met · phrasing: imperative · source: slack (chat)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: Spanish
  {
    name: "speaker-room-reservation",
    build: (c) => {
      const [events, by] = c.colleagues(2) as [Person, Person];
      return {
        text: "Resérvame un hotel para la conferencia de Berlín, del 16 al 19.",
        detail:
          "The Berlin organisers already hold a room for every speaker at the partner hotel 16–19 Nov, paid by " +
          `them (${events.full} in #events); booking another one duplicates it and expenses will not cover it.`,
        hidden: chat(
          c.ta,
          "events",
          [
            {
              who: events,
              text:
                `@${c.user.first} re Berlin: organisers hold a room for every speaker at the partner hotel 16–19 Nov, ` +
                "paid by them. please don't book your own, expenses won't cover a second one",
              when: at(10, 21, 14, 3),
            },
          ],
          by,
        ),
        decoy: chat(
          c.tb,
          "events",
          [
            {
              who: events,
              text:
                `@${c.user.first} re Berlin: speakers sort their own rooms this year, code SPK26 gets 15% off at ` +
                "the partner hotel, expense it as usual",
              when: at(10, 21, 14, 3),
            },
          ],
          by,
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: drive (doc)
  //   · anchored: no · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "offsite-rail-tickets",
    build: (c) => {
      const [owner] = c.colleagues(1) as [Person];
      const plan = (title: string, date: string, travel: string, t: Rng, edited: number): Plant =>
        doc(
          title,
          [
            `Date: ${date}`,
            "Venue: Swinton Estate, Masham",
            `Travel: ${travel}`,
            `Agenda: ${t.pick(["roadmap review, then team lunch", "retro in the morning, workshop after lunch"])}`,
            `Dietary needs to ${owner.full} by Thu 5 Nov.`,
          ].join("\n"),
          edited,
        );
      return {
        text: "I'll sort the trains for everyone for the away day.",
        detail:
          "The offsite plan now says a coach is hired from the office (leaves 08:15 on Thu 12 Nov, back 18:30) and " +
          "no rail tickets are needed; it used to say everyone books their own rail to Harrogate.",
        hidden: plan(
          "Q4 team offsite — logistics",
          "Thu 12 Nov 2026",
          "coach hired from the office, departs 08:15 sharp from the front entrance, returns 18:30. No rail tickets needed.",
          c.ta,
          at(10, 24, 18, 2),
        ),
        decoy: plan(
          "Q3 team offsite — logistics",
          "Thu 16 Jul 2026",
          "coach hired from the office, departs 08:30 from the front entrance, returns 18:00. No rail tickets needed.",
          c.tb,
          at(7, 2, 12, 0),
        ),
        before: plan(
          "Q4 team offsite — logistics",
          "Thu 12 Nov 2026",
          "book your own rail to Harrogate (LNER or Northern) and expense it; shared taxis from the station.",
          c.ta,
          at(10, 9, 9, 30),
        ),
      };
    },
  },
  // ---------------------------------------------------------------- family
  // overlap: name · decoy: (c) condition met · phrasing: question · source: whatsapp (chat)
  //   · anchored: no · silent: no · rare: yes · knowledge: no · language: Italian
  {
    name: "zia-naples-visit",
    build: (c) => {
      const days = c.r.int(20, 23);
      const thread = (lines: [string, string][], last: number) =>
        chatText(lines.map(([who, text], i) => ({ who, text, at: last - (lines.length - 1 - i) * 7 * 60_000 })));
      return {
        text: "Dici che prenoto il volo per Napoli per andare da zia Carla verso metà novembre?",
        detail:
          `Zia Carla said in WhatsApp that she is at Marco's in Milan from 9 to ${days} Nov for the new baby and the ` +
          "Naples flat is shut, so a mid-November trip to Naples would miss her.",
        hidden: rare(
          "whatsapp",
          "Zia Carla",
          thread(
            [
              ["Carla Esposito", "sweetheart we're off to Marco's in Milan for the baby 👶"],
              ["Carla Esposito", `from 9 till ${days} Nov, the Naples flat is shut up, Gino turned the water off`],
              [c.user.full, "aww congratulations!! send photos"],
            ],
            at(10, 25, 19, 40),
          ),
          at(10, 25, 19, 40),
        ),
        decoy: rare(
          "whatsapp",
          "Zia Carla",
          thread(
            [
              ["Carla Esposito", "change of plan, Milan's off, the baby came early and they're coming down to us"],
              ["Carla Esposito", "so we're home in Naples all November, come whenever you like ❤️"],
              [c.user.full, "amazing, congratulations!!"],
            ],
            at(10, 25, 19, 40),
          ),
          at(10, 25, 19, 40),
        ),
      };
    },
  },
  // overlap: name · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "ferry-crossing-family",
    build: (c) => {
      const ref = c.r.int(4_100_000, 4_899_999);
      const ferries = bot("Brittany Ferries", "bookings@brittany-ferries.co.uk");
      return {
        text: "Book the four of us on the Saturday ferry to Santander.",
        detail:
          `There is already a confirmed Brittany Ferries booking (ref ${ref}) for 2 adults, 2 children and a car, ` +
          "Portsmouth to Santander on Sat 21 Nov 17:00; booking again would duplicate it.",
        hidden: notice(c, c.ta, {
          from: ferries,
          when: at(10, 18, 20, 14),
          title: `Booking confirmed — ${ref}`,
          body: [
            `Booking reference: ${ref}`,
            "Route: Portsmouth → Santander",
            "Sailing: Sat 21 Nov 2026, depart 17:00, arrive Mon 23 Nov 08:15 (local time)",
            "Passengers: 2 adults, 2 children · Vehicle: car (under 1.85 m)",
            "Cabin: 4-berth inside, ensuite",
            "Check-in closes 45 minutes before departure.",
          ].join("\n"),
        }),
        decoy: notice(c, c.tb, {
          from: ferries,
          when: at(6, 30, 9, 2),
          title: `Booking cancelled — ${ref - 211_000}`,
          body: [
            `Booking reference: ${ref - 211_000}`,
            "Route: Portsmouth → Santander",
            "Sailing: Sat 25 Jul 2026 — CANCELLED at your request",
            "A refund of £1,284.00 has been made to the card used for payment.",
          ].join("\n"),
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: calendar (event)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: Arabic
  {
    name: "funeral-trip-amman",
    build: (c) => {
      const juror = c.r.int(1000, 4999);
      return {
        text: "هل أحجز رحلة إلى عمّان يوم الجمعة لحضور العزاء؟",
        detail:
          "The user is on jury service at Snaresbrook Crown Court on weekdays until Fri 6 Nov; Friday 30 Oct is " +
          "a sitting day, so they must ask the jury office for permission (a bereavement excusal) before booking.",
        hidden: event({
          title: "Jury service — Snaresbrook Crown Court",
          start: at(10, 26, 9, 15),
          when: "Mon 26 Oct – Fri 6 Nov 2026, weekdays, report 09:15",
          where: "Snaresbrook Crown Court, Hollybush Hill, E11",
          notes:
            `Juror no. ${juror}. ` +
            c.ta.pick(["Bring the summons letter.", "No laptops in court 4."]) +
            " Absence on a sitting day only with the court's permission: call the jury central summoning bureau.",
          edited: at(9, 14, 8, 0),
        }),
        decoy: event({
          title: "Jury service (deferred) — Snaresbrook Crown Court",
          start: at(2, 1, 9, 15, 2027),
          when: "Mon 1 Feb – Fri 12 Feb 2027, weekdays, report 09:15",
          where: "Snaresbrook Crown Court, Hollybush Hill, E11",
          notes: `Juror no. ${juror}. Deferred from Oct 2026 at your request. ` + c.tb.pick(["Bring the summons."]),
          edited: at(9, 14, 8, 0),
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: calendar (event)
  //   · anchored: yes · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "mum-arrivals-collect",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const sister = c.role("sister", ["Ellie", "Carter"]);
      const land = (who: string, flight: string, when: string, start: number, where: string, t: Rng, e: number) =>
        event({
          title: `${who} lands — ${flight}`,
          start,
          when,
          where,
          notes: `Overnight flight. ${t.pick(["She'll have the big suitcase + a box of wine.", "Two bags, one heavy."])} Text when parked, short stay car park.`,
          edited: e,
        });
      return {
        text: "I'll pick Mum up from Heathrow Thursday after work.",
        detail:
          `${mum.first}'s BA 58 from Cape Town now lands at 06:15 on Thu 29 Oct (LHR T5), not 18:20 as before, so ` +
          "collecting her after work would leave her waiting all day.",
        hidden: land(
          mum.first,
          "BA 58 from Cape Town",
          "Thu 29 Oct 2026, 06:15",
          at(10, 29, 6, 15),
          "LHR Terminal 5, arrivals",
          c.ta,
          at(10, 24, 7, 50),
        ),
        decoy: land(
          sister.first,
          "EZY 8402 from Geneva",
          "Thu 29 Oct 2026, 19:05",
          at(10, 29, 19, 5),
          "LGW North Terminal, arrivals",
          c.tb,
          at(10, 20, 12, 0),
        ),
        before: land(
          mum.first,
          "BA 58 from Cape Town",
          "Thu 29 Oct 2026, 18:20",
          at(10, 29, 18, 20),
          "LHR Terminal 5, arrivals",
          c.ta,
          at(10, 2, 21, 15),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: school (mail)
  //   · anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "wales-cottage-midterm",
    build: (c) => {
      const teacher = c.role("Maya's teacher", ["Mrs", "Daley"]);
      const fine = c.r.pick([80, 120]);
      const letter = (dates: string, year: string, t: Rng) =>
        [
          "Dear Parent/Carer,",
          `${teacher.full}'s class (Year 5) will sit their autumn assessments ${dates}.`,
          "Leave of absence in term time will not be authorised during this period. Unauthorised absence of five " +
            `or more sessions may result in a fixed penalty notice of £${fine} per parent from the local authority.`,
          t.pick([
            "Please make sure your child has a good breakfast on these mornings.",
            "Thank you for your support.",
          ]),
          `Holloway Primary, ${year}`,
        ].join("\n");
      return {
        text: "Book the cottage in Wales for the week of the 16th.",
        detail:
          "Maya's class (Year 5) has autumn assessments Mon 16 – Fri 27 Nov; the school will not authorise term-" +
          `time leave then and unauthorised absence can bring a £${fine}-per-parent fine.`,
        hidden: rare(
          "school",
          "Year 5 autumn assessments",
          letter("Mon 16 – Fri 27 Nov", "October 2026", c.ta),
          at(10, 20, 15, 30),
        ),
        decoy: rare(
          "school",
          "Year 5 autumn assessments",
          letter("Mon 17 – Fri 28 Nov 2025", "October 2025", c.tb),
          at(10, 21, 15, 30, 2025),
        ),
      };
    },
  },
  // ---------------------------------------------------------------- health
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: notes (doc)
  //   · anchored: no · silent: yes · rare: yes · knowledge: yes · language: English
  {
    name: "red-sea-last-dives",
    build: (c) => {
      const club = c.r.pick(["Camel Dive Club", "Sinai Divers", "Oonas Dive Centre"]);
      const note = (lines: string[], t: Rng) =>
        [
          `PADI Advanced — ${club}`,
          ...lines,
          t.pick(["Bring: logbook, mask, reef-safe suncream", "Bring: logbook, defogger, spare strap"]),
          "Cert card: they email it after",
        ].join("\n");
      return {
        text: "Planning to fly home Saturday morning from Sharm.",
        detail:
          "The dive note now has two Thistlegorm dives and a night dive on Fri 30 Oct, back about 21:30; flying " +
          "less than 18-24 hours after diving risks decompression sickness, so a Saturday-morning flight is too soon.",
        hidden: rare(
          "notes",
          "Red Sea dive trip",
          note(
            [
              "- Wed 28: Ras Mohammed x2 (boat 07:30)",
              "- Thu 29: navigation + buoyancy, shore",
              "- Fri 30: Thistlegorm wreck x2 + night dive, back ~21:30",
            ],
            c.ta,
          ),
          at(10, 26, 20, 10),
        ),
        decoy: rare(
          "notes",
          "Red Sea dive trip",
          note(
            [
              "- Wed 28: Thistlegorm wreck x2 (boat 06:00)",
              "- Thu 29: night dive, back ~20:00",
              "- Fri 30: free (Old Market, pack)",
            ],
            c.tb,
          ),
          at(10, 26, 20, 10),
        ),
        before: rare(
          "notes",
          "Red Sea dive trip",
          note(
            [
              "- Wed 28: Ras Mohammed x2 (boat 07:30)",
              "- Thu 29: Thistlegorm wreck x2 + night dive",
              "- Fri 30: free (Old Market, pack)",
            ],
            c.ta,
          ),
          at(10, 19, 21, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: question · source: health (notification)
  //   · anchored: no · silent: no · rare: yes · knowledge: yes · language: German
  {
    name: "japan-timezone-routine",
    build: (c) => {
      const units = c.r.int(16, 28);
      const gp = c.r.pick(["Dr Anand", "Dr Whitfield", "Dr Mensah"]);
      const issued = (items: string[], t: Rng) =>
        [
          `Your repeat prescription has been issued to ${t.pick(["Boots, High Street", "Superdrug, Camden"])}.`,
          "Items:",
          ...items.map((i) => `- ${i}`),
          "Ready to collect from: Wed 28 Oct",
          `Prescriber: ${gp}`,
        ].join("\n");
      return {
        text: "Nächste Woche flieg ich nach Tokio – kannst du mir einen Plan gegen Jetlag machen?",
        detail:
          `The user takes basal insulin (Lantus, ${units} units once daily at 22:00); a nine-hour shift to Tokyo ` +
          "means planning how to move that dose across time zones (and carrying insulin in the cabin), not just sleep.",
        hidden: rare(
          "health",
          "Repeat prescription issued",
          issued(
            [
              `Insulin glargine (Lantus) 100 units/ml SoloStar pen — ${units} units once daily at 22:00`,
              "NovoRapid FlexPen — as directed with meals",
              "FreeStyle Libre 2 sensors x2",
            ],
            c.ta,
          ),
          at(10, 26, 11, 5),
        ),
        decoy: rare(
          "health",
          "Repeat prescription issued",
          issued(
            ["Cetirizine 10 mg tablets — one daily as needed", "Diprobase emollient cream — apply twice a day"],
            c.tb,
          ),
          at(10, 26, 11, 5),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: gmail (mail)
  //   · anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "alpine-company-trip",
    build: (c) => {
      const physio = bot("Hannah Reid", "hannah@activephysio.co.uk");
      return {
        text: "Sign me up for the company skiing trip to Val Thorens.",
        detail:
          "The user had a right ACL reconstruction on 29 Sep; the physio plans return-to-sport tests at nine months, " +
          "so skiing in January (about three and a half months after surgery) is not safe.",
        hidden: mail(c, c.ta, {
          from: physio,
          when: at(10, 26, 17, 20),
          title: "Your session notes",
          body: [
            "Summary of today's session for your records: right knee, four weeks after ACL reconstruction (op 29 Sep).",
            "Phase 2 goals: full extension, quads activation, stationary bike 20 minutes daily.",
            "Straight-line jogging from about three months; return-to-sport tests at nine months.",
            "Next appointment Thu 5 Nov 08:30.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: physio,
          when: at(3, 12, 17, 20, 2025),
          title: "Your session notes",
          body: [
            "Final session today: left ankle sprain fully recovered, hop tests symmetrical.",
            "You're discharged with no restrictions; keep up the balance work twice a month.",
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: calendar (event)
  //   · anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "highland-ascent-tomorrow",
    build: (c) => {
      const doctor = c.r.pick(["Dr Anand", "Dr Fischer", "Dr Osei"]);
      const jab = (when: string, start: number, edited: number, t: Rng) =>
        event({
          title: "Steroid injection — right knee (MSK clinic)",
          start,
          when,
          where: "Royal Free Hospital, Outpatients B",
          notes: `${doctor}. ${t.pick(["Bring the referral letter.", "Bring your list of medicines."])} Arrange a lift.`,
          edited,
        });
      return {
        text: "Tomorrow I'm doing the Ben Nevis hike with the running club lot.",
        detail:
          "The user has a steroid injection in the right knee this morning (Tue 27 Oct 08:00); the joint should " +
          "be rested for a day or two afterwards, so a long mountain walk on Wednesday is a bad idea.",
        hidden: jab("Tue 27 Oct 2026, 08:00–08:30", at(10, 27, 8, 0), at(10, 12, 9, 40), c.ta),
        decoy: jab("Wed 18 Nov 2026, 08:00–08:30", at(11, 18, 8, 0), at(10, 12, 9, 40), c.tb),
      };
    },
  },
  // overlap: topic-word · decoy: (a) resolved/expired/superseded · phrasing: plan · source: calendar (event)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "thailand-vaccines-gp",
    build: (c) => {
      const clinic = c.r.pick(["Boots Travel Clinic, Oxford Street", "Superdrug Travel Clinic, Holborn"]);
      return {
        text: "Need to sort my jabs for Thailand with the GP.",
        detail:
          `A travel-clinic appointment is already booked (${clinic}, Mon 9 Nov 14:20) for hepatitis A, typhoid ` +
          "and a Japanese encephalitis discussion; no GP appointment is needed.",
        hidden: event({
          title: "Travel clinic — Thailand vaccines",
          start: at(11, 9, 14, 20),
          when: "Mon 9 Nov 2026, 14:20",
          where: clinic,
          notes:
            "Hep A + typhoid; discuss Japanese encephalitis (2 doses, 28 days apart) and rabies. " +
            c.ta.pick(["Bring your vaccination record.", "Pay at the appointment."]),
          edited: at(10, 15, 13, 0),
        }),
        decoy: event({
          title: "Cancelled: Travel clinic — Thailand vaccines",
          start: at(3, 2, 10, 0),
          when: "Mon 2 Mar 2026, 10:00",
          where: clinic,
          notes: "Cancelled by you on 20 Feb. " + c.tb.pick(["Rebook online.", "No charge."]),
          edited: at(2, 20, 9, 0),
        }),
      };
    },
  },
  // ---------------------------------------------------------------- money
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: bank (notification)
  //   · anchored: no · silent: no · rare: yes · knowledge: no · language: Japanese
  {
    name: "osaka-fare-payment",
    build: (c) => {
      const amount = c.r.int(480, 720) + 0.4;
      return {
        text: "来月の大阪出張、航空券は新しくカードで買おうと思ってる。",
        detail:
          `Lufthansa issued a travel voucher for £${amount.toFixed(2)} (the disputed August fare) valid for bookings ` +
          "made by 31 Dec 2026; the Osaka flight could use it instead of a new card payment.",
        hidden: rare(
          "bank",
          "Update on your dispute",
          [
            `We've finished looking into your dispute with Lufthansa (£${amount.toFixed(2)}, 3 Aug).`,
            "Lufthansa told us they issued a travel voucher for the full amount on 14 Sep instead of a refund, valid " +
              "for bookings made by 31 Dec 2026. Because a voucher was issued, we can't raise a chargeback.",
            "You'll find the voucher in the email Lufthansa sent to the address on your booking.",
          ].join("\n\n"),
          at(10, 16, 12, 30),
        ),
        decoy: rare(
          "bank",
          "Update on your dispute",
          [
            "Good news: your dispute with easyJet (£118.00, 2 Jun) is resolved.",
            "easyJet has refunded the full amount to your account. There's nothing more you need to do.",
          ].join("\n\n"),
          at(7, 9, 12, 30),
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "portugal-fares-payment",
    build: (c) => {
      const avios = c.r.int(12, 26) * 1_000 + c.r.int(1, 9) * 100;
      return {
        text: "Buy the Lisbon flights with my debit card.",
        detail:
          `${avios.toLocaleString("en-GB")} Avios expire on 15 Nov 2026 unless used; part-paying the Lisbon fares ` +
          "with Avios would use them before they lapse.",
        hidden: notice(c, c.ta, {
          from: bot("British Airways Executive Club", "executive.club@email.ba.com"),
          when: at(10, 15, 7, 0),
          title: "Your Avios are about to expire",
          body:
            `Your balance of ${avios.toLocaleString("en-GB")} Avios will expire on 15 Nov 2026 unless you collect or ` +
            "spend Avios before then.\nSpend them on reward seats, upgrades or Avios + money at checkout.",
        }),
        decoy: notice(c, c.tb, {
          from: bot("Costa Coffee Club", "club@costa.co.uk"),
          when: at(10, 15, 7, 0),
          title: "Your beans are about to expire",
          body: "You have 9 beans that will expire on 30 Nov 2026.\nUse them on any handcrafted drink in store.",
        }),
      };
    },
  },
  // overlap: topic-word · decoy: (c) condition met · phrasing: question · source: bank (notification)
  //   · anchored: no · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "abroad-spending-fees",
    build: (c) => {
      const fee = c.r.pick(["2.75%", "2.99%", "3%"]);
      return {
        text: "Which card should I take to Japan next week?",
        detail:
          `From 1 Nov the user's current-account card charges ${fee} on payments and withdrawals in currencies ` +
          "other than GBP (it used to be free), so another card without foreign fees is better for Japan.",
        hidden: rare(
          "bank",
          "Changes to your account terms",
          `From 1 November 2026, card payments and cash withdrawals in currencies other than GBP will carry a ${fee} ` +
            "fee (previously free on your plan).\nYou don't need to do anything. If you're not happy with the change " +
            "you can close your account at any time, free of charge.",
          at(9, 1, 8, 0),
        ),
        decoy: rare(
          "bank",
          "Changes to your account terms",
          "We're updating our terms from 1 November 2026. Spending abroad stays free: no fees on card payments in " +
            "other currencies, and cash withdrawals are free up to £200 every 30 days.",
          at(9, 1, 8, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: gmail (mail)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: Spanish
  {
    name: "cangas-house-deposit",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      const each = c.r.pick([170, 180, 190]);
      return {
        text: "Hoy le mando el depósito de la casa de Asturias a quien lo organiza.",
        detail:
          `${leila.full} wrote that the deposit for the Cangas house now goes straight to the owner (Marta Iglesias, ` +
          `IBAN in the mail), not to her, and it is now £${each} each instead of £150; due Fri 30 Oct.`,
        hidden: mail(c, c.ta, {
          from: leila,
          when: at(10, 25, 21, 12),
          title: "Cangas house",
          body: [
            "Small change on the deposit for the Cangas house: the owner wants it paid straight to her, not via me.",
            "Her details: Marta Iglesias, IBAN ES91 2100 0418 4502 0005 1332.",
            `And it's £${each} each now rather than £150, as the Ruizes dropped out.`,
            "Deadline is Fri 30 Oct.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: leila,
          when: at(10, 25, 21, 12),
          title: "Christmas do",
          body: [
            "Booked the upstairs room at the Dove for Sat 12 Dec!",
            "Deposit is £25 each, just send it to me by Fri 20 Nov and I'll pay them in one go.",
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: tasks (doc)
  //   · anchored: yes · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "flotilla-final-instalment",
    build: (c) => {
      const jamie = c.role("best friend", ["Jamie", "Fox"]);
      const total = c.r.pick([2_750, 2_950, 3_150]);
      const share = total / 5;
      return {
        text: "I'll pay the remaining balance for the Croatia sailing trip Friday.",
        detail:
          `${jamie.full} already settled the £${total.toLocaleString("en-GB")} flotilla instalment from the group ` +
          `kitty on Sat 24 Oct (task marked done); the user only owes ${jamie.first} their £${share} share.`,
        hidden: rare(
          "tasks",
          "Flotilla charter — final instalment",
          `✓ Completed Sat 24 Oct\nProject: Holidays 2027 · Priority 2\nNote: ${jamie.first} settled the ` +
            `£${total.toLocaleString("en-GB")} from the group kitty on Sat 24 Oct, owe him your £${share} share\n` +
            "Sub-tasks: ✓ crew list sent · ✓ skipper licence copy",
          at(10, 24, 18, 45),
        ),
        decoy: rare(
          "tasks",
          "Flotilla charter — final instalment",
          `Due: Fri 30 Oct · Priority 1\nProject: Holidays 2027\nNote: ${jamie.first} added you as a payer on the ` +
            `kitty account, fine to send the £${total.toLocaleString("en-GB")} from there\nSub-tasks: ✓ crew list sent`,
          at(10, 20, 9, 15),
        ),
        before: rare(
          "tasks",
          "Flotilla charter — final instalment",
          `Due: Fri 30 Oct · Priority 1\nProject: Holidays 2027\nNote: £${total.toLocaleString("en-GB")} to Sail ` +
            "Adriatic, IBAN in the confirmation email\nSub-tasks: ✓ crew list sent · ☐ skipper licence copy",
          at(10, 11, 10, 0),
        ),
      };
    },
  },
  // ---------------------------------------------------------------- travel
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: trips (doc)
  //   · anchored: yes · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "ribeira-loft-arrival",
    build: (c) => {
      const conf = c.r.token("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 10);
      const stay = (checkin: string, t: Rng) =>
        [
          "Air: TP1331 LHR → OPO, Fri 30 Oct 06:40 → 09:05",
          "Lodging: Airbnb — Ribeira loft, Rua de São João 41",
          `Check-in: ${checkin}`,
          "Check-out: Mon 2 Nov, 11:00",
          `Confirmation: HM${conf}`,
          t.pick(["Host: Inês (replies fast on the app)", "Host: Inês · wifi details on the fridge"]),
        ].join("\n");
      return {
        text: "Planning to get into the Porto flat around 10am Friday.",
        detail:
          "The Ribeira loft booking now says check-in from 15:00 (self check-in, no luggage drop); the agreed " +
          "09:00 early arrival is gone, so arriving at 10:00 means waiting until 15:00 or storing bags elsewhere.",
        hidden: rare(
          "trips",
          "Ribeira long weekend",
          stay("Fri 30 Oct, from 15:00 (self check-in, lockbox code sent 24 h before; no luggage drop)", c.ta),
          at(10, 25, 8, 30),
        ),
        decoy: rare(
          "trips",
          "Alfama, December",
          [
            "Air: TP1351 LHR → LIS, Fri 11 Dec 07:05 → 09:40",
            "Lodging: Alfama Patio Hotel",
            "Check-in: Fri 11 Dec, from 15:00 (bags can be left at reception)",
            "Check-out: Mon 14 Dec, 12:00",
            `Confirmation: ${conf}`,
          ].join("\n"),
          at(10, 25, 8, 30),
        ),
        before: rare(
          "trips",
          "Ribeira long weekend",
          stay("Fri 30 Oct, from 09:00 (early arrival agreed with host; Inês meets you)", c.ta),
          at(10, 8, 14, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: gmail (notification)
  //   · anchored: yes · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "us-domestic-carry-on",
    build: (c) => {
      const conf = c.r.token("ABCDEFGHJKLMNPQRSTUVWXYZ", 6);
      const united = bot("United Airlines", "unitedairlines@united.com");
      const confirm = (t: Rng, fare: string) =>
        notice(c, t, {
          from: united,
          when: at(10, 22, 16, 48),
          title: `Your trip confirmation — ${conf}`,
          body: [
            `Confirmation number: ${conf}`,
            "Thu 12 Nov 2026",
            "UA 1532 Chicago O'Hare (ORD) 08:05 → DEN 09:48",
            `Fare: ${fare}`,
            `Traveler: ${c.user.full.toUpperCase()}`,
            "Seat: assigned at check-in",
          ].join("\n"),
        });
      return {
        text: "Can I bring my wheelie case on board for the Denver leg?",
        detail:
          "The ORD–DEN flight (UA 1532, Thu 12 Nov) is booked in Basic Economy, which on US domestic flights allows " +
          "only a personal item under the seat, not a full-size carry-on; the case must be checked (for a fee).",
        hidden: confirm(c.ta, "Basic Economy (N)"),
        decoy: confirm(c.tb, "Economy (K) · 1 carry-on + 1 personal item included"),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: imperative · source: calendar (event)
  //   · anchored: no · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "eurostar-morning-taxi",
    build: (c) => {
      const coach = c.r.int(3, 16);
      const train = (title: string, when: string, start: number, t: Rng, edited: number) =>
        event({
          title,
          start,
          when,
          where: "St Pancras International",
          notes: `Coach ${coach}, seat ${t.int(11, 78)}. Gates close 30 min before departure.`,
          edited,
        });
      return {
        text: "Order a cab to St Pancras for 7:15 tomorrow.",
        detail:
          "The Eurostar on Wed 28 Oct now leaves at 06:31 (it was 08:31) and the gates close 30 minutes before, so " +
          "a 07:15 cab is too late; it needs to be about 05:30.",
        hidden: train(
          "Eurostar to Paris — 9008",
          "Wed 28 Oct 2026, dep 06:31 · arr Paris Nord 09:47",
          at(10, 28, 6, 31),
          c.ta,
          at(10, 26, 19, 2),
        ),
        decoy: train(
          "Eurostar to Brussels — 9126",
          "Wed 25 Nov 2026, dep 07:01 · arr Bruxelles-Midi 10:05",
          at(11, 25, 7, 1),
          c.tb,
          at(10, 26, 19, 2),
        ),
        before: train(
          "Eurostar to Paris — 9008",
          "Wed 28 Oct 2026, dep 08:31 · arr Paris Nord 11:47",
          at(10, 28, 8, 31),
          c.ta,
          at(10, 5, 12, 40),
        ),
      };
    },
  },
  // overlap: name · decoy: (c) condition met · phrasing: plan · source: slack (chat)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "northbound-rail-strike",
    build: (c) => {
      const [poster, by] = c.colleagues(2) as [Person, Person];
      return {
        text: "I'm planning to take the train to the Glasgow office next Wednesday.",
        detail:
          "RMT strike on Avanti West Coast on Wed 4 Nov: no Euston–Glasgow trains all day; go a day early, fly, or " +
          "use the crowded LNER route.",
        hidden: chat(
          c.ta,
          "glasgow-office",
          [
            {
              who: poster,
              text: "fyi for anyone heading up: RMT strike on Avanti West Coast Wed 4 Nov, no Euston–Glasgow services all day. LNER running but rammed",
              when: at(10, 26, 16, 22),
            },
          ],
          by,
        ),
        decoy: chat(
          c.tb,
          "glasgow-office",
          [
            {
              who: poster,
              text: "fyi the strike on Wed 4 Nov is Southern/Thameslink only, Avanti and LNER to Glasgow unaffected",
              when: at(10, 26, 16, 22),
            },
          ],
          by,
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: trips (doc)
  //   · anchored: yes · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "krakow-departure-hour",
    build: (c) => {
      const ref = c.r.token("ABCDEFGHJKLMNPQRSTUVWXYZ", 6);
      const trip = (dep: string, arr: string, t: Rng) =>
        [
          "Air: Ryanair FR 2471 London Stansted (STN) → Kraków (KRK)",
          `Depart: Tue 3 Nov 2026 ${dep} · Arrive ${arr}`,
          `Booking ref: ${ref}`,
          "Bags: 1 small bag + priority (10 kg)",
          `Lodging: ${t.pick(["Hotel Stary, 3 nights", "Aparthotel Kazimierz, 3 nights"])}`,
          "Return: Fri 6 Nov, FR 2472 10:05",
        ].join("\n");
      return {
        text: "What time should I leave for the airport on the 3rd?",
        detail:
          "The Kraków flight FR 2471 on Tue 3 Nov now departs Stansted at 06:10 (it was 09:40), so the user " +
          "needs to leave around 03:30-04:00, not mid-morning.",
        hidden: rare("trips", "Kraków city break", trip("06:10", "09:30", c.ta), at(10, 23, 22, 5)),
        decoy: rare(
          "trips",
          "Kraków (cancelled)",
          `Status: CANCELLED — refunded 12 Sep\nAir: Wizz Air W6 1305 London Luton (LTN) → Kraków (KRK)\nDepart: Tue 3 Nov 2026 07:20\nBooking ref: ${ref.split("").reverse().join("")}`,
          at(9, 12, 10, 0),
        ),
        before: rare("trips", "Kraków city break", trip("09:40", "13:00", c.ta), at(9, 30, 18, 0)),
      };
    },
  },
  // ---------------------------------------------------------------- home
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: residents (doc)
  //   · anchored: no · silent: yes · rare: yes · knowledge: no · language: Korean
  {
    name: "heating-off-while-away",
    build: (c) => {
      const min = c.r.pick([10, 12, 14]);
      const notice2 = (body: string, t: Rng) =>
        `Posted by Rendall & Rittner, managing agent for Albion Court\n\n${body}\n\n` +
        t.pick(["Questions: residents@rendallandrittner.co.uk", "Out of hours emergencies: 0345 000 1234"]);
      return {
        text: "다음 주부터 2주 동안 집 비우니까 보일러 꺼두고 갈게.",
        detail:
          "The residents' portal notice now says the communal frost protection is out of service until January: " +
          `flats left empty must keep heating at ${min}°C or more, and burst-pipe damage in unheated flats is recharged.`,
        hidden: rare(
          "residents",
          "Heating and frost protection this winter",
          notice2(
            "The communal frost-protection system failed its inspection and will not be replaced until January " +
              `2027. Until then, if you are away, please leave your heating on at a minimum of ${min}°C. ` +
              "Leaseholders will be recharged for damage from burst pipes in unheated flats.",
            c.ta,
          ),
          at(10, 22, 12, 0),
        ),
        decoy: rare(
          "residents",
          "Winter tips for residents",
          notice2(
            "The communal frost-protection system keeps pipes above freezing in every flat, so if you are away over " +
              "winter you may switch your heating off. Remember to bleed radiators when you return.",
            c.tb,
          ),
          at(10, 22, 12, 0),
        ),
        before: rare(
          "residents",
          "Heating and frost protection this winter",
          notice2(
            "The communal frost-protection system keeps pipes above freezing in every flat. If you are away over " +
              "winter, you may switch your heating off.",
            c.ta,
          ),
          at(10, 1, 12, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: gmail (mail)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "neighbour-greenery-help",
    build: (c) => {
      const gwen = bot("Gwen Pritchard", "gwen.pritchard@btinternet.com");
      const back = c.r.pick([19, 20, 21]);
      return {
        text: "Text the neighbour to water the plants while we're in Greece.",
        detail:
          `Gwen next door is at her daughter's in Leeds from Fri 6 Nov to ${back} Nov and said she can't do the ` +
          "post or the plants this time, so someone else is needed for the Greece trip.",
        hidden: mail(c, c.ta, {
          from: gwen,
          when: at(10, 24, 10, 30),
          title: "Away for a bit",
          body: [
            `Just to let you know Phil and I are off to our daughter's in Leeds from Fri 6 Nov until ${back} Nov.`,
            "So I'm afraid I can't do your post or the greenery this time!",
            "Our key for yours is in the drawer if you want it back before then.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: gwen,
          when: at(10, 24, 10, 30),
          title: "Away for a bit",
          body: [
            "Just to let you know Phil and I are off to our daughter's in Leeds from Fri 11 Dec until Mon 4 Jan.",
            "Could you keep an eye on the parcels for us? Happy to return the favour any other time.",
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: drive (doc)
  //   · anchored: yes · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "kennel-stay-seville",
    build: (c) => {
      const chip = c.r.int(100_000_000, 999_999_999);
      const record = (kc: string, t: Rng) =>
        [
          `Biscuit (cocker spaniel, 4 yrs) · microchip 826 097 ${chip}`,
          `Vet: Riverside Vets, ${t.pick(["Dr Kaur", "Dr Lindqvist"])}`,
          "Vaccinations:",
          "- DHP + Lepto L4 annual booster: 20 Oct 2026 (next due Oct 2027)",
          `- Kennel cough (Bb, intranasal): ${kc}`,
          "Flea/worm: Bravecto, last 1 Oct",
          "Insurance: Petplan, lifetime cover",
        ].join("\n");
      return {
        text: "Should the dog go to the kennels for our Seville week?",
        detail:
          "Biscuit's record shows no kennel cough vaccine; boarding kennels almost always require it, given at " +
          "least two weeks before the stay, so it needs booking now or kennels will refuse him.",
        hidden: doc("Pet records — Biscuit", record("never given", c.ta), at(10, 20, 18, 0)),
        decoy: doc("Pet records — Biscuit", record("2 Sep 2026 (valid 12 months)", c.tb), at(10, 20, 18, 0)),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: calendar (event)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "house-sitter-handover",
    build: (c) => {
      const landlord = c.role("landlord", ["Steve", "Hargreaves"]);
      const check = (when: string, start: number, t: Rng) =>
        event({
          title: "Gas safety check — engineer visit",
          start,
          when,
          where: "Flat 3, Albion Court",
          notes:
            `Booked by ${landlord.full} (landlord). Engineer needs access to the boiler and hob; someone must be in. ` +
            t.pick(["Certificate copy to follow by email.", "Clear the cupboard in front of the boiler."]),
          edited: at(10, 19, 9, 0),
        });
      return {
        text: "Send Leila the instructions for house-sitting next week.",
        detail:
          "The landlord's gas safety engineer is coming Wed 4 Nov 10:00–12:00 and someone must let them in, so " +
          "Leila needs to be told to be in (and where the boiler cupboard is).",
        hidden: check("Wed 4 Nov 2026, 10:00–12:00", at(11, 4, 10), c.ta),
        decoy: check("Wed 9 Dec 2026, 10:00–12:00", at(12, 9, 10), c.tb),
      };
    },
  },
  // overlap: name · decoy: (a) resolved/expired/superseded · phrasing: plan · source: gmail (notification)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "post-hold-request",
    build: (c) => {
      const order = c.r.int(10_000_000, 99_999_999);
      const rm = bot("Royal Mail", "noreply@royalmail.com");
      return {
        text: "I'll get Royal Mail to hold our post from the 6th.",
        detail:
          `A Royal Mail Keepsafe is already set up (order ${order}) from Fri 6 Nov to Fri 20 Nov, delivery on ` +
          "Sat 21 Nov; there is nothing more to arrange.",
        hidden: notice(c, c.ta, {
          from: rm,
          when: at(10, 21, 22, 3),
          title: "Your Keepsafe is set up",
          body:
            `Order number: ${order}\nWe'll keep your mail safe from Fri 6 Nov 2026 to Fri 20 Nov 2026 and deliver ` +
            "it all on Sat 21 Nov.\nAddress: Flat 3, Albion Court",
        }),
        decoy: notice(c, c.tb, {
          from: rm,
          when: at(8, 22, 9, 0),
          title: "Your Keepsafe has ended",
          body:
            `Order number: ${order - 4_120_000}\nYour Keepsafe (8 Aug – 21 Aug 2026) has ended and your mail ` +
            "has been delivered.\nAddress: Flat 3, Albion Court",
        }),
      };
    },
  },
  // ---------------------------------------------------------------- admin
  // overlap: none · decoy: (b) other entity or date · phrasing: statement · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: yes · language: Russian
  {
    name: "new-york-entry-authorisation",
    build: (c) => {
      const last4 = c.r.int(1000, 9999);
      const hmpo = bot("HM Passport Office", "noreply@passport.service.gov.uk");
      return {
        text: "В декабре лечу в Нью-Йорк на конференцию, билеты уже взял.",
        detail:
          `The user's new passport (ending ${last4}) was issued and the old one cancelled on 20 Oct; an ESTA is tied ` +
          "to the passport it was granted on, so they need a new ESTA before flying to the US.",
        hidden: notice(c, c.ta, {
          from: hmpo,
          when: at(10, 20, 15, 0),
          title: "Your new passport is on its way",
          body:
            "Your new passport has been printed and was sent to you by secure delivery on 20 Oct 2026.\n" +
            `Passport number ending: ${last4}\nYour old passport has been cancelled. Do not try to use it for travel.`,
        }),
        decoy: notice(c, c.tb, {
          from: hmpo,
          when: at(10, 20, 15, 0),
          title: "Maya's new passport is on its way",
          body:
            "The child passport for MAYA has been printed and was sent by secure delivery on 20 Oct 2026.\n" +
            `Passport number ending: ${((last4 + 3_311) % 9_000) + 1_000}\nThe previous child passport has been cancelled.`,
        }),
      };
    },
  },
  // overlap: topic-word · decoy: (c) condition met · phrasing: question · source: notes (doc)
  //   · anchored: no · silent: no · rare: yes · knowledge: yes · language: English
  {
    name: "bali-document-validity",
    build: (c) => {
      const num = c.r.int(500_000_000, 599_999_999);
      const nums = (pass: string, t: Rng) =>
        [
          `Passport: ${num} · ${pass}`,
          `NI number: ${t.pick(["QQ 12 34 56 C", "JT 48 22 91 A"])}`,
          "Driving licence: exp 2031",
          "GHIC: exp 2029",
          "Bike lock: 4-1-7-7",
        ].join("\n");
      return {
        text: "Is my passport fine for the Bali trip in January?",
        detail:
          "The passport expires 3 May 2027; Indonesia requires at least six months' validity on arrival, so for a " +
          "January trip (validity needed to about July 2027) it must be renewed first.",
        hidden: rare(
          "notes",
          "Important numbers",
          nums("issued 3 May 2017 · expires 3 May 2027", c.ta),
          at(6, 2, 20, 0),
        ),
        decoy: rare(
          "notes",
          "Important numbers",
          nums("issued 3 May 2019 · expires 3 May 2029", c.tb),
          at(6, 2, 20, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: drive (doc)
  //   · anchored: yes · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "delhi-entry-paperwork",
    build: (c) => {
      const [client] = c.clients(1) as [Person];
      const prep = (title: string, dates: string, paperwork: string, edited: number) =>
        doc(
          title,
          [
            `Dates: ${dates}`,
            "Flights: through the travel desk (AI 162)",
            `Entry paperwork: ${paperwork}`,
            "Lodging: The Lodhi",
            `Client: ${orgOf(client)}, ${client.full}`,
          ].join("\n"),
          edited,
        );
      return {
        text: "Apply for the India visa tonight.",
        detail:
          "The Delhi trip checklist now says the travel desk (CIBT) lodges the e-Business application for everyone " +
          "and a duplicate gets rejected; the user should only send them a passport scan and photo by Fri 30 Oct.",
        hidden: prep(
          "Delhi trip — prep checklist",
          "Sun 15 – Sat 21 Nov 2026",
          "travel desk (CIBT) lodges the e-Business application for all four travellers — don't lodge your own, " +
            "duplicates get rejected. Send them a scan of your photo page + a white-background photo by Fri 30 Oct.",
          at(10, 26, 17, 30),
        ),
        decoy: prep(
          "Mumbai trip (2025) — prep checklist",
          "Sun 9 – Fri 14 Feb 2025",
          "travel desk (CIBT) lodges the e-Business application for everyone; send them your scans by 20 Jan.",
          at(1, 10, 11, 0, 2025),
        ),
        before: prep(
          "Delhi trip — prep checklist",
          "Sun 15 – Sat 21 Nov 2026",
          "each traveller lodges their own e-Business application on the official site, at least 4 days ahead " +
            "(fee $80).",
          at(10, 12, 9, 0),
        ),
      };
    },
  },
  // overlap: topic-word · decoy: (b) other entity or date · phrasing: plan · source: school (mail)
  //   · anchored: no · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "child-passport-renewal",
    build: (c) => {
      const teacher = c.role("Maya's teacher", ["Mrs", "Daley"]);
      const letter = (cls: string, trip: string, by: string, t: Rng) =>
        [
          "Dear Parent/Carer,",
          `Thank you for the deposits for the ${cls} residential to ${trip}. Please hand in your child's passport ` +
            `(valid until at least June 2027) and GHIC card to the school office by ${by}.`,
          "We'll keep them in the school safe and hand them back at the coach.",
          t.pick(["Kit lists will follow after half term.", "A parents' meeting about the trip is on the website."]),
        ].join("\n");
      return {
        text: "Let's post off Maya's passport renewal this week.",
        detail:
          "Maya's class (Year 5) must hand her passport to the school office by Fri 13 Nov for the Normandy " +
          "residential (7-11 Dec); a renewal sent now would take weeks and leave nothing to hand in.",
        hidden: rare(
          "school",
          "Year 5 Normandy residential — documents",
          letter(`${teacher.full}'s class (Year 5)`, "Normandy (Mon 7 – Fri 11 Dec)", "Fri 13 Nov", c.ta),
          at(10, 23, 15, 45),
        ),
        decoy: rare(
          "school",
          "Year 6 Ardèche residential — documents",
          letter("Mr Osei's class (Year 6)", "the Ardèche (Mon 14 – Fri 18 Jun 2027)", "Fri 30 Apr 2027", c.tb),
          at(10, 23, 15, 45),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: gmail (notification)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "algarve-rental-licence",
    build: (c) => {
      const driver = c.r.token("ABCDEFGHJKLMNPRSTUVWXYZ", 5);
      const dvla = bot("DVLA", "noreply@notifications.dvla.gov.uk");
      return {
        text: "Book a hire car at Faro for the 18th.",
        detail:
          "The user's photocard driving licence expires on Sat 14 Nov, before the 18 Nov rental; the rental desk " +
          "will refuse an expired licence, so it must be renewed now (online, about a week).",
        hidden: notice(c, c.ta, {
          from: dvla,
          when: at(10, 14, 9, 0),
          title: "Your photocard driving licence is about to expire",
          body:
            "Your photocard driving licence expires on 14 Nov 2026. You must renew it to keep driving.\nRenew " +
            `online at GOV.UK: it costs £14 and usually arrives within a week.\nDriver number ending: ${driver}`,
        }),
        decoy: notice(c, c.tb, {
          from: dvla,
          when: at(9, 2, 9, 0),
          title: "Your new photocard driving licence is on its way",
          body: `Your renewed photocard driving licence is valid until 2 Sep 2036.\nDriver number ending: ${driver}`,
        }),
      };
    },
  },
  // ---------------------------------------------------------------- social
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: calendar (event)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: Greek
  {
    name: "fortieth-dinner-table",
    build: (c) => {
      const sister = c.role("sister", ["Ellie", "Carter"]);
      const paid = c.r.pick([85, 95, 120]);
      return {
        text: "Σκέφτομαι να κλείσω τραπέζι για τα 40ά γενέθλια του Τζέιμι το Σάββατο.",
        detail:
          `Sat 31 Oct is ${sister.first}'s hen do in Bath (from 11:00, staying overnight, £${paid} already paid), so ` +
          "a birthday dinner for Jamie that Saturday clashes.",
        hidden: event({
          title: `${sister.first}'s hen do — Bath`,
          start: at(10, 31, 11, 0),
          when: "Sat 31 Oct 2026, from 11:00, staying over",
          where: "Bath, Airbnb on Great Pulteney St",
          notes: `Spa 12:00, dinner 19:30 then out. Back Sun lunchtime. £${paid} paid to the maid of honour. ${c.ta.pick(["Dress code: 70s.", "Bring a swimsuit."])}`,
          edited: at(9, 28, 20, 0),
        }),
        decoy: event({
          title: `${sister.first}'s hen do — Bath (postponed)`,
          start: at(3, 13, 11, 0, 2027),
          when: "Sat 13 Mar 2027, from 11:00, staying over",
          where: "Bath, Airbnb on Great Pulteney St",
          notes: `Moved from 31 Oct to March; deposit carried over. ${c.tb.pick(["Dress code: 70s.", "Details to follow."])}`,
          edited: at(10, 15, 20, 0),
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: yes · language: Vietnamese
  {
    name: "late-party-saturday",
    build: (c) => {
      const prescriber = c.r.pick(["Dr Patel", "Dr Morgan", "Dr Achebe"]);
      const boots = bot("Boots Online Doctor", "noreply@boots.com");
      return {
        text: "Thứ Bảy này đi nhậu sinh nhật bạn tới khuya có ổn không?",
        detail:
          "The user takes a single 2 g dose of tinidazole on Thu 29 Oct; alcohol must be avoided for 72 hours after " +
          "it (disulfiram-like reaction), so drinking on Saturday 31 Oct is not safe.",
        hidden: notice(c, c.ta, {
          from: boots,
          when: at(10, 26, 17, 42),
          title: "Your prescription has been collected",
          body:
            "Items: Tinidazole 500 mg tablets x4 — take all four together as a single dose on Thursday 29 Oct, after food." +
            `\nPrescriber: ${prescriber} (online consultation)\nCollected: Mon 26 Oct 17:42, Boots Kentish Town`,
        }),
        decoy: notice(c, c.tb, {
          from: boots,
          when: at(10, 26, 17, 42),
          title: "Your prescription has been collected",
          body:
            "Items: Amoxicillin 500 mg capsules x21 — one three times a day for 7 days." +
            `\nPrescriber: ${prescriber} (online consultation)\nCollected: Mon 26 Oct 17:42, Boots Kentish Town`,
        }),
      };
    },
  },
  // overlap: name · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: gmail (mail)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "surprise-party-rsvp",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      const sami = bot(`Sami ${leila.last}`, `sami.${leila.last.toLowerCase()}@gmail.com`);
      return {
        text: `RSVP yes to ${leila.first}'s 40th for both of us.`,
        detail:
          `It is a surprise party: ${sami.full} asked guests not to reply to ${leila.first} or mention it, and to ` +
          "send numbers and dietary needs to him instead (arrive by 19:15 at the Rosewood on Sat 14 Nov).",
        hidden: mail(c, c.ta, {
          from: sami,
          when: at(10, 22, 22, 40),
          title: "Shh — Sat 14th",
          body: [
            `You'll have seen the invite for Sat 14 Nov: it's a surprise, so please don't reply to ${leila.first} or mention it to her!`,
            "Send numbers and any dietary stuff to me instead.",
            "Arrive by 19:15 at the Rosewood, she thinks we're going for a quiet dinner.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: sami,
          when: at(10, 22, 22, 40),
          title: "Surprise is off",
          body: [
            `The surprise for ${leila.first}'s barbecue in August is blown, she found the spreadsheet 🙈`,
            "So no secrecy needed, reply to her directly about anything.",
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: statement · source: gmail (mail)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "reading-group-at-home",
    build: (c) => {
      const landlord = c.role("landlord", ["Steve", "Hargreaves"]);
      const off = c.r.pick(["a week's", "two weeks'"]);
      return {
        text: "I'm hosting book club at mine on the 19th.",
        detail:
          "The landlord's floor sanders are in the flat Tue 17 – Fri 20 Nov (living room and hallway, furniture moved, " +
          "no walking on the lacquer for 48 h), so the flat cannot be used on Thu 19 Nov.",
        hidden: mail(c, c.ta, {
          from: landlord,
          when: at(10, 23, 13, 15),
          title: "Floor works",
          body: [
            "The floor sanders are confirmed for Tue 17 – Fri 20 Nov.",
            "They'll do the living room and hallway; the furniture has to go into the bedroom and nobody can walk on " +
              "the lacquer for 48 hours after the last coat, so the flat won't really be usable those days.",
            `Sorry for the disruption, I'll knock ${off} rent off.`,
          ],
        }),
        decoy: mail(c, c.tb, {
          from: landlord,
          when: at(10, 23, 13, 15),
          title: "Floor works",
          body: [
            "The floor sanders are confirmed for Tue 8 – Fri 11 Dec.",
            "They'll do the living room and hallway; the furniture has to go into the bedroom for those days.",
          ],
        }),
      };
    },
  },
  // overlap: name · decoy: (c) condition met · phrasing: plan · source: crm (deal)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "client-stadium-guests",
    build: (c) => {
      const [client] = c.clients(1) as [Person];
      const org = orgOf(client);
      const amount = c.r.int(80, 400) * 1_000;
      const deal = (stage: string, notes: string, t: Rng) =>
        [
          `Deal: ${org} — Expansion`,
          `Stage: ${stage}`,
          `Amount: $${amount.toLocaleString("en-US")}`,
          "Close date: 2026-12-15",
          `Owner: ${c.user.full}`,
          `Champion: ${client.full}`,
          `Notes: ${notes}`,
          `Next step: ${t.pick(["portal Q&A answers", "security questionnaire", "pricing call"])}`,
          "Last activity: 2026-10-21",
        ].join("\n");
      return {
        text: `Let's invite ${client.first} and a colleague to the Coldplay gig as our guests.`,
        detail:
          `${org} is running a formal tender until 30 Nov and its procurement code bars staff from accepting gifts ` +
          "or hospitality from bidders while it is open, so the concert invitation should wait.",
        hidden: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — Expansion 2026`,
          text: deal(
            "Proposal (formal tender)",
            `${org} is running a formal RFP until 30 Nov; their procurement code bars staff from accepting gifts ` +
              "or hospitality from any bidder while it is open. Keep contact to the portal Q&A.",
            c.ta,
          ),
          updatedAt: at(10, 21, 16, 0),
        },
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — Expansion 2026`,
          text: deal(
            "Negotiation",
            `${org} hospitality policy: events up to £200 a head are fine if declared to their compliance team.`,
            c.tb,
          ),
          updatedAt: at(10, 21, 16, 0),
        },
      };
    },
  },
];

/** Templates whose request names one person, thing or date the planted item words differently. */
export const DEV20D_ANCHORED: readonly string[] = [
  "delegation-dinner-booking",
  "conference-panel-departure",
  "mum-arrivals-collect",
  "wales-cottage-midterm",
  "flotilla-final-instalment",
  "ribeira-loft-arrival",
  "us-domestic-carry-on",
  "krakow-departure-hour",
  "neighbour-greenery-help",
  "kennel-stay-seville",
  "post-hold-request",
  "delhi-entry-paperwork",
  "algarve-rental-licence",
  "reading-group-at-home",
];
/** Templates whose planted item (both variants) sits in a rare source (RARE_SOURCES). */
export const DEV20D_RARE: readonly string[] = [
  "zia-naples-visit",
  "wales-cottage-midterm",
  "red-sea-last-dives",
  "japan-timezone-routine",
  "osaka-fare-payment",
  "abroad-spending-fees",
  "flotilla-final-instalment",
  "ribeira-loft-arrival",
  "krakow-departure-hour",
  "heating-off-while-away",
  "bali-document-validity",
  "child-passport-renewal",
];
/** Templates whose fact is a silent edit at the source (their Spec has `before`). */
export const DEV20D_SILENT: readonly string[] = [
  "conference-panel-departure",
  "offsite-rail-tickets",
  "mum-arrivals-collect",
  "red-sea-last-dives",
  "flotilla-final-instalment",
  "ribeira-loft-arrival",
  "eurostar-morning-taxi",
  "krakow-departure-hour",
  "heating-off-while-away",
  "delhi-entry-paperwork",
];
/** Templates whose request is not in English (name the language in the template's comment). */
export const DEV20D_NON_ENGLISH: readonly string[] = [
  "speaker-room-reservation",
  "zia-naples-visit",
  "funeral-trip-amman",
  "japan-timezone-routine",
  "osaka-fare-payment",
  "cangas-house-deposit",
  "heating-off-while-away",
  "new-york-entry-authorisation",
  "fortieth-dinner-table",
  "late-party-saturday",
];
/** Templates whose request is indirect or a question ("Should I…", "I need to…", "We should…", "Can we…?"). */
export const DEV20D_INDIRECT: readonly string[] = [
  "conference-panel-departure",
  "quarterly-review-friday-slot",
  "offsite-rail-tickets",
  "zia-naples-visit",
  "funeral-trip-amman",
  "mum-arrivals-collect",
  "red-sea-last-dives",
  "japan-timezone-routine",
  "highland-ascent-tomorrow",
  "thailand-vaccines-gp",
  "osaka-fare-payment",
  "abroad-spending-fees",
  "cangas-house-deposit",
  "flotilla-final-instalment",
  "ribeira-loft-arrival",
  "us-domestic-carry-on",
  "northbound-rail-strike",
  "krakow-departure-hour",
  "heating-off-while-away",
  "kennel-stay-seville",
  "post-hold-request",
  "new-york-entry-authorisation",
  "bali-document-validity",
  "child-passport-renewal",
  "fortieth-dinner-table",
  "late-party-saturday",
  "reading-group-at-home",
  "client-stadium-guests",
];
/** Templates whose request is a question (a subset of DEV20D_INDIRECT). */
export const DEV20D_QUESTION: readonly string[] = [
  "quarterly-review-friday-slot",
  "zia-naples-visit",
  "funeral-trip-amman",
  "japan-timezone-routine",
  "abroad-spending-fees",
  "us-domestic-carry-on",
  "krakow-departure-hour",
  "kennel-stay-seville",
  "bali-document-validity",
  "late-party-saturday",
];
/**
 * Templates whose fact connects to the request only through world knowledge (a drug and alcohol, asbestos and a
 * drill).
 */
export const DEV20D_KNOWLEDGE: readonly string[] = [
  "quarterly-review-friday-slot",
  "red-sea-last-dives",
  "japan-timezone-routine",
  "alpine-company-trip",
  "highland-ascent-tomorrow",
  "us-domestic-carry-on",
  "kennel-stay-seville",
  "new-york-entry-authorisation",
  "bali-document-validity",
  "late-party-saturday",
];
/** Templates whose request shares no word with the planted item (overlap: none). */
export const DEV20D_NO_OVERLAP: readonly string[] = [
  "delegation-dinner-booking",
  "conference-panel-departure",
  "offsite-rail-tickets",
  "funeral-trip-amman",
  "mum-arrivals-collect",
  "wales-cottage-midterm",
  "red-sea-last-dives",
  "japan-timezone-routine",
  "alpine-company-trip",
  "highland-ascent-tomorrow",
  "osaka-fare-payment",
  "portugal-fares-payment",
  "cangas-house-deposit",
  "flotilla-final-instalment",
  "ribeira-loft-arrival",
  "us-domestic-carry-on",
  "krakow-departure-hour",
  "heating-off-while-away",
  "neighbour-greenery-help",
  "kennel-stay-seville",
  "house-sitter-handover",
  "new-york-entry-authorisation",
  "delhi-entry-paperwork",
  "algarve-rental-licence",
  "fortieth-dinner-table",
  "late-party-saturday",
  "reading-group-at-home",
];

/** Each silent-change template's `before` item, for a days harness (same RNG draws as the planting function). */
export function dev20dBefore(world: World, seed: number): { template: string; before: Plant }[] {
  return build(world, seed).flatMap(({ name, spec }) => (spec.before ? [{ template: name, before: spec.before }] : []));
}

/** Build every template's spec, in order, with the suite's own streams (no world change). */
function build(world: World, seed: number): { name: string; spec: Spec }[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 2004);
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
export function plantDev20d(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  addRareSources(world, seed);
  const suite = variant === "hidden" ? "dev20d" : `dev20d-${variant}`;
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

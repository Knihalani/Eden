/**
 * Held-out hidden-context suite 20 (F4, the one fresh test of the F1–F3 fixes), written blind: the author read only
 * the scaffold of this file, the HiddenTask interface (the head of hidden-context.ts) and the sim world API
 * (world.ts, names.ts, text.ts, rng.ts, rare-sources.ts). No other suite, no engine, ranking, card or prompt code, no
 * docs, caches or tests were read, and no funnel, eval or model was run on it. Measurement only: never tune on it.
 *
 * 48 templates, six in each life area (work, family, health, money, travel, home, admin, social, in that order). Each
 * is a request a user types to their agent, a planted item stating a fact the request does not name (a clash, a
 * constraint, a change, a cancellation, a reason not to, a price, a rule, a deadline, a duplicate) and a near-miss
 * decoy that does not apply. Counts, from the label comments above each template:
 * - Overlap between request and planted item: none 29, a name or reference only 13, one topic word 6.
 * - Decoy kinds: (a) resolved, expired or superseded 16; (b) another entity or date 16; (c) condition met 16.
 * - Phrasing: imperative 17, question 12, indirect plan or statement 19.
 * - Non-English requests: 12, in 12 languages (Swedish, Polish, Turkish, Japanese in romaji, Indonesian, Arabic in
 *   Arabizi, Romanian, Tagalog, Vietnamese, Greek in Latin script, Czech, Spanish).
 * - Anchored: 16. Rare-source: 14 (notes 2, whatsapp 2, bank 2, health 2, school 2, trips 1, residents 1, tasks 2).
 * - Silent edits: 12 (calendar 4, drive 3, crm 1, notes 1, trips 1, residents 1, tasks 1).
 * - Sources of the 34 others: gmail 22 (13 person mail, 9 automated notices), calendar 4, drive 4, slack 3, crm 1.
 * Weekdays checked with Date.UTC: 2026-11-02 Mon, 03 Tue, 05 Thu, 06 Fri, 08 Sun, 09 Mon, 10 Tue, 11 Wed, 12 Thu,
 * 13 Fri, 14 Sat, 15 Sun, 16 Mon, 17 Tue, 18 Wed, 19 Thu, 20 Fri, 21 Sat, 22 Sun, 23 Mon, 24 Tue, 25 Wed, 26 Thu,
 * 27 Fri, 30 Mon; 2026-12-01 Tue, 02 Wed, 04 Fri, 05 Sat, 07 Mon, 11 Fri; 2027-01-04 Mon, 13 Wed, 14 Thu, 18 Mon.
 *
 * World time is HELDOUT20_NOW: Thursday 19 November 2026, 17:30 UTC (not the base world's Tuesday 27 October). The
 * suite's prepare step (suites.ts) moves `world.now` there before planting, so every harness's clock, the agent's
 * "today" and the calendar-slot clearing read this instant. The base world's ~1,500 items keep their dates (all
 * before 27 October 2026 or scheduled around it), so they read as the user's older history.
 */
import { itemId } from "@eden/protocol";
import { addRareSources, RARE_SOURCES } from "../rare-sources";
import { Rng } from "../rng";
import { chatText, emailBody, emailText, type Who } from "../text";
import type { ItemKind, Person, World } from "../world";
import type { HiddenTask } from "./hidden-context";

/** The suite's present: Thursday 19 November 2026, 17:30 UTC. */
export const HELDOUT20_NOW = Date.UTC(2026, 10, 19, 17, 30);

/** Move `world` to this suite's present (idempotent). Called by suites.ts's prepare step, before planting. */
export function shiftToHeldout20(world: World): void {
  world.now = HELDOUT20_NOW;
}
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
   * Silent-change templates only (HELDOUT20_SILENT): the planted item as it read before someone edited it at the
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

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A WhatsApp chat as the app shows a search hit: "[17/11/2026, 20:05] Mum: …", one line a message. */
const say = (lines: { who: string; text: string; when: number }[]): string =>
  lines
    .map((l) => {
      const d = new Date(l.when);
      const day = `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
      return `[${day}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}] ${l.who}: ${l.text}`;
    })
    .join("\n");

/** The 48 templates, six in each life area, each with its label comment. */
const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──

  // Overlap: a name only (the colleague's name). Decoy (b): another colleague's leave on the same dates.
  // Phrasing: imperative. Source: slack.
  {
    name: "work-catchup-early-week",
    build: (c) => {
      const [col, other, asker, by] = c.colleagues(4) as [Person, Person, Person, Person];
      const nick = col.nick ?? col.first;
      const otherNick = other.nick ?? other.first;
      const ask = (who: string) => ({
        who: asker,
        text: `${who} are you around for the Atlas numbers on Tues?`,
        when: at(11, 16, 10, 4),
      });
      const away = (t: Rng) =>
        t.pick([
          "nope, on leave 23/11–27/11 (school holidays with the kids), back Mon 30th. anything urgent before Fri pls",
          "I'm off 23–27/11, back on the 30th! grab me before Friday if it can't wait",
        ]);
      return {
        text: `Book a half-hour catch-up with ${nick} early next week.`,
        detail:
          `${col.full} said in Slack (#partnerships, Monday 16 November) that they are on leave from Monday 23 to ` +
          "Friday 27 November, back Monday 30 November, so a catch-up early next week will not work.",
        hidden: chat(c.ta, "partnerships", [ask(nick), { who: col, text: away(c.ta), when: at(11, 16, 10, 11) }], by),
        decoy: chat(
          c.tb,
          "partnerships",
          [ask(otherNick), { who: other, text: away(c.tb), when: at(11, 16, 10, 11) }],
          by,
        ),
      };
    },
  },

  // Overlap: one topic word ("portfolio"). Decoy (c): the same event edited, only its room changed, still on 24/11.
  // Phrasing: indirect ("I'll…"). Source: calendar.
  // Silent (the organiser moved the session forward without a notice).
  {
    name: "work-portfolio-slides",
    build: (c) => {
      const agenda = "Agenda: Atlas, Beacon, partnerships pipeline (Robin, 15 min).";
      const title = "SLT portfolio session";
      return {
        text: "I'll put my slides together over the weekend for Tuesday's portfolio review.",
        detail:
          "The SLT portfolio session in the calendar was moved (edited 18 November) from Tuesday 24 November 14:00 " +
          "to tomorrow, Friday 20 November 08:30, so slides prepared over the weekend would be too late.",
        hidden: event({
          title,
          start: at(11, 20, 8, 30),
          when: "20/11/2026, 08:30–10:00",
          where: "Boardroom, 5th floor",
          notes: `${c.ta.pick(["Brought forward:", "Moved earlier:"])} the CFO flies out on the 23rd. ${agenda}`,
          edited: at(11, 18, 16, 40),
        }),
        decoy: event({
          title,
          start: at(11, 24, 14, 0),
          when: "24/11/2026, 14:00–15:30",
          where: "Room 4.02 (the boardroom is being painted)",
          notes: agenda,
          edited: at(11, 18, 16, 40),
        }),
        before: event({
          title,
          start: at(11, 24, 14, 0),
          when: "24/11/2026, 14:00–15:30",
          where: "Boardroom, 5th floor",
          notes: agenda,
          edited: at(11, 2, 11, 0),
        }),
      };
    },
  },

  // Overlap: a name only (the client's first name, in the deal's champion line). Decoy (b): the same 8% ceiling on
  // another customer's deal. Phrasing: imperative, Swedish. Source: crm.
  // Silent (a finance colleague edited the deal's discount ceiling), non-English (Swedish).
  {
    name: "work-offer-discount",
    build: (c) => {
      const [cl] = c.clients(1) as [Person];
      const o = otherClient(c, cl);
      const [fin] = c.colleagues(1) as [Person];
      const amount = c.r.int(40, 180) * 1000;
      const deal = (p: Person, cap: string, edited: number): Plant => ({
        sourceId: "crm",
        kind: "deal",
        title: `${orgOf(p)} — Renewal 2027`,
        text:
          `Deal: ${orgOf(p)} — Renewal\nStage: Proposal\nAmount: $${amount.toLocaleString("en-US")}\n` +
          `Close date: 2026-12-15\nOwner: Robin Carter\nChampion: ${p.full} (${p.title ?? "Head of Procurement"})\n` +
          `Max discount: ${cap}\nNext step: send revised order form\nLast activity: 2026-11-17`,
        updatedAt: edited,
      });
      const capped = `8% (anything above needs CFO sign-off; ${fin.full}, 17 Nov)`;
      return {
        text: `Skicka offerten till ${cl.first} i dag med tolv procents rabatt, som vi sa på mötet.`,
        detail:
          `The ${orgOf(cl)} renewal deal in the CRM was edited on 17 November by ${fin.full}: the maximum discount ` +
          "is now 8% (anything above needs CFO sign-off), so the 12% discount cannot be offered without approval.",
        hidden: deal(cl, capped, at(11, 17, 15, 20)),
        decoy: deal(o, capped, at(11, 17, 15, 20)),
        before: deal(cl, "15% (approved at the QBR)", at(11, 3, 10, 0)),
      };
    },
  },

  // Overlap: none (the request says "the new analytics view", the item "dashboards v2" on the sandbox). Decoy (a): an
  // earlier rollback, already fixed. Phrasing: question ("Can I…?"). Source: slack.
  {
    name: "work-client-demo",
    build: (c) => {
      const [eng, by] = c.colleagues(2) as [Person, Person];
      return {
        text: "Can I show the client the new analytics view tomorrow?",
        detail:
          `${eng.full} posted in #releases on 18 November that dashboards v2 was rolled back on the sandbox and is ` +
          'down until Monday 23 November ("nobody demo off it"), so the new view cannot be shown to the client tomorrow.',
        hidden: chat(
          c.ta,
          "releases",
          [
            {
              who: eng,
              text: c.ta.pick([
                "dashboards v2 got rolled back on the sandbox last night, it stays down until Mon 23/11 while we fix the data job. please nobody demo off it",
                "heads up: sandbox is down till Monday 23/11, dashboards v2 rollback + data job fix. don't demo from it",
              ]),
              when: at(11, 18, 9, 40),
            },
          ],
          by,
        ),
        decoy: chat(
          c.tb,
          "releases",
          [
            {
              who: eng,
              text: "sandbox is back up after Monday's rollback, dashboards v2 stable again 👍",
              when: at(11, 11, 15, 5),
            },
          ],
          by,
        ),
      };
    },
  },

  // Overlap: none ("taking tomorrow off" against a leave freeze's dates). Decoy (b): the same freeze on other dates
  // (7/12–18/12). Phrasing: indirect ("Thinking of…"). Source: gmail.
  {
    name: "work-friday-off",
    build: (c) => {
      const [coo] = c.colleagues(1) as [Person];
      const freeze = (t: Rng, from: string, to: string) =>
        mail(c, t, {
          from: coo,
          when: at(11, 9, 8, 45),
          title: "Audit fieldwork: leave freeze",
          corporate: true,
          body: [
            `With the auditors on site, there is no annual leave from ${from} to ${to} for anyone in Partnerships or Finance unless agreed with me in advance.`,
            "Already-approved leave stands.",
          ],
        });
      return {
        text: "Thinking of taking tomorrow off to make it a long weekend.",
        detail:
          `${coo.full} emailed on 9 November that no annual leave is allowed from 16 November to 4 December (audit ` +
          "fieldwork) without agreeing it with them first, so taking Friday 20 November off needs their approval.",
        hidden: freeze(c.ta, "16/11", "4/12"),
        decoy: freeze(c.tb, "7/12", "18/12"),
      };
    },
  },

  // Overlap: none (Polish request; English mail). Decoy (c): the same client mail saying there are no dietary needs.
  // Phrasing: imperative, Polish. Source: gmail.
  // Anchored ("środowe" against "25/11"), non-English (Polish).
  {
    name: "work-workshop-catering",
    build: (c) => {
      const [cl] = c.clients(1) as [Person];
      const note = (t: Rng, need: string) =>
        mail(c, t, {
          from: cl,
          when: at(11, 13, 14, 25),
          title: "Session on the 25th: a few logistics",
          corporate: true,
          body: [
            need,
            "We'll be eight from our side plus the two of you, and we'll need the screen for the afternoon.",
          ],
        });
      return {
        text: "Zamów catering na środowe warsztaty, dziesięć osób.",
        detail:
          `${cl.full} (${orgOf(cl)}) emailed on 13 November that for the workshop on Wednesday 25 November two ` +
          "attendees are coeliac and one is vegan, so the catering needs gluten-free and vegan options.",
        hidden: note(
          c.ta,
          "For the session on 25/11, two of our people are coeliac and one is vegan, so we'll need proper gluten-free and vegan options at lunch.",
        ),
        decoy: note(c.tb, "For the session on 25/11: no dietary requirements on our side, anything is fine for lunch."),
      };
    },
  },

  // ── family ──

  // Overlap: none (the request says "take Maya in tomorrow", the letter "20/11" and "pupils"). Decoy (b): a training
  // day on another date (04/01). Phrasing: indirect ("I'll…"). Source: school (rare).
  // Anchored ("tomorrow" against "Friday 20/11"), rare.
  {
    name: "family-drop-off-tomorrow",
    build: (c) => {
      const letter = (t: Rng, day: string) =>
        rare(
          "school",
          "Staff training day",
          "Dear Parents and Carers,\n\n" +
            `A reminder that ${day} is a staff training (INSET) day and the school is closed to pupils. ` +
            t.pick(["Breakfast club and after-school club will not run.", "No clubs will run on that day."]) +
            "\n\nHolloway Primary School",
          at(11, 13, 15, 10),
        );
      return {
        text: "I'll take Maya in tomorrow on my way to the office, then go straight to my 9 o'clock.",
        detail:
          "The school's ParentMail letter of 13 November says Friday 20 November is a staff training (INSET) day " +
          "and the school is closed to pupils, so there is no drop-off tomorrow.",
        hidden: letter(c.ta, "Friday 20/11"),
        decoy: letter(c.tb, "Monday 04/01"),
      };
    },
  },

  // Overlap: none (Turkish request; English WhatsApp). Decoy (a): mum's Bristol trip called off, so she is home.
  // Phrasing: question ("…çağıralım mı?"), Turkish. Source: whatsapp (rare).
  // Anchored ("annem" and "pazar" against the chat "Mum" and "Saturday till Monday"), rare, non-English (Turkish).
  {
    name: "family-sunday-lunch-mum",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const chatWith = (lines: { who: string; text: string; when: number }[]) =>
        rare("whatsapp", "Mum", say(lines), lines[lines.length - 1]!.when, { people: `${mum.full} <${mum.email}>` });
      return {
        text: "Annemi pazar günü öğle yemeğine çağıralım mı?",
        detail:
          "Mum said on WhatsApp (17 November) she is going to Auntie Jean's in Bristol from Saturday 21 November " +
          "until Monday 23 November, so she is away on Sunday.",
        hidden: chatWith([
          {
            who: "Mum",
            text: c.ta.pick([
              "Off to Auntie Jean's in Bristol on Saturday morning, staying till Monday 😊 will ring when I'm there x",
              "Jean's invited me down to Bristol, going Saturday first thing and back Monday evening x",
            ]),
            when: at(11, 17, 20, 5),
          },
          { who: "Robin", text: "lovely, give her my love x", when: at(11, 17, 20, 12) },
        ]),
        decoy: chatWith([
          {
            who: "Mum",
            text: "Bristol's off, Jean's got the flu so I'm staying put this weekend x",
            when: at(11, 17, 20, 5),
          },
          { who: "Robin", text: "oh no, hope she feels better soon x", when: at(11, 17, 20, 12) },
        ]),
      };
    },
  },

  // Overlap: none (the request says "my sister's" and "Christmas Eve", the doc "Ellie's" and "24–26/12"). Decoy (c):
  // the same doc edited, plan unchanged (only New Year's Eve added). Phrasing: imperative. Source: drive.
  // Anchored ("my sister's" against "Ellie's"), silent (the sister edited the shared Christmas doc).
  {
    name: "family-christmas-eve-train",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const title = "Xmas 2026: who's where";
      const atSis =
        `24–26/12: at ${sis.first}'s in Leeds (Mum in the spare room, Robin & Maya on the sofa bed)\n` +
        `- ${sis.first} & Dan: doing the turkey\n- Robin: crackers + pudding`;
      return {
        text: "Book train tickets up to my sister's for Christmas Eve, back on Boxing Day.",
        detail:
          `${sis.first} edited the shared "Xmas 2026: who's where" doc on 16 November: Christmas (24–26 December) is ` +
          `now at Mum's in Norwich, not at ${sis.first}'s in Leeds, so the train should go to Norwich.`,
        hidden: doc(
          title,
          `Last edited by ${sis.full}, 16 Nov\n\n24–26/12: all at Mum's in Norwich this year ` +
            `(${sis.first}'s kitchen is being ripped out on the 14th, no oven!)\n` +
            `- ${sis.first} & Dan: driving, bringing the turkey\n- Robin: bring Maya + crackers\n- NYE: TBC`,
          at(11, 16, 21, 30),
        ),
        decoy: doc(title, `Last edited by ${sis.full}, 16 Nov\n\n${atSis}\n- NYE: at Jamie's`, at(11, 16, 21, 30)),
        before: doc(title, `${atSis}\n- NYE: TBC`, at(10, 21, 19, 0)),
      };
    },
  },

  // Overlap: none (Japanese romaji request; English mail). Decoy (b): the same parents' evening slot on another date
  // (01/12). Phrasing: question ("…itte mo daijoubu kana?"), Japanese (romaji). Source: gmail.
  // Anchored ("raishuu no kayoubi" against "24/11"), non-English (Japanese, romaji).
  {
    name: "family-tuesday-drinks",
    build: (c) => {
      const teacher = c.role("Maya's teacher", ["Mrs", "Daley"]);
      const slot = (t: Rng, day: string) =>
        mail(c, t, {
          from: teacher,
          when: at(11, 12, 16, 5),
          title: "Parents' evening: your slot",
          body: [
            `Your parents' evening slot for Maya is confirmed for ${day} at 18:10 in the Year 3 classroom.`,
            "Each slot is ten minutes, so please try to be prompt.",
          ],
        });
      return {
        text: "Raishuu no kayoubi no yoru, kaisha no nomikai ni itte mo daijoubu kana?",
        detail:
          `${teacher.full} confirmed by email (12 November) a parents' evening slot for Maya on Tuesday 24 November ` +
          "at 18:10, which clashes with the work drinks that evening.",
        hidden: slot(c.ta, "24/11"),
        decoy: slot(c.tb, "01/12"),
      };
    },
  },

  // Overlap: none (the request says "Saturday night", the mail "from Friday till Sunday teatime"). Decoy (b): the
  // same trip on the following weekend. Phrasing: imperative. Source: gmail.
  {
    name: "family-saturday-babysitter",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const trip = (t: Rng, when: string) =>
        mail(c, t, {
          from: sis,
          when: at(11, 15, 18, 30),
          title: "Taking Maya off your hands!",
          body: [
            `Mum and I are taking Maya to Norwich for the panto: we'll collect her ${when} and bring her home Sunday teatime.`,
            "She's so excited, don't tell her about the ice cream stop.",
          ],
        });
      return {
        text: "Book a babysitter for Saturday night so we can go out.",
        detail:
          `${sis.first} emailed on 15 November that she and Mum are taking Maya to Norwich from Friday 20 November ` +
          "until Sunday afternoon, so Maya will not be home on Saturday night and no babysitter is needed.",
        hidden: trip(c.ta, "on Friday morning (the 20th)"),
        decoy: trip(c.tb, "on Friday the 27th"),
      };
    },
  },

  // Overlap: a name only ("Maya"). Decoy (a): aftercare from an earlier procedure in June, long expired.
  // Phrasing: indirect ("Going to…"). Source: health (rare).
  // Rare.
  {
    name: "family-lessons-signup",
    build: (c) => {
      const aftercare = (done: string, review: string) =>
        "Whittington Health: ENT day surgery\nPatient: Maya Carter\n" +
        `Procedure: grommet insertion, both ears (${done})\n\n` +
        "Aftercare: keep ears dry for 6 weeks. No pools, and no putting her head under water in the bath, " +
        `until she is reviewed at the follow-up clinic on ${review}.`;
      return {
        text: "Going to sign Maya up for the Saturday swimming lessons at the leisure centre.",
        detail:
          "The NHS App message of 12 November: Maya had grommets fitted on 12 November and must keep her ears dry " +
          "for six weeks (no pools) until the ENT follow-up on 22 December, so swimming lessons cannot start yet.",
        hidden: rare(
          "health",
          "After your child's procedure",
          aftercare("12/11/2026", "22/12/2026"),
          at(11, 12, 16, 0),
        ),
        decoy: rare("health", "After your child's procedure", aftercare("03/06/2026", "15/07/2026"), at(6, 3, 15, 0)),
      };
    },
  },

  // ── health ──

  // Overlap: none (Indonesian request; English GP message). Decoy (c): the review is done and repeats are
  // authorised. Phrasing: imperative, Indonesian. Source: health (rare).
  // Rare, non-English (Indonesian).
  {
    name: "health-inhaler-reorder",
    build: (c) => ({
      text: "Tolong pesan ulang obat asmaku ya.",
      detail:
        "The GP practice declined the salbutamol inhaler repeat on 16 November (NHS App): an asthma review with " +
        "the practice nurse is overdue and must be booked before any further repeat is issued.",
      hidden: rare(
        "health",
        "Repeat prescription request",
        "Your request for Salbutamol 100 micrograms inhaler has been declined by Dr A. Shah.\n\n" +
          "Reason: you are overdue an asthma review. " +
          c.ta.pick([
            "Please book a review with the practice nurse; further repeats cannot be issued until it has taken place.",
            "Book a review with the practice nurse first. No further repeats will be issued before then.",
          ]) +
          "\n\nThe Northway Surgery",
        at(11, 16, 11, 20),
      ),
      decoy: rare(
        "health",
        "Repeat prescription request",
        "Your asthma review was completed on 02/11/2026. Your repeat medicines, including Salbutamol 100 " +
          "micrograms inhaler, are authorised until 01/11/2027 and can be ordered through the app.\n\nThe Northway Surgery",
        at(11, 16, 11, 20),
      ),
    }),
  },

  // Overlap: a name only ("Richmond"). Decoy (a): an earlier running restriction that ended in October.
  // Phrasing: question ("Should I…?"). Source: gmail.
  {
    name: "health-richmond-half",
    build: (c) => {
      const physio = c.role("physio", ["Hannah", "Moss"]);
      return {
        text: "Should I still do the Richmond half on Sunday?",
        detail:
          `${physio.full} (physio) emailed on 10 November after an assessment: Achilles irritation, no running over ` +
          "5 km for three weeks until a reassessment on 8 December, and advised sitting out the Richmond half.",
        hidden: mail(c, c.ta, {
          from: physio,
          when: at(11, 10, 17, 30),
          title: "Your assessment today",
          body: [
            "As discussed, the left Achilles is irritated, not torn.",
            "No running over 5k and no speed work for the next three weeks, then we reassess on 8/12.",
            "I know Richmond is coming up, but I'd sit that one out.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: physio,
          when: at(9, 22, 17, 30),
          title: "Your assessment today",
          body: [
            "As discussed, the left calf is just tight.",
            "Keep runs under 5k for the next two weeks, then build back up as normal from 6/10.",
            "If it settles you'll be fine for Richmond.",
          ],
        }),
      };
    },
  },

  // Overlap: none (the request says "team lunch tomorrow", the entry "Bloods (fasting)" and "20/11"). Decoy (c): the
  // same entry edited, only the room changed, still at 08:40. Phrasing: indirect ("Planning…"). Source: calendar.
  // Anchored ("tomorrow" against "20/11/2026"), silent (the clinic's booking system moved the slot).
  {
    name: "health-team-lunch-friday",
    build: (c) => {
      const title = "Bloods (fasting): Whittington phlebotomy";
      const notes = "Water only from midnight. Bring the blood form from Dr Shah.";
      return {
        text: "Planning a long team lunch tomorrow, somewhere near the office around half twelve.",
        detail:
          "The fasting blood test in the calendar (Whittington phlebotomy, edited 18 November) moved from 08:40 to " +
          "12:50–13:10 tomorrow, Friday 20 November, with water only from midnight, so a 12:30 lunch clashes and the " +
          "user cannot eat before it.",
        hidden: event({
          title,
          start: at(11, 20, 12, 50),
          when: "20/11/2026, 12:50–13:10",
          where: "Whittington Hospital, Outpatients B",
          notes,
          edited: at(11, 18, 11, 5),
        }),
        decoy: event({
          title,
          start: at(11, 20, 8, 40),
          when: "20/11/2026, 08:40–09:00",
          where: "Whittington Hospital, Outpatients C (moved from B)",
          notes,
          edited: at(11, 18, 11, 5),
        }),
        before: event({
          title,
          start: at(11, 20, 8, 40),
          when: "20/11/2026, 08:40–09:00",
          where: "Whittington Hospital, Outpatients B",
          notes,
          edited: at(11, 4, 9, 30),
        }),
      };
    },
  },

  // Overlap: none (the request says "spa", "sauna and hot tub", the mail "steam rooms or baths"). Decoy (a): stitches
  // already out and healed (an earlier procedure). Phrasing: imperative. Source: gmail.
  {
    name: "health-spa-weekend",
    build: (c) => {
      const clinic = bot("Islington Skin Clinic", "aftercare@islingtonskin.co.uk");
      return {
        text: "Book me into the spa on Saturday, sauna and hot tub.",
        detail:
          "Islington Skin Clinic's aftercare email of 17 November: the stitches stay in until 27 November and the " +
          "wound must be kept dry (no swimming, steam rooms or baths), so a sauna and hot tub on Saturday is ruled out.",
        hidden: notice(c, c.ta, {
          from: clinic,
          when: at(11, 17, 13, 0),
          title: "Aftercare following your procedure",
          body:
            "Thank you for attending on 17/11. Your stitches will be removed on 27/11. Until then keep the wound " +
            "dry: no swimming, steam rooms or baths.",
        }),
        decoy: notice(c, c.tb, {
          from: clinic,
          when: at(10, 23, 13, 0),
          title: "Aftercare following your procedure",
          body:
            "Your stitches were removed today and the wound has healed well. You can return to all your normal " +
            "activities.",
        }),
      };
    },
  },

  // Overlap: a name only (the trainer's first name). Decoy (a): an earlier cancellation, with sessions back to normal.
  // Phrasing: indirect ("Ana ra7…", I'm going to), Arabic (Arabizi). Source: gmail.
  // Non-English (Arabic, Arabizi).
  {
    name: "health-trainer-session",
    build: (c) => {
      const pt = c.role("personal trainer", ["Tom", "Bradley"]);
      return {
        text: `Ana ra7 a3mel session ma3 ${pt.first} bokra 3al sob7 bel park.`,
        detail:
          `${pt.full} (personal trainer) emailed this morning (19 November) cancelling tomorrow's 7am training ` +
          "(van in the garage) and offering Saturday 9am instead.",
        hidden: mail(c, c.ta, {
          from: pt,
          when: at(11, 19, 8, 20),
          title: "Friday 7am",
          body: [
            "Really sorry, I have to cancel tomorrow at 7, the van's in the garage and I can't get the kit over.",
            "I can do Saturday at 9 instead if that suits?",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: pt,
          when: at(11, 6, 8, 20),
          title: "Last Friday",
          body: ["Sorry again about last Friday, the van's fixed and we're back to normal from now on."],
        }),
      };
    },
  },

  // Overlap: none (the request says "Nurofen" and "mum's back", the note "ibuprofen" and her first name). Decoy (a):
  // the note says the warfarin course ended and ibuprofen is fine again. Phrasing: indirect ("I'll…"). Source: notes
  // (rare). Anchored ("mum" against her first name), rare, silent (the sister edited the shared note).
  {
    name: "health-mums-painkillers",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const title = `${mum.first}: medication list`;
      return {
        text: "I'll grab some Nurofen for mum's back on the way over tonight.",
        detail:
          `${sis.first} edited the shared note of ${mum.first}'s medicines on 10 November: Mum started warfarin and ` +
          "must not take ibuprofen (Nurofen) or aspirin, paracetamol only, so Nurofen should not be bought.",
        hidden: rare(
          "notes",
          title,
          `Shared with ${sis.first}\n\n- Amlodipine 5mg, mornings\n` +
            "- Warfarin (started 10/11 after the clot): NO anti-inflammatories (ibuprofen, aspirin), paracetamol only\n" +
            "- Vitamin D",
          at(11, 10, 19, 40),
        ),
        decoy: rare(
          "notes",
          title,
          `Shared with ${sis.first}\n\n- Amlodipine 5mg, mornings\n` +
            "- Warfarin: stopped 02/11 (course finished), ibuprofen OK again per GP\n- Vitamin D",
          at(11, 3, 19, 40),
        ),
        before: rare(
          "notes",
          title,
          `Shared with ${sis.first}\n\n- Amlodipine 5mg, mornings\n- Vitamin D\n- Ibuprofen when needed is fine (GP, 08/10)`,
          at(10, 8, 18, 0),
        ),
      };
    },
  },

  // ── money ──

  // Overlap: none (the request says "kitchen fitter's deposit", the alert a balance and a mortgage Direct Debit).
  // Decoy (b): a low balance in the joint account. Phrasing: imperative. Source: bank (rare).
  // Rare.
  {
    name: "money-fitter-deposit",
    build: (c) => ({
      text: "Send the kitchen fitter his deposit now.",
      detail:
        "Monzo alert (18 November): only £214.37 left and the £1,186 mortgage Direct Debit is due tomorrow, " +
        "20 November; paying the fitter's deposit now would make the mortgage payment fail.",
      hidden: rare(
        "bank",
        "Heads up: low balance",
        "You've got £214.37 left. Your Halifax Mortgage Direct Debit (£1,186.00) is due tomorrow, 20 Nov. " +
          c.ta.pick(["Top up before 2pm so it doesn't bounce.", "Add money before 2pm to avoid a missed payment."]),
        at(11, 18, 18, 2),
      ),
      decoy: rare(
        "bank",
        "Heads up: low balance",
        "Joint: you've got £58.10 left in the joint pot with Sam. Your Netflix Direct Debit (£10.99) is due on 3 Dec.",
        at(11, 18, 18, 2),
      ),
    }),
  },

  // Overlap: none (Romanian request; English mail). Decoy (c): the same invoice, sent normally and payable.
  // Phrasing: question ("Să plătesc…?"), Romanian. Source: gmail.
  // Anchored ("contabil" against the accountant's name), non-English (Romanian).
  {
    name: "money-accountant-invoice",
    build: (c) => {
      const acc = c.role("accountant", ["Owen", "Price"]);
      return {
        text: "Să plătesc acum factura de la contabil?",
        detail:
          `${acc.full} (accountant) emailed on 18 November that invoice 2291 was billed twice in error and should be ` +
          "ignored: a credit note is issued and a corrected invoice will follow, so it should not be paid now.",
        hidden: mail(c, c.ta, {
          from: acc,
          when: at(11, 18, 12, 15),
          title: "Invoice 2291",
          body: [
            "Please ignore invoice 2291 that went out on Monday: our system billed the year-end fee twice.",
            "I've issued a credit note and a corrected invoice will follow next week.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: acc,
          when: at(11, 18, 12, 15),
          title: "Invoice 2291",
          body: [
            "Invoice 2291 for the year-end accounts is attached.",
            "Payment within 30 days to the usual bank details, thanks.",
          ],
        }),
      };
    },
  },

  // Overlap: none (the request says "tax-free savings", the notice "ISA allowance"). Decoy (b): the daughter's Junior
  // ISA allowance, another account. Phrasing: indirect ("Remind me to…"). Source: gmail.
  // Anchored ("tax-free savings" against "ISA").
  {
    name: "money-savings-top-up",
    build: (c) => {
      const from = bot("Vanguard Investor", "no-reply@vanguardinvestor.co.uk");
      return {
        text: "Remind me to put another five grand into my tax-free savings before Christmas.",
        detail:
          "Vanguard's notice of 11 November: £18,600 of the £20,000 ISA allowance for 2026/27 is already used and " +
          "only £1,400 remains, so another £5,000 cannot go into the ISA before April.",
        hidden: notice(c, c.ta, {
          from,
          when: at(11, 11, 7, 0),
          title: "Your ISA allowance",
          body:
            "You have now subscribed £18,600 of your £20,000 ISA allowance for 2026/27. Remaining allowance: £1,400. " +
            "Your allowance resets on 6 April 2027.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(11, 11, 7, 0),
          title: "Your Junior ISA allowance",
          body:
            "Junior ISA for Maya Carter: you have subscribed £8,600 of the £9,000 allowance for 2026/27. " +
            "Remaining allowance: £400.",
        }),
      };
    },
  },

  // Overlap: none (the request says "my sister" and "share", the sheet her name and "split"). Decoy (c): the sheet
  // edited (parking added), amount unchanged. Phrasing: indirect ("I need to…"). Source: drive.
  // Anchored ("my sister" against her name), silent (the sister edited the costs sheet).
  {
    name: "money-cottage-share",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const title = "Peak District house: costs";
      const head = `Organiser: ${sis.first} (deposit paid 02/10)\nHouse: £1,236 for 4–6 Dec`;
      const pay = `Pay ${sis.first} by 30/11 (sort code in the group)`;
      return {
        text: "I need to transfer my sister my share for the cottage weekend.",
        detail:
          `${sis.first} edited the "Peak District house: costs" sheet on 17 November: Jamie dropped out, so the ` +
          "£1,236 is now split three ways, £412 each (was £309), due by 30 November.",
        hidden: doc(title, `${head}\nSplit: 3 ways now Jamie's out → £412 each\n${pay}`, at(11, 17, 20, 45)),
        decoy: doc(
          title,
          `${head}\nSplit: 4 ways → £309 each\n${pay}\nParking: free on the drive for 2 cars`,
          at(11, 17, 20, 45),
        ),
        before: doc(title, `${head}\nSplit: 4 ways → £309 each\n${pay}`, at(10, 2, 18, 0)),
      };
    },
  },

  // Overlap: none (Tagalog request; the alert names the Visa ending 4471). Decoy (a): the same Visa unfrozen.
  // Phrasing: indirect ("Babayaran ko…", I'll pay), Tagalog. Source: bank (rare).
  // Rare, non-English (Tagalog).
  {
    name: "money-council-tax-card",
    build: (c) => ({
      text: "Babayaran ko mamaya yung council tax gamit yung debit card ko.",
      detail:
        "Monzo froze the user's Visa debit card ending 4471 on 17 November after a suspected fraudulent payment " +
        "(a replacement is on its way), so it cannot be used to pay the council tax now.",
      hidden: rare(
        "bank",
        "We've frozen your Visa",
        "Your Visa ending 4471 is frozen after a payment we think wasn't you (£389.00, ZALANDO DE). " +
          c.ta.pick([
            "A replacement is on its way and should arrive within 3–5 working days.",
            "We're sending a replacement; it should arrive in 3–5 working days.",
          ]),
        at(11, 17, 22, 41),
      ),
      decoy: rare(
        "bank",
        "All good: Visa unfrozen",
        "Thanks for confirming the £389.00 payment (ZALANDO DE) was you. Your Visa ending 4471 is working again.",
        at(11, 17, 22, 41),
      ),
    }),
  },

  // Overlap: one topic word ("gas"). Decoy (a): the fixed plan already ended, no exit fees.
  // Phrasing: question ("Should I…?"). Source: gmail.
  {
    name: "money-energy-switch",
    build: (c) => {
      const from = bot("Octopus Energy", "hello@octopus.energy");
      return {
        text: "Should I switch our gas and electric to that new two-year deal now?",
        detail:
          "Octopus Energy's notice (5 November): the current plan runs to 31 March 2027 and leaving before " +
          "1 February 2027 costs £75 per fuel (£150 in all), which the new deal's saving would have to beat.",
        hidden: notice(c, c.ta, {
          from,
          when: at(11, 5, 9, 0),
          title: "About your plan",
          body:
            "Your plan: Flexible Fixed 12M (dual fuel). End date: 31/03/2027. Exit fees: £75 per fuel (gas and " +
            "electricity) if you leave before 01/02/2027.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(11, 5, 9, 0),
          title: "About your plan",
          body:
            "Your fixed plan (dual fuel, gas and electricity) ended on 31/10/2026 and you're now on our Flexible " +
            "Octopus tariff. No exit fees apply if you leave.",
        }),
      };
    },
  },

  // ── travel ──

  // Overlap: a name only ("Lisbon"). Decoy (c): the itinerary edited (seat change), still Heathrow at 07:40.
  // Phrasing: imperative. Source: trips (rare).
  // Rare, silent (the airline's schedule change synced into the itinerary).
  {
    name: "travel-airport-taxi",
    build: (c) => {
      const title = "Lisbon, 30 Nov – 3 Dec";
      const tail = "Confirmation: Q8KZ2M\n\nHotel: Memmo Alfama, 3 nights";
      const lhr = "TP1351 · London Heathrow (LHR) T2 → Lisbon (LIS)\nDeparts 30 Nov 07:40 · Arrives 10:30";
      return {
        text: "Book a taxi to Heathrow for my Lisbon flight a week on Monday.",
        detail:
          "TripIt's Lisbon itinerary was updated on 18 November by the airline: Monday 30 November's flight now " +
          "leaves London Gatwick (LGW) at 06:10, not Heathrow at 07:40, so the taxi must go to Gatwick, much earlier.",
        hidden: rare(
          "trips",
          title,
          "TP1337 · London Gatwick (LGW) North → Lisbon (LIS)\nDeparts 30 Nov 06:10 · Arrives 09:00\n" +
            `${tail}\n\nSchedule change applied by the airline, 18 Nov`,
          at(11, 18, 7, 12),
        ),
        decoy: rare("trips", title, `${lhr}\nSeat: 14A (changed 18 Nov)\n${tail}`, at(11, 18, 7, 12)),
        before: rare("trips", title, `${lhr}\n${tail}`, at(10, 30, 21, 0)),
      };
    },
  },

  // Overlap: none (Vietnamese request; the notice is about a passport, not Istanbul or a visa). Decoy (a): the new
  // passport already sent back. Phrasing: question ("…có cần… không?"), Vietnamese. Source: gmail.
  // Non-English (Vietnamese).
  {
    name: "travel-istanbul-visa",
    build: (c) => {
      const from = bot("HM Passport Office", "noreply@passport.service.gov.uk");
      return {
        text: "Tuần sau mình đi Istanbul, có cần xin visa không?",
        detail:
          "HM Passport Office confirmed on 12 November it has the user's passport renewal application and the old " +
          "passport (now cancelled), with about three weeks' processing, so the user may have no valid passport to " +
          "travel next week.",
        hidden: notice(c, c.ta, {
          from,
          when: at(11, 12, 10, 30),
          title: "We've received your documents",
          body:
            "We received your passport application and your old passport on 12 November 2026. Your old passport " +
            "has been cancelled and will be returned separately. Most applications are processed within 3 weeks.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 21, 10, 30),
          title: "Your new passport is on its way",
          body:
            "Your new passport was sent to you by secure delivery on 21 October 2026. It is valid for 10 years. " +
            "Your old passport will be returned separately.",
        }),
      };
    },
  },

  // Overlap: a name only ("the Golf"). Decoy (a): an earlier repair, finished and the car returned.
  // Phrasing: indirect ("We're driving…"). Source: gmail.
  {
    name: "travel-weekend-drive",
    build: (c) => {
      const garage = c.role("mechanic", ["Gary", "Doyle"]);
      return {
        text: "We're driving down to Cornwall in the Golf first thing Saturday.",
        detail:
          `${garage.full} at the garage emailed on 17 November that the clutch part is delayed until Tuesday ` +
          "24 November, so the Golf stays at the garage until at least Wednesday and cannot be used on Saturday.",
        hidden: mail(c, c.ta, {
          from: garage,
          when: at(11, 17, 16, 50),
          title: "Your car",
          body: [
            "The clutch kit we ordered is on back order and won't be with us until Tuesday 24th.",
            "So the Golf will be staying with us until at least Wednesday, sorry for the hassle.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: garage,
          when: at(11, 2, 16, 50),
          title: "Your car",
          body: ["The Golf's all done and ready to collect, the warning light from last month was just a sensor."],
        }),
      };
    },
  },

  // Overlap: none (the request says "the client meeting tomorrow", the entry the company's "quarterly review" and
  // "20/11"). Decoy (c): the same event edited, still in person in Manchester. Phrasing: indirect ("I'm getting…").
  // Source: calendar. Anchored ("the client meeting" against "<company> quarterly review"), silent (the client
  // switched the meeting to a video call).
  {
    name: "travel-client-visit-train",
    build: (c) => {
      const [cl] = c.clients(1) as [Person];
      const title = `${orgOf(cl)} quarterly review`;
      const office = `${orgOf(cl)} offices, Manchester (Spinningfields)`;
      const base = { title, start: at(11, 20, 10, 0), when: "20/11/2026, 10:00–12:00" };
      return {
        text: "I'm getting the early train up to the client meeting tomorrow.",
        detail:
          `${cl.full} edited the ${orgOf(cl)} quarterly review (Friday 20 November, 10:00) on 18 November into a ` +
          "Teams call, so there is no need to travel to Manchester tomorrow.",
        hidden: event({
          ...base,
          where: "Microsoft Teams (link in the invite)",
          notes:
            `Switched to remote by ${cl.full}: half their team is off sick. ` +
            "Agenda unchanged: usage, renewal, roadmap.",
          edited: at(11, 18, 17, 25),
        }),
        decoy: event({
          ...base,
          where: office,
          notes: `3rd floor; ask for ${cl.first} at reception. Agenda: usage, renewal, roadmap.`,
          edited: at(11, 18, 17, 25),
        }),
        before: event({ ...base, where: office, notes: "Agenda: usage, renewal, roadmap.", edited: at(11, 2, 9, 15) }),
      };
    },
  },

  // Overlap: one topic word ("flight"). Decoy (a): a cancellation warning withdrawn, the flight operates.
  // Phrasing: imperative. Source: gmail.
  {
    name: "travel-online-checkin",
    build: (c) => {
      const from = bot("British Airways", "ba@contact.ba.com");
      return {
        text: "Check me in online for my flight.",
        detail:
          "British Airways emailed on 18 November that BA982 to Berlin on Saturday 21 November is cancelled (strike) " +
          "and the user is rebooked on BA986 on Sunday 22 November at 07:15, unless they choose another flight or a refund.",
        hidden: notice(c, c.ta, {
          from,
          when: at(11, 18, 21, 0),
          title: "Your flight has been cancelled",
          body:
            "We're sorry: BA982 London Heathrow to Berlin on 21/11/2026 has been cancelled because of industrial " +
            "action. We have rebooked you on BA986 on 22/11/2026 at 07:15. If this doesn't suit, you can choose " +
            "another flight or a refund in Manage My Booking.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(11, 17, 12, 0),
          title: "Update: your flight will operate",
          body:
            "Good news: the industrial action has been called off. BA982 London Heathrow to Berlin on 21/11/2026 " +
            "will operate as scheduled.",
        }),
      };
    },
  },

  // Overlap: none (the request says "the airport on Wednesday", the message "LHR on the 25th"). Decoy (b): the same
  // closure on another date (the 2nd). Phrasing: question ("What time should I leave…?"). Source: slack.
  // Anchored ("Wednesday" against "the 25th").
  {
    name: "travel-airport-leave-time",
    build: (c) => {
      const [col, by] = c.colleagues(2) as [Person, Person];
      const works = (t: Rng, day: string) =>
        chat(
          t,
          "travel",
          [
            {
              who: col,
              text:
                `heads up for anyone flying out of LHR on the ${day}: no Elizabeth line or Heathrow Express all day ` +
                "(engineering works), rail replacement buses from Hayes only. TfL says allow an extra hour",
              when: at(11, 17, 12, 30),
            },
          ],
          by,
        );
      return {
        text: "What time should I leave for the airport on Wednesday?",
        detail:
          `${col.full} posted in #travel on 17 November that on Wednesday 25 November there are no Elizabeth line or ` +
          "Heathrow Express trains (engineering works), only replacement buses from Hayes, and to allow an extra hour.",
        hidden: works(c.ta, "25th"),
        decoy: works(c.tb, "2nd"),
      };
    },
  },

  // ── home ──

  // Overlap: none (the request says "sofa delivered on Tuesday", the notice "lift" and "Mon 23 Nov to Fri 27 Nov").
  // Decoy (c): lift servicing the same week with the lift staying in service. Phrasing: indirect ("We're having…").
  // Source: residents (rare). Rare, silent (the managing agent changed the dates on the portal).
  {
    name: "home-sofa-delivery",
    build: (c) => {
      const title = "Lift refurbishment: Block B";
      const sign = "\n\nRendall & Rittner, on behalf of Arlington Court RMC";
      const out = (from: string, to: string) =>
        `The Block B passenger lift will be out of service from ${from} to ${to} for refurbishment. ` +
        "Please plan any moves or bulky items outside these dates; the stairs must be kept clear.";
      return {
        text: "We're having the new sofa delivered on Tuesday.",
        detail:
          "The residents' portal notice (Rendall & Rittner, changed on 16 November from 7–11 December) says the " +
          "Block B lift is out of service from Monday 23 to Friday 27 November, so a sofa delivered on Tuesday " +
          "24 November would have to come up the stairs.",
        hidden: rare(
          "residents",
          title,
          `Updated 16 Nov 2026\n\n${out("Mon 23 Nov", "Fri 27 Nov")}${sign}`,
          at(11, 16, 12, 0),
        ),
        decoy: rare(
          "residents",
          "Lift servicing: Block B",
          "Updated 16 Nov 2026\n\nLift servicing 23–27 Nov: the lift stays in service throughout; expect short stops " +
            `of up to 10 minutes while engineers test it.${sign}`,
          at(11, 16, 12, 0),
        ),
        before: rare("residents", title, `${out("Mon 7 Dec", "Fri 11 Dec")}${sign}`, at(10, 20, 10, 0)),
      };
    },
  },

  // Overlap: a name only (the landlord's first name). Decoy (a): last year's gas safety certificate, long done.
  // Phrasing: imperative. Source: gmail.
  {
    name: "home-boiler-service",
    build: (c) => {
      const ll = c.role("landlord", ["Steve", "Hargreaves"]);
      return {
        text: `Book the boiler service for Monday and tell ${ll.first}.`,
        detail:
          `${ll.full} (landlord) emailed on 14 November that his heating engineer is doing the annual gas safety ` +
          "check and boiler once-over on Thursday 26 November, 9–1, so the user should not book one.",
        hidden: mail(c, c.ta, {
          from: ll,
          when: at(11, 14, 10, 40),
          title: "Gas safety check",
          body: [
            "Just to say I've arranged the annual gas safety check with my heating engineer for Thursday 26th, 9–1.",
            "He'll do the yearly once-over at the same visit, so no need to get anyone in yourself.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: ll,
          when: at(12, 1, 15, 0, 2025),
          title: "Gas safety check",
          body: ["The gas safety certificate from today's check is attached for your records.", "All fine this year."],
        }),
      };
    },
  },

  // Overlap: none (Greek request in Latin script; English notice). Decoy (b): the same water shut-off on another date
  // (3/12). Phrasing: question ("Na valo…?"), Greek (Latin script). Source: gmail.
  // Anchored ("apopse", tonight, against "22:00 on 19/11/2026"), non-English (Greek, Latin script).
  {
    name: "home-overnight-wash",
    build: (c) => {
      const from = bot("Thames Water", "noreply@thameswater.co.uk");
      const off = (t: Rng, from_: string, to: string, when: number) =>
        notice(c, t, {
          from,
          when,
          title: "Planned work in your area",
          body:
            `To replace a valve on Holloway Road, your water supply will be off from 22:00 on ${from_} until 06:00 ` +
            `on ${to}. Please store some water before the work starts.`,
        });
      return {
        text: "Na valo to plyntirio apopse prin koimitho?",
        detail:
          "Thames Water's notice (16 November): the water supply is off from 22:00 tonight (19 November) until " +
          "06:00 tomorrow, so a washing machine run overnight would have no water.",
        hidden: off(c.ta, "19/11/2026", "20/11/2026", at(11, 16, 9, 0)),
        decoy: off(c.tb, "03/12/2026", "04/12/2026", at(11, 16, 9, 0)),
      };
    },
  },

  // Overlap: none (the request says "the paint for the hallway", the task "F&B tins ×2 for the corridor"). Decoy (c):
  // the same task edited (three tins), still open and assigned to the user. Phrasing: imperative. Source: tasks (rare).
  // Anchored ("the paint" against "F&B tins"), rare, silent (the flatmate ticked the task off).
  {
    name: "home-hallway-paint",
    build: (c) => {
      const flat = c.role("flatmate", ["Jo", "Hart"]);
      const title = "F&B tins ×2 for the corridor";
      const open = "Project: Flat\nAssigned to: Robin · Due: Sat 21 Nov";
      return {
        text: "Order the paint for the hallway.",
        detail:
          `${flat.full} ticked off the shared Todoist task "F&B tins ×2 for the corridor" on 18 November: the ` +
          "hallway paint is already bought (2 × 2.5L Skimming Stone, in the cupboard), so ordering more would duplicate it.",
        hidden: rare(
          "tasks",
          title,
          `Project: Flat\n✓ Completed by ${flat.full} · 18 Nov\n` +
            "Note: got them at the Upper St shop, 2 × 2.5L Skimming Stone, in the cupboard under the stairs",
          at(11, 18, 19, 15),
        ),
        decoy: rare(
          "tasks",
          title,
          `${open}\nNote: ${flat.first} says make it 3 × 2.5L, two coats`,
          at(11, 18, 19, 15),
        ),
        before: rare("tasks", title, `${open}\nNote: Skimming Stone, estate emulsion, 2 × 2.5L`, at(11, 1, 12, 0)),
      };
    },
  },

  // Overlap: none (the request says "someone round", "damp patch", the clause "contractors" and "defect"). Decoy (c):
  // the clause lets the tenant hire a contractor for small repairs. Phrasing: indirect ("I need to…"). Source: drive.
  {
    name: "home-damp-repair",
    build: (c) => {
      const title = "Tenancy agreement: Flat 12, Arlington Court";
      const head = "Assured shorthold tenancy, 1 March 2026 – 28 February 2027.\n\n7. Repairs\n";
      return {
        text: "I need to get someone round to look at the damp patch in the bathroom.",
        detail:
          "Clause 7 of the tenancy agreement (Drive) says the tenant must report defects to the agent in writing and " +
          "must not instruct contractors directly; the landlord arranges repairs within 14 days.",
        hidden: doc(
          title,
          `${head}7.1 The Tenant shall report any disrepair or defect to the Agent in writing and shall not instruct ` +
            "contractors directly.\n7.2 The Landlord will arrange for repairs to be carried out within 14 days of notice.",
          at(3, 2, 10, 0),
        ),
        decoy: doc(
          title,
          `${head}7.1 The Tenant may instruct a contractor for minor repairs up to £250 and deduct the cost from the ` +
            "next rent, keeping receipts.\n7.2 Larger repairs are arranged by the Landlord within 14 days of notice.",
          at(3, 2, 10, 0),
        ),
      };
    },
  },

  // Overlap: one topic word ("recycling"). Decoy (b): the same suspension in another week (7 December).
  // Phrasing: indirect ("Remind me to…"). Source: gmail.
  {
    name: "home-recycling-tonight",
    build: (c) => {
      const from = bot("Islington Council", "noreply@islington.gov.uk");
      const stop = (t: Rng, week: string, next: string) =>
        notice(c, t, {
          from,
          when: at(11, 17, 14, 0),
          title: "Changes to your collections",
          body:
            `Because of industrial action, recycling collections on your street (usually Fridays) are suspended ${week}. ` +
            `Please keep bags inside until your next collection on ${next}.`,
        });
      return {
        text: "Remind me to put the recycling out tonight.",
        detail:
          "Islington Council's notice (17 November): recycling collections on the user's street are suspended this " +
          "week (industrial action), next collection Thursday 26 November, so the bags should stay in.",
        hidden: stop(c.ta, "this week", "Thursday 26 November"),
        decoy: stop(c.tb, "in the week of 7 December", "Thursday 17 December"),
      };
    },
  },

  // ── admin ──

  // Overlap: one topic word ("insurance"). Decoy (b): the home insurance price, another policy, barely changed.
  // Phrasing: imperative. Source: gmail.
  {
    name: "admin-motor-renewal",
    build: (c) => {
      const from = bot("Admiral", "noreply@admiral.com");
      const price = (t: Rng, what: string, ends: string, next: string, now: string) =>
        notice(c, t, {
          from,
          when: at(11, 10, 6, 30),
          title: "Next year's price",
          body:
            `Your ${what} insurance runs out on ${ends}. Next year's price: ${next} (this year: ${now}). ` +
            "If you do nothing, cover continues automatically at this price.",
        });
      return {
        text: "Renew the car insurance with the same company.",
        detail:
          "Admiral's notice (10 November): the motor insurance runs out on 1 December and next year's price is " +
          "£1,142.60, up from £648.20, worth comparing before renewing.",
        hidden: price(c.ta, "motor", "01/12/2026", "£1,142.60", "£648.20"),
        decoy: price(c.tb, "home", "14/01/2027", "£212.40", "£205.10"),
      };
    },
  },

  // Overlap: none (Czech request; English mail). Decoy (c): the accountant has everything and needs nothing more.
  // Phrasing: question ("Musím ještě…?"), Czech. Source: gmail.
  // Non-English (Czech).
  {
    name: "admin-tax-return-january",
    build: (c) => {
      const acc = c.role("accountant", ["Owen", "Price"]);
      return {
        text: "Musím ještě něco udělat s daňovým přiznáním, než přijde leden?",
        detail:
          `${acc.full} (accountant) emailed on 13 November that he still needs the P60 and the rental income figures ` +
          "by 30 November to file the 2025/26 tax return before the 31 January deadline.",
        hidden: mail(c, c.ta, {
          from: acc,
          when: at(11, 13, 11, 0),
          title: "2025/26 return",
          body: [
            "I'm still missing your P60 and the rental income figures for the flat.",
            "If I don't have them by 30/11 I can't promise to file before the 31 January deadline.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: acc,
          when: at(11, 13, 11, 0),
          title: "2025/26 return",
          body: [
            "Thanks, I have everything I need for your 2025/26 return.",
            "I'll file it in December and send you the figures to check first; nothing else needed from you.",
          ],
        }),
      };
    },
  },

  // Overlap: none (the request says "receipts" and "end of the month", the doc "claims" and "20/11"). Decoy (c): the
  // doc edited (mileage rate), deadline unchanged. Phrasing: indirect ("I'll…"). Source: drive.
  // Silent (Finance edited the policy doc).
  {
    name: "admin-receipts-month-end",
    build: (c) => {
      const title = "Expenses policy (Northwind)";
      const intro = "Claims are made in Concur, with an itemised bill for anything over £10.\n\nDeadlines\n";
      const usual = "- Claims must be submitted by the last working day of each month.";
      return {
        text: "I'll sort my receipts out at the end of the month.",
        detail:
          "Finance edited the expenses policy doc on 17 November: October and November claims must be in Concur by " +
          "20 November (tomorrow) because the year close was brought forward, not by the end of the month.",
        hidden: doc(
          title,
          `Last edited by Finance, 17 Nov\n\n${intro}- October and November claims must be submitted by 20/11 (year ` +
            "close brought forward). Late claims roll into the next financial year.\n- Mileage: 45p per mile.",
          at(11, 17, 9, 10),
        ),
        decoy: doc(
          title,
          `Last edited by Finance, 17 Nov\n\n${intro}${usual}\n- Mileage: 47p per mile from 1 December.`,
          at(11, 17, 9, 10),
        ),
        before: doc(title, `${intro}${usual}\n- Mileage: 45p per mile.`, at(9, 1, 9, 0)),
      };
    },
  },

  // Overlap: none (the request says "dinner money for next month", the letter "free school meals from 1 December").
  // Decoy (b): the same scheme from another date (September 2027). Phrasing: imperative. Source: school (rare).
  // Rare.
  {
    name: "admin-dinner-money",
    build: (c) => {
      const letter = (start: string, rest: string) =>
        rare(
          "school",
          "Free school meals for Years 3–6",
          `Dear Parents and Carers,\n\nFrom ${start}, all pupils in Years 3–6 will receive free school meals under ` +
            `Islington's new scheme. ${rest}\n\nHolloway Primary School`,
          at(11, 12, 13, 30),
        );
      return {
        text: "Top up Maya's dinner money for next month.",
        detail:
          "The school's ParentMail letter (12 November): from 1 December all Year 3–6 pupils get free school meals, " +
          "parents should not add meal money to ParentPay and balances will be refunded, so no top-up is needed.",
        hidden: letter(
          "1 December",
          "Please do not add funds to ParentPay for meals; existing balances will be refunded by the end of term.",
        ),
        decoy: letter("September 2027", "Until then, nothing changes."),
      };
    },
  },

  // Overlap: none (the request says "January", the note "Jan" with dates in Sintra). Decoy (a): the same wedding,
  // called off. Phrasing: imperative. Source: notes (rare).
  // Rare.
  {
    name: "admin-jury-availability",
    build: (c) => ({
      text: "Reply to the jury summons saying I'm free any time in January.",
      detail:
        'The user\'s note "Ana & Rui: wedding" (Apple Notes, 30 October): the user is at a wedding in Sintra from ' +
        "14 to 18 January 2027 with flights and an Airbnb booked, so they are not free all of January.",
      hidden: rare(
        "notes",
        "Ana & Rui: wedding",
        "Sintra, Thu 14 – Mon 18 Jan 2027\nFlights booked (TAP, 13 Jan), Airbnb paid\n" +
          c.ta.pick(["Gift: something from the list", "Gift: from the list, before Xmas"]) +
          "\nStill to book: hire car",
        at(10, 30, 21, 15),
      ),
      decoy: rare(
        "notes",
        "Ana & Rui: wedding",
        "~~Sintra, 14–18 Jan 2027~~\nOFF: they've postponed to 2028, flight and Airbnb refunds sorted (03/11)",
        at(11, 3, 18, 0),
      ),
    }),
  },

  // Overlap: a name only (the landlord's first name). Decoy (a): the rent query already sorted, clause corrected.
  // Phrasing: indirect ("I need to…"). Source: gmail.
  {
    name: "admin-tenancy-renewal",
    build: (c) => {
      const ll = c.role("landlord", ["Steve", "Hargreaves"]);
      const flat = c.role("flatmate", ["Jo", "Hart"]);
      return {
        text: `I need to return the signed renewal to ${ll.first}.`,
        detail:
          `${flat.full} (flatmate) emailed on 17 November not to return the new tenancy agreement yet: ${ll.first} ` +
          "put the rent at £1,950 in clause 3 instead of the agreed £1,800, and it is being queried.",
        hidden: mail(c, c.ta, {
          from: flat,
          when: at(11, 17, 21, 5),
          title: "Hold off",
          body: [
            `Don't do anything with the new agreement yet: ${ll.first} has put the rent up to £1,950 in clause 3, not the £1,800 we agreed on the phone.`,
            "I've emailed him to query it.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: flat,
          when: at(11, 6, 21, 5),
          title: "Rent query",
          body: [`Rent query sorted: ${ll.first} has corrected clause 3 back to £1,800, all fine now.`],
        }),
      };
    },
  },

  // ── social ──

  // Overlap: a name only (the best friend's first name, the group's title). Decoy (a): the venue scare resolved, all
  // as planned. Phrasing: indirect ("We're doing…"). Source: whatsapp (rare).
  // Rare.
  {
    name: "social-birthday-drinks",
    build: (c) => {
      const bf = c.role("best friend", ["Jamie", "Fox"]);
      const fr = c.role("friend", ["Leila", "Haddad"]);
      const group = (t: Rng, text: string) =>
        rare(
          "whatsapp",
          `${bf.first} 🎂🍻`,
          say([
            { who: "Ellie", text: t.pick(["can't wait!!", "see you all there x"]), when: at(11, 18, 13, 2) },
            { who: fr.first, text, when: at(11, 18, 13, 40) },
          ]),
          at(11, 18, 13, 40),
          { people: `${fr.full} <${fr.email}>` },
        );
      return {
        text: `We're doing ${bf.first}'s 40th drinks on Saturday, I'll head to the usual pub for 8.`,
        detail:
          `In the WhatsApp group for ${bf.first}'s birthday, ${fr.first} said on 18 November that the Crown ` +
          "double-booked the back room and it moved to the Albion on Thornhill Road from 7pm, not the usual pub at 8.",
        hidden: group(
          c.ta,
          "Crown messed up, they've double-booked the back room 🙄 NEW PLAN: the Albion on Thornhill Rd from 7, I've told the others",
        ),
        decoy: group(c.tb, "ignore my panic earlier, the Crown have sorted the back room, all as planned 🙌"),
      };
    },
  },

  // Overlap: a name only (the friend's first name). Decoy (c): the book club entry edited (venue), still on 26/11.
  // Phrasing: question ("Can I…?"). Source: calendar.
  // Anchored ("tomorrow night" against "20/11/2026, 19:30"), silent (the book club's host moved the date).
  {
    name: "social-dinner-tomorrow",
    build: (c) => {
      const fr = c.role("friend", ["Leila", "Haddad"]);
      const title = "Book club: Small Things Like These";
      const later = { start: at(11, 26, 19, 30), when: "26/11/2026, 19:30–21:30" };
      return {
        text: `Can I fit in dinner with ${fr.first} tomorrow night?`,
        detail:
          "The book club entry in the calendar was moved by its host (edited 17 November) from Thursday 26 November " +
          "to tomorrow, Friday 20 November, 19:30–21:30, which clashes with a dinner tomorrow night.",
        hidden: event({
          title,
          start: at(11, 20, 19, 30),
          when: "20/11/2026, 19:30–21:30",
          where: "Hana's, 41 Elmore St",
          notes: `Moved from the 26th (Hana's away then). ${fr.first} bringing wine.`,
          edited: at(11, 17, 22, 10),
        }),
        decoy: event({
          title,
          ...later,
          where: "Hana's, 41 Elmore St",
          notes: `Now at Hana's instead of the café. ${fr.first} bringing wine.`,
          edited: at(11, 17, 22, 10),
        }),
        before: event({ title, ...later, where: "Café Mono, Upper St", notes: "", edited: at(10, 28, 20, 0) }),
      };
    },
  },

  // Overlap: none (Spanish request; English booking notice). Decoy (b): a booking for six on another date (5/12).
  // Phrasing: imperative, Spanish. Source: gmail.
  // Anchored ("el sábado" against "Saturday 21 November"), non-English (Spanish).
  {
    name: "social-uni-dinner-table",
    build: (c) => {
      const from = bot("OpenTable", "reservations@opentable.co.uk");
      const booked = (t: Rng, day: string) =>
        notice(c, t, {
          from,
          when: at(11, 8, 19, 45),
          title: "Your reservation is confirmed",
          body:
            `Padella Shoreditch: ${day} 2026 at 20:00, party of 6. Booked under Robin Carter. Need to change? ` +
            "Modify or cancel up to 2 hours before.",
        });
      return {
        text: "Resérvame una mesa para seis el sábado por la noche para la cena con los de la uni.",
        detail:
          "OpenTable confirmed (8 November) a reservation for six at Padella Shoreditch on Saturday 21 November at " +
          "20:00, so a table is already booked.",
        hidden: booked(c.ta, "Saturday 21 November"),
        decoy: booked(c.tb, "Saturday 5 December"),
      };
    },
  },

  // Overlap: one topic word ("flat-warming"). Decoy (b): another friend's flat-warming, bring a bottle.
  // Phrasing: question ("Should I…?"). Source: gmail.
  {
    name: "social-flatwarming-bottle",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const fr = c.role("friend", ["Leila", "Haddad"]);
      return {
        text: "Should I bring a bottle to the flat-warming?",
        detail:
          `${sis.first} emailed on 16 November that her flat-warming on Saturday is alcohol-free (Dan is three months ` +
          "sober): soft drinks and nibbles only, so no bottle.",
        hidden: mail(c, c.ta, {
          from: sis,
          when: at(11, 16, 20, 20),
          title: "Saturday!",
          body: [
            "Reminder that the flat-warming is a dry one: Dan's three months sober and doing really well, so soft drinks and nibbles only please.",
            "Can't wait to show you the place.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: fr,
          when: at(11, 16, 20, 20),
          title: "Saturday!",
          body: ["My flat-warming is BYOB, there's a corner shop next door if you forget.", "Doors from 8."],
        }),
      };
    },
  },

  // Overlap: a name only (the colleague's first name). Decoy (c): the same task still open, assigned to the user with
  // a budget. Phrasing: indirect ("Going to…"). Source: tasks (rare).
  // Rare.
  {
    name: "social-leaving-present",
    build: (c) => {
      const [lv, org] = c.colleagues(2) as [Person, Person];
      const title = `${lv.first}'s send-off`;
      return {
        text: `Going to buy ${lv.first}'s leaving present this weekend.`,
        detail:
          `In the shared Todoist project, ${org.full} completed the task for ${lv.first}'s send-off on 17 November: ` +
          `a £150 Waterstones voucher is already bought, so no gift is needed, only £10 to ${org.first} for the collection.`,
        hidden: rare(
          "tasks",
          title,
          `Project: Team\n✓ Completed by ${org.full} · 17 Nov\n` +
            `Note: got the voucher (£150, Waterstones), card doing the rounds, £10 each to ${org.first}`,
          at(11, 17, 17, 30),
        ),
        decoy: rare(
          "tasks",
          title,
          `Project: Team\nAssigned to: Robin · Due: Mon 23 Nov\nNote: budget £150 from the whip-round, ${org.first} has the card`,
          at(11, 17, 17, 30),
        ),
      };
    },
  },

  // Overlap: a name only (the friend's first name). Decoy (b): the same friend got a pair for another band and date.
  // Phrasing: imperative. Source: gmail.
  {
    name: "social-gig-tickets",
    build: (c) => {
      const fr = c.role("friend", ["Leila", "Haddad"]);
      return {
        text: `Get two tickets for the Wet Leg gig for me and ${fr.first}.`,
        detail:
          `${fr.full} emailed on 14 November that she already got a pair for the Brixton show on 4 December for the ` +
          "two of them, so buying two more would double up.",
        hidden: mail(c, c.ta, {
          from: fr,
          when: at(11, 14, 11, 50),
          title: "!!!",
          body: [
            "Guess who got through the queue: I've got us a pair for Brixton on 4/12 (the one you sent me!) 🎉",
            "Pay me back whenever.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: fr,
          when: at(11, 14, 11, 50),
          title: "!!!",
          body: [
            "Guess who got through the queue: a pair for Fontaines D.C. at Ally Pally on 12/12 for me and my sister 🎉",
          ],
        }),
      };
    },
  },
];

/** Templates whose request names one person, thing or date the planted item words differently. */
export const HELDOUT20_ANCHORED: readonly string[] = [
  "work-workshop-catering",
  "family-drop-off-tomorrow",
  "family-sunday-lunch-mum",
  "family-christmas-eve-train",
  "family-tuesday-drinks",
  "health-team-lunch-friday",
  "health-mums-painkillers",
  "money-accountant-invoice",
  "money-savings-top-up",
  "money-cottage-share",
  "travel-client-visit-train",
  "travel-airport-leave-time",
  "home-overnight-wash",
  "home-hallway-paint",
  "social-dinner-tomorrow",
  "social-uni-dinner-table",
];
/** Templates whose planted item (both variants) sits in a rare source (RARE_SOURCES). */
export const HELDOUT20_RARE: readonly string[] = [
  "family-drop-off-tomorrow",
  "family-sunday-lunch-mum",
  "family-lessons-signup",
  "health-inhaler-reorder",
  "health-mums-painkillers",
  "money-fitter-deposit",
  "money-council-tax-card",
  "travel-airport-taxi",
  "home-sofa-delivery",
  "home-hallway-paint",
  "admin-dinner-money",
  "admin-jury-availability",
  "social-birthday-drinks",
  "social-leaving-present",
];
/** Templates whose fact is a silent edit at the source (their Spec has `before`). */
export const HELDOUT20_SILENT: readonly string[] = [
  "work-portfolio-slides",
  "work-offer-discount",
  "family-christmas-eve-train",
  "health-team-lunch-friday",
  "health-mums-painkillers",
  "money-cottage-share",
  "travel-airport-taxi",
  "travel-client-visit-train",
  "home-sofa-delivery",
  "home-hallway-paint",
  "admin-receipts-month-end",
  "social-dinner-tomorrow",
];
/** Templates whose request is not in English (name the language in the template's comment). */
export const HELDOUT20_NON_ENGLISH: readonly string[] = [
  "work-offer-discount",
  "work-workshop-catering",
  "family-sunday-lunch-mum",
  "family-tuesday-drinks",
  "health-inhaler-reorder",
  "health-trainer-session",
  "money-accountant-invoice",
  "money-council-tax-card",
  "travel-istanbul-visa",
  "home-overnight-wash",
  "admin-tax-return-january",
  "social-uni-dinner-table",
];
/** Templates whose request is a question ("Should I…?", "Can we…?", "Is … still …?"). */
export const HELDOUT20_QUESTION: readonly string[] = [
  "work-client-demo",
  "family-sunday-lunch-mum",
  "family-tuesday-drinks",
  "health-richmond-half",
  "money-accountant-invoice",
  "money-energy-switch",
  "travel-istanbul-visa",
  "travel-airport-leave-time",
  "home-overnight-wash",
  "admin-tax-return-january",
  "social-dinner-tomorrow",
  "social-flatwarming-bottle",
];
/** Templates whose request is an indirect plan or statement ("I need to…", "Thinking of…", "We're doing X…"). */
export const HELDOUT20_INDIRECT: readonly string[] = [
  "work-portfolio-slides",
  "work-friday-off",
  "family-drop-off-tomorrow",
  "family-lessons-signup",
  "health-team-lunch-friday",
  "health-trainer-session",
  "health-mums-painkillers",
  "money-savings-top-up",
  "money-cottage-share",
  "money-council-tax-card",
  "travel-weekend-drive",
  "travel-client-visit-train",
  "home-sofa-delivery",
  "home-damp-repair",
  "home-recycling-tonight",
  "admin-receipts-month-end",
  "admin-tenancy-renewal",
  "social-birthday-drinks",
  "social-leaving-present",
];
/** Templates whose request shares no word with the planted item (names, dates and numbers included). */
export const HELDOUT20_NO_OVERLAP: readonly string[] = [
  "work-client-demo",
  "work-friday-off",
  "work-workshop-catering",
  "family-drop-off-tomorrow",
  "family-sunday-lunch-mum",
  "family-christmas-eve-train",
  "family-tuesday-drinks",
  "family-saturday-babysitter",
  "health-inhaler-reorder",
  "health-team-lunch-friday",
  "health-spa-weekend",
  "health-mums-painkillers",
  "money-fitter-deposit",
  "money-accountant-invoice",
  "money-savings-top-up",
  "money-cottage-share",
  "money-council-tax-card",
  "travel-istanbul-visa",
  "travel-client-visit-train",
  "travel-airport-leave-time",
  "home-sofa-delivery",
  "home-overnight-wash",
  "home-hallway-paint",
  "home-damp-repair",
  "admin-tax-return-january",
  "admin-receipts-month-end",
  "admin-dinner-money",
  "admin-jury-availability",
  "social-uni-dinner-table",
];

/** Each silent-change template's `before` item, for a days harness (same RNG draws as the planting function). */
export function heldout20Before(world: World, seed: number): { template: string; before: Plant }[] {
  return build(world, seed).flatMap(({ name, spec }) => (spec.before ? [{ template: name, before: spec.before }] : []));
}
/** Build every template's spec, in order, with the suite's own streams (no world change). */
function build(world: World, seed: number): { name: string; spec: Spec }[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_927 + 2_020);
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
export function plantHeldout20(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  // The rare filler is dated from `world.now`, so the clock moves first (prepareWorld does both, in this order).
  if (world.now !== HELDOUT20_NOW) throw new Error('heldout20: call prepareWorld("heldout20", world, seed) first');
  addRareSources(world, seed);
  const suite = variant === "hidden" ? "heldout20" : `heldout20-${variant}`;
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

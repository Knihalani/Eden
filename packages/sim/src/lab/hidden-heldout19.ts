/**
 * Held-out hidden-context suite 19 (P7, the end-of-wave confirmation), written blind: the author read only the
 * scaffold of this file, the HiddenTask interface (the head of hidden-context.ts) and the sim world API (world.ts,
 * names.ts, text.ts, rng.ts, rare-sources.ts). No other suite, no engine, ranking, reader or prompt code, no docs,
 * caches or tests were read, and no funnel, eval or model was run on it. Measurement only: never tune on it.
 *
 * 40 templates, five in each life area (work, family, health, money, travel, home, admin, social, in that order).
 * Each is a request the user types (it does not name the hidden context), the consideration a good answer raises, a
 * planted item stating it (variant `hidden`) and a near-miss look-alike that does not apply (`control`); `neutral`
 * plants nothing. Request and detail are the same in every variant.
 *
 * Counts, from the comment above each template. Word overlap between request and planted item: none 26, a name or
 * reference only 11, one topic word 3 (none share more). Decoy kinds: (a) resolved/expired/superseded 13, (b) another
 * entity or date of the same kind 17, (c) condition met / item allows it 10. Phrasing: 11 plain imperatives, 29
 * indirect (10 questions: "Should I / Can I / Can you", 19 plans and "I want to / Let's / Remind me / Thinking of /
 * I'll / Going to" forms). Non-English 7 (German, Spanish, French, Italian, Portuguese, Dutch, Hindi in Latin script).
 * Anchored 16. Rare-source 12: notes 2, whatsapp 2, bank 2, health 1, school 1, trips 1, residents 2, tasks 1.
 * Silent-change 10 (calendar 3, drive 4, tasks 1, trips 1, residents 1). Sources of the other 28: gmail 11
 * (7 mail, 4 notification), calendar 5, drive 5, slack 5, crm 2 (an account and a contact).
 *
 * World time is Tuesday 27 October 2026, 09:00 UTC. Weekdays checked with Date.UTC: 2026-01-12 Mon; 01-27 Tue;
 * 03-30 Mon; 07-25 Sat; 07-26 Sun; 08-01 Sat; 08-02 Sun; 08-08 Sat; 08-09 Sun; 08-10 Mon; 09-01 Tue; 09-02 Wed;
 * 09-03 Thu; 09-09 Wed; 09-10 Thu; 09-21 Mon; 09-28 Mon; 10-01 Thu; 10-02 Fri; 10-03 Sat; 10-04 Sun; 10-07 Wed;
 * 10-08 Thu; 10-09 Fri; 10-11 Sun; 10-12 Mon; 10-13 Tue; 10-14 Wed; 10-15 Thu; 10-16 Fri; 10-18 Sun; 10-19 Mon;
 * 10-20 Tue; 10-21 Wed; 10-22 Thu; 10-23 Fri; 10-24 Sat; 10-25 Sun; 10-28 Wed; 10-29 Thu; 10-30 Fri; 10-31 Sat;
 * 11-02 Mon; 11-03 Tue; 11-04 Wed; 11-05 Thu; 11-06 Fri; 11-07 Sat; 11-08 Sun; 11-09 Mon; 11-12 Thu; 11-13 Fri;
 * 11-14 Sat; 11-15 Sun; 11-17 Tue; 11-18 Wed; 11-20 Fri; 11-21 Sat; 11-25 Wed; 11-26 Thu; 11-27 Fri; 12-03 Thu;
 * 12-04 Fri; 12-06 Sun; 12-11 Fri; 2027-01-18 Mon; 01-20 Wed.
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
   * Silent-change templates only (HELDOUT19_SILENT): the planted item as it read before someone edited it at the
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

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  // Overlap: none (the request names the client by first name, the chat names the company). Decoy (b): the same hold
  // on another client's company. Phrasing: question ("Can you…?"). Source: slack. Anchored.
  {
    name: "figures-wait-for-countersign",
    build: (c) => {
      const [p] = c.clients(1);
      const q = otherClient(c, p!);
      const [legal, by] = c.colleagues(2);
      const line = (t: Rng, org: string) =>
        chat(
          t,
          "deal-desk",
          [
            {
              who: legal!,
              text: `reminder: nothing with figures in it goes to ${org} until their mutual NDA comes back countersigned. sent it over 9 Oct, still waiting`,
              when: at(10, 21, 14, 12),
            },
            { who: legal!, text: "decks without numbers are fine", when: at(10, 21, 14, 13) },
          ],
          by!,
        );
      return {
        text: `Can you send ${p!.nick ?? p!.first} the updated pricing sheet today?`,
        detail: `${legal!.full} said in #deal-desk on 21 October 2026 that nothing with figures goes to ${orgOf(p!)} until their mutual NDA is countersigned, which it had not been.`,
        hidden: line(c.ta, orgOf(p!)),
        decoy: line(c.tb, orgOf(q)),
      };
    },
  },
  // Overlap: none (the request says Thursday, the event 29/10). Decoy (b): the same workshop series on another date.
  // Phrasing: imperative. Source: calendar. Anchored, silent (the client's organiser moved the slot later).
  {
    name: "onsite-runs-later",
    build: (c) => {
      const [host] = c.clients(1);
      const org = orgOf(host!);
      const ws = (when: string, start: number, edited: number) =>
        event({
          title: `${org} onsite workshop`,
          start,
          when,
          where: `${org} office, 3 Forbury Square, Reading`,
          notes: `Organiser: ${host!.full}\nAttendees: ${c.user.full}, ${host!.full}\nAgenda: roadmap walkthrough, then integration Q&A with their platform team.`,
          edited,
        });
      return {
        text: "Book me the 16:40 train home on Thursday.",
        detail: `The ${org} onsite workshop in Reading on Thursday 29 October 2026 was moved on the calendar (edited 23 October) from 11:00–15:00 to 14:00–17:30, so a 16:40 train home clashes with it.`,
        before: ws("29/10/2026, 11:00–15:00", at(10, 29, 11), at(10, 9, 10, 30)),
        hidden: ws("29/10/2026, 14:00–17:30", at(10, 29, 14), at(10, 23, 16, 40)),
        decoy: ws("12/11/2026, 14:00–17:30", at(11, 12, 14), at(10, 23, 16, 40)),
      };
    },
  },
  // Overlap: none. Decoy (a): the September freeze, already lifted. Phrasing: indirect ("I want to…"). Source: drive.
  {
    name: "freeze-over-month-end",
    build: (c) => {
      const [dev] = c.colleagues(1);
      return {
        text: `I want to give ${dev!.nick ?? dev!.first} the go-ahead to start moving the Atlas data across on Monday.`,
        detail:
          "The 'Change freeze — November close' doc (19 October 2026) bars deploys, schema changes and migrations to live systems from Monday 2 November to Friday 13 November without the COO's written OK.",
        hidden: doc(
          "Change freeze — November close",
          "No deploys, schema changes or migrations to live systems from Mon 2 Nov to Fri 13 Nov 2026 (month-end close and the audit sample).\nExceptions need a written OK from the COO in #change-board.\nStaging and dev are unaffected.",
          at(10, 19, 11, 5),
        ),
        decoy: doc(
          "Change freeze — September close",
          "No deploys, schema changes or migrations to live systems from Mon 21 Sep to Fri 2 Oct 2026 (quarter close).\nLifted Fri 2 Oct 17:00: normal release train resumed.\nStaging and dev were unaffected.",
          at(10, 2, 17, 10),
        ),
      };
    },
  },
  // Overlap: a name only. Decoy (a): the time off was postponed. Phrasing: question, German ("Kannst du…?").
  // Source: slack. Anchored, non-English (German).
  {
    name: "kollege-umzug",
    build: (c) => {
      const [col, cover] = c.colleagues(2);
      const [cl] = c.clients(1);
      const name = col!.nick ?? col!.first;
      const say = (t: Rng, text: string) =>
        chat(t, "team-partnerships", [{ who: col!, text, when: at(10, 22, 17, 5) }], cover!);
      return {
        text: `Kannst du ${name} für Freitag zum Termin mit ${orgOf(cl!)} einladen?`,
        detail: `${col!.full} said in #team-partnerships on 22 October 2026 that they are off from Thursday 29 October at lunchtime to Tuesday 3 November (moving house, phone off), so they cannot join a meeting on Friday 30 October.`,
        hidden: say(
          c.ta,
          `fyi I'm off from Thursday lunchtime until Tue 3rd, we're moving house. phone will be off, ${cover!.first} is covering anything urgent`,
        ),
        decoy: say(
          c.tb,
          `fyi the days off I'd booked for the move are cancelled, completion slipped to December. so I'm around as normal, ignore the OOO`,
        ),
      };
    },
  },
  // Overlap: a name only (the account title). Decoy (b): the same hold on another client's account. Phrasing:
  // indirect ("Let's…"). Source: crm.
  {
    name: "account-on-hold",
    build: (c) => {
      const [p] = c.clients(1);
      const q = otherClient(c, p!);
      const [ar] = c.colleagues(1);
      const rec = (org: string): Plant => ({
        sourceId: "crm",
        kind: "deal",
        title: `${org} — Account`,
        text: `Account: ${org}\nOwner: ${c.user.full}\nTier: Business\nStatus: CREDIT HOLD (set by Finance, 19 Oct 2026)\nNote: two invoices more than 60 days overdue. No new commercial terms or order forms until Accounts Receivable clears the hold.\nAR contact: ${ar!.full}`,
        updatedAt: at(10, 19, 15, 20),
      });
      return {
        text: `Let's offer ${orgOf(p!)} the multi-year discount on Thursday's call.`,
        detail: `The CRM account record for ${orgOf(p!)} has been on credit hold since 19 October 2026 (two invoices over 60 days overdue): no new commercial terms until ${ar!.full} in Accounts Receivable clears it.`,
        hidden: rec(orgOf(p!)),
        decoy: rec(orgOf(q)),
      };
    },
  },

  // ── family ──
  // Overlap: none. Decoy (b): the same change for another year group. Phrasing: indirect ("Remind me to…").
  // Source: school (rare). Anchored (Thursday vs 29/10), rare.
  {
    name: "swim-not-gym",
    build: (c) => {
      const teacher = c.role("Maya's teacher", ["Mrs", "Daley"]);
      const letter = (year: string, who: string) =>
        rare(
          "school",
          `${year}: changes this half term`,
          `Dear Parents and Carers,\n\nFrom 29/10, ${year}'s weekly PE lesson will be swimming at Sobell Leisure Centre for the rest of the autumn term. Children will need a swimming costume, a towel, goggles and a swimming hat; no jewellery. Please send them in school uniform as usual: there is no need for the usual PE bag on that day.\n\nWith thanks,\n${who}`,
          at(10, 20, 15, 30),
        );
      return {
        text: "Remind me to pack Maya's gym kit for Thursday.",
        detail: `A ParentMail letter from ${teacher.full} (20 October 2026) says that from 29 October Year 3's PE is swimming at Sobell Leisure Centre: Maya needs a costume, towel, goggles and hat, not her PE bag.`,
        hidden: letter("Year 3", teacher.full),
        decoy: letter("Year 5", "Mr Okoro"),
      };
    },
  },
  // Overlap: none. Decoy (b): a friend, not the sister, is the one expecting. Phrasing: indirect ("Quiero…").
  // Source: whatsapp (rare). Rare, non-English (Spanish).
  {
    name: "regalo-spa",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const friend = c.role("friend", ["Leila", "Haddad"]);
      const wa = (p: Person) =>
        rare(
          "whatsapp",
          p.first,
          chatText([
            {
              who: p.full,
              text: "ok you're the first to know after Mum 🙈 we're expecting!! 12 weeks on Friday, scan was all fine. keeping it quiet till Christmas",
              at: at(10, 18, 21, 4),
            },
            { who: c.user.full, text: "WHAT 😭❤️ congratulations!!!", at: at(10, 18, 21, 6) },
            {
              who: p.full,
              text: "midwife gave me the list: no hot tubs, no saunas, no steam rooms, half the cheeses. basically banned from fun",
              at: at(10, 18, 21, 9),
            },
          ]),
          at(10, 18, 21, 9),
          { people: `${p.full} <${p.email}>` },
        );
      return {
        text: `Quiero regalarle a ${sis.first} un fin de semana de spa por su cumpleaños.`,
        detail: `${sis.full} told Robin on WhatsApp on 18 October 2026 that she is 12 weeks pregnant and her midwife said no hot tubs, saunas or steam rooms, so a spa weekend needs to be pregnancy-safe.`,
        hidden: wa(sis),
        decoy: wa(friend),
      };
    },
  },
  // Overlap: a name only ("Mum"). Decoy (b): last summer's rota, other dates. Phrasing: statement of a plan.
  // Source: drive. Silent (the sister edited the shared rota).
  {
    name: "rota-swapped",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const title = "Mum — visits and lifts";
      const head = `Shared with ${sis.first}. Edit freely, just keep it up to date.\n\n`;
      const tail = `\n- Sat 14 Nov: hospital follow-up 10:30, ${sis.first} driving`;
      return {
        text: "I'll drive up to see Mum on Saturday morning and stay over.",
        detail: `${sis.full} edited the shared 'Mum — visits and lifts' doc on 24 October 2026: Mum is at Auntie Jean's in Bath on 31 October–1 November (no visit needed), and Robin's turn moved to 7–8 November.`,
        before: doc(
          title,
          `${head}October\n- Sat 24–Sun 25: ${sis.first}\n- Sat 31 Oct–Sun 1 Nov: Robin (bring the step ladder for the loft)\n\nNovember\n- Sat 7–Sun 8: ${sis.first}${tail}`,
          at(10, 3, 20, 45),
        ),
        hidden: doc(
          title,
          `${head}October\n- Sat 24–Sun 25: ${sis.first}\n- Sat 31 Oct–Sun 1 Nov: Mum at Auntie Jean's in Bath (Jean collecting her Fri), nobody needed\n\nNovember\n- Sat 7–Sun 8: Robin (bring the step ladder for the loft)${tail}`,
          at(10, 24, 20, 10),
        ),
        decoy: doc(
          `${title} (summer)`,
          `${head}July\n- Sat 25–Sun 26: Robin\n\nAugust\n- Sat 1–Sun 2: Mum at Auntie Jean's in Bath, nobody needed\n- Sat 8–Sun 9: ${sis.first}`,
          at(8, 10, 19, 0),
        ),
      };
    },
  },
  // Overlap: a name only. Decoy (b): another child's party, a week later. Phrasing: imperative. Source: calendar.
  // Anchored (Saturday vs 31/10).
  {
    name: "party-at-ten",
    build: () => {
      const party = (child: string, mum: string, when: string, start: number) =>
        event({
          title: `${child}'s 7th — Gambado`,
          start,
          when,
          where: "Gambado, Chelsea Harbour",
          notes: `Maya invited, RSVP'd yes to ${child}'s mum ${mum}. Drop-off 9:45, pick-up 12:00. Present is wrapped, in the hall cupboard.`,
          edited: at(10, 14, 19, 20),
        });
      return {
        text: "Book Maya a haircut for Saturday at 10.",
        detail:
          "The calendar has Maya at Lily's 7th birthday party at Gambado, Chelsea Harbour on Saturday 31 October 2026 from 10:00 to 12:00 (drop-off 9:45), added on 14 October.",
        hidden: party("Lily", "Sara", "31/10, 10:00–12:00", at(10, 31, 10)),
        decoy: party("Noah", "Priti", "07/11, 10:00–12:00", at(11, 7, 10)),
      };
    },
  },
  // Overlap: none. Decoy (c): the pass lapsed, so the gift would be welcome. Phrasing: indirect
  // ("Thinking of…"). Source: gmail.
  {
    name: "pass-already-given",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: mum, when: at(10, 11, 18, 30), title: "Sunday", body });
      return {
        text: "Thinking of getting Mum the Kew membership again for Christmas.",
        detail: `Mum (${mum.full}) wrote on 11 October 2026 that ${sis.first} already gave her the gardens pass for her birthday, valid until next autumn, and she would like new secateurs instead.`,
        hidden: note(c.ta, [
          `Lovely lunch on Sunday. ${sis.first} and Dom gave me the gardens pass for my birthday, so I'm sorted until next autumn.`,
          "If anyone asks what I'd like later in the year, a new pair of secateurs would be wonderful, mine are falling apart.",
        ]),
        decoy: note(c.tb, [
          "Lovely lunch on Sunday. I let the gardens pass lapse in the summer, I never got round to using it.",
          "I do miss the glasshouses though, maybe next year. Mine are falling apart, the secateurs I mean!",
        ]),
      };
    },
  },

  // ── health ──
  // Overlap: none. Decoy (a): the restriction was lifted after a normal repeat test. Phrasing: question ("Can I…?").
  // Source: health (rare). Rare.
  {
    name: "kidney-painkillers",
    build: () => {
      const msg = (text: string) => rare("health", "Message from your GP practice", text, at(10, 13, 11, 22));
      return {
        text: "Can I take ibuprofen for this back pain?",
        detail:
          "A GP message in the NHS App on 13 October 2026 (Dr A. Okoye, Highbury Grange) says kidney function is reduced (eGFR 52) and to avoid anti-inflammatory painkillers, which includes ibuprofen; paracetamol is fine.",
        hidden: msg(
          "Dr A. Okoye has reviewed your blood test from 7 October.\n\nYour kidney function is a little reduced (eGFR 52). Please avoid anti-inflammatory painkillers such as naproxen and diclofenac until we repeat the test in 3 months; paracetamol is fine. No other action is needed.\n\nHighbury Grange Medical Practice",
        ),
        decoy: msg(
          "Dr A. Okoye has reviewed your repeat blood test from 7 October.\n\nYour kidney function is back to normal (eGFR 91). The earlier advice to avoid anti-inflammatory painkillers no longer applies. No other action is needed.\n\nHighbury Grange Medical Practice",
        ),
      };
    },
  },
  // Overlap: none. Decoy (c): a different antibiotic with no alcohol warning. Phrasing: statement of a plan,
  // French. Source: gmail (notification). Non-English (French).
  {
    name: "verre-jeudi",
    build: (c) => {
      const friend = c.role("best friend", ["Jamie", "Fox"]);
      const boots = bot("Boots Pharmacy", "prescriptions@boots.com");
      const rx = (t: Rng, body: string) =>
        notice(c, t, { from: boots, when: at(10, 24, 12, 5), title: "Your prescription is ready to collect", body });
      return {
        text: `Je vais prendre un verre avec ${friend.first} jeudi soir après le boulot.`,
        detail:
          "Boots told Robin on 24 October 2026 that the prescription was metronidazole, a 7-day course: no alcohol during it and for 48 hours after, so drinks on Thursday 29 October are out.",
        hidden: rx(
          c.ta,
          "Your prescription for metronidazole 400mg (7-day course, three times a day) is ready at Boots, Upper Street.\n\nImportant: do not drink alcohol while taking this medicine and for at least 48 hours after the last dose. It can make you very unwell.",
        ),
        decoy: rx(
          c.tb,
          "Your prescription for amoxicillin 500mg (7-day course, three times a day) is ready at Boots, Upper Street.\n\nYou can drink alcohol in moderation with this medicine. Finish the whole course even if you feel better.",
        ),
      };
    },
  },
  // Overlap: none (the request says Wednesday, the event 28/10). Decoy (b): the same appointment a week later.
  // Phrasing: imperative. Source: calendar. Anchored, silent (the clinic's booking sync moved it).
  {
    name: "physio-moved-early",
    build: (c) => {
      const appt = (when: string, start: number, edited: number) =>
        event({
          title: "Physio — knee (Bayo)",
          start,
          when,
          where: "Balance Physio, 14 Essex Rd",
          notes: `Patient: ${c.user.full}\nBring shorts. Booked through the clinic app.`,
          edited,
        });
      return {
        text: "Sign me up for the 7:30 spin class on Wednesday.",
        detail:
          "The knee physio appointment with Bayo at Balance Physio on Wednesday 28 October 2026 was moved on the calendar (edited 22 October) from 13:00 to 07:30–08:15, clashing with a 7:30 class.",
        before: appt("28/10, 13:00–13:45", at(10, 28, 13), at(10, 8, 9, 15)),
        hidden: appt("28/10, 07:30–08:15", at(10, 28, 7, 30), at(10, 22, 18, 2)),
        decoy: appt("04/11, 07:30–08:15", at(11, 4, 7, 30), at(10, 22, 18, 2)),
      };
    },
  },
  // Overlap: none. Decoy (b): the child's nasal spray, another person. Phrasing: question ("Should I…?").
  // Source: tasks (rare). Rare, silent (the sister edited the shared task).
  {
    name: "jab-already-booked",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const shared = `Project: Family · Shared with ${sis.full}`;
      return {
        text: "Should I get my winter vaccine at the GP this week?",
        detail: `${sis.first} edited the shared Todoist task 'Flu jab' on 21 October 2026: she booked Robin in at Boots, Upper Street on Monday 2 November at 18:20, so no GP booking is needed.`,
        before: rare(
          "tasks",
          "Flu jab",
          `Flu jab\nbook one before Nov, Boots or the surgery?\n${shared}`,
          at(10, 1, 8, 10),
        ),
        hidden: rare(
          "tasks",
          "Flu jab",
          `Flu jab\n${sis.first}: booked you in with mine at Boots, Upper Street, Mon 2 Nov 18:20 (you) and 18:25 (me). Confirmation went to my email\n${shared}`,
          at(10, 21, 22, 40),
        ),
        decoy: rare(
          "tasks",
          "Maya — flu nasal spray",
          `Maya — flu nasal spray\nschool nurse is doing it on Thu 5 Nov, consent form signed and returned\n${shared}`,
          at(10, 21, 22, 40),
        ),
      };
    },
  },
  // Overlap: none. Decoy (a): an old shoulder restriction that was cleared. Phrasing: indirect ("Let's…").
  // Source: notes (rare). Rare.
  {
    name: "knee-no-load",
    build: (c) => {
      const pt = c.role("personal trainer", ["Tom", "Bradley"]);
      return {
        text: `Let's book a heavy leg day with ${pt.first} on Friday.`,
        detail:
          "Robin's note 'Knee' (15 October 2026, from the physio Bayo) says no loaded squats, lunges or jumping for 6 weeks, earliest 26 November; cycling and swimming are fine.",
        hidden: rare(
          "notes",
          "Knee",
          "Physio (Bayo), 15 Oct:\n- no loaded squats, lunges or jumping for 6 weeks → earliest 26 Nov\n- bike and swimming fine\n- the machine press only light, no deep bend\n- ice after, 10 min",
          at(10, 15, 18, 40),
        ),
        decoy: rare(
          "notes",
          "Shoulder",
          "Physio (Bayo), 2 Sep:\n- cleared for overhead pressing and pull-ups again, no limits\n- keep the band work as a warm-up\n- ice only if sore",
          at(9, 2, 18, 40),
        ),
      };
    },
  },

  // ── money ──
  // Overlap: a name only. Decoy (c): the payee name matched and was saved. Phrasing: imperative. Source: bank (rare).
  // Anchored (the accountant by first name; the bank shows the payee and account), rare.
  {
    name: "payee-mismatch",
    build: (c) => {
      const acc = c.role("accountant", ["Owen", "Price"]);
      const msg = (line: string) =>
        rare(
          "bank",
          "About the new payee you added",
          `You started adding a new payee on 23 Oct: '${acc.full}', sort code 04-00-75, account ending 3318.\n\n${line}`,
          at(10, 23, 16, 48),
        );
      return {
        text: `Send ${acc.first} the £600 for the tax return today.`,
        detail: `Robin's bank warned on 23 October 2026 that the account given for '${acc.full}' (ending 3318) is registered to 'K MENSAH TRADING', a possible scam (changed bank details), so the payee was not saved and nothing should be sent before checking with ${acc.first} by phone.`,
        hidden: msg(
          "The name on that account doesn't match: it's registered to 'K MENSAH TRADING'. This can be a sign of a scam, for example an email saying someone's bank details have changed. We haven't saved this payee. Please call the person on a number you trust before you send anything.",
        ),
        decoy: msg(
          `The name on that account matches: '${acc.last.toUpperCase()} ACCOUNTANCY LTD'. We've saved this payee and you can send money to them at any time.`,
        ),
      };
    },
  },
  // Overlap: none. Decoy (a): the fixed saver already matured and the money is free. Phrasing: indirect ("voglio…"),
  // Italian. Source: bank (rare). Rare, non-English (Italian).
  {
    name: "risparmi-bloccati",
    build: () => ({
      text: "Domani voglio spostare 5.000 sterline dai risparmi al conto corrente.",
      detail:
        "A bank message of 12 October 2026 says Robin's 1-Year Fixed Saver (ending 2207) matures on Monday 9 November and nothing can be withdrawn or moved before then.",
      hidden: rare(
        "bank",
        "Your Fixed Saver",
        "Your 1-Year Fixed Saver (ending 2207) matures on Mon 9 Nov 2026. Until then the money can't be withdrawn or moved. On maturity it goes to your Instant Access account unless you choose otherwise.",
        at(10, 12, 8, 0),
      ),
      decoy: rare(
        "bank",
        "Your Fixed Saver",
        "Your 1-Year Fixed Saver (ending 2207) matured on Fri 9 Oct 2026. £5,412.80 is now in your Instant Access account and you can move or withdraw it at any time.",
        at(10, 9, 8, 0),
      ),
    }),
  },
  // Overlap: none. Decoy (c): the allowance is still unused, so selling is fine. Phrasing: question ("Should I…?").
  // Source: gmail.
  {
    name: "allowance-used-up",
    build: (c) => {
      const acc = c.role("accountant", ["Owen", "Price"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: acc, when: at(10, 7, 10, 15), title: "Capital gains this year", body, corporate: true });
      return {
        text: "Should I sell some of my Vanguard holdings before Christmas?",
        detail: `${acc.full}, the accountant, wrote on 7 October 2026 that the July flat sale used up this tax year's capital gains allowance, so gains on the investments before 6 April 2027 are taxed at 24%; better to wait.`,
        hidden: note(c.ta, [
          "A note on the investment portfolio: the flat sale in July used up your capital gains allowance for this tax year (2026-27), so anything you realise before 6 April is taxable at 24%.",
          "If you can wait until after 5 April you'll have the new allowance. Happy to run the numbers if you need the cash sooner.",
        ]),
        decoy: note(c.tb, [
          "A note on the investment portfolio: the flat completed on 30 March, so that gain falls in last tax year and you still have the full £3,000 allowance for 2026-27.",
          "No reason to hold off if you want to realise some. Happy to run the numbers if useful.",
        ]),
      };
    },
  },
  // Overlap: one topic word ("council"). Decoy (a): last year's split, superseded. Phrasing: statement of a plan.
  // Source: drive. Silent (the sister edited the shared sheet).
  {
    name: "bill-already-moved",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const title = "Mum's bills — who pays what";
      const rest = "\nWater (Thames): Mum, from her pension account\nTV licence: Robin from January\nBroadband: Mum";
      return {
        text: "Going to take over paying Mum's council bill from November.",
        detail: `${sis.full} edited the shared 'Mum's bills — who pays what' doc on 20 October 2026: she now pays Mum's council tax by direct debit from her own account from November, so Robin should not set one up too.`,
        before: doc(
          title,
          `Council tax (Camden, Band D, £178/mo): Robin from Nov, needs the direct debit setting up${rest}`,
          at(10, 4, 21, 0),
        ),
        hidden: doc(
          title,
          `Council tax (Camden, Band D, £178/mo): ${sis.first} from Nov, DD set up from her account 20 Oct${rest}`,
          at(10, 20, 21, 30),
        ),
        decoy: doc(
          `${title} (2025)`,
          `Council tax (Camden, Band D, £169/mo): Robin until Oct 2025, then Mum again\nWater (Thames): Mum\nTV licence: Mum\nBroadband: Mum`,
          at(1, 12, 20, 0),
        ),
      };
    },
  },
  // Overlap: none ("Amex" vs American Express). Decoy (b): another issuer's card with the same last digits.
  // Phrasing: imperative. Source: gmail (notification). Anchored.
  {
    name: "card-cancelled",
    build: (c) => {
      const card = (t: Rng, issuer: string, email: string) =>
        notice(c, t, {
          from: bot(issuer, email),
          when: at(10, 19, 13, 40),
          title: "Your replacement card is on its way",
          body: `Following the security issue you reported on 19 Oct, your ${issuer} card ending 7731 has been cancelled and any payment attempted on it will be declined. Your replacement card ending 1009 should arrive within 5 working days.`,
        });
      return {
        text: "Put the kitchen fitter's deposit on the Amex.",
        detail:
          "American Express wrote on 19 October 2026 that the card ending 7731 was cancelled after a reported security issue and payments on it will be declined; the replacement (ending 1009) arrives within 5 working days.",
        hidden: card(c.ta, "American Express", "americanexpress@welcome.aexp.com"),
        decoy: card(c.tb, "Barclaycard", "noreply@barclaycard.co.uk"),
      };
    },
  },

  // ── travel ──
  // Overlap: none. Decoy (b): another trip from Gatwick on another date. Phrasing: question ("Can you…?").
  // Source: trips (rare). Anchored (12/11), rare, silent (the airline's schedule change synced into the itinerary).
  {
    name: "itinerary-new-airport",
    build: () => {
      const title = "Vienna, November";
      return {
        text: "Can you book a cab to Heathrow for 5am on 12/11?",
        detail:
          "The TripIt itinerary 'Vienna, November' now shows the outbound on Thursday 12 November 2026 as BA 2700 from London Gatwick North at 10:50 (it was Heathrow T5 at 07:15), changed on 20 October without notice.",
        before: rare(
          "trips",
          title,
          "Thu 12 Nov · BA 700 · London Heathrow T5 07:15 → Vienna 10:35\nHotel Topazz, 3 nights · confirmation 551902\nSun 15 Nov · BA 703 · Vienna 17:05 → London Heathrow 18:40",
          at(9, 28, 20, 0),
        ),
        hidden: rare(
          "trips",
          title,
          "Thu 12 Nov · BA 2700 · London Gatwick North 10:50 → Vienna 14:05\nHotel Topazz, 3 nights · confirmation 551902\nSun 15 Nov · BA 2703 · Vienna 15:00 → London Gatwick North 16:35",
          at(10, 20, 3, 12),
        ),
        decoy: rare(
          "trips",
          "Edinburgh, December",
          "Fri 4 Dec · easyJet U2 803 · London Gatwick North 09:40 → Edinburgh 11:00\nAirbnb in Stockbridge, 2 nights\nSun 6 Dec · U2 810 · Edinburgh 18:20 → London Gatwick North 19:45",
          at(10, 20, 3, 12),
        ),
      };
    },
  },
  // Overlap: none. Decoy (c): the new passport was already posted. Phrasing: indirect ("Preciso…"), Portuguese.
  // Source: gmail (notification). Non-English (Portuguese).
  {
    name: "passaporte-atrasado",
    build: (c) => {
      const hmpo = bot("HM Passport Office", "noreply@passport.service.gov.uk");
      const msg = (t: Rng, when: number, body: string) =>
        notice(c, t, { from: hmpo, when, title: "Update on your passport application", body });
      return {
        text: "Preciso marcar o voo para Toronto no dia 3 de dezembro.",
        detail:
          "HM Passport Office wrote on 21 October 2026 that the new passport will only be sent by 11 December and the old one is cancelled, so Robin has no valid passport for a flight on 3 December.",
        hidden: msg(
          c.ta,
          at(10, 21, 7, 30),
          "Your application (received 9 October) needs more checks. We now expect to send your new passport by 11 December 2026.\n\nYour old passport was cancelled when we received it and cannot be used to travel.",
        ),
        decoy: msg(
          c.tb,
          at(10, 16, 7, 30),
          "Your application (received 9 October) is complete. Your new passport has been printed and sent by secure delivery; it should arrive within 2 working days.",
        ),
      };
    },
  },
  // Overlap: none ("expense" vs "reimbursed"). Decoy (c): personal-card bookings still allowed under a limit.
  // Phrasing: imperative. Source: slack.
  {
    name: "booking-tool-only",
    build: (c) => {
      const [fin, by] = c.colleagues(2);
      const say = (t: Rng, text: string) => chat(t, "general", [{ who: fin!, text, when: at(10, 20, 10, 2) }], by!);
      return {
        text: "Get me a return to Edinburgh on the 17th, I'll expense it.",
        detail: `${fin!.full} announced in #general on 20 October 2026 that from 1 November all train and flight bookings must go through TravelPerk; anything booked on a personal card will not be reimbursed.`,
        hidden: say(
          c.ta,
          "Travel change from 1 Nov: all train and flight bookings go through TravelPerk. Anything booked on a personal card after that won't be reimbursed, no exceptions, finance can't reconcile them",
        ),
        decoy: say(
          c.tb,
          "Travel reminder: TravelPerk stays optional until January. Train and flight bookings under £500 on a personal card are still reimbursed as normal",
        ),
      };
    },
  },
  // Overlap: a name only ("Porto"). Decoy (b): another event in the same city, other dates. Phrasing: imperative.
  // Source: drive. Anchored (18/11), silent (the organiser moved the dates in the doc).
  {
    name: "offsite-slipped-week",
    build: (c) => {
      const [owner] = c.colleagues(1);
      const title = "Leadership offsite — logistics";
      const body = (dates: string) =>
        `Location: Porto, Torel Avante\nDates: ${dates}\nTravel: book your own flights, arrive by 15:00 on day one\nOwner: ${owner!.full}`;
      return {
        text: "Book me the early flight to Porto on 18/11.",
        detail: `${owner!.full} changed the 'Leadership offsite — logistics' doc on 22 October 2026: the Porto offsite is now Wednesday 25 to Friday 27 November, not 18–20 November.`,
        before: doc(title, body("Wed 18 – Fri 20 Nov"), at(10, 5, 12, 0)),
        hidden: doc(title, body("Wed 25 – Fri 27 Nov (venue double-booked our first week)"), at(10, 22, 17, 25)),
        decoy: doc("Sales kick-off — logistics", body("Mon 18 – Wed 20 Jan 2027"), at(10, 22, 17, 25)),
      };
    },
  },
  // Overlap: none ("hire" vs "rental"). Decoy (a): an older note, licence renewed long ago. Phrasing: question
  // ("Should I…?"). Source: notes (rare). Rare.
  {
    name: "licence-with-dvla",
    build: () => ({
      text: "Should I hire a car for the week in Mallorca?",
      detail:
        "Robin's note 'Driving licence' (12 October 2026) says the photocard expired on 2 October and the old card went to the DVLA with the renewal, so there is nothing to show at a rental desk until the new one arrives.",
      hidden: rare(
        "notes",
        "Driving licence",
        "Photocard expired 2 Oct!! Renewal posted to DVLA 12 Oct with the photo from Snappy Snaps. They say up to 3 weeks. Old card went with the form, so nothing to show at a rental desk till the new one comes.",
        at(10, 12, 19, 0),
      ),
      decoy: rare(
        "notes",
        "Driving licence",
        "Photocard renewed, new one arrived 3 Sep, valid to 2036. Old one cut up. DVLA check code is in the passwords app if a rental desk asks.",
        at(9, 3, 19, 0),
      ),
    }),
  },

  // ── home ──
  // Overlap: none. Decoy (a): a lift repair notice for work already finished. Phrasing: statement of a plan.
  // Source: residents (rare). Rare, silent (the managing agent extended the dates in the posted notice).
  {
    name: "goods-lift-extended",
    build: () => {
      const title = "Goods lift — refurbishment";
      const notice = (end: string) =>
        `Notice to residents of Mercer Court\n\nThe goods lift (Lift 2) will be out of service from Monday 19 October to ${end} for refurbishment. The passenger lift cannot be used for furniture or removals. Please rebook any large items outside these dates.\n\nRendall & Rittner, on behalf of the freeholder`;
      return {
        text: "Going to get the new sofa delivered Saturday morning.",
        detail:
          "The residents' portal notice 'Goods lift — refurbishment' was changed on 22 October 2026: the goods lift is out of service until Friday 6 November (not 23 October), and the passenger lift cannot take furniture.",
        before: rare("residents", title, notice("Friday 23 October"), at(10, 5, 10, 0)),
        hidden: rare("residents", title, notice("Friday 6 November"), at(10, 22, 15, 30)),
        decoy: rare(
          "residents",
          "Passenger lift — repairs complete",
          "Notice to residents of Mercer Court\n\nThe passenger lift (Lift 1) repairs finished on 9 September and it is back in service. The goods lift is available for furniture and removals as usual.\n\nRendall & Rittner, on behalf of the freeholder",
          at(9, 9, 16, 0),
        ),
      };
    },
  },
  // Overlap: none ("hallway" vs "corridor"). Decoy (c): the test came back clear, so fixings are fine. Phrasing:
  // indirect ("I want to…"). Source: gmail.
  {
    name: "no-drilling-walls",
    build: (c) => {
      const ll = c.role("landlord", ["Steve", "Hargreaves"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: ll, when: at(10, 16, 18, 0), title: "Survey results", body });
      return {
        text: "I want to put a coat rack up in the hallway this weekend.",
        detail: `The landlord, ${ll.full}, wrote on 16 October 2026 that the textured coating on the corridor walls by the front door contains asbestos: no drilling, sanding or fixings there until the removal team comes in January.`,
        hidden: note(c.ta, [
          "One thing from the survey: the textured coating on the corridor walls by the front door has asbestos in it.",
          "Please don't drill, sand or put any fixings into those walls until the removal team have been in January. The rest of the flat is fine.",
        ]),
        decoy: note(c.tb, [
          "Good news from the survey: the sample from the textured coating on the corridor walls by the front door came back clear, no asbestos.",
          "So feel free to put up whatever you like on those walls. The rest of the flat is fine too.",
        ]),
      };
    },
  },
  // Overlap: none. Decoy (a): the tree work was postponed. Phrasing: statement of a plan. Source: whatsapp (rare).
  // Rare.
  {
    name: "bays-suspended",
    build: () => {
      const msg = (first: string, second: string) =>
        rare(
          "whatsapp",
          "Neighbours",
          chatText([
            { who: "Rasa Petrauskaitė", text: first, at: at(10, 24, 9, 40) },
            { who: "Dev Shah", text: second, at: at(10, 24, 9, 52) },
          ]),
          at(10, 24, 9, 52),
          { people: "Rasa Petrauskaitė; Dev Shah" },
        );
      return {
        text: "I'll leave the car out front on Wednesday night.",
        detail:
          "In the Neighbours WhatsApp group on 24 October 2026, Rasa passed on the council letter: the bays on their road are suspended from 6am on Thursday 29 October for tree work and any car left there will be towed.",
        hidden: msg(
          "council letter came: tree surgeons are doing our side of the road Thursday 29th from 7am. bays suspended from 6am, anything still parked gets towed 😬",
          "thanks Rasa, moving the van the night before then",
        ),
        decoy: msg(
          "update from the council: the tree work on our side of the road is postponed to the new year, bays back to normal 👍",
          "thanks Rasa, the van can stay put then",
        ),
      };
    },
  },
  // Overlap: none. Decoy (b): another trip away on another Friday. Phrasing: imperative. Source: calendar.
  // Anchored (Friday 30th vs 30/10).
  {
    name: "away-on-delivery-day",
    build: () => {
      const trip = (title: string, when: string, start: number, where: string, notes: string) =>
        event({ title, start, when, where, notes, edited: at(10, 2, 12, 0) });
      return {
        text: "Order the new fridge for delivery on Friday 30th.",
        detail:
          "The calendar has Robin away all day on Friday 30 October 2026 at the Product Leaders Summit in Manchester (06:40 train from Euston, back about 21:30), so nobody is home for a delivery.",
        hidden: trip(
          "Product Leaders Summit (Manchester)",
          "30/10, all day",
          at(10, 30, 6, 40),
          "Manchester Central",
          "Train 06:40 from Euston, back about 21:30. Badge collection from 08:30.",
        ),
        decoy: trip(
          "Partner Summit (Birmingham)",
          "13/11, all day",
          at(11, 13, 6, 40),
          "ICC Birmingham",
          "Train 06:40 from Euston, back about 21:30. Badge collection from 08:30.",
        ),
      };
    },
  },
  // Overlap: none ("damp patch" vs "water damage"). Decoy (c): the inspection is done and repairs may go ahead.
  // Phrasing: statement of a plan. Source: gmail.
  {
    name: "wait-for-adjuster",
    build: (c) => {
      const adj: Who = { full: "Hannah Briggs", first: "Hannah", email: "hannah.briggs@crawfordclaims.co.uk" };
      const note = (t: Rng, when: number, body: string[]) =>
        mail(c, t, { from: adj, when, title: "Claim HO-4471820", body, corporate: true });
      return {
        text: "I'm going to paint over the damp patch on Saturday.",
        detail:
          "Hannah Briggs, the insurer's loss adjuster, wrote on 21 October 2026 that she inspects the water damage on Friday 6 November and nothing should be repaired or redecorated before then, or the claim (HO-4471820) may be reduced.",
        hidden: note(c.ta, at(10, 21, 11, 10), [
          "Thank you for the photos of the water damage to the ceiling.",
          "I'll inspect on Friday 6 November between 10 and 12. Until then, please don't repair or redecorate the affected area: we need to see the damage as it is, or the claim may be reduced.",
        ]),
        decoy: note(c.tb, at(10, 21, 11, 10), [
          "Thank you for letting me inspect the water damage to the ceiling this morning.",
          "I have everything I need, so you're free to go ahead with repairs and redecoration whenever suits you.",
        ]),
      };
    },
  },

  // ── admin ──
  // Overlap: the notice reference only. Decoy (b): another notice on hold. Phrasing: imperative. Source: gmail
  // (notification). Anchored.
  {
    name: "challenge-on-hold",
    build: (c) => {
      const council = bot("Islington Parking Services", "parking@islington.gov.uk");
      const pcn = (t: Rng, no: string) =>
        notice(c, t, {
          from: council,
          when: at(10, 15, 14, 5),
          title: "We have received your challenge",
          body: `Penalty Charge Notice ${no} (vehicle LB19 XKT)\n\nWe have received your informal challenge and put the charge on hold while we consider it. You do not need to pay now. If you pay, the case will be closed and we will not consider your challenge. We will reply within 28 days.`,
        });
      return {
        text: "Settle IS40018322 today, before it doubles.",
        detail:
          "Islington Parking Services confirmed on 15 October 2026 that the challenge to IS40018322 was received and the charge is on hold; paying now closes the case without considering the challenge.",
        hidden: pcn(c.ta, "IS40018322"),
        decoy: pcn(c.tb, "IS40017905"),
      };
    },
  },
  // Overlap: none. Decoy (a): last year's return, filed in January. Phrasing: indirect ("Ik moet…"), Dutch.
  // Source: gmail. Non-English (Dutch).
  {
    name: "aangifte-al-gedaan",
    build: (c) => {
      const acc = c.role("accountant", ["Owen", "Price"]);
      const note = (t: Rng, when: number, body: string[]) =>
        mail(c, t, { from: acc, when, title: "Your tax return", body, corporate: true });
      return {
        text: "Ik moet mijn belastingaangifte nog indienen voor januari, kun je die klaarzetten?",
        detail: `${acc.full}, the accountant, wrote on 21 October 2026 that he already filed the 2025-26 self assessment with HMRC and Robin must not file one too; only the £1,846.20 balance is due by 31 January.`,
        hidden: note(c.ta, at(10, 21, 16, 0), [
          "Just to confirm I filed your 2025-26 return with HMRC today; the acknowledgement is attached.",
          "You don't need to do anything else, and please don't submit one yourself: a second filing is treated as an amendment and makes a mess.",
          "Balance to pay by 31 January: £1,846.20.",
        ]),
        decoy: note(c.tb, at(1, 27, 16, 0), [
          "Just to confirm I filed your 2024-25 return with HMRC today; the acknowledgement is attached.",
          "You don't need to do anything else for that year.",
          "Balance to pay by 31 January: £1,212.40.",
        ]),
      };
    },
  },
  // Overlap: one topic word ("Figma"). Decoy (a): the move was called off. Phrasing: question ("Can you…?").
  // Source: slack.
  {
    name: "design-tool-sunset",
    build: (c) => {
      const [ops, by] = c.colleagues(2);
      const say = (t: Rng, text: string) => chat(t, "ops", [{ who: ops!, text, when: at(10, 16, 12, 30) }], by!);
      return {
        text: "Can you extend our Figma plan for 2027?",
        detail: `${ops!.full} said in #ops on 16 October 2026 that design moves to Penpot at the end of November and nobody should renew Figma seats; they lapse on 30 November.`,
        hidden: say(
          c.ta,
          "heads up: design is moving to Penpot at the end of Nov, so please don't renew any Figma seats. they lapse on their own on 30 Nov",
        ),
        decoy: say(
          c.tb,
          "heads up: the Penpot move is off, design is staying where it is. renew Figma seats as normal when the reminder comes",
        ),
      };
    },
  },
  // Overlap: none. Decoy (b): the contractors' page, another group. Phrasing: statement of a plan. Source: drive.
  // Silent (finance changed the cut-off in the how-to doc).
  {
    name: "claims-cutoff-early",
    build: (c) => {
      const [fin] = c.colleagues(1);
      const title = "Expenses — how to claim";
      const tail = `\nPaid with the following month's salary.\nOwner: Finance (${fin!.full})`;
      return {
        text: "I'll submit my receipts from the Leeds trip on Friday.",
        detail: `The 'Expenses — how to claim' doc was changed on 21 October 2026 (owner ${fin!.full}): October's cut-off is Wednesday 28 October at 5pm; anything after that is paid at the end of December, not November.`,
        before: doc(
          title,
          `Submit in Expensify by 5pm on the last working day of the month, with a photo of each itemised slip.${tail}`,
          at(9, 1, 9, 0),
        ),
        hidden: doc(
          title,
          `Submit in Expensify by 5pm on the last working day of the month, with a photo of each itemised slip.\nOctober only (year-end close): cut-off is Wed 28 Oct at 5pm. Anything later is paid at the end of December, not November.${tail}`,
          at(10, 21, 16, 45),
        ),
        decoy: doc(
          `${title} (contractors)`,
          `Contractors invoice monthly instead of using Expensify.\nOctober only (year-end close): invoices by Wed 28 Oct at 5pm. Anything later is paid at the end of December, not November.\nOwner: Finance (${fin!.full})`,
          at(10, 21, 16, 45),
        ),
      };
    },
  },
  // Overlap: a name only. Decoy (b): the same note on another client's contact. Phrasing: imperative. Source: crm
  // (contact). Anchored.
  {
    name: "signatory-left",
    build: (c) => {
      const [p] = c.clients(1);
      const q = otherClient(c, p!);
      const contact = (x: Person): Plant => ({
        sourceId: "crm",
        kind: "contact",
        title: x.full,
        text: `Contact: ${x.full}\nTitle: ${x.title ?? "Head of Procurement"}\nCompany: ${orgOf(x)}\nEmail: ${x.email}\nLifecycle: former contact\nNote (${c.user.full}, 16 Oct 2026): left ${orgOf(x)} last week. New signatory for contracts is Harriet Osei (Legal). Old mailbox is not monitored.`,
        updatedAt: at(10, 16, 9, 50),
      });
      return {
        text: `Send the renewal paperwork to ${p!.nick ?? p!.first} for signature.`,
        detail: `The CRM contact for ${p!.full} notes (16 October 2026) that they have left ${orgOf(p!)}; contracts now go to Harriet Osei in Legal and the old mailbox is not monitored.`,
        hidden: contact(p!),
        decoy: contact(q),
      };
    },
  },

  // ── social ──
  // Overlap: a name only. Decoy (a): the allergy turned out to be a false positive. Phrasing: imperative, Hindi in
  // Latin script. Source: gmail. Non-English (Hindi).
  {
    name: "khana-allergy",
    build: (c) => {
      const fr = c.role("friend", ["Leila", "Haddad"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: fr, when: at(10, 19, 20, 15), title: "Allergy saga", body });
      return {
        text: `Saturday ko ${fr.first} ke saath Hoppers mein dinner book kar do.`,
        detail: `${fr.full} wrote on 19 October 2026 that tests confirmed a serious coconut and cashew allergy (she carries an EpiPen) and anywhere that cooks with coconut is off for her, which rules out a Sri Lankan place like Hoppers.`,
        hidden: note(c.ta, [
          "Finally got the test results back: it's coconut and cashews, properly, the EpiPen kind.",
          "So I'm being really boring about where we eat for now: anywhere that cooks with coconut is off for me.",
        ]),
        decoy: note(c.tb, [
          "Finally got the test results back: the coconut and cashew one was a false positive, the specialist says.",
          "So I'm back to eating everything, no EpiPen needed. Celebrate with me somewhere good?",
        ]),
      };
    },
  },
  // Overlap: a name only. Decoy (b): another friend's party, another date. Phrasing: question ("Should I…?").
  // Source: calendar. Anchored (Saturday vs 31/10), silent (the host edited the invite).
  {
    name: "grown-ups-only-now",
    build: (c) => {
      const bf = c.role("best friend", ["Jamie", "Fox"]);
      const fr = c.role("friend", ["Leila", "Haddad"]);
      const title = `${bf.first}'s housewarming`;
      const where = "41 Lordship Lane";
      return {
        text: `Should I bring Maya along to ${bf.first}'s on Saturday?`,
        detail: `${bf.full} edited the housewarming invite on 25 October 2026: it is now Saturday 31 October from 19:30 and grown-ups only (it was 15:00 with kids welcome).`,
        before: event({
          title,
          start: at(10, 31, 15),
          when: "31/10, 15:00–19:00",
          where,
          notes: "Kids welcome, there'll be a bouncy castle in the garden. Bring a bottle!",
          edited: at(10, 6, 21, 0),
        }),
        hidden: event({
          title,
          start: at(10, 31, 19, 30),
          when: "31/10, 19:30 till late",
          where,
          notes: "Grown-ups only now, sorry! The garden's a building site. Bring a bottle!",
          edited: at(10, 25, 22, 15),
        }),
        decoy: event({
          title: `${fr.first}'s 40th`,
          start: at(11, 21, 19, 30),
          when: "21/11, 19:30 till late",
          where: "The Albion, Thornhill Rd",
          notes: "Grown-ups only, sorry! Upstairs room. Bring a bottle!",
          edited: at(10, 25, 22, 15),
        }),
      };
    },
  },
  // Overlap: one topic word ("birthday"). Decoy (c): she changed her mind and wants a night out. Phrasing: question
  // ("Can you…?"). Source: gmail. Anchored (Friday vs the 30th).
  {
    name: "no-fuss-please",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: sis, when: at(10, 22, 22, 5), title: "the 30th", body });
      return {
        text: `Can you book a table at Barrafina Friday for ${sis.first}'s birthday?`,
        detail: `${sis.full} wrote on 22 October 2026 asking for no fuss for her birthday on the 30th: no restaurant, just cake at Mum's on Sunday.`,
        hidden: note(c.ta, [
          "About my birthday: please, please no fuss this year. I really don't want a restaurant thing, I'm exhausted.",
          "Just come to Mum's on Sunday for cake, that's all I want.",
        ]),
        decoy: note(c.tb, [
          "About my birthday: ignore what I said about no fuss, I've changed my mind.",
          "I'd love a proper night out on the 30th, you pick the place!",
        ]),
      };
    },
  },
  // Overlap: none. Decoy (a): an earlier closure that ended. Phrasing: indirect ("Thinking of…"). Source: residents
  // (rare). Rare.
  {
    name: "terrace-closed-winter",
    build: () => ({
      text: "Thinking of having friends round for drinks up top on Saturday 14th.",
      detail:
        "A residents' portal notice of 19 October 2026 says the Mercer Court roof terrace is closed from Monday 9 November until March 2027 for membrane works, with bookings cancelled and the door locked.",
      hidden: rare(
        "residents",
        "Roof terrace closure",
        "Notice to residents of Mercer Court\n\nThe roof terrace will be closed from Monday 9 November until March 2027 while the waterproof membrane is replaced. All bookings in that period have been cancelled and the access door will be locked.\n\nRendall & Rittner, on behalf of the freeholder",
        at(10, 19, 14, 0),
      ),
      decoy: rare(
        "residents",
        "Roof terrace reopened",
        "Notice to residents of Mercer Court\n\nThe roof terrace reopened on 10 September after deep cleaning. Bookings are open through the portal as usual.\n\nRendall & Rittner, on behalf of the freeholder",
        at(9, 10, 14, 0),
      ),
    }),
  },
  // Overlap: a name only. Decoy (c): the extension fell through, so the last day stands. Phrasing: indirect
  // ("Let's…"). Source: slack. Anchored.
  {
    name: "last-day-pushed",
    build: (c) => {
      const [col, hr, by] = c.colleagues(3);
      const name = col!.nick ?? col!.first;
      const say = (t: Rng, text: string) =>
        chat(t, "partnerships", [{ who: hr!, text, when: at(10, 23, 11, 40) }], by!);
      return {
        text: `Let's do ${name}'s leaving drinks this Thursday.`,
        detail: `${hr!.full} said in #partnerships on 23 October 2026 that ${col!.full}'s last day is now Friday 27 November (staying on for the Q4 handover), so this Thursday is early.`,
        hidden: say(
          c.ta,
          `small update: ${name}'s last day is now Fri 27 Nov, they've agreed to stay on for the Q4 handover. farewell plans TBC nearer the time`,
        ),
        decoy: say(
          c.tb,
          `small update: the Q4 handover extension for ${name} didn't work out, so last day stays Fri 30 Oct. farewell plans still on`,
        ),
      };
    },
  },
];

/** Templates whose request names one person, thing or date the planted item words differently. */
export const HELDOUT19_ANCHORED: readonly string[] = [
  "figures-wait-for-countersign",
  "onsite-runs-later",
  "kollege-umzug",
  "swim-not-gym",
  "party-at-ten",
  "physio-moved-early",
  "payee-mismatch",
  "card-cancelled",
  "itinerary-new-airport",
  "offsite-slipped-week",
  "away-on-delivery-day",
  "challenge-on-hold",
  "signatory-left",
  "grown-ups-only-now",
  "no-fuss-please",
  "last-day-pushed",
];
/** Templates whose planted item (both variants) sits in a rare source (RARE_SOURCES). */
export const HELDOUT19_RARE: readonly string[] = [
  "swim-not-gym",
  "regalo-spa",
  "kidney-painkillers",
  "jab-already-booked",
  "knee-no-load",
  "payee-mismatch",
  "risparmi-bloccati",
  "itinerary-new-airport",
  "licence-with-dvla",
  "goods-lift-extended",
  "bays-suspended",
  "terrace-closed-winter",
];
/** Templates whose fact is a silent edit at the source (their Spec has `before`). */
export const HELDOUT19_SILENT: readonly string[] = [
  "onsite-runs-later",
  "rota-swapped",
  "physio-moved-early",
  "jab-already-booked",
  "bill-already-moved",
  "itinerary-new-airport",
  "offsite-slipped-week",
  "goods-lift-extended",
  "claims-cutoff-early",
  "grown-ups-only-now",
];
/** Templates whose request is not in English (name the language in the template's comment). */
export const HELDOUT19_NON_ENGLISH: readonly string[] = [
  "kollege-umzug",
  "regalo-spa",
  "verre-jeudi",
  "risparmi-bloccati",
  "passaporte-atrasado",
  "aangifte-al-gedaan",
  "khana-allergy",
];
/** Templates whose request is indirect or a question ("Should I…", "I need to…", "We should…", "Can we…?"). */
export const HELDOUT19_INDIRECT: readonly string[] = [
  "figures-wait-for-countersign",
  "freeze-over-month-end",
  "kollege-umzug",
  "account-on-hold",
  "swim-not-gym",
  "regalo-spa",
  "rota-swapped",
  "pass-already-given",
  "kidney-painkillers",
  "verre-jeudi",
  "jab-already-booked",
  "knee-no-load",
  "risparmi-bloccati",
  "allowance-used-up",
  "bill-already-moved",
  "itinerary-new-airport",
  "passaporte-atrasado",
  "licence-with-dvla",
  "goods-lift-extended",
  "no-drilling-walls",
  "bays-suspended",
  "wait-for-adjuster",
  "aangifte-al-gedaan",
  "design-tool-sunset",
  "claims-cutoff-early",
  "grown-ups-only-now",
  "no-fuss-please",
  "terrace-closed-winter",
  "last-day-pushed",
];

/** Each silent-change template's `before` item, for a days harness (same RNG draws as the planting function). */
export function heldout19Before(world: World, seed: number): { template: string; before: Plant }[] {
  return build(world, seed).flatMap(({ name, spec }) => (spec.before ? [{ template: name, before: spec.before }] : []));
}

/** Build every template's spec, in order, with the suite's own streams (no world change). */
function build(world: World, seed: number): { name: string; spec: Spec }[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 1_919);
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
export function plantHeldout19(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  addRareSources(world, seed);
  const suite = variant === "hidden" ? "heldout19" : `heldout19-${variant}`;
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

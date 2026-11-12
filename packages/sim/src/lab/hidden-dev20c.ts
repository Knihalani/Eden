/**
 * Tuning suite dev20c (F8, a dev20 tuning set; not held out: tune on it), written by an isolated author. Flavour:
 * money and home (payroll dates, closed periods, purchase-order limits, estates, guarantees, insurance pre-approval,
 * ISAs and Premium Bonds, deposits and balances, excess cover, water shut-offs, supply upgrades, mortgage terms,
 * parking zones, bulky waste, registries and split bills).
 *
 * 40 templates, five in each life area (work, family, health, money, travel, home, admin, social, in that order).
 * Each is a request the user types (it does not name the hidden context), the consideration a good answer raises, a
 * planted item stating it (variant `hidden`) and a near-miss look-alike that does not apply (`control`); `neutral`
 * plants nothing. Request and detail are the same in every variant.
 *
 * Counts, from the comment above each template:
 * - overlap: none 27, name 7, topic-word 6.
 * - decoys: (a) resolved/expired/superseded 13, (b) other entity or date 14, (c) condition met 13.
 * - phrasing: imperative 12, plan or statement 18, question 10 (INDIRECT 28, QUESTION 10).
 * - languages: English 30; French 2, Portuguese (European), Spanish, Norwegian, Finnish, Hungarian, Catalan, Malay,
 *   Swahili 1 each.
 * - anchored 14.
 * - rare 12: bank 3, trips 2, residents 2, notes 1, whatsapp 1, health 1, school 1, tasks 1.
 * - silent 10: calendar 3, drive 3, notes 1, trips 1, residents 1, tasks 1.
 * - sources of the other 28: drive 8, gmail notifications 7, gmail mail 4, calendar 4, slack 4, crm 1 (gmail 11).
 * - world knowledge 7: sister-guarantor (a rent guarantee is a liability a remortgage underwriter cares about),
 *   inhaler-collect (a lapsed prepayment certificate means paying per item), lisa-car (25% Lifetime ISA withdrawal
 *   charge), bonus-premium-bonds (£50,000 holding limit), jetski-tenerife (a jet ski is motorised watercraft),
 *   ev-charger (a 7kW charger is a large continuous load on a 60A supply), airbnb-room (short lets are letting under
 *   the mortgage terms).
 *
 * World time is Tuesday 27 October 2026, 09:00 UTC. Weekdays checked with Date.UTC: Fri 25 Sep, Fri 23 Oct,
 * Wed 28 Oct, Thu 29 Oct, Fri 30 Oct, Sat 31 Oct, Mon 2 Nov, Tue 3 Nov, Wed 4 Nov, Thu 5 Nov, Fri 6 Nov, Sat 7 Nov,
 * Sun 8 Nov, Thu 12 Nov, Fri 13 Nov, Sat 14 Nov, Thu 19 Nov, Fri 20 Nov, Sat 21 Nov, Mon 23 Nov, Fri 27 Nov,
 * Mon 30 Nov, Tue 1 Dec, Fri 4 Dec, Fri 11 Dec, Fri 18 Dec.
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
   * Silent-change templates only (DEV20C_SILENT): the planted item as it read before someone edited it at the
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

// The 40 templates. Each is preceded by its labels (overlap, decoy kind, phrasing, source, anchored, silent, rare,
// knowledge, language), wrapped over two comment lines to fit 120 columns.
const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  // overlap: topic-word · decoy: (a) resolved/expired/superseded · phrasing: plan · source: slack (chat) ·
  // anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "rsu-sale-monday",
    build: (c) => {
      const [legal, by] = c.colleagues(2);
      return {
        text: "Planning to sell my vested RSUs on Monday",
        detail:
          "Monday 2 November falls inside the Q3 closed period announced by legal (2 Nov to 20 Nov inclusive, results " +
          "on 19 Nov): no one may deal in company stock, vested shares included, so the sale has to wait until the " +
          "window reopens on 23 November.",
        hidden: chat(
          c.ta,
          "announcements",
          [
            {
              who: legal!,
              text:
                "Reminder from Legal: the Q3 closed period starts 2 Nov and runs to 20 Nov inclusive (results are out " +
                `on 19 Nov). During it nobody may deal in company stock, ${c.ta.pick(["including", "and that covers"])} ` +
                "vested shares and ESPP. Pre-clearance requests will be declined. The window reopens 23 Nov.",
              when: at(10, 26, 16, 5),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "announcements",
          [
            {
              who: legal!,
              text:
                "Legal update: the Q2 closed period ended today. The dealing window is open until 30 Sep for anyone " +
                `who ${c.tb.pick(["wants", "needs"])} to sell vested shares; pre-clearance as usual.`,
              when: at(7, 30, 11, 20),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: imperative · source: slack (chat) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: French
  {
    name: "monitors-po",
    build: (c) => {
      const [fin, by] = c.colleagues(2);
      const n = c.r.int(14, 18);
      const price = c.r.pick([389, 415, 449]);
      const total = (n * price).toLocaleString("en-GB");
      return {
        text: `Fais une demande d'achat pour ${n} écrans pour l'équipe`,
        detail:
          `${n} monitors at the catalogue price of £${price} come to about £${total}, over the new £5,000 limit: ` +
          "since 1 November such a purchase order needs CFO approval in Coupa on top of the budget holder's " +
          "(allow about 5 working days).",
        hidden: chat(
          c.ta,
          "finance",
          [
            {
              who: fin!,
              text:
                "From 1 Nov any PO over £5,000 inc. VAT needs CFO sign-off in Coupa as well as the budget holder. " +
                `Allow ${c.ta.pick(["5", "five"])} working days. Under that it's budget holder only.`,
              when: at(10, 22, 14, 10),
            },
            {
              who: fin!,
              text: `(fyi the Dell 27" monitors on the IT catalogue are £${price} each)`,
              when: at(10, 22, 14, 12),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "finance",
          [
            {
              who: fin!,
              text:
                "Update: for IT hardware bought from the catalogue the PO approval threshold is now £25,000, budget " +
                `holder only, no CFO step. ${c.tb.pick(["Enjoy", "Should speed things up"])}.`,
              when: at(10, 22, 14, 10),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: drive (doc) ·
  // anchored: no · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "builder-deposit-payday",
    build: (c) => {
      const table = (nov: string, dec: string) =>
        "UK monthly staff. Owner: People Ops.\n\n" +
        "Month | Pay date | Cut-off for changes\n" +
        "September | Fri 25 Sep | 14 Sep\n" +
        "October | Fri 23 Oct | 12 Oct\n" +
        `November | ${nov} | 12 Nov\n` +
        `December | ${dec} | 7 Dec\n\n` +
        "Salaries reach most bank accounts by 07:00. Questions to payroll@ (not your manager).";
      return {
        text: "Remind me to send the builder his deposit the day I get paid",
        detail:
          "The payroll calendar was quietly updated: November salary now lands on Tuesday 1 December (payroll " +
          "provider migration), not Friday 27 November, so the reminder belongs on 1 December.",
        hidden: doc(
          "Payroll calendar 2026",
          table("Tue 1 Dec *", "Fri 18 Dec") + "\n* moved: provider migration (ADP to Rippling)",
          at(10, 21, 15, 40),
        ),
        decoy: doc(
          "Payroll calendar 2026",
          table("Fri 27 Nov", "Fri 18 Dec *") +
            `\n* ${c.tb.pick(["early", "brought forward"])} for the Christmas close`,
          at(10, 21, 15, 40),
        ),
        before: doc("Payroll calendar 2026", table("Fri 27 Nov", "Fri 18 Dec"), at(1, 12, 10, 0)),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: drive (doc) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: Norwegian
  {
    name: "wedding-shoots-weekends",
    build: (c) => {
      const clause =
        "12. Outside interests. During your employment you must not, without the prior written consent of the " +
        "Company, be engaged or concerned in any other business, trade or occupation, whether remunerated or not. " +
        "Requests go to your line manager and HR.";
      return {
        text: "Tenker å begynne å ta bryllupsoppdrag som fotograf i helgene for litt ekstra penger",
        detail:
          "The user's employment contract (clause 12, outside interests) bars any other business or occupation, paid " +
          "or not, without the company's prior written consent, so weekend wedding photography needs written approval " +
          "from the line manager and HR first.",
        hidden: doc(
          `Employment contract — ${c.user.full}`,
          `Start date: 6 March 2023. Notice: ${c.ta.pick(["one month", "two months"])}.\n\n` +
            "11. Holidays. 27 days plus bank holidays.\n" +
            clause +
            "\n13. Confidentiality. Survives termination.",
          at(3, 6, 10, 0, 2023),
        ),
        decoy: doc(
          `Employment contract — ${c.user.full} (previous employer)`,
          "Initech Ltd. This agreement terminated on 31 January 2023; kept for reference.\n\n" +
            clause.replace("12.", c.tb.pick(["9.", "10."])),
          at(2, 1, 10, 0, 2023),
        ),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: imperative · source: crm (deal) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "invoice-client-october",
    build: (c) => {
      const [client] = c.clients(1);
      const other = otherClient(c, client!);
      const po = c.r.int(10_000, 99_999);
      const account = (p: Person, t: Rng, billing: string) => ({
        sourceId: "crm",
        kind: "deal" as ItemKind,
        title: `${orgOf(p)} — Account`,
        text:
          `Account: ${orgOf(p)}\nOwner: ${c.user.full}\nBilling contact: ${p.full}\nPayment terms: ` +
          `${t.pick(["45", "60"])} days\nBilling notes: ${billing}`,
        updatedAt: at(10, 21, 11, 30),
      });
      return {
        text: `Send ${orgOf(client!)} the invoice for October's work today`,
        detail:
          `${orgOf(client!)}'s accounts-payable portal rejects invoices without a valid PO, and their current PO ` +
          `4500-${po} ran out on 20 October; a new PO requested from ${client!.full} has not been issued yet, so the ` +
          "invoice should wait for the new PO number.",
        hidden: account(
          client!,
          c.ta,
          `invoices must quote a PO; AP portal (Coupa) rejects any without one. PO 4500-${po} exhausted 20 Oct. New ` +
            `PO requested from ${client!.full} 21 Oct, not issued yet.`,
        ),
        decoy: account(
          other,
          c.tb,
          `invoices must quote a PO; AP portal rejects any without one. Current PO 4500-${po + 7} valid to 31 Mar.`,
        ),
      };
    },
  },
  // ── family ──
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: bank (notification) ·
  // anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "maya-pocket-money",
    build: (c) => {
      const amt = c.r.pick([10, 15, 20]);
      const card = c.r.int(1000, 9999);
      return {
        text: "Send Maya her pocket money for this week",
        detail:
          `A £${amt} standing order to Maya's junior card already goes out every Friday (next on 30 October), so ` +
          "sending it by hand would pay her twice.",
        hidden: rare(
          "bank",
          "Scheduled payments",
          `Upcoming\nEvery Friday · £${amt}.00 · to M ${c.user.last} (Junior card ••${card}) · Ref ALLOWANCE · next ` +
            `30 Oct\nMonthly · £${c.ta.pick(["10.99", "12.99"])} · to Spotify · next 3 Nov\nMonthly · £1,240.00 · ` +
            "to Nationwide BS · next 1 Nov",
          at(10, 24, 8, 0),
        ),
        decoy: rare(
          "bank",
          "Standing order cancelled",
          `You cancelled your standing order of £${amt}.00 every Friday to M ${c.user.last} (Junior card ` +
            `••${card}). No further payments will be made. ${c.tb.pick(["", "Cancelled in the app."])}`,
          at(6, 14, 19, 0),
        ),
      };
    },
  },
  // overlap: name · decoy: (c) condition met · phrasing: plan · source: gmail (mail) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "grandma-savings-split",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const sol: Who = {
        full: "Harriet Moss",
        first: "Harriet",
        email: "h.moss@mossandgrey.co.uk",
        title: "Associate, Private Client",
        company: "Moss & Grey Solicitors",
      };
      return {
        text: `I'll split grandma's savings between me and ${sis.first} this weekend`,
        detail:
          "The estate solicitor (Harriet Moss) asked that nothing from the late Margaret's estate be distributed until " +
          "the grant of probate (expected early December); sharing the money out now could leave the user personally " +
          "liable if a claim or tax bill comes in.",
        hidden: mail(c, c.ta, {
          from: sol,
          when: at(10, 20, 15, 30),
          title: `Estate of the late Margaret ${c.user.last}`,
          corporate: true,
          body: [
            `As executors, please don't move or share out any funds from Margaret's accounts yet, even between you and ${sis.first}.`,
            "We are still waiting on the grant of probate, which we now expect in early December.",
            "Any distribution before then could leave you personally liable if a claim or an inheritance tax bill comes in.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: sol,
          when: at(10, 20, 15, 30),
          title: `Estate of the late Margaret ${c.user.last}`,
          corporate: true,
          body: [
            "Good news: the grant of probate was issued on 19 October.",
            `You and ${sis.first} are now free to distribute the funds as set out in the will.`,
            c.tb.pick(["Our final bill will follow.", "We will send the estate accounts separately."]),
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: gmail (mail) ·
  // anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "sister-guarantor",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const broker: Who = {
        full: "Priya Nair",
        first: "Priya",
        email: "priya.nair@harbourmortgages.co.uk",
        title: "Mortgage adviser",
        company: "Harbour Mortgages",
      };
      return {
        text: `Is it fine to just sign as guarantor on ${sis.first}'s new flat?`,
        detail:
          "The user's remortgage is in underwriting until about 4 December and the broker (Priya Nair) asked them to " +
          "take on no further financial commitments before completion; a rent guarantee is a liability lenders ask " +
          "about, so check with the broker before signing.",
        hidden: mail(c, c.ta, {
          from: broker,
          when: at(10, 19, 10, 15),
          title: "Remortgage — with underwriting",
          corporate: true,
          body: [
            "Your remortgage application is now with the lender's underwriters, target completion 4 December.",
            "Until it completes, please don't take on any further credit, loans or financial commitments of any kind.",
            "Lenders re-check before releasing funds, so tell me first about any change in your circumstances.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: broker,
          when: at(4, 9, 10, 15),
          title: "Remortgage — completed",
          corporate: true,
          body: [
            "Your remortgage completed this morning and the new rate is live.",
            c.tb.pick(["Nothing further is needed from you.", "No further action needed on your side."]),
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: imperative · source: notes (doc) ·
  // anchored: no · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "standing-desk",
    build: (c) => {
      const price = c.r.int(54, 79) * 10;
      const rules = (cap: string) =>
        "Joint account rules (agreed on the sofa, Sun)\n" +
        "- bills + mortgage go out on the 1st\n" +
        "- groceries cap £450/mo\n" +
        `- anything over ${cap} from joint → ask each other first\n` +
        "- holiday pot £100/mo\n" +
        "- own money is own money";
      return {
        text: `Order the £${price} standing desk for the spare room`,
        detail:
          "The household money note now says anything over £250 from the joint account needs checking with the " +
          `partner first (it said £1,000 until a recent edit), so the £${price} desk needs that conversation unless ` +
          "it comes from the user's own account.",
        hidden: rare("notes", "Money — us", rules("£250"), at(10, 25, 21, 10)),
        decoy: rare("notes", "Money — us", rules("£1,000") + c.tb.pick(["", "\n- review in Jan"]), at(10, 25, 21, 10)),
        before: rare("notes", "Money — us", rules("£1,000"), at(5, 3, 20, 0)),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: plan · source: school (mail) ·
  // anchored: no · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "austria-trip-balance",
    build: (c) => {
      const bal = c.r.int(38, 46) * 10;
      return {
        text: "I'll sort out the rest of Maya's Austria trip money at the end of the month",
        detail:
          `The final balance (£${bal}) for Maya's Year 9 Innsbruck ski residential is due by Friday 6 November via ` +
          "ParentPay, before month-end; places still unpaid then go to the waiting list.",
        hidden: rare(
          "school",
          "Year 9 Innsbruck ski residential — final balance",
          `Dear Parent/Carer of Maya ${c.user.last},\n\nThe final balance of £${bal} for the Year 9 Innsbruck ski ` +
            "residential (14–20 February) is due by Friday 6 November via ParentPay. Places with an unpaid balance " +
            "after this date will be offered to the waiting list. Kit list and EHIC/GHIC reminder to follow.\n\n" +
            `${c.ta.pick(["Mr J. Ellis, Head of Year 9", "Mrs R. Ahmed, Trips Coordinator"])}`,
          at(10, 16, 13, 0),
        ),
        decoy: rare(
          "school",
          "Year 7 Brecon outdoor centre — deposit",
          "Dear Parents/Carers of Year 7,\n\nA deposit of £50 for the Year 7 Brecon outdoor centre residential is due " +
            "by Friday 4 December via ParentPay.\n\n" +
            `${c.tb.pick(["Miss K. Doyle, Head of Year 7", "Mrs R. Ahmed, Trips Coordinator"])}`,
          at(10, 16, 13, 0),
        ),
      };
    },
  },
  // ── health ──
  // overlap: none · decoy: (c) condition met · phrasing: imperative · source: gmail (notification) ·
  // anchored: yes · silent: no · rare: no · knowledge: no · language: Portuguese
  {
    name: "knee-mri",
    build: (c) => {
      const from = bot("Bupa Claims", "claims@notifications.bupa.co.uk");
      const auth = c.r.int(100000, 999999);
      return {
        text: "Marca a ressonância ao joelho para quinta-feira",
        detail:
          "The health insurer has not authorised the knee MRI yet: it needs a GP or consultant referral letter " +
          "first, and a scan booked before authorisation won't be covered.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 23, 12, 0),
          title: "Your pre-authorisation request: more information needed",
          body:
            "Treatment: MRI, right knee\nStatus: Not yet authorised\n\nWe need a referral letter from your GP or " +
            "consultant before we can authorise this. Until it is authorised, any scan you book will not be covered " +
            `under your policy. ${c.ta.pick(["Upload the letter in the app.", "Send the letter via My Bupa."])}`,
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 23, 12, 0),
          title: "Your pre-authorisation request: approved",
          body:
            `Treatment: MRI, right knee\nStatus: Authorised\nAuthorisation code: ${auth}\nValid until: 30 November ` +
            `2026\n\n${c.tb.pick(["Quote the code when you book.", "Give this code to the hospital when booking."])}`,
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: gmail (notification) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: Finnish
  {
    name: "gym-from-monday",
    build: (c) => {
      const from = bot("PureGym", "hello@puregym.com");
      return {
        text: "Aion alkaa käydä salilla taas maanantaista",
        detail:
          "The gym membership is frozen until 30 November: the door PIN won't work on Monday 2 November unless the " +
          "freeze is ended early in the app at least 48 hours before (a £10 unfreeze fee applies).",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 1, 7, 30),
          title: "Your membership freeze is active",
          body:
            "Your membership is frozen until 30 November 2026. Your PIN won't open the doors while it is frozen. To " +
            "end your freeze early, change it in the app at least 48 hours before you want to come in (a £10 " +
            `unfreeze fee applies). ${c.ta.pick(["See you soon!", "We'll be here when you're back."])}`,
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(8, 31, 7, 30),
          title: "Your membership freeze has ended",
          body:
            "Your freeze ended on 31 August 2026 and your monthly payments have restarted. Your PIN works again at " +
            `all our sites. ${c.tb.pick(["Welcome back!", "Good to have you back."])}`,
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: calendar (event) ·
  // anchored: yes · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "lakes-weekend-7th",
    build: (c) => {
      const dent = c.role("dentist", ["Ngozi", "Okafor"]);
      const bal = c.r.int(28, 39) * 10;
      const crown = (start: number, when: string, edited: number) =>
        event({
          title: `Dr ${dent.last} — crown fit`,
          start,
          when,
          where: "Brightsmile Dental, 14 Church Road",
          notes: `Permanent crown, lower left. Band 3 balance £${bal} payable on the day. Temporary crown only lasts a few weeks.`,
          edited,
        });
      return {
        text: "Let's do the Lakes trip the weekend of the 7th",
        detail:
          `The crown-fitting appointment with Dr ${dent.last} (Brightsmile Dental) now sits on Saturday 7 November ` +
          "10:30 (moved in the calendar from the 14th), clashing with a Lakes weekend; the temporary crown " +
          "shouldn't be left much longer.",
        hidden: crown(at(11, 7, 10, 30), "Sat 7 Nov, 10:30–11:30", at(10, 23, 16, 45)),
        decoy: event({
          title: `Dr ${dent.last} — hygienist`,
          start: at(11, 21, 10, 30),
          when: "Sat 21 Nov, 10:30–11:00",
          where: "Brightsmile Dental, 14 Church Road",
          notes: `Scale and polish. ${c.tb.pick(["£65 private fee.", "Pay at reception."])}`,
          edited: at(10, 23, 16, 45),
        }),
        before: crown(at(11, 14, 10, 30), "Sat 14 Nov, 10:30–11:30", at(10, 9, 11, 0)),
      };
    },
  },
  // overlap: topic-word · decoy: (a) resolved/expired/superseded · phrasing: question · source: slack (chat) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "cheap-glasses",
    build: (c) => {
      const [hr, by] = c.colleagues(2);
      return {
        text: "Could you find me a cheap optician for new glasses?",
        detail:
          "Work's eyecare scheme gives screen users a free eye test and £60 towards glasses at Specsavers via an " +
          "e-voucher from the People team, if requested by Friday 13 November.",
        hidden: chat(
          c.ta,
          "people-team",
          [
            {
              who: hr!,
              text:
                "Eyecare reminder: if you use a screen for work you can get a free eye test plus £60 towards glasses " +
                `at Specsavers. Request your e-voucher from People by Fri 13 Nov, ${c.ta.pick(["this year's scheme closes then", "after that it closes for the year"])}.`,
              when: at(10, 20, 10, 0),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "people-team",
          [
            {
              who: hr!,
              text:
                "The 2025 eyecare voucher window has now closed, thanks to everyone who used it. " +
                `${c.tb.pick(["Details of next year's will follow.", "We'll share next year's dates in due course."])}`,
              when: at(12, 12, 10, 0, 2025),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: health (notification) ·
  // anchored: no · silent: no · rare: yes · knowledge: yes · language: English
  {
    name: "inhaler-collect",
    build: (c) => {
      const ppc = c.r.token("0123456789", 10);
      return {
        text: "I'll pick up my inhaler from the chemist on Thursday",
        detail:
          "The user's prescription prepayment certificate ends on 28 October, the day before Thursday's collection; " +
          "unless it is renewed first, each item will cost the standard NHS prescription charge (about £9.90).",
        hidden: rare(
          "health",
          "Prescription Prepayment Certificate",
          `Your 12-month PPC (no. ${ppc}) ends on 28 October 2026. You can renew it online at any time. ` +
            `${c.ta.pick(["Renewing early does not shorten your cover.", "Find out more on the NHSBSA website."])}`,
          at(10, 14, 9, 0),
        ),
        decoy: rare(
          "health",
          "Prescription Prepayment Certificate",
          `Your PPC (no. ${ppc}) has been renewed. Valid from 29 October 2026 to 28 October 2027. ` +
            `${c.tb.pick(["Paid by direct debit.", "Show this if asked."])}`,
          at(10, 14, 9, 0),
        ),
      };
    },
  },
  // ── money ──
  // overlap: topic-word · decoy: (b) other entity or date · phrasing: plan · source: gmail (notification) ·
  // anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "lisa-car",
    build: (c) => {
      const amt = c.r.int(3, 6);
      const bal = c.r.int(12_000, 18_000);
      const from = bot("Moneybox", "noreply@moneyboxapp.com");
      return {
        text: `Planning to take £${amt}k out of my Lifetime ISA for the car`,
        detail:
          "Withdrawing from a Lifetime ISA for anything but a first home (or terminal illness, or after 60) incurs " +
          `the 25% government withdrawal charge, so taking £${amt}k out loses about £${amt * 250}; better to use ` +
          "other savings.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 8, 8, 0),
          title: "Your Lifetime ISA annual statement",
          body:
            `Balance: £${bal.toLocaleString("en-GB")}\nGovernment bonus received this tax year: £1,000\nAccount ` +
            `opened: ${c.ta.pick(["2021", "2022"])}\n\nThanks for saving with us.`,
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 8, 8, 0),
          title: "Your Stocks & Shares ISA annual statement",
          body:
            `Balance: £${bal.toLocaleString("en-GB")}\nContributions this tax year: £2,400\nGrowth: ` +
            `${c.tb.pick(["+6.1%", "+4.8%"])}\n\nThanks for investing with us.`,
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: gmail (mail) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: Malay
  {
    name: "tax-after-christmas",
    build: (c) => {
      const acc = c.role("accountant", ["Owen", "Price"]);
      return {
        text: "Saya nak uruskan hal cukai lepas Krismas nanti",
        detail:
          `${acc.full} (accountant) needs the rental income figures, P11D and pension statements by Monday 30 ` +
          "November to file the self-assessment before 31 January; leaving it until after Christmas is too late.",
        hidden: mail(c, c.ta, {
          from: acc,
          when: at(10, 19, 17, 20),
          title: "2025–26 return — what I need",
          body: [
            "To get your 2025–26 return filed before the January deadline I need the rental income figures, your P11D and the pension statements.",
            "Please send them by Mon 30 Nov at the latest.",
            "Anything after that I can't guarantee before 31 Jan, and your first payment on account is due that day too.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: acc,
          when: at(1, 22, 17, 20),
          title: "2024–25 return — filed",
          body: [
            "Your 2024–25 return has been filed and HMRC have accepted it.",
            c.tb.pick(["Nothing else needed from you.", "All done for this year."]),
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: bank (notification) ·
  // anchored: no · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "car-insurance-card",
    build: (c) => {
      const oldCard = c.r.int(1000, 9999);
      const newCard = c.r.int(1000, 9999);
      return {
        text: "Can you pay the car insurance renewal online on Monday?",
        detail:
          `The user's usual card (ending ${oldCard}) was cancelled on 22 October after being reported lost; the ` +
          `replacement (ending ${newCard}) may not have arrived or been activated, so use another card or update ` +
          "the saved details first.",
        hidden: rare(
          "bank",
          "Card replacement",
          `Your card ending ${oldCard} was cancelled on 22 Oct after you reported it lost. Your new card ending ` +
            `${newCard} was posted on 23 Oct and should arrive within 3–5 working days. Saved card details on ` +
            `websites and apps will need updating. ${c.ta.pick(["Activate it in the app.", "Tap to activate when it arrives."])}`,
          at(10, 23, 9, 30),
        ),
        decoy: rare(
          "bank",
          "Card replacement",
          `Your new card ending ${oldCard} is now active. Your old card ending ${newCard} no longer works. ` +
            `${c.tb.pick(["Thanks for activating.", "Nothing else to do."])}`,
          at(3, 18, 9, 30),
        ),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: imperative · source: bank (notification) ·
  // anchored: no · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "chase-refund",
    build: (c) => {
      const amt = c.r.int(289, 449);
      return {
        text: "Chase Currys about the refund for the broken dishwasher",
        detail: `Currys' refund of £${amt}.00 already landed in the account on 23 October, so there is nothing to chase.`,
        hidden: rare(
          "bank",
          "Transactions · 23 Oct",
          `CURRYS RETAIL LTD · Refund · +£${amt}.00\nTESCO STORES 2231 · −£${c.ta.int(20, 60)}.40\nTFL TRAVEL CH · −£8.10`,
          at(10, 23, 18, 0),
        ),
        decoy: rare(
          "bank",
          "Transactions · 23 Oct",
          `AO.COM · Refund · +£${amt}.00\nTESCO STORES 2231 · −£${c.tb.int(20, 60)}.40\nTFL TRAVEL CH · −£8.10`,
          at(10, 23, 18, 0),
        ),
      };
    },
  },
  // overlap: topic-word · decoy: (c) condition met · phrasing: question · source: drive (doc) ·
  // anchored: no · silent: yes · rare: no · knowledge: yes · language: English
  {
    name: "bonus-premium-bonds",
    build: (c) => {
      const bonus = c.r.int(4, 8);
      const tracker = (pb: string) =>
        "Account | Balance | Notes\n" +
        "Easy access (Chase) | £6,200 | emergency fund, don't touch\n" +
        `NS&I Premium Bonds | ${pb} | holder no. on the fridge\n` +
        "Cash ISA (Trading 212) | £9,850 | 2026–27 sub so far £9,850\n" +
        "Pension (work) | see portal |";
      return {
        text: `Can I put my £${bonus}k bonus straight into premium bonds?`,
        detail:
          "The savings tracker now shows £48,500 already in Premium Bonds (it read £38,500 until a recent edit); the " +
          `maximum holding is £50,000, so only £1,500 of the £${bonus}k bonus can go in.`,
        hidden: doc("Savings tracker", tracker("£48,500"), at(10, 24, 20, 15)),
        decoy: doc("Savings tracker", tracker(c.tb.pick(["£21,000", "£18,500"])), at(10, 24, 20, 15)),
        before: doc("Savings tracker", tracker("£38,500"), at(6, 2, 20, 15)),
      };
    },
  },
  // ── travel ──
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: drive (doc) ·
  // anchored: no · silent: no · rare: no · knowledge: yes · language: Catalan
  {
    name: "jetski-tenerife",
    build: (c) => {
      const pol = c.r.token("0123456789", 8);
      const summary = (extra: string) =>
        `Policy ${pol} · Annual multi-trip, Europe incl. Canary Islands · 1 Apr 2026 – 31 Mar 2027\n\n` +
        "Medical expenses: £10m · Cancellation: £5,000 · Baggage: £1,500 · Excess: £100\n\n" +
        `Not covered: winter sports, motorised watercraft, quad bikes, scuba below 30m, skydiving.${extra}`;
      return {
        text: "Reservem una sessió de moto aquàtica a Tenerife pel dia 8",
        detail:
          "The user's annual travel insurance excludes motorised watercraft, so a jet-ski session in Tenerife would " +
          "not be covered for injury or liability unless an add-on is bought first.",
        hidden: doc("Travel insurance — policy summary", summary(""), at(4, 1, 10, 0)),
        decoy: doc(
          "Travel insurance — policy summary",
          summary(
            `\n\nAdventure pack added ${c.tb.pick(["2 Oct", "5 Oct"])}: motorised watercraft now covered with a ` +
              "licensed operator.",
          ),
          at(10, 2, 10, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: trips (doc) ·
  // anchored: no · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "cottage-settle-checkin",
    build: (c) => {
      const bal = c.r.int(48, 69) * 10;
      const trip = (terms: string) =>
        "Stable Cottage, Bamburgh · 18–22 Dec (4 nights) · sleeps 4\n" +
        "Deposit £150 paid 2 Sep\n" +
        `${terms}\n` +
        "Key safe by the back door, code sent 2 days before · dogs allowed";
      return {
        text: "I'll settle up with the holiday let owner when we arrive",
        detail:
          `The cottage booking now says the £${bal} balance is due by bank transfer by Friday 6 November, not on ` +
          "arrival (the itinerary was updated); unpaid bookings are cancelled and the deposit kept.",
        hidden: rare(
          "trips",
          "Northumberland, December",
          trip(`Balance £${bal} due by bank transfer by 6 Nov — unpaid bookings cancelled, deposit kept`),
          at(10, 22, 12, 0),
        ),
        decoy: rare(
          "trips",
          "Northumberland, December",
          trip(`Balance £${bal} paid in full ${c.tb.pick(["20 Oct", "21 Oct"])} ✓`),
          at(10, 22, 12, 0),
        ),
        before: rare("trips", "Northumberland, December", trip(`Balance £${bal} payable on arrival`), at(9, 2, 18, 0)),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: gmail (notification) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: Spanish
  {
    name: "faro-excess",
    build: (c) => {
      const from = bot("iCarhireinsurance", "policies@icarhireinsurance.com");
      const limit = c.r.pick(["£6,000", "£7,500"]);
      return {
        text: "¿Pillo el seguro de franquicia en el mostrador cuando recoja el coche en Faro?",
        detail:
          `The user already has an annual car hire excess insurance policy (up to ${limit}, worldwide) valid until 14 ` +
          "March 2027, so the rental desk's excess cover in Faro would duplicate it; decline it and keep a credit card " +
          "for the deposit hold.",
        hidden: notice(c, c.ta, {
          from,
          when: at(3, 15, 9, 0),
          title: "Your annual car hire excess policy is active",
          body:
            `Cover: excess reimbursement up to ${limit}, worldwide\nPolicy period: 15 Mar 2026 – 14 Mar 2027\n\n` +
            `${c.ta.pick(["Keep this email with you when you rent.", "Show your policy number if asked."])}`,
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(9, 30, 9, 0),
          title: "Your annual car hire excess policy has expired",
          body:
            `Cover: excess reimbursement up to ${limit}, worldwide\nPolicy period: 1 Oct 2025 – 30 Sep 2026 ` +
            `(expired)\n\n${c.tb.pick(["Renew now to stay covered.", "Get a new quote in two minutes."])}`,
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: question · source: calendar (event) ·
  // anchored: yes · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "airport-saturday",
    build: (c) => {
      const seat = `${c.r.int(10, 32)}${c.r.pick(["A", "C", "D", "F"])}`;
      const out = (start: number, when: string, edited: number) =>
        event({
          title: "Flight to Valencia — BA2614",
          start,
          when,
          where: "London Gatwick, North Terminal",
          notes: `Seat ${seat}. Hand luggage only. Booking ref on the BA app.`,
          edited,
        });
      return {
        text: "What time should I leave for the airport on Saturday?",
        detail:
          "The Saturday 31 October flight to Valencia (BA2614, Gatwick North) now departs at 07:15, not 10:40 (the " +
          "calendar entry was changed), so the user needs to leave around 04:45–05:00, not mid-morning.",
        hidden: out(at(10, 31, 7, 15), "Sat 31 Oct, 07:15–10:35", at(10, 24, 7, 50)),
        decoy: event({
          title: "Flight home — BA2615",
          start: at(11, 8, 18, 5),
          when: "Sun 8 Nov, 18:05–19:30",
          where: "Valencia Airport",
          notes: `Seat ${seat}. ${c.tb.pick(["Hand luggage only.", "Check in opens 24h before."])}`,
          edited: at(10, 24, 7, 50),
        }),
        before: out(at(10, 31, 10, 40), "Sat 31 Oct, 10:40–14:00", at(9, 12, 21, 0)),
      };
    },
  },
  // overlap: name · decoy: (c) condition met · phrasing: imperative · source: trips (doc) ·
  // anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "porto-train",
    build: (c) => {
      const coach = c.r.int(1, 6);
      const leg = (fare: string) =>
        "CP Alfa Pendular 125 · Thu 12 Nov\nLisboa Santa Apolónia 08:39 → Porto Campanhã 11:35\n" +
        `Coach ${coach}, seat 42 · 2nd class\nFare: ${fare}`;
      return {
        text: "Move my Porto train to the afternoon",
        detail:
          "The Lisbon–Porto Alfa Pendular on Thursday 12 November is on a promo fare with no changes and no " +
          "refunds, so moving it means buying a new afternoon ticket.",
        hidden: rare(
          "trips",
          "Portugal, November",
          leg(`Promo (no changes, no refunds)${c.ta.pick(["", " · €19.90"])}`),
          at(10, 10, 20, 0),
        ),
        decoy: rare(
          "trips",
          "Portugal, November",
          leg(`Base (changes free until departure)${c.tb.pick(["", " · €32.40"])}`),
          at(10, 10, 20, 0),
        ),
      };
    },
  },
  // ── home ──
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: residents (doc) ·
  // anchored: yes · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "washer-install-thursday",
    build: (c) => {
      const block = c.r.pick(["A–C", "A–D"]);
      const notice2 = (date: string) =>
        `Blocks ${block}: the mains supply will be isolated 08:00–16:00 on ${date} for riser valve replacement. ` +
        "Please store drinking water beforehand and avoid running taps while the supply is restored.";
      return {
        text: "Book the washing machine install for Thursday",
        detail:
          "The building's mains water is off 08:00–16:00 on Thursday 29 October (residents' notice, date moved from " +
          "5 November), so a washing machine can't be plumbed in and tested that day.",
        hidden: rare("residents", "Planned works: mains water off", notice2("29 October"), at(10, 22, 16, 0)),
        decoy: rare(
          "residents",
          "Planned works: mains water off",
          notice2("19 November") + c.tb.pick(["", " Thank you for your patience."]),
          at(10, 22, 16, 0),
        ),
        before: rare("residents", "Planned works: mains water off", notice2("5 November"), at(10, 5, 16, 0)),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: imperative · source: drive (doc) ·
  // anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "ev-charger",
    build: (c) => {
      const date = c.r.pick(["12 Aug 2026", "3 Sep 2026"]);
      const report = (supply: string, cu: string, rec: string) =>
        `Inspected ${date} by Brightwire Electrical (NICEIC). Overall: SATISFACTORY.\n\n` +
        `Supply: single-phase, ${supply}\nConsumer unit: ${cu}\nEarthing: TN-C-S (PME)\n\n` +
        `Observations: C3 – no RCD on outside socket; C3 – loft lighting circuit unlabelled.\n${rec}`;
      return {
        text: "Order a 7kW EV charger and get it put in on the drive",
        detail:
          "The house's electrical report shows a 60A main fuse and a full consumer unit; a 7kW charger draws about " +
          "32A continuously, so it needs a supply upgrade from UKPN (6–12 weeks) and probably a new consumer unit " +
          "first.",
        hidden: doc(
          "EICR — electrical inspection report",
          report(
            "60A main fuse (DNO cut-out)",
            "10-way, all ways used, no spare",
            "Recommendation: before adding any large continuous load, request a main fuse upgrade from the network " +
              "operator (UKPN); lead time 6–12 weeks.",
          ),
          at(9, 4, 10, 0),
        ),
        decoy: doc(
          "EICR — electrical inspection report",
          report(
            "100A main fuse (DNO cut-out)",
            "18-way, Type B RCBOs, 4 spare ways",
            `Recommendation: ${c.tb.pick(["none beyond the C3 items.", "re-inspect in 10 years."])}`,
          ),
          at(9, 4, 10, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: drive (doc) ·
  // anchored: no · silent: no · rare: no · knowledge: yes · language: Hungarian
  {
    name: "airbnb-room",
    build: (c) => {
      const acct = c.r.token("0123456789", 10);
      const terms =
        `Mortgage account ${acct}\n\n` +
        "4. Insurance: keep the property insured for its full rebuild cost.\n" +
        "5. Repair: keep the property in good repair.\n" +
        "7. Letting: you must not grant any tenancy or licence of the property, or any part of it, or accept " +
        "payment for anyone to occupy it, without our prior written consent.";
      return {
        text: "Kiadhatom a vendégszobát Airbnb-n karácsonykor?",
        detail:
          "The mortgage conditions forbid letting any part of the property or taking paying occupants without the " +
          "lender's prior written consent, so Airbnb guests need the lender's consent (and the home insurer told) " +
          "first.",
        hidden: doc("Mortgage offer — key conditions", terms, at(2, 11, 10, 0)),
        decoy: doc(
          "Mortgage offer — key conditions",
          terms +
            `\n\nConsent to let: granted ${c.tb.pick(["3 Mar 2026", "9 Mar 2026"])} for lodgers and short lets ` +
            "of a single room (letter on file).",
          at(3, 3, 10, 0),
        ),
      };
    },
  },
  // overlap: topic-word · decoy: (a) resolved/expired/superseded · phrasing: statement · source: gmail (notification) ·
  // anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "fridge-wednesday",
    build: (c) => {
      const from = bot("AO.com Deliveries", "deliveries@ao.com");
      const order = c.r.int(10_000_000, 99_999_999);
      return {
        text: "The fridge is being delivered tomorrow so I'll work from home",
        detail:
          "The fridge freezer delivery was rescheduled to Friday 30 October, so staying in tomorrow (Wednesday 28 " +
          "October) for it is unnecessary.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 26, 18, 30),
          title: "Your delivery has been rescheduled",
          body:
            `Order ${order}: Bosch Series 4 fridge freezer KGN39VIBT\nNew date: Friday 30 October, 07:00–19:00\n\n` +
            `${c.ta.pick(["We'll text a 2-hour slot the evening before.", "You'll get a 2-hour slot by text the night before."])}`,
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(8, 12, 15, 0),
          title: "Your order has been delivered",
          body:
            `Order ${order - 4_211}: Bosch Series 6 washing machine WGG244\nDelivered 12 August. ` +
            `${c.tb.pick(["Rate your driver.", "Tell us how we did."])}`,
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: residents (doc) ·
  // anchored: no · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "parents-parking",
    build: (c) => {
      const zone = c.r.pick(["Q", "K", "HB"]);
      return {
        text: "My parents are visiting next weekend, they can just park outside, right?",
        detail:
          `The street is in controlled zone ${zone}, enforced Mon–Sat 08:30–18:30 in permit-holder bays, so the ` +
          "parents need a visitor voucher (RingGo, about £2.40 a day) for the Saturday; Sunday is free.",
        hidden: rare(
          "residents",
          `Controlled parking zone ${zone}`,
          "Hours: Mon–Sat 08:30–18:30. Bays on the estate roads are for permit holders only. Visitors need a " +
            "visitor voucher (buy in the RingGo app, £2.40 per day, max 20 a month). Penalty charge notices are " +
            `issued by the council's enforcement officers. ${c.ta.pick(["", "Blue badge holders: see council site."])}`,
          at(9, 15, 10, 0),
        ),
        decoy: rare(
          "residents",
          `Controlled parking zone ${zone}`,
          "Hours: Mon–Fri 08:30–18:30. Evenings, weekends and bank holidays are free for everyone. " +
            `${c.tb.pick(["", "Blue badge holders: see council site."])}`,
          at(9, 15, 10, 0),
        ),
      };
    },
  },
  // ── admin ──
  // overlap: topic-word · decoy: (b) other entity or date · phrasing: imperative · source: gmail (mail) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "upvc-windows",
    build: (c) => {
      const no = c.r.int(3, 48);
      const officer: Who = {
        full: "Tom Ashworth",
        first: "Tom",
        email: "tom.ashworth@council.gov.uk",
        title: "Conservation Officer",
        company: "Planning Services",
      };
      return {
        text: "Get three quotes for uPVC windows at the front",
        detail:
          `${no} Albion Road is in the conservation area under an Article 4 Direction: replacing front windows needs ` +
          "planning permission, and the council expects timber sashes; uPVC is unlikely to be approved.",
        hidden: mail(c, c.ta, {
          from: officer,
          when: at(10, 13, 11, 0),
          title: "Article 4 Direction — your property",
          corporate: true,
          body: [
            `${no} Albion Road is in the St Mark's Conservation Area and covered by an Article 4 Direction.`,
            "Replacing windows on the front elevation needs planning permission.",
            "We'd normally expect timber sashes to match the originals; uPVC is unlikely to be approved.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: officer,
          when: at(10, 13, 11, 0),
          title: "Article 4 Direction — consultation",
          corporate: true,
          body: [
            "We are consulting on an Article 4 Direction for the houses on Elm Grove.",
            `You are receiving this as a neighbouring owner; ${no} Albion Road itself is not affected.`,
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: drive (doc) ·
  // anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "boiler-local-guy",
    build: (c) => {
      const last = c.r.pick(["9 Dec 2025", "2 Dec 2025"]);
      return {
        text: "Could you find a local plumber to look at the boiler?",
        detail:
          "The combi is a Worcester Bosch Greenstar under a 10-year manufacturer guarantee to January 2031: call " +
          "Worcester Bosch for a free engineer visit; a local plumber's repair could void the guarantee.",
        hidden: doc(
          "House — guarantees & warranties",
          "Worcester Bosch Greenstar 8000 Life combi · fitted 14 Jan 2021 by HeatRight Ltd · 10-year manufacturer " +
            "guarantee to Jan 2031 · faults: call Worcester Bosch 0330 123 9339 for a free engineer visit (repairs " +
            `by anyone else void it) · annual Gas Safe service required, last ${last}\n` +
            "Dishwasher (Bosch) · 2-year guarantee to Mar 2027\nRoof (flat, rear) · 15-year guarantee to 2034",
          at(12, 10, 19, 0, 2025),
        ),
        decoy: doc(
          "House — guarantees & warranties (old flat)",
          "Vaillant ecoTEC combi · guarantee expired Mar 2024 · flat sold Sept 2024\n" +
            `${c.tb.pick(["Fridge (Beko) · guarantee expired", "Oven (AEG) · guarantee expired"])}`,
          at(9, 30, 19, 0, 2024),
        ),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: plan · source: tasks (doc) ·
  // anchored: no · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "meter-numbers",
    build: (c) => {
      const p = c.r.pick(["p1", "p2"]);
      const task = (due: string) =>
        `Submit gas + electric readings to Octopus\nDue: ${due} · Priority ${p} · Project: House\n` +
        "Note: before the 1 Nov tariff change or they estimate. Photos of both dials in the app.";
      return {
        text: "Remind me next week to send Octopus the numbers off the meters",
        detail:
          "The to-do now says the Octopus readings are due by Friday 30 October, before the 1 November tariff " +
          "change (it said 5 November until it was edited), so next week is too late.",
        hidden: rare("tasks", "Submit gas + electric readings to Octopus", task("Fri 30 Oct"), at(10, 24, 10, 0)),
        decoy: rare(
          "tasks",
          "Send water reading to Thames Water",
          `Due: Fri 20 Nov · Priority ${p} · Project: House\n${c.tb.pick(["Meter is under the kitchen sink.", "Cupboard by the front door."])}`,
          at(10, 24, 10, 0),
        ),
        before: rare("tasks", "Submit gas + electric readings to Octopus", task("Thu 5 Nov"), at(10, 2, 10, 0)),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: gmail (notification) ·
  // anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "sofa-pavement-sunday",
    build: (c) => {
      const from = bot("Council Waste Services", "waste@council.gov.uk");
      const fee = c.r.pick(["£28", "£35"]);
      return {
        text: "Put the old sofa out on the pavement Sunday night",
        detail:
          "The council bulky-waste collection for the settee is Wednesday 4 November: items may only go out after " +
          "6pm on Tuesday 3 November, so leaving it out from Sunday night risks a fly-tipping fine.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 25, 12, 0),
          title: "Bulky waste collection confirmed",
          body:
            `Items: 1 x three-seater settee\nCollection: Wednesday 4 November\nFee paid: ${fee}\n\nPlease leave ` +
            "items at the kerbside no earlier than 6pm the evening before, and by 7am on collection day. Items left " +
            "out earlier may be treated as fly-tipping (fine up to £400).",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(8, 12, 15, 0),
          title: "Bulky waste collection completed",
          body: `Items: 1 x mattress, 1 x chest of drawers\nCollected: 12 August\nFee paid: ${fee}\n\n${c.tb.pick(["Thank you for using the service.", "Rate our service."])}`,
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: plan · source: drive (doc) ·
  // anchored: no · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "house-empty-christmas",
    build: (c) => {
      const pol = c.r.token("0123456789", 9);
      const sched = (days: string) =>
        `Policy ${pol} · Renewal 1 Oct 2026 · Buildings £420,000 · Contents £60,000 · Excess £250\n\n` +
        `Unoccupancy: if the home is unoccupied for more than ${days} consecutive days, cover for theft, escape of ` +
        "water and malicious damage is suspended unless we agree otherwise in writing.\n" +
        "Accidental damage: included for buildings only.";
      return {
        text: "We'll be away from the house for five weeks over Christmas",
        detail:
          "The renewed home-insurance schedule now suspends theft and escape-of-water cover after 30 consecutive " +
          "days unoccupied (it said 60 before a recent update); five weeks away breaches it unless the insurer agrees " +
          "in writing or someone stays or checks in.",
        hidden: doc("Home insurance — policy schedule", sched("30"), at(10, 1, 9, 0)),
        decoy: doc(
          "Home insurance — policy schedule",
          sched("90") + c.tb.pick(["", "\nKeys: neighbour at no. 9."]),
          at(10, 1, 9, 0),
        ),
        before: doc("Home insurance — policy schedule", sched("60"), at(9, 10, 9, 0)),
      };
    },
  },
  // ── social ──
  // overlap: name · decoy: (b) other entity or date · phrasing: plan · source: whatsapp (chat) ·
  // anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "jamie-cabin-share",
    build: (c) => {
      const bf = c.role("best friend", ["Jamie", "Fox"]);
      return {
        text: `I'll send ${bf.first} £95 for the cabin`,
        detail:
          `${bf.full} said in the Loch Tay lodge group that the split rose to £114 each after Priya dropped out, so ` +
          "£95 is £19 short.",
        hidden: rare(
          "whatsapp",
          "Loch Tay lodge 🏡",
          `${bf.full}: right so Priya's out 😢 refund only covers half her bit\n${bf.full}: new split is £114 each, ` +
            `sort me when you can x\nSam: ${c.ta.pick(["done 👍", "sent"])}`,
          at(10, 25, 20, 40),
        ),
        decoy: rare(
          "whatsapp",
          "Gig tickets",
          `${bf.full}: tickets were £58 each incl fees, sort me when you can x\nSam: ${c.tb.pick(["done 👍", "sent"])}`,
          at(10, 25, 20, 40),
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: slack (chat) ·
  // anchored: yes · silent: no · rare: no · knowledge: no · language: French
  {
    name: "friday-dinner-cancel",
    build: (c) => {
      const [org, by] = c.colleagues(2);
      const n = c.r.int(12, 18);
      return {
        text: "Je pense annuler ma place au dîner de vendredi",
        detail:
          "The organiser said anyone dropping out of Friday's Dishoom set-menu dinner after Wednesday noon still owes " +
          "the full £45 (the restaurant charges the group), so cancel before Wednesday 12:00 to avoid paying.",
        hidden: chat(
          c.ta,
          "social",
          [
            {
              who: org!,
              text:
                `Dishoom Fri: set menu £45pp, I've paid the deposit for ${n}. Anyone dropping out after Weds noon ` +
                `still owes the full £45 ${c.ta.pick(["(restaurant charges us)", "as they charge us regardless"])}`,
              when: at(10, 26, 13, 15),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "social",
          [
            {
              who: org!,
              text:
                "Xmas party Fri 11 Dec: £20 contribution, fully refundable if you drop out before 1 Dec " +
                `${c.tb.pick(["🎄", "(just tell me)"])}`,
              when: at(10, 26, 13, 15),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: gmail (notification) ·
  // anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "stand-mixer-gift",
    build: (c) => {
      const fr = c.role("friend", ["Leila", "Haddad"]);
      const from = bot("John Lewis Gift Registry", "registry@johnlewis.co.uk");
      const reg = c.r.int(100000, 999999);
      return {
        text: `Buy ${fr.first} the stand mixer off her wedding list`,
        detail:
          `The KitchenAid stand mixer on ${fr.first}'s registry has already been bought; pick something still ` +
          "needed (e.g. the Le Creuset casserole).",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 24, 11, 0),
          title: `${fr.last} & Kerr gift registry — what's left`,
          body:
            `Registry ${reg}\nKitchenAid Artisan 4.8L — fully purchased\nLe Creuset 26cm casserole — 1 of 1 still ` +
            `needed\nEgyptian cotton towel bale — ${c.ta.pick(["2", "3"])} of 4 still needed`,
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 24, 11, 0),
          title: `${fr.last} & Kerr gift registry — what's left`,
          body:
            `Registry ${reg}\nKitchenAid Artisan 4.8L — 1 of 1 still needed\nSmeg 2-slice toaster — fully ` +
            `purchased\nEgyptian cotton towel bale — ${c.tb.pick(["2", "3"])} of 4 still needed`,
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: calendar (event) ·
  // anchored: yes · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "uni-drinks-6th",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const party = (start: number, when: string, edited: number) =>
        event({
          title: `${mum.first}'s 65th — dinner`,
          start,
          when,
          where: "The Ivy, Richmond",
          notes: `Table for 10 booked by ${mum.first}. Card + flowers from us.`,
          edited,
        });
      return {
        text: "Planning drinks with the uni lot on Friday the 6th",
        detail:
          `Mum's (${mum.full}) 65th birthday dinner at The Ivy, Richmond now sits on Friday 6 November at 19:00 (moved ` +
          "in the calendar from Saturday 7 November), the same evening as the planned uni drinks.",
        hidden: party(at(11, 6, 19, 0), "Fri 6 Nov, 19:00–22:30", at(10, 24, 12, 30)),
        decoy: event({
          title: "Leila's birthday — pub",
          start: at(11, 13, 19, 0),
          when: "Fri 13 Nov, 19:00–23:00",
          where: "The Albion, Islington",
          notes: c.tb.pick(["Bring a card.", "Her round first, apparently."]),
          edited: at(10, 24, 12, 30),
        }),
        before: party(at(11, 7, 19, 0), "Sat 7 Nov, 19:00–22:30", at(9, 20, 12, 30)),
      };
    },
  },
  // overlap: none · decoy: (c) condition met · phrasing: question · source: calendar (event) ·
  // anchored: no · silent: no · rare: no · knowledge: no · language: Swahili
  {
    name: "sisters-party-plusone",
    build: (c) => {
      const sis = c.role("sister", ["Ellie", "Carter"]);
      const venue = c.r.pick(["The Lamb, Holborn", "The Crown, Clapham"]);
      const invite = (rule: string) =>
        event({
          title: `${sis.first} & Dan — engagement drinks`,
          start: at(11, 21, 19, 0),
          when: "Sat 21 Nov, 19:00–23:00",
          where: venue,
          notes: `Organiser: ${sis.full}\n\n${rule}`,
          edited: at(10, 18, 21, 0),
        });
      return {
        text: "Ni sawa nikimleta mpenzi wangu kwenye sherehe ya uchumba ya dada yangu?",
        detail:
          `${sis.first}'s engagement drinks invite (Saturday 21 November) says the venue caps numbers at 40 and only ` +
          "the names on the invite can come, no plus-ones; check with her before bringing a partner.",
        hidden: invite("Venue caps us at 40 so it's just the names on this invite I'm afraid, no extra guests 🙏"),
        decoy: invite(`Partners and +1s very welcome! ${c.tb.pick(["🥂", "Just let me know numbers."])}`),
      };
    },
  },
];

/** Templates whose request names one person, thing or date the planted item words differently. */
export const DEV20C_ANCHORED: readonly string[] = [
  "rsu-sale-monday",
  "maya-pocket-money",
  "knee-mri",
  "lakes-weekend-7th",
  "airport-saturday",
  "porto-train",
  "washer-install-thursday",
  "fridge-wednesday",
  "boiler-local-guy",
  "sofa-pavement-sunday",
  "jamie-cabin-share",
  "friday-dinner-cancel",
  "stand-mixer-gift",
  "uni-drinks-6th",
];
/** Templates whose planted item (both variants) sits in a rare source (RARE_SOURCES). */
export const DEV20C_RARE: readonly string[] = [
  "maya-pocket-money",
  "standing-desk",
  "austria-trip-balance",
  "inhaler-collect",
  "car-insurance-card",
  "chase-refund",
  "cottage-settle-checkin",
  "porto-train",
  "washer-install-thursday",
  "parents-parking",
  "meter-numbers",
  "jamie-cabin-share",
];
/** Templates whose fact is a silent edit at the source (their Spec has `before`). */
export const DEV20C_SILENT: readonly string[] = [
  "builder-deposit-payday",
  "standing-desk",
  "lakes-weekend-7th",
  "bonus-premium-bonds",
  "cottage-settle-checkin",
  "airport-saturday",
  "washer-install-thursday",
  "meter-numbers",
  "house-empty-christmas",
  "uni-drinks-6th",
];
/** Templates whose request is not in English (name the language in the template's comment). */
export const DEV20C_NON_ENGLISH: readonly string[] = [
  "monitors-po",
  "wedding-shoots-weekends",
  "knee-mri",
  "gym-from-monday",
  "tax-after-christmas",
  "jetski-tenerife",
  "faro-excess",
  "airbnb-room",
  "friday-dinner-cancel",
  "sisters-party-plusone",
];
/** Templates whose request is indirect or a question ("Should I…", "I need to…", "We should…", "Can we…?"). */
export const DEV20C_INDIRECT: readonly string[] = [
  "rsu-sale-monday",
  "builder-deposit-payday",
  "wedding-shoots-weekends",
  "grandma-savings-split",
  "austria-trip-balance",
  "gym-from-monday",
  "lakes-weekend-7th",
  "inhaler-collect",
  "lisa-car",
  "tax-after-christmas",
  "jetski-tenerife",
  "cottage-settle-checkin",
  "fridge-wednesday",
  "meter-numbers",
  "house-empty-christmas",
  "jamie-cabin-share",
  "friday-dinner-cancel",
  "uni-drinks-6th",
  "sister-guarantor",
  "cheap-glasses",
  "car-insurance-card",
  "bonus-premium-bonds",
  "faro-excess",
  "airport-saturday",
  "airbnb-room",
  "parents-parking",
  "boiler-local-guy",
  "sisters-party-plusone",
];
/** Templates whose request is a question (a subset of DEV20C_INDIRECT). */
export const DEV20C_QUESTION: readonly string[] = [
  "sister-guarantor",
  "cheap-glasses",
  "car-insurance-card",
  "bonus-premium-bonds",
  "faro-excess",
  "airport-saturday",
  "airbnb-room",
  "parents-parking",
  "boiler-local-guy",
  "sisters-party-plusone",
];
/**
 * Templates whose fact connects to the request only through world knowledge (a drug and alcohol, asbestos and a
 * drill).
 */
export const DEV20C_KNOWLEDGE: readonly string[] = [
  "sister-guarantor",
  "inhaler-collect",
  "lisa-car",
  "bonus-premium-bonds",
  "jetski-tenerife",
  "ev-charger",
  "airbnb-room",
];
/** Templates whose request shares no word with the planted item (overlap: none). */
export const DEV20C_NO_OVERLAP: readonly string[] = [
  "monitors-po",
  "builder-deposit-payday",
  "wedding-shoots-weekends",
  "maya-pocket-money",
  "sister-guarantor",
  "standing-desk",
  "knee-mri",
  "gym-from-monday",
  "lakes-weekend-7th",
  "inhaler-collect",
  "tax-after-christmas",
  "car-insurance-card",
  "jetski-tenerife",
  "cottage-settle-checkin",
  "faro-excess",
  "airport-saturday",
  "washer-install-thursday",
  "ev-charger",
  "airbnb-room",
  "parents-parking",
  "boiler-local-guy",
  "sofa-pavement-sunday",
  "house-empty-christmas",
  "friday-dinner-cancel",
  "stand-mixer-gift",
  "uni-drinks-6th",
  "sisters-party-plusone",
];

/** Each silent-change template's `before` item, for a days harness (same RNG draws as the planting function). */
export function dev20cBefore(world: World, seed: number): { template: string; before: Plant }[] {
  return build(world, seed).flatMap(({ name, spec }) => (spec.before ? [{ template: name, before: spec.before }] : []));
}

/** Build every template's spec, in order, with the suite's own streams (no world change). */
function build(world: World, seed: number): { name: string; spec: Spec }[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 2003);
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
export function plantDev20c(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  addRareSources(world, seed);
  const suite = variant === "hidden" ? "dev20c" : `dev20c-${variant}`;
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

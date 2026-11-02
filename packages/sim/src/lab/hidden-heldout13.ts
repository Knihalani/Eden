/**
 * Held-out hidden-context suite 13: blind, written by an author who read only the world generator, the text helpers
 * and the HiddenTask interface. Measurement only: never tune on it.
 *
 * 32 requests across home, family, health, money, travel, work projects, IT, sales, HR, events, legal, education,
 * community and hobbies. Each plants one item the request does not ask about: in the `hidden` variant the real
 * consideration (a clash, a limit, a change, a prerequisite not met, or "already done"), in the `control` variant a
 * near-miss decoy that looks relevant but does not apply. Request and `detail` are identical across variants, so an
 * answer that raises the detail in control is a false claim.
 *
 * The planted items are written so that word overlap with the request varies: about a third share no content word
 * (paraphrase, other date formats), a third share only a person's or organisation's name, a third share one topic
 * word. Decoys are split between resolved/expired/superseded, about another entity or date of the same kind, and
 * "prerequisite met / allows the request".
 *
 * World time is NOW in world.ts: Tuesday 27 October 2026, 09:00 UTC. Every date below is written out against it.
 */
import { itemId } from "@eden/protocol";
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
}

/**
 * What a template gets: `r` for every draw that shapes the task (people, numbers), and two forked streams for the
 * prose of the hidden item and of the decoy. Both items are always built, so the draws on `r` are identical across
 * variants and the hidden and control suites describe the same people and numbers.
 */
interface Ctx {
  r: Rng;
  ta: Rng;
  tb: Rng;
  user: Person;
  colleague(): Person;
  colleagues(k: number): Person[];
  clients(k: number): Person[];
  vendors(k: number): Person[];
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
  m: { from: Who; to: Who; when: number; title: string; body: string[]; corporate?: boolean },
): Plant {
  const body = emailBody(t, { from: m.from, to: m.to, at: m.when, body: m.body, corporate: m.corporate ?? false });
  return {
    sourceId: "gmail",
    kind: "mail",
    title: m.title,
    text: emailText(m.from, m.to, m.when, body),
    updatedAt: m.when,
    meta: { people: people(c.user, [m.from, m.to]) },
  };
}

/** An automated email: no greeting or signature, a reference and a footer like real service mail. */
function notice(c: Ctx, t: Rng, m: { from: Who; when: number; title: string; body: string }): Plant {
  const footer =
    "You are receiving this email because you have an account with us. Please do not reply to this message; " +
    "this mailbox is not monitored. Privacy | Terms | Help";
  return {
    sourceId: "gmail",
    kind: "notification",
    title: m.title,
    text: emailText(
      m.from,
      c.user,
      m.when,
      `${m.body}\n\nRef ${t.token("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10)}\n\n${footer}`,
    ),
    updatedAt: m.when,
  };
}

/** A Slack channel excerpt: an unrelated line before the message that matters, as a search hit usually shows. */
function chat(t: Rng, channel: string, lines: { who: Person; text: string; when: number }[], bystander: Person): Plant {
  const chatter = t.pick([
    "has anyone got the guest wifi password?",
    "anyone else's VPN dropping this morning?",
    "lunch order closes at 11:30",
    "reminder that the kitchen is being deep-cleaned on Friday",
  ]);
  const first = lines[0]!.when - t.int(5, 50) * 60_000;
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

const STARTERS = ["Hannah Osei", "Callum Reid", "Noor Siddiqui", "Pablo Ferreira", "Greta Lindahl", "Femi Ajayi"];
const CANDIDATES = ["Imogen Bell", "Rahul Desai", "Clara Mendes", "Theo Barnes", "Yasmin Qureshi", "Felix Gruber"];
const COVER = ["Harriet Moss", "Kenji Ito", "Sofia Marino", "Declan Ward", "Aisha Bello", "Pieter de Vries"];

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  {
    // No shared word; decoy: the visit was cancelled. Hidden: already arranged by the landlord.
    name: "gutters-landlord",
    build: (c) => {
      const s = c.role("landlord", ["Steve", "Hargreaves"]);
      return {
        text: "Can you find someone to clear out the gutters before the winter storms arrive?",
        detail:
          "The landlord (Steve Hargreaves) already has Pellow Roofing clearing the building's gutters and downpipes " +
          "on Wednesday 4 November 2026, 08:00-13:00, at his own cost.",
        hidden: mail(c, c.ta, {
          from: s,
          to: c.user,
          when: at(10, 22, 18, 40),
          title: "Roofline work at the building",
          body: [
            "Pellow Roofing are coming to clean out the roofline drainage and downpipes on the whole building on " +
              "Wednesday 4 November, 08:00 to 13:00.",
            "It's on me, part of the annual upkeep, and they won't need to come inside the flat.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: s,
          to: c.user,
          when: at(10, 26, 8, 15),
          title: "Roofline work at the building",
          body: [
            "Pellow Roofing have cancelled the roofline drainage job they had pencilled in for Wednesday 4 November.",
            "I'm not rebooking it this year, so if anything at your end needs doing you'll have to sort it as usual.",
          ],
        }),
      };
    },
  },
  {
    // Shares the name Maya only; decoy: the grandmother paid a different club. Hidden: already paid.
    name: "maya-pool-fee",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const receipt = c.r.token("0123456789", 7);
      return {
        text: "Please pay the £14.50 for Maya's swimming lessons on ParentPay today.",
        detail:
          `Robin's mum (Ruth Carter) already paid Maya's £14.50 swimming fee on ParentPay on Sunday 25 October ` +
          `(receipt PP-${receipt}), so paying again would pay twice.`,
        hidden: mail(c, c.ta, {
          from: mum,
          to: c.user,
          when: at(10, 25, 10, 5),
          title: "Done!",
          body: [
            `I've sorted the pool sessions for Maya on ParentPay this morning, £14.50, receipt number PP-${receipt}.`,
            "Call it an early Christmas present from Granny.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: mum,
          to: c.user,
          when: at(10, 25, 10, 5),
          title: "Done!",
          body: [
            "I've sorted the after-school drama club for Maya on ParentPay this morning, " +
              `£22.00, receipt PP-${receipt}.`,
            "Call it an early Christmas present from Granny.",
          ],
        }),
      };
    },
  },
  {
    // Shares the topic word "hygienist"; decoy: the plan renewed and covers it.
    name: "hygienist-plan",
    build: (c) => {
      const practice = bot("Harley Street Dental", "reception@harleydental.co.uk");
      return {
        text: "Get me a hygienist appointment for a scale and polish before the end of November.",
        detail:
          "Robin's Denplan dental plan lapsed after the 30 September 2026 direct debit failed, so a hygienist visit " +
          "will be charged privately at £78 unless the plan is reinstated first.",
        hidden: notice(c, c.ta, {
          from: practice,
          when: at(10, 9, 7, 30),
          title: "Your Denplan Essentials membership",
          body:
            "We were unable to collect your Denplan Essentials direct debit on 30 September 2026 and your plan has " +
            "now lapsed. Until it is reinstated, hygienist visits are charged at our private rate of £78 per visit. " +
            "To reinstate, call the practice on 020 7946 0000.",
        }),
        decoy: notice(c, c.tb, {
          from: practice,
          when: at(10, 2, 7, 30),
          title: "Your Denplan Essentials membership",
          body:
            "Your Denplan Essentials plan renewed on 1 October 2026. It includes two hygienist visits a year at no " +
            "extra charge, and you have both remaining for this plan year.",
        }),
      };
    },
  },
  {
    // No shared word (ISO-style dates, no destination); decoy: the renewal already came through.
    name: "passport-validity",
    build: (c) => {
      const hmpo = bot("HM Passport Office", "no-reply@passport.service.gov.uk");
      const ending = c.r.token("0123456789", 4);
      return {
        text: "Find us return flights to Lisbon for the three of us, going out on 19 December and back on 2 January.",
        detail:
          `Maya's passport (ending ${ending}) expires on 14 February 2027, which fails the EU rule of 3 months' ` +
          "validity after leaving on 2 January; it needs renewing (about 3 weeks) before she can travel.",
        hidden: notice(c, c.ta, {
          from: hmpo,
          when: at(10, 20, 6, 0),
          title: "Reminder: a passport on your account is due to expire",
          body:
            `The passport for MAYA CARTER (ending ${ending}) expires on 14/02/2027. For travel to EU countries a ` +
            "passport must be valid for at least 3 months after the day you plan to leave. Renewals are currently " +
            "taking about 3 weeks.",
        }),
        decoy: notice(c, c.tb, {
          from: hmpo,
          when: at(10, 21, 6, 0),
          title: "Your passport application: dispatched",
          body:
            "The application for MAYA CARTER has been approved. The new passport (valid until 19/10/2031) was sent " +
            `by secure courier on 21/10/2026, and the old passport (ending ${ending}) has been cancelled.`,
        }),
      };
    },
  },
  {
    // No shared word; decoy: the earlier deadline applies to someone else's section.
    name: "board-pack-deadline",
    build: (c) => {
      const [x, y, by] = c.colleagues(3);
      return {
        text: "Get the partnerships numbers into the board pack by Thursday.",
        detail:
          `${x!.full} moved the deadline: the board meeting moved to Monday 2 November, so every section is due ` +
          "Wednesday 28 October at 17:00, a day before Thursday.",
        hidden: chat(
          c.ta,
          "leadership",
          [
            {
              who: x!,
              when: at(10, 26, 16, 12),
              text:
                "Directors' meeting has been pulled forward to Mon 2 Nov, so I need every section's slides by " +
                "tomorrow (Wed 28/10) 17:00, not Thu. Sorry for the squeeze.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "leadership",
          [
            {
              who: x!,
              when: at(10, 26, 16, 12),
              text:
                `Directors' meeting has been pulled forward to Mon 2 Nov. ${y!.first}, I need the finance appendix ` +
                "by tomorrow (Wed 28/10) 17:00; everyone else, the original date still stands.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares the topic word "domain"; decoy: a different domain renewed. Hidden: already renewed.
    name: "events-domain",
    build: (c) => {
      const reg = bot("NameHarbor", "billing@nameharbor.com");
      return {
        text: "Renew our events microsite domain before it expires.",
        detail:
          "northwind-events.com already auto-renewed on 24 October 2026 (£16.99) and is registered until " +
          "24 October 2027; nothing needs doing.",
        hidden: notice(c, c.ta, {
          from: reg,
          when: at(10, 24, 3, 10),
          title: "Receipt: northwind-events.com",
          body:
            "Your domain northwind-events.com has been extended automatically for 1 year and is now registered " +
            "until 24 October 2027. £16.99 was charged to the Visa ending 0612 on 24 October 2026.",
        }),
        decoy: notice(c, c.tb, {
          from: reg,
          when: at(10, 24, 3, 10),
          title: "Receipt: northwind-careers.co.uk",
          body:
            "Your domain northwind-careers.co.uk has been extended automatically for 1 year and is now registered " +
            "until 24 October 2027. £9.49 was charged to the Visa ending 0612 on 24 October 2026.",
        }),
      };
    },
  },
  {
    // Shares the topic word "discount"; decoy: the approval rule was lifted.
    name: "deal-desk-approval",
    build: (c) => {
      const [client] = c.clients(1);
      const [desk, by] = c.colleagues(2);
      return {
        text: `Send ${client!.first} at ${client!.org} the order form with the 15% discount we agreed.`,
        detail:
          `Since Monday 26 October 2026, any discount above 12% needs deal-desk sign-off from ${desk!.full} before ` +
          "paperwork goes out, so the 15% needs approval first.",
        hidden: chat(
          c.ta,
          "sales",
          [
            {
              who: desk!,
              when: at(10, 26, 9, 4),
              text:
                "Policy change effective today (Mon 26 Oct): any discount above 12% needs deal-desk sign-off from me " +
                "before paperwork goes to the customer. I usually turn approvals round in 2 working days.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "sales",
          [
            {
              who: desk!,
              when: at(10, 23, 9, 4),
              text:
                "The temporary rule that any discount above 12% needs deal-desk sign-off ends today (Fri 23 Oct). " +
                "From Monday reps can approve up to 20% themselves again.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares the vendor's organisation name only; decoy: another vendor corrected its bill.
    name: "vendor-bill-correction",
    build: (c) => {
      const [v, w] = c.vendors(2);
      const wrong = `INV-${c.r.int(10000, 99999)}`;
      const right = `INV-${c.r.int(10000, 99999)}`;
      const body = (org: string) => [
        `Please disregard ${wrong}, the bill ${org} sent you on the 21st: it double-counted your seats.`,
        `The corrected one is ${right} for £3,840.00 (not £7,680.00) and is attached; apologies for the confusion.`,
      ];
      return {
        text: `Pay the ${v!.org} invoice for October.`,
        detail:
          `${v!.org} said ${wrong} was issued in error (it double-counted seats); pay the corrected ${right} for ` +
          "£3,840.00, not £7,680.00.",
        hidden: mail(c, c.ta, {
          from: v!,
          to: c.user,
          when: at(10, 23, 14, 20),
          title: `Correction: ${wrong}`,
          body: body(v!.org!),
          corporate: true,
        }),
        decoy: mail(c, c.tb, {
          from: w!,
          to: c.user,
          when: at(10, 23, 14, 20),
          title: `Correction: ${wrong}`,
          body: body(w!.org!),
          corporate: true,
        }),
      };
    },
  },
  {
    // No shared word (ISO date, no "team" or "offsite"); decoy: the all-hands moved to another date.
    name: "offsite-allhands",
    build: () => ({
      text: "Book the private room at Rochelle Canteen for the team offsite on 12 November.",
      detail:
        "Thursday 12 November 2026 clashes with the mandatory in-person company all-hands / annual kickoff, " +
        "10:00-16:00 at the Shoreditch office.",
      hidden: event({
        title: "Annual kickoff & all-hands (in person, mandatory)",
        start: at(11, 12, 10),
        when: "2026-11-12, 10:00-16:00",
        where: "Shoreditch HQ, 4th floor",
        notes: "Whole company in person. No external meetings for any department that day.",
        edited: at(10, 5, 11),
      }),
      decoy: event({
        title: "Annual kickoff & all-hands (in person, mandatory)",
        start: at(11, 19, 10),
        when: "2026-11-19, 10:00-16:00",
        where: "Shoreditch HQ, 4th floor",
        notes: "Moved from 2026-11-12 after the AV supplier fell through. Whole company in person.",
        edited: at(10, 21, 11),
      }),
    }),
  },
  {
    // Shares the new starter's name only; decoy: kit ordered for a different starter. Hidden: already ordered.
    name: "starter-laptop",
    build: (c) => {
      const [starter, other] = c.r.sample(STARTERS, 2);
      const [it, by] = c.colleagues(2);
      const po = `PO-${c.r.int(4000, 4999)}`;
      return {
        text: `Order a laptop for ${starter}, who joins us on Monday 9 November.`,
        detail:
          `${it!.full} already ordered a 14-inch MacBook Pro for ${starter} (${po}), arriving Thursday 5 November; ` +
          "ordering another would duplicate it.",
        hidden: chat(
          c.ta,
          "it-requests",
          [
            {
              who: it!,
              when: at(10, 23, 15, 47),
              text: `${starter}'s kit is sorted: 14" MacBook Pro on ${po}, arriving Thu 5/11, imaged by the Fri.`,
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "it-requests",
          [
            {
              who: it!,
              when: at(10, 23, 15, 47),
              text: `${other}'s kit is sorted: 14" MacBook Pro on ${po}, arriving Thu 12/11 for the 16th.`,
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares the topic word "claims"; decoy: the cut-off is still ahead.
    name: "expenses-cutoff",
    build: (c) => {
      const [f] = c.colleagues(1);
      return {
        text: "Submit my expense claim for the client dinner on 20 October: £184 at Hoppers.",
        detail:
          "The cut-off for this month's expense claims was Sunday 25 October 2026, so a claim submitted now is paid " +
          "in the 30 November payroll, not this month's.",
        hidden: mail(c, c.ta, {
          from: f!,
          to: c.user,
          when: at(10, 26, 11, 30),
          title: "Payroll reminder",
          body: [
            "Reminder that the cut-off for this month's claims was Sunday 25/10.",
            "Anything submitted from now on will be reimbursed in the 30 November payroll rather than this one.",
          ],
          corporate: true,
        }),
        decoy: mail(c, c.tb, {
          from: f!,
          to: c.user,
          when: at(10, 26, 11, 30),
          title: "Payroll reminder",
          body: [
            "Reminder that the cut-off for this month's claims is Thursday 29/10 at noon.",
            "Anything in before then is reimbursed in this month's payroll on the 30th.",
          ],
          corporate: true,
        }),
      };
    },
  },
  {
    // No shared word ("roadworthiness test", a plate); decoy: the test is still due. Hidden: already passed.
    name: "car-mot",
    build: (c) => {
      const area = c.r.token("ABCDEFGHKLMNPRSTVWY", 2);
      const plate = `${area}${c.r.int(15, 23)} ${c.r.token("ABCDEFGHJKLMNPRSTVWXYZ", 3)}`;
      const garage = bot("Kwik Fit", "noreply@kwik-fit.com");
      return {
        text: "Book the car in for its MOT.",
        detail:
          `The car (${plate}) already passed its MOT at Kwik Fit Walthamstow on 22 October 2026; the next one is ` +
          "not due until 21 October 2027.",
        hidden: notice(c, c.ta, {
          from: garage,
          when: at(10, 22, 15, 5),
          title: `Test result for ${plate}`,
          body:
            `Vehicle ${plate} passed its annual roadworthiness test at Kwik Fit Walthamstow on 22/10/2026 with no ` +
            "advisories. Next test due by 21/10/2027.",
        }),
        decoy: notice(c, c.tb, {
          from: garage,
          when: at(10, 12, 15, 5),
          title: `Reminder for ${plate}`,
          body:
            `Vehicle ${plate} is due its annual roadworthiness test by 09/11/2026. Slots at Kwik Fit Walthamstow ` +
            "are available most weekdays.",
        }),
      };
    },
  },
  {
    // Shares the name Tom only; decoy: Tom is free all month.
    name: "trainer-away",
    build: (c) => {
      const tom = c.role("personal trainer", ["Tom", "Bradley"]);
      return {
        text: "Book three more sessions with Tom for next month.",
        detail:
          "Tom Bradley is away from Monday 9 to Sunday 22 November 2026 on his Level 4 course in Loughborough, so " +
          "November slots are only possible 2-6 November or from 23 November.",
        hidden: mail(c, c.ta, {
          from: tom,
          to: c.user,
          when: at(10, 24, 12, 0),
          title: "Heads up",
          body: [
            "I'm away from Mon 9 Nov to Sun 22 Nov doing my Level 4 course in Loughborough, so I'm not training " +
              "anyone in that stretch.",
            "Back on the 23rd.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: tom,
          to: c.user,
          when: at(10, 24, 12, 0),
          title: "Heads up",
          body: [
            "My Level 4 course in Loughborough got pushed to March, so I'm around every weekday in November, " +
              "mornings and evenings.",
            "Just send me dates.",
          ],
        }),
      };
    },
  },
  {
    // Shares the client's name only; decoy: a different client is on leave.
    name: "client-leave",
    build: (c) => {
      const [a, b] = c.clients(2);
      const [cov] = c.r.sample(COVER, 1);
      const auto = (p: Person): string[] => [
        "I'm on parental leave from Friday 30 October until Monday 4 January 2027 with no access to email.",
        `For anything on the ${p.org} account please contact ${cov} (${cov!.split(" ")[0]!.toLowerCase()}@` +
          `${p.email.split("@")[1]}).`,
      ];
      return {
        text: `Set up lunch with ${a!.full} next Wednesday to talk about the renewal.`,
        detail:
          `${a!.full} is on parental leave from 30 October 2026 until 4 January 2027 (auto-reply); ${cov} is ` +
          `covering the ${a!.org} account.`,
        hidden: mail(c, c.ta, {
          from: a!,
          to: c.user,
          when: at(10, 26, 13, 2),
          title: "Automatic reply: Q4 check-in",
          body: auto(a!),
          corporate: true,
        }),
        decoy: mail(c, c.tb, {
          from: b!,
          to: c.user,
          when: at(10, 26, 13, 2),
          title: "Automatic reply: Q4 check-in",
          body: auto(b!),
          corporate: true,
        }),
      };
    },
  },
  {
    // Shares the vendor's organisation name only; decoy: legal cleared the paperwork.
    name: "dpa-hold",
    build: (c) => {
      const [v] = c.vendors(1);
      const [legal, by] = c.colleagues(2);
      return {
        text: `Countersign the ${v!.org} data processing agreement and send it back to them today.`,
        detail:
          `Legal (${legal!.full}) said not to sign the ${v!.org} DPA yet: clause 9 allows sub-processors outside ` +
          "the UK/EEA without notice, and redlines from Friday 23 October are awaiting their reply.",
        hidden: chat(
          c.ta,
          "legal",
          [
            {
              who: legal!,
              when: at(10, 26, 10, 18),
              text:
                `Hold off on the ${v!.org} paperwork please. Clause 9 lets them move personal records to ` +
                "sub-processors outside the UK/EEA without telling us. My redlines went over on Fri 23/10 and we're " +
                "still waiting on them.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "legal",
          [
            {
              who: legal!,
              when: at(10, 26, 10, 18),
              text:
                `Reviewed the ${v!.org} paperwork: clause 9 keeps sub-processors inside the UK/EEA and they agreed ` +
                "our liability cap. Fine to execute as is from my side.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares the event name; decoy: last year's pass. Hidden: a colleague already bought the pass.
    name: "summit-pass",
    build: (c) => {
      const [buyer] = c.colleagues(1);
      const order = `ASE-${c.r.int(100000, 999999)}`;
      const tix = bot("Eventbrite", "orders@eventbrite.com");
      return {
        text: "Register me for the Alliances Summit in Amsterdam on 3-4 December.",
        detail:
          `Robin is already registered: ${buyer!.full} bought a Full Pass for Alliances Summit Europe 2026 ` +
          `(3-4 December) on 20 October, order ${order}.`,
        hidden: notice(c, c.ta, {
          from: tix,
          when: at(10, 20, 16, 41),
          title: `Order confirmed: ${order}`,
          body:
            "1 x Full Pass, Alliances Summit Europe 2026, RAI Centre, 3-4 Dec 2026.\nAttendee: Robin Carter\n" +
            `Purchased by: ${buyer!.full} (${buyer!.email}) on 20 Oct 2026.`,
        }),
        decoy: notice(c, c.tb, {
          from: tix,
          when: at(10, 20, 16, 41, 2025),
          title: `Order confirmed: ${order}`,
          body:
            "1 x Full Pass, Alliances Summit Europe 2025, Fira Gran Via, 4-5 Dec 2025.\nAttendee: Robin Carter\n" +
            `Purchased by: ${buyer!.full} (${buyer!.email}) on 20 Oct 2025.`,
        }),
      };
    },
  },
  {
    // No shared word; decoy: the minimum term already ended.
    name: "broadband-exit-fee",
    build: (c) => {
      const isp = bot("Lumen Home", "account@lumenhome.co.uk");
      return {
        text: "Move our broadband over to that cheaper Zest Fibre deal.",
        detail:
          "The current Lumen Home internet contract has a minimum term until 14 March 2027; leaving now costs an " +
          "early exit fee of £187.40.",
        hidden: notice(c, c.ta, {
          from: isp,
          when: at(10, 14, 8, 0),
          title: "Your annual plan summary",
          body:
            "Your minimum term on Lumen Home Internet 500 runs until 14 March 2027. If you end your plan before " +
            "then, an early exit fee of £187.40 applies.",
        }),
        decoy: notice(c, c.tb, {
          from: isp,
          when: at(10, 14, 8, 0),
          title: "Your annual plan summary",
          body:
            "Your minimum term on Lumen Home Internet 500 ended on 14 March 2026. You are now on a rolling monthly " +
            "plan and can leave at any time with 30 days' notice and no exit fee.",
        }),
      };
    },
  },
  {
    // Shares the name Ellie only; decoy: Mum moved, not Ellie.
    name: "ellie-new-address",
    build: (c) => {
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      const mum = c.role("mum", ["Ruth", "Carter"]);
      return {
        text: "Order flowers for Ellie's birthday on Saturday, from the usual florist.",
        detail:
          "Ellie moved on 24 October 2026: delivery must go to Flat 2, 14 Kestrel Road, Bristol BS6 5AJ, not her " +
          "old Clifton flat.",
        hidden: mail(c, c.ta, {
          from: ellie,
          to: c.user,
          when: at(10, 24, 19, 22),
          title: "We got the keys!",
          body: [
            "From Sat 24 Oct our address is Flat 2, 14 Kestrel Road, Bristol BS6 5AJ.",
            "The Clifton place has been handed back, so nothing to there any more please!",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: mum,
          to: c.user,
          when: at(10, 24, 19, 22),
          title: "We got the keys!",
          body: [
            "From Sat 24 Oct my address is Flat 2, 14 Kestrel Road, Bristol BS6 5AJ, round the corner from Ellie.",
            "The old house is handed back, so nothing to there any more please!",
          ],
        }),
      };
    },
  },
  {
    // Shares the name Owen only; decoy: last year's return. Hidden: already filed.
    name: "tax-already-filed",
    build: (c) => {
      const owen = c.role("accountant", ["Owen", "Price"]);
      const ref = c.r.token("0123456789", 10);
      return {
        text: "Send Owen my P60 and the rental figures so he can do my tax return.",
        detail:
          `Owen Price already filed Robin's 2025-26 Self Assessment with HMRC on Monday 19 October 2026 ` +
          `(ref ${ref}); £2,316.80 is due by 31 January 2027.`,
        hidden: mail(c, c.ta, {
          from: owen,
          to: c.user,
          when: at(10, 19, 17, 45),
          title: "2025-26 Self Assessment",
          body: [
            `Your 2025-26 Self Assessment went in to HMRC today (submission reference ${ref}).`,
            "Balance due by 31 January 2027: £2,316.80. I worked from the payslips and lettings statement you " +
              "emailed in September.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: owen,
          to: c.user,
          when: at(1, 14, 17, 45),
          title: "2024-25 Self Assessment",
          body: [
            `Your 2024-25 Self Assessment went in to HMRC today (submission reference ${ref}).`,
            "Balance due by 31 January 2026: £1,904.10. I worked from the payslips and lettings statement you " +
              "emailed in December.",
          ],
        }),
      };
    },
  },
  {
    // Shares the topic word "admin"; decoy: Robin is an approver and may grant it.
    name: "crm-admin-freeze",
    build: (c) => {
      const [who, sec, by] = c.colleagues(3);
      return {
        text: `Give ${who!.first} admin access in HubSpot.`,
        detail:
          "New admin rights on production systems (CRM included) are frozen until the SOC 2 (Delta) fieldwork ends " +
          `on Friday 20 November 2026; exceptions need the CISO's written sign-off (posted by ${sec!.full}).`,
        hidden: chat(
          c.ta,
          "security",
          [
            {
              who: sec!,
              when: at(10, 21, 9, 33),
              text:
                "Until Delta fieldwork wraps on Fri 20 Nov: no new admin rights on any production system, CRM " +
                "included. Exceptions need written sign-off from the CISO.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "security",
          [
            {
              who: sec!,
              when: at(10, 21, 9, 33),
              text:
                "Reminder: Robin Carter and the team leads are approvers for CRM admin rights, so grant directly and " +
                "just log it in #it-requests.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares the topic word "senior"; decoy: the band sheet covers a different role.
    name: "offer-salary-band",
    build: (c) => {
      const [cand] = c.r.sample(CANDIDATES, 1);
      const [hr] = c.colleagues(1);
      const doc = (rows: string): Plant => ({
        sourceId: "drive",
        kind: "doc",
        title: "Salary bands 2026-27",
        text:
          `Salary bands 2026-27 (approved by the exec team on 15 Oct 2026; owner ${hr!.full})\n\n${rows}\n\n` +
          "Offers above the top of a band need CEO approval before they are made.",
        updatedAt: at(10, 15, 14),
      });
      return {
        text: `Draft the offer letter for ${cand} for the senior PM role at £68,000.`,
        detail:
          "The approved band for Senior Product Manager is £58,000-£64,000; £68,000 is above it and needs CEO " +
          "approval before the offer is made.",
        hidden: doc("Product Manager: £46,000-£55,000\nSenior Product Manager: £58,000-£64,000"),
        decoy: doc("Data Engineer: £50,000-£60,000\nSenior Data Engineer: £60,000-£72,000"),
      };
    },
  },
  {
    // No shared word (ISO date, no event name); decoy: the same pickup on another Sunday.
    name: "marshal-sleepover-pickup",
    build: () => {
      const entry = (day: number, edited: number) =>
        event({
          title: "Pick Maya up from Brownies sleepover",
          start: at(11, day, 8, 30),
          when: `2026-11-${String(day).padStart(2, "0")}, 08:30-09:30`,
          where: "Hampstead Scout Hut",
          notes: "Bring her sleeping bag back. Collection is 08:30 sharp, leaders leave at 09:30.",
          edited,
        });
      return {
        text: "Sign me up as a volunteer marshal for the Hackney Half on Sunday 8 November.",
        detail:
          "On Sunday 8 November 2026, 08:30-09:30, Robin has to pick Maya up from the Brownies sleepover in " +
          "Hampstead, which clashes with a morning marshal shift.",
        hidden: entry(8, at(10, 18, 20)),
        decoy: entry(15, at(10, 18, 20)),
      };
    },
  },
  {
    // Shares the project name Cobalt only; decoy: the cutover was postponed.
    name: "cobalt-cutover-dinner",
    build: (c) => {
      const [lead, by] = c.colleagues(2);
      return {
        text: "Book a table for eight for the Cobalt team dinner on Thursday 5 November.",
        detail:
          "The Cobalt billing cutover is now on Thursday 5 November 2026, 19:00-23:00, with the whole squad needed " +
          `online (${lead!.full}), which clashes with the dinner.`,
        hidden: chat(
          c.ta,
          "cobalt",
          [
            {
              who: lead!,
              when: at(10, 26, 17, 3),
              text:
                "Cobalt cutover has been rescheduled to 05/11, 19:00-23:00. I need all of you online for the switch " +
                "and the smoke tests afterwards, so please keep that evening clear.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "cobalt",
          [
            {
              who: lead!,
              when: at(10, 26, 17, 3),
              text:
                "Cobalt cutover is postponed to January while finance re-runs reconciliation, so no evening work for " +
                "anyone this side of Christmas.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares the topic word "overpayment"; decoy: no limit applies any more.
    name: "mortgage-allowance",
    build: (c) => {
      const lender = bot("Harbourside Building Society", "statements@harbourside.co.uk");
      return {
        text: "Make a £10,000 overpayment on the mortgage this month.",
        detail:
          "Only £2,400 of the yearly 10% allowance is left (£18,000 of £20,400 used); the other £7,600 of a " +
          "£10,000 overpayment would carry a 3% early repayment charge (about £228).",
        hidden: notice(c, c.ta, {
          from: lender,
          when: at(10, 1, 6, 0),
          title: "Your annual home loan statement",
          body:
            "During your fixed rate (until 31 May 2028) you can overpay up to 10% of your balance each year " +
            "without charge. Allowance used this year: £18,000 of £20,400. Any overpayment beyond your remaining " +
            "£2,400 carries an early repayment charge of 3%.",
        }),
        decoy: notice(c, c.tb, {
          from: lender,
          when: at(10, 1, 6, 0),
          title: "Your annual home loan statement",
          body:
            "Your fixed rate ended on 1 September 2026 and you are now on our standard variable rate. An " +
            "overpayment of any size can be made at any time without charge.",
        }),
      };
    },
  },
  {
    // Shares the topic word "membership"; decoy: it ends soon with auto-renewal off. Hidden: already renewed.
    name: "climbing-membership",
    build: (c) => {
      const wall = bot("The Arch Bouldering", "members@archbouldering.co.uk");
      return {
        text: "Renew my climbing wall membership for another year.",
        detail:
          "The membership at The Arch already rolled over automatically on 21 October 2026 (£540, valid until " +
          "20 October 2027); renewing again would pay twice.",
        hidden: notice(c, c.ta, {
          from: wall,
          when: at(10, 21, 5, 0),
          title: "Payment received",
          body:
            "Your annual membership rolled over on 21 October 2026. £540.00 was charged to the Visa ending 0612 " +
            "and your card is valid until 20 October 2027.",
        }),
        decoy: notice(c, c.tb, {
          from: wall,
          when: at(10, 21, 5, 0),
          title: "Your membership is ending soon",
          body:
            "Your annual membership ends on 15 November 2026. Automatic rollover is switched off on your account, " +
            "so you'll need to rejoin at reception or online to keep your access.",
        }),
      };
    },
  },
  {
    // Shares the client's name and organisation only; decoy: a different contact left a different client.
    name: "export-contact-left",
    build: (c) => {
      const [a, b] = c.clients(2);
      const [alt] = c.r.sample(COVER, 1);
      const record = (p: Person): Plant => ({
        sourceId: "crm",
        kind: "contact",
        title: p.full,
        text:
          `Contact: ${p.full}\nCompany: ${p.org}\nEmail: ${p.email}\nLifecycle: former contact\n` +
          `Note (2026-10-16): Left ${p.org} to join a competitor. ${alt} is now primary contact for the account. ` +
          "Do not send account data to their old or personal addresses.",
        updatedAt: at(10, 16, 15),
      });
      return {
        text: `Email ${a!.full} the usage data export for ${a!.org} that they asked for.`,
        detail:
          `${a!.full} left ${a!.org} on 16 October 2026 for a competitor (CRM); ${alt} is now the primary contact, ` +
          "so the export must not go to them.",
        hidden: record(a!),
        decoy: record(b!),
      };
    },
  },
  {
    // No shared word; decoy: the blackout covers Finance only.
    name: "leave-blackout",
    build: (c) => {
      const [boss, by] = c.colleagues(2);
      return {
        text: "Book me off from 14 to 18 December.",
        detail:
          "There's a year-end leave blackout 7-18 December 2026 covering Partnerships; leave in that window needs " +
          `${boss!.full}'s personal approval.`,
        hidden: chat(
          c.ta,
          "partnerships",
          [
            {
              who: boss!,
              when: at(10, 20, 8, 55),
              text:
                "Reminder: the year-end close blackout runs 07/12-18/12 for Finance, Sales and Partnerships. No " +
                "annual leave gets approved in that window except by me personally.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "partnerships",
          [
            {
              who: boss!,
              when: at(10, 20, 8, 55),
              text:
                "Reminder: the year-end close blackout runs 07/12-18/12 for Finance only this year. Sales and " +
                "Partnerships can take annual leave as normal.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // No shared word ("cake stall", "the 30th"); decoy: anything homemade is welcome.
    name: "bake-sale-nut-free",
    build: (c) => {
      const t = c.role("Maya's teacher", ["Mrs", "Daley"]);
      return {
        text: "Tell the PTA I'll bring two trays of brownies to the school bake sale on Friday.",
        detail:
          "The stall on Friday 30 October is strictly nut-free (two Year 3 children have severe allergies) and every " +
          "item needs an ingredients label.",
        hidden: mail(c, c.ta, {
          from: t,
          to: c.user,
          when: at(10, 23, 16, 10),
          title: "Cake stall on the 30th",
          body: [
            "A reminder for the cake stall on the 30th: everything must be completely nut-free (no nuts, peanut " +
              "butter, Nutella or praline), as we have two children with severe allergies in Year 3.",
            "Every item also needs a label listing its ingredients.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: t,
          to: c.user,
          when: at(10, 23, 16, 10),
          title: "Cake stall on the 30th",
          body: [
            "Thank you to everyone offering cakes for the stall on the 30th: anything homemade is welcome.",
            "Please just drop it at the hall by 15:00.",
          ],
        }),
      };
    },
  },
  {
    // No shared word ("Sat 7 Nov 23:00 UTC", Postgres); decoy: the maintenance already happened.
    name: "migration-maintenance",
    build: (c) => {
      const [v] = c.vendors(1);
      const host = bot(`${v!.org} Status`, `status@${v!.email.split("@")[1]}`);
      return {
        text: "Schedule the Atlas data migration cutover for Saturday night, 7 November.",
        detail:
          `The hosting provider (${v!.org}) has planned database maintenance from Saturday 7 November 23:00 to ` +
          "Sunday 8 November 05:00 UTC, with writes paused for up to 40 minutes, overlapping the cutover.",
        hidden: notice(c, c.ta, {
          from: host,
          when: at(10, 22, 12, 0),
          title: "Planned maintenance: London region",
          body:
            "Planned maintenance on London region managed Postgres clusters, Sat 7 Nov 23:00 UTC to Sun 8 Nov " +
            "05:00 UTC. Writes will be paused for up to 40 minutes and a failover may occur.",
        }),
        decoy: notice(c, c.tb, {
          from: host,
          when: at(10, 25, 6, 0),
          title: "Completed: London region",
          body:
            "Completed: planned maintenance on London region managed Postgres clusters, Sat 24 Oct 23:00 UTC to " +
            "Sun 25 Oct 05:00 UTC. No further work is planned this quarter.",
        }),
      };
    },
  },
  {
    // Shares Leila's name and the book's title only; decoy: she bought next month's pick. Hidden: already bought.
    name: "book-club-copies",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      return {
        text: "Order two copies of The Dispossessed for book club, one for me and one for Leila.",
        detail:
          "Leila already bought both copies of The Dispossessed at Daunt Books on Saturday 24 October; Robin's is " +
          "in her bag.",
        hidden: mail(c, c.ta, {
          from: leila,
          to: c.user,
          when: at(10, 24, 17, 31),
          title: "Sorted",
          body: ["Got us both The Dispossessed at Daunt today, yours is in my bag.", "Pay me back in wine."],
        }),
        decoy: mail(c, c.tb, {
          from: leila,
          to: c.user,
          when: at(10, 24, 17, 31),
          title: "Sorted",
          body: [
            "Got us both Piranesi at Daunt today for December's meeting, yours is in my bag.",
            "Pay me back in wine.",
          ],
        }),
      };
    },
  },
  {
    // Shares the topic word "cataract"; decoy: the date was confirmed unchanged.
    name: "mum-surgery-moved",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      return {
        text: "Put Mum's cataract operation on the family calendar for Thursday 12 November.",
        detail:
          "Mum's (Ruth Carter's) surgery has moved from 12 November to Thursday 26 November 2026, arriving 07:30 at " +
          "Moorfields.",
        hidden: mail(c, c.ta, {
          from: mum,
          to: c.user,
          when: at(10, 26, 14, 48),
          title: "Moorfields rang",
          body: [
            "My cataract surgery has moved to the 26th of November because the surgeon is away on the 12th.",
            "I have to be there for 07:30. Could one of you drive me?",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: mum,
          to: c.user,
          when: at(10, 26, 14, 48),
          title: "Moorfields rang",
          body: [
            "Just to confirm my cataract surgery: the 12th stays as planned, I need to be there for 08:00.",
            "Could one of you drive me?",
          ],
        }),
      };
    },
  },
  {
    // Shares the topic word "website"; decoy: the freeze was lifted early.
    name: "website-freeze",
    build: (c) => {
      const [lead, by] = c.colleagues(2);
      return {
        text: "Publish the new partner pricing page on the website tomorrow.",
        detail:
          "There's a Beacon relaunch freeze on the website and CMS from Wednesday 28 October to Tuesday 3 November " +
          `2026; publishing then needs ${lead!.full}'s approval.`,
        hidden: chat(
          c.ta,
          "beacon",
          [
            {
              who: lead!,
              when: at(10, 26, 11, 20),
              text:
                "Beacon relaunch: website code & content freeze from Wed 28/10 to Tue 3/11 inclusive. Nothing goes " +
                "live on the CMS without my OK.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "beacon",
          [
            {
              who: lead!,
              when: at(10, 26, 11, 20),
              text:
                "Beacon relaunch shipped this morning, so the website freeze is lifted early. CMS publishing is open " +
                "as normal.",
            },
          ],
          by!,
        ),
      };
    },
  },
];

/**
 * Plant one item per template (the real one for `hidden`, the decoy for `control`) and return the tasks. Builds both
 * items every time so RNG draws, and so the people and numbers in each task, match across the two variants.
 */
export function plantHeldout13(world: World, seed: number, variant: "hidden" | "control"): HiddenTask[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 1_313);
  const by = (rel: string) => world.people.filter((p) => p.relation === rel);
  const pools = { colleague: by("colleague"), client: by("client"), vendor: by("vendor") };
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
  const suite = variant === "hidden" ? "heldout13" : "heldout13-control";
  const tasks: HiddenTask[] = [];
  for (const t of TEMPLATES) {
    const ta = r.fork();
    const tb = r.fork();
    const ctx: Ctx = {
      r,
      ta,
      tb,
      user: world.user,
      colleague: () => draw(pools.colleague, 1, standIn("Alex", "Morgan", "colleague", world.user.company))[0]!,
      colleagues: (k) => draw(pools.colleague, k, standIn("Alex", "Morgan", "colleague", world.user.company)),
      clients: (k) => draw(pools.client, k, standIn("Jordan", "Blake", "client", "Globex")),
      vendors: (k) => draw(pools.vendor, k, standIn("Casey", "Shaw", "vendor", "Cyberdyne")),
      role: (role, [first, last]) =>
        world.people.find((p) => p.role === role) ?? standIn(first, last, role === "friend" ? "friend" : "service"),
    };
    const spec = t.build(ctx);
    const p = variant === "hidden" ? spec.hidden : spec.decoy;
    // The same ref in both variants, so the item id does not tell a grader or a model which variant it is.
    const ref = `h13-${t.name}`;
    world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    tasks.push({ id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}

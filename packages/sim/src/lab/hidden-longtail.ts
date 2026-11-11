/**
 * The long-tail suite (P7, D873; B5 in docs/research/weak-points-1111.md): every fact sits in a rarely used connector
 * (rare-sources.ts: notes, whatsapp, bank, health, school, trips, residents, tasks), never in the world's five. It
 * prices the decisions about sources a user seldom touches: the weekly sweep of unused sources (D356), any dormancy
 * rule (D602, removed because no suite held a fact in such a source) and the earn rule at many sources. Written by
 * P7 for tuning and measurement (not blind): tune on it as on train.
 *
 * 24 templates, three per life area (work, family, health, money, travel, home, admin, social, in that order), each a
 * request, the consideration a good answer raises, a planted item stating it (`hidden`) and a near-miss in the same
 * connector that does not apply (`control`); `neutral` plants nothing. Decoys: (a) resolved or expired, (b) another
 * person or date, (c) the condition is met. Connectors: notes 5, whatsapp 4, tasks 4, residents 3, school 2, health 2,
 * bank 2, trips 2. Requests mix imperatives with indirect forms ("I should…", "Can we…?"), since the suite is about
 * where the fact sits, not how the request is worded.
 *
 * On its own (the funnel, one request a session) every planted item is there from the backfill. Over days
 * (`days-calls.ts --suite train,longtail --arrive-days 1-10`) each planted item instead appears at its connector some
 * days before its request with no notice, so only a poll or a sweep of that connector finds it in time.
 *
 * Dates (2026 calendar, Date.UTC): Fri 30 Oct, Sat 31 Oct, Mon 2 Nov, Wed 4 Nov, Thu 5 Nov, Fri 6 Nov, Sat 7 Nov,
 * Mon 9 Nov, Tue 10 Nov, Wed 11 Nov, Sat 14 Nov, Mon 16 Nov, Fri 20 Nov, Sat 21 Nov.
 */
import { itemId } from "@eden/protocol";
import { addRareSources, RARE_SOURCES } from "../rare-sources";
import { Rng } from "../rng";
import type { ItemKind, Person, World } from "../world";
import type { HiddenTask } from "./hidden-context";

const at = (month: number, day: number, h = 9, min = 0) => Date.UTC(2026, month - 1, day, h, min);

interface Plant {
  sourceId: string;
  kind: ItemKind;
  title: string;
  text: string;
  updatedAt: number;
}

interface Spec {
  text: string;
  detail: string;
  hidden: Plant;
  decoy: Plant;
}

/** An item in a rare connector, of that connector's kind. */
const rare = (sourceId: string, title: string, text: string, updatedAt: number): Plant => {
  const src = RARE_SOURCES[sourceId];
  if (!src) throw new Error(`not a rare source: ${sourceId}`);
  return { sourceId, kind: src.kind, title, text, updatedAt };
};

/** A WhatsApp excerpt as the app exports it: "[date, time] Name: text". */
const wa = (lines: [Person | string, string, number][]) =>
  lines
    .map(([who, text, t]) => {
      const d = new Date(t);
      const stamp = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/2026, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      return `[${stamp}] ${typeof who === "string" ? who : who.first}: ${text}`;
    })
    .join("\n");

interface Ctx {
  colleague: () => Person;
  client: () => Person;
}

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  // notes; decoy (b): another client's diet.
  {
    name: "lt-client-lunch-coeliac",
    build: (c) => {
      const p = c.client();
      const q = c.client();
      const note = (who: Person) =>
        rare(
          "notes",
          "People",
          `${who.first} ${who.last} (${who.org ?? "client"}): coeliac, properly strict, not just "avoids gluten". ` +
            "Last lunch the place had nothing safe and it was awkward. Kids: two, football mad.",
          at(9, 18, 21, 10),
        );
      return {
        text: `Book lunch with ${p.full} next week somewhere nice near the office.`,
        detail: `The user's own note says ${p.full} is strictly coeliac, so the restaurant needs safe gluten-free food.`,
        hidden: note(p),
        decoy: note(q.full === p.full ? { ...q, first: "Dana", last: "Okafor", full: "Dana Okafor" } : q),
      };
    },
  },
  // whatsapp; decoy (b): away the week before.
  {
    name: "lt-launch-review-reviewer-away",
    build: (c) => {
      const p = c.colleague();
      const msg = (week: string) =>
        rare(
          "whatsapp",
          p.full,
          wa([
            [
              p,
              `random one but I'm off the whole week of ${week}, my brother's wedding in Lisbon 🎉`,
              at(10, 14, 19, 2),
            ],
            [p, "back on the Monday after, no laptop", at(10, 14, 19, 3)],
          ]),
          at(10, 14, 19, 3),
        );
      return {
        text: `Can we move the launch review with ${p.first} to Monday 9 November?`,
        detail: `${p.full} said on WhatsApp on 14 October that they are away the whole week of 9 November (a wedding in Lisbon).`,
        hidden: msg("9 Nov"),
        decoy: msg("26 Oct"),
      };
    },
  },
  // tasks; decoy (a): last quarter's cutoff, done.
  {
    name: "lt-expenses-q3-cutoff",
    build: () => ({
      text: "I should submit my September expenses at some point.",
      detail: "The user's to-do list says finance's cutoff for Q3 expense claims is Friday 30 October.",
      hidden: rare(
        "tasks",
        "Submit Q3 expenses",
        "Due Fri 30 Oct. Finance: anything after the Q3 cutoff rolls into next year's budget and needs director sign-off.",
        at(10, 2, 8, 30),
      ),
      decoy: rare(
        "tasks",
        "Submit Q2 expenses",
        "Completed 28 Jul. Q2 cutoff was 31 Jul; receipts uploaded to Concur.",
        at(7, 28, 17, 45),
      ),
    }),
  },
  // ── family ──
  // school; decoy (b): another week.
  {
    name: "lt-coast-trip-assessment-week",
    build: () => {
      const letter = (dates: string, day: string) =>
        rare(
          "school",
          "Year 3 assessment week",
          `Dear parents, Year 3 assessments take place ${dates}. Please avoid any absence that week; the reading ` +
            `assessment is on ${day} and cannot be rescheduled. Thank you for your support. Mrs Patel, Year 3 lead`,
          at(10, 9, 15, 0),
        );
      return {
        text: "Let's take the kids for a day at the coast on Friday 6 November.",
        detail:
          "The school wrote that Year 3 assessment week is 2–6 November and the reading assessment on Friday 6 November cannot be moved.",
        hidden: letter("Monday 2 to Friday 6 November", "Friday 6 November"),
        decoy: letter("Monday 16 to Friday 20 November", "Friday 20 November"),
      };
    },
  },
  // whatsapp; decoy (b): the following Saturday.
  {
    name: "lt-padella-mum-visiting",
    build: () => {
      const chat = (day: string) =>
        rare(
          "whatsapp",
          "Family",
          wa([
            [
              "Mum",
              `we've booked the train! coming down ${day}, arriving about 6, staying two nights`,
              at(10, 19, 20, 15),
            ],
            ["Mum", "you said you'd cook, I'm holding you to it 😄", at(10, 19, 20, 16)],
            ["Dad", "👍", at(10, 19, 20, 40)],
          ]),
          at(10, 19, 20, 40),
        );
      return {
        text: "Book a table for four at Padella on Saturday 14 November, 7pm.",
        detail:
          "Mum said in the family WhatsApp on 19 October that she and Dad arrive on Saturday 14 November at about 6 and expect the user to cook.",
        hidden: chat("Sat 14th"),
        decoy: chat("Sat 21st"),
      };
    },
  },
  // notes; decoy (b): bought for someone else.
  {
    name: "lt-lego-gift-already-bought",
    build: () => {
      const note = (who: string) =>
        rare(
          "notes",
          "Birthdays",
          `${who}: Lego Botanical orchid set, already bought, top of the wardrobe. Still need a card.`,
          at(10, 3, 22, 5),
        );
      return {
        text: "Order the Lego Botanical orchid set for Maya's birthday.",
        detail:
          "The user's birthdays note says the Lego orchid set for Maya is already bought (in the wardrobe); only a card is needed.",
        hidden: note("Maya (8 Nov)"),
        decoy: note("Rosie (Aug, done)"),
      };
    },
  },
  // ── health ──
  // health; decoy (c): the review is done.
  {
    name: "lt-repeat-prescription-review",
    build: () => ({
      text: "Reorder my repeat prescription.",
      detail:
        "The GP app says the repeat prescription needs a medication review with the practice pharmacist before it can be issued again.",
      hidden: rare(
        "health",
        "Your repeat prescription",
        "Your repeat prescription for sertraline 50mg is due for a medication review. It cannot be issued again until " +
          "you have had a review with the practice pharmacist. Book a review in the app or call the surgery.",
        at(10, 12, 7, 30),
      ),
      decoy: rare(
        "health",
        "Your repeat prescription",
        "Your medication review is complete. Your repeat prescription for sertraline 50mg can be ordered as normal.",
        at(10, 12, 7, 30),
      ),
    }),
  },
  // health; decoy (b): a week later.
  {
    name: "lt-breakfast-fasting-blood-test",
    build: (c) => {
      const p = c.colleague();
      const appt = (day: string) =>
        rare(
          "health",
          "Appointment confirmed",
          `Blood test with the practice nurse, ${day} at 08:40. Please fast for 12 hours beforehand (water only).`,
          at(10, 20, 11, 0),
        );
      return {
        text: `Set up breakfast with ${p.first} at 8 on Wednesday 4 November.`,
        detail: "The GP app has a blood test at 08:40 on Wednesday 4 November that needs 12 hours' fasting.",
        hidden: appt("Wednesday 4 November"),
        decoy: appt("Wednesday 11 November"),
      };
    },
  },
  // notes; decoy (a): an old note, cleared since.
  {
    name: "lt-half-marathon-physio",
    build: () => ({
      text: "Sign me up for the Hackney half marathon in December.",
      detail: "The user's physio note from 20 October says no running for eight weeks, then build up slowly.",
      hidden: rare(
        "notes",
        "Physio",
        "20 Oct: no running for 8 weeks, then build up slowly from 2 km. Swimming and bike fine. Exercises twice a day.",
        at(10, 20, 18, 20),
      ),
      decoy: rare(
        "notes",
        "Physio (spring)",
        "April: cleared to run again, no limits. Keep doing the calf raises.",
        at(4, 22, 18, 20),
      ),
    }),
  },
  // ── money ──
  // bank; decoy (c): closure cancelled.
  {
    name: "lt-council-tax-joint-account-closing",
    build: () => ({
      text: "Set up the council tax direct debit from the joint account.",
      detail:
        "The bank says the joint account will close on 5 November as requested, so regular payments should come from another account.",
      hidden: rare(
        "bank",
        "Your joint account is closing",
        "As requested, your joint account ending 2291 will close on 5 November. Please move any regular payments and " +
          "direct debits to another account before then.",
        at(10, 22, 10, 0),
      ),
      decoy: rare(
        "bank",
        "Your joint account",
        "Your request to close your joint account ending 2291 has been cancelled. The account stays open as normal.",
        at(10, 22, 10, 0),
      ),
    }),
  },
  // bank; decoy (b): a healthy balance.
  {
    name: "lt-builder-invoice-balance",
    build: () => {
      const alert = (bal: string, avail: string) =>
        rare(
          "bank",
          "Low balance",
          `Your current account balance is ${bal}. Payments over your available balance (${avail} including your ` +
            "arranged overdraft) will be declined.",
          at(10, 26, 18, 0),
        );
      return {
        text: "Pay the builder's £2,400 invoice today.",
        detail:
          "The bank warned on 26 October that the balance is £1,180 (£1,680 available with the overdraft), so a £2,400 payment would be declined.",
        hidden: alert("£1,180", "£1,680"),
        decoy: alert("£5,180", "£5,680"),
      };
    },
  },
  // tasks; decoy (a): last tax year.
  {
    name: "lt-isa-allowance-used",
    build: () => {
      const task = (year: string, done: string) =>
        rare("tasks", "ISA top-up", `${year}: ${done}. Allowance is £20k a tax year across all ISAs.`, at(9, 30, 9, 0));
      return {
        text: "I want to put £5,000 into my new Moneybox ISA.",
        detail:
          "The user's to-do says £18,000 already went into the Nationwide ISA this tax year, leaving £2,000 of the £20,000 allowance.",
        hidden: task("2026/27", "paid £18,000 into the Nationwide ISA already, £2k left until April"),
        decoy: task("2025/26", "paid £18,000 into the Nationwide ISA, done, new allowance from 6 April"),
      };
    },
  },
  // ── travel ──
  // trips; decoy (a): the old passport, renewed.
  {
    name: "lt-bangkok-passport-validity",
    build: () => ({
      text: "Book flights to Bangkok for late January.",
      detail:
        "The travel app's documents note says the passport expires on 14 March 2027, short of the six months' validity Thailand asks for.",
      hidden: rare(
        "trips",
        "Travel documents",
        "Passport no. 5XX expires 14 March 2027. Some countries need 6 months' validity on entry. EHIC/GHIC valid to 2029.",
        at(8, 30, 12, 0),
      ),
      decoy: rare(
        "trips",
        "Travel documents",
        "Old passport expired 2024; renewed, new one valid to 2036. GHIC valid to 2029.",
        at(8, 30, 12, 0),
      ),
    }),
  },
  // trips; decoy (c): approved.
  {
    name: "lt-new-york-esta-refused",
    build: () => ({
      text: "Should I book the New York trip for Thanksgiving week?",
      detail: "The travel app records that the user's ESTA was refused on 3 October and a visa interview is needed.",
      hidden: rare(
        "trips",
        "USA: entry",
        "ESTA application refused 3 Oct. You may apply for a visa at a US embassy (interview needed, waits of several weeks).",
        at(10, 3, 16, 0),
      ),
      decoy: rare(
        "trips",
        "USA: entry",
        "ESTA approved 3 Oct, valid for two years or until the passport expires.",
        at(10, 3, 16, 0),
      ),
    }),
  },
  // whatsapp; decoy (b): December.
  {
    name: "lt-lisbon-cat-sitter-away",
    build: () => {
      const chat = (when: string) =>
        rare(
          "whatsapp",
          "Ellie",
          wa([
            [
              "Ellie",
              `so sorry!! I can't do Pickle in ${when} anymore, I'm away for work the whole time`,
              at(10, 16, 21, 0),
            ],
            ["Ellie", "can do any other time though x", at(10, 16, 21, 1)],
          ]),
          at(10, 16, 21, 1),
        );
      return {
        text: "Book the Lisbon flights for 20 to 27 November.",
        detail:
          "Ellie, who looks after the cat, said on WhatsApp on 16 October that she cannot do it in November (away 18–30 Nov).",
        hidden: chat("Nov (18th-30th)"),
        decoy: chat("Dec (1st-12th)"),
      };
    },
  },
  // ── home ──
  // residents; decoy (b): another block.
  {
    name: "lt-washer-install-water-off",
    build: () => {
      const notice = (block: string) =>
        rare(
          "residents",
          `Water shut-off, ${block}`,
          `Water will be off in ${block} on Tuesday 10 November, 08:00-16:00, while the riser is replaced. Please ` +
            "do not book plumbing work that day.",
          at(10, 21, 9, 30),
        );
      return {
        text: "Have the new washing machine delivered and plumbed in on Tuesday 10 November.",
        detail:
          "The residents' portal says the water is off in the user's block (Block B) on Tuesday 10 November, 08:00–16:00.",
        hidden: notice("Block B"),
        decoy: notice("Block D"),
      };
    },
  },
  // residents; decoy (a): postponed.
  {
    name: "lt-sofa-delivery-lift-out",
    build: () => ({
      text: "Can we get the sofa delivered on Thursday 5 November?",
      detail:
        "The residents' portal says the lift is out of service from Monday 2 to Friday 6 November, with no large deliveries.",
      hidden: rare(
        "residents",
        "Lift refurbishment",
        "The lift will be out of service from Monday 2 to Friday 6 November for refurbishment. Deliveries of large " +
          "items will not be possible that week.",
        at(10, 15, 9, 0),
      ),
      decoy: rare(
        "residents",
        "Lift refurbishment",
        "The lift refurbishment planned for November has been postponed to January. The lift stays in service.",
        at(10, 15, 9, 0),
      ),
    }),
  },
  // tasks; decoy (c): consent received.
  {
    name: "lt-hallway-paint-consent",
    build: () => ({
      text: "Get someone round to paint the hallway dark green.",
      detail:
        "The user's to-do says the landlord must give written consent before any redecorating (tenancy clause 14).",
      hidden: rare(
        "tasks",
        "Ask landlord before decorating",
        "Tenancy cl. 14: no redecorating without the landlord's written consent. Email him first, he took ages last time.",
        at(9, 12, 10, 0),
      ),
      decoy: rare(
        "tasks",
        "Ask landlord before decorating",
        "Completed 3 Sep: written consent received for repainting (email), any colour.",
        at(9, 3, 10, 0),
      ),
    }),
  },
  // ── admin ──
  // tasks; decoy (a): licence back.
  {
    name: "lt-car-hire-licence-at-dvla",
    build: () => ({
      text: "Rent a car for the Cornwall weekend, 14–15 November.",
      detail:
        "The user's to-do says the driving licence went to the DVLA on 12 October for an address change; they keep it about three weeks.",
      hidden: rare(
        "tasks",
        "Driving licence address change",
        "Sent the licence to DVLA 12 Oct. They keep it ~3 weeks, sometimes longer. Chase if not back by 9 Nov.",
        at(10, 12, 13, 0),
      ),
      decoy: rare(
        "tasks",
        "Driving licence address change",
        "Done: new licence with the new address arrived 2 Oct.",
        at(10, 2, 13, 0),
      ),
    }),
  },
  // residents; decoy (a): last month's.
  {
    name: "lt-visitor-parking-suspended",
    build: () => {
      const notice = (month: string) =>
        rare(
          "residents",
          "Visitor parking",
          `Visitor parking permits are suspended for all of ${month} while the car park is resurfaced. Visitors will ` +
            "need to use the public car park on Mill Lane.",
          at(10, 1, 9, 0),
        );
      return {
        text: "My brother's coming next weekend, I need him to park at mine.",
        detail:
          "The residents' portal says visitor parking permits are suspended for all of November while the car park is resurfaced.",
        hidden: notice("November"),
        decoy: notice("September"),
      };
    },
  },
  // notes; decoy (b): someone else's accountant.
  {
    name: "lt-self-assessment-agent-files",
    build: () => {
      const note = (who: string) =>
        rare(
          "notes",
          "Tax",
          `Self-assessment: ${who}. Don't submit anything on the HMRC site, it confuses things. Send her the P60 and the rental figures.`,
          at(9, 25, 20, 0),
        );
      return {
        text: "I need to file my self-assessment this weekend.",
        detail:
          "The user's tax note says their accountant Rachel files the self-assessment as agent and asked them not to submit anything themselves.",
        hidden: note("Rachel files mine as agent"),
        decoy: note("Rachel did Mum's last year as agent, mine I do myself"),
      };
    },
  },
  // ── social ──
  // whatsapp; decoy (b): the week after.
  {
    name: "lt-barbecue-five-a-side-away",
    build: () => {
      const chat = (day: string) =>
        rare(
          "whatsapp",
          "Five-a-side",
          wa([
            [
              "Jamal",
              `reminder most of us are at the tournament in Leeds ${day}, coach leaves 7am sharp`,
              at(10, 23, 18, 30),
            ],
            ["Chris", "back about 10pm I reckon", at(10, 23, 18, 34)],
          ]),
          at(10, 23, 18, 34),
        );
      return {
        text: "We should do a barbecue at ours on Saturday 7 November and invite the five-a-side lot.",
        detail:
          "The five-a-side WhatsApp says most of the group is at a tournament in Leeds on Saturday 7 November, back about 10pm.",
        hidden: chat("Sat 7th"),
        decoy: chat("Sat 14th"),
      };
    },
  },
  // notes; decoy (b): another friend.
  {
    name: "lt-wine-tasting-friend-sober",
    build: () => {
      const note = (who: string) =>
        rare(
          "notes",
          "Friends",
          `${who}: not drinking at all since August, doing a year sober. Don't plan anything boozy. Loves climbing.`,
          at(9, 2, 22, 30),
        );
      return {
        text: "Book a wine-tasting evening for Jess's birthday.",
        detail: "The user's note says Jess has not drunk at all since August and is doing a sober year.",
        hidden: note("Jess"),
        decoy: note("Priya"),
      };
    },
  },
  // school; decoy (b): the day before.
  {
    name: "lt-fortieth-parents-evening",
    build: () => {
      const letter = (day: string) =>
        rare(
          "school",
          "Parents' evening",
          `Year 3 parents' evening is on ${day}, 17:00-20:00. Please book a slot with your child's teacher.`,
          at(10, 20, 15, 30),
        );
      return {
        text: "Accept the invite to Dan's 40th on Friday 20 November, 7pm.",
        detail: "The school's parents' evening for Year 3 is on Friday 20 November, 17:00–20:00.",
        hidden: letter("Friday 20 November"),
        decoy: letter("Thursday 19 November"),
      };
    },
  },
];

/**
 * Plant one item per template in its rare connector (the fact for `hidden`, the look-alike for `control`, nothing for
 * `neutral`) and return the tasks. The world must be prepared (`prepareWorld`, suites.ts): the rare connectors and
 * their filler are the base world's, in every variant.
 */
export function plantLongtail(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  addRareSources(world, seed);
  const r = new Rng(seed * 7_919 + 2_727);
  const by = (rel: string) => world.people.filter((p) => p.relation === rel);
  const stand = (first: string, last: string, relation: Person["relation"]): Person => ({
    id: `p-${first}-${last}`.toLowerCase(),
    first,
    last,
    full: `${first} ${last}`,
    email: `${first}.${last}@example.com`.toLowerCase(),
    relation,
  });
  const pick = (pool: Person[], fallback: Person) => (pool.length ? r.pick(pool) : fallback);
  const ctx: Ctx = {
    colleague: () => pick(by("colleague"), stand("Alex", "Morgan", "colleague")),
    client: () => pick(by("client"), stand("Jordan", "Blake", "client")),
  };
  const suite = variant === "hidden" ? "longtail" : `longtail-${variant}`;
  return TEMPLATES.map((t) => {
    const spec = t.build(ctx);
    if (variant !== "neutral") {
      const p = variant === "hidden" ? spec.hidden : spec.decoy;
      // A ref of the base world's shape, the same index in hidden and control (one item per template, in order).
      const ref = `${p.kind}-${world.items.length}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    return { id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail };
  });
}

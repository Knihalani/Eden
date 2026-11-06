/**
 * Held-out hidden-context suite 14 (RealUse-1, docs/research/benchmark-realuse-1.md): blind, written by an author who
 * read only hidden-heldout13.ts (as a format example), the suite registry, the HiddenTask interface, the sim world API
 * (world.ts, names.ts, text.ts, rng.ts) and the benchmark's design. No engine, ranking, reader or card code and no
 * other suite was read. Measurement only: never tune on it.
 *
 * 32 requests a user types to their personal agent, four in each life area: work, family, health, money, travel,
 * home, admin and social. Each plants one item the request does not ask about: in the `hidden` variant the real
 * consideration (a clash, a limit, a change, a prerequisite not met, "already done", an allergy, a closure, a moved
 * date), in the `control` variant a near-miss decoy that looks relevant but does not apply. The `neutral` variant
 * plants nothing: the same request in a world with no planted item, which is what most real turns look like. Request
 * and `detail` are identical across the three variants, so an answer that raises the detail in control or neutral is
 * a false claim.
 *
 * Word overlap between the request and the planted item varies: about a third share no content word (paraphrase,
 * other date formats), a third share only a person's, organisation's, place's or venue's name, a third share one
 * topic word. Decoys are split between resolved/expired/superseded, about another entity or date of the same kind,
 * and "prerequisite met / allows the request".
 *
 * World time is NOW in world.ts: Tuesday 27 October 2026, 09:00 UTC. Every date below is written out against it
 * (Sunday 1 November, Tuesday 1 December).
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
 * variants and the three suites describe the same people and numbers.
 */
interface Ctx {
  r: Rng;
  ta: Rng;
  tb: Rng;
  user: Person;
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

/** Two people from a pool whose organisations differ (pools repeat organisations), the first one drawn first. */
function twoOrgs(pool: Person[]): [Person, Person] {
  const a = pool[0]!;
  return [a, pool.slice(1).find((p) => p.org !== a.org) ?? pool[1] ?? a];
}

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
    "does anyone know if the printer on 2 is fixed yet?",
    "who left a lasagne in the fridge from last week",
    "standup is 10 mins late today",
    "the guest wifi password changed again, it's on the board by the lifts",
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

const HOSTS = ["Priyanka Shah", "Bea Lindqvist", "Marta Kowalska", "Grace Adeyemi"];
const PLATE_AREAS = "ABCDEFGHKLMNPRSTVWY";
const PLATE_LETTERS = "ABCDEFGHJKLMNPRSTVWXYZ";

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  {
    // Shares the client's organisation only; decoy: another client's renewal closed. Hidden: already renewed.
    name: "renewal-already-won",
    build: (c) => {
      const [a, b] = twoOrgs(c.clients(6));
      const amount = c.r.int(40, 180) * 1000;
      const deal = (p: Person): Plant => ({
        sourceId: "crm",
        kind: "deal",
        title: `${p.org} — Renewal 2027`,
        text:
          `Deal: ${p.org} — Renewal 2027\nStage: Closed won\nAmount: $${amount.toLocaleString("en-US")}\n` +
          `Close date: 2026-10-22\nOwner: Robin Carter\nChampion: ${p.full}\nTerm: 24 months from 2027-01-01\n` +
          `Note: order form countersigned by ${p.full} on 2026-10-22; nothing further needed until the next term.`,
        updatedAt: at(10, 22, 16, 40),
      });
      return {
        text:
          `Their contract runs out at the end of the year, so can you draft a proposal to keep ${a.org} on for ` +
          "another term? Want to get in early.",
        detail:
          `${a.org} has already renewed: the CRM shows the renewal closed won on 22 October 2026 ` +
          `($${amount.toLocaleString("en-US")}, 24 months from 1 January 2027, order form signed by ${a.full}), ` +
          "so no proposal is needed.",
        hidden: deal(a),
        decoy: deal(b),
      };
    },
  },
  {
    // No shared word ("bookable spaces", "Tue 3/11"); decoy: the same closure a week later.
    name: "review-room-closure",
    build: (c) => {
      const [x, fac, by] = c.colleagues(3);
      const line = (day: string) =>
        `Heads up: the whole 3rd floor is shut on ${day} while the fire alarm system is replaced. No bookable ` +
        "spaces up there that day, and the 2nd floor is hot-desk only, so plan anything face to face elsewhere.";
      return {
        text: `Book a meeting room for my quarterly review with ${x!.first} next Tuesday, 2 till 4.`,
        detail:
          "No meeting rooms are available on Tuesday 3 November 2026: the 3rd floor is shut for the fire alarm " +
          `replacement and the 2nd floor is hot-desk only (${fac!.full} in #office), so the review needs another ` +
          "day or a room elsewhere.",
        hidden: chat(c.ta, "office", [{ who: fac!, when: at(10, 26, 10, 2), text: line("Tue 3/11") }], by!),
        decoy: chat(c.tb, "office", [{ who: fac!, when: at(10, 26, 10, 2), text: line("Tue 10/11") }], by!),
      };
    },
  },
  {
    // Shares the client's name only; decoy: their quiet period already ended.
    name: "webinar-speaker-quiet-period",
    build: (c) => {
      const [a] = c.clients(1);
      return {
        text:
          `Email ${a!.full} and lock in ${a!.first}'s slot as guest speaker on our partner webinar, Thursday ` +
          "19 November at 4pm.",
        detail:
          `${a!.full} can't appear at external events until ${a!.org}'s results on 26 November 2026 (a company ` +
          "quiet period, per their email of 26 October), so the 19 November webinar needs another speaker or a " +
          "later date.",
        hidden: mail(c, c.ta, {
          from: a!,
          to: c.user,
          when: at(10, 26, 12, 10),
          title: "Quiet period",
          body: [
            `Awkward one, I'm afraid: our comms team has just put everyone at ${a!.org} into a quiet period ahead ` +
              "of our results on 26 November.",
            "Until then none of us can appear at external events or in anyone's marketing, so I'd have to pull out " +
              "of anything before the 27th. Really sorry.",
          ],
          corporate: true,
        }),
        decoy: mail(c, c.tb, {
          from: a!,
          to: c.user,
          when: at(10, 26, 12, 10),
          title: "Quiet period",
          body: [
            `Good news: the quiet period at ${a!.org} ended with our results on 22 October.`,
            "I'm cleared to appear at external events and in partners' marketing again, so happy to help wherever " +
              "it's useful.",
          ],
          corporate: true,
        }),
      };
    },
  },
  {
    // Shares the topic word "freelance"; decoy: plenty left on the line.
    name: "freelance-budget-line",
    build: (c) => {
      const [fin] = c.colleagues(1);
      const doc = (committed: string, left: string): Plant => ({
        sourceId: "drive",
        kind: "doc",
        title: "Partnerships budget tracker, Q4 2026",
        text:
          `Partnerships budget tracker, Q4 2026 (owner ${fin!.full}, Finance Partner; updated 23 Oct)\n\n` +
          `Freelance & contractor spend: budget £48,000, committed ${committed}, remaining ${left}\n` +
          "Events & sponsorship: budget £30,000, committed £21,500, remaining £8,500\n" +
          "Travel: budget £12,000, committed £7,900, remaining £4,100\n\n" +
          `Anything that would take a line over budget needs sign-off from ${fin!.full} before it is committed.`,
        updatedAt: at(10, 23, 15),
      });
      return {
        text: "Approve another 20 days for the freelance designer on the partner portal: £450 a day, so £9,000.",
        detail:
          "Only £5,400 is left on the Partnerships freelance and contractor line for Q4 (£42,600 of £48,000 " +
          `committed, budget tracker); £9,000 would overrun it and needs ${fin!.full}'s sign-off first.`,
        hidden: doc("£42,600", "£5,400"),
        decoy: doc("£27,600", "£20,400"),
      };
    },
  },
  // ── family ──
  {
    // Shares the name Maya only; decoy: the party is the following Saturday.
    name: "maya-saturday-party",
    build: () => {
      const entry = (day: number, label: string) =>
        event({
          title: "Maya: Lily Okoye's 8th birthday party",
          start: at(day > 20 ? 10 : 11, day, 14),
          when: `${label}, 14:00-17:00`,
          where: "Clissold Leisure Centre (soft play)",
          notes: "Drop off and collect. Present already bought (Lego set, in the hall cupboard).",
          edited: at(10, 15, 20, 30),
        });
      return {
        text: "Message Jamie and set up a playdate for Maya and his little one at ours on Saturday afternoon.",
        detail:
          "Maya is at Lily Okoye's birthday party on Saturday 31 October 2026, 14:00-17:00 at Clissold Leisure " +
          "Centre, so Saturday afternoon is already taken.",
        hidden: entry(31, "Sat 31/10"),
        decoy: entry(7, "Sat 07/11"),
      };
    },
  },
  {
    // Shares "Mum" only; decoy: the visit to Bristol was called off.
    name: "mum-away-sunday",
    build: (c) => {
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      return {
        text: "Book somewhere nice for Sunday lunch with Mum, Islington-ish, 1pm. Four of us including her.",
        detail:
          "Mum (Ruth Carter) is in Bristol with Ellie from Friday 30 October until Monday 2 November 2026, so she " +
          "won't be in London for Sunday lunch on 1 November.",
        hidden: mail(c, c.ta, {
          from: ellie,
          to: c.user,
          when: at(10, 25, 20, 15),
          title: "This weekend",
          body: [
            "Mum's coming to us: I'm picking her up on Friday afternoon and driving her back on Monday morning.",
            "She's very excited about the kids' school play on the Saturday.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: ellie,
          to: c.user,
          when: at(10, 25, 20, 15),
          title: "This weekend",
          body: [
            "Mum was meant to be coming to us, but she's decided the drive is too much this time.",
            "So she's at home as normal; we'll try again at Christmas.",
          ],
        }),
      };
    },
  },
  {
    // No shared word ("13:30 on 30/10", "go home"); decoy: the early finish is a different Friday.
    name: "school-early-finish",
    build: (c) => {
      const t = c.role("Maya's teacher", ["Mrs", "Daley"]);
      const body = (day: string) => [
        `A reminder that Highbury Primary closes at 13:30 on ${day} for the staff training afternoon.`,
        "Children go home from the main gate at 13:30, and there is no late club that day.",
      ];
      return {
        text:
          "Can you ask Leila if she could collect Maya from school at 3:15 on Friday? I'm stuck in a client " +
          "meeting.",
        detail:
          "Highbury Primary closes early, at 13:30 on Friday 30 October 2026 (staff training afternoon, no late " +
          "club), so a 15:15 pickup would be too late.",
        hidden: mail(c, c.ta, {
          from: t,
          to: c.user,
          when: at(10, 22, 15, 40),
          title: "INSET afternoon",
          body: body("30/10"),
        }),
        decoy: mail(c, c.tb, {
          from: t,
          to: c.user,
          when: at(10, 22, 15, 40),
          title: "INSET afternoon",
          body: body("13/11"),
        }),
      };
    },
  },
  {
    // Shares the topic word "pottery"; decoy: Mum's plan fell through. Hidden: already bought.
    name: "sister-gift-bought",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      return {
        text: "Sort a present for my sister, she's really into pottery at the moment. Around £60?",
        detail:
          "Mum (Ruth Carter) already bought Ellie a pottery wheel course at Clay Collective for her birthday, from " +
          "both of them (£120, Robin owes £60), so another present isn't needed.",
        hidden: mail(c, c.ta, {
          from: mum,
          to: c.user,
          when: at(10, 24, 11, 0),
          title: "Ellie's birthday",
          body: [
            "I've bought Ellie the pottery wheel course at Clay Collective for her birthday, from both of us.",
            "It was £120, so half from you whenever you're ready. The voucher's going straight to her.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: mum,
          to: c.user,
          when: at(10, 24, 11, 0),
          title: "Ellie's birthday",
          body: [
            "I was going to get Ellie the pottery wheel course at Clay Collective from both of us, but it's sold " +
              "out until the spring.",
            "So I haven't got her anything yet, over to you!",
          ],
        }),
      };
    },
  },
  // ── health ──
  {
    // Shares the topic word "physio"; decoy: the pre-authorisation is already approved.
    name: "physio-preauth",
    build: (c) => {
      const ins = bot("Brightwell Health", "claims@brightwellhealth.co.uk");
      return {
        text: "Book me a physio for my knee. The place on Harley Street is fine, sometime next week.",
        detail:
          "Since 1 October 2026 Robin's health insurer (Brightwell) only covers physio that is pre-authorised with " +
          "a GP or specialist referral; sessions booked without an authorisation code won't be reimbursed.",
        hidden: notice(c, c.ta, {
          from: ins,
          when: at(10, 5, 7, 0),
          title: "Changes to your cover",
          body:
            "From 1 October 2026, physio sessions are only covered when pre-authorised. You will need a GP or " +
            "specialist referral and an authorisation code from us before your first appointment. Treatment started " +
            "without one will not be reimbursed.",
        }),
        decoy: notice(c, c.tb, {
          from: ins,
          when: at(10, 22, 7, 0),
          title: "Your claim is pre-authorised",
          body:
            "Good news: 6 physio sessions for your right knee are pre-authorised and covered in full at any " +
            "recognised clinic until 31/01/2027. No further referral is needed.",
        }),
      };
    },
  },
  {
    // No shared word ("vaccination clinic", "Thu 29/10"); decoy: the office clinic was cancelled. Hidden: booked.
    name: "flu-clinic-slot",
    build: (c) => {
      const [hr, a, b, by] = c.colleagues(4);
      return {
        text: "Get me a flu jab booked at Boots this week",
        detail:
          "Robin already has a slot at the free office flu vaccination clinic on Thursday 29 October 2026 at 11:40, " +
          `3rd floor (posted by ${hr!.full} in #general), so a Boots booking isn't needed.`,
        hidden: chat(
          c.ta,
          "general",
          [
            {
              who: hr!,
              when: at(10, 23, 14, 5),
              text:
                "Office vaccination clinic is Thu 29/10 in the 3rd floor quiet room. Slots: " +
                `${a!.full} 11:20, Robin Carter 11:40, ${b!.full} 11:50. Just turn up, nothing to pay.`,
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "general",
          [
            {
              who: hr!,
              when: at(10, 23, 14, 5),
              text:
                "The office vaccination clinic on Thu 29/10 is cancelled, the supplier ran short. Please book your " +
                "own at a pharmacy and expense it (up to £20).",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // No shared word; decoy: the food challenge cleared her.
    name: "maya-sesame-allergy",
    build: (c) => {
      const clinic = bot("Evelina Children's Allergy Service", "allergy.letters@gstt.nhs.uk");
      return {
        text: "order us a gousto box for next week - the family one, 4 recipes, whatever looks good",
        detail:
          "Maya has a confirmed sesame allergy (Evelina allergy clinic, 19 October 2026): recipes with sesame seeds, " +
          "tahini, sesame oil or hummus must be avoided.",
        hidden: notice(c, c.ta, {
          from: clinic,
          when: at(10, 20, 13, 0),
          title: "Clinic letter: Maya Carter",
          body:
            "Following Maya Carter's skin prick test on 19/10/2026, she has a confirmed sesame allergy. Please avoid " +
            "sesame seeds, tahini, sesame oil and hummus, and check labels for 'may contain sesame'. An adrenaline " +
            "auto-injector prescription has been sent to your GP.",
        }),
        decoy: notice(c, c.tb, {
          from: clinic,
          when: at(10, 20, 13, 0),
          title: "Clinic letter: Maya Carter",
          body:
            "Following Maya Carter's supervised food challenge on 19/10/2026, she tolerated a full portion of sesame " +
            "with no reaction. She does not have a sesame allergy and can eat it normally. No follow-up is needed.",
        }),
      };
    },
  },
  {
    // Shares the topic word "inhaler"; decoy: the review is done and repeats are authorised.
    name: "inhaler-review-due",
    build: (c) => {
      const gp = bot("Canonbury Medical Practice", "no-reply@canonburymedical.nhs.uk");
      return {
        text: "Reorder my inhaler on the NHS app please, I'm on my last one.",
        detail:
          "The GP practice won't issue more Salbutamol inhaler repeats until Robin has had an asthma review with " +
          "the practice nurse (notice of 15 October 2026), so the reorder will be refused until that is booked.",
        hidden: notice(c, c.ta, {
          from: gp,
          when: at(10, 15, 8, 0),
          title: "Your repeat prescription",
          body:
            "Your repeat prescription for Salbutamol 100mcg inhaler is due a medication review. We cannot issue " +
            "further repeats until you have seen the practice nurse for an asthma review. Please book an appointment.",
        }),
        decoy: notice(c, c.tb, {
          from: gp,
          when: at(10, 12, 16, 0),
          title: "Your repeat prescription",
          body:
            "Thank you for attending your asthma review on 12/10/2026. Your repeat prescriptions, including " +
            "Salbutamol 100mcg inhaler, are authorised until 12/10/2027 and can be ordered as normal.",
        }),
      };
    },
  },
  // ── money ──
  {
    // Shares the topic word "ISA"; decoy: most of the allowance is left.
    name: "isa-allowance",
    build: (c) => {
      const bank = bot("Marlow Bank", "savings@marlowbank.co.uk");
      const body = (paid: string, left: string) =>
        `Thank you for your deposit. Cash ISA subscriptions this tax year (2026/27): ${paid}. Remaining allowance ` +
        `across all your ISAs: ${left}. The allowance resets on 6 April 2027.`;
      return {
        text: "Put another £8,000 into my stocks and shares ISA before April.",
        detail:
          "Robin has already paid £15,000 into a Marlow Bank cash ISA in the 2026-27 tax year, so only £5,000 of " +
          "the £20,000 ISA allowance is left; £8,000 would go over it.",
        hidden: notice(c, c.ta, {
          from: bank,
          when: at(10, 16, 7, 0),
          title: "Deposit received",
          body: body("£15,000.00", "£5,000.00"),
        }),
        decoy: notice(c, c.tb, {
          from: bank,
          when: at(10, 16, 7, 0),
          title: "Deposit received",
          body: body("£5,000.00", "£15,000.00"),
        }),
      };
    },
  },
  {
    // No shared word ("Band D instalments"); decoy: the bank cancelled the Direct Debit. Hidden: collected anyway.
    name: "council-tax-direct-debit",
    build: (c) => {
      const council = bot("Islington Revenues", "revenues@islington.gov.uk");
      return {
        text: "Pay this month's council tax for me, it's £186-ish",
        detail:
          "Council tax is now on Direct Debit: Islington collects each instalment automatically on the 1st, " +
          "starting 1 November 2026, so paying by hand would pay twice.",
        hidden: notice(c, c.ta, {
          from: council,
          when: at(10, 19, 6, 30),
          title: "Your Direct Debit instruction",
          body:
            "Your Direct Debit instruction is now active. Band D instalments will be collected automatically on the " +
            "1st of each month, starting 1 November 2026. You do not need to do anything.",
        }),
        decoy: notice(c, c.tb, {
          from: council,
          when: at(10, 20, 6, 30),
          title: "Your Direct Debit instruction",
          body:
            "Your Direct Debit instruction was cancelled by your bank on 20/10/2026. Please pay the November Band D " +
            "instalment online or by phone by 1 November 2026.",
        }),
      };
    },
  },
  {
    // Shares the builder's name only; decoy: an older payment for another job. Hidden: deposit already paid.
    name: "builder-deposit-paid",
    build: (c) => {
      const bank = bot("Thames Bank", "alerts@thamesbank.co.uk");
      const ending = c.r.token("0123456789", 4);
      return {
        text: "Pay Cole & Sons their deposit so they can get started on the bathroom.",
        detail:
          "Robin already paid Cole & Sons the £1,200 deposit on 23 October 2026 (bank alert, reference ROBIN CARTER " +
          "DEP); paying again would pay twice.",
        hidden: notice(c, c.ta, {
          from: bank,
          when: at(10, 23, 18, 12),
          title: "Payment sent",
          body:
            "You sent £1,200.00 to COLE & SONS BUILDERS LTD, reference ROBIN CARTER DEP, on 23/10/2026 from your " +
            `current account ending ${ending}.`,
        }),
        decoy: notice(c, c.tb, {
          from: bank,
          when: at(3, 14, 18, 12),
          title: "Payment sent",
          body:
            "You sent £850.00 to COLE & SONS BUILDERS LTD, reference BOILER FINAL, on 14/03/2026 from your " +
            `current account ending ${ending}.`,
        }),
      };
    },
  },
  {
    // Shares the topic word "pension"; decoy: the freeze ended early.
    name: "pension-change-freeze",
    build: (c) => {
      const [hr, by] = c.colleagues(2);
      return {
        text: "Bump my pension contribution up to 10% starting with November's salary.",
        detail:
          "Pension contribution changes are frozen during the move to Aviva: nothing submitted now applies to the " +
          `November or December payroll, and changes reopen on 4 January 2027 (${hr!.full} in #people).`,
        hidden: chat(
          c.ta,
          "people",
          [
            {
              who: hr!,
              when: at(10, 21, 11, 15),
              text:
                "Pension changes are paused while we move providers to Aviva: nothing submitted now will apply to " +
                "the Nov or Dec payroll. New contribution forms open on 4 Jan.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "people",
          [
            {
              who: hr!,
              when: at(10, 21, 11, 15),
              text:
                "The pension provider move to Aviva finished early, so contribution changes are open again: anything " +
                "in by 13/11 applies to the November payroll.",
            },
          ],
          by!,
        ),
      };
    },
  },
  // ── travel ──
  {
    // No shared word ("industrial action", "Thu 12/11", Belgium); decoy: the strike is a week later.
    name: "rail-strike-cologne",
    build: (c) => {
      const db = bot("DB Travel Alerts", "noreply@travelalerts.bahn.de");
      const body = (from: string, to: string) =>
        `Industrial action has been announced by the train drivers' union GDL from 02:00 on ${from} to 22:00 on ` +
        `${to}. Long-distance services across Germany will run to a heavily reduced emergency timetable, and many ` +
        "connections from Belgium and the Netherlands will not run.";
      return {
        text: "Book me the 07:01 Eurostar to Brussels on 12 November and the ICE on to Cologne after it.",
        detail:
          "German train drivers have called a strike from 02:00 on Thursday 12 November to 22:00 on Friday " +
          "13 November 2026; long-distance trains, including connections from Belgium, run a heavily reduced " +
          "timetable.",
        hidden: notice(c, c.ta, {
          from: db,
          when: at(10, 26, 15, 0),
          title: "Travel alert",
          body: body("Thu 12/11", "Fri 13/11"),
        }),
        decoy: notice(c, c.tb, {
          from: db,
          when: at(10, 26, 15, 0),
          title: "Travel alert",
          body: body("Thu 19/11", "Fri 20/11"),
        }),
      };
    },
  },
  {
    // Shares the topic word "Lisbon"; decoy: rooms were booked for two colleagues only. Hidden: already booked.
    name: "lisbon-room-booked",
    build: (c) => {
      const [x, y, z] = c.colleagues(3);
      const conf = `MYR-${c.r.int(10000, 99999)}`;
      const doc = (rows: string): Plant => ({
        sourceId: "drive",
        kind: "doc",
        title: "Lisbon trip, w/c 9 Nov: who's where",
        text:
          `Lisbon trip, w/c 9 Nov: who's where (owner ${x!.full}; rooms booked 16 Oct on the company card, ` +
          `room only)\n\n${rows}\n\nTaxis from the airport are on expenses. Dinner on the Wednesday is on the company.`,
        updatedAt: at(10, 16, 17),
      });
      return {
        text: "Find me a hotel in Lisbon for the 9th to the 13th of November, somewhere near the conference centre.",
        detail:
          `${x!.full} already booked Robin a room at Hotel Myriad (Parque das Nações) for 9-13 November 2026, ` +
          `confirmation ${conf} (trip doc), so another hotel isn't needed.`,
        hidden: doc(
          `- Robin Carter: Hotel Myriad, Parque das Nações, in Mon 9/11, out Fri 13/11, conf. ${conf}\n` +
            `- ${y!.full}: Hotel Myriad, in Mon 9/11, out Thu 12/11`,
        ),
        decoy: doc(
          `- ${y!.full}: Hotel Myriad, Parque das Nações, in Mon 9/11, out Fri 13/11, conf. ${conf}\n` +
            `- ${z!.full}: Hotel Myriad, in Mon 9/11, out Thu 12/11`,
        ),
      };
    },
  },
  {
    // No shared word ("travel authorisation", "United States"); decoy: the authorisation is valid.
    name: "esta-expired",
    build: (c) => {
      const cbp = bot("ESTA Notifications", "esta-notifications@cbp.dhs.gov");
      const app = c.r.token("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789", 16);
      return {
        text: "Book flights to New York for the client visit: out Monday 30 November, back Friday 4 December.",
        detail:
          "Robin's ESTA (US travel authorisation) expired on 18 October 2026; a new one must be approved before " +
          "the trip (allow at least 72 hours).",
        hidden: notice(c, c.ta, {
          from: cbp,
          when: at(10, 18, 5, 0),
          title: "Your travel authorisation has expired",
          body:
            `The travel authorisation for ROBIN CARTER (application ${app}) expired on 18/10/2026. A new ` +
            "application must be approved before you travel to the United States; allow at least 72 hours.",
        }),
        decoy: notice(c, c.tb, {
          from: cbp,
          when: at(9, 3, 5, 0),
          title: "Your travel authorisation is approved",
          body:
            `The travel authorisation for ROBIN CARTER (application ${app}) has been approved and is valid until ` +
            "03/09/2028 for multiple visits to the United States.",
        }),
      };
    },
  },
  {
    // No shared word ("photocard", "30/11/2026"); decoy: the new licence was issued.
    name: "driving-licence-expiry",
    build: (c) => {
      const dvla = bot("DVLA", "no-reply@dvla.gov.uk");
      return {
        text: "Rent us a car at Faro airport from 21 to 28 December, big enough for three of us and the bags.",
        detail:
          "Robin's photocard driving licence expires on 30 November 2026, before the 21 December hire; it must be " +
          "renewed first (online, £14, about a week) or the car can't be collected.",
        hidden: notice(c, c.ta, {
          from: dvla,
          when: at(10, 1, 6, 0),
          title: "Your photocard is due to expire",
          body:
            "Your photocard driving licence expires on 30/11/2026. You can renew online for £14; allow up to a week " +
            "for the new card. You must not drive on an expired licence.",
        }),
        decoy: notice(c, c.tb, {
          from: dvla,
          when: at(10, 22, 6, 0),
          title: "Your new photocard is on its way",
          body:
            "Your new photocard driving licence has been issued and posted. It is valid until 22/10/2036. Please " +
            "destroy your old card when the new one arrives.",
        }),
      };
    },
  },
  // ── home ──
  {
    // Shares the topic words "washing machine"; decoy: the cover lapsed.
    name: "washer-repair-cover",
    build: (c) => {
      const care = bot("Currys Care & Repair", "careandrepair@currys.co.uk");
      return {
        text: "Find someone to come and fix the washing machine, it's leaking again",
        detail:
          "The washing machine is covered by a Currys Care & Repair plan until 14 February 2027 (repairs, parts and " +
          "call-outs in full), so the repair should be booked through them rather than paying an engineer.",
        hidden: notice(c, c.ta, {
          from: care,
          when: at(10, 8, 9, 30),
          title: "Your plan summary",
          body:
            "Your Care & Repair plan for your Bosch Serie 6 washing machine is active until 14/02/2027. Repairs, " +
            "parts and call-outs are covered in full: book an engineer online or call 0344 561 1234.",
        }),
        decoy: notice(c, c.tb, {
          from: care,
          when: at(10, 1, 9, 30),
          title: "Your plan has ended",
          body:
            "Your Care & Repair plan for your Bosch Serie 6 washing machine ended on 30/09/2026 and has not been " +
            "renewed. Repairs are no longer covered.",
        }),
      };
    },
  },
  {
    // Shares the street name only; decoy: the closure is the following Thursday.
    name: "street-closure-delivery",
    build: (c) => {
      const hw = bot("Islington Highways", "highways@islington.gov.uk");
      const body = (day: string) =>
        `Aldridge Road N5 will be closed to all vehicles on ${day} from 07:00 to 13:00 for a crane lift at no. 41. ` +
        "There will be no vehicle access at all in that window and residents' bays are suspended.";
      return {
        text: "Get an Ocado slot booked for Thursday morning to Aldridge Road, we need a big shop in.",
        detail:
          "Aldridge Road is closed to all vehicles on Thursday 29 October 2026, 07:00-13:00, for a crane lift, so a " +
          "morning delivery can't reach the house.",
        hidden: notice(c, c.ta, {
          from: hw,
          when: at(10, 20, 10, 0),
          title: "Road closure notice",
          body: body("29/10/2026"),
        }),
        decoy: notice(c, c.tb, {
          from: hw,
          when: at(10, 20, 10, 0),
          title: "Road closure notice",
          body: body("05/11/2026"),
        }),
      };
    },
  },
  {
    // No shared word ("lift out of action", "brought in"); decoy: the works finished early.
    name: "sofa-lift-outage",
    build: (c) => {
      const s = c.role("landlord", ["Steve", "Hargreaves"]);
      return {
        text: "Order the grey three-seater sofa from Loaf and have it delivered to the flat.",
        detail:
          "The building's lift is out of service from Monday 2 to Friday 20 November 2026 for replacement and " +
          "nothing large fits up the stairs (landlord Steve Hargreaves), so the sofa has to arrive before 2 November " +
          "or after the 20th.",
        hidden: mail(c, c.ta, {
          from: s,
          to: c.user,
          when: at(10, 21, 17, 20),
          title: "Lift works",
          body: [
            "The lift will be out of action from Mon 2 Nov to Fri 20 Nov while it's replaced.",
            "The stairwell's too narrow to turn anything big, so please don't have anything bulky brought in until " +
              "it's back.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: s,
          to: c.user,
          when: at(10, 26, 17, 20),
          title: "Lift works",
          body: [
            "Good news: the new lift was signed off this morning, so the works I'd planned for November are done.",
            "It's back in normal use.",
          ],
        }),
      };
    },
  },
  {
    // Shares the topic word "meter"; decoy: the install was cancelled by the supplier. Hidden: already booked.
    name: "smart-meter-booked",
    build: (c) => {
      const ref = `OE-${c.r.int(100000, 999999)}`;
      return {
        text: "Can you get the energy company to fit us a smart meter? Sick of estimated bills.",
        detail:
          `A smart meter install is already booked: an Octopus engineer is coming on Wednesday 4 November 2026, ` +
          `08:00-12:00 (ref ${ref}).`,
        hidden: event({
          title: "Octopus engineer: smart meter install",
          start: at(11, 4, 8),
          when: "Wed 4 Nov, 08:00-12:00",
          where: "Home",
          notes:
            `Booked by phone on 18/10, ref ${ref}. Someone needs to be in; access to the cupboard under the ` +
            "stairs.",
          edited: at(10, 18, 13),
        }),
        decoy: event({
          title: "CANCELLED: Octopus engineer: smart meter install",
          start: at(11, 4, 8),
          when: "Wed 4 Nov, 08:00-12:00",
          where: "Home",
          notes:
            `Ref ${ref}. Cancelled by the supplier on 22/10 (no engineer in the area); they said to rebook ` +
            "online.",
          edited: at(10, 22, 13),
        }),
      };
    },
  },
  // ── admin ──
  {
    // No shared word ("Vehicle Excise Duty", a plate); decoy: the licence is due and unpaid. Hidden: already set up.
    name: "road-tax-direct-debit",
    build: (c) => {
      const dvla = bot("DVLA", "no-reply@dvla.gov.uk");
      const plate = `${c.r.token(PLATE_AREAS, 2)}${c.r.int(15, 23)} ${c.r.token(PLATE_LETTERS, 3)}`;
      return {
        text: "Sort out the Golf's road tax, I think it runs out this month.",
        detail:
          `The Golf's (${plate}) road tax is already renewed by Direct Debit with DVLA, monthly from 1 November ` +
          "2026, so paying again would double up.",
        hidden: notice(c, c.ta, {
          from: dvla,
          when: at(10, 13, 6, 0),
          title: "Vehicle Excise Duty: Direct Debit confirmed",
          body:
            `Your Direct Debit for ${plate} is set up. Payments of £16.63 a month will be taken from 1 November ` +
            "2026. You do not need to do anything.",
        }),
        decoy: notice(c, c.tb, {
          from: dvla,
          when: at(10, 13, 6, 0),
          title: `Reminder for ${plate}`,
          body:
            `The current licence for ${plate} ends on 31/10/2026. Pay online now to continue to use this vehicle ` +
            "on the road.",
        }),
      };
    },
  },
  {
    // Shares the topic word "contents"; decoy: the renewal is still weeks away.
    name: "contents-auto-renewed",
    build: (c) => {
      const ins = bot("Hartwell Home Insurance", "policies@hartwellhome.co.uk");
      return {
        text: "Get me three quotes for home contents insurance, ours is up for renewal.",
        detail:
          "The Hartwell contents policy already renewed automatically on 20 October 2026 at £214.60; switching " +
          "without a fee means cancelling by 3 November 2026, after which a £35 cancellation fee applies.",
        hidden: notice(c, c.ta, {
          from: ins,
          when: at(10, 20, 4, 0),
          title: "Your policy has renewed",
          body:
            "Your contents policy renewed automatically on 20/10/2026. Annual premium £214.60, paid by card ending " +
            "0612. You can cancel within 14 days (by 03/11/2026) for a full refund; after that a £35 cancellation " +
            "fee applies.",
        }),
        decoy: notice(c, c.tb, {
          from: ins,
          when: at(10, 20, 4, 0),
          title: "Your policy renews soon",
          body:
            "Your contents policy renews on 15/12/2026. Your renewal quote will arrive 21 days before; nothing has " +
            "been charged yet and you are free to compare.",
        }),
      };
    },
  },
  {
    // Shares the topic word "sign"; decoy: the instructions are in and the wills are ready.
    name: "wills-not-ready",
    build: (c) => {
      const sol = bot("Hannah Webb", "h.webb@webblowe.co.uk");
      return {
        text: "Book a time with the solicitor for us to sign our wills. Any weekday morning next week works.",
        detail:
          "The wills can't be signed yet: the solicitor (Hannah Webb) still needs Robin's instructions on clause 4 " +
          "(Maya's guardian), then about a week to prepare the final versions.",
        hidden: mail(c, c.ta, {
          from: sol,
          to: c.user,
          when: at(10, 23, 16, 30),
          title: "Your wills",
          body: [
            "Before we can arrange a signing I still need your instructions on clause 4 (who would be Maya's " +
              "guardian), which was left blank in the draft I sent on 6 October.",
            "Once I have that I'll prepare the final versions; that takes about a week.",
          ],
          corporate: true,
        }),
        decoy: mail(c, c.tb, {
          from: sol,
          to: c.user,
          when: at(10, 23, 16, 30),
          title: "Your wills",
          body: [
            "Thank you for confirming clause 4. The final versions of both wills are ready to sign.",
            "We will provide the two witnesses at the office, so just let me know a time.",
          ],
          corporate: true,
        }),
      };
    },
  },
  {
    // Shares the vendor's name and organisation only; decoy: an NDA with a different vendor. Hidden: already signed.
    name: "nda-already-signed",
    build: (c) => {
      const [v, w] = twoOrgs(c.vendors(6));
      const record = (p: Person): Plant => ({
        sourceId: "crm",
        kind: "contact",
        title: p.full,
        text:
          `Contact: ${p.full}\nTitle: ${p.title ?? "Account Manager"}\nCompany: ${p.org}\nEmail: ${p.email}\n` +
          "Lifecycle: partner prospect\n" +
          "Note (2026-10-19): mutual NDA countersigned by both sides, valid 3 years; PDF in Legal > Executed. " +
          "Next: integration scoping call, date TBC.",
        updatedAt: at(10, 19, 15, 30),
      });
      return {
        text: `Send the mutual NDA over to ${v.full} at ${v.org} so we can get going on the integration.`,
        detail:
          `A mutual NDA with ${v.org} was already countersigned by both sides on 19 October 2026 (valid 3 years, ` +
          "per the CRM), so sending another isn't needed.",
        hidden: record(v),
        decoy: record(w),
      };
    },
  },
  // ── social ──
  {
    // Shares the name Jamie only; decoy: another friend's weekend moved.
    name: "stag-weekend-moved",
    build: (c) => {
      const ross = bot("Ross Fox", "ross.fox@gmail.com");
      const dev = bot("Dev Shah", "devshah88@outlook.com");
      return {
        text: "Can you sort flights for Jamie's stag? Out Friday evening, back on the Sunday.",
        detail:
          "Jamie's stag weekend in Dublin has moved from 13-15 November to 27-29 November 2026 (email from his " +
          "brother Ross Fox), so flights are for Friday 27 to Sunday 29 November.",
        hidden: mail(c, c.ta, {
          from: ross,
          to: c.user,
          when: at(10, 25, 21, 5),
          title: "Change of plan",
          body: [
            "The place in Dublin double-booked us, so Jamie's send-off has moved from 13-15 Nov to 27-29 Nov.",
            "Same plan otherwise, sorry for the faff.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: dev,
          to: c.user,
          when: at(10, 25, 21, 5),
          title: "Change of plan",
          body: [
            "The place in Edinburgh double-booked us, so Marcus's send-off has moved from 13-15 Nov to 27-29 Nov.",
            "Same plan otherwise, sorry for the faff.",
          ],
        }),
      };
    },
  },
  {
    // Shares the restaurant's name only; decoy: the refurbishment was postponed.
    name: "restaurant-refurb",
    build: (c) => {
      const rest = bot("Barrafina", "bookings@barrafina.co.uk");
      return {
        text: "Book Barrafina for Leila's birthday dinner on Friday 13 November, there'll be eight of us",
        detail:
          "Barrafina (Drury Lane) is closed for refurbishment from Monday 9 to Sunday 15 November 2026, so it can't " +
          "host the dinner on Friday 13 November.",
        hidden: notice(c, c.ta, {
          from: rest,
          when: at(10, 19, 12, 0),
          title: "We're getting a makeover",
          body:
            "Barrafina Drury Lane will be closed from Monday 9 to Sunday 15 November while we refurbish the dining " +
            "room. Existing reservations in that week have been moved to our Dean Street site.",
        }),
        decoy: notice(c, c.tb, {
          from: rest,
          when: at(10, 19, 12, 0),
          title: "We're getting a makeover",
          body:
            "The refurbishment we planned for 9-15 November has moved to January, so Barrafina Drury Lane is open as " +
            "normal throughout November.",
        }),
      };
    },
  },
  {
    // No shared word ("reading group", "the November one"); decoy: December is taken, November open.
    name: "book-club-host-taken",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      const [host] = c.r.sample(HOSTS, 1);
      const body = (taken: string, day: string, open: string) => [
        `Reading group admin: ${host} is having us at hers for the ${taken} one (${day}), she offered first.`,
        `${open}'s still up for grabs if anyone wants it.`,
      ];
      return {
        text: "Tell the book club I'm happy to host next month at mine.",
        detail:
          `November's book club already has a host: ${host} offered first and it's at hers on Thursday ` +
          "19 November (per Leila); December is the month that's still open.",
        hidden: mail(c, c.ta, {
          from: leila,
          to: c.user,
          when: at(10, 24, 9, 45),
          title: "Next meetings",
          body: body("November", "Thu 19th", "December"),
        }),
        decoy: mail(c, c.tb, {
          from: leila,
          to: c.user,
          when: at(10, 24, 9, 45),
          title: "Next meetings",
          body: body("December", "Thu 17th", "November"),
        }),
      };
    },
  },
  {
    // No shared word ("Sat 21 Nov - Sun 22 Nov", Bristol); decoy: the weekend moved a week later.
    name: "race-family-weekend",
    build: () => ({
      text: "Enter me for the Victoria Park 10k on Sunday 22 November.",
      detail:
        "Robin is in Bristol for Ellie's 40th on the weekend of 21-22 November 2026 (party Saturday night, family " +
        "lunch Sunday, train back at 18:00), which clashes with the race.",
      hidden: event({
        title: "Ellie's 40th weekend, Bristol",
        start: at(11, 21, 10),
        when: "Sat 21 Nov - Sun 22 Nov (all weekend)",
        where: "Bristol, staying at Ellie's",
        notes: "Party Sat night, family lunch Sun. Train back Sun 18:00 from Temple Meads.",
        edited: at(10, 10, 19),
      }),
      decoy: event({
        title: "Ellie's 40th weekend, Bristol",
        start: at(11, 28, 10),
        when: "Sat 28 Nov - Sun 29 Nov (all weekend)",
        where: "Bristol, staying at Ellie's",
        notes: "Moved from 21-22 Nov (the venue's availability). Party Sat night, family lunch Sun.",
        edited: at(10, 24, 19),
      }),
    }),
  },
];

/**
 * Plant one item per template (the real one for `hidden`, the decoy for `control`, nothing for `neutral`) and return
 * the tasks. Builds both items every time so RNG draws, and so the people and numbers in each task, match across the
 * three variants.
 */
export function plantHeldout14(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 1_414);
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
  const suite = variant === "hidden" ? "heldout14" : `heldout14-${variant}`;
  const tasks: HiddenTask[] = [];
  for (const t of TEMPLATES) {
    const ta = r.fork();
    const tb = r.fork();
    const ctx: Ctx = {
      r,
      ta,
      tb,
      user: world.user,
      colleagues: (k) => draw(pools.colleague, k, standIn("Alex", "Morgan", "colleague", world.user.company)),
      clients: (k) => draw(pools.client, k, standIn("Jordan", "Blake", "client", "Globex")),
      vendors: (k) => draw(pools.vendor, k, standIn("Casey", "Shaw", "vendor", "Cyberdyne")),
      role: (role, [first, last]) =>
        world.people.find((p) => p.role === role) ??
        standIn(first, last, role === "friend" ? "friend" : role === "mum" || role === "sister" ? "family" : "service"),
    };
    const spec = t.build(ctx);
    if (variant !== "neutral") {
      const p = variant === "hidden" ? spec.hidden : spec.decoy;
      // The same ref in hidden and control, so the item id does not tell a grader or a model which variant it is.
      const ref = `h14-${t.name}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    tasks.push({ id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}

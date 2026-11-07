/**
 * Held-out hidden-context suite 15: blind, written for the S3b weak-points work
 * (docs/research/realuse-1-weak-points.md, issue 12) by an author who read only hidden-heldout14.ts (as a format
 * example), the suite registry, the HiddenTask interface, the sim world API (world.ts, names.ts, text.ts, rng.ts) and
 * the RealUse-1 design (docs/research/benchmark-realuse-1.md). No engine, ranking, reader, card or intent code and no
 * other suite was read. Measurement only: never tune on it. Reserved for the final blind confirmation.
 *
 * 32 requests a user types to their personal agent, four in each life area: work, family, health, money, travel,
 * home, admin and social. The situations and wording were chosen to differ from heldout14's. Each template plants one
 * item the request does not ask about: in the `hidden` variant the real consideration (a clash, a limit, a change, a
 * prerequisite not met, "already done", a medical constraint, a closure, a moved time, a policy, someone's
 * constraint), in the `control` variant a near-miss decoy that looks relevant but does not apply. The `neutral`
 * variant plants nothing. Request and `detail` are identical across the three variants, so an answer that raises the
 * detail in control or neutral is a false claim.
 *
 * Word overlap between the request and the planted item varies: 10 templates share no content word (paraphrase,
 * other date formats), 12 share only a name (person, organisation, pet, place or brand), 10 share one topic word.
 * Decoys: 13 resolved/expired/superseded, 11 about another entity or date of the same kind, 8 where the
 * prerequisite is met or the item allows the request. Each template's comment names its bucket and decoy.
 *
 * World time is NOW in world.ts: Tuesday 27 October 2026, 09:00 UTC. Every date below is written out against it
 * (Thursday 29 October is "this Thursday", Monday 16 November is three weeks on).
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
  ]);
  return {
    sourceId: "gmail",
    kind: "notification",
    title: m.title,
    text: emailText(
      m.from,
      c.user,
      m.when,
      `${m.body}\n\nReference: ${t.token("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 9)}\n\n${footer}`,
    ),
    updatedAt: m.when,
  };
}

/** A Slack channel excerpt: an unrelated line before the message that matters, as a search hit usually shows. */
function chat(t: Rng, channel: string, lines: { who: Person; text: string; when: number }[], bystander: Person): Plant {
  const chatter = t.pick([
    "has anyone got a spare HDMI adapter? the one in the big room has walked off",
    "coffee machine on 4 is descaling, use the one by reception",
    "reminder that timesheets are due by Friday lunchtime",
    "who's in tomorrow? thinking of ordering pizza for the demo",
  ]);
  const first = lines[0]!.when - t.int(4, 40) * 60_000;
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

const NEW_OWNERS = ["Hiroshi Sato", "Nina Brandt", "Clara Jansen", "Tunde Bakare"];

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  {
    // Shares the client's organisation only; decoy: the purchase order has been issued (prerequisite met).
    name: "invoice-awaiting-po",
    build: (c) => {
      const [a] = c.clients(1);
      const amount = (c.r.int(16, 60) * 500).toLocaleString("en-US");
      const po = `PO-${c.r.int(40000, 49999)}`;
      const deal = (status: string): Plant => ({
        sourceId: "crm",
        kind: "deal",
        title: `${a!.org} — Partner onboarding Q4`,
        text:
          `Deal: ${a!.org} — Partner onboarding Q4\nStage: Closed won\nAmount: £${amount}\nOwner: Robin Carter\n` +
          `Champion: ${a!.full}\nBilling note: their AP team only pays bills that quote a purchase order number ` +
          `(their policy since 1 Sep). ${status}`,
        updatedAt: at(10, 21, 14, 20),
      });
      return {
        text:
          `Raise the invoice to ${a!.org} for the October integration work, £${amount}, and email it to their ` +
          "accounts payable.",
        detail:
          `${a!.org} only pays bills that quote a purchase order number, and their PO for this work has not been ` +
          `issued yet (CRM billing note, chased 14 October 2026); an invoice sent now would be rejected, so the PO ` +
          `is needed from ${a!.full} first.`,
        hidden: deal(`PO requested from their procurement on 14 Oct, not issued yet; chase ${a!.full}.`),
        decoy: deal(`${po} issued by their procurement on 21 Oct; quote it on everything for this deal.`),
      };
    },
  },
  {
    // Shares the topic word "board"; decoy: the colleague built another team's pages, not Robin's.
    name: "board-pages-done",
    build: (c) => {
      const [x, by] = c.colleagues(2);
      const line = (whose: string, tail: string) =>
        `Robin, I've already built ${whose} pages for the board deck from the Q3 dashboard last night. ${tail}`;
      return {
        text: "Can you knock up a few slides with our partner numbers for the board pack?",
        detail:
          `${x!.full} has already built the Partnerships pages for the board deck from the Q3 dashboard ` +
          "(#leadership, 26 October 2026); Robin only needs to sanity-check them before Thursday, not draft new " +
          "slides.",
        hidden: chat(
          c.ta,
          "leadership",
          [
            {
              who: x!,
              when: at(10, 26, 8, 47),
              text: line("your team's", "Nothing needed from you beyond a sanity check before Thursday."),
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
              when: at(10, 26, 8, 47),
              text: line("the sales", "Your team's section is still yours to do, I haven't touched it."),
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares the client's name only; decoy: the move was called off and they stay the contact.
    name: "pilot-review-new-owner",
    build: (c) => {
      const [a] = c.clients(1);
      const name = c.r.pick(NEW_OWNERS);
      const domain = a!.email.split("@")[1]!;
      const heir = { full: name, email: `${name.split(" ")[0]!.toLowerCase()}@${domain}` };
      const contact = (note: string, when: number): Plant => ({
        sourceId: "crm",
        kind: "contact",
        title: a!.full,
        text:
          `Contact: ${a!.full}\nTitle: ${a!.title ?? "Head of Partnerships"}\nCompany: ${a!.org}\nEmail: ${a!.email}\n` +
          `Lifecycle: customer\n${note}`,
        updatedAt: when,
      });
      return {
        text: `Put a call in with ${a!.full} for Monday 16 November, 3pm, to walk through the pilot results.`,
        detail:
          `${a!.full} moves to ${a!.org}'s APAC team on 2 November 2026 and hands the Northwind relationship to ` +
          `${heir.full} (CRM note, 23 October), so the 16 November pilot review should be set up with ${heir.full}.`,
        hidden: contact(
          `Note (2026-10-23): moving to the APAC team on 2 Nov; hands the Northwind relationship to ${heir.full} ` +
            `(${heir.email}). Everything about the trial goes to ${heir.full} from then.`,
          at(10, 23, 16, 5),
        ),
        decoy: contact(
          "Note (2026-10-26): the move to the APAC team planned for 2 Nov has been called off; stays on as our " +
            "main contact for the trial.",
          at(10, 26, 11, 40),
        ),
      };
    },
  },
  {
    // No shared word ("staff meals", "per person"); decoy: the limit went up and allows the request.
    name: "team-dinner-spend-cap",
    build: (c) => {
      const [fin, by] = c.colleagues(2);
      return {
        text: "Book somewhere nice for the team after the offsite on the 12th, six of us, budget about £80 each.",
        detail:
          "From 1 November 2026 staff meals are capped at £45 per person including drinks " +
          `(${fin!.full} in #finance); £80 a head needs director sign-off before booking.`,
        hidden: chat(
          c.ta,
          "finance",
          [
            {
              who: fin!,
              when: at(10, 22, 16, 30),
              text:
                "New spend rule from 1 Nov: staff meals and celebrations are capped at £45 per person including " +
                "drinks. Anything above that needs director sign-off before you book.",
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
              when: at(10, 22, 16, 30),
              text:
                "Spend rule update from 1 Nov: the limit on staff meals and celebrations goes up to £100 per person " +
                "including drinks, no extra sign-off needed under that.",
            },
          ],
          by!,
        ),
      };
    },
  },
  // ── family ──
  {
    // No shared word ("Thu 29/10 from 17:30", "look after"); decoy: the same arrangement a week later.
    name: "babysitter-mum-booked",
    build: () => {
      const entry = (day: number, label: string) =>
        event({
          title: "Mum here to look after Maya",
          start: at(day > 20 ? 10 : 11, day, 17, 30),
          when: `${label} from 17:30 (sleeps in the spare room, leaves after the school run)`,
          where: "Home",
          notes: "Maya's bedtime 7:30, reading book in her bag. Leave Mum the spare key.",
          edited: at(10, 19, 21, 10),
        });
      return {
        text: "Find us a babysitter for Thursday night, 6 till 11ish, we've got that dinner.",
        detail:
          "Mum (Ruth Carter) is already down to look after Maya on Thursday 29 October 2026 from 17:30 and stays " +
          "over (calendar), so no babysitter is needed.",
        hidden: entry(29, "Thu 29/10"),
        decoy: entry(5, "Thu 05/11"),
      };
    },
  },
  {
    // No shared word ("Wed 11/11", parents' evening); decoy: the slot is the following Wednesday.
    name: "pta-quiz-parents-evening",
    build: () => {
      const entry = (day: number, label: string) =>
        event({
          title: "Parents' evening: Mrs Daley (Year 3)",
          start: at(11, day, 19, 10),
          when: `${label}, 19:10-19:20`,
          where: "Highbury Primary, Room 6",
          notes: "Booked slot, can't be moved online after Friday. Bring the reading record.",
          edited: at(10, 20, 20, 45),
        });
      return {
        text: "Get two tickets for the PTA quiz night at the Hen and Chickens, Wednesday 11 November, 7pm start.",
        detail:
          "Robin has a parents' evening slot with Mrs Daley at 19:10 on Wednesday 11 November 2026 (calendar), " +
          "which clashes with the 7pm quiz.",
        hidden: entry(11, "Wed 11/11"),
        decoy: entry(18, "Wed 18/11"),
      };
    },
  },
  {
    // Shares the name Ellie only; decoy: the size change is for Finn's sister.
    name: "nephew-size-up",
    build: (c) => {
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      return {
        text: "Order Ellie's boy the trainers he's been after for Christmas, the Nike Air Max, kids' size 2.",
        detail:
          "Ellie's son Finn has gone up to a size 4 (Ellie's email of 24 October 2026), so a size 2 would be too " +
          "small.",
        hidden: mail(c, c.ta, {
          from: ellie,
          when: at(10, 24, 19, 50),
          title: "Growth spurt",
          body: [
            "Finn's had another growth spurt, he's a 4 in shoes now.",
            "Everything I bought him in September is already too small, honestly.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: ellie,
          when: at(10, 24, 19, 50),
          title: "Growth spurt",
          body: [
            "Rosie's had another growth spurt, she's a 13 in shoes now. Finn's still a 2, thank goodness.",
            "Everything I bought her in September is already too small, honestly.",
          ],
        }),
      };
    },
  },
  {
    // Shares the topic word "trip"; decoy: the consent slip is in and payment is open.
    name: "trip-consent-slip",
    build: (c) => {
      const t = c.role("Maya's teacher", ["Mrs", "Daley"]);
      return {
        text: "Pay the £18 for Maya's Science Museum trip on ParentPay.",
        detail:
          "The school hasn't received Maya's signed consent slip for the Year 3 trip on 19 November 2026; payment " +
          "can't be taken until it is returned (by Friday 6 November, Mrs Daley's email).",
        hidden: mail(c, c.ta, {
          from: t,
          when: at(10, 23, 15, 5),
          title: "Year 3 outing, 19 November",
          body: [
            "We still don't have a signed consent slip from you for the trip on 19 November.",
            "Payment can't be taken until the slip is back, and children without one stay in school that day. " +
              "Please return it by Friday 6 November.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: t,
          when: at(10, 23, 15, 5),
          title: "Year 3 outing, 19 November",
          body: [
            "Thank you, we have your signed consent slip for the trip on 19 November.",
            "Online payment is now open whenever suits you, any time before Friday 6 November.",
          ],
        }),
      };
    },
  },
  // ── health ──
  {
    // No shared word (NSAIDs, apixaban); decoy: the course of blood thinners has ended.
    name: "painkiller-anticoagulant",
    build: (c) => {
      const gp = bot("Canonbury Medical Practice", "no-reply@canonburymedical.nhs.uk");
      return {
        text: "Add ibuprofen and some Lemsip Max to the Boots order please, I've got a stinker of a cold.",
        detail:
          "Robin has been on apixaban, a blood thinner, since 9 October 2026 (GP letter) and must avoid " +
          "anti-inflammatory painkillers such as ibuprofen; paracetamol-only products are the safe choice.",
        hidden: notice(c, c.ta, {
          from: gp,
          when: at(10, 9, 12, 0),
          title: "Your new medicine: apixaban",
          body:
            "You started apixaban 5mg twice daily on 09/10/2026. While you take it, do not use anti-inflammatory " +
            "painkillers (NSAIDs) such as aspirin or naproxen, as they raise the risk of bleeding. Use paracetamol " +
            "instead and check combination products with a pharmacist.",
        }),
        decoy: notice(c, c.tb, {
          from: gp,
          when: at(10, 9, 12, 0),
          title: "Your medicine: apixaban stopped",
          body:
            "Your three-month course of apixaban finished on 09/10/2026 and has been stopped on your record. There " +
            "are no longer any restrictions on other medicines because of it.",
        }),
      };
    },
  },
  {
    // Shares the topic word "running"; decoy: the clinic discharged Robin back to full training.
    name: "ankle-no-impact",
    build: (c) => {
      const clinic = bot("Pure Sports Clinic", "results@puresportsclinic.co.uk");
      return {
        text: "Message Tom and book me back in twice a week from Monday, I want to get the running up again for the half.",
        detail:
          "Robin has a grade 2 ankle sprain: the sports clinic advised no running, jumping or impact training until " +
          "2 December 2026, so training sessions should be low-impact (cycling, swimming) until then.",
        hidden: notice(c, c.ta, {
          from: clinic,
          when: at(10, 21, 17, 0),
          title: "Your scan results",
          body:
            "Your scan on 21/10/2026 shows a grade 2 sprain of the right ankle ligaments. For six weeks (until " +
            "02/12/2026): no running, jumping or impact training. Cycling, swimming and upper-body work are fine.",
        }),
        decoy: notice(c, c.tb, {
          from: clinic,
          when: at(10, 21, 17, 0),
          title: "Your follow-up",
          body:
            "At your follow-up on 21/10/2026 the right ankle had fully healed. You are discharged and can return to " +
            "running and all training as normal.",
        }),
      };
    },
  },
  {
    // Shares the topic word "lenses" (as "lens"); decoy: the prescription is unchanged, so a repeat is fine.
    name: "lens-strength-changed",
    build: (c) => {
      const opt = bot("Vision Express", "eyecare@visionexpress.co.uk");
      return {
        text: "Reorder my monthly contact lenses, same as last time, six months' worth.",
        detail:
          "Robin's right-eye prescription changed at the eye test on 17 October 2026 (from -2.25 to -2.75; left " +
          "unchanged at -2.00), so repeating the last order would be the wrong strength.",
        hidden: notice(c, c.ta, {
          from: opt,
          when: at(10, 17, 16, 15),
          title: "Your eye test results",
          body:
            "Following your eye test on 17/10/2026 your right eye prescription has changed from -2.25 to -2.75; " +
            "left eye unchanged at -2.00. Please use the new prescription for any lens orders.",
        }),
        decoy: notice(c, c.tb, {
          from: opt,
          when: at(10, 17, 16, 15),
          title: "Your eye test results",
          body:
            "Following your eye test on 17/10/2026 your prescription is unchanged (right -2.25, left -2.00) and is " +
            "valid for lens orders until 17/10/2028.",
        }),
      };
    },
  },
  {
    // Shares the topic word "clinic"; decoy: an allergy test removed the label.
    name: "penicillin-on-form",
    build: (c) => {
      const hosp = bot("Whittington Allergy Service", "allergy.letters@whittington.nhs.uk");
      return {
        text: "Fill in the registration form for the new dermatology clinic in Marylebone, use my usual details.",
        detail:
          "Robin is now recorded as allergic to penicillin (amoxicillin) after a reaction on 2 October 2026 " +
          "(hospital letter), so the allergy must go on the clinic's registration form.",
        hidden: notice(c, c.ta, {
          from: hosp,
          when: at(10, 12, 10, 0),
          title: "Letter after your reaction",
          body:
            "Following your reaction on 02/10/2026 you are now recorded as allergic to penicillin (amoxicillin). " +
            "Please tell any clinic, dentist or pharmacist who treats you.",
        }),
        decoy: notice(c, c.tb, {
          from: hosp,
          when: at(10, 12, 10, 0),
          title: "Letter after your allergy test",
          body:
            "Your penicillin challenge on 02/10/2026 showed no allergy. The penicillin allergy label has been " +
            "removed from your record and you can take it normally; any clinic can treat you as not allergic.",
        }),
      };
    },
  },
  // ── money ──
  {
    // Shares the brand name Amex only; decoy: plenty of available credit.
    name: "amex-headroom",
    build: (c) => {
      const amex = bot("Amex Alerts", "alerts@americanexpress.co.uk");
      const body = (avail: string, bal: string) =>
        `Your available credit is ${avail} (credit limit £6,000.00; current balance ${bal}). Transactions above ` +
        "your available credit may be declined.";
      return {
        text: "Pay the £1,650 villa deposit on my Amex.",
        detail:
          "Only £640 of credit is available on Robin's Amex (balance £5,360 of a £6,000 limit, alert of 25 October " +
          "2026), so a £1,650 payment would likely be declined.",
        hidden: notice(c, c.ta, {
          from: amex,
          when: at(10, 25, 7, 30),
          title: "Your balance update",
          body: body("£640.00", "£5,360.00"),
        }),
        decoy: notice(c, c.tb, {
          from: amex,
          when: at(10, 25, 7, 30),
          title: "Your balance update",
          body: body("£4,820.00", "£1,180.00"),
        }),
      };
    },
  },
  {
    // No shared word ("J FOX", "CONCERT TIX"); decoy: the transfer came from someone else.
    name: "gig-money-back",
    build: (c) => {
      const bank = bot("Thames Bank", "alerts@thamesbank.co.uk");
      const ending = c.r.token("0123456789", 4);
      const body = (who: string) =>
        `You received £120.00 from ${who}, reference CONCERT TIX, on 24/10/2026 into your current account ending ` +
        `${ending}.`;
      return {
        text: "Nudge Jamie about the £120 he still owes me for the gig tickets.",
        detail:
          "Jamie has already paid the £120 back: a transfer from J FOX (reference CONCERT TIX) arrived on " +
          "24 October 2026.",
        hidden: notice(c, c.ta, { from: bank, when: at(10, 24, 13, 2), title: "Money in", body: body("J FOX") }),
        decoy: notice(c, c.tb, { from: bank, when: at(10, 24, 13, 2), title: "Money in", body: body("L HADDAD") }),
      };
    },
  },
  {
    // No shared word ("return", "HMRC"); decoy: the accountant is not doing it this time, so the request applies.
    name: "accountant-filed-return",
    build: (c) => {
      const owen = c.role("accountant", ["Owen", "Price"]);
      return {
        text: "Can you make a start on my self assessment? Want it sorted well before the January deadline.",
        detail:
          "Owen Price (the accountant) already filed Robin's 2025-26 tax return on 21 October 2026; £2,340 is due " +
          "to HMRC by 31 January 2027, so there's nothing to start.",
        hidden: mail(c, c.ta, {
          from: owen,
          when: at(10, 22, 10, 25),
          title: "Your 2025-26 return",
          body: [
            "Good news: I filed your 2025-26 return with HMRC yesterday.",
            "You owe £2,340, payable by 31/01/2027. I'll send the payment details separately.",
          ],
          corporate: true,
        }),
        decoy: mail(c, c.tb, {
          from: owen,
          when: at(10, 22, 10, 25),
          title: "Your 2025-26 return",
          body: [
            "As I mentioned, I'm winding the practice down, so I won't be doing your 2025-26 return with HMRC.",
            "You'll need to file it yourself or find someone new; happy to pass on your figures from last time.",
          ],
          corporate: true,
        }),
      };
    },
  },
  {
    // Shares the topic word "overpay"; decoy: the fixed rate ended, so there is no charge.
    name: "overpayment-allowance-left",
    build: (c) => {
      const lender = bot("Harbour Home Loans", "service@harbourhomeloans.co.uk");
      return {
        text: "Move £15k from savings and overpay the mortgage with it.",
        detail:
          "Only £3,800 of the penalty-free overpayment allowance is left until 31 March 2027 (£8,000 of £11,800 " +
          "used); overpaying £15,000 would incur a 3% early repayment charge on the excess (about £336).",
        hidden: notice(c, c.ta, {
          from: lender,
          when: at(10, 14, 6, 45),
          title: "Your overpayment allowance",
          body:
            "You can overpay up to 10% of your balance each year without an early repayment charge. Allowance to " +
            "31/03/2027: £11,800.00; used so far: £8,000.00; remaining: £3,800.00. Overpayments above this incur " +
            "a 3% charge until your fixed rate ends on 31/03/2028.",
        }),
        decoy: notice(c, c.tb, {
          from: lender,
          when: at(10, 14, 6, 45),
          title: "Your fixed rate has ended",
          body:
            "Your fixed rate ended on 30/09/2026 and you are now on our standard variable rate. You can overpay " +
            "any amount at any time with no early repayment charge.",
        }),
      };
    },
  },
  // ── travel ──
  {
    // Shares the city name only; decoy: a colleague's flight was retimed, not Robin's.
    name: "berlin-outbound-retimed",
    build: (c) => {
      const [desk, y, by] = c.colleagues(3);
      const line = (who: string) =>
        `@${who} heads up, BA has retimed your Berlin outbound on Tue 17/11: BA982 now leaves LHR at 06:35 ` +
        "(was 08:50). Hotel and return unchanged.";
      return {
        text: "Book a cab to Heathrow for my Berlin trip, pick me up at home 3 hours before the flight.",
        detail:
          "Robin's Berlin outbound on Tuesday 17 November 2026 has been retimed: BA982 now leaves Heathrow at 06:35 " +
          `instead of 08:50 (${desk!.full} in #travel), so the pickup should be about 03:35.`,
        hidden: chat(c.ta, "travel", [{ who: desk!, when: at(10, 26, 13, 12), text: line("Robin") }], by!),
        decoy: chat(c.tb, "travel", [{ who: desk!, when: at(10, 26, 13, 12), text: line(y!.first) }], by!),
      };
    },
  },
  {
    // No shared word ("winter sports", "on- or off-piste"); decoy: the add-on was bought.
    name: "winter-sports-not-covered",
    build: (c) => {
      const pol = c.r.token("0123456789", 8);
      const schedule = (line: string, edited: number) =>
        doc(
          "Annual travel insurance: policy schedule 2026-27",
          `Insurer: Larkspur Travel Insurance. Policy ${pol}. Period 01/09/2026-31/08/2027.\n` +
            "Cover: Europe, family (2 adults, 1 child). Medical expenses £10m; cancellation £5,000 per person.\n" +
            `${line}\nExcess: £75 per claim.`,
          edited,
        );
      return {
        text: "Book me 5 mornings of ski school in Morzine for February half term.",
        detail:
          "Robin's annual travel insurance doesn't include winter sports (the £39 add-on wasn't bought, policy " +
          "schedule), so the Morzine trip needs that cover added before going on the slopes.",
        hidden: schedule(
          "Winter sports: NOT COVERED (optional add-on, £39, not purchased). Without it, on- or off-piste " +
            "activities and snowboarding are excluded.",
          at(9, 1, 11),
        ),
        decoy: schedule(
          "Winter sports: COVERED (add-on purchased 03/10/2026, £39), including on- or off-piste activities with " +
            "a guide and snowboarding.",
          at(10, 3, 11),
        ),
      };
    },
  },
  {
    // Shares the name Vatican only; decoy: the closure noted is a different day of the trip.
    name: "vatican-feast-day",
    build: () => {
      const notes = (line: string) =>
        doc(
          "Rome, 5-9 Dec: notes",
          "Flat: Via dei Coronari, check-in from 15:00. Airport bus from Fiumicino every 30 min.\n" +
            `${line}\nColosseum: open daily, book the underground tour ahead. Trastevere for dinner on the Saturday.`,
          at(10, 18, 21),
        );
      return {
        text: "Get 3 tickets for the Vatican Museums on Tuesday 8 December, first entry slot.",
        detail:
          "The Vatican Museums are closed on Tuesday 8 December 2026 for the Immaculate Conception holiday (Rome " +
          "trip notes); Monday 7 or Wednesday 9 December would work instead.",
        hidden: notes(
          "Vatican Museums: closed Tue 8/12 (Immaculate Conception, public holiday); go Mon 7th or Wed 9th.",
        ),
        decoy: notes("Vatican Museums: closed Sun 6/12 (Sunday closure); open every other day we're there."),
      };
    },
  },
  {
    // Shares the topic word "Christmas"; decoy: Mum's plan to come was superseded.
    name: "christmas-extra-passenger",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      return {
        text:
          "Hire a car at Edinburgh airport over Christmas, 23rd to 28th. The cheapest small one is fine for the three " +
          "of us.",
        detail:
          "Mum (Ruth Carter) is now joining the Christmas trip on the same flight on 23 December (her email of " +
          "22 October 2026), so the hire car needs room for four and a large suitcase, not the cheapest small one.",
        hidden: mail(c, c.ta, {
          from: mum,
          when: at(10, 22, 18, 40),
          title: "Scotland",
          body: [
            "I've decided to come up to Scotland with you all for Christmas after all. I've booked myself on your " +
              "flight on the 23rd!",
            "Hope there's space for me and my big suitcase when we drive up to the cottage.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: mum,
          when: at(10, 22, 18, 40),
          title: "Scotland",
          body: [
            "I was going to come up to Scotland with you all for Christmas, but I've decided to go to Ellie's in " +
              "Bristol instead.",
            "You three have a lovely time at the cottage.",
          ],
        }),
      };
    },
  },
  // ── home ──
  {
    // Shares the dog's name only; decoy: the vaccine is in date.
    name: "kennel-cough-lapsed",
    build: (c) => {
      const vet = bot("Archway Vets", "reminders@archwayvets.co.uk");
      return {
        text: "Book Biscuit into Highgate Paws kennels from 12 to 19 December.",
        detail:
          "Biscuit's kennel cough (Bordetella) vaccine lapsed on 30 September 2026 (vet reminder); boarding " +
          "normally needs it given at least 14 days before the stay, so it must be done by 28 November.",
        hidden: notice(c, c.ta, {
          from: vet,
          when: at(10, 2, 8, 0),
          title: "Vaccination reminder: Biscuit",
          body:
            "Biscuit's Bordetella vaccine (intranasal) expired on 30/09/2026. Most boarding facilities require it " +
            "to be given at least 14 days before a stay. Book online or call us.",
        }),
        decoy: notice(c, c.tb, {
          from: vet,
          when: at(10, 3, 8, 0),
          title: "Vaccination record: Biscuit",
          body:
            "Biscuit's Bordetella vaccine (intranasal) was given on 03/10/2026 and is valid until 03/10/2027. " +
            "A certificate is attached for any boarding facility.",
        }),
      };
    },
  },
  {
    // Shares the topic word "windows"; decoy: the planned direction was dropped.
    name: "conservation-area-windows",
    build: (c) => {
      const planning = bot("Islington Planning", "planning@islington.gov.uk");
      return {
        text: "Get me three quotes for new uPVC windows at the front of the house.",
        detail:
          "The house is in the Highbury Hill Conservation Area, where from 1 November 2026 replacing front windows " +
          "needs planning permission and plastic (uPVC) frames won't normally be approved (council notice), so " +
          "timber quotes or a planning application come first.",
        hidden: notice(c, c.ta, {
          from: planning,
          when: at(10, 15, 9, 0),
          title: "Article 4 direction: Highbury Hill Conservation Area",
          body:
            "This letter is sent to all properties on Kelvin Road N5. From 01/11/2026, replacing front windows or " +
            "doors in the Highbury Hill Conservation Area needs planning permission, and plastic frames will not " +
            "normally be approved.",
        }),
        decoy: notice(c, c.tb, {
          from: planning,
          when: at(10, 15, 9, 0),
          title: "Article 4 direction: Highbury Hill Conservation Area",
          body:
            "This letter is sent to all properties on Kelvin Road N5. The proposed direction consulted on in the " +
            "spring will not go ahead: replacing front windows or doors on your street still needs no planning " +
            "permission.",
        }),
      };
    },
  },
  {
    // Shares the topic word "recycling"; decoy: a different collection (garden waste) moves.
    name: "collection-day-moves",
    build: (c) => {
      const waste = bot("Islington Waste Services", "waste@islington.gov.uk");
      return {
        text: "Set me a weekly reminder, Wednesday nights from next week, to put the recycling out.",
        detail:
          "From 2 November 2026 the street's recycling is collected on Mondays instead of Thursdays (council " +
          "notice), so the reminder should be Sunday nights, not Wednesdays.",
        hidden: notice(c, c.ta, {
          from: waste,
          when: at(10, 16, 7, 0),
          title: "Your collection day is changing",
          body:
            "From Monday 02/11/2026, recycling and rubbish on Kelvin Road will be collected on Mondays instead of " +
            "Thursdays. Please put bins out by 6am on collection day.",
        }),
        decoy: notice(c, c.tb, {
          from: waste,
          when: at(10, 16, 7, 0),
          title: "Your collection day is changing",
          body:
            "From Monday 02/11/2026, garden waste on Kelvin Road will be collected on Mondays instead of Fridays. " +
            "Recycling and rubbish days are unchanged.",
        }),
      };
    },
  },
  {
    // Shares the cleaner's name only; decoy: she is back from her trip.
    name: "cleaner-in-porto",
    build: (c) => {
      const ana = bot("Ana Sousa", "ana.sousa.limpezas@gmail.com");
      return {
        text: "Ask Ana to give the oven a deep clean when she's in on Friday the 6th.",
        detail:
          "Ana is away in Porto from 2 to 20 November 2026 (her email), so she won't be in on Friday 6 November; " +
          "her next visit is after 23 November.",
        hidden: mail(c, c.ta, {
          from: ana,
          when: at(10, 20, 20, 0),
          title: "November",
          body: [
            "Just to remind you I'm in Porto with my family from 2 to 20 November, so no work those weeks.",
            "Back Monday 23rd, same day as normal after that.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: ana,
          when: at(10, 20, 20, 0),
          title: "November",
          body: [
            "I'm back from Porto now, sorry again about the missed weeks.",
            "Normal Fridays from now on, see you then.",
          ],
        }),
      };
    },
  },
  // ── admin ──
  {
    // Shares the topic word "passport"; decoy: the application in progress is Robin's own, not Maya's.
    name: "child-passport-in-progress",
    build: (c) => {
      const hmpo = bot("HM Passport Office", "noreply@passport.service.gov.uk");
      const ref = c.r.token("0123456789", 10);
      const body = (who: string) =>
        `Your passport application for ${who} (ref ${ref}) was received on 12/10/2026 and is being processed. ` +
        "Do not send another application. We'll email you when it has been posted.";
      return {
        text: "Do my daughter's passport renewal online tonight, the photo's on my desktop.",
        detail:
          `Maya's passport application was already received on 12 October 2026 and is being processed (HM Passport ` +
          `Office, ref ${ref}), so applying again isn't needed.`,
        hidden: notice(c, c.ta, {
          from: hmpo,
          when: at(10, 12, 15, 0),
          title: "Application received",
          body: body("MAYA CARTER"),
        }),
        decoy: notice(c, c.tb, {
          from: hmpo,
          when: at(10, 12, 15, 0),
          title: "Application received",
          body: body("ROBIN CARTER"),
        }),
      };
    },
  },
  {
    // No shared word (jury service, "16/11/2026"); decoy: the service was deferred to March.
    name: "jury-service-summons",
    build: (c) => {
      const jcsb = bot("Jury Central Summoning Bureau", "jury@justice.gov.uk");
      return {
        text: "Say yes to the speaker slot at Partner Summit on Tuesday 24 November and block the day.",
        detail:
          "Robin is summoned for jury service at Snaresbrook Crown Court from Monday 16 November 2026 for up to ten " +
          "working days (to 27 November), which covers 24 November.",
        hidden: notice(c, c.ta, {
          from: jcsb,
          when: at(9, 28, 10, 0),
          title: "Jury summons",
          body:
            "You are summoned for jury service at Snaresbrook Crown Court starting Monday 16/11/2026, for up to 10 " +
            "working days (to 27/11/2026). Please confirm your attendance online.",
        }),
        decoy: notice(c, c.tb, {
          from: jcsb,
          when: at(10, 8, 10, 0),
          title: "Jury service: deferral granted",
          body:
            "Your request to defer jury service at Snaresbrook Crown Court has been granted. Your new start date is " +
            "Monday 08/03/2027; you do not need to attend in 2026.",
        }),
      };
    },
  },
  {
    // Shares the gym's name only; decoy: the minimum term is over.
    name: "gym-minimum-term",
    build: (c) => {
      const gym = bot("PureGym", "hello@puregym.com");
      return {
        text: "Cancel my PureGym membership from the end of this month please.",
        detail:
          "Robin's PureGym plan is in a 12-month minimum term until 31 January 2027; leaving at the end of October " +
          "means paying the remaining three months (£29.99 each) anyway.",
        hidden: notice(c, c.ta, {
          from: gym,
          when: at(10, 1, 6, 0),
          title: "Your plan details",
          body:
            "Your plan is in its 12-month minimum term until 31/01/2027. If you leave before then, the remaining " +
            "monthly fees (£29.99 a month) are still due.",
        }),
        decoy: notice(c, c.tb, {
          from: gym,
          when: at(10, 1, 6, 0),
          title: "Your plan details",
          body:
            "Your 12-month minimum term ended on 31/07/2026. You're now on a rolling monthly plan and can leave at " +
            "any time with no notice.",
        }),
      };
    },
  },
  {
    // No shared word ("tenancy", "lessor"); decoy: the agreement is the old one and the term is now periodic.
    name: "tenancy-fixed-term",
    build: () => {
      const agreement = (title: string, term: string, edited: number) =>
        doc(
          title,
          "Assured shorthold tenancy. Lessor: S. Hargreaves. Tenants: R. Carter and household.\n" +
            `${term}\nRent: £2,350 per calendar month, due on the 14th. Deposit held with the DPS.`,
          edited,
        );
      return {
        text: "Draft our notice email for the landlord, we're aiming to move out by the end of January.",
        detail:
          "The tenancy is in a fixed term until 13 March 2027 with no break clause (tenancy agreement), so leaving " +
          "at the end of January needs the landlord's written agreement or rent paid to March.",
        hidden: agreement(
          "Tenancy agreement 2026-27",
          "Fixed term: 14/03/2026 to 13/03/2027. No break clause: the tenant may not terminate before the fixed " +
            "term expires unless the lessor agrees in writing.",
          at(3, 10, 12),
        ),
        decoy: agreement(
          "Tenancy agreement 2025-26",
          "Fixed term: 14/03/2025 to 13/03/2026, then periodic month to month. After the fixed term the tenant may " +
            "terminate with one month's written notice expiring on a rent day.",
          at(3, 10, 12, 0, 2025),
        ),
      };
    },
  },
  // ── social ──
  {
    // No shared word (coeliac, "the 7th"); decoy: the coeliac test came back negative.
    name: "coeliac-dinner-guest",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      return {
        text: "Plan a roast for six on Saturday 7th and do me a shopping list.",
        detail:
          "Leila's partner Kai, one of the six, has coeliac disease (Leila's email of 23 October 2026): the roast " +
          "needs to be fully gluten-free, including the gravy and stuffing.",
        hidden: mail(c, c.ta, {
          from: leila,
          when: at(10, 23, 21, 30),
          title: "Kai",
          body: [
            "Can't wait for the 7th! One thing: Kai has just been diagnosed coeliac.",
            "He can't have any gluten at all, not even gravy thickened with flour. Sorry to be a pain!",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: leila,
          when: at(10, 23, 21, 30),
          title: "Kai",
          body: [
            "Can't wait for the 7th! Kai's coeliac test came back negative, so panic over.",
            "He can eat anything after all, gravy and all.",
          ],
        }),
      };
    },
  },
  {
    // Shares the band's and venue's names only; decoy: Jamie got presale tickets for another band.
    name: "presale-already-got",
    build: (c) => {
      const jamie = c.role("best friend", ["Jamie", "Fox"]);
      const body = (band: string, venue: string, day: string) => [
        `GOT THEM. 4 for ${band} at ${venue} in the presale, ${day}, standing.`,
        "You, me and the Haddads. Pay me back whenever.",
      ];
      return {
        text: "Two tickets for Fontaines D.C. at Ally Pally when general sale opens Friday, please.",
        detail:
          "Jamie already got four standing tickets for Fontaines D.C. at Ally Pally (Saturday 6 March 2027) in the " +
          "presale, including one for Robin (his email of 26 October 2026), so buying two more isn't needed.",
        hidden: mail(c, c.ta, {
          from: jamie,
          when: at(10, 26, 10, 3),
          title: "!!!",
          body: body("Fontaines D.C.", "Ally Pally", "Sat 6 March"),
        }),
        decoy: mail(c, c.tb, {
          from: jamie,
          when: at(10, 26, 10, 3),
          title: "!!!",
          body: body("IDLES", "Brixton Academy", "Fri 12 March"),
        }),
      };
    },
  },
  {
    // Shares the name Jamie only; decoy: the surprise is for Leila, not Jamie.
    name: "surprise-fortieth-friday",
    build: () => {
      const entry = (who: string, host: string) =>
        event({
          title: `${who}'s surprise 40th (SHH)`,
          start: at(11, 20, 19),
          when: "Fri 20/11, 19:00 till late",
          where: "The Lexington, Pentonville Road",
          notes:
            `Invite from ${host}. ${who} thinks it's a quiet pint with ${host}. Don't make other plans with ${who} ` +
            "that night and don't mention it!",
          edited: at(10, 17, 22, 5),
        });
      return {
        text: "Ask Jamie if he's up for a curry on Friday 20th, just the two of us.",
        detail:
          "Friday 20 November 2026 is Jamie's surprise 40th at the Lexington (invite from his partner Hannah, " +
          "calendar); Robin is invited and shouldn't make other plans with Jamie that night or let it slip.",
        hidden: entry("Jamie", "Hannah"),
        decoy: entry("Leila", "Kai"),
      };
    },
  },
  {
    // Shares the name Leila only; decoy: her run of night shifts is over.
    name: "friend-on-nights",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      return {
        text: "Invite Leila and her new fella round for dinner, suggest a couple of weeknights the week of the 16th.",
        detail:
          "Leila is on night shifts Monday to Thursday until the end of November 2026 (her email), so weeknights " +
          "the week of 16 November won't work; a weekend would.",
        hidden: mail(c, c.ta, {
          from: leila,
          when: at(10, 25, 11, 15),
          title: "Rota",
          body: [
            "New rota's out and I'm on nights at the hospital Monday to Thursday until the end of November.",
            "So it's weekends only for me for a bit, I'm a zombie otherwise.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: leila,
          when: at(10, 25, 11, 15),
          title: "Rota",
          body: [
            "My run of nights at the hospital finished last week, thank god.",
            "Back to normal now, so I'm free most evenings again.",
          ],
        }),
      };
    },
  },
];

/**
 * Plant one item per template (the real one for `hidden`, the decoy for `control`, nothing for `neutral`) and return
 * the tasks. Builds both items every time so RNG draws, and so the people and numbers in each task, match across the
 * three variants.
 */
export function plantHeldout15(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 1_515);
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
  const suite = variant === "hidden" ? "heldout15" : `heldout15-${variant}`;
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
      role: (role, [first, last]) =>
        world.people.find((p) => p.role === role) ?? standIn(first, last, relationOf(role)),
    };
    const spec = t.build(ctx);
    if (variant !== "neutral") {
      const p = variant === "hidden" ? spec.hidden : spec.decoy;
      // The same ref in hidden and control, so the item id does not tell a grader or a model which variant it is.
      const ref = `h15-${t.name}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    tasks.push({ id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}

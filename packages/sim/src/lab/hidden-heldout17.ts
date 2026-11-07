/**
 * Held-out hidden-context suite 17: written blind for the end-of-day confirmation (heldout17), by an author who saw
 * only hidden-heldout16.ts (as a format example), the HiddenTask interface and the sim world API (world.ts, names.ts,
 * text.ts, rng.ts). No engine, ranking, reader, prompt, card or intent code, no other suite, no docs and no research
 * note was read. Measurement only: never tune on it.
 *
 * 32 requests a user types to their personal agent, four in each life area: work, family, health, money, travel,
 * home, admin and social. The situations and template names differ from heldout16's. Each template plants one item
 * the request does not ask about: in the `hidden` variant the real consideration (a clash, a lapsed prerequisite,
 * "already done", a rule, someone's constraint, a closure, a correction), in the `control` variant a near-miss decoy
 * that looks relevant but does not apply. The `neutral` variant plants nothing. Request and `detail` are identical
 * across the three variants, so an answer that raises the detail in control or neutral is a false claim.
 *
 * Word overlap between the request and the planted item: 10 templates share no content word (paraphrase, other date
 * formats), 11 share only a name (person, organisation, brand or place), 11 share one topic word. Decoys: 11
 * resolved/expired/superseded, 11 about another entity or date of the same kind, 10 where the condition is met or
 * the item allows the request. Each template's comment names its overlap bucket and decoy.
 *
 * Late arrivals: 8 templates, one per life area, plant a fact that naturally lands after the request, later the same
 * day (HELDOUT17_LATE: partner-mailout-embargo, sleepover-vs-parents-evening, trainer-cancels-week,
 * accountant-corrected-bill, early-flight-retimed, plumber-vs-water-off, council-tax-dd-set-up,
 * birthday-drinks-moved). Their hidden item and decoy are both dated the morning of NOW (08:00-08:59 UTC, before NOW,
 * so they are valid planted up front too) and read as fresh news that still matters if the agent already acted. A
 * harness may hold them back and release them after the answer, re-stamping `updatedAt`.
 *
 * World time is NOW in world.ts: Tuesday 27 October 2026, 09:00 UTC. Weekdays below were checked against it
 * (Wednesday 28 October, Thursday 29 October, Friday 30 October, Saturday 31 October, Monday 2 November, Tuesday 3
 * November, Wednesday 4 November, Friday 6 November, Saturday 7 November, Monday 9 November, Thursday 12 November,
 * Friday 13 November, Saturday 14 November, Monday 16 November, Wednesday 18 November, Thursday 19 November, Thursday
 * 3 December, Saturday 5 December, Thursday 17 December, Saturday 9 January 2027).
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

/**
 * Templates whose planted fact naturally arrives after the request, later the same day. Their items (hidden and
 * decoy) are dated 08:00-08:59 on the morning of NOW, so a harness can also hold them back and release them later.
 */
export const HELDOUT17_LATE: readonly string[] = [
  "partner-mailout-embargo",
  "sleepover-vs-parents-evening",
  "trainer-cancels-week",
  "accountant-corrected-bill",
  "early-flight-retimed",
  "plumber-vs-water-off",
  "council-tax-dd-set-up",
  "birthday-drinks-moved",
];

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  {
    // No shared word ("Wed 04/11, 14:30-16:30", warden course); decoy: the same course a week later.
    name: "onboarding-call-vs-warden-course",
    build: () => {
      const entry = (day: number, label: string) =>
        event({
          title: "Fire warden training (mandatory)",
          start: at(11, day, 14, 30),
          when: `${label}, 14:30-16:30`,
          where: "Northwind HQ, 2nd floor training room",
          notes: "Run by HR for floor wardens; the certificate is needed for the office audit. Can't be moved.",
          edited: at(10, 9, 15, 10),
        });
      return {
        text: "Set up a one-hour onboarding call with the Initech partner team on Wednesday 4 November at 3pm and send them the invite.",
        detail:
          "Robin is booked on mandatory fire warden training on Wednesday 4 November 2026 from 14:30 to 16:30 " +
          "(calendar), which clashes with a 3pm call that day.",
        hidden: entry(4, "Wed 04/11"),
        decoy: entry(11, "Wed 11/11"),
      };
    },
  },
  {
    // Late. Shares the topic word "partner"; decoy: the embargo lifted early (resolved).
    name: "partner-mailout-embargo",
    build: (c) => {
      const [comms, by] = c.colleagues(2);
      const when = at(10, 27, 8, 40);
      return {
        text: "Send the Q4 partner newsletter out to the full mailing list this afternoon, the draft in Drive is signed off.",
        detail:
          `${comms!.full} asked this morning (27 October 2026, #partnerships) for all external partner ` +
          "communications to be held until Thursday 29 October at 9am because the pricing announcement is under " +
          "embargo, so the newsletter shouldn't go out this afternoon.",
        hidden: chat(
          c.ta,
          "partnerships",
          [
            {
              who: comms!,
              when,
              text:
                "Morning all. Please hold ALL external partner comms until Thursday 9am: the pricing announcement is " +
                "under embargo and legal want nothing going out before it. If anything already went out, tell me asap.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "partnerships",
          [
            {
              who: comms!,
              when,
              text:
                "Morning all. The embargo on the pricing announcement lifted early, so external partner comms can go " +
                "ahead as planned from now. Thanks for holding off last week.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares only names (the colleague, Hana Ito); decoy: the colleague referred a different candidate.
    name: "referrer-on-interview-panel",
    build: (c) => {
      const [x, by] = c.colleagues(2);
      const line = (who: string, job: string, pronoun: string) =>
        `fyi I referred ${who} for the ${job} role, we worked together at my last place, so under the referral ` +
        `policy I have to stay off ${pronoun} loop. Happy to cover someone else's.`;
      return {
        text: `Put ${x!.first} on the interview panel for Hana Ito's final round on Monday 9 November.`,
        detail:
          `${x!.full} referred Hana Ito for the senior PM role and, under the referral policy, must stay off her ` +
          "interviews (#hiring, 22 October 2026), so can't sit on her panel.",
        hidden: chat(
          c.ta,
          "hiring",
          [{ who: x!, when: at(10, 22, 11, 35), text: line("Hana Ito", "senior PM", "her") }],
          by!,
        ),
        decoy: chat(
          c.tb,
          "hiring",
          [{ who: x!, when: at(10, 22, 11, 35), text: line("Marco Bell", "data engineer", "his") }],
          by!,
        ),
      };
    },
  },
  {
    // Shares the topic word "hardware"; decoy: the freeze excludes equipment (the item allows the request).
    name: "laptop-order-spend-freeze",
    build: () => {
      const sheet = (rule: string) =>
        doc(
          "Q4 spending controls",
          `Owner: Finance. Applies 26/10/2026 to 31/12/2026.\n${rule}\nQuestions to #finance-requests.`,
          at(10, 23, 17, 0),
        );
      return {
        text: "Order eight MacBook Airs for the new starters in January and charge them to the team hardware budget.",
        detail:
          "Finance's Q4 spending controls (26 October to 31 December 2026) require CFO sign-off before any hardware " +
          "purchase over £1,000 (Q4 spending controls doc), so eight MacBook Airs need approval before ordering.",
        hidden: sheet(
          "Any hardware purchase above £1,000 needs CFO sign-off before anything is bought. Software renewals are " +
            "unaffected.",
        ),
        decoy: sheet(
          "The freeze covers travel, events and contractors only. Hardware purchases continue as normal under each " +
            "manager's existing limits.",
        ),
      };
    },
  },
  // ── family ──
  {
    // Late. No shared word ("Fri 30/10/2026", "17:50", consultations); decoy: the consultations moved to the 6th.
    name: "sleepover-vs-parents-evening",
    build: (c) => {
      const office = bot("Holloway Primary Office", "office@hollowayprimary.sch.uk");
      const body = (date: string) =>
        `Year 3 parent consultations have moved to ${date} because of staff illness on the original date. Your new ` +
        "slot is 17:50 with the class teacher, in the Year 3 classroom. Please let the office know if you cannot " +
        "attend.";
      return {
        text: "Reply to the Hendersons, yes to Maya's sleepover at theirs on Friday, I'll drop her round at 6.",
        detail:
          "The school moved Robin's Year 3 parents' evening slot to Friday 30 October 2026 at 17:50 (school notice " +
          "this morning), which clashes with dropping Maya at the Hendersons' at 6pm.",
        hidden: notice(c, c.ta, {
          from: office,
          when: at(10, 27, 8, 20),
          title: "Change to Year 3 consultations",
          body: body("Fri 30/10/2026"),
        }),
        decoy: notice(c, c.tb, {
          from: office,
          when: at(10, 27, 8, 20),
          title: "Change to Year 3 consultations",
          body: body("Fri 06/11/2026"),
        }),
      };
    },
  },
  {
    // No shared word (Ellie, "the 14th", "overnight"); decoy: Ellie offered the following Saturday.
    name: "babysitter-ellie-offered",
    build: (c) => {
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      const body = (day: string) => [
        `Just checking you've not forgotten: I'm having Maya overnight on the ${day} so you can go to your do.`,
        "I'll pick her up at 5 and bring her back the next day after lunch.",
      ];
      return {
        text: "Find me a babysitter for Saturday 14 November, about 6pm till midnight, I've got the work awards dinner.",
        detail:
          "Ellie already offered to have Maya overnight on Saturday 14 November 2026, collecting her at 5pm (Ellie's " +
          "email of 20 October), so no babysitter is needed.",
        hidden: mail(c, c.ta, { from: ellie, when: at(10, 20, 19, 30), title: "Sleepover", body: body("14th") }),
        decoy: mail(c, c.tb, { from: ellie, when: at(10, 20, 19, 30), title: "Sleepover", body: body("21st") }),
      };
    },
  },
  {
    // Shares the topic word "school"; decoy: short family absences only need a note (the item allows the request).
    name: "term-time-absence-rule",
    build: (c) => {
      const office = bot("Holloway Primary Office", "office@hollowayprimary.sch.uk");
      return {
        text: "Email Mrs Daley that Maya will be off school next Monday to Wednesday, we're visiting Granny in Cornwall.",
        detail:
          "Holloway Primary's attendance policy (school notice of 13 October 2026) says term-time leave needs the " +
          "head teacher's authorisation on the request form at least 10 school days ahead, and unauthorised absence " +
          "can bring an £80 penalty notice; telling Mrs Daley isn't enough for Monday 2 to Wednesday 4 November.",
        hidden: notice(c, c.ta, {
          from: office,
          when: at(10, 13, 15, 45),
          title: "Attendance policy reminder",
          body:
            "Leave in term time can only be authorised by the head teacher, using the request form, at least 10 " +
            "school days in advance and only in exceptional circumstances. Unauthorised absence may lead to an £80 " +
            "penalty notice from Islington Council.",
        }),
        decoy: notice(c, c.tb, {
          from: office,
          when: at(10, 13, 15, 45),
          title: "Attendance policy reminder",
          body:
            "A short absence of up to 3 school days for family reasons only needs a note to the class teacher " +
            "beforehand; no form is required. Longer absences go to the head teacher.",
        }),
      };
    },
  },
  {
    // Shares only "Mum"; decoy: Mum is back from the trip (resolved).
    name: "mum-away-in-spain",
    build: (c) => {
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      return {
        text: "Do Mum's usual Ocado order for Thursday, the list is in my notes.",
        detail:
          "Mum (Ruth Carter) is in Alicante until 15 November 2026 and her fridge is switched off (Ellie's email of " +
          "25 October), so a grocery delivery on Thursday 29 October would go to an empty house.",
        hidden: mail(c, c.ta, {
          from: ellie,
          when: at(10, 25, 17, 50),
          title: "Mum's trip",
          body: [
            "Mum flew out to Alicante with Auntie Pat yesterday, she's there until 15 November.",
            "Can you hold off sending anything to hers till she's back? She's switched the fridge off.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: ellie,
          when: at(10, 25, 17, 50),
          title: "Mum's trip",
          body: [
            "Mum's back from Alicante, landed Sunday and full of stories about Auntie Pat.",
            "Her fridge is bare, mind!",
          ],
        }),
      };
    },
  },
  // ── health ──
  {
    // Late. Shares the name Tom only (sender); decoy: only Friday's clients are cancelled.
    name: "trainer-cancels-week",
    build: (c) => {
      const tom = c.role("personal trainer", ["Tom", "Bradley"]);
      return {
        text: "Book my usual PT session with Tom for Thursday at 7am.",
        detail:
          "Tom (the personal trainer) emailed this morning (27 October 2026) that he has hurt his back and is " +
          "cancelling all clients Wednesday 28 to Friday 30 October, so there is no Thursday 7am session.",
        hidden: mail(c, c.ta, {
          from: tom,
          when: at(10, 27, 8, 15),
          title: "This week",
          body: [
            "Bad news, I've put my back out and the physio says rest, so I'm cancelling all my clients Wednesday to " +
              "Friday this week.",
            "Anything in the diary for those days is off, no charge. Back on Monday 2nd.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: tom,
          when: at(10, 27, 8, 15),
          title: "This week",
          body: [
            "Bad news, I've got a family thing so I'm cancelling my clients on Friday 30th only.",
            "Wednesday and Thursday go ahead as normal, see you then.",
          ],
        }),
      };
    },
  },
  {
    // Shares the topic word "massage"; decoy: the course of blood thinners ended in September (resolved).
    name: "massage-on-anticoagulant",
    build: (c) => {
      const gp = bot("Canonbury Medical Practice", "no-reply@canonburymedical.nhs.uk");
      return {
        text: "Book me a 90-minute deep tissue massage at Agua on Saturday morning, my shoulders are wrecked.",
        detail:
          "Robin was started on the blood thinner apixaban on 15 October 2026 for three months and told to avoid " +
          "firm massage (GP practice notice), so a deep tissue massage should be checked with the GP first.",
        hidden: notice(c, c.ta, {
          from: gp,
          when: at(10, 15, 12, 30),
          title: "Your new medicine",
          body:
            "You have been started on apixaban (a blood thinner) for 3 months from 15/10/2026. While you take it, " +
            "avoid firm massage and contact sports, as bruising and bleeding happen more easily.",
        }),
        decoy: notice(c, c.tb, {
          from: gp,
          when: at(9, 10, 12, 30),
          title: "Your medicine",
          body:
            "Your 3-month course of apixaban ended on 10/09/2026 and you can stop taking it. No restrictions on " +
            "massage or exercise remain.",
        }),
      };
    },
  },
  {
    // No shared word (Nurofen, "anti-inflammatory painkillers"); decoy: the result was normal (allows the request).
    name: "ibuprofen-after-ulcer",
    build: (c) => {
      const endo = bot("Whittington Endoscopy Unit", "endoscopy@whittington.nhs.uk");
      return {
        text: "Add a big pack of ibuprofen and some Lemsip to this week's Tesco order.",
        detail:
          "Robin's gastroscopy on 21 October 2026 found a stomach ulcer and the hospital said to avoid " +
          "anti-inflammatory painkillers such as Nurofen (ibuprofen) for about two months (Whittington letter); " +
          "paracetamol is fine.",
        hidden: notice(c, c.ta, {
          from: endo,
          when: at(10, 21, 16, 5),
          title: "After your procedure",
          body:
            "Your gastroscopy on 21/10/2026 found a stomach ulcer. Do not take anti-inflammatory painkillers such as " +
            "Nurofen, Advil or aspirin for at least two months; paracetamol is fine. Take omeprazole as prescribed.",
        }),
        decoy: notice(c, c.tb, {
          from: endo,
          when: at(10, 21, 16, 5),
          title: "After your procedure",
          body: "Your gastroscopy on 21/10/2026 was normal. There are no restrictions on medicines or diet.",
        }),
      };
    },
  },
  {
    // No shared word (audiology, "18/11/2026 at 10:20"); decoy: an old referral, closed after discharge (expired).
    name: "audiology-already-referred",
    build: (c) => {
      const audio = bot("Whittington Audiology", "audiology.bookings@whittington.nhs.uk");
      return {
        text: "I keep mishearing people on calls lately, can you book me a hearing test at Specsavers?",
        detail:
          "Robin already has an NHS audiology appointment from a GP referral on Wednesday 18 November 2026 at 10:20 " +
          "at the Whittington (hospital letter), so a separate high-street test may not be needed.",
        hidden: notice(c, c.ta, {
          from: audio,
          when: at(10, 16, 10, 0),
          title: "Appointment letter",
          body:
            "Following your GP's referral, your audiology appointment is on 18/11/2026 at 10:20, ENT outpatients, " +
            "Whittington Hospital. The assessment takes about an hour. To rebook, ring 020 7288 5555.",
        }),
        decoy: notice(c, c.tb, {
          from: audio,
          when: at(5, 20, 10, 0, 2025),
          title: "Discharge letter",
          body:
            "Your audiology referral has been closed: you were discharged after your assessment on 14/05/2025 with " +
            "normal results. Your GP can refer you again if needed.",
        }),
      };
    },
  },
  // ── money ──
  {
    // Late. Shares the name Owen only (sender); decoy: the correction is for Ellie's invoice, not Robin's.
    name: "accountant-corrected-bill",
    build: (c) => {
      const owen = c.role("accountant", ["Owen", "Price"]);
      return {
        text: "Pay Owen's bill for doing my tax return, £480, by bank transfer today.",
        detail:
          "Owen (the accountant) emailed this morning (27 October 2026) that his invoice was at the wrong rate: the " +
          "correct amount is £360, not £480, and he'll refund the difference if it has already been sent.",
        hidden: mail(c, c.ta, {
          from: owen,
          when: at(10, 27, 8, 25),
          title: "Correction",
          body: [
            "Apologies, the invoice I sent you last Tuesday was at last year's rate by mistake.",
            "The correct figure is £360, same details as before. If the £480 has already gone over, I'll refund the " +
              "£120 difference straight away.",
          ],
          corporate: true,
        }),
        decoy: mail(c, c.tb, {
          from: owen,
          when: at(10, 27, 8, 25),
          title: "Correction",
          body: [
            "Apologies, the invoice I sent your sister last Tuesday was at last year's rate by mistake.",
            "Yours is correct as it stands, so no change on your side.",
          ],
          corporate: true,
        }),
      };
    },
  },
  {
    // Shares the topic word "pension"; decoy: the cut-off is still ahead (the condition is met).
    name: "pension-payroll-cutoff",
    build: (c) => {
      const hr = bot("Northwind People Team", "people@northwind.co");
      return {
        text: "Bump my pension contribution up to 10%, starting from the November payslip.",
        detail:
          "The payroll cut-off for the 25 November 2026 pay run was 20 October 2026 (People Team notice), so a " +
          "pension change made now only takes effect from the December payroll.",
        hidden: notice(c, c.ta, {
          from: hr,
          when: at(10, 21, 9, 0),
          title: "Payroll cut-off",
          body:
            "Changes to salary sacrifice, pension or bank details for the payroll paid 25/11/2026 closed on " +
            "20/10/2026. Anything submitted now will apply from the payroll paid 23/12/2026.",
        }),
        decoy: notice(c, c.tb, {
          from: hr,
          when: at(10, 21, 9, 0),
          title: "Payroll cut-off",
          body:
            "Changes to salary sacrifice, pension or bank details for the payroll paid 25/11/2026 close on " +
            "10/11/2026. Submit them through the HR portal before then.",
        }),
      };
    },
  },
  {
    // No shared word ("roadside assistance", Green Flag); decoy: the benefit was withdrawn in March (superseded).
    name: "breakdown-cover-via-bank",
    build: (c) => {
      const nw = bot("Nationwide", "no-reply@nationwide.co.uk");
      return {
        text: "Renew the car breakdown cover with the AA, same level as last year.",
        detail:
          "Robin's Nationwide FlexPlus current account already includes UK and European roadside assistance with " +
          "Green Flag (Nationwide notice), so separate AA breakdown cover would duplicate it.",
        hidden: notice(c, c.ta, {
          from: nw,
          when: at(10, 2, 7, 0),
          title: "Your FlexPlus benefits",
          body:
            "As a FlexPlus member you have UK and European roadside assistance and vehicle recovery with Green Flag, " +
            "for you and anyone you're travelling with, included each month while you hold the account.",
        }),
        decoy: notice(c, c.tb, {
          from: nw,
          when: at(2, 2, 7, 0),
          title: "Changes to your FlexPlus benefits",
          body:
            "From 01/03/2026, FlexPlus no longer includes roadside assistance with Green Flag. Your travel insurance " +
            "and mobile phone insurance are unchanged.",
        }),
      };
    },
  },
  {
    // Shares the brand name Barclaycard only (sender); decoy: no Direct Debit is set up (the item allows the request).
    name: "card-balance-direct-debit",
    build: (c) => {
      const bc = bot("Barclaycard", "noreply@barclaycard.co.uk");
      return {
        text: "Clear what I owe on the Barclaycard, roughly £1,240, from the current account.",
        detail:
          "Barclaycard will collect the full statement balance of £1,241.18 by Direct Debit on 3 November 2026 " +
          "(Barclaycard statement notice), so paying it manually would pay it twice.",
        hidden: notice(c, c.ta, {
          from: bc,
          when: at(10, 13, 6, 0),
          title: "Your statement is ready",
          body:
            "Statement balance £1,241.18. Your Direct Debit is set to pay the full balance and will be collected on " +
            "03/11/2026. No action needed.",
        }),
        decoy: notice(c, c.tb, {
          from: bc,
          when: at(10, 13, 6, 0),
          title: "Your statement is ready",
          body:
            "Statement balance £1,241.18, minimum payment £36.00 due 03/11/2026. You don't have a Direct Debit set " +
            "up, so please make a payment by the due date.",
        }),
      };
    },
  },
  // ── travel ──
  {
    // Late. Shares only the places Gatwick and Lisbon; decoy: the return leg was retimed, the outbound is unchanged.
    name: "early-flight-retimed",
    build: (c) => {
      const ezy = bot("easyJet", "noreply@easyjet.com");
      return {
        text: "Book me a cab to Gatwick for 4:30am Friday, I'm on the early Lisbon flight.",
        detail:
          "easyJet retimed Robin's Friday 30 October 2026 Gatwick-Lisbon departure from 07:05 to 10:40 (easyJet " +
          "notice this morning), so a 4:30am taxi is far too early.",
        hidden: notice(c, c.ta, {
          from: ezy,
          when: at(10, 27, 8, 5),
          title: "Your booking has changed",
          body:
            "Schedule change: EZY8603 London Gatwick (LGW) to Lisbon (LIS) on Fri 30/10/2026 now departs at 10:40 " +
            "instead of 07:05. Check-in and bag drop open 2 hours before departure.",
        }),
        decoy: notice(c, c.tb, {
          from: ezy,
          when: at(10, 27, 8, 5),
          title: "Your booking has changed",
          body:
            "Schedule change: EZY8604 Lisbon (LIS) to London Gatwick (LGW) on Mon 02/11/2026 now departs at 15:25 " +
            "instead of 13:10. Your outbound journey is unchanged.",
        }),
      };
    },
  },
  {
    // No shared word (photocard driving licence); decoy: the renewed licence was sent (prerequisite met).
    name: "hire-car-licence-expired",
    build: (c) => {
      const dvla = bot("DVLA", "noreply@dvla.gov.uk");
      return {
        text: "Book a hire car at Palma airport for 19 to 26 December, an automatic please.",
        detail:
          "Robin's photocard driving licence expired on 12 September 2026 (DVLA notice), so a valid renewed licence " +
          "is needed before hiring a car in Palma in December.",
        hidden: notice(c, c.ta, {
          from: dvla,
          when: at(9, 12, 6, 0),
          title: "Your photocard has expired",
          body:
            "Your photocard driving licence expired on 12/09/2026. You must not drive until you renew it. Renew " +
            "online for £14; it usually arrives within a week.",
        }),
        decoy: notice(c, c.tb, {
          from: dvla,
          when: at(9, 30, 6, 0),
          title: "Your new photocard is on its way",
          body: "Your renewed photocard driving licence has been sent. It is valid until 29/09/2036.",
        }),
      };
    },
  },
  {
    // Shares the topic word "ski"; decoy: the annual policy lapsed (expired).
    name: "annual-cover-includes-ski",
    build: (c) => {
      const ss = bot("Staysure", "policies@staysure.co.uk");
      return {
        text: "Get me insurance for the Morzine ski week, 9th to 16th January.",
        detail:
          "Robin's annual multi-trip travel policy renewed for 15 October 2026 to 14 October 2027 with the winter " +
          "sports add-on (Staysure notice), so the Morzine trip in January is already covered.",
        hidden: notice(c, c.ta, {
          from: ss,
          when: at(10, 15, 5, 30),
          title: "Your policy has renewed",
          body:
            "Your annual multi-trip cover has renewed for 15/10/2026 to 14/10/2027: Europe, trips up to 31 days, " +
            "with the winter sports (ski and snowboard) add-on included. Premium £118 collected.",
        }),
        decoy: notice(c, c.tb, {
          from: ss,
          when: at(10, 15, 5, 30),
          title: "Your policy has ended",
          body:
            "Your annual multi-trip cover, including the winter sports (ski and snowboard) add-on, ended on " +
            "14/10/2026 because auto-renewal was switched off. You are no longer covered.",
        }),
      };
    },
  },
  {
    // Shares the place name Glasgow only; decoy: a different Glasgow date went virtual.
    name: "glasgow-event-gone-virtual",
    build: (c) => {
      const [org, by] = c.colleagues(2);
      return {
        text: "Book me on the 07:30 Avanti up to Glasgow on Thursday 19 November for the client event.",
        detail:
          `${org!.full} said in #events (23 October 2026) that the Glasgow event on Thursday 19 November is now ` +
          "virtual because the venue fell through, so nobody needs to travel.",
        hidden: chat(
          c.ta,
          "events",
          [
            {
              who: org!,
              when: at(10, 23, 14, 20),
              text:
                "Change of plan for Glasgow on the 19th: the venue fell through, so it's now virtual. Teams link " +
                "going out this week, nobody needs to travel.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "events",
          [
            {
              who: org!,
              when: at(10, 23, 14, 20),
              text:
                "Change of plan for the Glasgow session on Thu 3/12: the venue fell through, so that one's now " +
                "virtual. The one on the 19th is unaffected.",
            },
          ],
          by!,
        ),
      };
    },
  },
  // ── home ──
  {
    // Late. No shared word ("supply will be off", "28/10/2026"); decoy: the repair finished overnight (resolved).
    name: "plumber-vs-water-off",
    build: (c) => {
      const tw = bot("Thames Water", "noreply@thameswater.co.uk");
      return {
        text: "Get the plumber in for Wednesday the 28th at 10 to fit the new kitchen tap.",
        detail:
          "Thames Water will cut the water supply on Robin's street on Wednesday 28 October 2026 from 09:00 to 16:00 " +
          "for an emergency repair (notice this morning), so a plumber fitting a tap at 10 can't work.",
        hidden: notice(c, c.ta, {
          from: tw,
          when: at(10, 27, 8, 10),
          title: "Emergency repair in your area",
          body:
            "We're repairing a burst main on your street. Your supply will be off on 28/10/2026 between 09:00 and " +
            "16:00. Bottled water will be available at the end of the road.",
        }),
        decoy: notice(c, c.tb, {
          from: tw,
          when: at(10, 27, 8, 10),
          title: "Emergency repair in your area",
          body:
            "The emergency repair on your street planned for 28/10/2026 was finished overnight. Your supply will not " +
            "be interrupted after all.",
        }),
      };
    },
  },
  {
    // Shares the topic word "paint"; decoy: the tenancy allows painting (the item allows the request).
    name: "tenancy-no-redecorating",
    build: () => {
      const terms = (clause: string) =>
        doc(
          "Tenancy agreement: key terms",
          "Landlord: Steve Hargreaves. Term: 12 months from 14/11/2025, then rolling.\n" +
            `Pets: none without consent.\nDecoration: ${clause}\nDeposit: held with the DPS.`,
          at(11, 16, 20, 0, 2025),
        );
      return {
        text: "Order some paint so I can do Maya's bedroom pink this weekend, the Farrow & Ball one she picked.",
        detail:
          "The tenancy agreement says the tenant must not paint or decorate without the landlord's prior written " +
          "consent (tenancy key terms doc), so Steve needs to agree before Maya's room is painted.",
        hidden: terms(
          "the tenant must not paint, wallpaper or put up fixtures without the landlord's prior written consent.",
        ),
        decoy: terms(
          "the tenant may paint any room in any colour without consent, provided it is returned to white at the end.",
        ),
      };
    },
  },
  {
    // Shares the name British Gas only; decoy: the landlord let the plan lapse (expired).
    name: "hob-on-landlord-plan",
    build: (c) => {
      const steve = c.role("landlord", ["Steve", "Hargreaves"]);
      return {
        text: "Get British Gas to send someone about the hob, it clicks but won't light.",
        detail:
          "Steve (the landlord) said the boiler and cooker are covered by his British Gas HomeCare plan and asked to " +
          "be rung so he can arrange any callout free (his email of 8 October 2026), rather than Robin booking and " +
          "paying.",
        hidden: mail(c, c.ta, {
          from: steve,
          when: at(10, 8, 18, 40),
          title: "Gas appliances",
          body: [
            "Quick reminder that the boiler and the cooker are both on my British Gas HomeCare plan.",
            "Please don't arrange or pay for any callouts yourselves: ring me and I'll get them out, it's free under " +
              "the plan.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: steve,
          when: at(10, 8, 18, 40),
          title: "Gas appliances",
          body: [
            "Heads up, I've let the British Gas HomeCare plan lapse as of September.",
            "So if anything gas-related goes, get whoever you like out and send me the invoice.",
          ],
        }),
      };
    },
  },
  {
    // Shares the topic word "fridge"; decoy: a bulky collection is already booked for Thursday (allows the request).
    name: "fridge-bulky-collection",
    build: (c) => {
      const council = bot("Islington Council Waste Services", "recycling@islington.gov.uk");
      return {
        text: "Stick the old fridge out front with the rubbish on Thursday night.",
        detail:
          "Islington Council doesn't take fridges with household waste; it needs a booked bulky waste collection " +
          "(£25), and leaving it on the street risks a £400 fly-tipping fine (council notice of 5 October 2026).",
        hidden: notice(c, c.ta, {
          from: council,
          when: at(10, 5, 11, 0),
          title: "Bulky items",
          body:
            "Fridges and freezers are not collected with household waste. Book a bulky waste collection online (£25, " +
            "usually within 10 working days). Leaving items on the street is fly-tipping and can mean a £400 fine.",
        }),
        decoy: notice(c, c.tb, {
          from: council,
          when: at(10, 5, 11, 0),
          title: "Bulky items",
          body:
            "Booking confirmed: bulky waste collection on Thu 29/10/2026 for 1 x fridge freezer. Please leave it " +
            "outside your property by 7am on the day.",
        }),
      };
    },
  },
  // ── admin ──
  {
    // Late. Shares the topic "council tax"; decoy: the Direct Debit starts in December (the item allows the request).
    name: "council-tax-dd-set-up",
    build: (c) => {
      const council = bot("Islington Council", "counciltax@islington.gov.uk");
      const body = (start: string, tail: string) =>
        `Your Direct Debit has been set up. Council tax instalments of £187.00 will be collected on the 1st of each ` +
        `month, starting ${start}. ${tail}`;
      return {
        text: "Pay November's council tax, £187, by card today.",
        detail:
          "Islington Council confirmed this morning (27 October 2026) that council tax is now paid by Direct Debit, " +
          "with £187 collected on 1 November 2026, so paying by card would pay it twice.",
        hidden: notice(c, c.ta, {
          from: council,
          when: at(10, 27, 8, 30),
          title: "Direct Debit confirmation",
          body: body("01/11/2026", "You do not need to do anything else."),
        }),
        decoy: notice(c, c.tb, {
          from: council,
          when: at(10, 27, 8, 30),
          title: "Direct Debit confirmation",
          body: body("01/12/2026", "Please pay the instalment due on 01/11/2026 by your usual method."),
        }),
      };
    },
  },
  {
    // Shares the topic word "MOT"; decoy: last year's certificate, now expired.
    name: "mot-already-passed",
    build: (c) => {
      const dvsa = bot("DVSA", "noreply@dvsa.gov.uk");
      const plate = `LK${c.r.int(15, 22)} ${c.r.token("ABCDEFGHJKLMNPRSTUVWXYZ", 3)}`;
      return {
        text: "Book the car in for its MOT at Kwik Fit on Saturday 7 November.",
        detail:
          "Robin's car already passed its MOT on 20 October 2026, valid to 19 October 2027 (DVSA notice), so no MOT " +
          "is needed now.",
        hidden: notice(c, c.ta, {
          from: dvsa,
          when: at(10, 20, 15, 10),
          title: "MOT test result",
          body:
            `Vehicle ${plate} (Volkswagen Golf) passed its MOT test on 20/10/2026. The next test is due by ` +
            "19/10/2027.",
        }),
        decoy: notice(c, c.tb, {
          from: dvsa,
          when: at(10, 20, 15, 10, 2025),
          title: "MOT test result",
          body:
            `Vehicle ${plate} (Volkswagen Golf) passed its MOT test on 20/10/2025. The next test is due by ` +
            "19/10/2026.",
        }),
      };
    },
  },
  {
    // No shared word (jury service, "Monday 16/11/2026"); decoy: the service was deferred to March (superseded).
    name: "jury-service-summons",
    build: (c) => {
      const jury = bot("Jury Central Summoning Bureau", "jurysummoning@justice.gov.uk");
      return {
        text: "Block out 16 to 20 November for the sales kickoff in Manchester and book me a hotel near Piccadilly.",
        detail:
          "Robin is summoned for jury service at Snaresbrook Crown Court from Monday 16 November 2026 for up to 10 " +
          "working days (summons of 19 October 2026), which clashes with 16-20 November in Manchester unless deferred.",
        hidden: notice(c, c.ta, {
          from: jury,
          when: at(10, 19, 7, 30),
          title: "Jury summons",
          body:
            "You have been summoned for jury service at Snaresbrook Crown Court starting Monday 16/11/2026, for up " +
            "to 10 working days. If you cannot attend, you must apply to defer within 7 days of this letter.",
        }),
        decoy: notice(c, c.tb, {
          from: jury,
          when: at(10, 19, 7, 30),
          title: "Deferral granted",
          body:
            "Your request to defer jury service has been granted. Your new date is Monday 08/03/2027 at Snaresbrook " +
            "Crown Court.",
        }),
      };
    },
  },
  {
    // Shares the name HMRC only (sender); decoy: an earlier year's underpayment, already collected.
    name: "hmrc-via-tax-code",
    build: (c) => {
      const hmrc = bot("HMRC", "noreply@confirmation.tax.service.gov.uk");
      return {
        text: "Clear that £2,900 bill from HMRC before the January deadline.",
        detail:
          "HMRC will collect the £2,900 owed for 2025-26 through Robin's PAYE tax code from 6 April 2027 (HMRC " +
          "notice), so no separate payment is needed in January.",
        hidden: notice(c, c.ta, {
          from: hmrc,
          when: at(10, 10, 6, 45),
          title: "Your PAYE code",
          body:
            "We will collect the £2,900 for 2025-26 through your PAYE code from 06/04/2027, so you do not need to " +
            "make a separate payment.",
        }),
        decoy: notice(c, c.tb, {
          from: hmrc,
          when: at(10, 10, 6, 45),
          title: "Your PAYE code",
          body:
            "We collected the £640 underpaid for 2024-25 through your PAYE code during 2025-26. Nothing more is due " +
            "for that year.",
        }),
      };
    },
  },
  // ── social ──
  {
    // Late. Shares the name Leila only (sender); decoy: a different get-together was moved.
    name: "birthday-drinks-moved",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      return {
        text: "Tell Leila I'm in for her birthday drinks Friday night.",
        detail:
          "Leila emailed this morning (27 October 2026) that her drinks on Friday 30 October are off because the pub " +
          "double-booked, moved to Saturday 31 October, same time, at the Faltering Fullback.",
        hidden: mail(c, c.ta, {
          from: leila,
          when: at(10, 27, 8, 50),
          title: "change of plan",
          body: [
            "Annoyingly the pub's double-booked us, so the 30th is off.",
            "Moving it to Saturday the 31st instead, same time, at the Faltering Fullback. Hope you can still make it!",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: leila,
          when: at(10, 27, 8, 50),
          title: "change of plan",
          body: [
            "Annoyingly the pub's double-booked us for the Sunday roast on the 8th, so that's moving to the 15th.",
            "The 30th is still on as planned!",
          ],
        }),
      };
    },
  },
  {
    // Shares only names (Jamie, Fontaines); decoy: Jamie has no tickets yet (the item allows the request).
    name: "gig-tickets-bought",
    build: (c) => {
      const jamie = c.role("best friend", ["Jamie", "Fox"]);
      return {
        text: "Grab two tickets for Jamie and me to see Fontaines D.C. at Ally Pally on 5 December.",
        detail:
          "Jamie already bought two standing tickets for Fontaines D.C. at Alexandra Palace on 5 December 2026 for " +
          "both of them (Jamie's email of 19 October); Robin owes him £62.",
        hidden: mail(c, c.ta, {
          from: jamie,
          when: at(10, 19, 22, 15),
          title: "5th",
          body: ["Got us sorted for Fontaines at the Palace on the 5th, two standing.", "You owe me £62, no rush."],
        }),
        decoy: mail(c, c.tb, {
          from: jamie,
          when: at(10, 19, 22, 15),
          title: "5th",
          body: [
            "Fontaines on the 5th: I haven't got anything yet, you said you'd sort it?",
            "Standing is fine by me.",
          ],
        }),
      };
    },
  },
  {
    // No shared word (Partner Summit, "Thu 12/11 - Sat 14/11"); decoy: the summit is the following week.
    name: "hen-weekend-vs-summit",
    build: () => {
      const entry = (d0: number, d2: number) =>
        event({
          title: "Partner Summit, Berlin (speaking)",
          start: at(11, d0, 7, 15),
          when: `Thu ${d0}/11 - Sat ${d2}/11/2026`,
          where: "Estrel Congress Center, Berlin",
          notes:
            `Keynote slot Sat ${d2}/11 at 10:00. BA982 out Thu ${d0}/11 07:15 from LHR, back Sat ${d2}/11 ` +
            "landing 18:40.",
          edited: at(10, 6, 11, 0),
        });
      return {
        text: "Accept Sophie's invite to the hen weekend in Bath, 13th to 15th November, and pay the £240 deposit.",
        detail:
          "Robin is speaking at the Partner Summit in Berlin from Thursday 12 to Saturday 14 November 2026, flying " +
          "back on the Saturday evening (calendar), which clashes with the hen weekend 13-15 November.",
        hidden: entry(12, 14),
        decoy: entry(19, 21),
      };
    },
  },
  {
    // Shares the topic word "Christmas"; decoy: the company party moved to January (superseded).
    name: "team-party-vs-company-party",
    build: (c) => {
      const [y, by] = c.colleagues(2);
      return {
        text: "Book the upstairs room at the Lamb for our team's Christmas drinks, Thursday 17 December, about 20 people.",
        detail:
          `${y!.full} announced in #general (21 October 2026) that the company Christmas party is on Thursday 17 ` +
          "December 2026 at Tobacco Dock from 6pm and asked people not to plan separate dos that night.",
        hidden: chat(
          c.ta,
          "general",
          [
            {
              who: y!,
              when: at(10, 21, 10, 5),
              text:
                "Save the date! Company Christmas party is Thu 17/12 at Tobacco Dock from 6pm, everyone in the " +
                "company invited, so please don't plan separate dos that night.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "general",
          [
            {
              who: y!,
              when: at(10, 21, 10, 5),
              text:
                "Update on the company Christmas party: it's moving to Fri 15/01 at Tobacco Dock, so nothing from us " +
                "in December. Plan whatever you like.",
            },
          ],
          by!,
        ),
      };
    },
  },
];

/**
 * Plant one item per template (the real one for `hidden`, the decoy for `control`, nothing for `neutral`) and return
 * the tasks. Builds both items every time so RNG draws, and so the people and numbers in each task, match across the
 * three variants.
 */
export function plantHeldout17(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 1_717);
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
  const suite = variant === "hidden" ? "heldout17" : `heldout17-${variant}`;
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
      // A ref of the base world's shape (`<kind>-<index>`): the tools arm sees refs, so one naming the template or
      // marking the item as planted would tell the agent. The same index in hidden and control, since both plant one
      // item per template in order.
      const ref = `${p.kind}-${world.items.length}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    tasks.push({ id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}

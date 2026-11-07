/**
 * Held-out hidden-context suite 16: written blind for the CL wave's final check, by an author who saw only
 * hidden-heldout15.ts (as a format example), the HiddenTask interface and the sim world API (world.ts, names.ts,
 * text.ts, rng.ts). No engine, ranking, reader, card or intent code, no other suite, no docs and no research note was
 * read. Measurement only: never tune on it. Reserved for the final blind check.
 *
 * 32 requests a user types to their personal agent, four in each life area: work, family, health, money, travel,
 * home, admin and social. The situations, template names and wording differ from heldout15's. Each template plants
 * one item the request does not ask about: in the `hidden` variant the real consideration (a clash, a lapsed
 * prerequisite, "already done", a rule, someone's constraint, a closure), in the `control` variant a near-miss decoy
 * that looks relevant but does not apply. The `neutral` variant plants nothing. Request and `detail` are identical
 * across the three variants, so an answer that raises the detail in control or neutral is a false claim.
 *
 * Word overlap between the request and the planted item: 11 templates share no content word (paraphrase, other date
 * formats), 11 share only a name (person, organisation, brand or place), 10 share one topic word. Decoys: 12
 * resolved/expired/superseded, 11 about another entity or date of the same kind, 9 where the prerequisite is met or
 * the item allows the request. Each template's comment names its overlap bucket and decoy.
 *
 * World time is NOW in world.ts: Tuesday 27 October 2026, 09:00 UTC. Weekdays below were checked against it
 * (Thursday 5 November, Saturday 14 November, Wednesday 2 December, Monday 7 December).
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

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  {
    // No shared word ("Thu 05/11, 14:00-15:30", panel); decoy: the same panel a week later.
    name: "strategy-session-panel-clash",
    build: () => {
      const entry = (day: number, label: string) =>
        event({
          title: "Panel: open ecosystems in B2B (you're speaking)",
          start: at(11, day, 14, 0),
          when: `${label}, 14:00-15:30`,
          where: "LSE, Marshall Building, lecture theatre MAR.1.04",
          notes: "On the panel with two founders and a VC. Arrive 13:30 for a mic check; about 35 min from the office.",
          edited: at(10, 14, 12, 20),
        });
      return {
        text: "Book the big meeting room for a partnerships strategy session with my team, Thursday 5 November, 2pm to 4pm.",
        detail:
          "Robin is speaking on a panel at the LSE on Thursday 5 November 2026 from 14:00 to 15:30 (arrive 13:30, " +
          "calendar), which clashes with a 2pm-4pm session.",
        hidden: entry(5, "Thu 05/11"),
        decoy: entry(12, "Thu 12/11"),
      };
    },
  },
  {
    // Shares the topic word "ticket"; decoy: the ticket on the company account was a colleague's, not Robin's.
    name: "rail-fare-on-company-account",
    build: (c) => {
      const [desk, y, by] = c.colleagues(3);
      const line = (who: string) =>
        `@${who} heads up, the ticket for your trip up north on the 20th went on the company Trainline account, so ` +
        "it's already paid. Please don't put it through Expensify, finance will bounce it as a duplicate.";
      return {
        text: "File an expense claim for my rail ticket to Manchester last week, it was £186.",
        detail:
          "Robin's rail ticket for the trip north on 20 October 2026 was booked on the company Trainline account and " +
          `is already paid (${desk!.full} in #travel); claiming it would be a duplicate.`,
        hidden: chat(c.ta, "travel", [{ who: desk!, when: at(10, 22, 15, 40), text: line("Robin") }], by!),
        decoy: chat(c.tb, "travel", [{ who: desk!, when: at(10, 22, 15, 40), text: line(y!.first) }], by!),
      };
    },
  },
  {
    // Shares the client's name only; decoy: the NDA renewal was countersigned (prerequisite met).
    name: "roadmap-nda-lapsed",
    build: (c) => {
      const [a] = c.clients(1);
      const deal = (legal: string, when: number): Plant => ({
        sourceId: "crm",
        kind: "deal",
        title: `${a!.org} — Partner programme expansion`,
        text:
          `Deal: ${a!.org} — Partner programme expansion\nStage: Negotiation\nOwner: Robin Carter\n` +
          `Champion: ${a!.full}\nLegal: ${legal}`,
        updatedAt: when,
      });
      return {
        text: `Send ${a!.full} our 2027 roadmap deck before next week's call.`,
        detail:
          `The mutual NDA with ${a!.org} expired on 30 September 2026 and the renewal has not been countersigned ` +
          `(CRM legal note), so confidential plans shouldn't go to ${a!.full} until it is.`,
        hidden: deal(
          "mutual NDA expired 30 Sep 2026; renewal sent to their legal 12 Oct, not countersigned yet. Do not share " +
            "anything confidential (pricing, plans, unreleased features) until it is.",
          at(10, 19, 10, 15),
        ),
        decoy: deal(
          "mutual NDA renewal countersigned by their legal on 20 Oct 2026, valid to Oct 2028; fine to share plans " +
            "and pricing under it.",
          at(10, 20, 16, 0),
        ),
      };
    },
  },
  {
    // Shares the colleague's name only; decoy: they are back from leave.
    name: "reviewer-on-parental-leave",
    build: (c) => {
      const [x, cover, by] = c.colleagues(3);
      return {
        text: `Ask ${x!.first} to review the partner agreement draft by Friday.`,
        detail:
          `${x!.full} is on parental leave from 26 October 2026 until 1 February 2027 (#partnerships, 23 October), ` +
          `so can't review it this week; ${cover!.full} is covering contracts.`,
        hidden: chat(
          c.ta,
          "partnerships",
          [
            {
              who: x!,
              when: at(10, 23, 17, 10),
              text:
                `Last day before parental leave! Off from Mon 26/10 until 1 Feb. ${cover!.full} is covering anything ` +
                "legal or contracts while I'm out, please don't wait on me.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "partnerships",
          [
            {
              who: x!,
              when: at(10, 26, 9, 5),
              text:
                "Back from parental leave today, thanks for holding the fort. Send anything legal or contracts my " +
                "way again from now on.",
            },
          ],
          by!,
        ),
      };
    },
  },
  // ── family ──
  {
    // Shares the name Maya only; decoy: the club is on Sundays.
    name: "swimming-vs-drama-club",
    build: () => {
      const entry = (day: number, label: string) =>
        event({
          title: "Maya: drama club (autumn term)",
          start: at(11, day, 9, 30),
          when: `${label}, 09:30-11:30`,
          where: "Little Angel Theatre, Dagmar Passage",
          notes: "Paid for the term (£96). Packed snack and a water bottle; parents collect from the side door.",
          edited: at(10, 11, 20, 30),
        });
      return {
        text: "Sign Maya up for the Saturday 10am swimming lessons at Highbury Pool, starting 7 November.",
        detail:
          "Maya already has drama club on Saturdays 09:30-11:30 from 7 November to 12 December 2026 (paid for the " +
          "term, calendar), which clashes with 10am swimming.",
        hidden: entry(7, "Sat 07/11, then weekly to 12/12"),
        decoy: entry(8, "Sun 08/11, then weekly to 13/12"),
      };
    },
  },
  {
    // Shares only "Mum"; decoy: the operation was in September and she is recovered.
    name: "mum-knee-op-recovery",
    build: (c) => {
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      return {
        text: "Book a table for Sunday lunch with Mum on the 22nd, somewhere near her in St Albans.",
        detail:
          "Mum (Ruth Carter) has her knee operation on Thursday 19 November 2026 and will be on crutches, staying " +
          "with Ellie for two weeks with no outings until December (Ellie's email of 25 October), so lunch out on " +
          "the 22nd won't work.",
        hidden: mail(c, c.ta, {
          from: ellie,
          when: at(10, 25, 18, 5),
          title: "Mum's op",
          body: [
            "Mum's knee op has been brought forward to Thursday 19 November.",
            "She'll be on crutches and staying with me for a fortnight after, so no outings till December, " +
              "doctor's orders.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: ellie,
          when: at(10, 25, 18, 5),
          title: "Mum's op",
          body: [
            "Mum's knee op back in September went really well, she's walking to the shops every day now.",
            "She'd love an outing if you're offering!",
          ],
        }),
      };
    },
  },
  {
    // No shared word (Oscar, "Saturday", tree nuts); decoy: the guest can no longer come.
    name: "party-guest-nut-allergy",
    build: (c) => {
      const parent = bot("Hannah Okoro", "hannah.okoro@gmail.com");
      return {
        text: "Order the chocolate praline cake from Gail's for Maya's birthday party on the 7th.",
        detail:
          "Oscar, a guest at Maya's party on Saturday 7 November 2026, has a severe peanut and tree nut allergy " +
          "(his mum Hannah's email of 24 October), so a hazelnut praline cake is unsafe; it needs to be nut-free.",
        hidden: mail(c, c.ta, {
          from: parent,
          when: at(10, 24, 20, 15),
          title: "Oscar",
          body: [
            "Oscar would love to come on Saturday, thank you for inviting him!",
            "Just so you know, he has a severe peanut and tree nut allergy (hazelnuts included) and carries an EpiPen.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: parent,
          when: at(10, 24, 20, 15),
          title: "Oscar",
          body: [
            "So sorry, Oscar can't come on Saturday after all, we'll be at his gran's in Kent.",
            "One less nut allergy for you to worry about, at least!",
          ],
        }),
      };
    },
  },
  {
    // No shared word ("06/11/2026", "closed to pupils"); decoy: the training day is later in the month.
    name: "inset-day-closure",
    build: (c) => {
      const office = bot("Holloway Primary Office", "office@hollowayprimary.sch.uk");
      const body = (date: string) =>
        `Reminder: Holloway Primary will be closed to pupils on ${date} for staff training (INSET). Breakfast and ` +
        "wraparound care will not run that day.";
      return {
        text: "Set up a playdate for Maya and Isla on Friday the 6th, straight after school, I'll do pickup.",
        detail:
          "Friday 6 November 2026 is an INSET day and Maya's school is closed to pupils (school notice), so there is " +
          "no after-school pickup that day.",
        hidden: notice(c, c.ta, {
          from: office,
          when: at(10, 16, 13, 0),
          title: "Staff training day",
          body: body("Friday 06/11/2026"),
        }),
        decoy: notice(c, c.tb, {
          from: office,
          when: at(10, 16, 13, 0),
          title: "Staff training day",
          body: body("Friday 27/11/2026"),
        }),
      };
    },
  },
  // ── health ──
  {
    // No shared word ("05/11/2026 at 08:40", fasting); decoy: the test is the following week.
    name: "fasting-blood-test",
    build: (c) => {
      const lab = bot("Whittington Phlebotomy", "phlebotomy.bookings@whittington.nhs.uk");
      const body = (date: string) =>
        `Your fasting blood test: ${date} at 08:40, Whittington Hospital, outpatients level 3. Do not eat for ` +
        "10 hours beforehand; water is fine. Bring your request form.";
      return {
        text: "Book breakfast with Jamie at the Breakfast Club in Angel, Thursday 5th at 8am.",
        detail:
          "Robin has a fasting blood test at 08:40 on Thursday 5 November 2026 at the Whittington (no food for 10 " +
          "hours before, hospital confirmation), so an 8am breakfast that day clashes.",
        hidden: notice(c, c.ta, {
          from: lab,
          when: at(10, 20, 11, 30),
          title: "Appointment confirmation",
          body: body("05/11/2026"),
        }),
        decoy: notice(c, c.tb, {
          from: lab,
          when: at(10, 20, 11, 30),
          title: "Appointment confirmation",
          body: body("12/11/2026"),
        }),
      };
    },
  },
  {
    // Shares the topic word "flu"; decoy: the vaccination recorded is Maya's, not Robin's.
    name: "flu-jab-already-given",
    build: (c) => {
      const gp = bot("Canonbury Medical Practice", "no-reply@canonburymedical.nhs.uk");
      return {
        text: "Book me a flu jab at Boots sometime this week.",
        detail:
          "Robin already had this season's flu vaccination at the GP practice on 14 October 2026 (practice notice), " +
          "so another jab isn't needed.",
        hidden: notice(c, c.ta, {
          from: gp,
          when: at(10, 14, 16, 0),
          title: "Vaccination recorded",
          body:
            "Your flu vaccination was given at the practice on 14/10/2026 and has been added to your record. You do " +
            "not need another this season.",
        }),
        decoy: notice(c, c.tb, {
          from: gp,
          when: at(10, 14, 16, 0),
          title: "Vaccination recorded",
          body:
            "Maya Carter's flu vaccination (nasal spray) was given at school on 14/10/2026 and has been added to her " +
            "record.",
        }),
      };
    },
  },
  {
    // Shares the topic word "drive"; decoy: no dilating drops, so driving is fine (the item allows the request).
    name: "dilating-drops-no-driving",
    build: (c) => {
      const eye = bot("Moorfields Eye Hospital", "appointments@moorfields.nhs.uk");
      return {
        text: "Book the car into the garage on Holloway Road for Wednesday the 4th at 11, I'll drive it over.",
        detail:
          "Robin has an eye appointment at Moorfields at 10:00 on Wednesday 4 November 2026 with dilating drops and " +
          "must not drive for 6 hours afterwards (hospital letter), so driving the car to the garage at 11 won't work.",
        hidden: notice(c, c.ta, {
          from: eye,
          when: at(10, 19, 9, 0),
          title: "Your appointment",
          body:
            "Your appointment: 04/11/2026 at 10:00, City Road. We will put drops in your eyes to widen the pupils. " +
            "You must not drive for at least 6 hours afterwards, so please arrange other transport.",
        }),
        decoy: notice(c, c.tb, {
          from: eye,
          when: at(10, 19, 9, 0),
          title: "Your appointment",
          body:
            "Your appointment: 04/11/2026 at 10:00, City Road. This is a routine pressure check without dilating " +
            "drops; you can drive afterwards as normal.",
        }),
      };
    },
  },
  {
    // No shared word (lisinopril, "medication review"); decoy: the repeat has gone to the pharmacy (met).
    name: "repeat-needs-review",
    build: (c) => {
      const gp = bot("Canonbury Medical Practice", "no-reply@canonburymedical.nhs.uk");
      return {
        text: "Ask Ellie to collect my repeat prescription from Day Lewis on Thursday on her way past.",
        detail:
          "Robin's lisinopril repeat was not issued because the annual medication review is overdue (GP practice " +
          "notice of 26 October 2026), so there is nothing to collect until a review is booked.",
        hidden: notice(c, c.ta, {
          from: gp,
          when: at(10, 26, 12, 10),
          title: "About your medicines request",
          body:
            "Your request for lisinopril 10mg could not be issued: your annual medication review is overdue. Please " +
            "book a review with the practice nurse; we can issue a 7-day emergency supply meanwhile.",
        }),
        decoy: notice(c, c.tb, {
          from: gp,
          when: at(10, 26, 12, 10),
          title: "About your medicines request",
          body:
            "Your request for lisinopril 10mg has been sent to Day Lewis Pharmacy, Highbury Park, and will be ready " +
            "from Wednesday.",
        }),
      };
    },
  },
  // ── money ──
  {
    // Shares the topic word "ISA"; decoy: the subscriptions are to Maya's Junior ISA, a separate allowance.
    name: "isa-allowance-mostly-used",
    build: (c) => {
      const chip = bot("Chip", "hello@getchip.uk");
      return {
        text: "Put £8,000 into my Vanguard stocks and shares ISA before the end of the tax year.",
        detail:
          "Robin has already paid £16,500 into a Cash ISA with Chip in 2026/27 (Chip statement), leaving only £3,500 " +
          "of the £20,000 annual ISA allowance, so £8,000 more would breach it.",
        hidden: notice(c, c.ta, {
          from: chip,
          when: at(10, 18, 8, 0),
          title: "Your statement",
          body:
            "Cash ISA statement: you have paid in £16,500.00 in 2026/27. The annual ISA allowance is £20,000 across " +
            "all your ISAs.",
        }),
        decoy: notice(c, c.tb, {
          from: chip,
          when: at(10, 18, 8, 0),
          title: "Your statement",
          body:
            "Junior ISA for Maya Carter: £8,500.00 paid in during 2026/27. The Junior ISA limit is £9,000 and is " +
            "separate from your own allowance.",
        }),
      };
    },
  },
  {
    // Shares the brand name Monzo only (sender); decoy: the card was unfrozen.
    name: "monzo-card-frozen",
    build: (c) => {
      const monzo = bot("Monzo", "help@monzo.com");
      const ending = c.r.token("0123456789", 4);
      return {
        text: "Pay the £420 deposit for the sofa from Loaf with Monzo.",
        detail:
          "Robin's Monzo card was frozen after being reported lost on 25 October 2026 and payments will be declined " +
          "until the replacement arrives in 3-5 working days (Monzo notice), so another way to pay is needed.",
        hidden: notice(c, c.ta, {
          from: monzo,
          when: at(10, 25, 22, 40),
          title: "Your card is frozen",
          body:
            `Your card ending ${ending} is frozen because you reported it lost on 25/10/2026. Card payments will be ` +
            "declined. Your replacement card should arrive in 3-5 working days.",
        }),
        decoy: notice(c, c.tb, {
          from: monzo,
          when: at(10, 25, 22, 40),
          title: "Your card is unfrozen",
          body:
            `You've unfrozen your card ending ${ending} after finding it. Card payments work as normal again and no ` +
            "replacement will be sent.",
        }),
      };
    },
  },
  {
    // Shares the landlord's name only (sender); decoy: the planned rise was dropped.
    name: "rent-rise-from-november",
    build: (c) => {
      const steve = c.role("landlord", ["Steve", "Hargreaves"]);
      return {
        text: "Set up a standing order to Steve, £2,350 a month on the 14th, starting November.",
        detail:
          "Steve Hargreaves (the landlord) is raising the rent to £2,475 a month from 14 November 2026 (his email of " +
          "15 October), so a £2,350 standing order would underpay.",
        hidden: mail(c, c.ta, {
          from: steve,
          when: at(10, 15, 19, 20),
          title: "Rent review",
          body: [
            "Following the rent review we discussed, the new rent from 14/11 is £2,475 per month.",
            "I've sent the formal notice by post as well.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: steve,
          when: at(10, 15, 19, 20),
          title: "Rent review",
          body: [
            "I mentioned a possible increase over the summer, but I've decided to keep the rent where it is for " +
              "another year.",
            "Thanks for being such good tenants.",
          ],
        }),
      };
    },
  },
  {
    // No shared word ("home insurance policy renewed"); decoy: the renewal date is in January.
    name: "contents-policy-renewed",
    build: (c) => {
      const aviva = bot("Aviva", "noreply@aviva.co.uk");
      return {
        text: "Shop around for a better deal on our contents cover before it rolls over.",
        detail:
          "The home insurance already renewed automatically on 20 October 2026 (Aviva notice); it can be cancelled " +
          "free only until 3 November 2026, after which a £50 cancellation charge applies.",
        hidden: notice(c, c.ta, {
          from: aviva,
          when: at(10, 20, 6, 30),
          title: "Your home policy has renewed",
          body:
            "Your home insurance policy renewed automatically on 20/10/2026 for 12 months (premium £312.40). You can " +
            "cancel free within 14 days (until 03/11/2026); after that a £50 cancellation charge applies.",
        }),
        decoy: notice(c, c.tb, {
          from: aviva,
          when: at(10, 20, 6, 30),
          title: "Your home policy",
          body:
            "Your home insurance policy is due to renew on 20/01/2027. We'll send your renewal price 21 days before; " +
            "you can switch or cancel free before then.",
        }),
      };
    },
  },
  // ── travel ──
  {
    // No shared word (passport expiry, "6 months' validity"); decoy: a new passport was issued (prerequisite met).
    name: "passport-six-months-thailand",
    build: (c) => {
      const hmpo = bot("HM Passport Office", "noreply@passport.service.gov.uk");
      const ending = c.r.token("0123456789", 3);
      return {
        text: "Book the three of us flights to Bangkok for February half term.",
        detail:
          "Robin's passport expires on 30 April 2027 (HM Passport Office reminder), under the six months' validity " +
          "Thailand requires on arrival in mid-February, so it needs renewing before travel.",
        hidden: notice(c, c.ta, {
          from: hmpo,
          when: at(10, 5, 10, 0),
          title: "Your passport is due to expire",
          body:
            `Your passport (number ending ${ending}) expires on 30/04/2027. Some countries require at least ` +
            "6 months' validity on arrival. Renew online now; standard processing takes up to 3 weeks.",
        }),
        decoy: notice(c, c.tb, {
          from: hmpo,
          when: at(10, 6, 10, 0),
          title: "Your new passport has been sent",
          body:
            `Your new passport (number ending ${ending}) was issued on 06/10/2026 and is valid until 06/10/2036. ` +
            "Your old passport has been cancelled.",
        }),
      };
    },
  },
  {
    // Shares the place name Bristol only; decoy: the strike is the following Saturday.
    name: "bristol-rail-strike",
    build: (c) => {
      const gwr = bot("GWR", "noreply@gwr.com");
      const body = (date: string) =>
        `Strike action on ${date}: no Great Western Railway services will run between London Paddington and ` +
        "Bristol Temple Meads. Tickets for that day can be refunded with no fee.";
      return {
        text: "Get me a train to Bristol on Saturday 21 November, morning, I'm visiting Ellie.",
        detail:
          "A strike on Saturday 21 November 2026 means no GWR trains between London Paddington and Bristol that day " +
          "(GWR notice), so the trip needs another day or another way.",
        hidden: notice(c, c.ta, {
          from: gwr,
          when: at(10, 23, 17, 0),
          title: "Planned disruption",
          body: body("Saturday 21/11/2026"),
        }),
        decoy: notice(c, c.tb, {
          from: gwr,
          when: at(10, 23, 17, 0),
          title: "Planned disruption",
          body: body("Saturday 28/11/2026"),
        }),
      };
    },
  },
  {
    // Shares the city name Copenhagen only; decoy: the booking was cancelled.
    name: "copenhagen-stay-booked",
    build: (c) => {
      const [desk, by] = c.colleagues(2);
      return {
        text: "Find me a hotel in Copenhagen for the partner conference, three nights from 2 December.",
        detail:
          `${desk!.full} already booked Robin into Sanders in Copenhagen for 2-5 December 2026 on the company ` +
          "account (#travel), so nothing needs finding.",
        hidden: chat(
          c.ta,
          "travel",
          [
            {
              who: desk!,
              when: at(10, 21, 11, 25),
              text:
                "@Robin you're sorted for Copenhagen: Sanders, in Wed 2/12, out Sat 5/12, on the company account " +
                "at the conf rate. Confirmation in your inbox.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "travel",
          [
            {
              who: desk!,
              when: at(10, 21, 11, 25),
              text:
                "@Robin as asked I've cancelled your Copenhagen room at Sanders (2/12-5/12); the refund goes back to " +
                "the company account.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // No shared word (ESTA, "United States"); decoy: the ESTA is approved (prerequisite met).
    name: "esta-expired",
    build: (c) => {
      const cbp = bot("ESTA Notifications", "noreply@esta.cbp.dhs.gov");
      const ref = c.r.token("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789", 16);
      return {
        text: "Book flights to Boston for the partner summit, out 7 December and back on the 11th.",
        detail:
          "Robin's ESTA expired on 18 September 2026 (ESTA notice), so a new approved ESTA is needed before flying " +
          "to Boston on 7 December.",
        hidden: notice(c, c.ta, {
          from: cbp,
          when: at(9, 18, 4, 0),
          title: "Travel authorization expired",
          body:
            `The travel authorization for application ${ref} expired on 18/09/2026. You will need a new approved ` +
            "ESTA before you travel to the United States. Apply at least 72 hours before departure.",
        }),
        decoy: notice(c, c.tb, {
          from: cbp,
          when: at(9, 18, 4, 0),
          title: "Travel authorization approved",
          body:
            `Your ESTA application ${ref} has been approved and is valid until 18/09/2028 or until your passport ` +
            "expires, whichever comes first.",
        }),
      };
    },
  },
  // ── home ──
  {
    // Shares the topic word "dishwasher"; decoy: the guarantee expired years ago.
    name: "dishwasher-guarantee",
    build: () => {
      const sheet = (line: string) =>
        doc(
          "House: appliances and guarantees",
          "Washing machine: Hotpoint, landlord's, report faults to Steve.\n" +
            `${line}\nFridge freezer: Samsung, bought 2022, no extended cover.`,
          at(3, 14, 18),
        );
      return {
        text: "Get a repair person out to look at the dishwasher, it's stopped draining.",
        detail:
          "The dishwasher is under a 5-year John Lewis guarantee to March 2030 (appliances doc) that a third-party " +
          "repair would void, so the fault should be booked through John Lewis.",
        hidden: sheet(
          "Dishwasher: Bosch Serie 4, bought from John Lewis 12/03/2025. 5-year guarantee to 11/03/2030, registered. " +
            "Repairs must be booked through John Lewis (0345 604 9049); a third-party repair voids it.",
        ),
        decoy: sheet(
          "Dishwasher: Bosch Serie 4, bought 2019. The 2-year guarantee ran out in 2021; any repairer is fine.",
        ),
      };
    },
  },
  {
    // No shared word ("interruption to your electricity supply", "12/11/2026"); decoy: the work was cancelled.
    name: "planned-power-cut",
    build: (c) => {
      const ukpn = bot("UK Power Networks", "planned.works@ukpowernetworks.co.uk");
      return {
        text: "Get the carpet cleaners booked for Thursday 12 November, 9 till 1.",
        detail:
          "There's a planned power cut at home on Thursday 12 November 2026 from 08:30 to 15:00 (UK Power Networks " +
          "notice), so carpet cleaners who need electricity can't work 9 till 1 that day.",
        hidden: notice(c, c.ta, {
          from: ukpn,
          when: at(10, 22, 10, 0),
          title: "Planned work in your area",
          body:
            "There will be a planned interruption to your electricity supply on 12/11/2026 between 08:30 and 15:00 " +
            "while we upgrade equipment on your street. Please make arrangements.",
        }),
        decoy: notice(c, c.tb, {
          from: ukpn,
          when: at(10, 26, 10, 0),
          title: "Planned work in your area",
          body:
            "The planned interruption to your electricity supply on 12/11/2026 has been cancelled. Your supply will " +
            "not be affected.",
        }),
      };
    },
  },
  {
    // Shares the topic word "sycamore"; decoy: the order covers the neighbour's oak.
    name: "sycamore-tree-order",
    build: (c) => {
      const council = bot("Islington Planning", "trees@islington.gov.uk");
      return {
        text: "Get someone in to cut back the big sycamore in the back garden before winter.",
        detail:
          "The sycamore in Robin's back garden is now under a Tree Preservation Order (council notice of 9 October " +
          "2026); cutting it back needs the council's consent first, which takes about eight weeks.",
        hidden: notice(c, c.ta, {
          from: council,
          when: at(10, 9, 9, 30),
          title: "Tree Preservation Order made",
          body:
            "A Tree Preservation Order has been made on the sycamore in the rear garden of your property. Any " +
            "pruning or felling now needs the council's consent first (apply online; decisions take about 8 weeks).",
        }),
        decoy: notice(c, c.tb, {
          from: council,
          when: at(10, 9, 9, 30),
          title: "Tree Preservation Order made",
          body:
            "As a neighbour, you are being told that a Tree Preservation Order has been made on the oak in the rear " +
            "garden of number 16. Trees on your own property are not affected.",
        }),
      };
    },
  },
  {
    // Shares the topic word "mice"; decoy: the treatment was last month and done.
    name: "pest-visit-booked",
    build: () => {
      const entry = (start: number, label: string, notes: string, edited: number) =>
        event({
          title: "Pest control visit (mice), arranged by Steve",
          start,
          when: `${label}, 08:00-09:00`,
          where: "Home",
          notes,
          edited,
        });
      return {
        text: "Find someone to deal with the mice in the kitchen, as soon as they can come.",
        detail:
          "The landlord has already booked Rentokil for Friday 30 October 2026, 08:00-09:00 (calendar), so there's " +
          "no need to find anyone else; it just needs someone home.",
        hidden: entry(
          at(10, 30, 8),
          "Fri 30/10",
          "Rentokil, arranged and paid by the landlord. Clear under the sink and give access to the loft hatch.",
          at(10, 24, 12, 45),
        ),
        decoy: entry(
          at(9, 25, 8),
          "Fri 25/09",
          "Rentokil treatment, arranged by the landlord. Treatment completed; no follow-up booked.",
          at(9, 20, 12, 45),
        ),
      };
    },
  },
  // ── admin ──
  {
    // Shares the name Islington only (sender); decoy: the challenge was rejected, so paying applies.
    name: "pcn-challenge-pending",
    build: (c) => {
      const council = bot("Islington Council", "pcn@islington.gov.uk");
      const pcn = `IZ${c.r.token("0123456789", 8)}`;
      return {
        text: "Pay that £130 parking fine from Islington, the one that came last week.",
        detail:
          `Robin has already challenged that penalty charge (${pcn}, received 19 October 2026) and it is on hold; ` +
          "paying it now would close the challenge (council notice).",
        hidden: notice(c, c.ta, {
          from: council,
          when: at(10, 19, 14, 0),
          title: `Penalty Charge Notice ${pcn}`,
          body:
            `We received your challenge to Penalty Charge Notice ${pcn} on 19/10/2026. The charge is on hold while ` +
            "we consider it. Please do not pay: payment closes the case and the challenge.",
        }),
        decoy: notice(c, c.tb, {
          from: council,
          when: at(10, 19, 14, 0),
          title: `Penalty Charge Notice ${pcn}`,
          body:
            `We have considered your challenge to Penalty Charge Notice ${pcn} and rejected it. You can pay the ` +
            "discounted amount of £65 until 10/11/2026.",
        }),
      };
    },
  },
  {
    // No shared word (motor policy, "Drivers: policyholder only"); decoy: any driver is covered (allows it).
    name: "named-driver-only",
    build: (c) => {
      const plate = `LK${c.r.int(15, 22)} ${c.r.token("ABCDEFGHJKLMNPRSTUVWXYZ", 3)}`;
      const schedule = (drivers: string) =>
        doc(
          "Motor policy schedule 2026-27",
          `Insurer: Direct Line. Vehicle: VW Golf, ${plate}. Period 01/08/2026-31/07/2027.\n` +
            `Drivers: ${drivers}\nUse: social, domestic and pleasure, commuting. Excess: £250.`,
          at(8, 1, 9),
        );
      return {
        text: "Tell Jamie he can borrow the car next weekend for his flat move, keys are under the mat.",
        detail:
          "Robin's motor insurance covers only Robin as a driver (policy schedule), so Jamie would be uninsured; he " +
          "would need adding to the policy first.",
        hidden: schedule("policyholder only (Robin Carter). Any other driver: NOT COVERED."),
        decoy: schedule("any driver aged 25 or over, with the policyholder's permission."),
      };
    },
  },
  {
    // Shares the topic word "volunteer"; decoy: the DBS certificate is already on file (prerequisite met).
    name: "volunteer-dbs-check",
    build: (c) => {
      const teacher = c.role("Maya's teacher", ["Mrs", "Daley"]);
      return {
        text: "Sign me up as a volunteer reading helper in Maya's class, Tuesday mornings.",
        detail:
          "Volunteers at Maya's school need an enhanced DBS check first, which takes 4-6 weeks (Mrs Daley's email of " +
          "21 October 2026), so Robin can't start on Tuesdays until it clears.",
        hidden: mail(c, c.ta, {
          from: teacher,
          when: at(10, 21, 16, 20),
          title: "Helping out",
          body: [
            "Lovely to hear you might volunteer with us.",
            "Before you can start helping with readers, we need an enhanced DBS check through the school office. It " +
              "usually takes 4-6 weeks, so realistically early December at the soonest.",
          ],
          corporate: true,
        }),
        decoy: mail(c, c.tb, {
          from: teacher,
          when: at(10, 21, 16, 20),
          title: "Helping out",
          body: [
            "Lovely to hear you might volunteer with us.",
            "Your enhanced DBS certificate (issued 02/10/2026) is already on file with the office, so you can start " +
              "helping with readers whenever suits.",
          ],
          corporate: true,
        }),
      };
    },
  },
  {
    // Shares the topic word "licence"; decoy: the Direct Debit was cancelled, so renewing applies.
    name: "tv-licence-auto-renewed",
    build: (c) => {
      const tvl = bot("TV Licensing", "donotreply@tvlicensing.co.uk");
      return {
        text: "Sort out the BBC licence fee before the old one runs out on Saturday.",
        detail:
          "The TV Licence has already been renewed by Direct Debit, running from 1 November 2026 to 31 October 2027 " +
          "(TV Licensing notice), so nothing needs doing.",
        hidden: notice(c, c.ta, {
          from: tvl,
          when: at(10, 12, 7, 15),
          title: "Your TV Licence has been renewed",
          body:
            "Your TV Licence has been renewed. It runs from 01/11/2026 to 31/10/2027 and is paid by Direct Debit. " +
            "No action needed.",
        }),
        decoy: notice(c, c.tb, {
          from: tvl,
          when: at(9, 1, 7, 15),
          title: "Your Direct Debit has been cancelled",
          body:
            "As requested, we cancelled your Direct Debit on 01/09/2026. Your TV Licence ends on 31/10/2026; renew " +
            "online to stay covered.",
        }),
      };
    },
  },
  // ── social ──
  {
    // No shared word (Arsenal v Spurs, "Sat 14/11, kick-off 17:30"); decoy: the match is on the Sunday.
    name: "housewarming-vs-derby",
    build: () => {
      const entry = (day: number, label: string, time: string, h: number, min: number) =>
        event({
          title: "Arsenal v Spurs with Jamie",
          start: at(11, day, h, min),
          when: `${label}, kick-off ${time}`,
          where: "Emirates Stadium, block 21",
          notes: "Jamie's season-ticket mate can't go. Meet at the Twelve Pins at 16:00; back about 20:00.",
          edited: at(10, 17, 13, 50),
        });
      return {
        text: "Say yes to the Haddads' housewarming on Saturday 14 November, 7pm.",
        detail:
          "Robin is going to Arsenal v Spurs with Jamie on Saturday 14 November 2026, kick-off 17:30 and back about " +
          "20:00 (calendar), which clashes with the 7pm housewarming.",
        hidden: entry(14, "Sat 14/11", "17:30", 17, 30),
        decoy: entry(15, "Sun 15/11", "16:30", 16, 30),
      };
    },
  },
  {
    // Shares the colleague's name only; decoy: there is no group present this time (the item allows the request).
    name: "leaving-gift-whipround",
    build: (c) => {
      const [x, y, by] = c.colleagues(3);
      return {
        text: `Order a leaving present for ${x!.first}, about £50, something for the garden.`,
        detail:
          `${y!.full} has already bought ${x!.full} a voucher from the whole team (#team, 23 October 2026), with ` +
          "Robin down for £15, so a separate present isn't needed.",
        hidden: chat(
          c.ta,
          "team",
          [
            {
              who: y!,
              when: at(10, 23, 12, 5),
              text:
                `Whip-round for ${x!.full} is done: I've got a Crocus voucher from all of us for the last day. ` +
                "Robin, you're in for £15, send it whenever.",
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "team",
          [
            {
              who: y!,
              when: at(10, 23, 12, 5),
              text:
                `No group whip-round for ${x!.full} this time, everyone's doing their own thing for the last day. ` +
                "Card's on my desk to sign though.",
            },
          ],
          by!,
        ),
      };
    },
  },
  {
    // Shares the topic word "reunion"; decoy: the friend has recovered and needs no access.
    name: "reunion-step-free",
    build: (c) => {
      const nikhil = bot("Nikhil Rao", "nikhil.rao@outlook.com");
      return {
        text: "Book a table at Barrafina for the uni reunion on Friday 27 November, eight of us.",
        detail:
          "Dev, one of the eight, now uses a wheelchair (Nikhil's email of 22 October 2026), so the venue must be " +
          "step-free with an accessible toilet and no counter-only seating; Barrafina is mostly counter stools.",
        hidden: mail(c, c.ta, {
          from: nikhil,
          when: at(10, 22, 21, 10),
          title: "27th",
          body: [
            "For the reunion on the 27th: Dev's been using a wheelchair since his accident in the summer.",
            "So wherever we go needs to be step-free with an accessible loo, and high stools at a counter are no " +
              "good for him either.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: nikhil,
          when: at(10, 22, 21, 10),
          title: "27th",
          body: [
            "For the reunion on the 27th: good news, Dev's off the crutches now and walking fine.",
            "So anywhere works, stools and all.",
          ],
        }),
      };
    },
  },
  {
    // Shares the name Ellie only (sender); decoy: they still need a pushchair (the item allows the request).
    name: "ellie-pram-sorted",
    build: (c) => {
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      return {
        text: "Buy Ellie something nice for the baby, a pram maybe, up to £300.",
        detail:
          "Mum has already bought Ellie a pram (a Bugaboo Fox, Ellie's email of 24 October 2026); Ellie has a John " +
          "Lewis gift list for other ideas.",
        hidden: mail(c, c.ta, {
          from: ellie,
          when: at(10, 24, 9, 40),
          title: "Bump update",
          body: [
            "Please nobody buy us wheels for the little one, Mum's already got us the Bugaboo Fox!",
            "If anyone wants ideas we've started a John Lewis list.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: ellie,
          when: at(10, 24, 9, 40),
          title: "Bump update",
          body: [
            "We still haven't sorted a Bugaboo or anything to push the little one around in.",
            "So if anyone's asking, that's top of the list!",
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
export function plantHeldout16(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 1_616);
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
  const suite = variant === "hidden" ? "heldout16" : `heldout16-${variant}`;
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
      // A ref of the base world's shape (`<kind>-<index>`, as the train suites give): the tools arm sees refs, so one
      // naming the template or marking the item as planted would tell the agent (CL5 review). The same index in
      // hidden and control, since both plant one item per template in order.
      const ref = `${p.kind}-${world.items.length}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    tasks.push({ id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}

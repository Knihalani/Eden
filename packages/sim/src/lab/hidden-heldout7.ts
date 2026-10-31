/**
 * Held-out hidden-context suite 7: twenty requests an assistant would act on, across work and personal life, each
 * with one planted item that should change what it does. Written blind to the engine and to every other suite.
 *
 * The planted items are hard on purpose. Half state their constraint in their own domain's vocabulary and share no
 * content word with the request (a discharge letter against a race sign-up, a tenancy clause against a holiday let);
 * a quarter share only a person's or organisation's name; a quarter share one topic word. Constraints sit in quoted
 * replies, table-like lines, notifications and calendar entries, phrased the way people write them.
 *
 * The control variant plants a near miss instead: the decisive value changed (another date span, a limit not
 * crossed, a status resolved, another account), often in an item that still looks alarming. The request text is the
 * same in both variants; a task's `detail` is the hidden consideration in the hidden variant and, in the control
 * variant, the claim a good answer must not make.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import { chatText, clock, dayLabel, emailBody, emailText, type Who } from "../text";
import type { Person, World, WorldItem } from "../world";
import type { HiddenTask, Variant } from "./suites";

const SUITE = "heldout7";

interface Planted {
  sourceId: string;
  kind: WorldItem["kind"];
  title: string;
  text: string;
  updatedAt: number;
  meta?: Record<string, string>;
}

interface Made {
  text: string;
  detail: string;
  hidden: Planted;
  decoy: Planted;
  falseClaim: string;
}

interface Cast {
  user: Person;
  rng: Rng;
  client: Person;
  /** Four distinct colleagues: [0] finance, [1] on leave, [2] release manager, [3] a bystander. */
  colleagues: Person[];
  vendorOrgs: string[];
  personal: (first: string) => Person;
}

/** A UTC time in October 2026 (day 32 is 1 November); the world's present is 27 Oct 09:00. */
const t = (day: number, hh: number, mm = 0) => Date.UTC(2026, 9, day, hh, mm);
const MIN = 60_000;

const who = (p: Who) => `${p.full} <${p.email}>`;

/** A sender outside the user's address book (a clinic, a school, a government office). */
const outsider = (full: string, email: string, company?: string): Who => ({
  full,
  first: full.split(" ")[0]!,
  email,
  company,
});

function mail(c: Cast, from: Who, title: string, at: number, body: string[], corporate = true): Planted {
  const text = emailText(from, c.user, at, emailBody(c.rng, { from, to: c.user, at, body, corporate }));
  return { sourceId: "gmail", kind: "mail", title, text, updatedAt: at, meta: { people: who(from) } };
}

/** A reply whose decisive line is inside the quoted message, as clients render it. */
function quotedReply(c: Cast, from: Who, title: string, at: number, own: string, quotedFrom: Who, quoted: string) {
  const prior = at - 26 * 60 * MIN;
  const q = quoted
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
  const body = `${own}\n\nOn ${dayLabel(prior)} ${clock(prior)}, ${quotedFrom.full} <${quotedFrom.email}> wrote:\n${q}`;
  const text = emailText(from, c.user, at, body);
  return { sourceId: "gmail", kind: "mail" as const, title, text, updatedAt: at, meta: { people: who(from) } };
}

/** A notification from a no-reply sender: no greeting, a reference line, a footer. */
function notice(from: Who, to: Who, title: string, at: number, lines: string[]): Planted {
  const footer = "This is an automated message. Please do not reply to this email.";
  const text = emailText(from, to, at, [...lines, "", footer].join("\n"));
  return { sourceId: "gmail", kind: "notification", title, text, updatedAt: at, meta: { people: who(from) } };
}

function event(c: Cast, title: string, start: number, mins: number, where: string, notes: string): Planted {
  const end = start + mins * MIN;
  const text =
    `When: ${dayLabel(start)} ${new Date(start).getUTCFullYear()}, ${clock(start)}–${clock(end)}\n` +
    `Where: ${where}\nAttendees: ${c.user.full}` +
    (notes ? `\n\n${notes}` : "");
  return {
    sourceId: "calendar",
    kind: "event",
    title,
    text,
    updatedAt: start - 12 * 24 * 60 * MIN,
    meta: { start: new Date(start).toISOString() },
  };
}

function doc(title: string, at: number, text: string): Planted {
  return { sourceId: "drive", kind: "doc", title, text, updatedAt: at };
}

function chat(channel: string, lines: { who: string; text: string; at: number }[]): Planted {
  const at = lines[lines.length - 1]!.at;
  return { sourceId: "slack", kind: "chat", title: channel, text: chatText(lines), updatedAt: at };
}

const TEMPLATES: { name: string; make: (c: Cast) => Made }[] = [
  // ── semantic gap: the item shares no content word with the request ──
  {
    name: "dinner-guest-diet",
    make: (c) => {
      const leila = c.personal("Leila");
      const ask = "Are you free on the 31st? Come round for food, 7ish. Bring nothing but yourself!";
      const reply = (own: string) =>
        quotedReply(c, leila, "Re: the 31st", t(24, 21, 12), own, c.user, `Hey ${leila.first},\n\n${ask}\n\nR`);
      return {
        text:
          "Plan the menu for my dinner party on Saturday: six of us, and I'm thinking slow-roast lamb shoulder " +
          "with a pavlova to finish.",
        detail: `${leila.first} is coming on the 31st and has gone vegan, so lamb and an egg-white pavlova won't work`,
        hidden: reply(
          "Count me in!! One thing, I went fully vegan over the summer so I'm officially that guest now. " +
            "Sorry in advance x",
        ),
        decoy: reply(
          "Count me in!! I did the whole vegan thing for Veganuary but I'm very much back on everything now, " +
            "so feed me whatever x",
        ),
        falseClaim: `${leila.first} is vegan`,
      };
    },
  },
  {
    name: "trip-cancelled-passport",
    make: (c) => {
      const from = outsider("Passport Services", "noreply@passport-services.example.gov");
      const ref = `PEX-${c.rng.token("0123456789", 8)}`;
      return {
        text: "Book me the cheapest return flight to Lisbon, out on 12 Nov and back on the 15th.",
        detail:
          "the user's old passport has been cancelled and the renewal can take up to 4 weeks from 26 Oct, so it " +
          "may not arrive before the 12 Nov trip",
        hidden: notice(from, c.user, `Your application ${ref}: documents received`, t(26, 15, 40), [
          `Application reference: ${ref}`,
          "We have received your supporting documents and your previous passport, which has now been cancelled.",
          "Applications are currently taking up to 4 weeks from the date we receive your documents (26 October).",
          "A cancelled passport is no longer valid for international journeys.",
        ]),
        decoy: notice(from, c.user, `Your application ${ref}: delivered`, t(23, 11, 5), [
          `Application reference: ${ref}`,
          "Your new passport was dispatched by secure courier on 22 October and delivered on 23 October.",
          "Your previous passport has been cancelled and returned to you with the corner cut off; keep it safe.",
        ]),
        falseClaim: "the user has no valid passport for the trip",
      };
    },
  },
  {
    name: "planning-day-site-shut",
    make: (c) => {
      const table = (hq: string) =>
        "Facilities: planned works, Q4\nOwner: Workplace team. Last updated 22/10.\n\n" +
        "Site | Dates | Impact\n" +
        `London HQ (Clerkenwell) | ${hq} | building shut, no badge access (HV switchgear replacement)\n` +
        "Manchester | 18/11 | lifts out of service, stairs only\n" +
        "Lisbon hub | 02/12 | fire alarm test 10:00-10:30\n\n" +
        "Questions to #workplace.";
      return {
        text: "Set up the team planning day for Thursday 5 Nov at the office and order lunch for twelve.",
        detail: "London HQ is shut with no badge access 4-6 Nov for electrical works, so 5 Nov can't be at the office",
        hidden: doc("Facilities: planned works Q4", t(22, 10), table("04/11-06/11")),
        decoy: doc("Facilities: planned works Q4", t(22, 10), table("11/11-13/11")),
        falseClaim: "the office is closed on 5 Nov",
      };
    },
  },
  {
    name: "wire-during-cutover",
    make: (c) => {
      const fin = c.colleagues[0]!;
      const other = c.colleagues[3]!;
      return {
        text: "Wire the $18,400 for invoice INV-3391 today, it's due.",
        detail:
          "outbound transfers are paused until Mon 2 Nov 09:00 for the treasury platform cutover; urgent ones go " +
          `through ${fin.first} manually`,
        hidden: chat("#finance-ops", [
          {
            who: fin.full,
            text:
              "pencils down on ALL outbound transfers from now until Mon 2 Nov 09:00. we're cutting over to the " +
              "new treasury platform and the old rails are read-only. anything genuinely urgent, DM me and I'll " +
              "push it by hand",
            at: t(26, 16, 2),
          },
          { who: other.full, text: "noted, thanks", at: t(26, 16, 9) },
        ]),
        decoy: chat("#finance-ops", [
          {
            who: fin.full,
            text:
              "cutover to the new treasury platform is DONE. outbound transfers running normally from this " +
              "morning, old rails retired. shout if anything looks off",
            at: t(26, 16, 2),
          },
          { who: other.full, text: "nice one", at: t(26, 16, 9) },
        ]),
        falseClaim: "payments are paused for a cutover",
      };
    },
  },
  {
    name: "race-after-surgery",
    make: (c) => {
      const physio = outsider("Hannah Doyle", "h.doyle@riversidephysio.example.com", "Riverside Physio");
      const surgeon = outsider("Mr A. Bhatt", "orthopaedics@stmarks-clinic.example.com");
      const own = `Hi ${c.user.first}, as promised here's the summary from Mr Bhatt so we're on the same page.`;
      return {
        text: "Sign me up for the Richmond half marathon on 22 Nov and put together a month-long build-up for it.",
        detail: "after knee arthroscopy on 19 Oct the user must not run or do impact sport for 6 weeks (to ~30 Nov)",
        hidden: quotedReply(
          c,
          physio,
          "Fwd: discharge summary",
          t(21, 12, 30),
          own,
          surgeon,
          "Discharge summary: right knee arthroscopy (partial meniscectomy), 19/10/2026.\n" +
            "Advice: no running, jumping or impact sport for 6 weeks. Static bike from week 3.\n" +
            "Review in clinic at 6 weeks.",
        ),
        decoy: quotedReply(
          c,
          physio,
          "Fwd: MRI report",
          t(21, 12, 30),
          own,
          surgeon,
          "MRI right knee, 19/10/2026: no meniscal or ligament tear. Mild patellar tendinopathy.\n" +
            "Advice: continue normal activity; ease off if sore the next morning. No follow-up needed.",
        ),
        falseClaim: "the user is barred from running after knee surgery",
      };
    },
  },
  {
    name: "weekend-collection",
    make: (c) => {
      const notes =
        "Coach back from the Year 4 residential. Parents must collect in person at the gates; nobody is " +
        "released to walk home alone.";
      return {
        text: "Say yes to Jamie's barbecue this weekend and tell him I'll bring dessert.",
        detail: "Maya's residential coach returns Sunday 1 Nov at 14:00 and she must be collected in person",
        hidden: event(c, "Maya: residential pick-up", t(32, 14), 45, "School gates", notes),
        decoy: event(c, "Maya: residential pick-up", t(39, 14), 45, "School gates", notes),
        falseClaim: "the user has to collect Maya this weekend",
      };
    },
  },
  {
    name: "holiday-let-clause",
    make: () => {
      const lease = (clause: string) =>
        "Assured Shorthold Tenancy Agreement (signed copy)\n\n" +
        "13.1 The Tenant shall keep the Property in good and clean condition.\n" +
        `14.2 ${clause}\n` +
        "15.1 The Tenant shall not keep any animal at the Property without consent, not to be unreasonably withheld.";
      return {
        text: "List my flat on Airbnb for the fortnight I'm in Tokyo.",
        detail:
          "the tenancy (clause 14.2) forbids underletting or paid occupation without the landlord's written consent",
        hidden: doc(
          "Tenancy agreement (signed)",
          t(-200, 10),
          lease(
            "The Tenant shall not underlet, assign or part with possession of the whole or any part of the " +
              "Property, nor permit any person to occupy it for payment, without the Landlord's prior written consent.",
          ),
        ),
        decoy: doc(
          "Tenancy agreement (signed)",
          t(-200, 10),
          lease(
            "The Tenant may underlet the Property for periods not exceeding 28 days in aggregate in any year " +
              "without further consent, provided the Landlord is notified of the dates in advance.",
          ),
        ),
        falseClaim: "the lease forbids short lets without the landlord's consent",
      };
    },
  },
  {
    name: "spend-on-maxed-card",
    make: (c) => {
      const fin = c.colleagues[0]!;
      const other = c.colleagues[3]!;
      const line = (used: string) => ({
        who: fin.full,
        text:
          `monthly card check:\nAmex (marketing) | ${used} of £25,000 | resets 1 Dec\n` +
          "anything over what's left will decline",
        at: t(26, 11, 20),
      });
      return {
        text: "Launch the £5k LinkedIn promotion for the webinar on Monday.",
        detail: "the marketing card has only £150 of its £25,000 limit left until 1 Dec, so £5k will decline",
        hidden: chat("#marketing-ops", [line("£24,850"), { who: other.full, text: "oof", at: t(26, 11, 31) }]),
        decoy: chat("#marketing-ops", [line("£14,850"), { who: other.full, text: "ok", at: t(26, 11, 31) }]),
        falseClaim: "the marketing card can't take a £5k charge",
      };
    },
  },
  {
    name: "hire-car-no-licence",
    make: (c) => {
      const from = outsider("Driving Licence Services", "noreply@licensing.example.gov");
      return {
        text: "Book a hire car at Berlin airport for when I land on 9 Nov.",
        detail: "the user's driving licence expired on 30 Sep and the renewal hasn't arrived, so they can't drive",
        hidden: notice(from, c.user, "We've received your application", t(19, 8, 15), [
          "We have received your application to renew your photocard driving licence.",
          "Your previous licence expired on 30 September 2026. You must not drive until your new one arrives.",
          "Most applications are processed within 3 weeks; some take longer if we need more information.",
        ]),
        decoy: notice(from, c.user, "Your photocard needs renewing", t(19, 8, 15), [
          "Your photocard driving licence expires on 30 September 2027.",
          "You can renew online at any time in the next 11 months. Your entitlement to drive is not affected.",
        ]),
        falseClaim: "the user's driving licence has lapsed",
      };
    },
  },
  {
    name: "workshop-vs-summons",
    make: (c) => ({
      text: "Accept the vendor workshop on 17-18 Nov and block out both days.",
      detail: "the user is summoned for jury service at Snaresbrook Crown Court from 16 Nov for up to 10 working days",
      hidden: event(
        c,
        "Jury service: Snaresbrook Crown Court",
        t(47, 9, 30),
        450,
        "Snaresbrook Crown Court",
        "Summoned for up to two weeks of sittings (16-27 Nov). Bring the summons letter and photo ID.",
      ),
      decoy: event(
        c,
        "Jury service (deferred): Snaresbrook Crown Court",
        Date.UTC(2027, 2, 15, 9, 30),
        450,
        "Snaresbrook Crown Court",
        "Deferral granted from the original 16 Nov 2026 date. New date: 15 Mar 2027, up to two weeks.",
      ),
      falseClaim: "the user has jury service in November",
    }),
  },
  // ── name only: the item shares just a person's or organisation's name with the request ──
  {
    name: "thank-you-gift-code",
    make: (c) => {
      const p = c.client;
      const own = (line: string) => `Ha, you're very kind. ${line} Looking forward to the kick-off.\n\n${p.first}`;
      const quoted = `Thanks again ${p.first}, really glad we got there. I owe you one!\n\nRobin`;
      const reply = (line: string) => quotedReply(c, p, "Re: signed!", t(23, 14, 48), own(line), c.user, quoted);
      return {
        text: `Send ${p.full} at ${p.org} a nice bottle of champagne to say thanks for getting the renewal signed.`,
        detail: `${p.first} asked for no gifts: ${p.org}'s supplier code means gifts get declared and returned`,
        hidden: reply(
          "Honestly, please don't. Under our supplier code I have to declare and hand back anything, however small.",
        ),
        decoy: reply("No need, but if you insist: our supplier code only makes me declare anything over £250."),
        falseClaim: `${p.org} doesn't allow ${p.first} to accept the gift`,
      };
    },
  },
  {
    name: "export-without-dpa",
    make: (c) => {
      const org = c.vendorOrgs[0]!;
      const rec = (dpa: string, sec: string) =>
        `Account: ${org}\nType: Vendor (data processor)\nOwner: ${c.colleagues[0]!.full}\n` +
        `DPA: ${dpa}\nSecurity review: ${sec}\nRenewal: 2027-03-31`;
      return {
        text: `Share the Q3 customer export with ${org} so their team can start on the churn model.`,
        detail: `${org} has no signed DPA yet (legal still redlining the sub-processor clause)`,
        hidden: {
          sourceId: "crm",
          kind: "deal",
          title: `${org}: vendor account`,
          text: rec("NOT SIGNED. Legal still redlining the sub-processor clause (9.3)", "passed 2026-09-14"),
          updatedAt: t(23, 13),
        },
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org}: vendor account`,
          text: rec("Signed 2026-10-02 (countersigned copy in Drive)", "3 findings (all low), remediated 2026-10-09"),
          updatedAt: t(23, 13),
        },
        falseClaim: `${org} hasn't signed a DPA`,
      };
    },
  },
  {
    name: "meeting-with-leaver",
    make: (c) => {
      const p = c.colleagues[1]!;
      const cover = c.colleagues[3]!.full;
      return {
        text: `Set up 30 minutes with ${p.full} on Thursday to go through the Q4 forecast.`,
        detail: `${p.first} is on parental leave from 27 Oct until 18 Jan; ${cover} is covering`,
        hidden: chat("#general", [
          {
            who: p.full,
            text: `last day before parental leave! offline from tomorrow, back 18 Jan. ${cover} has my stuff`,
            at: t(26, 17, 40),
          },
          { who: c.colleagues[0]!.full, text: "congrats!! enjoy every minute", at: t(26, 17, 44) },
        ]),
        decoy: chat("#general", [
          {
            who: p.full,
            text: `back from parental leave today, three months of no sleep. thanks ${cover} for holding the fort`,
            at: t(26, 9, 5),
          },
          { who: c.colleagues[0]!.full, text: "welcome back!!", at: t(26, 9, 9) },
        ]),
        falseClaim: `${p.first} is away on leave`,
      };
    },
  },
  {
    name: "rfp-suspended-supplier",
    make: (c) => {
      const org = c.vendorOrgs[1]!;
      const register = (status: string) =>
        "Approved supplier register (Procurement)\n\n" +
        "Supplier | Category | Status | Note\n" +
        "Stark Freight | Logistics | Approved | renewal due 03/2027\n" +
        `${org} | Automation | ${status}\n` +
        "Soylent Foods | Catering | Approved | -\n\n" +
        "Do not invite a supplier to tender unless its status is Approved.";
      return {
        text: `Add ${org} to the shortlist for the warehouse automation RFP and send them the brief.`,
        detail: `${org} is suspended on the supplier register after failing an InfoSec review (re-review Jan 2027)`,
        hidden: doc(
          "Approved supplier register",
          t(20, 15),
          register("Suspended | failed InfoSec review 06/2026, re-review 01/2027"),
        ),
        decoy: doc(
          "Approved supplier register",
          t(20, 15),
          register("Approved | suspended 06/2026, re-review passed 09/2026"),
        ),
        falseClaim: `${org} is suspended and can't be invited`,
      };
    },
  },
  {
    name: "trainer-already-paid",
    make: (c) => {
      const tom = c.personal("Tom");
      const line = (body: string) => mail(c, tom, "Re: sessions", t(23, 7, 50), [body], false);
      return {
        text: "Transfer Tom Bradley £240 for October's sessions.",
        detail: "Tom confirmed on 23 Oct that October's £240 had already arrived",
        hidden: line("Got your transfer for October this morning, all square, cheers! See you Weds 7am."),
        decoy: line("Got September's money, cheers. October whenever suits, no rush. See you Weds 7am."),
        falseClaim: "October's sessions are already paid",
      };
    },
  },
  // ── topic word: the item shares one topic word with the request ──
  {
    name: "offer-above-band",
    make: () => {
      const bands = (senior: string) =>
        "Engineering comp bands FY26 (confidential)\n\n" +
        "Role | Level | Base range\n" +
        "Data Engineer | L4 | £58k-£72k\n" +
        `Data Engineer (Senior) | L5 | ${senior}\n` +
        "Staff Engineer | L6 | £98k-£118k\n\n" +
        "Any offer above band max needs CFO and Head of People sign-off before it goes out.";
      return {
        text: "Draft the offer letter for the senior data engineer candidate at £92k base.",
        detail: "£92k is above the L5 Senior Data Engineer band (max £86k) and needs CFO and Head of People sign-off",
        hidden: doc("Comp bands FY26", t(5, 12), bands("£74k-£86k")),
        decoy: doc("Comp bands FY26", t(5, 12), bands("£80k-£96k")),
        falseClaim: "£92k is above band",
      };
    },
  },
  {
    name: "isa-allowance",
    make: (c) => {
      const from = outsider("Fernleaf Invest", "statements@fernleaf.example.com");
      const summary = (sub: string, left: string) =>
        notice(from, c.user, "Your Stocks & Shares ISA: subscription summary", t(20, 6), [
          "Tax year 2026/27",
          `Allowance: £20,000 | Subscribed so far: ${sub} | Remaining: ${left}`,
          "Subscriptions over the allowance will be returned and may incur a charge.",
        ]);
      return {
        text: "Put £3,000 from my savings into my ISA before the month's out.",
        detail: "only £1,500 of this year's £20,000 ISA allowance is left, so £3,000 would go over",
        hidden: summary("£18,500", "£1,500"),
        decoy: summary("£8,500", "£11,500"),
        falseClaim: "£3,000 would exceed the ISA allowance",
      };
    },
  },
  {
    name: "deploy-in-lock",
    make: (c) => {
      const rel = c.colleagues[2]!;
      const msg = (window: string) => ({
        who: rel.full,
        text:
          `reminder: production is locked ${window} while payments cuts over to the new provider. ` +
          "exceptions via #release-mgmt with a named approver",
        at: t(26, 18, 10),
      });
      return {
        text: "Merge the pricing-page PR and get it into production this afternoon.",
        detail: "production is locked from today 12:00 UTC until Thu 29 Oct 09:00 for the payments cutover",
        hidden: chat("#releases", [msg("from Tue 27 Oct 12:00 UTC to Thu 29 Oct 09:00 UTC")]),
        decoy: chat("#releases", [msg("from Tue 3 Nov 12:00 UTC to Thu 5 Nov 09:00 UTC")]),
        falseClaim: "production is locked this afternoon",
      };
    },
  },
  {
    name: "laptop-orders-paused",
    make: (c) => {
      const it = outsider("IT Service Desk", `it-help@${c.user.email.split("@")[1]}`, "Northwind");
      return {
        text: "Order a laptop for the designer who starts on Monday, same spec as last time.",
        detail: "laptop orders are paused until the device-management contract is re-signed (~16 Nov); use a loaner",
        hidden: mail(c, it, "Hardware ordering update", t(22, 9, 30), [
          "Our device-management contract lapsed at the end of September, so no new laptops can be enrolled.",
          "Orders are paused until it's re-signed, which we expect around 16 November.",
          "New starters before then get a loaner from the IT cupboard on level 2.",
        ]),
        decoy: mail(c, it, "Hardware ordering update", t(22, 9, 30), [
          "Good news: the device-management contract was re-signed on 20 October.",
          "Laptop orders are open again and the usual 5-day lead time applies.",
        ]),
        falseClaim: "laptop orders are paused",
      };
    },
  },
  {
    name: "whitening-after-crown",
    make: (c) => {
      const dentist = c.personal("Ngozi");
      return {
        text: "Book me a teeth-whitening appointment for next week.",
        detail: "after the crown fitted on 21 Oct the dentist said to avoid whitening for at least 6 weeks",
        hidden: mail(c, dentist, "Aftercare: today's appointment", t(21, 16, 45), [
          "Your new crown (upper left) is fitted and the bite looks good.",
          "Please avoid any whitening for at least 6 weeks, or the shade will no longer match.",
        ]),
        decoy: mail(c, dentist, "Aftercare: today's appointment", t(21, 16, 45), [
          "Your scale and polish went well and your gums look healthy.",
          "If you were thinking about whitening, it's fine any time from now on.",
        ]),
        falseClaim: "the user should hold off on whitening",
      };
    },
  },
];

/** Adds one planted item per template to the world, in template order, and returns the matching tasks. */
export function plantHeldout7(world: World, seed: number, variant: Variant): HiddenTask[] {
  const rng = new Rng(seed * 7_919 + 707);
  const user = world.user;
  const ambiguous = new Set(["Sam", "Dana"]);
  const colleagues = world.people.filter((p) => p.relation === "colleague" && !ambiguous.has(p.first));
  const clients = world.people.filter((p) => p.relation === "client" && !ambiguous.has(p.first) && p.org);
  const vendorOrgs = [...new Set(world.people.filter((p) => p.relation === "vendor" && p.org).map((p) => p.org!))];
  const fallbackOrgs = ["Cyberdyne", "Tyrell Bio", "Aperture Labs", "Pied Piper"];
  const orgs = rng.sample(vendorOrgs.length >= 2 ? vendorOrgs : fallbackOrgs, 2);
  const personal = (first: string): Person => {
    const p = world.people.find((x) => x.first === first && x.relation !== "colleague" && x.relation !== "client");
    if (p) return p;
    // Every built world has the personal contacts; this keeps the suite total if a world is ever built without.
    return { id: `p-${first.toLowerCase()}`, first, last: "", full: first, email: "", relation: "friend" };
  };
  const cast: Cast = {
    user,
    rng,
    client: rng.pick(clients),
    colleagues: rng.sample(colleagues, 4),
    vendorOrgs: orgs,
    personal,
  };

  const taken = new Set(world.items.map((i) => i.id));
  const tasks: HiddenTask[] = [];
  for (const tpl of TEMPLATES) {
    // Both variants make the same draws, so the request text is identical across them.
    const made = tpl.make(cast);
    const planted = variant === "hidden" ? made.hidden : made.decoy;
    let ref = `${SUITE}-${tpl.name}`;
    for (let n = 1; taken.has(itemId(planted.sourceId, ref)); n++) ref = `${SUITE}-${tpl.name}-${n}`;
    const id = itemId(planted.sourceId, ref);
    taken.add(id);
    world.items.push({ ...planted, id, ref, facts: [], noise: false });
    tasks.push({
      // The control variant's ids differ, as every suite's do: runners key results by task id.
      id: `w${seed}:${variant === "hidden" ? SUITE : `${SUITE}-control`}:${tpl.name}`,
      template: tpl.name,
      text: made.text,
      detail: variant === "hidden" ? made.detail : made.falseClaim,
    });
  }
  return tasks;
}

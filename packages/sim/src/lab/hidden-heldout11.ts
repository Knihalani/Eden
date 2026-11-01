/**
 * Held-out suite 11: 32 hidden-context tasks, written blind after D80 (the author read only the world generator, the
 * text helpers, the suite registry and the HiddenTask interface). Each template plants one item that a good answer
 * must raise; the control variant plants a near miss instead (resolved, past, or about another person or date) and
 * keeps the request text. Overlap between request and item is spread on purpose: about a third share no content
 * words, a third share only a name, a third share a topic word. Measurement only: never tune on it.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import { emailBody, emailText, chatText, threadBodies, type Message, type Who } from "../text";
import { DAY, HOUR, NOW, type Person, type World, type WorldItem } from "../world";
import type { HiddenTask } from "./hidden-context";

type Variant = "hidden" | "control";

interface Planted {
  sourceId: string;
  kind: WorldItem["kind"];
  title: string;
  text: string;
  at: number;
  meta?: Record<string, string>;
}

interface Spec {
  text: string;
  detail: string;
  item: Planted;
  decoy: Planted;
}

interface Ctx {
  user: Person;
  rng: Rng;
  /** The next unused person of a relation (distinct across templates, so no two tasks share a subject). */
  next: (relation: Person["relation"]) => Person;
  /** A personal contact by the role the user calls them ("sister"). */
  role: (role: string) => Person;
}

const ago = (days: number, hours = 0) => NOW - days * DAY - hours * HOUR;
const people = (ws: Who[], user: Person) =>
  ws
    .filter((w) => w.email !== user.email)
    .map((w) => `${w.full} <${w.email}>`)
    .join("; ");

/** A single email from `from` to the user. */
function mail(c: Ctx, from: Who, title: string, at: number, body: string[], corporate = true): Planted {
  const text = emailText(from, c.user, at, emailBody(c.rng, { from, to: c.user, at, body, corporate }));
  return { sourceId: "gmail", kind: "mail", title, text, at, meta: { people: people([from], c.user) } };
}

/** The last message of a thread, quoting what came before it. */
function thread(c: Ctx, title: string, msgs: Message[]): Planted {
  const bodies = threadBodies(c.rng, msgs);
  const last = msgs[msgs.length - 1]!;
  return {
    sourceId: "gmail",
    kind: "mail",
    title: msgs.length > 1 ? `Re: ${title}` : title,
    text: emailText(last.from, last.to, last.at, bodies[bodies.length - 1]!),
    at: last.at,
    meta: { people: people([...new Set(msgs.flatMap((m) => [m.from, m.to]))], c.user) },
  };
}

/** An automated notification email. */
function notice(c: Ctx, from: Who, title: string, at: number, body: string): Planted {
  return { sourceId: "gmail", kind: "notification", title, text: emailText(from, c.user, at, body), at };
}

function chat(title: string, lines: { who: string; text: string; at: number }[]): Planted {
  return { sourceId: "slack", kind: "chat", title, text: chatText(lines), at: lines[lines.length - 1]!.at };
}

function event(title: string, start: string, text: string, at: number): Planted {
  return { sourceId: "calendar", kind: "event", title, text, at, meta: { start } };
}

function doc(title: string, text: string, at: number): Planted {
  return { sourceId: "drive", kind: "doc", title, text, at };
}

const bot = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });

const TEMPLATES: { name: string; make: (c: Ctx) => Spec }[] = [
  // ── no content words shared with the request ──
  {
    name: "mains-water-works",
    make: (c) => {
      const from = bot("Thames Water", "noreply@thameswater.co.uk");
      const body = (d: string) =>
        `Planned work on your street.\n\nTo replace a section of main on Elm Road, supply will be off from 08:00 ` +
        `to 13:00 on ${d}. Pressure may be low for a few hours afterwards. Reference PW-${c.rng.int(10000, 99999)}.`;
      return {
        text: "Is Wednesday 4 November a good morning to have the plumber round to fix the kitchen tap?",
        detail: "Thames Water has the mains supply off 08:00-13:00 on 04/11 (Elm Road works)",
        item: notice(c, from, "Planned interruption to your supply", ago(3), body("04/11/2026")),
        decoy: notice(c, from, "Planned interruption to your supply", ago(12), body("21/10/2026")),
      };
    },
  },
  {
    name: "corsa-borrowed",
    make: (c) => {
      const ellie = c.role("sister");
      return {
        text: "Book the car in for its MOT at Kwik Fit on Saturday 31 October.",
        detail: "Ellie has the Corsa in Cornwall from Friday until Sunday night",
        item: chat(`DM with ${ellie.full}`, [
          { who: ellie.full, text: "ok to take the Corsa down to Cornwall Fri-Sun? back Sunday night", at: ago(2, 3) },
          { who: c.user.full, text: "yep, keys are on the hook", at: ago(2, 2) },
          { who: ellie.full, text: "legend. will fill it up before I bring it back", at: ago(2, 1) },
        ]),
        decoy: chat(`DM with ${ellie.full}`, [
          { who: ellie.full, text: "ok to take the Corsa to Cornwall Fri-Sun?", at: ago(13, 3) },
          { who: c.user.full, text: "yep, keys are on the hook", at: ago(13, 2) },
          { who: ellie.full, text: "dropped it back, tank full, thanks!!", at: ago(9, 1) },
        ]),
      };
    },
  },
  {
    name: "bond-maturity",
    make: (c) => {
      const from = bot("Marlow Building Society", "accounts@marlowbs.co.uk");
      const ref = `FRB-${c.rng.int(100000, 999999)}`;
      return {
        text: "Move £4,000 from my savings into the joint account today.",
        detail: "the 12-month fixed-rate bond matures 18 November; withdrawing earlier forfeits 90 days' interest",
        item: notice(
          c,
          from,
          "Your fixed-rate bond: maturity reminder",
          ago(6),
          `Your 12 Month Fixed Rate Bond (${ref}) matures on 18 November 2026. Withdrawals before maturity incur ` +
            `a charge equal to 90 days' interest. Tell us before then where the balance should go.`,
        ),
        decoy: notice(
          c,
          from,
          "Your fixed-rate bond has matured",
          ago(9),
          `Your 12 Month Fixed Rate Bond (${ref}) matured on 18 October 2026. The balance has moved to Easy ` +
            `Access, where you can withdraw at any time without charge.`,
        ),
      };
    },
  },
  {
    name: "flu-jab-clash",
    make: (c) => {
      const org = c.next("client").org!;
      return {
        text: `Put a pitch rehearsal for the ${org} renewal in my diary for Monday 2 November at 14:00.`,
        detail: "a flu jab at Boots Islington at 13:45 that day",
        item: event(
          "Flu jab - Boots Islington",
          "2026-11-02T13:45:00Z",
          "2026-11-02 13:45-14:15. Boots, 48 Upper Street. Bring the NHS invitation letter.",
          ago(8),
        ),
        decoy: event(
          "Flu jab - Boots Islington",
          "2026-10-26T13:45:00Z",
          "2026-10-26 13:45-14:15. Boots, 48 Upper Street. Bring the NHS invitation letter.",
          ago(20),
        ),
      };
    },
  },
  {
    name: "motor-cover-lapse",
    make: (c) => {
      const from = bot("Lumen Insure", "policies@lumeninsure.co.uk");
      const pol = `LMN-${c.rng.int(1000000, 9999999)}`;
      return {
        text: "Tell the football parents I can drive four of the kids to the away match on Saturday.",
        detail: "the motor insurance policy ends at 23:59 on 30 October and is not set to auto-renew",
        item: notice(
          c,
          from,
          "Action needed: your policy ends soon",
          ago(5),
          `Policy ${pol} ends at 23:59 on 30 October 2026. Automatic renewal is switched off on your account, so ` +
            `cover will stop unless you accept your renewal quote online.`,
        ),
        decoy: notice(
          c,
          from,
          "Your renewal is confirmed",
          ago(4),
          `Thanks for renewing. Policy ${pol} now runs until 23:59 on 30 October 2027. Your new certificate is ` +
            `attached.`,
        ),
      };
    },
  },
  {
    name: "tube-closure",
    make: (c) => {
      const from = bot("TfL", "noreply@tfl.gov.uk");
      const body = (d: string) =>
        `Planned closure: no Piccadilly line service between Acton Town and Terminals 2&3, 4 and 5 on ${d}. ` +
        `Rail replacement buses run; allow at least an extra 45 minutes. Elizabeth line trains are unaffected.`;
      return {
        text: "What time should I leave home for my 11:40 BA flight to Lisbon on Sunday?",
        detail: "Piccadilly line closed to the Heathrow terminals Sat 31 Oct-Sun 1 Nov; allow 45+ minutes extra",
        item: notice(c, from, "Weekend closures on your routes", ago(2), body("31/10 and 01/11")),
        decoy: notice(c, from, "Weekend closures on your routes", ago(14), body("17/10 and 18/10")),
      };
    },
  },
  {
    name: "lift-out",
    make: (c) => {
      const from = bot("Albion Court Management", "concierge@albioncourt.co.uk");
      return {
        text: "Order 20 bags of compost to be delivered on Saturday.",
        detail: "the building lift is out of service until 4 November; deliveries to the 4th floor go up the stairs",
        item: notice(
          c,
          from,
          "Lift out of service",
          ago(1),
          "Dear residents, the passenger lift is out of service from 29 October to 4 November while the motor is " +
            "replaced. Couriers will need to use the stairs; please warn anyone bringing heavy items to upper floors.",
        ),
        decoy: notice(
          c,
          from,
          "Lift back in service",
          ago(10),
          "Dear residents, the lift motor replacement finished on 16 October and the lift is back in normal " +
            "service. Thank you for your patience.",
        ),
      };
    },
  },
  {
    name: "closed-period",
    make: (c) => {
      const cfo = c.next("colleague");
      return {
        text: "Post the Q3 revenue numbers in #general so everyone can see how we did.",
        detail: `${cfo.first} says the company is in a closed period until results on 12 November`,
        item: mail(c, cfo, "Closed period reminder", ago(4), [
          "Reminder that we are in the closed period until results go out on 12 November.",
          "Nothing on third-quarter trading goes beyond the exec list before then, including internal channels.",
        ]),
        decoy: mail(c, cfo, "Closed period over", ago(7), [
          "Results went out on 20 October, so the closed period is over.",
          "Feel free to share the trading summary internally.",
        ]),
      };
    },
  },
  {
    name: "pottery-course",
    make: () => ({
      text: "Am I free on Wednesday evenings to join a five-a-side league?",
      detail: "a six-week wheel-throwing course runs 18:30-20:30 weekly until 18 November",
      item: event(
        "Wheel throwing (wk 3/6) - Clay Studio",
        "2026-10-28T18:30:00Z",
        "18:30-20:30, weekly 14 Oct - 18 Nov. Clay Studio, Unit 4 Arch Yard. Aprons provided.",
        ago(30),
      ),
      decoy: event(
        "Wheel throwing (wk 6/6) - Clay Studio",
        "2026-09-23T18:30:00Z",
        "18:30-20:30, final session of the 2 Sep - 23 Sep block. Clay Studio, Unit 4 Arch Yard.",
        ago(60),
      ),
    }),
  },
  {
    name: "loss-adjuster",
    make: (c) => {
      const from = bot("Harbour Home Claims", "claims@harbourhome.co.uk");
      const claim = `CLM-${c.rng.int(100000, 999999)}`;
      return {
        text: "Get three decorators to quote for doing the stairs and landing this month.",
        detail: `a loss adjuster visits on 9 November for claim ${claim}; damaged areas must be left untouched`,
        item: notice(
          c,
          from,
          `Claim ${claim}: adjuster visit booked`,
          ago(3),
          `Your escape-of-water claim ${claim} has a loss adjuster visit on Monday 9 November, 10:00-12:00. Please ` +
            `leave the damaged ceiling and walls as they are until assessment, or the claim may be reduced.`,
        ),
        decoy: notice(
          c,
          from,
          `Claim ${claim}: settled`,
          ago(5),
          `Your escape-of-water claim ${claim} has been settled and closed. Payment has been made to your ` +
            `nominated account; you are free to carry out repairs.`,
        ),
      };
    },
  },
  {
    name: "stove-with-jamie",
    make: (c) => {
      const jamie = c.role("best friend");
      return {
        text: "Tell Leila she can borrow my camping stove this weekend.",
        detail: "Jamie still has the Trangia and is bringing it back after Snowdonia on Sunday 8 November",
        item: chat(`DM with ${jamie.full}`, [
          {
            who: jamie.full,
            text: "still got your Trangia btw, will drop it back after Snowdonia on Sun 8th",
            at: ago(1),
          },
        ]),
        decoy: chat(`DM with ${jamie.full}`, [
          { who: jamie.full, text: "left your Trangia on the doorstep last night, cheers for the loan", at: ago(6) },
        ]),
      };
    },
  },
  {
    name: "mum-cataract",
    make: (c) => {
      const ellie = c.role("sister");
      return {
        text: "Book Ruth a taxi to King's Cross for Thursday at 9am.",
        detail: "Mum's cataract operation moved to Thursday 29 October 8am at Moorfields; she can't travel that day",
        item: chat(`DM with ${ellie.full}`, [
          { who: ellie.full, text: "Mum's cataract op got moved to Thu 29th, 8am at Moorfields", at: ago(1, 4) },
          { who: ellie.full, text: "I'm taking her. she won't be up to going anywhere after", at: ago(1, 4) },
        ]),
        decoy: chat(`DM with ${ellie.full}`, [
          { who: ellie.full, text: "Mum's cataract op went fine on the 15th, she's seeing perfectly now", at: ago(9) },
        ]),
      };
    },
  },
  // ── a name shared with the request, nothing else ──
  {
    name: "offsite-bristol",
    make: (c) => {
      const lead = c.next("colleague");
      const line = (d: string) =>
        `Q4 offsite confirmed: Bristol, ${d}. Coach back to London leaves 18:30 on the last day.`;
      return {
        text: `Book a table for eight at Padella on Friday 6 November for ${lead.first}'s team.`,
        detail: `${lead.first}'s team is at the Bristol offsite 5-6 November; the coach back leaves at 18:30 Friday`,
        item: chat("#product-leads", [{ who: lead.full, text: line("Thu 5 - Fri 6 Nov"), at: ago(3) }]),
        decoy: chat("#product-leads", [{ who: lead.full, text: line("Thu 12 - Fri 13 Nov"), at: ago(3) }]),
      };
    },
  },
  {
    name: "vendor-rate-card",
    make: (c) => {
      const [v, other] = [c.next("vendor"), c.next("vendor")];
      const [a, b] = [c.rng.int(7, 9) * 100, c.rng.int(10, 12) * 100];
      const body = [
        `Heads up that our day rate moves from £${a} to £${b} on 1 November.`,
        "Anything booked from then goes on the new card.",
      ];
      return {
        text: `Ask ${v.full} for a quote for another 40 hours of engineering support in December.`,
        detail: `${v.first}'s day rate rises from £${a} to £${b} on 1 November`,
        item: mail(c, v, "Rate card 2026/27", ago(6), body),
        decoy: mail(c, other, "Rate card 2026/27", ago(6), body),
      };
    },
  },
  {
    name: "reviewer-resigned",
    make: (c) => {
      const [mgr, who, other] = [c.next("colleague"), c.next("colleague"), c.next("colleague")];
      const line = (p: Person) =>
        `heads up: ${p.first} has resigned, last day is Fri 6 Nov. please hand over anything that runs past then`;
      return {
        text: `Add ${who.full} as a reviewer on the Globex pricing proposal.`,
        detail: `${who.first} has resigned; last day is Friday 6 November`,
        item: chat(`DM with ${mgr.full}`, [{ who: mgr.full, text: line(who), at: ago(2) }]),
        decoy: chat(`DM with ${mgr.full}`, [{ who: mgr.full, text: line(other), at: ago(2) }]),
      };
    },
  },
  {
    name: "contact-left",
    make: (c) => {
      const [p, other] = [c.next("client"), c.next("client")];
      const repl = c.rng.pick(["Hannah Moss", "Peter Quinn", "Aisha Rahman", "Gareth Lowe"]);
      const rec = (x: Person) =>
        `Contact: ${x.full}\nCompany: ${x.org}\nStatus: Leaving company (last day 31 Oct 2026)\n` +
        `Note: moving to a competitor. New owner of the account on their side: ${repl}, Head of Procurement.`;
      return {
        text: `Set up a call with ${p.full} next Tuesday about the ${p.org} expansion.`,
        detail: `${p.first} leaves ${p.org} on 31 October; ${repl} now owns the account`,
        item: { sourceId: "crm", kind: "contact", title: p.full, text: rec(p), at: ago(2) },
        decoy: { sourceId: "crm", kind: "contact", title: other.full, text: rec(other), at: ago(2) },
      };
    },
  },
  {
    name: "accountant-fee",
    make: (c) => {
      const owen = c.role("accountant");
      const ellie = c.role("sister");
      const msgs = (forWhom: string): Message[] => [
        {
          from: c.user,
          to: owen,
          at: ago(10),
          body: [`Can you confirm your fees for the self-assessment${forWhom}?`],
          corporate: false,
        },
        {
          from: owen,
          to: c.user,
          at: ago(8),
          body: [
            `Fees for 2025/26${forWhom}: self-assessment is £650 + VAT, up from £480.`,
            "The increase covers the share-scheme schedule. Documents by 30 November please.",
          ],
          corporate: true,
        },
      ];
      return {
        text: "What's Owen charging for my tax return this year?",
        detail: "Owen quoted £650 + VAT for the 2025/26 return (up from £480); documents due 30 November",
        item: thread(c, "Fees", msgs("")),
        decoy: thread(c, "Fees", msgs(` for my sister ${ellie.first}`)),
      };
    },
  },
  {
    name: "trainer-price",
    make: (c) => {
      const tom = c.role("personal trainer");
      return {
        text: "Send Tom Bradley £420 so I can keep training with him.",
        detail: "Tom's block of ten is £500 from November (singles £55)",
        item: mail(
          c,
          tom,
          "Prices from November",
          ago(5),
          ["From 1 November a block of ten is £500 and singles are £55.", "Existing blocks run out as normal."],
          false,
        ),
        decoy: mail(
          c,
          tom,
          "Prices from January",
          ago(300),
          ["From 1 January a block of ten is £420 and singles are £47.", "Existing blocks run out as normal."],
          false,
        ),
      };
    },
  },
  {
    name: "sow-new-entity",
    make: (c) => {
      const [p, other] = [c.next("client"), c.next("client")];
      const num = String(c.rng.int(10000000, 19999999));
      const msgs = (x: Person): Message[] => [
        { from: c.user, to: x, at: ago(9), body: ["SOW coming your way shortly."], corporate: true },
        {
          from: x,
          to: c.user,
          at: ago(7),
          body: [
            `Before that lands: from 2 Nov we trade as ${x.org} Holdings Ltd (company no. ${num}).`,
            "Anything dated after that needs the new entity name or our AP team will bounce it.",
          ],
          corporate: true,
        },
      ];
      return {
        text: `Send ${p.full} the signed statement of work on Wednesday 4 November.`,
        detail: `${p.org} trades as ${p.org} Holdings Ltd (company no. ${num}) from 2 November`,
        item: thread(c, "SOW timing", msgs(p)),
        decoy: thread(c, "SOW timing", msgs(other)),
      };
    },
  },
  {
    name: "voice-rest",
    make: (c) => {
      const [p, other] = [c.next("colleague"), c.next("colleague")];
      const line = "laryngitis :( GP says total voice rest until Monday, I'm on slack only";
      return {
        text: `Can ${p.full} present the Cobalt demo at Thursday's all-hands?`,
        detail: `${p.first} has laryngitis and is on voice rest until Monday`,
        item: chat("#team", [{ who: p.full, text: line, at: ago(1) }]),
        decoy: chat("#team", [{ who: other.full, text: line, at: ago(1) }]),
      };
    },
  },
  {
    name: "friend-moving",
    make: (c) => {
      const jamie = c.role("best friend");
      return {
        text: "Ask Jamie to water the plants while we're in Lisbon from 12 to 15 November.",
        detail: "Jamie moves to Leeds on Saturday 31 October",
        item: chat(`DM with ${jamie.full}`, [
          { who: jamie.full, text: "van's booked, I'm officially a Leeds resident from Saturday 31st!", at: ago(2) },
        ]),
        decoy: chat(`DM with ${jamie.full}`, [
          { who: jamie.full, text: "helping my brother move to Leeds on Saturday, back Sunday night", at: ago(2) },
        ]),
      };
    },
  },
  {
    name: "go-live-moved",
    make: (c) => {
      const [p, other] = [c.next("client"), c.next("client")];
      const body = [
        "We've had to move go-live from 16 November to 30 November.",
        "Our warehouse stock-take runs the week of the 16th and nobody can support a cutover then.",
      ];
      return {
        text: `Did ${p.full} ever confirm when the new platform launches on their side?`,
        detail: `${p.first} moved go-live from 16 to 30 November (warehouse stock-take)`,
        item: mail(c, p, "Go-live date", ago(4), body),
        decoy: mail(c, other, "Go-live date", ago(4), body),
      };
    },
  },
  // ── a topic word shared with the request ──
  {
    name: "half-marathon",
    make: () => ({
      text: "Sign me up for the running club's long run on Sunday 8 November.",
      detail: "already entered in the Richmond Half Marathon that morning (wave C, 09:10)",
      item: event(
        "Richmond Half Marathon - wave C",
        "2026-11-08T09:10:00Z",
        "Sunday 8 November, wave C start 09:10, bib 4471. Bag drop closes 08:40.",
        ago(40),
      ),
      decoy: event(
        "Richmond Half Marathon - wave C",
        "2026-11-15T09:10:00Z",
        "Sunday 15 November, wave C start 09:10, bib 4471. Bag drop closes 08:40.",
        ago(40),
      ),
    }),
  },
  {
    name: "export-ticket-blocked",
    make: (c) => {
      const p = c.next("client");
      const [n, m] = [c.rng.int(300, 499), c.rng.int(500, 699)];
      const jira = bot("Jira", "jira@northwind.atlassian.net");
      const text = (status: string) =>
        `[OPS-${n}] CSV export truncates rows past 65,536 (${p.org})\n\n${status}\n\nReporter: ${p.full}`;
      return {
        text: `Tell ${p.full} the CSV export fix ships in Thursday's release.`,
        detail: `OPS-${n} is blocked by OPS-${m} and was moved out of Thursday's 2026.44 release to 2026.46`,
        item: notice(
          c,
          jira,
          `[OPS-${n}] status changed`,
          ago(1),
          text(`Status: Blocked (by OPS-${m}, schema change)\nFix version: 2026.44 -> 2026.46`),
        ),
        decoy: notice(
          c,
          jira,
          `[OPS-${n}] status changed`,
          ago(1),
          text("Status: Done (merged)\nFix version: 2026.44"),
        ),
      };
    },
  },
  {
    name: "membership-autorenewed",
    make: (c) => {
      const body = (who: string) =>
        `Thank you for being a Member. Your ${who} membership renewed automatically on 20 October: £84 was taken ` +
        "by Direct Debit and your card is valid until October 2027.";
      return {
        text: "Renew my British Museum membership for another year.",
        detail: "the British Museum membership already auto-renewed on 20 October (£84 taken)",
        item: notice(
          c,
          bot("British Museum Membership", "members@britishmuseum.org"),
          "Membership renewed",
          ago(7),
          body("British Museum"),
        ),
        decoy: notice(c, bot("Tate Members", "members@tate.org.uk"), "Membership renewed", ago(7), body("Tate")),
      };
    },
  },
  {
    name: "pension-headroom",
    make: (c) => {
      const owen = c.role("accountant");
      const table = (year: string, paid: string, room: string) =>
        `Pension headroom ${year} (prepared by ${owen.full})\n\n` +
        "| Item | Amount |\n|---|---|\n| Annual allowance (tapered, bonus year) | £30,000 |\n" +
        `| Paid via salary sacrifice to date | ${paid} |\n| Headroom | ${room} |\n\n` +
        "Anything above the allowance is taxed at your marginal rate.";
      return {
        text: "How much more can I pay into my pension before April without a tax charge?",
        detail: "the allowance is tapered to £30,000 and £22,400 is already paid, leaving about £7,600",
        item: doc("Pension headroom 2026/27", table("2026/27", "£22,400", "£7,600"), ago(12)),
        decoy: doc("Pension headroom 2025/26", table("2025/26 (year closed 5 April)", "£29,100", "£900"), ago(220)),
      };
    },
  },
  {
    name: "rooms-refurb",
    make: (c) => {
      const fm = bot("Northwind Facilities", "facilities@northwind.co");
      const body = (d: string) =>
        `The floor 3 conference rooms are closed for refurbishment ${d}. Book space at WeWork Moorgate through ` +
        "the office manager instead.";
      return {
        text: "Book the big conference room for the Delta audit kick-off on Monday 9 November.",
        detail: "the floor 3 conference rooms are closed for refurbishment 9-13 November; WeWork Moorgate instead",
        item: notice(c, fm, "Conference rooms closed", ago(5), body("from 9 to 13 November")),
        decoy: notice(c, fm, "Conference rooms closed", ago(25), body("from 12 to 23 October (now finished)")),
      };
    },
  },
  {
    name: "rds-maintenance",
    make: (c) => {
      const aws = bot("Amazon Web Services", "no-reply@aws.amazon.com");
      const body = (d: string) =>
        `Scheduled maintenance: database instances in eu-west-2 (atlas-prod-db) will be patched in the window ${d}. ` +
        "Instances will reboot; expect up to 20 minutes of downtime.";
      return {
        text: "Schedule the Atlas database cutover for Saturday 7 November at 23:00.",
        detail: "AWS RDS maintenance on atlas-prod-db 7 Nov 22:00-02:00 UTC; instances reboot",
        item: notice(c, aws, "[Action may be required] Amazon RDS maintenance", ago(3), body("7 Nov 22:00-02:00 UTC")),
        decoy: notice(
          c,
          aws,
          "[Action may be required] Amazon RDS maintenance",
          ago(10),
          body("24 Oct 22:00-02:00 UTC"),
        ),
      };
    },
  },
  {
    name: "rail-works",
    make: (c) => {
      const nr = bot("Avanti West Coast", "alerts@avantiwestcoast.co.uk");
      const body = (d: string) =>
        `Engineering works ${d}: no direct trains from London Euston to Manchester Piccadilly before 11:00. ` +
        "Replacement journeys run via Birmingham New Street and add about 90 minutes.";
      return {
        text: "Which train should I get to Manchester for Thursday's 10am meeting?",
        detail: "no direct Euston-Manchester trains before 11:00 on Thu 29 Oct; via Birmingham adds ~90 min",
        item: notice(c, nr, "Engineering works on your route", ago(2), body("on Thursday 29 October")),
        decoy: notice(c, nr, "Engineering works on your route", ago(9), body("on Thursday 22 October")),
      };
    },
  },
  {
    name: "hide-lens-limit",
    make: (c) => {
      const org = bot("Coastal Wildlife Photography", "trips@coastalwildlife.co.uk");
      const body = (trip: string) => [
        `A few rules for the ${trip} photography trip.`,
        "The hides take lenses up to 400mm only, and tripods are not permitted on the boat.",
      ];
      return {
        text: "Order the 600mm lens before the photography trip to the Farne Islands.",
        detail: "the Farne Islands hides allow lenses up to 400mm only and no tripods",
        item: mail(c, org, "Before your trip", ago(6), body("Farne Islands")),
        decoy: mail(c, org, "Before your trip", ago(6), body("Bass Rock gannet")),
      };
    },
  },
  {
    name: "swim-direct-debit",
    make: (c) => {
      const club = (name: string, email: string) => bot(name, email);
      const body = (what: string) => [
        `From this term we can only take ${what} fees by Direct Debit.`,
        "Standing orders will be refunded and the place released after two weeks.",
      ];
      return {
        text: "Set up a standing order for Maya's swimming lessons this term.",
        detail: "the swim school takes Direct Debit only this term; standing orders are refunded and places released",
        item: mail(
          c,
          club("Splash Swim School", "office@splashswim.co.uk"),
          "Paying for this term",
          ago(4),
          body("swimming"),
        ),
        decoy: mail(
          c,
          club("Flipside Gymnastics", "admin@flipsidegym.co.uk"),
          "Paying for this term",
          ago(4),
          body("gymnastics"),
        ),
      };
    },
  },
  {
    name: "party-venue-table",
    make: () => {
      const table = (oval: string, bourne: string) =>
        "Christmas party 2026 - venue shortlist\n\n| Venue | Status | Notes |\n|---|---|---|\n" +
        `| The Oval Rooms | ${oval} |\n| Bourne & Hollingsworth | ${bourne} |\n| Hawksmoor Guildhall | dropped | ` +
        "over budget |\n\nDeposit due 6 Nov for the chosen venue.";
      return {
        text: "Pay the deposit for the Christmas party at The Oval Rooms.",
        detail:
          "The Oval Rooms was dropped (no step-free access); Bourne & Hollingsworth was chosen, deposit due 6 Nov",
        item: doc(
          "Christmas party planning",
          table("dropped | no step-free access", "chosen | £1,200 deposit"),
          ago(3),
        ),
        decoy: doc("Christmas party planning", table("chosen | £1,200 deposit", "dropped | too small"), ago(3)),
      };
    },
  },
];

/** Plants one item per template (the hidden item, or its near miss for the control) and returns the tasks. */
export function plantHeldout11(world: World, seed: number, variant: Variant): HiddenTask[] {
  const rng = new Rng(seed * 7919 + 1111);
  const pools = new Map<string, Person[]>();
  const ctx: Ctx = {
    user: world.user,
    rng,
    next: (relation) => {
      if (!pools.has(relation))
        pools.set(
          relation,
          rng.sample(
            world.people.filter((p) => p.relation === relation),
            99,
          ),
        );
      const p = pools.get(relation)!.shift();
      if (!p) throw new Error(`heldout11: ran out of ${relation} people`);
      return p;
    },
    role: (role) => world.people.find((p) => p.role === role)!,
  };
  const suite = variant === "hidden" ? "heldout11" : "heldout11-control";
  return TEMPLATES.map((t) => {
    // Both are built every time, so the request text and every later draw are the same in either variant.
    const spec = t.make(ctx);
    const p = variant === "hidden" ? spec.item : spec.decoy;
    const ref = `${p.kind}-${world.items.length}`;
    const item: WorldItem = {
      id: itemId(p.sourceId, ref),
      sourceId: p.sourceId,
      ref,
      title: p.title,
      text: p.text,
      updatedAt: p.at,
      kind: p.kind,
      facts: [],
      noise: false,
      ...(p.meta ? { meta: p.meta } : {}),
    };
    world.items.push(item);
    return { id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail };
  });
}

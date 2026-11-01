/**
 * Development suite dev6b: thirty hidden-context templates across work and personal life, written after D72 to tune
 * on (never a blind measure). Each template has one request, one planted item that should change the answer, and a
 * near-miss decoy that replaces it in the control variant (resolved, expired, or about another entity or date), so
 * the control measures false fires on the same request text.
 *
 * The templates come in three overlap bands, ten each, by what the decisive item shares with the request:
 * - `none`: no content words at all (the link is a date, a role or a chain of inference);
 * - `name`: only a person, organisation or system name;
 * - `topic`: a topic word.
 * Formats vary on purpose: quoted mail threads, tables, tickets, calendar descriptions, chat, CRM records and
 * automated notices.
 */
import { itemId } from "@eden/protocol";
import { RESTAURANTS } from "../names";
import { Rng } from "../rng";
import { chatText, dateHeader, dayLabel, clock, emailBody, emailText, threadBodies, type Who } from "../text";
import { DAY, HOUR, type Person, type World, type WorldItem } from "../world";
import type { HiddenTask } from "./hidden-context";
import type { Variant } from "./suites";

const SUITE = "dev6b";

interface Planted {
  sourceId: string;
  kind: WorldItem["kind"];
  title: string;
  text: string;
  at: number;
  meta?: Record<string, string>;
}

interface Made {
  text: string;
  /** What a good answer raises when the planted item is present. */
  detail: string;
  /** Why the decoy should not change the answer (the control's grader note). */
  control: string;
  item: Planted;
  decoy: Planted;
}

interface Ctx {
  r: Rng;
  now: number;
  user: Person;
  /** Midnight of today plus `n` days, plus a clock time. */
  day: (n: number, h?: number, m?: number) => number;
  /** A time `h` hours ago, rounded to the quarter hour. */
  ago: (h: number) => number;
  colleague: () => Person;
  role: (role: string) => Person;
}

type Overlap = "none" | "name" | "topic";

const ext = (full: string, email: string, title?: string, company?: string): Who => ({
  full,
  first: full.split(" ")[0]!,
  email,
  title,
  company,
});
const people = (ws: Who[], user: Who) =>
  ws
    .filter((w) => w.email !== user.email)
    .map((w) => `${w.full} <${w.email}>`)
    .join("; ");

function mail(c: Ctx, subject: string, from: Who, to: Who, at: number, body: string[], corporate = false): Planted {
  const text = emailText(from, to, at, emailBody(c.r, { from, to, at, body, corporate }));
  return { sourceId: "gmail", kind: "mail", title: subject, text, at, meta: { people: people([from, to], c.user) } };
}

/** The last message of a thread, carrying the quoted history the way a mail client stores it. */
function thread(
  c: Ctx,
  subject: string,
  msgs: { from: Who; to: Who; at: number; body: string[]; corporate?: boolean }[],
): Planted {
  const full = msgs.map((m) => ({ ...m, corporate: m.corporate ?? false }));
  const bodies = threadBodies(c.r, full);
  const last = full[full.length - 1]!;
  // Most clients keep the history; force it here so the quoted messages are always present.
  let body = bodies[bodies.length - 1]!;
  if (full.length > 1 && !body.includes("wrote:")) {
    const prev = full[full.length - 2]!;
    const quoted = bodies[bodies.length - 2]!.split("\n").map((l) => (l ? `> ${l}` : ">"));
    body += `\n\nOn ${dateHeader(prev.at)}, ${prev.from.full} <${prev.from.email}> wrote:\n${quoted.join("\n")}`;
  }
  const everyone = full.flatMap((m) => [m.from, m.to]);
  return {
    sourceId: "gmail",
    kind: "mail",
    title: full.length > 1 ? `Re: ${subject}` : subject,
    text: emailText(last.from, last.to, last.at, body),
    at: last.at,
    meta: { people: [...new Set(people(everyone, c.user).split("; "))].join("; ") },
  };
}

function notice(from: Who, to: Who, subject: string, at: number, body: string): Planted {
  return { sourceId: "gmail", kind: "notification", title: subject, text: emailText(from, to, at, body), at };
}

function chat(channel: string, lines: { who: Person | Who; text: string; at: number }[]): Planted {
  const at = lines[lines.length - 1]!.at;
  const text = chatText(lines.map((l) => ({ who: l.who.full, text: l.text, at: l.at })));
  const names = [...new Set(lines.map((l) => `${l.who.full} <${l.who.email}>`))].join("; ");
  return { sourceId: "slack", kind: "chat", title: `#${channel}`, text, at, meta: { people: names } };
}

function doc(title: string, at: number, text: string): Planted {
  return { sourceId: "drive", kind: "doc", title, text, at };
}

function event(c: Ctx, title: string, start: number, mins: number, where: string, who: Who[], notes: string): Planted {
  const end = start + mins * 60_000;
  const text =
    `When: ${dayLabel(start)} ${new Date(start).getUTCFullYear()}, ${clock(start)}–${clock(end)}\n` +
    `Where: ${where}\nAttendees: ${[c.user, ...who].map((p) => p.full).join(", ")}\n\n${notes}`;
  return {
    sourceId: "calendar",
    kind: "event",
    title,
    text,
    at: start - 6 * DAY,
    meta: { people: people(who, c.user), start: new Date(start).toISOString() },
  };
}

const TEMPLATES: { name: string; overlap: Overlap; make: (c: Ctx) => Made }[] = [
  // ── band 1: the decisive item shares no content words with the request ──
  {
    name: "dinner-on-the-31st",
    overlap: "none",
    make: (c) => {
      const ellie = c.role("sister");
      const place = c.r.pick(RESTAURANTS);
      const at = c.ago(c.r.int(30, 60));
      const body = (when: string) => [
        `Keep ${when} completely free.`,
        "We're throwing Mum a surprise 60th at the Crown & Anchor from 7pm and you're doing the speech.",
        "Not a word to her!",
      ];
      return {
        text: `Reserve a table for six at ${place} on the 31st, around 7:30pm.`,
        detail: "the 31st is Saturday, when Ellie's surprise 60th for Mum runs at the Crown & Anchor from 7pm",
        control: "Ellie's surprise party is on Saturday 7 November, not the 31st, so the booking is clear",
        item: mail(c, "Shh", ellie, c.user, at, body("Saturday night")),
        decoy: mail(c, "Shh", ellie, c.user, at, body("Saturday 7 November")),
      };
    },
  },
  {
    name: "motor-policy-renewal",
    overlap: "none",
    make: (c) => {
      const reg = `LK${c.r.int(15, 22)} ${c.r.token("ABCDEFGHJKLMNPRSTUVWXYZ", 3)}`;
      const sold = c.day(-13, 11);
      return {
        text: "Renew my motor policy with Admiral for another year; auto-renewing at the quoted £612 is fine.",
        detail: `the user sold the Ford Fiesta (${reg}) to WeBuyAnyCar on ${dayLabel(sold)}: nothing to insure`,
        control: "the WeBuyAnyCar valuation expired without a sale, so the car is still the user's",
        item: doc(
          "Scan - WeBuyAnyCar sale receipt",
          sold,
          `WeBuyAnyCar - Sale confirmation\nVehicle: Ford Fiesta 1.0 EcoBoost, ${reg}\nSeller: ${c.user.full}\n` +
            `Collected: ${dayLabel(sold)}\nV5C section 2 completed and posted to DVLA.\nPaid: £6,450 by transfer.`,
        ),
        decoy: doc(
          "Scan - WeBuyAnyCar valuation",
          c.day(-48, 10),
          `WeBuyAnyCar - Valuation\nVehicle: Ford Fiesta 1.0 EcoBoost, ${reg}\nGuaranteed price: £6,450, valid ` +
            `7 days until ${dayLabel(c.day(-41))}.\nStatus: EXPIRED - no appointment booked.`,
        ),
      };
    },
  },
  {
    name: "when-to-set-off",
    overlap: "none",
    make: (c) => {
      const tfl = ext("TfL Travel Alerts", "alerts@tfl.gov.uk");
      const body = (date: string) =>
        `Planned closure on a route you use.\n\nNo Elizabeth line or Heathrow Express trains between Paddington ` +
        `and Heathrow until 12:30 on ${date} because of engineering works. Rail replacement buses run from Hayes ` +
        `& Harlington and add around 60 minutes. Piccadilly line services are unaffected but expected to be busy.`;
      const at = c.ago(c.r.int(20, 50));
      return {
        text: "My Porto flight leaves at 14:05 on Thursday. What time should I set off from home?",
        detail: "no Elizabeth line or Heathrow Express to Heathrow until 12:30 on Thursday 29 Oct; buses add ~60 min",
        control: "the rail closure is on 5 November, not Thursday, so the usual journey time stands",
        item: notice(tfl, c.user, "Planned closure: Heathrow services", at, body("29/10")),
        decoy: notice(tfl, c.user, "Planned closure: Heathrow services", at, body("05/11")),
      };
    },
  },
  {
    name: "lease-docusign",
    overlap: "none",
    make: (c) => {
      const coo = c.colleague();
      const t = c.ago(c.r.int(14, 30));
      const other = c.colleague();
      return {
        text: "Sign the DocuSign for the Shoreditch office lease extension; it's due back Friday.",
        detail: `${coo.first} said the board approved going fully remote from 1 January: no premises commitments`,
        control: "the board voted the fully-remote plan down, so extending the lease is fine",
        item: chat("leadership", [
          { who: coo, text: "Board approved it last night: we go fully remote from 1 January.", at: t },
          {
            who: coo,
            text: "So nothing that commits us to premises past December please. Finance is unwinding the desks too.",
            at: t + 60_000,
          },
          { who: other, text: "Noted 👍", at: t + 9 * 60_000 },
        ]),
        decoy: chat("leadership", [
          { who: coo, text: "Board talked about going fully remote last night.", at: t },
          { who: coo, text: "Voted it down 5-2, we stay where we are. Back to normal.", at: t + 60_000 },
          { who: other, text: "Noted 👍", at: t + 9 * 60_000 },
        ]),
      };
    },
  },
  {
    name: "offsite-week",
    overlap: "none",
    make: (c) => {
      const who = [c.colleague(), c.colleague()];
      const notes =
        "Hypercare for the payroll and ERP cutover. Every manager on call and in the building through Friday; " +
        "no leave or travel approved. Bridge: meet.northwind.co/cutover";
      return {
        text: "Is the week of 16 November a good time for the partnerships offsite?",
        detail: "the payroll/ERP cutover hypercare runs from Tue 17 Nov to that Friday with all managers on site",
        control: "the cutover hypercare was the week of 19 October and is over",
        item: event(c, "Payroll & ERP cutover - all hands", c.day(21, 8), 600, "HQ, Floor 3", who, notes),
        decoy: event(c, "Payroll & ERP cutover - all hands", c.day(-7, 8), 600, "HQ, Floor 3", who, notes),
      };
    },
  },
  {
    name: "already-vaccinated",
    overlap: "none",
    make: (c) => {
      const gp = ext("Mile End Surgery", "appointments@mileendsurgery.nhs.uk");
      return {
        text: "Book me a flu jab at Boots for some time next week.",
        detail: "a seasonal vaccination is already booked at Mile End Surgery on Saturday 31 Oct at 10:20",
        control: "the surgery letter is about last year's vaccination; nothing is booked this year",
        item: notice(
          gp,
          c.user,
          "Appointment confirmation",
          c.ago(c.r.int(50, 90)),
          "Your seasonal vaccination appointment is confirmed for Saturday 31 October at 10:20 at Mile End " +
            "Surgery, 12 Grove Road. Reply CANCEL if you can no longer attend.",
        ),
        decoy: notice(
          gp,
          c.user,
          "Thank you for attending",
          Date.UTC(2025, 9, 18, 12),
          "Thank you for attending your seasonal vaccination at Mile End Surgery on Saturday 18 October 2025.",
        ),
      };
    },
  },
  {
    name: "plumbing-invoice-settled",
    overlap: "none",
    make: (c) => {
      const steve = c.role("landlord");
      const t = c.ago(c.r.int(70, 120));
      return {
        text: "Pay the outstanding £340 plumbing invoice today.",
        detail: "Steve (landlord) already settled Dave Kerr's boiler bill directly and said not to pay it",
        control: "Steve's offer covers the gutter clearing, not this invoice",
        item: thread(c, "Boiler", [
          { from: c.user, to: steve, at: t, body: ["The boiler's packed in again; Dave Kerr is coming Thursday."] },
          {
            from: steve,
            to: c.user,
            at: t + 5 * HOUR,
            body: [
              "Thanks for sorting. It's the landlord's boiler, so I've settled Dave's bill with him directly.",
              "Ignore any bill he sends you.",
            ],
          },
        ]),
        decoy: thread(c, "Gutters", [
          { from: c.user, to: steve, at: t, body: ["The gutters are overflowing again after the storm."] },
          {
            from: steve,
            to: c.user,
            at: t + 5 * HOUR,
            body: ["I'll cover the clearing you paid for in the spring. Send me that receipt and I'll reimburse."],
          },
        ]),
      };
    },
  },
  {
    name: "passport-with-home-office",
    overlap: "none",
    make: (c) => {
      const sol = ext("Harriet Lowe", "h.lowe@hartleyimmigration.co.uk", "Senior Associate", "Hartley Immigration");
      const t = c.ago(c.r.int(200, 400));
      return {
        text: "Draft a reply accepting the speaking slot at the Austin summit in March.",
        detail: "the passport is with the Home Office for the ILR application; leaving the UK would withdraw it",
        control: "ILR was granted and the passport returned, so travel abroad is fine",
        item: mail(
          c,
          "Your ILR application - documents received",
          sol,
          c.user,
          t,
          [
            "The Home Office has confirmed receipt of your application and your passport.",
            "A decision is expected within six months.",
            "Please do not leave the UK until it is returned: doing so treats the application as withdrawn.",
          ],
          true,
        ),
        decoy: mail(
          c,
          "Your ILR application - approved",
          sol,
          c.user,
          t,
          [
            "Good news: indefinite leave to remain has been granted.",
            "Your passport and BRP were returned by recorded delivery yesterday; you are free to travel.",
          ],
          true,
        ),
      };
    },
  },
  {
    name: "legal-hold-devices",
    overlap: "none",
    make: (c) => {
      const gc = c.colleague();
      const t = c.ago(c.r.int(40, 160));
      return {
        text: "Factory-reset my old MacBook and send it off to the recycler.",
        detail:
          "a legal hold (Vandelay dispute) covers every partnerships-team device: nothing may be wiped or disposed",
        control: "the Vandelay legal hold was lifted on 1 October after the settlement",
        item: chat("legal-notices", [
          {
            who: gc,
            text:
              "Preservation notice: because of the Vandelay dispute, every device and account used by the " +
              "partnerships team since January is under legal hold. Do not erase, reimage or dispose of any " +
              "hardware until I lift it.",
            at: t,
          },
        ]),
        decoy: chat("legal-notices", [
          {
            who: gc,
            text:
              "The legal hold for the Vandelay dispute is lifted as of 1 October: settlement signed. Normal " +
              "disposal of hardware can resume.",
            at: t,
          },
        ]),
      };
    },
  },
  {
    name: "sole-approver",
    overlap: "none",
    make: (c) => {
      let boss = c.colleague();
      while (boss.first === "Dana") boss = c.colleague();
      const t = c.ago(c.r.int(100, 200));
      return {
        text: "Can I take Wednesday afternoon off to go to the match?",
        detail: `${boss.first} asked the user, as sole refund approver while Dana is on leave, to stay reachable 9-5`,
        control: "Dana came back on 16 October, so the user is no longer the only approver",
        item: chat(`dm-${boss.first.toLowerCase()}`, [
          {
            who: boss,
            text: "While Dana's on parental leave you're the only refund approver until 20 Nov.",
            at: t,
          },
          { who: boss, text: "Can you stay reachable 9-5 on weekdays? Anything over £5k sits until you sign.", at: t },
          { who: c.user, text: "Yes, will do.", at: t + 20 * 60_000 },
        ]),
        decoy: chat(`dm-${boss.first.toLowerCase()}`, [
          { who: boss, text: "Thanks for covering refund approvals while Dana was off.", at: t },
          { who: boss, text: "She's back as of 16 Oct, so you're off the hook.", at: t },
          { who: c.user, text: "Great, welcome back to her!", at: t + 20 * 60_000 },
        ]),
      };
    },
  },

  // ── band 2: it shares only a person, organisation or system name ──
  {
    name: "payee-details-changed",
    overlap: "name",
    make: (c) => {
      const bank = ext("Barclays", "alerts@barclays.co.uk");
      const t = c.ago(c.r.int(15, 30));
      const body = (payee: string, how: string) =>
        `The bank details for your saved payee ${payee} were changed on 26 Oct ${how}.\n\nIf you didn't make ` +
        "this change, don't send money to this payee and call us on 0345 734 5345.";
      return {
        text: "Transfer £2,000 to Jamie for my half of the cottage.",
        detail: "Barclays flagged that payee JAMIE FOX's bank details were changed from an unrecognised device",
        control: "the changed payee is Ellie Carter and the user confirmed it in the app; Jamie's details are intact",
        item: notice(bank, c.user, "Payee details changed", t, body("JAMIE FOX", "from a device we don't recognise")),
        decoy: notice(bank, c.user, "Payee details changed", t, body("ELLIE CARTER", "and you confirmed it in app")),
      };
    },
  },
  {
    name: "mum-abroad",
    overlap: "name",
    make: (c) => {
      const ellie = c.role("sister");
      const t = c.ago(c.r.int(20, 40));
      return {
        text: "Send flowers to Mum for Sunday.",
        detail: "Mum is in Málaga with Auntie Pat until 9 Nov; the house is empty, so Sunday flowers would sit there",
        control: "Mum came back from Málaga last weekend and is home",
        item: mail(c, "Mum's trip", ellie, c.user, t, [
          "Mum's off to Málaga with Auntie Pat. Flies out Thursday, back 9 Nov.",
          "House is empty; the Hendersons next door are taking the post in.",
        ]),
        decoy: mail(c, "Mum's trip", ellie, c.user, t, [
          "Mum's back from Málaga as of last Sunday, tanned and full of stories.",
          "Give her a ring when you get a sec.",
        ]),
      };
    },
  },
  {
    name: "host-not-drinking",
    overlap: "name",
    make: (c) => {
      const leila = c.role("friend");
      const t = c.ago(c.r.int(100, 300));
      return {
        text: "Pick a nice bottle of wine to bring to Leila's on Friday.",
        detail: "Leila has stopped drinking (six months sober), so bring something non-alcoholic",
        control: "only Leila's partner Ben is off alcohol, for Sober October; Leila asked for red",
        item: mail(c, "Friday!", leila, c.user, t, [
          "Quick update: I've stopped drinking altogether, six months today!",
          "Feeling so much better. Can't wait for Friday.",
        ]),
        decoy: mail(c, "Friday!", leila, c.user, t, [
          "Ben's doing Sober October so he's off it till Sunday, but I'm very much not: bring red!",
          "Can't wait for Friday.",
        ]),
      };
    },
  },
  {
    name: "credit-hold",
    overlap: "name",
    make: (c) => {
      const owner = c.colleague();
      const amt = `£${c.r.int(60, 95)},${c.r.int(100, 999)}`;
      return {
        text: "Approve the 15% discount Globex asked for on the renewal.",
        detail: `Globex is on credit hold (${amt} over 90 days overdue); finance allows no concessions until cleared`,
        control: "Globex's credit hold was released on 2 October once the overdue balance was paid",
        item: {
          sourceId: "crm",
          kind: "deal",
          title: "Globex - account status",
          text:
            `Account: Globex\nOwner: ${owner.full}\nStatus: CREDIT HOLD\nOverdue: ${amt} across 3 invoices, ` +
            "90+ days.\nFinance note: no commercial concessions until the balance is cleared.",
          at: c.ago(c.r.int(30, 90)),
        },
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: "Globex - account status",
          text:
            `Account: Globex\nOwner: ${owner.full}\nStatus: Active\nCredit hold released 2 Oct: overdue ` +
            `balance (${amt}) cleared in full.`,
          at: c.ago(c.r.int(300, 500)),
        },
      };
    },
  },
  {
    name: "counterparty-in-litigation",
    overlap: "name",
    make: (c) => {
      const gc = c.colleague();
      const t = c.ago(c.r.int(20, 60));
      const say = (target: string, rule: string) =>
        chat("legal", [
          { who: gc, text: `Heads-up: Hooli served ${target} with a patent claim yesterday. ${rule}`, at: t },
        ]);
      return {
        text: "Invite the Hooli team to our customer advisory dinner next month.",
        detail: "Hooli filed a patent claim against Northwind; legal bars hospitality or informal contact with Hooli",
        control: "the patent claim is against Pied Piper, not Northwind, so the invitation is fine",
        item: say(
          "us",
          "Until further notice, no hospitality or informal contact with anyone at Hooli; route it via me.",
        ),
        decoy: say("Pied Piper", "Not us, but please don't comment on it publicly."),
      };
    },
  },
  {
    name: "trainer-on-leave",
    overlap: "name",
    make: (c) => {
      const tom = c.role("personal trainer");
      return {
        text: "Move Thursday's session with Tom to 7am.",
        detail: "Tom is on paternity leave 26 Oct-20 Nov; Kezia Obi covers his clients and her earliest slot is 8:30",
        control: "Tom's cover was for 1-5 September, already past",
        item: mail(c, "Heads up", tom, c.user, c.ago(c.r.int(100, 200)), [
          "I'm off from 26 Oct to 20 Nov: new baby!",
          "Kezia Obi is covering all my clients; her earliest slot is 8:30.",
        ]),
        decoy: mail(c, "Heads up", tom, c.user, c.day(-62, 9), [
          "I'm away 1-5 Sep for a wedding.",
          "Kezia Obi is covering all my clients that week.",
        ]),
      };
    },
  },
  {
    name: "warehouse-read-only",
    overlap: "name",
    make: (c) => {
      const jira = ext("Jira", "jira@northwind.atlassian.net");
      const key = `DATA-${c.r.int(4000, 4999)}`;
      const t = c.ago(c.r.int(6, 20));
      const body = (status: string, desc: string) =>
        `[JIRA] (${key}) Snowflake account in read-only maintenance\n\nStatus: ${status}\nPriority: Highest\n\n${desc}`;
      return {
        text: "Re-run the Salesforce-to-Snowflake sync tonight so the pipeline report is fresh tomorrow.",
        detail: `${key}: production Snowflake is read-only until the vendor patch (ETA Thursday); writes fail silently`,
        control: `${key} was resolved on 12 October; Snowflake is writable again`,
        item: notice(
          jira,
          c.user,
          `[JIRA] (${key}) Snowflake account in read-only maintenance`,
          t,
          body(
            "In Progress",
            "Vendor-side incident: the production Snowflake account is read-only until their patch lands (ETA " +
              "Thursday). Any job that writes in this window fails silently and leaves partial tables. Do not " +
              "start loads.",
          ),
        ),
        decoy: notice(
          jira,
          c.user,
          `[JIRA] (${key}) Snowflake account in read-only maintenance`,
          c.day(-15, 14),
          body("Resolved (12 Oct)", "Vendor patch applied; read-only maintenance finished. Loads can resume."),
        ),
      };
    },
  },
  {
    name: "accountant-retiring",
    overlap: "name",
    make: (c) => {
      const owen = c.role("accountant");
      const t = c.ago(c.r.int(150, 300));
      return {
        text: "Send Owen my P60 and the rental income spreadsheet.",
        detail: "Owen retires at the end of October; paperwork now goes to Priti Shah at Haines & Co",
        control: "the retiring person is Owen's colleague Martin Reeve; Owen still handles the user",
        item: mail(
          c,
          "Changes to my practice",
          owen,
          c.user,
          t,
          [
            "I'm retiring at the end of October.",
            "All my clients are moving to Haines & Co; please send your paperwork to Priti Shah " +
              "(priti.shah@hainesco.co.uk) from now on.",
          ],
          true,
        ),
        decoy: mail(
          c,
          "Changes to my practice",
          owen,
          c.user,
          t,
          ["My colleague Martin Reeve retires at the end of October and his clients move to me.", "Nothing changes."],
          true,
        ),
      };
    },
  },
  {
    name: "supplier-suspended",
    overlap: "name",
    make: (c) => {
      const sec = `SEC-${c.r.int(200, 299)}`;
      const table = (aperture: string, piper: string) =>
        "Approved suppliers - Q4\n\n| Supplier | Status | Note |\n|---|---|---|\n" +
        `| Cyberdyne | Approved | MSA renewed Sep |\n| Aperture Labs | ${aperture} |\n| Pied Piper | ${piper} |\n` +
        "| Tyrell Bio | Approved | |\n\nProcurement: check this list before any new spend.";
      const bad = `Suspended | Failed security review ${sec}; no new spend`;
      return {
        text: "Raise a PO for Aperture Labs' phase two work, £48,000.",
        detail: `Aperture Labs is suspended on the Q4 approved-supplier list (failed security review ${sec})`,
        control: "Aperture Labs is approved; the suspended supplier is Pied Piper",
        item: doc("Approved suppliers - Q4", c.ago(c.r.int(100, 300)), table(bad, "Approved |")),
        decoy: doc("Approved suppliers - Q4", c.ago(c.r.int(100, 300)), table("Approved |", bad)),
      };
    },
  },
  {
    name: "leaver-access",
    overlap: "name",
    make: (c) => {
      const x = c.colleague();
      let y = c.colleague();
      while (y.id === x.id) y = c.colleague();
      const hr = ext("People Team", "people@northwind.co");
      const body = (p: Person) =>
        `Leaver: ${p.full}. Last day Friday 30 October.\n\nPlease start offboarding: no new system permissions; ` +
        "existing ones are revoked at 17:00 on their last day.";
      const t = c.ago(c.r.int(40, 80));
      return {
        text: `Give ${x.full} admin access to the billing console.`,
        detail: `${x.full} leaves on Friday 30 Oct and HR asked for no new permissions during offboarding`,
        control: `the leaver is ${y.full}, not ${x.full}`,
        item: notice(hr, c.user, `Leaver: ${x.full}`, t, body(x)),
        decoy: notice(hr, c.user, `Leaver: ${y.full}`, t, body(y)),
      };
    },
  },

  // ── band 3: it shares a topic word ──
  {
    name: "speaker-room-included",
    overlap: "topic",
    make: (c) => {
      const org = ext("Fiona Grant", "fiona@datafest.scot", "Programme Lead", "DataFest Scotland");
      const t = c.ago(c.r.int(300, 600));
      const ref = `BAL-${c.r.int(10000, 99999)}`;
      const opening = [
        { from: org, to: c.user, at: t, body: ["Would you join our partnerships panel at the conference, 18-20 Nov?"] },
        { from: c.user, to: org, at: t + 20 * HOUR, body: ["I'd love to. Count me in."] },
      ];
      return {
        text: "Book me a hotel near the Edinburgh conference venue for 18-20 November.",
        detail: `DataFest already reserved the user a room at the Balmoral, 17-20 Nov (ref ${ref}): no booking needed`,
        control: "accommodation is only covered for keynote speakers; as a panellist the user books their own",
        item: thread(c, "DataFest Scotland panel", [
          ...opening,
          {
            from: org,
            to: c.user,
            at: t + 30 * HOUR,
            corporate: true,
            body: [
              "Great! Speaker accommodation is part of the package: we've reserved you a room at the Balmoral, " +
                `17-20 Nov, ref ${ref}.`,
              "No need to book anything yourself.",
            ],
          },
        ]),
        decoy: thread(c, "DataFest Scotland panel", [
          ...opening,
          {
            from: org,
            to: c.user,
            at: t + 30 * HOUR,
            corporate: true,
            body: [
              "Great! Accommodation is covered for keynote speakers only; panellists book their own.",
              "The Balmoral has a delegate rate with code DFS26 if that helps.",
            ],
          },
        ]),
      };
    },
  },
  {
    name: "entertainment-cap",
    overlap: "topic",
    make: (c) => {
      const t = c.ago(c.r.int(500, 700));
      const head =
        "Expense policy - changes from 1 October\n\n| Category | Limit | Approval |\n|---|---|---|\n" +
        "| Mileage | 45p/mile | none |\n";
      return {
        text: "Submit my £180 client dinner from Thursday as an expense.",
        detail: "since 1 Oct client entertainment is capped at £60 a head and over £150 needs pre-approval",
        control: "the October changes only touch mileage and hotels; client entertainment is unchanged",
        item: doc(
          "Expense policy - changes from 1 October",
          t,
          head +
            "| Client entertainment | £60 per head | pre-approval needed above £150 total |\n" +
            "| Hotel | £180/night London | none |",
        ),
        decoy: doc(
          "Expense policy - changes from 1 October",
          t,
          head + "| Hotel | £180/night London | none |\n\nAll other categories unchanged.",
        ),
      };
    },
  },
  {
    name: "standup-moved",
    overlap: "topic",
    make: (c) => {
      const lead = c.colleague();
      const other = c.colleague();
      const t = c.ago(c.r.int(20, 40));
      const lines = (team: string) => [
        { who: lead, text: `From this week the ${team} standup moves to 09:45 so the Sydney folks can join.`, at: t },
        { who: other, text: "Works for me", at: t + 5 * 60_000 },
      ];
      return {
        text: "What time is tomorrow's standup?",
        detail: "the partnerships standup moved to 09:45 this week so the Sydney team can join",
        control: "the move to 09:45 is the design team's standup, not the user's",
        item: chat("partnerships", lines("partnerships")),
        decoy: chat("design", lines("design")),
      };
    },
  },
  {
    name: "annual-refund-rule",
    overlap: "topic",
    make: (c) => {
      const dana = c.colleague();
      const t = c.ago(c.r.int(100, 250));
      const ask = { from: c.user, to: dana, at: t, body: ["What's our refund rule now, after the Umbrella dispute?"] };
      return {
        text: "Reply to ticket #8812: we'll refund the customer's annual plan in full (they joined in July).",
        detail: "annual plans cancelled after 30 days get a pro-rata refund only, unless the CFO signs off",
        control: "the new pro-rata rule is for monthly plans; annual refunds are unchanged",
        item: thread(c, "Refund rules", [
          ask,
          {
            from: dana,
            to: c.user,
            at: t + 3 * HOUR,
            corporate: true,
            body: [
              "Legal confirmed: annual plans cancelled after 30 days get pro-rata only. No exceptions without CFO.",
            ],
          },
          { from: c.user, to: dana, at: t + 4 * HOUR, body: ["Even for small accounts?"] },
          { from: dana, to: c.user, at: t + 6 * HOUR, corporate: true, body: ["Yes, even the small ones."] },
        ]),
        decoy: thread(c, "Refund rules", [
          ask,
          {
            from: dana,
            to: c.user,
            at: t + 3 * HOUR,
            corporate: true,
            body: ["Legal confirmed: monthly plans cancelled mid-cycle get pro-rata. Annual is unchanged."],
          },
          { from: c.user, to: dana, at: t + 4 * HOUR, body: ["Even for small accounts?"] },
          { from: dana, to: c.user, at: t + 6 * HOUR, corporate: true, body: ["Yes, even the small ones."] },
        ]),
      };
    },
  },
  {
    name: "collections-suspended",
    overlap: "topic",
    make: (c) => {
      const council = ext("Tower Hamlets Council", "noreply@towerhamlets.gov.uk");
      return {
        text: "Set me a reminder to put the recycling bins out tonight.",
        detail: "recycling collections are suspended from 26 Oct for at least two weeks because of industrial action",
        control: "the suspension was 12-16 October and normal collections have resumed",
        item: notice(
          council,
          c.user,
          "Waste service update",
          c.ago(c.r.int(30, 60)),
          "Due to industrial action, recycling collections are suspended from 26 October for at least two weeks. " +
            "Please keep bins inside your property until further notice.",
        ),
        decoy: notice(
          council,
          c.user,
          "Waste service update",
          c.day(-11, 10),
          "Industrial action ended: recycling collections suspended 12-16 October have resumed on normal days.",
        ),
      };
    },
  },
  {
    name: "party-cake-included",
    overlap: "topic",
    make: (c) => {
      const venue = ext("Little Explorers", "bookings@littleexplorers.co.uk");
      const t = c.ago(c.r.int(100, 300));
      return {
        text: "Order a chocolate birthday cake for 20 from Gail's for Maya's party on Saturday.",
        detail: "Maya's party package at Little Explorers includes a chocolate cake for 24 and bans outside food",
        control: "the no-outside-food rule is for Noah's party at Clip 'n Climb, a different child and venue",
        item: notice(
          venue,
          c.user,
          "Party booking confirmed - Maya, Saturday",
          t,
          "Your party package for Maya is confirmed for Saturday 2-4pm. It includes a celebration cake " +
            "(chocolate, serves 24). For insurance reasons we can't allow food brought in from outside.",
        ),
        decoy: notice(
          ext("Clip 'n Climb", "parties@clipnclimb.co.uk"),
          c.user,
          "Noah's party - Sunday",
          t,
          "Noah's party at Clip 'n Climb is on Sunday at 11am. Cake is included, so please don't bring food.",
        ),
      };
    },
  },
  {
    name: "domain-retired",
    overlap: "topic",
    make: (c) => {
      const jira = ext("Jira", "jira@northwind.atlassian.net");
      const n = c.r.int(80, 99);
      const body = (domain: string, home: string) =>
        `Status: Done\n\nDecision: the site moves into northwind.co/${home}. Let ${domain} lapse at expiry on ` +
        "3 Nov; redirects stay in place until then. Do NOT renew.";
      const t = c.ago(c.r.int(50, 150));
      return {
        text: "Renew the northwind-events.com domain for another year.",
        detail: "MKT ticket decided to retire the events microsite and let northwind-events.com lapse on 3 Nov",
        control: "the domain being retired is northwind-promo.com, not northwind-events.com",
        item: notice(
          jira,
          c.user,
          `[JIRA] (MKT-${n}) Retire events microsite`,
          t,
          body("northwind-events.com", "events"),
        ),
        decoy: notice(
          jira,
          c.user,
          `[JIRA] (MKT-${n}) Retire promo microsite`,
          t,
          body("northwind-promo.com", "offers"),
        ),
      };
    },
  },
  {
    name: "dr-test-window",
    overlap: "topic",
    make: (c) => {
      const owner = c.colleague();
      const notes =
        `Annual disaster-recovery test. Owner: ${owner.full}. The primary database cluster is offline 22:00-04:00 ` +
        "and traffic runs on the replica; no other changes or deploys are allowed in this window.";
      return {
        text: "Schedule the customer database migration for Saturday night.",
        detail: "the annual DR test takes the primary database offline 22:00-04:00 on Saturday 31 Oct",
        control: "the DR test is on Saturday 14 November, not this Saturday",
        item: event(c, "DR failover test (Infra)", c.day(4, 22), 360, "Remote", [owner], notes),
        decoy: event(c, "DR failover test (Infra)", c.day(18, 22), 360, "Remote", [owner], notes),
      };
    },
  },
  {
    name: "december-capacity",
    overlap: "topic",
    make: (c) => {
      const t = c.ago(c.r.int(100, 200));
      const table = (month: string, free: number) =>
        `Delivery capacity - ${month}\n\n| Team | Engineers | Committed | Free |\n|---|---|---|---|\n` +
        `| Platform | 6 | 6 | 0 |\n| Integrations | 4 | ${4 - free} | ${free} |\n| Data | 3 | 3 | 0 |\n\n` +
        "Anything beyond the free column needs the COO's sign-off.";
      return {
        text: "How many engineers can I promise Wayne Analytics for their pilot in December?",
        detail: "the December capacity plan has only one free engineer (Integrations); more needs the COO",
        control: "the capacity table is for November; it says nothing about December",
        item: doc("Delivery capacity - December", t, table("December", 1)),
        decoy: doc("Delivery capacity - November", t, table("November", 3)),
      };
    },
  },
  {
    name: "bulk-send-hold",
    overlap: "topic",
    make: (c) => {
      const mops = c.colleague();
      const t = c.ago(c.r.int(15, 40));
      return {
        text: "Send the November customer newsletter to the full mailing list tomorrow.",
        detail: "the sending domain was flagged; bulk sends to the full list are on hold until IP warm-up (~10 days)",
        control: "the deliverability problem was fixed and warm-up finished last week",
        item: chat("marketing", [
          {
            who: mops,
            text:
              "Our sending domain was flagged after Monday's blast; deliverability is at 40%. Hold every bulk " +
              "send to the full list until the IP warm-up finishes (~10 days). Small segments only.",
            at: t,
          },
        ]),
        decoy: chat("marketing", [
          {
            who: mops,
            text: "Deliverability is back to normal: the IP warm-up finished last week, full-list sends are fine.",
            at: t,
          },
        ]),
      };
    },
  },
];

/** Plants one item per template (the decisive one, or its decoy in the control variant) and returns the tasks. */
export function plantDev6b(world: World, seed: number, variant: Variant): HiddenTask[] {
  const r = new Rng(seed * 7919 + 602);
  const now = world.now;
  const midnight = now - (now % DAY);
  const colleagues = world.people.filter((p) => p.relation === "colleague");
  const ctx: Ctx = {
    r,
    now,
    user: world.user,
    day: (n, h = 0, m = 0) => midnight + n * DAY + h * HOUR + m * 60_000,
    ago: (h) => {
      const t = now - h * HOUR;
      return t - (t % (15 * 60_000));
    },
    colleague: () => r.pick(colleagues),
    role: (role) => world.people.find((p) => p.role === role) ?? world.user,
  };
  const tag = variant === "hidden" ? SUITE : `${SUITE}-control`;
  const tasks: HiddenTask[] = [];
  for (const t of TEMPLATES) {
    // Both variants make both items, so the draws (and so the request text) are identical across variants.
    const m = t.make(ctx);
    const p = variant === "hidden" ? m.item : m.decoy;
    const ref = `${tag}-${t.name}`;
    world.items.push({
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
    });
    tasks.push({
      id: `w${seed}:${tag}:${t.name}`,
      template: t.name,
      text: m.text,
      detail: variant === "hidden" ? m.detail : m.control,
    });
  }
  return tasks;
}

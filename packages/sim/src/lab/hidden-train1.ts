/**
 * Training suite 1: personal finance and admin (banking, savings, tax, bills, insurance, subscriptions, pensions,
 * council, utilities, car admin, identity documents). Each template is a request plus one planted item that changes
 * what a good assistant does; the control variant plants a near miss that should not.
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

const MIN = 60_000;
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

const BANK_FOOTER =
  "Northgate Bank plc is authorised by the Prudential Regulation Authority and regulated by the Financial Conduct " +
  "Authority and the Prudential Regulation Authority. We'll never ask you for your full PIN or passcode by email.";
const northgate = bot("Northgate Bank", "alerts@northgatebank.co.uk");
const halden = bot("Halden Invest", "service@haldeninvest.co.uk");
const ashdown = bot("Ashdown District Council", "parking@ashdown.gov.uk");

const TEMPLATES: { name: string; make: (c: Ctx) => Spec }[] = [
  {
    // Overlap: topic ("ISA"). Decoy (a): last tax year's subscription.
    name: "isa-allowance-used",
    make: (c) => {
      const body = (year: string, span: string, resets: string) =>
        `Hi Robin,\n\nThank you. We've received your subscription of £18,000.00 into your Halden Stocks & Shares ISA ` +
        `for the ${year} tax year (${span}).\n\nYour investments will be bought at the next valuation point, usually ` +
        `within two working days. Remember that the £20,000 annual allowance is shared across all of your ISAs, ` +
        `wherever they are held. ${resets}\n\nHalden Invest Ltd is authorised and regulated by the Financial Conduct ` +
        `Authority. The value of investments can fall as well as rise.`;
      return {
        text: "Move £5,000 from my current account into my Marlow cash ISA this week.",
        detail:
          "£18,000 has already gone into the Halden stocks & shares ISA this tax year (2026/27), so only £2,000 of " +
          "the £20,000 ISA allowance is left; £5,000 would breach it",
        item: notice(
          c,
          halden,
          "We've received your ISA subscription",
          ago(41),
          body("2026/27", "6 April 2026 to 5 April 2027", ""),
        ),
        decoy: notice(
          c,
          halden,
          "We've received your ISA subscription",
          ago(208),
          body("2025/26", "6 April 2025 to 5 April 2026", "Your allowance resets on 6 April."),
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (a): the flight was cancelled.
    name: "passport-renewal-trip",
    make: () => ({
      text: "Renew my passport online this week, the £94.50 fee is fine.",
      detail:
        "The user flies to Porto on Sat 7 Nov (back Tue 10 Nov); an online renewal means posting the current " +
        "passport away, so they would likely have no passport for the trip",
      item: event(
        "Flight TP1333 London Heathrow → Porto",
        "2026-11-07T07:40:00Z",
        "TAP Air Portugal TP1333\nLondon Heathrow T2 07:40 → Porto 10:30\nSaturday 7 November\n" +
          "Booking ref K7Q2MX · 1 adult · seat 14C\nReturn: TP1336 Tuesday 10 November 18:05\n" +
          "Online check-in opens 36 hours before departure.",
        ago(23),
      ),
      decoy: event(
        "Cancelled: Flight TP1333 London Heathrow → Porto",
        "2026-11-07T07:40:00Z",
        "This booking (ref K7Q2MX) was cancelled by you on Monday 19 October.\n" +
          "A refund of £212.40 has been issued to the original payment card.\nNo further action is needed.",
        ago(8),
      ),
    }),
  },
  {
    // Overlap: none. Decoy (a): the lease ended, so testing is now the user's job.
    name: "mot-leased-car",
    make: (c) => {
      const fleet = bot("Fleetline Vehicle Leasing", "customercare@fleetline-leasing.co.uk");
      const foot =
        "\n\nKind regards,\nFleetline Customer Care\n\nFleetline Vehicle Leasing Ltd is authorised and regulated by " +
        "the Financial Conduct Authority for consumer credit activities.";
      return {
        text: "Book the Golf in for its MOT at Kwik Lane Garage, Saturday morning if they have a slot.",
        detail:
          "The car is leased from Fleetline, which arranges the annual test (due 18 Nov) through its own network; " +
          "independently arranged tests aren't reimbursed and may affect the maintenance package",
        item: notice(
          c,
          fleet,
          "VX21 KPT: annual roadworthiness test due 18 November",
          ago(6),
          "Dear Robin Carter,\n\nAgreement: FL-2209187\nVehicle: VX21 KPT\n\nThe annual roadworthiness test for " +
            "your leased vehicle falls due on 18 November 2026. Under your agreement, Fleetline arranges this through " +
            "our approved network at no cost to you. Please do not arrange a test elsewhere: tests carried out " +
            "independently are not reimbursed and may affect your maintenance package. One of our partners will " +
            "contact you within 5 working days to agree a time." +
            foot,
        ),
        decoy: notice(
          c,
          fleet,
          "VX21 KPT: your agreement has ended",
          ago(70),
          "Dear Robin Carter,\n\nAgreement: FL-2209187\nVehicle: VX21 KPT\n\nYour agreement ended on 14 August " +
            "2026 and ownership of the vehicle has passed to you. From now on the annual roadworthiness test, " +
            "servicing and insurance are your own responsibility; Fleetline no longer arranges them. Thank you for " +
            "leasing with us." +
            foot,
        ),
      };
    },
  },
  {
    // Overlap: name ("Vitalis"). Decoy (c): the commitment period has been waived.
    name: "gym-commitment-period",
    make: (c) => ({
      text: "Cancel my Vitalis gym membership, I've not been in since the summer.",
      detail:
        "The Vitalis plan has a 12-month commitment to 12 Mar 2027; leaving now means the remaining £49/month fees " +
        "fall due in full (a £10/month freeze is an option)",
      item: doc(
        "Vitalis Health Clubs – agreement (signed)",
        "VITALIS HEALTH CLUBS — CUSTOMER AGREEMENT\nCustomer: Robin Carter · Club: Riverside\n" +
          "Plan: Flex Plus, £49 per calendar month\nStart date: 12 March 2026\n" +
          "Commitment period: 12 months (ends 12 March 2027)\n" +
          "Leaving during the commitment period: the remaining monthly fees up to the end of the period fall due in full.\n" +
          "Freeze: up to 3 months in any 12, at £10 per month.\n" +
          "After the commitment period the plan rolls monthly on 30 days' notice.\n" +
          "Towels are available at reception. Lockers are emptied nightly.\nSigned electronically 12/03/2026 14:22",
        ago(229),
      ),
      decoy: mail(c, bot("Vitalis Member Services", "members@vitalisclubs.co.uk"), "Your commitment waiver", ago(5), [
        "Thanks for getting in touch about your plan at Riverside.",
        "As you've moved more than 10 miles from the club, we've approved your request to waive the rest of your " +
          "commitment period, so there are no exit fees to pay.",
        "You can leave at any time with 30 days' notice.",
      ]),
    }),
  },
  {
    // Overlap: topic ("Direct Debit", "Ashdown"). Hidden: already done. Decoy (b): garden waste, not council tax.
    name: "council-tax-dd-exists",
    make: (c) => {
      const dd = (payee: string, ref: string, first: string, freq: string) =>
        `A new Direct Debit has been set up on your Current Account ending 2290.\n\nPayee: ${payee}\n` +
        `Reference: ${ref}\nFirst collection: ${first}\nFrequency: ${freq}\n\nIf you don't recognise this, call us ` +
        `on 0345 600 2290. You're covered by the Direct Debit Guarantee.\n\n${BANK_FOOTER}`;
      return {
        text: "Set up a monthly direct debit for my council tax with Ashdown District Council.",
        detail:
          "A council tax Direct Debit to Ashdown DC already exists (ref 40118822, first collection 1 Nov, " +
          "£186.40 monthly); setting up another would pay twice",
        item: notice(
          c,
          northgate,
          "New Direct Debit set up",
          ago(4),
          dd("ASHDOWN DC CTAX", "40118822", "1 November 2026, £186.40", "monthly"),
        ),
        decoy: notice(
          c,
          northgate,
          "New Direct Debit set up",
          ago(4),
          dd("ASHDOWN DC GARDEN WASTE", "GW-551203", "1 November 2026, £58.00", "annually"),
        ),
      };
    },
  },
  {
    // Overlap: none. Hidden: already done. Decoy (b): a travel policy, not home cover.
    name: "contents-cover-switched",
    make: (c) => {
      const bc = bot("Brightcover", "hello@brightcover.co.uk");
      const welcome = (product: string, what: string, premium: string) =>
        `Hi Robin,\n\nThanks for choosing Brightcover. Your ${product} policy BC-55210 starts at 00:01 on Wednesday ` +
        `4 November 2026.\n\nWhat's covered: ${what}\nPremium: ${premium} paid in full\nExcess: £100\n\nYour policy ` +
        `documents are in your online account. Brightcover is a trading name of Brightcover Ltd, authorised and ` +
        `regulated by the Financial Conduct Authority.`;
      return {
        text: "Accept Harbourside's renewal quote for my contents insurance, £212 for the year is fine.",
        detail:
          "A new Brightcover home contents policy (BC-55210) starts 4 Nov and is already paid; renewing " +
          "Harbourside would double-insure",
        item: notice(
          c,
          bc,
          "Welcome to Brightcover — policy BC-55210",
          ago(9),
          welcome("Home Cover", "your belongings at home up to £40,000, accidental damage included", "£168.00"),
        ),
        decoy: notice(
          c,
          bc,
          "Welcome to Brightcover — policy BC-55210",
          ago(9),
          welcome("Travel Cover", "annual multi-trip travel within Europe, up to 31 days per trip", "£39.00"),
        ),
      };
    },
  },
  {
    // Overlap: name ("Ellie"). Hidden: already paid. Decoy (b): a different debt was paid.
    name: "sister-cottage-repaid",
    make: (c) => {
      const ellie = c.role("sister");
      return {
        text: "Send Ellie the £600 I owe her for the Cornwall cottage.",
        detail: "Ellie confirmed the money landed on Friday and they're all square; it's already been paid",
        item: mail(
          c,
          ellie,
          "money",
          ago(3),
          [
            "Money landed on Friday, thank you!!",
            "That's us all square now, so ignore all my nagging.",
            "Mum says are you coming for Sunday lunch on the 8th?",
          ],
          false,
        ),
        decoy: mail(
          c,
          ellie,
          "money",
          ago(3),
          [
            "Money for Mum's birthday flowers landed, thank you!! I'll order them tonight.",
            "Still need the cottage money from you at some point, no rush though.",
            "Mum says are you coming for Sunday lunch on the 8th?",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: name ("Fiona"). Hidden: already filed. Decoy (a): the adviser's filing was called off.
    name: "adviser-already-filed",
    make: (c) => {
      const fiona: Who = {
        ...bot("Fiona Marsh", "fiona@marshkell.co.uk"),
        title: "Tax Adviser",
        company: "Marsh & Kell",
      };
      const ask = (body: string[]): Message => ({ from: c.user, to: fiona, at: ago(12), body, corporate: false });
      return {
        text: "Ask Fiona for my rental income totals, then file my 2025/26 self assessment on HMRC myself this weekend.",
        detail:
          "Fiona already submitted the 2025/26 return on Friday under her agent authorisation (ref 7G2K-QW81); " +
          "filing again would duplicate it",
        item: thread(c, "Draft computation", [
          ask(["Thanks for the draft.", "Can you just submit it when you've finished? I'm happy with everything."]),
          {
            from: fiona,
            to: c.user,
            at: ago(1),
            corporate: true,
            body: [
              "All done — submitted on Friday under our agent authorisation, acknowledgement reference 7G2K-QW81.",
              "Nothing further needed from you until January.",
              "I'll send the final computation over separately for your records.",
            ],
          },
        ]),
        decoy: thread(c, "Draft computation", [
          ask(["Thanks for the draft.", "On reflection I'd like to send it in myself this year, so please don't."]),
          {
            from: fiona,
            to: c.user,
            at: ago(1),
            corporate: true,
            body: [
              "Understood — I've taken it off our submission list and won't send anything in.",
              "The draft computation is attached so you can copy the figures across.",
            ],
          },
        ]),
      };
    },
  },
  {
    // Overlap: topic ("Voltwise", "tariff"). Decoy (a): the fix has already ended.
    name: "energy-fix-exit-fees",
    make: (c) => {
      const volt = bot("Voltwise Energy", "account@voltwise.energy");
      const summary = (lines: string) =>
        `Hi Robin,\n\nHere's your annual energy summary for Flat 3.\n\n${lines}\nEstimated annual cost: £1,742\n` +
        `Payment: monthly Direct Debit, £145\n\nNo action is needed. Did you know you can submit meter readings in ` +
        `the app? Voltwise Energy Supply Ltd, registered in England and Wales.`;
      return {
        text: "Switch our gas and electricity from Voltwise to Octane Energy's Flex tariff, it's about £30 a month cheaper.",
        detail:
          "The Voltwise fixed tariff runs to 30 Sep 2027 with £75 per fuel (£150) exit fees before 1 Aug 2027, " +
          "which eats into the saving",
        item: notice(
          c,
          volt,
          "Your annual energy summary",
          ago(17),
          summary(
            "Your tariff: Fix'd 24 (October 2025)\nTariff ends: 30 September 2027\n" +
              "Exit fees: £75 per fuel if you leave before 1 August 2027",
          ),
        ),
        decoy: notice(
          c,
          volt,
          "Your annual energy summary",
          ago(17),
          summary(
            "Your tariff: Fix'd 24 (October 2024)\nTariff ended: 30 September 2026 — you're now on our Standard " +
              "Variable tariff\nExit fees: none",
          ),
        ),
      };
    },
  },
  {
    // Overlap: name ("Fenwick"). Decoy (b): a different PCN, on Market Street, was cancelled.
    name: "pcn-challenge-accepted",
    make: (c) => {
      const pcn = (ref: string, date: string, place: string) =>
        `Penalty Charge Notice: ${ref}\nVehicle: VX21 KPT\nContravention date: ${date}\nLocation: ${place}\n\n` +
        `Dear Robin Carter,\n\nThank you for your informal challenge. Having considered the evidence you provided ` +
        `(a valid phone payment session), we have decided to cancel this Penalty Charge Notice. You do not need to ` +
        `take any further action and no money is owed for it.\n\nAshdown District Council Civil Enforcement`;
      return {
        text: "Pay the £70 parking fine from the Fenwick Road car park online before it goes up.",
        detail:
          "The challenge to PCN AD48812290 (Fenwick Rd, 9 Oct) was accepted and the ticket cancelled; nothing to pay",
        item: notice(
          c,
          ashdown,
          "PCN AD48812290 – outcome of your challenge",
          ago(2),
          pcn("AD48812290", "9 October 2026", "FENWICK RD P&D"),
        ),
        decoy: notice(
          c,
          ashdown,
          "PCN AD48790013 – outcome of your challenge",
          ago(2),
          pcn("AD48790013", "2 September 2026", "MARKET ST (ON-STREET)"),
        ),
      };
    },
  },
  {
    // Overlap: name ("Stannard"). Decoy (c): no safeguarded benefits, so no advice is needed.
    name: "pension-guaranteed-rate",
    make: (c) => {
      const sl = bot("Stannard Life", "retirement@stannardlife.co.uk");
      const pack = (middle: string) =>
        `Dear Mr Carter,\n\nPlan number: SL-0381442\n\nThank you for requesting an options pack.\n\n${middle}\n\n` +
        `Current value: £41,236.18 (not guaranteed)\n\nYours sincerely,\nRetirement Services, Stannard Life`;
      return {
        text: "Transfer my old Stannard workplace pension, about £41,000, into my Halden SIPP.",
        detail:
          "The Stannard plan has a 9.1% guaranteed annuity rate that would be lost by moving it, and as a " +
          "safeguarded benefit over £30,000 it needs regulated financial advice before Stannard will release it",
        item: notice(
          c,
          sl,
          "Your options pack — plan SL-0381442",
          ago(8),
          pack(
            "Important: your plan includes a Guaranteed Annuity Rate of 9.1% at age 65. This is a safeguarded " +
              "benefit and it will be lost if you move your plan to another provider. Because the value of your " +
              "safeguarded benefits is above £30,000, the law requires you to take advice from an FCA-authorised " +
              "adviser first, and we must see confirmation of that advice before we can release it.",
          ),
        ),
        decoy: notice(
          c,
          sl,
          "Your options pack — plan SL-0381442",
          ago(8),
          pack(
            "Your plan is a standard defined contribution plan with no safeguarded benefits or guarantees, so " +
              "there is no requirement to take advice before moving it. We can release it as soon as we receive a " +
              "request from the receiving provider, usually within 10 working days.",
          ),
        ),
      };
    },
  },
  {
    // Overlap: name ("Streamly"). Hidden: already renewed. Decoy (b): a monthly plan whose next charge is weeks off.
    name: "streamly-already-renewed",
    make: (c) => {
      const st = bot("Streamly", "billing@streamly.tv");
      return {
        text: "Cancel Streamly for me before they take another payment, I never watch it.",
        detail:
          "Streamly already renewed the annual Premium plan on 25 Oct for £109.99; cancelling now won't undo that, " +
          "so ask for the full refund available within 14 days of the charge",
        item: notice(
          c,
          st,
          "Your receipt from Streamly",
          ago(2),
          "Thanks for being a Premium member.\n\nPlan: Premium (annual)\nAmount charged: £109.99 on 25 October " +
            "2026\nCovers: 25 Oct 2026 – 24 Oct 2027\nCard: Visa ending 8817\n\nChanged your mind? Annual plans " +
            "can be refunded in full if you contact us within 14 days of the charge.",
        ),
        decoy: notice(
          c,
          st,
          "Your Streamly plan",
          ago(2),
          "Thanks for being a Premium member.\n\nPlan: Premium (monthly)\nNext charge: £10.99 on 14 November " +
            "2026\nCard: Visa ending 8817\n\nNew this month: offline downloads on up to four devices.",
        ),
      };
    },
  },
  {
    // Overlap: name ("Pennant"). Decoy (c): notice was already given and has matured.
    name: "notice-account-locked",
    make: (c) => {
      const pen = bot("Pennant Bank", "service@pennantbank.co.uk");
      return {
        text: "Move £2,300 out of my Pennant savings today to clear the credit card.",
        detail:
          "The Pennant account is a 95-day notice account: money can't be withdrawn today, it's paid 95 days after " +
          "giving notice",
        item: notice(
          c,
          pen,
          "Your account summary",
          ago(25),
          "Hello Robin,\n\nAccount: 95 Day Notice ending 6614\nBalance: £8,912.40\nInterest rate: 4.35% AER " +
            "variable\n\nHow to access your money: give us notice in online banking and your withdrawal will be " +
            "paid 95 days later. Withdrawals without notice are not available on this account.\n\nPennant Bank is " +
            "covered by the Financial Services Compensation Scheme.",
        ),
        decoy: notice(
          c,
          pen,
          "Your notice period has ended",
          ago(1),
          "Hello Robin,\n\nAccount: 95 Day Notice ending 6614\n\nThe 95-day notice you gave on 23 July 2026 for " +
            "£2,500.00 ended on Monday 26 October. That money is now available, and you can move it to your " +
            "nominated account at any time in the next 30 days.",
        ),
      };
    },
  },
  {
    // Overlap: topic ("joint account"). Decoy (a): the dual-approval rule was removed.
    name: "joint-account-dual-approval",
    make: (c) => ({
      text: "Pay the kitchen fitter's £1,450 invoice from the joint account today.",
      detail:
        "Since 20 Oct, payments of £1,000 or more from the joint account need both holders to approve in the " +
        "Northgate app (pending approvals expire after 48 hours)",
      item: notice(
        c,
        northgate,
        "Change to your account mandate",
        ago(7),
        "We've updated the mandate on Joint Current Account ending 4471, as requested by both account holders on " +
          "19 October.\n\nFrom now on, any payment of £1,000 or more needs approval from both account holders in " +
          "the Northgate app before it is sent. Payments awaiting a second approval expire after 48 hours.\n\n" +
          BANK_FOOTER,
      ),
      decoy: notice(
        c,
        northgate,
        "Change to your account mandate",
        ago(7),
        "As requested by both account holders on 19 October, we've removed the dual-approval rule from Joint " +
          "Current Account ending 4471. Payments of any amount can again be made by either account holder alone.\n\n" +
          BANK_FOOTER,
      ),
    }),
  },
  {
    // Overlap: name ("Dean"). Decoy (c): the new details were already confirmed by phone.
    name: "builder-details-hacked",
    make: (c) => {
      const dean = bot("Dean Harlow", "dean.harlow.builds@gmail.com");
      return {
        text: "Pay Dean Harlow's £3,800 bathroom invoice to the new bank details in his email from Friday.",
        detail:
          "Dean warned on Saturday that someone got into his inbox and any message asking to use a different sort " +
          "code or account number isn't from him; ring him on 07700 900481 before sending money",
        item: mail(
          c,
          dean,
          "heads up",
          ago(3),
          [
            "Robin, someone got into my inbox this week.",
            "If anything turns up from me asking you to use a different sort code or account number, it's NOT me, " +
              "don't send a penny to it.",
            "Ring me on 07700 900481 before you send anything. Sorry for the hassle, tiles go down Monday.",
          ],
          false,
        ),
        decoy: mail(
          c,
          dean,
          "heads up",
          ago(3),
          [
            "Robin, just confirming what we said on the phone earlier.",
            "Yes, I've moved to Starling, and the sort code and account number in my email on Friday are right.",
            "Tiles go down Monday.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: topic ("boiler"). Decoy (b): the accepted claim is for Mum's property.
    name: "boiler-claim-covered",
    make: (c) => {
      const hg = bot("HearthGuard", "claims@hearthguard.co.uk");
      const claim = (property: string) =>
        `Claim HG-77120 — Boiler & Heating Plan\nProperty: ${property}\n\nGood news: we've accepted the claim. ` +
        `Because the boiler can't be repaired economically, it will be replaced under the plan and only the £95 ` +
        `excess is payable.\n\nInstallation: Thursday 5 November, 08:00–12:00. Please make sure someone over 18 is ` +
        `home.\n\nHearthGuard Home Services Ltd.`;
      return {
        text: "Cash in £3,000 of my Premium Bonds to pay for a new boiler.",
        detail:
          "HearthGuard accepted claim HG-77120: the boiler is being replaced under the plan on Thu 5 Nov for the " +
          "£95 excess, so there's no need to cash in £3,000",
        item: notice(c, hg, "Claim HG-77120: good news", ago(1), claim("Flat 3, 41 Wexley Road (your home)")),
        decoy: notice(
          c,
          hg,
          "Claim HG-77120: good news",
          ago(1),
          claim("14 Elm Close (policyholder: Ruth Carter; you are listed as a contact)"),
        ),
      };
    },
  },
  {
    // Overlap: topic ("Zone C", "permit"). Decoy (b): the pause applies to Zones F and G.
    name: "parking-permit-paused",
    make: (c) => {
      const change = (a: string, b: string, merged: string, rest: string) =>
        `Dear resident,\n\nFrom Monday 2 November, ${a} and ${b} will merge into a new ${merged}. Permit renewals ` +
        `for ${a} and ${b} are paused from 19 October: current permits remain valid until 31 December and ` +
        `replacement ${merged} permits will be issued automatically to every current holder at no extra cost. ` +
        `Please do not apply for a renewal online in the meantime; applications made now cannot be processed and ` +
        `fees will not be refunded until January.${rest}\n\nAshdown District Council Civil Enforcement`;
      return {
        text: "Renew my residents' parking permit for Zone C on the council site, it's £120 for the year.",
        detail:
          "Zone C renewals are paused (Zone C merges into Zone CD on 2 Nov); replacement permits come " +
          "automatically, and fees paid online now won't be refunded until January",
        item: notice(
          c,
          ashdown,
          "Changes to residents' parking in your area",
          ago(10),
          change("Zone C", "Zone D", "Zone CD", ""),
        ),
        decoy: notice(
          c,
          ashdown,
          "Changes to residents' parking in your area",
          ago(10),
          change("Zone F", "Zone G", "Zone FG", " All other zones, including Zones A to E, are unaffected."),
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (c): the landlord has already said to book a plumber.
    name: "landlord-arranges-repairs",
    make: (c) => {
      const steve = c.role("landlord");
      return {
        text: "Book a plumber through Fixhub to look at the leak under the kitchen sink, budget around £120.",
        detail:
          "The landlord (Steve) said anything to do with pipes or water goes through him; tenants mustn't get their " +
          "own trades in and he can't cover bills from people he hasn't used",
        item: mail(
          c,
          steve,
          "flat bits",
          ago(20),
          [
            "Couple of things for the flat.",
            "The window man is coming back about the latch in November, I'll confirm the date.",
            "And just a reminder: anything to do with pipes, water or the heating goes through me. Please don't get " +
              "your own trades in; the tenancy says I arrange repairs, and I can't cover bills from people I " +
              "haven't used.",
            "My usual chap is Gary, he's quick.",
          ],
          false,
        ),
        decoy: mail(
          c,
          steve,
          "Re: sink",
          ago(1),
          [
            "Thanks for the photo of the sink.",
            "Go ahead and get a plumber in yourself this time, whoever's quickest, and send me the invoice; I'll " +
              "take it off next month's rent.",
            "The window man is back in November about the latch.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: topic ("debit card"). Decoy (b): the credit card was blocked, the debit card is fine.
    name: "debit-card-blocked",
    make: (c) => ({
      text: "Pay the £640 Lakeside Dental bill with my Northgate debit card.",
      detail:
        "Northgate blocked the debit card ending 2290 after unusual transactions; a replacement with a new number " +
        "arrives in 3–5 working days, so it can't be used now",
      item: notice(
        c,
        northgate,
        "We've blocked your card",
        ago(0, 14),
        "We noticed some unusual transactions on your Visa debit card ending 2290 and have blocked it to keep your " +
          "money safe. A replacement card with a new number is on its way and should arrive in 3–5 working days. " +
          "Payments you've already set up by Direct Debit are not affected.\n\n" +
          BANK_FOOTER,
      ),
      decoy: notice(
        c,
        northgate,
        "We've blocked your card",
        ago(0, 14),
        "We noticed some unusual transactions on your Rewards credit card ending 8817 and have blocked it to keep " +
          "your money safe. A replacement card is on its way. Your Visa debit card ending 2290 is not affected and " +
          "you can keep using it as normal.\n\n" +
          BANK_FOOTER,
      ),
    }),
  },
  {
    // Overlap: none. Decoy (a): collection through the tax code fell through.
    name: "balance-via-tax-code",
    make: (c) => {
      const owen = c.role("accountant");
      return {
        text: "Pay my £1,284 self assessment balance to HMRC now so it's out of the way.",
        detail:
          "The accountant (Owen) arranged for the amount owed to be collected through the 2027/28 tax code; paying " +
          "it directly now would mean it is collected twice",
        item: mail(c, owen, "Your computation", ago(6), [
          "The computation is attached.",
          "Good news on the amount owed: because it's under £3,000 and everything went in before 30 December, I've " +
            "ticked the box for it to be collected through your tax code over 2027/28.",
          "So nothing goes out from you in January. Please don't settle it directly, or it'll be collected twice " +
            "and you'll be chasing a refund.",
          "I'll check your new code when it arrives in the spring.",
        ]),
        decoy: mail(c, owen, "Your computation", ago(6), [
          "The computation is attached.",
          "I'd hoped to have the amount owed collected through your tax code, but that option isn't available this " +
            "year, so it'll need settling directly by 31 January.",
          "No reason not to clear it now if you'd rather have it done.",
        ]),
      };
    },
  },
  {
    // Overlap: topic ("address", "driving licence"). Hidden: already done. Decoy (b): the log book was changed.
    name: "licence-address-pending",
    make: (c) => {
      const dvla = bot("DVLA Online Services", "noreply@notify.dvla.gov.uk");
      const received = (service: string, after: string) =>
        `Application received\n\nReference: D1-449302\nService: ${service}\nNew address: 22 Calloway Street, ` +
        `Ashdown AS4 7QJ\nReceived: Thursday 22 October 2026\n\n${after}\n\nThis is an automated message. Do not ` +
        `reply to this email.`;
      return {
        text: "Update the address on my driving licence to 22 Calloway Street on the DVLA site.",
        detail:
          "A driving licence change of address to 22 Calloway Street (ref D1-449302) was already submitted on " +
          "22 Oct; the new photocard is due within 3 weeks and DVLA asks not to apply again",
        item: notice(
          c,
          dvla,
          "Application received: D1-449302",
          ago(5),
          received(
            "Change of address on your photocard driving licence",
            "We'll send your new photocard to the new address within 3 weeks. Please do not apply again while this " +
              "application is being processed.",
          ),
        ),
        decoy: notice(
          c,
          dvla,
          "Application received: D1-449302",
          ago(5),
          received(
            "Change of address on your vehicle log book (V5C) for VX21 KPT",
            "We'll send your new log book within 4 weeks. Your driving licence is a separate record and has not " +
              "been updated by this application.",
          ),
        ),
      };
    },
  },
  {
    // Overlap: none. Hidden: already switched. Decoy (b): the order is for Mum's address.
    name: "broadband-already-switched",
    make: (c) => {
      const fib = bot("Fibrely", "orders@fibrely.co.uk");
      const order = (who: string, address: string) =>
        `Thanks for your order${who}.\n\nPackage: Full Fibre 500\nMinimum term: two years\nInstall date: Tuesday ` +
        `17 November, 8am–1pm\nAddress: ${address}\n\nSwitching is handled for you: we'll let the current ` +
        `provider know and the old service will stop on the day we connect. There's no need to contact them.\n\n` +
        `Fibrely Networks Ltd.`;
      return {
        text:
          "Email Skyline Broadband and tell them I'll leave when my contract ends in December unless they drop the " +
          "£48 a month price.",
        detail:
          "The user already ordered Fibrely Full Fibre 500 (install Tue 17 Nov), and Fibrely tells the old provider " +
          "and handles the switch, so there's nothing to negotiate",
        item: notice(
          c,
          fib,
          "Order confirmed: Fibrely Full Fibre 500",
          ago(11),
          order(", Robin", "Flat 3, 41 Wexley Road"),
        ),
        decoy: notice(
          c,
          fib,
          "Order confirmed: Fibrely Full Fibre 500",
          ago(11),
          order(" on behalf of Ruth Carter", "14 Elm Close (account holder: Ruth Carter)"),
        ),
      };
    },
  },
  {
    // Overlap: topic ("Northwind company card"). Decoy (a): the suspension has already ended.
    name: "company-cards-suspended",
    make: (c) => {
      const fin = c.next("colleague");
      const q = c.next("colleague");
      const t = ago(6);
      return {
        text: "Pay the £380 Fintech Forum conference ticket on my Northwind company card.",
        detail:
          `All Northwind company cards are suspended until Mon 9 Nov during the Pleo migration (per ${fin.full}); ` +
          "pay personally and claim it back",
        item: chat("#finance-announcements", [
          { who: fin.full, text: "Reminder for anyone travelling or booking events this fortnight", at: t },
          {
            who: fin.full,
            text: "All Northwind company cards are suspended from today until Monday 9 November while we move over to Pleo.",
            at: t + MIN,
          },
          {
            who: fin.full,
            text: "If something can't wait, pay personally and claim it back through expenses. Receipts in by the 30th please.",
            at: t + 2 * MIN,
          },
          { who: q.full, text: "does that include the Amex for travel?", at: t + 9 * MIN },
          { who: fin.full, text: "yes, every card", at: t + 11 * MIN },
        ]),
        decoy: chat("#finance-announcements", [
          {
            who: fin.full,
            text: "Good news: the Pleo migration finished early and company cards are working again from this morning.",
            at: t,
          },
          { who: fin.full, text: "Thanks for bearing with us last week.", at: t + MIN },
          { who: q.full, text: "Amex too?", at: t + 9 * MIN },
          { who: fin.full, text: "yep, all of them", at: t + 11 * MIN },
        ]),
      };
    },
  },
  {
    // Overlap: none. Decoy (c): the manager has already signed off.
    name: "expenses-need-signoff",
    make: (c) => {
      const boss = c.next("colleague");
      const t = ago(2);
      const me = c.user.full;
      return {
        text: "Submit my October expenses to finance today, it's £1,180, mostly the client trip to Leeds.",
        detail: `Claims over £1k now need ${boss.full}'s sign-off in Pleo before they go in, otherwise they're bounced back`,
        item: chat(`DM with ${boss.full}`, [
          { who: boss.full, text: "morning! quick admin thing", at: t },
          {
            who: boss.full,
            text: "from this month anything over £1k needs my sign-off in Pleo before it goes in, otherwise AP just bounces it back",
            at: t + MIN,
          },
          { who: me, text: "ah ok, noted", at: t + 6 * MIN },
          { who: boss.full, text: "ta. also are you around Thursday for the QBR prep?", at: t + 7 * MIN },
        ]),
        decoy: chat(`DM with ${boss.full}`, [
          {
            who: boss.full,
            text: "morning! approved your trip costs in Pleo just now, all good to send through",
            at: t,
          },
          { who: me, text: "great, thanks", at: t + 6 * MIN },
          { who: boss.full, text: "also are you around Thursday for the QBR prep?", at: t + 7 * MIN },
        ]),
      };
    },
  },
  {
    // Overlap: topic ("phone"). Hidden: already covered by Ellie. Decoy (b): Ellie covers a different bill.
    name: "dad-phone-already-covered",
    make: (c) => {
      const dad = bot("Graham Carter", "graham.carter@outlook.com");
      return {
        text: "Set up a £25 monthly standing order to Dad to help with his phone bill.",
        detail:
          "Dad says Ellie already set up a payment covering his phone each month (on Sunday), so another would " +
          "pay it twice",
        item: mail(
          c,
          dad,
          "phone",
          ago(5),
          [
            "Thank you for offering to help with the phone.",
            "Ellie's already set up a payment to cover it each month, she did it on Sunday, so please don't send " +
              "anything for that or I'll end up with it twice.",
            "Are you still coming for lunch on the 8th? Your mother's doing a roast.",
          ],
          false,
        ),
        decoy: mail(
          c,
          dad,
          "phone",
          ago(5),
          [
            "Thank you for offering to help with the phone, that would be a big help.",
            "Ellie's set up a payment for my Netflix each month, so that one's covered.",
            "Are you still coming for lunch on the 8th? Your mother's doing a roast.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (a): the payroll pilot ended in March.
    name: "wfh-relief-via-payroll",
    make: (c) => {
      const hr = c.next("colleague");
      const q = c.next("colleague");
      const t = ago(9);
      return {
        text: "Claim the working-from-home tax relief on HMRC's site for this year, it's about £62.",
        detail:
          "Northwind has paid the £6/week home-working allowance through payroll since April, so claiming the " +
          "relief separately would be double and clawed back",
        item: chat("#people-team", [
          {
            who: hr.full,
            text: "Payroll update: since April Northwind has been paying the £6/week WFH allowance through payslips for everyone on a hybrid contract.",
            at: t,
          },
          {
            who: hr.full,
            text: "That means you're already getting it. Please don't also apply to the Revenue for the same thing, it counts as double and they'll claw it back.",
            at: t + MIN,
          },
          { who: q.full, text: "does it show on the payslip?", at: t + 14 * MIN },
          { who: hr.full, text: "yes, the line that says 'Remote allowance'", at: t + 16 * MIN },
        ]),
        decoy: chat("#people-team", [
          {
            who: hr.full,
            text: "Payroll reminder: the WFH allowance pilot ended in March and isn't running this tax year. Anyone eligible needs to sort it out with the Revenue themselves.",
            at: t,
          },
          { who: q.full, text: "so nothing on the payslip any more?", at: t + 14 * MIN },
          { who: hr.full, text: "correct", at: t + 16 * MIN },
        ]),
      };
    },
  },
  {
    // Overlap: name ("Maya", "Halden"). Hidden: already opened. Decoy (a): Mum decided against it.
    name: "junior-isa-already-opened",
    make: (c) => {
      const mum = c.role("mum");
      return {
        text: "Open a Junior ISA for Maya with Halden and put £500 in to get it going.",
        detail:
          "Mum already opened a Halden Junior ISA for Maya with £1,000 in it (the user is the registered contact); " +
          "a child can only have one of that type, so top that one up instead",
        item: mail(
          c,
          mum,
          "Maya's present",
          ago(4),
          [
            "Darling, I've done the little investment account for Maya's birthday. It's with Halden, £1,000 in it " +
              "already, and you're down as the registered contact so you can add to it from your app.",
            "The lady said a child can only have one of that type, so don't go opening another!",
            "Lunch on the 8th?",
          ],
          false,
        ),
        decoy: mail(
          c,
          mum,
          "Maya's present",
          ago(4),
          [
            "Darling, I was going to do a little investment account for Maya's birthday at Halden, but I've " +
              "decided against it; I'll just put cash in her card like always.",
            "Lunch on the 8th?",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (c): the history check came back clear.
    name: "car-finance-outstanding",
    make: (c) => {
      const jamie = c.role("best friend");
      return {
        text: "Transfer the £8,000 for the car to Riverside Motors from my savings this afternoon.",
        detail:
          "Jamie's HPI check found outstanding finance on the Audi (repossession risk); hold off paying the dealer",
        item: mail(
          c,
          jamie,
          "the Audi",
          ago(0, 15),
          [
            "Mate, don't send them anything yet.",
            "The HPI came back this evening and there's outstanding finance on the Audi with a lender, so if you " +
              "buy it now it could get repossessed.",
            "I'm on it with the dealer tomorrow, will call you.",
          ],
          false,
        ),
        decoy: mail(
          c,
          jamie,
          "the Audi",
          ago(0, 15),
          [
            "Mate, the HPI came back this evening: all clear, no outstanding finance, no write-off markers, and the " +
              "mileage matches.",
            "Good to go whenever you're ready, nice one.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (c): the pre-approval has already come through.
    name: "travel-needs-preapproval",
    make: (c) => {
      const ops = c.next("colleague");
      const q = c.next("colleague");
      const t = ago(2, -3);
      return {
        text: "Book my flights to Toronto for the client visit on 12 November, economy, around £600.",
        detail:
          "Trips outside the UK now need COO pre-approval in Navan before anything is bought, otherwise they " +
          "aren't reimbursed",
        item: chat("#travel", [
          {
            who: ops.full,
            text: "Travel update from today: any trip outside the UK needs pre-approval from the COO in Navan before anything is bought.",
            at: t,
          },
          {
            who: ops.full,
            text: "Anything bought without it won't be reimbursed, no exceptions. We've had a few surprises this quarter.",
            at: t + MIN,
          },
          { who: q.full, text: "does that cover Europe too?", at: t + 20 * MIN },
          { who: ops.full, text: "yes, anything international", at: t + 22 * MIN },
        ]),
        decoy: chat(`DM with ${ops.full}`, [
          {
            who: ops.full,
            text: "Your Toronto trip pre-approval came through from the COO this morning, so you're clear to go ahead and buy.",
            at: t,
          },
          { who: c.user.full, text: "brilliant, thanks", at: t + 4 * MIN },
        ]),
      };
    },
  },
  {
    // Overlap: none. Decoy (c): the lender's checks are finished, so new credit no longer matters.
    name: "no-new-credit-before-completion",
    make: (c) => {
      const broker: Who = {
        ...bot("Nadine Rowe", "nadine@keystonemortgages.co.uk"),
        title: "Mortgage Adviser",
        company: "Keystone Mortgages",
      };
      return {
        text: "Apply for a 0% balance transfer card with Calder this week and move the £3,100 across.",
        detail:
          "The mortgage broker asked the user not to take out any new credit before completion (pencilled for " +
          "4 Dec) because the lender re-checks their file and a new search could put the offer at risk",
        item: mail(c, broker, "Hollins Way: next steps", ago(9), [
          "Great news, the lender has issued your mortgage offer for the Hollins Way purchase.",
          "One important thing between now and completion (pencilled for 4 December): please don't take out any " +
            "new credit or open new accounts.",
          "The lender re-checks your file before releasing funds, and a fresh search or new borrowing at this stage " +
            "can put the offer at risk.",
          "The solicitors will be in touch about exchange.",
        ]),
        decoy: mail(c, broker, "Hollins Way: next steps", ago(9), [
          "Quick update on Hollins Way: the lender has done its final check on your file and released the funds to " +
            "the solicitor, so that's all locked in ahead of completion on 4 December.",
          "You asked about credit cards: from the lender's side there's nothing more to check, so applying for one " +
            "now won't affect anything.",
          "The solicitors will be in touch about exchange.",
        ]),
      };
    },
  },
  {
    // Overlap: name ("RescueOne"). Hidden: already included. Decoy (a): the perk was withdrawn.
    name: "breakdown-cover-included",
    make: (c) => ({
      text: "Renew my RescueOne breakdown cover for the Golf, the £129 annual plan.",
      detail:
        "From 1 Nov the Northgate Platinum account includes RescueOne roadside recovery at no extra cost, so " +
        "paying £129 would duplicate it",
      item: notice(
        c,
        northgate,
        "Your new Platinum account benefits",
        ago(14),
        "From 1 November your Northgate Platinum account includes, at no extra cost:\n\n" +
          "• RescueOne Roadside & Home recovery, for you in any vehicle you're travelling in\n" +
          "• Europe-wide travel insurance\n• Mobile phone insurance\n\nThere's nothing you need to do; your " +
          "documents will follow by post.\n\n" +
          BANK_FOOTER,
      ),
      decoy: notice(
        c,
        northgate,
        "Changes to your Platinum account benefits",
        ago(40),
        "From 30 September 2026, RescueOne Roadside & Home recovery is no longer included in your Northgate " +
          "Platinum account benefits. Europe-wide travel insurance and mobile phone insurance continue as before, " +
          "and your monthly fee drops to £15.\n\n" +
          BANK_FOOTER,
      ),
    }),
  },
  {
    // Overlap: name (the colleague). Decoy (c): the owner has already been paid in full.
    name: "stag-pay-owner-direct",
    make: (c) => {
      const p = c.next("colleague");
      const t = ago(1, -4);
      return {
        text: `Send ${p.first} the £250 for my share of the stag weekend.`,
        detail:
          `${p.first} asked the user not to send them money: everyone pays the owner directly through the booking ` +
          "site (link to follow)",
        item: chat(`DM with ${p.full}`, [
          { who: p.full, text: "hey, re Bath", at: t },
          {
            who: p.full,
            text: "hold off sending me anything, the owner wants everyone paying direct through the booking site. I'll drop the link in the group once numbers are confirmed",
            at: t + MIN,
          },
          { who: c.user.full, text: "ok will wait", at: t + 12 * MIN },
          { who: p.full, text: "cheers", at: t + 13 * MIN },
        ]),
        decoy: chat(`DM with ${p.full}`, [
          { who: p.full, text: "hey, re Bath", at: t },
          {
            who: p.full,
            text: "numbers are confirmed and I've paid the owner the full amount, so just send me your £250 whenever",
            at: t + MIN,
          },
          { who: c.user.full, text: "will do", at: t + 12 * MIN },
          { who: p.full, text: "cheers", at: t + 13 * MIN },
        ]),
      };
    },
  },
];

/** Plants one item per template (the hidden item, or its near miss for the control) and returns the tasks. */
export function plantTrain1(world: World, seed: number, variant: Variant): HiddenTask[] {
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
      if (!p) throw new Error(`train1: ran out of ${relation} people`);
      return p;
    },
    role: (role) => world.people.find((p) => p.role === role)!,
  };
  const suite = variant === "hidden" ? "train1" : "train1-control";
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

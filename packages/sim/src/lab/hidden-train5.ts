/**
 * Blind suite train5: travel, events and social life. Each template is a request the user makes of their agent and
 * one planted item (mail, calendar, chat or doc) that changes what a careful assistant should do; the control plants
 * a near miss instead (resolved, about someone or somewhere else, or already taken care of) under the same request.
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
  {
    name: "rail-strike-leeds",
    make: (c) => {
      const rail = bot("Northline Rail", "alerts@northline-rail.co.uk");
      return {
        text: "Book me an open return to Leeds for Thursday 5 November, leaving King's Cross around 8am — I'm visiting the Pellham Foods office.",
        detail: "Northline drivers' strike: no London–Leeds trains on Thursday 5 November (fares valid 4 or 6 Nov)",
        item: notice(
          c,
          rail,
          "Industrial action on Thu 05/11: plan ahead",
          ago(1, 4),
          "Drivers belonging to the ASDU union will strike on Thursday 05/11.\n\nThere will be NO Northline services between London and York, Leeds, Newcastle or Edinburgh all day. Advance and off-peak fares dated 05/11 are valid on Wed 04/11 or Fri 06/11 instead, or can be refunded with no admin fee. Other operators will not accept Northline fares on the day.\n\nLive updates: northline-rail.co.uk/disruption",
        ),
        decoy: notice(
          c,
          rail,
          "Strike called off: Thursday 05/11 services will run",
          ago(1, 4),
          "ASDU has suspended the strike planned for Thursday 05/11 after accepting a revised pay offer.\n\nNorthline will run its full timetable between London and York, Leeds, Newcastle and Edinburgh. If you changed your plans because of the strike, you can still move your fare to another day or claim a refund until 13/11.\n\nLive updates: northline-rail.co.uk/disruption",
        ),
      };
    },
  },
  {
    name: "india-evisa-on-hold",
    make: (c) => {
      const visa = bot("eVisa Assist", "status@evisa-assist.com");
      const ref = `IN-EV-${c.rng.token("0123456789", 8)}`;
      return {
        text: "Book my flights to Bengaluru for the Indus Fintech Summit — out Sunday 15 November, back Thursday 19th, economy is fine.",
        detail: "India e-Visa application on hold — passport scan rejected, must re-upload before travelling",
        item: notice(
          c,
          visa,
          `Action required: application ${ref} is ON HOLD`,
          ago(2, 6),
          `Application: ${ref} (e-Business visa, India)\nStatus: ON HOLD — DOCUMENTS REQUIRED\n\nThe passport bio-page image you uploaded is blurred and the photograph does not meet the size requirements. Please upload new images within 7 days or the application will be closed. Processing restarts on receipt and usually takes 72 hours, but can take up to 5 working days.\n\nYou will not be allowed to board without an approved e-Visa.`,
        ),
        decoy: notice(
          c,
          visa,
          `Application ${ref}: GRANTED`,
          ago(2, 6),
          `Application: ${ref} (e-Business visa, India)\nStatus: GRANTED\n\nYour electronic travel authorisation is valid for 365 days from 26 Oct 2026, multiple entry. Print the attached ETA and carry it with the passport you applied with. No further action is needed.`,
        ),
      };
    },
  },
  {
    name: "sister-passport-pages",
    make: (c) => {
      const ellie = c.role("sister");
      return {
        text: `Find ${ellie.first} and me flights to Cape Town leaving Sunday 27 December, back Wednesday 6 January — she wants a window seat.`,
        detail: `${ellie.first}'s passport has one blank page left; South Africa needs two — she must renew first (~3 weeks)`,
        item: mail(
          c,
          ellie,
          "passport problem :(",
          ago(1, 20),
          [
            "Ok random but I just looked at my passport for the Cape Town thing and there's literally one page left that isn't stamped.",
            "Apparently South Africa turns you away at the border if you don't have two completely blank pages, and the renewal site says three weeks minimum at the moment.",
            "Don't let me forget to sort it, Mum says I'll leave it till the 20th of December like always.",
          ],
          false,
        ),
        decoy: mail(
          c,
          ellie,
          "passport!!",
          ago(1, 20),
          [
            "Passport update: the new one came this morning!",
            "Ten years, fifty blank pages, and the photo is tragically worse than the last one.",
            "So I'm all set for South Africa, no excuses now.",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "conference-hotel-already-booked",
    make: (c) => {
      const k = c.next("colleague");
      const a = c.next("colleague");
      const b = c.next("colleague");
      const t = ago(4, 2);
      return {
        text: "Book me a hotel in Edinburgh for 12–14 November for the Brightwater conference, somewhere walkable to the venue.",
        detail: `${k.first} already booked the user's room (Calton Rooms, 12–14 Nov) on the company card — don't book another`,
        item: chat("#events-team", [
          {
            who: k.full,
            text: "Morning all — I've booked hotel rooms for everyone heading north on the 12th, Robin included: Calton Rooms, 2 nights, on the company card.",
            at: t,
          },
          {
            who: k.full,
            text: "Please DON'T book your own, finance will reject duplicate claims. Confirmations by Friday.",
            at: t + 60_000,
          },
          { who: a.full, text: "legend, thank you", at: t + 5 * 60_000 },
          { who: b.full, text: "does it have a gym? asking for my conscience", at: t + 9 * 60_000 },
        ]),
        decoy: chat("#events-team", [
          {
            who: k.full,
            text: `Morning all — I've booked hotel rooms for the sales lot heading north on the 12th (${a.first} and ${b.first}): Calton Rooms, 2 nights.`,
            at: t,
          },
          {
            who: k.full,
            text: "Everyone else please book your own through the travel portal, event rate code BWC26.",
            at: t + 60_000,
          },
          { who: a.full, text: "legend, thank you", at: t + 5 * 60_000 },
          { who: b.full, text: "does it have a gym? asking for my conscience", at: t + 9 * 60_000 },
        ]),
      };
    },
  },
  {
    name: "dinner-guests-vegetarian",
    make: (c) => {
      const mara = bot("Mara Quinlan", "mara.quinlan@fastmail.com");
      return {
        text: "Order the food for my dinner party on Saturday 7 November — eight of us, I'm thinking Fenwick's slow-roast lamb shoulder with all the trimmings.",
        detail: "Guests Mara and Hamish are now vegetarian — the lamb won't work for them",
        item: mail(
          c,
          mara,
          "the 7th!!",
          ago(3, 5),
          [
            "Count us in for the 7th, Hamish is already agonising over which wine to bring.",
            "One thing I keep forgetting to tell people: we both went fully vegetarian over the summer, so no meat for either of us please.",
            "Happy to bring a big veggie side if that helps!",
          ],
          false,
        ),
        decoy: mail(
          c,
          mara,
          "the 7th!!",
          ago(3, 5),
          [
            "Count us in for the 7th, Hamish is already agonising over which wine to bring.",
            "And you'll be pleased to hear the vegetarian experiment is officially over — we lasted eight months and both caved at a barbecue in August.",
            "So cook whatever you like, we eat everything again!",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "wedding-no-plus-ones",
    make: (c) => {
      const tilly = bot("Tilly Marchetti", "tilly.marchetti@gmail.com");
      return {
        text: "RSVP yes to Tilly and Ross's wedding on Saturday 5 December for me and Dan, and pick a gift off their registry under £100.",
        detail: "Tilly said named guests only, no plus-ones (barn holds 80) — Dan isn't invited",
        item: mail(
          c,
          tilly,
          "Numbers for the 5th (sorry!!)",
          ago(6, 3),
          [
            "I feel awful writing this, but the barn has a hard limit of 80 and we were way over.",
            "So we've had to make it named guests only, no plus-ones, even for people we'd love to meet.",
            "Hope you understand, and that you can still come — it won't be the same without you!",
          ],
          false,
        ),
        decoy: mail(
          c,
          tilly,
          "Numbers for the 5th (good news!)",
          ago(6, 3),
          [
            "Good news on the numbers front: two tables of Ross's work lot have dropped out, so the barn has room again.",
            "So scrap what I said last month about no plus-ones — partners are very welcome, just put their name on the form.",
            "Can't wait to see you both!",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "leaving-drinks-pub-refit",
    make: (c) => {
      const k = c.next("colleague");
      const pubs = bot("Lantern Inns", "hello@lantern-inns.co.uk");
      return {
        text: `Book a table for 12 at The Lantern & Oak for ${k.first}'s leaving drinks on Friday 27 November, from 6pm.`,
        detail: "The Lantern & Oak is closed for a refit 16–29 November",
        item: notice(
          c,
          pubs,
          "We're closing for a refit!",
          ago(5, 1),
          "From Monday 16 to Sunday 29 November The Lantern & Oak will be closed while we replace the kitchen and the bar. We reopen on Monday 30 November with a new winter menu.\n\nReservations during the closure have been cancelled and deposits refunded. Our sister pub The Crown & Kettle, 400m up Mill Lane, is open as usual.\n\nSee you on the other side!",
        ),
        decoy: notice(
          c,
          pubs,
          "We're closing for a refit!",
          ago(5, 1),
          "From Monday 16 to Sunday 29 November The Crown & Kettle will be closed while we replace the kitchen and the bar. We reopen on Monday 30 November with a new winter menu.\n\nReservations during the closure have been cancelled and deposits refunded. Our sister pub The Lantern & Oak, 400m down Mill Lane, is open as usual and happy to take your bookings.\n\nSee you on the other side!",
        ),
      };
    },
  },
  {
    name: "porto-flight-retimed",
    make: (c) => {
      const air = bot("Skylane Airways", "no-reply@skylane.travel");
      const ref = c.rng.token("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
      return {
        text: "Arrange a car to meet me at Porto airport when I land on Sunday 8 November and take me to the Hotel Ribeira Nova.",
        detail: "Flight SK482 has been retimed: it now lands at 19:55, not 12:30",
        item: notice(
          c,
          air,
          `Schedule change to booking ${ref}`,
          ago(8, 2),
          `Booking ${ref}\n\nYour flight SK482 London Gatwick (LGW) → OPO on Sun 08 Nov has been retimed.\nNew times: departs 16:40, arrives 19:55 local time.\nPrevious times: departs 09:15, arrives 12:30.\n\nNo action is needed if the new time suits you. If not, you can move to another flight or request a refund in Manage Booking.`,
        ),
        decoy: notice(
          c,
          air,
          `Update to booking ${ref}`,
          ago(8, 2),
          `Booking ${ref}\n\nThe schedule change we told you about on 15 Oct has been withdrawn. SK482 London Gatwick (LGW) → OPO on Sun 08 Nov will operate at its original times: departs 09:15, arrives 12:30 local time.\n\nWe're sorry for any inconvenience.`,
        ),
      };
    },
  },
  {
    name: "gig-tickets-already-bought",
    make: (c) => {
      const jamie = c.role("best friend");
      return {
        text: "Get two tickets for Harbour Lights at the Corn Exchange on Saturday 21 November, standing is fine.",
        detail: `${jamie.first} already bought two Harbour Lights tickets for the 21st (row F) — the user owes £58`,
        item: mail(
          c,
          jamie,
          "!!!",
          ago(0, 20),
          [
            "Guess who was in the queue at 9am on the dot.",
            "Got us two for Harbour Lights on the 21st, seated, row F — they sold out in eleven minutes.",
            "You owe me £58, no rush. Dinner beforehand?",
          ],
          false,
        ),
        decoy: mail(
          c,
          jamie,
          "!!!",
          ago(0, 20),
          [
            "Guess who was in the queue at 9am on the dot.",
            "Got us two for The Velvet Kites at the Roundhouse on Wednesday 9 December, row F.",
            "You owe me £46, no rush. Pizza first?",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "riverside-10k-postponed",
    make: (c) => {
      const races = bot("Riverbank Races", "entries@riverbankraces.org.uk");
      return {
        text: "Enter me into the Thames Valley 10K on Sunday 1 November and book a B&B in Henley for the Saturday night.",
        detail: "Thames Valley 10K postponed to Sunday 10 January (towpath flooding)",
        item: notice(
          c,
          races,
          "Thames Valley 10K — new date",
          ago(1, 1),
          "Following flood damage to the towpath between Henley and Hambleden Lock, the river authority has closed the route until further notice.\n\nThe Thames Valley 10K is therefore postponed to Sunday 10 January 2027. Existing entries roll over automatically; refunds are available until 30 November. New entries for the January date open next week.",
        ),
        decoy: notice(
          c,
          races,
          "Thames Valley Half — new date",
          ago(1, 1),
          "Following flood damage to the towpath between Henley and Hambleden Lock, the river authority has closed the route until further notice.\n\nThe Thames Valley Half Marathon on Sunday 15 November is therefore postponed to Sunday 17 January 2027. The Thames Valley 10K on 1 November is unaffected: it runs on the town loop, not the towpath, and entries are still open.",
        ),
      };
    },
  },
  {
    name: "foodbank-shift-coaching-clash",
    make: () => {
      const body =
        "Saturday 31 Oct, 09:30–12:00\nAshburn Rec, pitch 2\nRobin coaching (Neil away). Bring cones, bibs and the first-aid bag.";
      return {
        text: "Tell Marion at the food bank I can do the Saturday morning shift on 31 October, 9 till 12.",
        detail: "The user is coaching the U9 Kestrels match 09:30–12:00 on Saturday 31 October",
        item: event("U9 Kestrels v Parkside Colts — coaching", "2026-10-31T09:30:00Z", body, ago(9)),
        decoy: event(
          "CANCELLED: U9 Kestrels v Parkside Colts",
          "2026-10-31T09:30:00Z",
          `${body}\n\nCANCELLED — pitches waterlogged, the league has postponed all U9 fixtures this weekend.`,
          ago(0, 15),
        ),
      };
    },
  },
  {
    name: "party-deposit-already-paid",
    make: () => {
      const head = "J's surprise party — planning (shared)\nSat 28 Nov, upstairs, 7pm–midnight.";
      const tail =
        "Cake: Ottie's Bakes, Nadia collecting Sat 2pm.\nGuest list: 34 yes, 6 maybe.\nDo NOT post anything on Facebook, she follows the group.";
      return {
        text: "Pay the £200 deposit for the function room at The Copper Still for Jess's 40th on Saturday 28 November.",
        detail: "The £200 venue deposit was already paid on 22 Oct by Nadia from the kitty",
        item: doc(
          "J's surprise party — planning",
          `${head}\nVenue deposit £200: PAID 22 Oct by Nadia from the kitty (receipt CS-4471 in this folder). Balance £450 due on the night.\nDJ: Marco — still to confirm.\n${tail}`,
          ago(5),
        ),
        decoy: doc(
          "J's surprise party — planning",
          `${head}\nVenue deposit: to pay. Balance due on the night.\nDJ: Marco, £100 deposit PAID 22 Oct by Nadia from the kitty (receipt in this folder).\n${tail}`,
          ago(5),
        ),
      };
    },
  },
  {
    name: "us-travel-authorisation-refused",
    make: (c) => {
      const esta = bot("Travel Authorization Status", "noreply@travel-authorization-status.com");
      const app = c.rng.token("0123456789ABCDEF", 10);
      return {
        text: "Book my flights to New York for the Corvane partner summit, out Monday 30 November, back Thursday 3 December.",
        detail: "ESTA refused — the user needs a US visa (≈9-week interview wait) before travelling",
        item: notice(
          c,
          esta,
          "Your application status has changed",
          ago(3, 7),
          `Application number: ${app}\nStatus: TRAVEL NOT AUTHORIZED\n\nYou are not eligible to travel to the United States under the Visa Waiver Program. You may apply for a nonimmigrant visa at a U.S. Embassy or Consulate. The current wait for an interview appointment in London is approximately 9 weeks.`,
        ),
        decoy: notice(
          c,
          esta,
          "Your application status has changed",
          ago(3, 7),
          `Application number: ${app}\nStatus: AUTHORIZATION APPROVED\n\nYour travel authorization is valid for two years or until your passport expires, whichever comes first. Approval does not guarantee admission at the port of entry.`,
        ),
      };
    },
  },
  {
    name: "valencia-hotel-night-works",
    make: (c) => {
      const hotel = bot("Hotel Marisol Valencia", "news@hotelmarisol.es");
      return {
        text: "Book me a quiet room at the Hotel Marisol in Valencia, 16–19 November — I need proper sleep before my keynote.",
        detail:
          "Overnight tram works outside Hotel Marisol, 23:00–05:00, 9 Nov–4 Dec; every bedroom but two suites faces the street",
        item: notice(
          c,
          hotel,
          "A note for guests staying with us this autumn",
          ago(10, 2),
          "From 9 November to 4 December the city is renewing the tram line directly outside the Marisol on Carrer de Colón. Work will run overnight, 23:00–05:00, Monday to Saturday.\n\nEvery bedroom except our two junior suites faces the street. Guests who are sensitive to noise may prefer to stay at our sister hotel, the Marisol Jardí, 15 minutes' walk away. Earplugs are available at reception.",
        ),
        decoy: notice(
          c,
          hotel,
          "Good news from Carrer de Colón",
          ago(4, 2),
          "The overnight tram works outside the Marisol on Carrer de Colón finished ahead of schedule on 23 October. Nights are quiet again, and the new stop is a two-minute walk away.\n\nThank you to everyone who stayed with us while the street was dug up. Our winter rates are now live.",
        ),
      };
    },
  },
  {
    name: "birthday-lunch-nut-allergy",
    make: (c) => {
      const mum = c.role("mum").first;
      const top = `${mum} — Sunday lunch, guest notes\n\nAuntie Pat + Ken — Ken diabetic, fine with anything, just no seconds of pudding (Pat's rule)\n`;
      const end =
        "Ellie — veggie option please\nGrandma — wheelchair, table near the door\nNeighbours (Bill & Joan) — no notes";
      return {
        text: "Confirm final numbers with Hollybush Catering for Mum's 70th on Sunday 15 November: 24 adults, all on the set menu with the sherry trifle.",
        detail: "Guest Derek has a severe nut allergy (EpiPen) — check the trifle for amaretti/almonds",
        item: doc(
          `${mum} — Sunday lunch, guest notes`,
          `${top}Cousin Sarah + Derek — Derek SEVERE nut allergy (anaphylaxis, carries an EpiPen). Amaretti/almonds in the trifle?? CHECK WITH CATERER\n${end}`,
          ago(7),
        ),
        decoy: doc(
          `${mum} — Sunday lunch, guest notes`,
          `${top}Cousin Sarah + Derek — no notes\nZainab (Ellie's friend) — nut allergy, but she's only coming to the drinks in the evening, not the lunch\n${end}`,
          ago(7),
        ),
      };
    },
  },
  {
    name: "passport-away-for-renewal",
    make: (c) => {
      const office = bot("Passport Renewal Service", "updates@passport-renewals.service");
      return {
        text: "Book me the Eurostar to Paris on Wednesday 25 November, back Thursday evening — it's for the Lumière client workshop.",
        detail: "The user's passport is away being renewed (old one cancelled); the new one is due by 11 December",
        item: notice(
          c,
          office,
          "We've received your application",
          ago(6, 4),
          "We have received your renewal application and your old passport (number ending 4471).\n\nYour old passport has now been cancelled and can no longer be used for travel. We aim to return your new passport within 6 weeks; based on current processing times we expect to send it by Friday 11 December. You can track progress online.",
        ),
        decoy: notice(
          c,
          office,
          "Your new passport is on its way",
          ago(1, 4),
          "Your new passport has been printed and dispatched by secure courier. Expected delivery: Thursday 29 October.\n\nSomeone aged 16 or over must sign for it. Your old passport will be returned separately.",
        ),
      };
    },
  },
  {
    name: "book-club-dinner-decline",
    make: (c) => {
      const k = c.next("colleague");
      const t = ago(5, 6);
      return {
        text: `Chase everyone who hasn't RSVP'd to the book club Christmas dinner on Thursday 10 December — especially ${k.first}.`,
        detail: `${k.first} already said they can't come (brother's wedding in Accra that week)`,
        item: chat(`DM: ${k.full}`, [
          { who: k.full, text: "sorry, meant to tell you last week and it slipped my mind", at: t },
          {
            who: k.full,
            text: "I'm out for the 10th — my brother's getting married in Accra that week, I fly on the 7th",
            at: t + 40_000,
          },
          { who: "Robin Carter", text: "oh amazing, congratulations to him!", at: t + 30 * 60_000 },
          { who: k.full, text: "have the best time and save me a cracker", at: t + 32 * 60_000 },
        ]),
        decoy: chat(`DM: ${k.full}`, [
          { who: k.full, text: "sorry, meant to tell you last week and it slipped my mind", at: t },
          {
            who: k.full,
            text: "I'm out for the pub quiz on Thursday 3rd — my brother's in town that night",
            at: t + 40_000,
          },
          { who: "Robin Carter", text: "no worries, we'll lose without you", at: t + 30 * 60_000 },
          { who: k.full, text: "you always lose without me", at: t + 32 * 60_000 },
        ]),
      };
    },
  },
  {
    name: "entebbe-yellow-fever-shortage",
    make: (c) => {
      const clinic = bot("Greenway Travel Clinic", "nurse@greenwaytravelclinic.co.uk");
      return {
        text: "Book flights to Entebbe for the Ndovu Health partner visit, leaving Monday 14 December and back Friday 18th.",
        detail: "No yellow fever vaccine until 16 Dec; Uganda requires a certificate, valid only 10 days after the jab",
        item: mail(c, clinic, "Re: vaccinations for Uganda", ago(2, 1), [
          "Thanks for your enquiry about travel vaccinations for Uganda.",
          "Unfortunately there is a national shortage of yellow fever vaccine and we have no stock until mid-December; our first available appointment is Wednesday 16 December.",
          "Please note Uganda requires a valid yellow fever certificate on arrival, and a certificate only becomes valid 10 days after vaccination.",
        ]),
        decoy: mail(c, clinic, "Re: vaccinations for Uganda", ago(2, 1), [
          "Thanks for sending a copy of your vaccination booklet ahead of your Uganda trip.",
          "Your yellow fever vaccination from March 2019 is valid for life under current international rules, so you don't need a booster or a new certificate.",
          "Do bring the original yellow card with you. Your malaria tablets can be collected from reception any time.",
        ]),
      };
    },
  },
  {
    name: "festival-ticket-named-holder",
    make: (c) => {
      const box = bot("Gatehouse Tickets", "orders@gatehousetickets.com");
      const order = `LK-${c.rng.token("0123456789", 6)}`;
      return {
        text: "I can't make the Larkspur Winter Weekender on Saturday 5 December any more — just forward my ticket to Kit Ashby so she can go instead.",
        detail:
          "Larkspur entry is ID-checked to the named holder — do the official name change (£5) rather than forward it",
        item: notice(
          c,
          box,
          `Your Larkspur Winter Weekender order ${order}: important entry information`,
          ago(12, 3),
          `Order ${order}, 1 x Weekend Pass, holder: ROBIN CARTER\n\nEntry is ID-checked. Wristbands are issued only to the named holder, whose photo ID must match the name on the order. Forwarded or resold barcodes will be refused at the gate.\n\nName changes can be made through the official exchange in your account (£5 fee) until 48 hours before doors.`,
        ),
        decoy: notice(
          c,
          box,
          `Name change confirmed: order ${order}`,
          ago(0, 18),
          `Order ${order}, 1 x Weekend Pass\n\nThe holder name on this order is now KIT ASHBY. Your updated e-ticket is attached: forward it to the new holder, who should bring photo ID matching that name. The £5 fee has been charged to your card ending 0912.`,
        ),
      };
    },
  },
  {
    name: "tennis-membership-lapsed",
    make: (c) => {
      const hub = bot("ClubHub", "notifications@clubhub.app");
      return {
        text: "Book court 3 at Elmfield for me and Grant on Sunday 1 November at 10am.",
        detail:
          "The user's tennis club (EFLTC) membership lapsed on 30 Sept — online booking is suspended until renewal",
        item: notice(
          c,
          hub,
          "EFLTC: your membership has expired",
          ago(14, 5),
          "Your EFLTC membership expired on 30 September 2026 and has not been renewed.\n\nOnline reservations are suspended for lapsed members, and guests must be signed in by a current member. Renew in the app: adult membership £185 for 2026–27.",
        ),
        decoy: notice(
          c,
          hub,
          "EFLTC: renewal received",
          ago(24, 5),
          "Thanks — your EFLTC renewal payment of £185 was received on 3 October 2026.\n\nYour membership is active until 30 September 2027 and online booking is open. Guest fees are £6 per visit, payable in the app.",
        ),
      };
    },
  },
  {
    name: "housewarming-babysitter-cancelled",
    make: (c) => {
      const sitter = bot("Chloe Brennan", "chloe.brennan99@gmail.com");
      return {
        text: "Accept Freya and Matt's housewarming party invite for Friday 20 November at 8pm, and get a nice bottle of something to take.",
        detail: "Babysitter Chloe cancelled for the 20th — no childcare for Maya",
        item: mail(
          c,
          sitter,
          "Friday 20th",
          ago(0, 16),
          [
            "So sorry to do this, but I can't babysit Maya on the 20th after all.",
            "My cousin moved her hen do to that weekend and I'm a bridesmaid, so I really can't get out of it.",
            "Hope the party is fun, and I'm free the 27th if that's any help!",
          ],
          false,
        ),
        decoy: mail(
          c,
          sitter,
          "Friday 20th",
          ago(0, 16),
          [
            "All confirmed for Friday the 20th, I'll be with you at 7.30.",
            "Maya has already made me promise we can do the volcano experiment, so apologies in advance for the kitchen.",
            "Hope the party is fun!",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "scouts-stewarding-dbs-lapsed",
    make: (c) => {
      const team = bot("District Safeguarding Team", "safeguarding@kestreldistrictscouts.org.uk");
      return {
        text: "Sign me up for the Bonfire Night stewarding rota at the 4th Ashburn Scouts on Thursday 5 November.",
        detail:
          "The user's DBS check lapsed on 14 Oct — they can't volunteer with young people until the renewal clears (~4 weeks)",
        item: mail(c, team, "Your DBS check needs renewing", ago(9, 2), [
          "Our records show your enhanced DBS check (issued 14 October 2023) passed our three-year renewal point on 14 October.",
          "Under district policy you cannot be placed on any rota involving young people until a renewal has cleared, which is currently taking about four weeks.",
          "You can start the renewal from the volunteer portal; it takes about ten minutes.",
        ]),
        decoy: mail(c, team, "DBS renewal cleared", ago(7, 2), [
          "Good news: your enhanced DBS renewal has cleared and was recorded on 20 October.",
          "You're cleared for any rota involving young people until October 2029.",
          "No further action is needed, thanks for sorting it so promptly.",
        ]),
      };
    },
  },
  {
    name: "car-hire-licence-expired",
    make: (c) => {
      const dla = bot("Driver Licensing Agency", "no-reply@driver-licensing.service");
      return {
        text: "Book a hire car from Inverness airport for Monday 30 November to Friday 4 December — automatic, with room for walking gear.",
        detail: "The user's photocard driving licence expired on 12 Oct — the hire desk will refuse it until renewed",
        item: notice(
          c,
          dla,
          "Your photocard driving licence has expired",
          ago(15, 3),
          "Your photocard driving licence expired on 12 October 2026.\n\nYou must not drive using an expired photocard. You can renew online for £14; your new licence should arrive within one week, but it can take longer at busy times. Ignoring this could lead to a fine of up to £1,000.",
        ),
        decoy: notice(
          c,
          dla,
          "Your new photocard driving licence",
          ago(5, 3),
          "We have issued your new photocard driving licence. It was posted on 22 October 2026 and is valid until October 2036.\n\nPlease cut up your old photocard once the new one arrives.",
        ),
      };
    },
  },
  {
    name: "bristol-stay-already-arranged",
    make: (c) => {
      const leila = c.role("friend");
      return {
        text: "Find me an Airbnb in Bristol for the night of Saturday 9 January, somewhere near Temple Meads.",
        detail: `${leila.first} already offered (and the user accepted) her spare room for the 9th`,
        item: mail(
          c,
          leila,
          "Re: January!",
          ago(2, 3),
          [
            "Yes yes yes, the spare room is yours on the 9th, I've already told Sami.",
            "I'll leave a key with the downstairs neighbour in case you're late.",
            "Bring nothing but yourself (and maybe that cheese).",
          ],
          false,
        ),
        decoy: mail(
          c,
          leila,
          "Re: January!",
          ago(2, 3),
          [
            "Gutted, but I have to take back the spare-room offer for the 9th — Sami's parents have just announced they're coming that weekend.",
            "Let's still do dinner on the Saturday though!",
            "Sorry for the faff x",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "stag-weekend-moved",
    make: () => {
      const t = ago(1, 9);
      return {
        text: "Book flights to Kraków for Callum's stag, out Friday 15 January, back Sunday 17th.",
        detail: "The stag has moved a week later, to Fri 22 – Sun 24 January",
        item: chat("callum-stag-planning", [
          { who: "Dev Arora", text: "Right lads, change of plan", at: t },
          {
            who: "Dev Arora",
            text: "Brewery can't do the 16th any more so we're moving everything a week: Fri 22 – Sun 24 Jan",
            at: t + 30_000,
          },
          {
            who: "Dev Arora",
            text: "Callum knows, the apartment's already moved, DON'T book anything for the old dates",
            at: t + 60_000,
          },
          { who: "Sean Malley", text: "sound, works better for me anyway", at: t + 10 * 60_000 },
        ]),
        decoy: chat("callum-stag-planning", [
          { who: "Dev Arora", text: "Right lads, update on the dates wobble", at: t },
          {
            who: "Dev Arora",
            text: "Brewery found us a slot on the 16th after all, so we're sticking with Fri 15 – Sun 17 Jan as planned",
            at: t + 30_000,
          },
          { who: "Dev Arora", text: "ignore all the 22nd–24th talk from last week", at: t + 60_000 },
          { who: "Sean Malley", text: "sound", at: t + 10 * 60_000 },
        ]),
      };
    },
  },
  {
    name: "hall-party-music-curfew",
    make: () => {
      const head =
        "Riverside Community Hall — hire terms (updated September 2026)\n\n1. Bookings are confirmed on receipt of a £150 deposit.\n2. The kitchen must be left as found.\n";
      const tail = "\n8. No confetti, glitter or open flames.\n9. Hirers are responsible for their guests' behaviour.";
      return {
        text: "Book Riverside Community Hall for my 40th on Saturday 19 December, 7pm till 1am, with a DJ.",
        detail: "Community Hall licence: amplified music must end by 23:00 and the building be empty by 23:30",
        item: doc(
          "Community Hall — hire terms",
          `${head}7. Amplified music must end by 23:00 and the building be vacated by 23:30 (a licence condition following neighbour complaints, effective 1 September 2026). Hirers in breach forfeit their deposit.${tail}`,
          ago(40),
        ),
        decoy: doc(
          "Community Hall — hire terms",
          `${head}7. Update 20 October: following the soundproofing works, the temporary 23:00 music limit introduced in September has been lifted. Amplified music may continue until 01:00, with the building vacated by 01:30.${tail}`,
          ago(7),
        ),
      };
    },
  },
  {
    name: "dublin-airport-runway-closure",
    make: (c) => {
      const news = bot("Airport Travel Updates", "updates@airport-travel-updates.co.uk");
      return {
        text: "Book me a morning flight from London City to Dublin on Wednesday 18 November.",
        detail: "London City Airport (LCY) is closed 14–22 November for runway resurfacing",
        item: notice(
          c,
          news,
          "Runway resurfacing: LCY closed 14–22 November",
          ago(11, 6),
          "LCY will be closed from Saturday 14 to Sunday 22 November while the runway is resurfaced. All flights from LCY are suspended for those nine days; most airlines are operating replacement services from Southend and Stansted.\n\nCheck with your airline for details. Southend, Stansted, Gatwick and Heathrow are operating normally.",
        ),
        decoy: notice(
          c,
          news,
          "Runway resurfacing: Southend closed 14–22 November",
          ago(11, 6),
          "Southend Airport will be closed from Saturday 14 to Sunday 22 November while the runway is resurfaced. All flights from Southend are suspended for those nine days; most airlines are operating replacement services from Stansted.\n\nCheck with your airline for details. LCY, Stansted, Gatwick and Heathrow are operating normally.",
        ),
      };
    },
  },
  {
    name: "theatre-friend-on-crutches",
    make: (c) => {
      const bea = bot("Bea Hollis", "bea.hollis@icloud.com");
      return {
        text: "Buy four tickets for the Sunday 15 November matinee of The Glass Orchard at the Alderney Theatre — upper circle, for the usual group.",
        detail: "Bea is on crutches until Christmas — she needs step-free seats, not the circle",
        item: mail(
          c,
          bea,
          "post-op update",
          ago(3, 2),
          [
            "Knee op went fine, thanks so much for the flowers!",
            "Bad news is I'm on crutches until at least Christmas and stairs are a nightmare, so anything up in a circle is out unless there's a lift.",
            "Sorry to be a pain for our next outing — an aisle seat in the stalls would be perfect.",
          ],
          false,
        ),
        decoy: mail(
          c,
          bea,
          "post-op update",
          ago(3, 2),
          [
            "Physio signed me off today — the crutches are in the loft!",
            "Stairs are no problem any more, so I'm game for wherever we sit on our next outing, even up in the circle.",
            "Thanks for putting up with me hobbling about all summer.",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "whisky-tasting-friend-pregnant",
    make: (c) => {
      const imogen = bot("Imogen Strand", "imogen.strand@gmail.com");
      return {
        text: "Book the whisky tasting at Glenrigg Distillery for Imogen's birthday on Saturday 30 January, six of us.",
        detail: "Imogen is pregnant (not public yet) — a whisky tasting won't suit her",
        item: mail(
          c,
          imogen,
          "shhh",
          ago(4, 7),
          [
            "Okay, you're one of the first to know: I'm 11 weeks pregnant!!",
            "We're not telling everyone until after the scan on the 20th, so keep it zipped please.",
            "It also means I'm on lime and sodas for a good while, so no big nights for me.",
          ],
          false,
        ),
        decoy: mail(
          c,
          imogen,
          "shhh",
          ago(4, 7),
          [
            "Okay, you're one of the first to know: my sister Hanna is 11 weeks pregnant!!",
            "I'm going to be an auntie and I'm already shopping for tiny jumpers.",
            "She's not telling people until after the scan on the 20th, so keep it zipped please.",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "five-a-side-spanish-class",
    make: () => {
      const where = "Room 4, Westgate Adult Learning Centre\nPaid £120 for the term. Homework: past-tense worksheet.";
      return {
        text: "Register me for the Hollins Park five-a-side league — Tuesday nights at 7pm, starting 10 November.",
        detail:
          "The user has a paid Spanish class on Tuesdays 18:30–20:30 until 8 December, which clashes with the league",
        item: event(
          "Conversational Spanish (week 3 of 8)",
          "2026-11-03T18:30:00Z",
          `Tuesdays 18:30–20:30, weekly from 20 October until 8 December\n${where}`,
          ago(20),
        ),
        decoy: event(
          "Conversational Spanish (week 3 of 8)",
          "2026-11-04T18:30:00Z",
          `Wednesdays 18:30–20:30, weekly from 21 October until 9 December\n${where}`,
          ago(20),
        ),
      };
    },
  },
  {
    name: "bonfire-party-guest-friction",
    make: (c) => {
      const nell = bot("Nell Garrow", "nell.garrow@outlook.com");
      return {
        text: "Invite Theo to the bonfire party at mine on Thursday 5 November — usual time, bring a sparkler.",
        detail: "Nell won't come if Theo is invited (they fell out over the summer)",
        item: mail(
          c,
          nell,
          "Thursday",
          ago(1, 6),
          [
            "Can't wait for Thursday, I'm bringing the mulled cider again.",
            "Awkward one though: if Theo's coming I'll give it a miss — I still can't be in a room with him after the summer.",
            "Totally your call, it's your party, I just didn't want to make a scene on the night.",
          ],
          false,
        ),
        decoy: mail(
          c,
          nell,
          "Thursday",
          ago(1, 6),
          [
            "Can't wait for Thursday, I'm bringing the mulled cider again.",
            "Also, Theo and I finally had a proper chat last weekend and we're totally fine now, so honestly invite whoever.",
            "Water under the bridge!",
          ],
          false,
        ),
      };
    },
  },
  {
    name: "island-ferry-vehicle-ramp",
    make: (c) => {
      const ferry = bot("Solent Link Ferries", "travel-updates@solentlink.co.uk");
      return {
        text: "Reserve a car space on the 08:15 sailing from Lymington to the Isle of Wight on Friday 6 November.",
        detail: "Lymington vehicle sailings are suspended 26 Oct–8 Nov (ramp repairs) — foot passengers only",
        item: notice(
          c,
          ferry,
          "Service update: vehicle ramp repairs",
          ago(3, 1),
          "Following damage to the linkspan in last week's storm, the vehicle ramp at Lymington is closed for repairs from Monday 26 October to Sunday 8 November.\n\nAll vehicle sailings on the Lymington–Yarmouth route are suspended during this period; foot passenger sailings will run to the normal timetable. Vehicle bookings have been cancelled and refunded. Portsmouth–Fishbourne is operating normally.",
        ),
        decoy: notice(
          c,
          ferry,
          "Service update: vehicle ramp repairs",
          ago(3, 1),
          "Following damage to the linkspan in last week's storm, the vehicle ramp at Fishbourne is closed for repairs from Monday 26 October to Sunday 8 November.\n\nAll vehicle sailings on the Portsmouth–Fishbourne route are suspended during this period; foot passenger sailings will run to the normal timetable. Lymington–Yarmouth is operating normally and has extra vehicle capacity.",
        ),
      };
    },
  },
];

/** Plants one item per template (the hidden item, or its near miss for the control) and returns the tasks. */
export function plantTrain5(world: World, seed: number, variant: Variant): HiddenTask[] {
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
      if (!p) throw new Error(`train5: ran out of ${relation} people`);
      return p;
    },
    role: (role) => world.people.find((p) => p.role === role)!,
  };
  const suite = variant === "hidden" ? "train5" : "train5-control";
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

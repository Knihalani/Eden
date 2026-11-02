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

/** A moment in 2026 (UTC), month 1-based: world time is fixed, so dates in the text are written out. */
const on = (month: number, day: number, h = 9, m = 0) => Date.UTC(2026, month - 1, day, h, m);
const iso = (t: number) => new Date(t).toISOString();

// The household: Robin, partner Alex, Maya (Year 3, Holloway Primary), Theo (4, Little Acorns Nursery), Biscuit the
// dog and Pepper the cat, a rented flat (landlord Steve) in a block with a service lift, and Mum in Bath.
const alex = bot("Alex Carter", "alex.carter@fastmail.com");
const nursery = bot("Little Acorns Nursery", "office@littleacorns-nursery.co.uk");
const surgery = bot("Parkside Surgery", "no-reply@parksidesurgery.nhs.uk");
const vets = bot("Riverside Vets", "care@riversidevets.co.uk");
const schoolOffice = bot("Holloway Primary Office", "office@hollowayprimary.sch.uk");

const TEMPLATES: { name: string; make: (c: Ctx) => Spec }[] = [
  {
    // Overlap: one topic word ("collect"). Decoy (c): the prerequisite is already met.
    name: "nursery-collection-list",
    make: (c) => ({
      text:
        "Can you message Mum and ask her to collect Theo from nursery at 5pm on Thursday 5 November? " +
        "I've got a late meeting and Alex is away.",
      detail: "Mum is not on Theo's named collection list; new collectors must be registered with photo ID 48h ahead",
      item: notice(
        c,
        nursery,
        "Important: changes to collection arrangements from 2 November",
        ago(6, 2),
        "Dear Parents and Carers,\n\nThank you to everyone who came to our autumn stay-and-play. We have some " +
          "housekeeping for the coming half of term.\n\nFrom Monday 2 November, children will only be released to " +
          "adults on their named collection list. Anyone new must be registered in person at the office with photo " +
          "ID at least 48 hours before their first collection; we cannot make exceptions on the day, even for " +
          "grandparents.\n\nOur records show the named adults for your child (Squirrels) are: Robin Carter, Alex " +
          "Carter.\n\nWellies and a named spare set of clothes, please, as we are outside in all weathers.\n\nWarm " +
          "wishes,\nThe Little Acorns Team",
      ),
      decoy: notice(
        c,
        nursery,
        "Collection list updated for Theo Carter",
        ago(3, 22),
        "Dear Robin,\n\nThank you for bringing in Ruth Carter's photo ID this morning. She has now been added to Theo's " +
          "named collection list alongside you and Alex, with the collection password you chose, and can collect " +
          "him from today.\n\nA reminder that Squirrels have forest school on Wednesdays, so wellies please.\n\nWarm " +
          "wishes,\nThe Little Acorns Team",
      ),
    }),
  },
  {
    // Overlap: name only (Maya). Decoy (b): the same thing done for the other child.
    name: "maya-dentist-already-booked",
    make: (c) => ({
      text: "Book Maya a check-up with Dr Okafor at Harley Street Dental some time the week of 9 November, after school.",
      detail: "Alex already booked Maya's dental check-up for Thursday 12 November at 16:00",
      item: chat("DM: Alex Carter", [
        { who: "Alex Carter", text: "did you see the boiler man has moved again 🙄", at: ago(1, 14) },
        { who: "Robin Carter", text: "of course he has", at: ago(1, 13) },
        {
          who: "Alex Carter",
          text: "also fyi I booked Maya's teeth thing, Thu 12th at 4pm with Dr O. It's in my calendar not yours",
          at: ago(1, 13),
        },
        { who: "Alex Carter", text: "can you do the pickup from there? I'm in Reading till late", at: ago(1, 13) },
      ]),
      decoy: chat("DM: Alex Carter", [
        { who: "Alex Carter", text: "did you see the boiler man has moved again 🙄", at: ago(1, 14) },
        { who: "Robin Carter", text: "of course he has", at: ago(1, 13) },
        {
          who: "Alex Carter",
          text: "also fyi I booked Theo's teeth thing, Thu 12th at 4pm with Dr O. Maya's still needs doing, can you sort hers?",
          at: ago(1, 13),
        },
        { who: "Alex Carter", text: "I'm in Reading till late that day", at: ago(1, 13) },
      ]),
    }),
  },
  {
    // Overlap: one topic word ("physio"). Decoy (a): the fee has been dropped.
    name: "physio-late-change-fee",
    make: (c) => {
      const clinic = bot("Moveright Physio", "bookings@moveright-physio.co.uk");
      return {
        text: "Move my physio tomorrow morning (Wednesday 8:30) to Monday 2 November, same time.",
        detail: "Moveright charges the full £55 fee for changes with less than 48 hours' notice",
        item: notice(
          c,
          clinic,
          "Your treatment plan and our booking terms",
          ago(20, 3),
          "Hi Robin,\n\nThanks for coming in for your initial assessment. Your plan is six weekly appointments with " +
            "Kirsty Lund, focusing on your lower back.\n\nPlease note our booking terms: appointments moved or " +
            "cancelled with less than 48 hours' notice are charged at the full fee of £55, as we are rarely " +
            "able to fill the slot.\n\nDon't forget to keep up the home exercises between visits.\n\nMoveright Physio",
        ),
        decoy: notice(
          c,
          clinic,
          "Good news: changes to our booking terms",
          ago(20, 3),
          "Hi Robin,\n\nThanks for coming in for your initial assessment. Your plan is six weekly appointments with " +
            "Kirsty Lund, focusing on your lower back.\n\nFrom 1 October we have dropped our late-change fee: you can " +
            "now move or cancel any appointment free of charge up to 12 hours before it starts, online or by phone." +
            "\n\nDon't forget to keep up the home exercises between visits.\n\nMoveright Physio",
        ),
      };
    },
  },
  {
    // Overlap: name only (Mum). Decoy (b): a list of people where the restriction is someone else's.
    name: "mum-no-ibuprofen",
    make: (c) => {
      const ellie = c.role("sister");
      return {
        text:
          "When you do Mum's FreshCart order for Friday 30 October, add a pack of ibuprofen and some paracetamol, " +
          "she says her knee's playing up.",
        detail: "Mum must not take ibuprofen or other anti-inflammatories now she is on apixaban (blood thinner)",
        item: chat("DM: Ellie Carter", [
          { who: ellie.full, text: "back from the GP with Mum", at: ago(4, 3) },
          { who: ellie.full, text: "they've put her on apixaban for the AF, twice a day", at: ago(4, 3) },
          {
            who: ellie.full,
            text: "GP was really clear: no anti-inflammatories at all from now on, they make bleeds more likely. She'll forget",
            at: ago(4, 3),
          },
          { who: c.user.full, text: "ok noted, thanks for taking her", at: ago(4, 2) },
        ]),
        decoy: chat("DM: Ellie Carter", [
          { who: ellie.full, text: "back from the GP with Mum and Auntie Jean (two for one 😅)", at: ago(4, 3) },
          {
            who: ellie.full,
            text: "they've put Jean on apixaban, so no anti-inflammatories for her any more",
            at: ago(4, 3),
          },
          {
            who: ellie.full,
            text: "Mum's bloods were all normal, no changes to anything for her, GP said carry on as she is",
            at: ago(4, 3),
          },
          { who: c.user.full, text: "ok good, thanks for taking them", at: ago(4, 2) },
        ]),
      };
    },
  },
  {
    // Overlap: name only (Biscuit). Decoy (b): the lapsed vaccine is the cat's, the dog is up to date.
    name: "biscuit-kennel-cough-lapsed",
    make: (c) => ({
      text: "Book Biscuit into Oakfield Dog Hotel for 19–23 November while we're in Edinburgh.",
      detail: "Biscuit's kennel cough vaccine lapsed on 14 October; boarding needs it at least 14 days before the stay",
      item: notice(
        c,
        vets,
        "Vaccination reminder for Biscuit",
        ago(9, 1),
        "Dear Robin,\n\nOur records show that Biscuit's intranasal Bordetella (kennel cough) vaccination lapsed on " +
          "14 October. Most boarding establishments require it to be given at least 14 days before a stay, so " +
          "please book in soon if you have any plans.\n\nBiscuit's main annual booster is up to date until March.\n\n" +
          "Book online or call us on 020 7946 0311.\n\nRiverside Vets",
      ),
      decoy: notice(
        c,
        vets,
        "Vaccination reminders for your pets",
        ago(9, 1),
        "Dear Robin,\n\nHere is a summary of your pets' vaccinations:\n\nPepper (cat): annual booster overdue since " +
          "14 October, please book an appointment.\nBiscuit (dog): all vaccinations up to date, including kennel " +
          "cough (valid until August 2027).\n\nBook online or call us on 020 7946 0311.\n\nRiverside Vets",
      ),
    }),
  },
  {
    // Overlap: none. Decoy (a): the landlord's rule has been relaxed.
    name: "landlord-repairs-via-me",
    make: (c) => {
      const steve = c.role("landlord");
      return {
        text: "Find a plumber who can come out this week to fix the dripping kitchen tap, and get me a couple of quotes.",
        detail: "Landlord Steve says all repairs go through him; contractors instructed directly won't be reimbursed",
        item: thread(c, "Flat 3 — couple of things", [
          {
            from: c.user,
            to: steve,
            at: ago(30),
            body: ["Quick one: the bathroom light pull has snapped. I can just get someone in and send you the bill?"],
            corporate: false,
          },
          {
            from: steve,
            to: c.user,
            at: ago(29, 20),
            body: [
              "Please don't, I'd rather you didn't book anyone yourself.",
              "Under clause 14 of the tenancy all repairs go through me, I use my own people and I can't reimburse " +
                "contractors I haven't instructed. Just email me and I'll sort it within a few days.",
              "Rent for November is fine on the usual date.",
            ],
            corporate: false,
          },
        ]),
        decoy: thread(c, "Flat 3 — couple of things", [
          {
            from: c.user,
            to: steve,
            at: ago(30),
            body: ["Quick one: the bathroom light pull has snapped. I can just get someone in and send you the bill?"],
            corporate: false,
          },
          {
            from: steve,
            to: c.user,
            at: ago(29, 20),
            body: [
              "Yes, go ahead. I know I used to ask you to run every job past me first, but I've dropped that.",
              "For anything small (under £150) just get it done by whoever you like and send me the invoice, " +
                "I'll take it off the next month's rent.",
              "Rent for November is fine on the usual date.",
            ],
            corporate: false,
          },
        ]),
      };
    },
  },
  {
    // Overlap: name only (Maya). Decoy (a): the clashing slot has moved.
    name: "maya-saturday-swim-clash",
    make: (c) => {
      const club = bot("Hillside Swim Club", "lessons@hillsideswim.org.uk");
      return {
        text: "Sign Maya up for the Saturday 10am ballet class at Rosewood Dance starting 7 November, £64 for the term.",
        detail: "Maya has swimming at Hillside on Saturdays 9:00–10:30 from 7 November (already paid), clashing",
        item: notice(
          c,
          club,
          "Place confirmed: Stage 4, Saturdays",
          ago(5, 6),
          "Dear Alex and Robin,\n\nWe're pleased to confirm Maya Carter's place in Stage 4 for the winter block. " +
            "Lessons run on Saturdays from 9:00 to 10:30 at Hillside Leisure Centre, starting 7 November, for 10 " +
            "weeks. Payment of £80 has been received with thanks.\n\nPlease arrive 10 minutes early and bring " +
            "goggles.\n\nHillside Swim Club",
        ),
        decoy: notice(
          c,
          club,
          "Change of lesson day: Stage 4",
          ago(5, 6),
          "Dear Alex and Robin,\n\nDue to pool refurbishment, Stage 4 lessons for the winter block are moving from " +
            "Saturday mornings to Sundays, 9:00 to 10:30, starting 8 November. Maya Carter's place carries over " +
            "automatically and there are no Saturday sessions this block.\n\nPlease arrive 10 minutes early and bring " +
            "goggles.\n\nHillside Swim Club",
        ),
      };
    },
  },
  {
    // Overlap: one topic word ("prescription"). Decoy (b): a different medicine is ready, not the inhaler.
    name: "inhaler-prescription-ready",
    make: (c) => {
      const pharmacy = bot("Kingsmead Pharmacy", "noreply@kingsmeadpharmacy.co.uk");
      return {
        text: "Book me a GP appointment next week, I need my asthma prescription renewed before I run out.",
        detail:
          "The salbutamol (asthma reliever) repeat was already issued and is ready to collect at Kingsmead Pharmacy",
        item: notice(
          c,
          pharmacy,
          "Your prescription is ready to collect",
          ago(0, 18),
          "Hello Robin,\n\nYour prescription is ready to collect from Kingsmead Pharmacy, 41 Holloway Road.\n\n" +
            "Items: Salbutamol 100mcg reliever inhaler x2\nIssued by: Parkside Surgery (repeat)\n\nWe'll keep it for 14 days. " +
            "Opening hours Mon–Sat 8:30–19:00.\n\nKingsmead Pharmacy",
        ),
        decoy: notice(
          c,
          pharmacy,
          "Your prescription is ready to collect",
          ago(0, 18),
          "Hello Robin,\n\nYour prescription is ready to collect from Kingsmead Pharmacy, 41 Holloway Road.\n\n" +
            "Items: Cetirizine 10mg tablets x30\nIssued by: Parkside Surgery (repeat)\n\nWe'll keep it for 14 days. " +
            "Opening hours Mon–Sat 8:30–19:00.\n\nKingsmead Pharmacy",
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (a): the training day has moved.
    name: "breakfast-club-inset-day",
    make: (c) => ({
      text: "Book Maya into breakfast club every day next week, Monday 2 to Friday 6 November.",
      detail: "Monday 2 November is a staff training day: closed to pupils, no wraparound care that day",
      item: notice(
        c,
        schoolOffice,
        "Dates for your diary",
        ago(12, 5),
        "Dear Families,\n\nAhead of half-term (19–23 October), A few dates:\n\n- Monday 2 November: staff training day. " +
          "The building is closed to pupils and wraparound care (morning and after-school sessions) will not run.\n" +
          "- Thursday 12 November: Year 3 class assembly, 9:00.\n- Friday 20 November: non-uniform day (£1).\n\n" +
          "Thank you,\nThe Office",
      ),
      decoy: notice(
        c,
        schoolOffice,
        "Dates for your diary (updated)",
        ago(12, 5),
        "Dear Families,\n\nAhead of half-term (19–23 October), A few dates:\n\n- The staff training day previously " +
          "planned for Monday 2 November has moved to Friday 4 December. We are open as normal on 2 November, " +
          "wraparound care included.\n- Thursday 12 November: Year 3 class assembly, 9:00.\n- Friday 20 November: " +
          "non-uniform day (£1).\n\nThank you,\nThe Office",
      ),
    }),
  },
  {
    // Overlap: none. Decoy (a): the trip was cancelled.
    name: "childminder-away",
    make: (c) => {
      const bev = bot("Bev Lawson", "bev.lawson.childcare@gmail.com");
      return {
        text: "Ask our childminder if she can have Theo for an extra afternoon on Wednesday 4 November, usual £45.",
        detail: "Bev the childminder is away 2–6 November (wedding in Cork) and closed that week",
        item: mail(
          c,
          bev,
          "Dates",
          ago(15, 2),
          [
            "Just a reminder that I'm away from Monday 2 to Friday 6 November for my daughter's wedding in Cork, so " +
              "I'm closed that week.",
            "The little ones made salt dough hedgehogs today, they're drying on the windowsill!",
            "Invoices for November will come out on the 1st as usual.",
          ],
          false,
        ),
        decoy: mail(
          c,
          bev,
          "Dates",
          ago(15, 2),
          [
            "Change of plan: the wedding in Cork has been postponed to the spring, so I'm not going away on 2–6 " +
              "November after all and I'm open as normal that week.",
            "The little ones made salt dough hedgehogs today, they're drying on the windowsill!",
            "Invoices for November will come out on the 1st as usual.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: one topic word ("fan"). Decoy (b): the job booked is for another flat; Robin's isn't done.
    name: "bathroom-fan-already-booked",
    make: (c) => {
      const steve = c.role("landlord");
      return {
        text: "Book an electrician to replace the broken extractor fan in our bathroom, ideally this week.",
        detail: "Steve already booked his electrician to replace the bathroom fan on Thursday 5 November (has a key)",
        item: mail(
          c,
          steve,
          "Sparky",
          ago(2, 3),
          [
            "Dave (my sparky) is coming to sort your fan on Thursday 5 November, morning.",
            "He has a key so no need to be in. I've also asked him to look at the hallway light while he's there.",
          ],
          false,
        ),
        decoy: mail(
          c,
          steve,
          "Sparky",
          ago(2, 3),
          [
            "Heads up, Dave (my sparky) is doing Flat 2's kitchen fan on Thursday 5 November, so you might " +
              "hear drilling in the morning.",
            "Nothing needed from you. Yours isn't on his list, so get your own person in for it if you like.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: name only (Mum). Decoy (a): Mum's trip away was called off.
    name: "mum-staying-in-leeds",
    make: (c) => {
      const ellie = c.role("sister");
      return {
        text: "Book me train tickets to Bath to visit Mum, Saturday 7 November, back on the Sunday.",
        detail: "Mum is staying with Ellie in Leeds 4–11 November while her kitchen is refitted, not in Bath",
        item: thread(c, "Mum's kitchen", [
          {
            from: c.user,
            to: ellie,
            at: ago(8),
            body: ["How's the kitchen saga going? Has she picked the worktops yet?"],
            corporate: false,
          },
          {
            from: ellie,
            to: c.user,
            at: ago(7, 18),
            body: [
              "Finally! Fitters are in from the 4th, so she's coming up to stay with me in Leeds from Wednesday 4th " +
                "to Wednesday 11th November.",
              "The house will be a building site and the water's off for most of it.",
              "She's bringing the cat, God help me.",
            ],
            corporate: false,
          },
        ]),
        decoy: thread(c, "Mum's kitchen", [
          {
            from: c.user,
            to: ellie,
            at: ago(8),
            body: ["How's the kitchen saga going? Has she picked the worktops yet?"],
            corporate: false,
          },
          {
            from: ellie,
            to: c.user,
            at: ago(7, 18),
            body: [
              "She was going to come up to me in Leeds 4–11 November while the fitters were in, but they've pushed " +
                "the job back to January.",
              "So she's at home in Bath all of November as normal, and quite relieved about it.",
            ],
            corporate: false,
          },
        ]),
      };
    },
  },
  {
    // Overlap: name only (Pepper). Decoy (b): the parcel dispatched is the dog's.
    name: "pepper-flea-parcel-sent",
    make: (c) => {
      const club = bot("Riverside Vets Pet Health Club", "healthclub@riversidevets.co.uk");
      return {
        text: "Order Pepper's flea and worming treatment from PetMeds Direct, the usual 3-month pack.",
        detail: "Pepper's quarterly treatment parcel was already dispatched on 22 October under the vet health plan",
        item: notice(
          c,
          club,
          "Your quarterly parcel is on its way",
          ago(5, 2),
          "Hi Robin,\n\nPepper's quarterly parcel was dispatched on Thursday 22 October by Royal Mail Tracked 48 " +
            "(tracking ZK 4410 2287 6GB). It contains three months of spot-on and tablets, included in your monthly " +
            "plan.\n\nYour next parcel is due in January.\n\nRiverside Vets Pet Health Club",
        ),
        decoy: notice(
          c,
          club,
          "Your quarterly parcel is on its way",
          ago(5, 2),
          "Hi Robin,\n\nBiscuit's quarterly parcel was dispatched on Thursday 22 October by Royal Mail Tracked 48 " +
            "(tracking ZK 4410 2287 6GB). It contains three months of spot-on and tablets, included in your monthly " +
            "plan.\n\nPepper is not on a plan with us, so cat treatments are not included.\n\nRiverside Vets Pet " +
            "Health Club",
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (c): the neighbour confirms she's in.
    name: "neighbour-away-for-parcel",
    make: (c) => {
      const halina = bot("Halina Kowalska", "halina.kowalska@outlook.com");
      return {
        text: "Reply to DPD and set Thursday's bunk bed delivery (29 October) to 'leave with neighbour at number 14'.",
        detail: "The neighbours at number 14 are away in Kraków from 28 October to 9 November",
        item: mail(
          c,
          halina,
          "Favour",
          ago(3, 1),
          [
            "Marek and I fly to Kraków on Wednesday 28th and we're back Monday 9 November.",
            "Would you mind keeping an eye on the house and taking the bins out on Tuesday? Spare key is under the " +
              "blue pot.",
            "Thank you, we'll bring you some pierniki!",
          ],
          false,
        ),
        decoy: mail(
          c,
          halina,
          "Favour",
          ago(3, 1),
          [
            "Marek is flying to Kraków for his mum's birthday but I'm working from home all this week and next.",
            "So if you ever need me to take a parcel in, just send it to number 14, I'm always in.",
            "Could you return the favour with our bins on Tuesday? Thank you!",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: one topic word ("flu"). Decoy (c): school did not vaccinate her, so the pharmacy is right.
    name: "maya-flu-done-at-school",
    make: (c) => {
      const imms = bot("North London School Immunisation Team", "imms.team@nlschoolimms.nhs.uk");
      return {
        text: "Book Maya's flu vaccine at Kingsmead Pharmacy for this Saturday morning.",
        detail: "Maya already had the nasal flu vaccine at school on 20 October",
        item: notice(
          c,
          imms,
          "Immunisation record",
          ago(6, 22),
          "Dear Parent/Carer,\n\nYour child (Year 3, Holloway Primary) received the nasal flu spray in school " +
            "today, Tuesday 20 October. No further dose is needed this season.\n\nSome children develop a runny nose " +
            "for a day or two; this is normal.\n\nNorth London School Immunisation Team",
        ),
        decoy: notice(
          c,
          imms,
          "Vaccination record: Maya Carter",
          ago(6, 22),
          "Dear Parent/Carer,\n\nWe vaccinated Year 3 at Holloway Primary today, Tuesday 20 October. We did not " +
            "receive a consent form for Maya Carter, so she was not vaccinated and we will not return this season." +
            "\n\nPlease arrange her flu vaccine through your GP or a community pharmacy instead.\n\nNorth London " +
            "School Immunisation Team",
        ),
      };
    },
  },
  {
    // Overlap: one topic word ("jumpers"). Decoy (a): the purchase didn't happen.
    name: "maya-jumpers-bought",
    make: (c) => ({
      text: "Order Maya two school jumpers, age 8–9, from the uniform shop. She's grown out of the old ones.",
      detail: "Alex already bought two age 8–9 jumpers for Maya at the PTA nearly-new sale on Saturday",
      item: chat("DM: Alex Carter", [
        { who: "Alex Carter", text: "PTA sale was carnage", at: ago(2, 22) },
        { who: "Alex Carter", text: "got 2 jumpers in her size for M, £3 each, both fine, no holes", at: ago(2, 22) },
        { who: "Alex Carter", text: "and a book bag because hers has jam in it", at: ago(2, 22) },
        { who: "Robin Carter", text: "hero", at: ago(2, 20) },
      ]),
      decoy: chat("DM: Alex Carter", [
        { who: "Alex Carter", text: "PTA sale was carnage", at: ago(2, 22) },
        {
          who: "Alex Carter",
          text: "was going to get Maya jumpers but they'd sold out in 8-9 by 10am",
          at: ago(2, 22),
        },
        { who: "Alex Carter", text: "got a book bag though because hers has jam in it", at: ago(2, 22) },
        { who: "Robin Carter", text: "ha ok", at: ago(2, 20) },
      ]),
    }),
  },
  {
    // Overlap: one topic word ("health"). Decoy (c): the allowance has renewed, so the claim is fine.
    name: "physio-claim-allowance-used",
    make: (c) => {
      const insurer = bot("Brightcover Health Member Services", "members@brightcoverhealth.co.uk");
      return {
        text: "Submit Kirsty Lund's £220 physio invoice to my health insurer for reimbursement.",
        detail: "Brightcover outpatient therapies benefit is used up (£400 of £400) until the 1 January renewal",
        item: notice(
          c,
          insurer,
          "Your claim has been settled",
          ago(11, 4),
          "Dear Robin Carter,\n\nYour claim CLM-88213 (osteopathy, £180) has been settled and paid to your account." +
            "\n\nWith this claim, your outpatient therapies benefit for this policy year has been fully used (£400 of " +
            "£400). Further therapy claims cannot be paid until your benefit renews on 1 January 2027.\n\n" +
            "Brightcover Member Services",
        ),
        decoy: notice(
          c,
          insurer,
          "Your policy has renewed",
          ago(11, 4),
          "Dear Robin Carter,\n\nYour policy renewed on 1 October. Your outpatient therapies benefit has reset and " +
            "you have £400 available for physiotherapy, osteopathy or chiropractic treatment this policy year.\n\n" +
            "Claims can be submitted in the app with an itemised invoice.\n\nBrightcover Member Services",
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (a): the restriction was lifted.
    name: "babysitter-mocks",
    make: (c) => {
      const megan = bot("Megan Price", "megan.price08@gmail.com");
      return {
        text: "Book our usual babysitter for Saturday 31 October from 7pm so Alex and I can go out for dinner.",
        detail: "Megan (the usual babysitter) isn't free any Friday or Saturday night until her mocks end 13 November",
        item: mail(
          c,
          megan,
          "Evenings",
          ago(9, 9),
          [
            "Mum says I have to stop all my evening jobs until my mocks are done (last one is Friday 13 November).",
            "So I'm not free on any Friday or Saturday nights before then, sorry!",
            "Say hi to Maya and Theo, and tell Theo I've got the dinosaur book he lent me.",
          ],
          false,
        ),
        decoy: mail(
          c,
          megan,
          "Evenings",
          ago(9, 9),
          [
            "Good news, my mocks have been moved to January so mum says I can keep doing evenings this term.",
            "I'm free most Fridays and Saturdays, just message me.",
            "Say hi to Maya and Theo, and tell Theo I've got the dinosaur book he lent me.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: name only (Halvorsen). Decoy (b): a different payment is recorded; the autumn fee is still open.
    name: "piano-fee-already-paid",
    make: (c) => ({
      text: "Pay Mr Halvorsen £180 by bank transfer for Maya's autumn-term piano lessons.",
      detail: "The household spending sheet shows the £180 autumn term to Halvorsen was paid by Alex on 25 October",
      item: doc(
        "Household spending — October",
        "Household spending — October\n\nDate | What | Amount | Paid by\n" +
          "02 Oct | Council tax | £168 | DD\n" +
          "10 Oct | Little Acorns (Oct) | £1,140 | Alex\n" +
          "18 Oct | Hillside swim (winter block) | £80 | Robin\n" +
          "25 Oct | D. Halvorsen (Sept–Dec) | £180 | Alex ✓\n" +
          "26 Oct | Car insurance | £44 | DD\n\nTo do: book MOT, renew Biscuit's insurance",
        ago(1, 6),
      ),
      decoy: doc(
        "Household spending — October",
        "Household spending — October\n\nDate | What | Amount | Paid by\n" +
          "02 Oct | Council tax | £168 | DD\n" +
          "10 Oct | Little Acorns (Oct) | £1,140 | Alex\n" +
          "18 Oct | Hillside swim (winter block) | £80 | Robin\n" +
          "25 Oct | D. Halvorsen, summer term top-up (2 extra lessons) | £45 | Alex ✓\n" +
          "26 Oct | Car insurance | £44 | DD\n\nTo do: book MOT, renew Biscuit's insurance, Halvorsen autumn (Robin)",
        ago(1, 6),
      ),
    }),
  },
  {
    // Overlap: name only (Theo). Decoy (c): the allergy was ruled out.
    name: "theo-peanut-allergy-party",
    make: (c) => {
      const clinic = bot("Whittington Children's Allergy Clinic", "paeds.allergy@whittington.nhs.uk");
      return {
        text: "RSVP yes for Theo to Freddie Nash's 4th birthday at Jungle Jim's soft play, Sunday 8 November at 2pm.",
        detail: "Theo has a confirmed peanut and cashew allergy: tell the hosts, carry two adrenaline auto-injectors",
        item: notice(
          c,
          clinic,
          "Clinic letter: Theo Carter",
          ago(8, 3),
          "Dear Mr/Ms Carter,\n\nThank you for attending clinic with Theo on 14 October. Skin prick testing " +
            "confirmed allergy to peanut and cashew.\n\nPlan: strict avoidance; two adrenaline auto-injectors " +
            "(Jext 150) to be carried at all times; please inform nursery, hosts and anyone serving food.\n\nWe will " +
            "review in 12 months.\n\nDr S. Iyer, Consultant Paediatric Allergist",
        ),
        decoy: notice(
          c,
          clinic,
          "Clinic letter: Theo Carter",
          ago(8, 3),
          "Dear Mr/Ms Carter,\n\nThank you for attending clinic with Theo on 14 October for his oral food challenge." +
            "\n\nTheo ate a full age-appropriate portion of peanut without any reaction. The suspected peanut allergy " +
            "is ruled out: no dietary restrictions, and there is no need to carry an auto-injector.\n\nHe has been " +
            "discharged from our clinic.\n\nDr S. Iyer, Consultant Paediatric Allergist",
        ),
      };
    },
  },
  {
    // Overlap: one topic word ("delivery"). Decoy (a): the lift works were postponed.
    name: "oven-delivery-lift-closed",
    make: (c) => {
      const block = bot("Ashby Court Management", "residents@ashbycourt-mgmt.co.uk");
      return {
        text: "Accept the delivery slot Kitchenhaus offered for our new oven: Friday 6 November, 7am–1pm.",
        detail: "The Ashby Court service lift is out of action 2–13 November; no large-item delivery possible",
        item: notice(
          c,
          block,
          "Service lift refurbishment 2–13 November",
          ago(10, 3),
          "Dear Residents,\n\nThe service lift will be out of action from Monday 2 to Friday 13 November while it is " +
            "refurbished. Please do not book any delivery or removal of furniture or large appliances during this " +
            "period; couriers will not be permitted to use the stairs.\n\nThe passenger lift is unaffected.\n\n" +
            "Bin store cleaning is on Thursday.\n\nAshby Court Management",
        ),
        decoy: notice(
          c,
          block,
          "Service lift refurbishment postponed",
          ago(10, 3),
          "Dear Residents,\n\nThe service lift refurbishment we told you about, planned for 2–13 November, has been " +
            "postponed to February because of a parts delay. Both lifts will operate as normal throughout November, " +
            "and deliveries can be booked as usual.\n\nBin store cleaning is on Thursday.\n\nAshby Court Management",
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (b): the booking is for a different appointment date.
    name: "mum-hospital-transport-booked",
    make: (c) => {
      const pts = bot("Patient Transport Service", "pts.bookings@ruh-bath.nhs.uk");
      return {
        text: "Book a taxi for my mum to her hearing clinic appointment on Thursday 12 November at 10:40.",
        detail: "Patient transport is already booked to collect Mum at 09:15 on 12 November, return included",
        item: notice(
          c,
          pts,
          "Booking confirmation PTS-55120",
          ago(2, 5),
          "This message is sent to the nominated contact.\n\nPatient: Mrs R. Carter\nCollection: 4 Lansdown " +
            "Crescent, Bath, Thursday 12 November, 09:15\nDestination: Royal United Hospital, Audiology (B12)\n" +
            "Return journey: included\nMobility: walking stick, 1 escort permitted\n\nTo cancel, call 01225 000 418 " +
            "at least 24 hours before.",
        ),
        decoy: notice(
          c,
          pts,
          "Booking confirmation PTS-55120",
          ago(2, 5),
          "This message is sent to the nominated contact.\n\nPatient: Mrs R. Carter\nCollection: 4 Lansdown " +
            "Crescent, Bath, Thursday 19 November, 13:30\nDestination: Royal United Hospital, Eye Clinic (B7)\n" +
            "Return journey: included\nMobility: walking stick, 1 escort permitted\n\nTo cancel, call 01225 000 418 " +
            "at least 24 hours before.",
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (a): the change never happened.
    name: "cleaner-lockbox-changed",
    make: (c) => {
      const steve = c.role("landlord");
      return {
        text: "Tell Gosia she can let herself in with the key safe code as usual on Monday 2 November to clean.",
        detail: "The front-door lock box was replaced on 23 October; the old code no longer works (new one is 4471)",
        item: mail(
          c,
          steve,
          "Front door",
          ago(1, 2),
          [
            "The locksmith replaced the lock box by the front door on Friday after the downstairs tenants left.",
            "The old combination won't open it any more. The new one is 4471, please keep it within the household.",
          ],
          false,
        ),
        decoy: mail(
          c,
          steve,
          "Front door",
          ago(1, 2),
          [
            "The locksmith was meant to replace the lock box by the front door on Friday but couldn't get the part.",
            "So nothing has changed for now, same combination as before. I'll let you know if he rebooks.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: name only (Maya). Decoy (c): Mum can't have them, so the club is needed.
    name: "christmas-club-mum-has-kids",
    make: (c) => {
      const mum = c.role("mum");
      return {
        text: "Book Maya into Camp Kestrel holiday club for 21–23 December, £38 a day.",
        detail: "Mum is having Maya and Theo in Bath 19–24 December (already agreed)",
        item: thread(c, "Christmas", [
          {
            from: c.user,
            to: mum,
            at: ago(16),
            body: ["Are you still happy to have the kids before Christmas? Work is mad until the 23rd."],
            corporate: false,
          },
          {
            from: mum,
            to: c.user,
            at: ago(15, 20),
            body: [
              "Of course love, it's in the diary: Maya and Theo with me from Saturday 19th to Christmas Eve.",
              "I've bought a new duvet for the little room and the panto tickets are for the 22nd.",
            ],
            corporate: false,
          },
        ]),
        decoy: thread(c, "Christmas", [
          {
            from: c.user,
            to: mum,
            at: ago(16),
            body: ["Are you still happy to have the kids before Christmas? Work is mad until the 23rd."],
            corporate: false,
          },
          {
            from: mum,
            to: c.user,
            at: ago(15, 20),
            body: [
              "I'd love to but the doctor says not until my hip's properly healed, so I can't this year.",
              "Book Maya and Theo into whatever club you need, love, and bring them for Boxing Day instead.",
            ],
            corporate: false,
          },
        ]),
      };
    },
  },
  {
    // Overlap: name only (Biscuit). Decoy (a): an earlier restriction that has ended.
    name: "biscuit-lead-rest",
    make: (c) => ({
      text: "Ask Priyanka at Paws Patrol to take Biscuit out with her lunchtime pack every day next week.",
      detail: "Biscuit is on strict lead rest after cruciate surgery on 21 October: 10-minute on-lead walks, no groups",
      item: notice(
        c,
        vets,
        "Discharge instructions: Biscuit",
        ago(5, 15),
        "Biscuit had his cruciate ligament repair today (Wednesday 21 October) and is recovering well.\n\nAftercare " +
          "for the next 4 weeks: strict lead rest. Short on-lead toilet walks of up to 10 minutes only; no off-lead " +
          "exercise, no group walks, no jumping on furniture. Keep the cone on.\n\nPost-op check: Wednesday 4 " +
          "November.\n\nRiverside Vets",
      ),
      decoy: notice(
        c,
        vets,
        "Recheck summary: Biscuit",
        ago(5, 15),
        "Biscuit came in today (Wednesday 21 October) for his recheck after the sprained paw earlier this month.\n\n" +
          "The paw has fully healed. The lead rest has ended and he can go back to normal exercise straight away, " +
          "including off-lead and group walks.\n\nNext appointment: annual booster in March.\n\nRiverside Vets",
      ),
    }),
  },
  {
    // Overlap: none. Decoy (b): the award is for a different child.
    name: "free-school-meals-awarded",
    make: (c) => {
      const council = bot("Islington Fields Council — Education Benefits", "edbenefits@islingtonfields.gov.uk");
      return {
        text: "Top up Maya's dinner account on ParentPay with £50.",
        detail: "Maya was awarded free school meals from 2 November; the council says not to top up",
        item: notice(
          c,
          council,
          "Free school meals: application FSM-30417 approved",
          ago(1, 2),
          "Dear Robin Carter,\n\nYour application has been approved. M. Carter (Holloway Primary, Year 3) is " +
            "eligible for free school meals from Monday 2 November.\n\nThe school has been told. You do not need to " +
            "add money for lunches from that date, and any remaining balance will be refunded at the end of term.\n\n" +
            "Education Benefits Team",
        ),
        decoy: notice(
          c,
          council,
          "Free school meals: application FSM-30417",
          ago(1, 2),
          "Dear Robin Carter,\n\nWe have assessed your application. T. Carter (Little Acorns Nursery) is eligible " +
            "for the early years pupil premium from Monday 2 November.\n\nM. Carter (Holloway Primary, Year 3) is " +
            "not eligible for free school meals; lunches continue to be paid in the usual way.\n\nEducation Benefits " +
            "Team",
        ),
      };
    },
  },
  {
    // Overlap: one topic word ("dehumidifier"). Decoy (c): the survey found nothing more needed.
    name: "dehumidifier-already-ordered",
    make: (c) => {
      const steve = c.role("landlord");
      return {
        text: "Buy a dehumidifier for Theo's bedroom, something under £200. The mould on the window wall is getting worse.",
        detail: "Steve already ordered a dehumidifier for the flat, arriving Thursday 29 October, and a damp survey",
        item: mail(
          c,
          steve,
          "Damp",
          ago(1, 4),
          [
            "Thanks for the photos.",
            "I've ordered a dehumidifier for the flat, it's being delivered to you on Thursday 29 October.",
            "A damp surveyor will come on 4 November as well. Please don't paint over anything before then.",
          ],
          false,
        ),
        decoy: mail(
          c,
          steve,
          "Damp",
          ago(1, 4),
          [
            "Thanks for the photos of the bedroom wall.",
            "The surveyor's report on the building came back: no rising or structural damp, it's condensation.",
            "Nothing more needed from my side; keep the windows cracked and run the extractor after showers.",
          ],
          false,
        ),
      };
    },
  },
  {
    // Overlap: none. Decoy (c): leave has already been approved.
    name: "term-time-leave-rules",
    make: (c) => {
      const daley = c.role("Maya's teacher");
      return {
        text:
          "Email Mrs Daley to say Maya will be off school on Thursday 19 and Friday 20 November because we're going " +
          "to Edinburgh.",
        detail:
          "Term-time leave must be requested from the Headteacher 4 weeks ahead; unauthorised leave risks £80 fines",
        item: notice(
          c,
          schoolOffice,
          "Attendance policy reminder",
          ago(21, 4),
          "Dear Families,\n\nA reminder of our attendance policy. Requests for leave in term time must be made to the " +
            "Headteacher using the Leave of Absence form at least four weeks beforehand. Class teachers cannot " +
            "authorise leave. Unauthorised absence of five or more sessions may result in a penalty notice of £80 " +
            "per parent from the local authority.\n\nThank you for your support.\nMr J. Fenwick, Headteacher",
        ),
        decoy: thread(c, "Leave of absence request", [
          {
            from: c.user,
            to: schoolOffice,
            at: ago(40),
            body: ["Please find attached our Leave of Absence form for Maya, for a family event in Scotland."],
            corporate: false,
          },
          {
            from: schoolOffice,
            to: c.user,
            at: ago(38, 2),
            body: [
              "Mr Fenwick has approved Maya's leave of absence for 19–20 November.",
              `Do just let ${daley.full} know nearer the time so she can send any work home.`,
            ],
            corporate: true,
          },
        ]),
      };
    },
  },
  {
    // Overlap: none. Decoy (c): the alternative account is unavailable, so pay as usual.
    name: "nursery-paid-via-tax-free",
    make: (c) => ({
      text: "Pay Little Acorns' November invoice of £1,140 from my current account today.",
      detail: "Alex already paid November's £1,140 via the Tax-Free Childcare account on Friday 23 October",
      item: chat("DM: Alex Carter", [
        { who: "Alex Carter", text: "fyi I've moved nursery onto Tax-Free Childcare", at: ago(4, 1) },
        { who: "Alex Carter", text: "govt adds 20% so it's a no brainer", at: ago(4, 1) },
        {
          who: "Alex Carter",
          text: "already paid November's £1,140 through it this morning, so DON'T pay it yourself",
          at: ago(4, 1),
        },
        { who: "Robin Carter", text: "oh nice, ok", at: ago(4) },
      ]),
      decoy: chat("DM: Alex Carter", [
        { who: "Alex Carter", text: "was going to move nursery onto the Tax-Free Childcare account", at: ago(4, 1) },
        { who: "Alex Carter", text: "but it's frozen until we reconfirm in January, annoying", at: ago(4, 1) },
        { who: "Alex Carter", text: "so keep paying from your account as usual for now", at: ago(4, 1) },
        { who: "Robin Carter", text: "ok will do", at: ago(4) },
      ]),
    }),
  },
  {
    // Overlap: none. Decoy (a): the appointment moved to another week.
    name: "breakfast-vs-fasting-blood-test",
    make: (c) => {
      const t = on(11, 5, 8, 40);
      const moved = on(11, 12, 8, 40);
      return {
        text: "Book breakfast with Jamie at The Larder, 8:30 on Thursday 5 November.",
        detail:
          "Fasting blood test at Parkside Surgery 08:40 Thursday 5 November (water only from 22:00 the night before)",
        item: event(
          "Blood test — Parkside Surgery",
          iso(t),
          "When: Thursday 5 Nov 2026, 08:40–08:55\nWhere: Parkside Surgery, 2 Elm Road\nAttendees: Robin Carter\n\n" +
            "Fasting: water only after 22:00 the night before. Bring the form from Dr Mensah.",
          ago(7),
        ),
        decoy: event(
          "Blood test — Parkside Surgery (moved from 5 Nov)",
          iso(moved),
          "When: Thursday 12 Nov 2026, 08:40–08:55\nWhere: Parkside Surgery, 2 Elm Road\nAttendees: Robin Carter\n\n" +
            "Rebooked from Thursday 5 November at the surgery's request. Fasting: water only after 22:00 the night " +
            "before.",
          ago(7),
        ),
      };
    },
  },
  {
    // Overlap: name only (Little Acorns). Decoy (b): the rule is for a different room.
    name: "snack-rota-sesame-free",
    make: (c) => ({
      text:
        "Sign me up for the Little Acorns snack rota for Squirrels room, week of 9 November. I'll bring hummus and " +
        "oatcakes.",
      detail: "Squirrels room is now sesame-free (a child has a severe sesame allergy), so no hummus",
      item: notice(
        c,
        nursery,
        "Allergy update — Squirrels",
        ago(4, 3),
        "Dear Squirrels families,\n\nA child in Squirrels has a severe sesame allergy. From Monday 2 November " +
          "Squirrels is sesame-free as well as nut-free: please check labels for tahini, sesame oil and seeds.\n\nThank " +
          "you for the conkers, the children have been counting them all week!\n\nThe Little Acorns Team",
      ),
      decoy: notice(
        c,
        nursery,
        "Allergy update — Hedgehogs",
        ago(4, 3),
        "Dear families,\n\nA child in Hedgehogs has a severe sesame allergy. From Monday 2 November the Hedgehogs " +
          "room only is sesame-free as well as nut-free. Squirrels and Badgers rooms are unchanged.\n\nThank you for " +
          "the conkers, the children have been counting them all week!\n\nThe Little Acorns Team",
      ),
    }),
  },
  {
    // Overlap: one topic word ("sofa"). Decoy (c): confirmed the sofa is the tenant's.
    name: "sofa-on-landlord-inventory",
    make: (c) => {
      const steve = c.role("landlord");
      return {
        text: "Book a council bulky waste collection for next Wednesday, 4 November, for the old sofa and Theo's cot.",
        detail: "The sofa belongs to the landlord (on the flat's inventory); Steve asked that it not be disposed of",
        item: thread(c, "Furniture", [
          {
            from: c.user,
            to: steve,
            at: ago(22),
            body: ["We're thinking of getting a new sofa. Is it OK if we get rid of the grey one?"],
            corporate: false,
          },
          {
            from: steve,
            to: c.user,
            at: ago(21, 19),
            body: [
              "Please don't, the grey sofa is mine and it's on the inventory for the flat.",
              "If you want your own, I can collect it and store it, just give me a couple of weeks' notice.",
            ],
            corporate: false,
          },
        ]),
        decoy: thread(c, "Furniture", [
          {
            from: c.user,
            to: steve,
            at: ago(22),
            body: ["We're thinking of getting a new sofa. Is it OK if we get rid of the grey one?"],
            corporate: false,
          },
          {
            from: steve,
            to: c.user,
            at: ago(21, 19),
            body: [
              "I checked the inventory and the grey sofa isn't on it, the previous tenant left it and signed it over.",
              "It's yours, do whatever you like with it.",
            ],
            corporate: false,
          },
        ]),
      };
    },
  },
];

/** Plants one item per template (the hidden item, or its near miss for the control) and returns the tasks. */
export function plantTrain2(world: World, seed: number, variant: Variant): HiddenTask[] {
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
      if (!p) throw new Error(`train2: ran out of ${relation} people`);
      return p;
    },
    role: (role) => world.people.find((p) => p.role === role)!,
  };
  const suite = variant === "hidden" ? "train2" : "train2-control";
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

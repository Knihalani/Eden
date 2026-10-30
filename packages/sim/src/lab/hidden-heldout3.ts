/**
 * Held-out hidden-context tasks, personal-life domain (third set).
 *
 * Each template is a request from the user to do something whose right answer turns on a fact the request never
 * mentions, stored in one planted item. The "control" variant plants a near-miss decoy instead: same people, source
 * and topic, but the deciding fact is changed so the plan should stand. A careless answer raises the decoy's
 * `falseClaim`; a good one stays quiet about it.
 */
import { Rng } from "../rng";
import type { Person, World, WorldItem } from "../world";

export interface HiddenTask {
  id: string;
  template: string;
  text: string;
  detail: string;
}

interface Planted {
  sourceId: string;
  kind: WorldItem["kind"];
  title: string;
  text: string;
  meta?: Record<string, string>;
}

const who = (p: Person) => `${p.full} <${p.email}>`;

/** What the user calls a person in a casual request. */
const call = (p: Person) => p.nick ?? p.first;
/** How the user refers to a relative ("my mum"); anyone else by name, since a fallback pick may be a colleague. */
const refer = (p: Person) => (p.relation === "family" && p.role ? `my ${p.role}` : call(p));

/** A sender that is not one of the world's people (a clinic, a school office, a shop). */
function service(first: string, last: string, email: string, org: string): Person {
  return { id: `heldout3-${email}`, full: `${first} ${last}`, first, last, email, relation: "service", org };
}

/** The user's child (the world has "Maya's teacher"). */
const KID = "Maya";
const RESTAURANTS = ["Bellweather", "The Copper Pot", "Osteria Lume", "Saffron House", "The Mill Kitchen"];
const CITIES = ["Lisbon", "Porto", "Seville", "Copenhagen", "Ljubljana"];
const BANDS = ["The Lanterns", "Marsh Harbour", "Velvet Coast", "Northern Static"];

const TEMPLATES: {
  name: string;
  roles: Person["relation"][];
  make: (
    ps: Person[],
    user: Person,
    rng: Rng,
  ) => { text: string; item: Planted; detail: string; decoy: Planted; falseClaim: string };
}[] = [
  {
    // Someone's constraint (diet), told in passing in a family email.
    name: "family-dinner-coeliac",
    roles: ["family"],
    make: ([p]) => {
      const r = refer(p!);
      return {
        text: `Book us somewhere nice for dinner on Saturday with ${r}, around 7.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: "Results from the clinic",
          text:
            `Hi love, quick update since you asked. The blood test came back and it's coeliac disease, so no ` +
            `wheat, barley or rye from now on, and the consultant says even a shared fryer or a dusting of flour ` +
            `can set it off. It's a lot to get used to but I'm feeling better already. Speak soon, ${p!.first}`,
          meta: { people: who(p!) },
        },
        detail:
          `${p!.full} was diagnosed with coeliac disease and must avoid all gluten, including cross-contamination, ` +
          `so the restaurant has to handle a strict gluten-free meal.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: "Results from the clinic",
          text:
            `Hi love, quick update since you asked. The blood test came back clear, they tested for coeliac and ` +
            `it's negative, so the tummy trouble was just that bug going round. Eating everything again, bread ` +
            `included! Speak soon, ${p!.first}`,
          meta: { people: who(p!) },
        },
        falseClaim: `Says the Saturday dinner must be gluten-free because ${p!.first} is coeliac.`,
      };
    },
  },
  {
    // School closed on the day named: a staff training day in the school newsletter.
    name: "school-pickup-inset-day",
    roles: [],
    make: () => {
      const kid = KID;
      const office = service("Hollins Park", "Office", "office@hollinspark.sch.example", "Hollins Park Primary");
      const body = (day: string) =>
        `Dear parents and carers, a reminder that ${day} is a staff training (INSET) day and the school will be ` +
        `closed to all pupils. Breakfast club and after-school club will not run. Year 3 swimming resumes the ` +
        `following week. With thanks, Hollins Park Primary School Office`;
      return {
        text: `let the kids' school know i'll be doing pickup for ${kid} myself on friday, not the childminder`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: "Reminder: staff training day",
          text: body("Friday 30 October"),
          meta: { people: who(office) },
        },
        detail:
          "Friday 30 October is an INSET day at Hollins Park Primary, so the school is closed and there is no " +
          "pickup that day.",
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: "Reminder: staff training day",
          text: body("Friday 13 November"),
          meta: { people: who(office) },
        },
        falseClaim: "Says the school is closed this Friday for a staff training day.",
      };
    },
  },
  {
    // Appointment moved: the calendar entry already sits on a different day.
    name: "dentist-moved",
    roles: [],
    make: () => ({
      text: "Can you confirm my dentist appointment on Thursday morning?",
      item: {
        sourceId: "calendar",
        kind: "event",
        title: "Dental check-up (moved from Thu)",
        text:
          "Check-up and scale & polish at Brookside Dental. Rescheduled by the practice from Thursday " +
          "29 October because the hygienist is off; now Friday 30 October at 14:40.",
        meta: { start: "2026-10-30T14:40:00.000Z" },
      },
      detail:
        "The practice moved the dental check-up from Thursday 29 October to Friday 30 October at 14:40, so there " +
        "is nothing on Thursday to confirm.",
      decoy: {
        sourceId: "calendar",
        kind: "event",
        title: "Dental check-up",
        text:
          "Check-up and scale & polish at Brookside Dental, Thursday 29 October at 10:20. Note: the " +
          "practice has moved its reception entrance round to Mill Lane.",
        meta: { start: "2026-10-29T10:20:00.000Z" },
      },
      falseClaim: "Says the Thursday dental appointment has been moved to another day.",
    }),
  },
  {
    // Document expired before the trip: noted in a drive doc of household paperwork.
    name: "trip-passport-expiry",
    roles: ["friend"],
    make: ([p], _user, rng) => {
      const city = rng.pick(CITIES);
      const doc = (expiry: string) =>
        `Household paperwork. Robin's passport: no. 5481 07733, issued 14 Nov 2016, expires ${expiry}. ` +
        `Driving licence: renewed 2024. EHIC/GHIC: valid to 2029. Home insurance: Aviva, renews March. ` +
        `Birth certificates in the blue folder, top drawer.`;
      return {
        text: `find me and ${call(p!)} flights to ${city} for the weekend of the 21st of november`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: "Household paperwork & IDs",
          text: doc("2 Nov 2026"),
        },
        detail: "Robin's passport expires on 2 November 2026, before a 21 November trip, so it must be renewed first.",
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: "Household paperwork & IDs",
          text: doc("2 Nov 2029"),
        },
        falseClaim: "Warns that Robin's passport expires before the November trip.",
      };
    },
  },
  {
    // Price changed: the landlord announced a rent rise starting this month.
    name: "rent-increase",
    roles: [],
    make: (_ps, _user, rng) => {
      const landlord = service("Gareth", "Pryce", "gareth.pryce@example.net", "Pryce Lettings");
      const old = rng.pick([1450, 1550, 1650]);
      const raised = old + rng.pick([60, 75, 90]);
      return {
        text: "Set up November's rent payment to my landlord, same as usual.",
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: "Tenancy: notice of change from 1 November",
          text:
            `Hi Robin, writing as managing agent for your landlord. As agreed at the inspection, and per the ` +
            `notice I sent in September, the monthly amount goes from £${old} to £${raised} starting with the ` +
            `1 November payment. Bank details are unchanged. ` +
            `Thanks for being a great tenant. Gareth`,
          meta: { people: who(landlord) },
        },
        detail: `The rent rises from £${old} to £${raised} from the 1 November payment, so "same as usual" is wrong.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: "Tenancy: renewal for next year",
          text:
            `Hi Robin, writing as managing agent for your landlord. They're happy to renew for another twelve ` +
            `months and are keeping the monthly amount at £${old}, no change. Bank details are unchanged. Thanks ` +
            `for being a great tenant. Gareth`,
          meta: { people: who(landlord) },
        },
        falseClaim: "Says November's rent has gone up from the usual amount.",
      };
    },
  },
  {
    // Wrong address: the recipient moved last month.
    name: "flowers-new-address",
    roles: ["family"],
    make: ([p]) => ({
      text: `send ${call(p!)} some flowers to say congrats on the new job, to their place`,
      item: {
        sourceId: "gmail",
        kind: "mail",
        title: "Keys!!",
        text:
          `We finally got the keys! Moved in on the 10th, so from now on it's 14 Larch Close, Didsbury, M20 6RT. ` +
          `The old flat on Wilmslow Road is handed back, so nothing there will reach us. Come and see it soon. ` +
          `${p!.first}`,
        meta: { people: who(p!) },
      },
      detail:
        `${p!.full} moved on 10 October to 14 Larch Close, Didsbury, M20 6RT; deliveries to the old Wilmslow Road ` +
        `flat will not reach them.`,
      decoy: {
        sourceId: "gmail",
        kind: "mail",
        title: "Keys!!",
        text:
          `We viewed a house on Larch Close in Didsbury and loved it, but the chain is a mess so nothing will ` +
          `happen before spring. Still at the Wilmslow Road flat for now, same as ever. ${p!.first}`,
        meta: { people: who(p!) },
      },
      falseClaim: `Says ${p!.first} has moved, so the flowers must go to a new address.`,
    }),
  },
  {
    // A surprise not to spoil: the friend's surprise party is the same evening.
    name: "drinks-surprise-party",
    roles: ["friend", "family"],
    make: ([f, fam]) => {
      const body = (date: string) =>
        `Right, it's happening: ${f!.first}'s surprise 40th at ours, ${date} from 7pm. ${f!.first} has NO idea, ` +
        `so don't book anything with them that night and don't mention it. Can you bring ice and a cake knife? ` +
        `${fam!.first}`;
      return {
        text: `Send ${f!.first} an invite for drinks Saturday evening, just the two of us.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: "Shh, the plan",
          text: body("Saturday 31 October"),
          meta: { people: who(fam!) },
        },
        detail:
          `${fam!.full} is throwing ${f!.full} a surprise 40th on Saturday 31 October from 7pm; inviting ` +
          `${f!.first} out that evening would clash with it and risk spoiling the surprise.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: "Shh, the plan",
          text: body("Saturday 14 November"),
          meta: { people: who(fam!) },
        },
        falseClaim: `Says Saturday evening is taken by a surprise party for ${f!.first}.`,
      };
    },
  },
  {
    // Someone away: the friend's trip is in the calendar for exactly that weekend.
    name: "cat-feeding-friend-away",
    roles: ["friend"],
    make: ([p]) => ({
      text: `Ask ${call(p!)} if they can pop in and feed the cat while we're away next weekend.`,
      item: {
        sourceId: "calendar",
        kind: "event",
        title: `${p!.first} away (Skye)`,
        text: `${p!.full} is in Skye, Friday 6 to Monday 9 November, no signal most of the time.`,
        meta: { start: "2026-11-06T08:00:00.000Z" },
      },
      detail: `${p!.full} is away on Skye from Friday 6 to Monday 9 November, so cannot feed the cat next weekend.`,
      decoy: {
        sourceId: "calendar",
        kind: "event",
        title: `${p!.first} away (Skye)`,
        text: `${p!.full} is in Skye, Friday 20 to Monday 23 November, no signal most of the time.`,
        meta: { start: "2026-11-20T08:00:00.000Z" },
      },
      falseClaim: `Says ${p!.first} is away next weekend and can't feed the cat.`,
    }),
  },
  {
    // Plan changed: the gym is retiring the user's plan.
    name: "gym-plan-discontinued",
    roles: [],
    make: () => {
      const gym = service("Pulse", "Membership", "members@pulsefitness.example", "Pulse Fitness");
      return {
        text: "renew my gym membership, same plan as this year",
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: "Changes to your Pulse membership",
          text:
            "Hello Robin, from 1 November we are retiring the Off-Peak plan. Members renewing after that date move " +
            "to Standard at £54 a month (currently £38 on Off-Peak) unless they choose another option. Your " +
            "membership is due for renewal on 4 November. The Pulse Team",
          meta: { people: who(gym) },
        },
        detail:
          "Pulse is retiring the Off-Peak plan from 1 November, so the 4 November renewal cannot be on the same " +
          "plan and defaults to Standard at £54 a month instead of £38.",
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: "Your Pulse membership for 2027",
          text:
            "Hello Robin, good news: Off-Peak stays at £38 a month for 2027 with no changes to access hours. Your " +
            "membership is due for renewal on 4 November and you can renew in the app or at reception. The " +
            "Pulse Team",
          meta: { people: who(gym) },
        },
        falseClaim: "Says the gym's Off-Peak plan is being withdrawn or its price is changing.",
      };
    },
  },
  {
    // Already bought: the friend got both tickets.
    name: "gig-tickets-already-bought",
    roles: ["friend"],
    make: ([p], _user, rng) => {
      const band = rng.pick(BANDS);
      return {
        text: `Grab two tickets for ${band} at the Roundhouse on 14 November, for me and ${p!.first}.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: `${band}!!`,
          text:
            `Got them!! Two standing for the 14th, I was in the queue at 9 sharp. They're both on my app, I'll ` +
            `forward yours. You owe me £42, no rush. ${p!.first}`,
          meta: { people: who(p!) },
        },
        detail:
          `${p!.full} already bought two tickets for ${band} on 14 November, one for Robin (Robin owes £42), so ` +
          `buying more would double up.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: `${band}!!`,
          text:
            `Got mine!! Standing for the 14th, I was in the queue at 9 sharp. Only managed one before the basket ` +
            `timed out, so grab yours quick before they go. ${p!.first}`,
          meta: { people: who(p!) },
        },
        falseClaim: `Says ${p!.first} has already bought Robin's ticket for the gig.`,
      };
    },
  },
  {
    // Mobility: a relative is recovering from surgery (drive note).
    name: "family-day-out-mobility",
    roles: ["family"],
    make: ([p]) => {
      const r = refer(p!);
      return {
        text: `Plan a day out with ${r} on Sunday, maybe a good walk somewhere and then a pub lunch.`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: `${p!.first}: knee op notes`,
          text:
            `Knee replacement done 15 Oct at St Anne's. Discharge notes: on crutches for about six weeks, no ` +
            `walking more than a couple of hundred metres, avoid stairs and uneven ground. Physio Tuesdays. ` +
            `Blue badge application sent.`,
        },
        detail:
          `${p!.full} had a knee replacement on 15 October and is on crutches for about six weeks, limited to a ` +
          `couple of hundred metres on level ground, so a long walk is out.`,
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: `${p!.first}: knee op notes`,
          text:
            `Knee replacement booked for 18 Dec at St Anne's. Pre-op notes: keep walking as normal until then, ` +
            `the more the better, it helps recovery. Pre-op assessment 2 Dec. Arrange lifts for after the op.`,
        },
        falseClaim: `Says ${p!.first} can't manage a long walk because of a knee operation.`,
      };
    },
  },
  {
    // Already arranged: the insurance renews itself by direct debit (bills tracker in drive).
    name: "car-insurance-autorenew",
    roles: [],
    make: (_ps, _user, rng) => {
      const amount = `£${rng.int(480, 690)}.${String(rng.int(10, 99))}`;
      const policy = `HD-${rng.token("0123456789", 6)}`;
      const line = (setting: string) =>
        `Bills & renewals 2026. Car insurance (Haven Direct, policy ${policy}): renews ` +
        `3 Nov, ${amount} for the year. ${setting} Broadband: Fibrely, £32/month, contract ends Feb. Council tax: ` +
        `10 instalments, DD on the 1st. TV licence: paid Aug.`;
      const auto = line("Auto-renew ON, taken by direct debit on 3 Nov, don't pay it manually.");
      const manual = line("Auto-renew OFF (switched off last year), has to be paid by hand before 3 Nov.");
      return {
        text: "Pay the car insurance renewal please.",
        item: { sourceId: "drive", kind: "doc", title: "Bills & renewals 2026", text: auto },
        detail:
          `The car insurance auto-renews by direct debit on 3 November (${amount}), so paying it manually would ` +
          `pay twice.`,
        decoy: { sourceId: "drive", kind: "doc", title: "Bills & renewals 2026", text: manual },
        falseClaim: "Says the car insurance renews automatically by direct debit, so no payment is needed.",
      };
    },
  },
  {
    // A clash: a child's swimming gala sits in the calendar at the same time.
    name: "bbq-clash-gala",
    roles: ["friend"],
    make: ([p]) => {
      const kid = KID;
      const gala = (start: string, day: string) => ({
        sourceId: "calendar",
        kind: "event" as const,
        title: `${kid}: county swimming gala`,
        text: `${kid} swimming in the county gala at Crystal Leisure Centre, ${day} 12:30 to 16:00. Parents stay.`,
        meta: { start },
      });
      return {
        text: `tell ${p!.first} yes, we'll come to the barbecue saturday at 1`,
        item: gala("2026-10-31T12:30:00.000Z", "Saturday 31 October"),
        detail:
          `${kid}'s county swimming gala is on Saturday 31 October from 12:30 to 16:00, clashing with the 1pm ` +
          `barbecue.`,
        decoy: gala("2026-11-07T12:30:00.000Z", "Saturday 7 November"),
        falseClaim: `Says Saturday's barbecue clashes with ${kid}'s swimming gala.`,
      };
    },
  },
  {
    // A sensitivity and an absence: a colleague's bereavement, said in a Slack DM.
    name: "pub-quiz-bereavement",
    roles: ["colleague"],
    make: ([p]) => ({
      text: `Message ${p!.first} and see if they fancy the pub quiz on Thursday, keep it light.`,
      item: {
        sourceId: "slack",
        kind: "chat",
        title: `DM with ${p!.first}`,
        text:
          `${p!.first}: Hi Robin, letting a few people know directly. My mum died on Sunday, very suddenly. I'm ` +
          `on compassionate leave until 9 November and won't be checking much. The funeral is Friday. Thanks for ` +
          `understanding.`,
        meta: { people: who(p!) },
      },
      detail:
        `${p!.full}'s mother died on Sunday and they are on compassionate leave until 9 November, funeral on ` +
        `Friday, so a light-hearted pub-quiz invite is badly timed.`,
      decoy: {
        sourceId: "slack",
        kind: "chat",
        title: `DM with ${p!.first}`,
        text:
          `${p!.first}: Hi Robin, sorry I was slow on the thread yesterday. My mum had a minor op on Sunday, all ` +
          `went fine and she's home already. I'm in all week as normal.`,
        meta: { people: who(p!) },
      },
      falseClaim: `Says ${p!.first} is bereaved or on leave, so an invite would be insensitive.`,
    }),
  },
  {
    // A constraint on the recipient: their employer bans gifts (CRM contact note).
    name: "client-hamper-gift-policy",
    roles: ["client"],
    make: ([p]) => {
      const org = p!.org ?? "their company";
      return {
        text: `Send ${p!.first} a nice hamper to say thanks for this year.`,
        item: {
          sourceId: "crm",
          kind: "contact",
          title: `${p!.full} (${org})`,
          text:
            `${p!.full}, ${org}. Notes: ${org} has a strict no-gifts policy for staff since the procurement audit; ` +
            `anything sent gets returned and logged. A card or a thank-you email is fine.`,
          meta: { people: who(p!) },
        },
        detail:
          `${org} does not let ${p!.full} accept gifts (items are returned and logged), so send a card or ` +
          `thank-you note instead of a hamper.`,
        decoy: {
          sourceId: "crm",
          kind: "contact",
          title: `${p!.full} (${org})`,
          text:
            `${p!.full}, ${org}. Notes: ${org}'s gifts policy allows staff to accept gifts up to £75 without ` +
            `declaring them; prefers vegetarian food. Birthday in March.`,
          meta: { people: who(p!) },
        },
        falseClaim: `Says ${org}'s policy forbids ${p!.first} from accepting a gift.`,
      };
    },
  },
];

export function plantHeldout3(world: World, seed: number, variant: "hidden" | "control" = "hidden"): HiddenTask[] {
  const rng = new Rng(seed * 3_000_017);
  const pool = world.people.filter((p) => p.relation !== "self");
  const used = new Set<string>();
  const tasks: HiddenTask[] = [];
  TEMPLATES.forEach((t, i) => {
    const ps = t.roles.map((relation) => {
      let candidates = pool.filter((p) => p.relation === relation && !used.has(p.id));
      if (candidates.length === 0) candidates = pool.filter((p) => !used.has(p.id));
      if (candidates.length === 0) candidates = pool;
      const p = rng.pick(candidates);
      used.add(p.id);
      return p;
    });
    // Called once per template whatever the variant, so both variants draw the same rng sequence.
    const out = t.make(ps, world.user, rng);
    const chosen = variant === "hidden" ? out.item : out.decoy;
    const ref = `heldout3-${i}`;
    world.items.push({
      id: `${chosen.sourceId}:${ref}`,
      sourceId: chosen.sourceId,
      ref,
      title: chosen.title,
      text: chosen.text,
      updatedAt: world.now - 86_400_000,
      kind: chosen.kind,
      facts: [],
      noise: false,
      ...(chosen.meta ? { meta: chosen.meta } : {}),
    });
    tasks.push({
      id: variant === "hidden" ? `w${seed}:heldout3:${t.name}` : `w${seed}:heldout3-control:${t.name}`,
      template: t.name,
      text: out.text,
      detail: variant === "hidden" ? out.detail : out.falseClaim,
    });
  });
  return tasks;
}

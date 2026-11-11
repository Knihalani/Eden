/**
 * Rarely used connectors (P7, B5 in docs/research/weak-points-1111.md): a user's long tail of sources beside the
 * world's five, each holding a handful of old, ordinary items. The world's five sources are where nearly every fact
 * in the lab sits; a real user also connects a notes app, a messenger, a bank, a patient app, a school app, a travel
 * app, a residents' portal and a to-do list, and reads them rarely. A fact that sits in one of them is what the
 * weekly sweep and any dormancy rule (D602) decide about, so a suite that plants there can price those rules.
 *
 * `addRareSources` registers all eight in `world.sources` and adds their filler items, deterministically per seed and
 * with a generator of its own (the world's other draws do not move). A suite that plants in a rare source calls it in
 * every variant, so `hidden`, `control` and `neutral` see the same connector list. Each source takes the latency and
 * search profile of the world source it is most like (`like`): `sourcesFor` falls back to it. Simulated data only.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "./rng";
import type { ItemKind, World, WorldItem } from "./world";

export interface RareSource {
  /** What the connector says it is (a world source's one-sentence description). */
  description: string;
  /** The world source whose search and latency profile it borrows (`sources.ts` profile sets). */
  like: "gmail" | "calendar" | "drive" | "crm" | "slack";
  /** The kind of item it holds. */
  kind: ItemKind;
}

export const RARE_SOURCES: Record<string, RareSource> = {
  notes: { description: "The user's personal notes app (Apple Notes)", like: "drive", kind: "doc" },
  whatsapp: { description: "The user's personal messages (WhatsApp)", like: "slack", kind: "chat" },
  bank: {
    description: "The user's bank app: statements, alerts and secure messages (Monzo)",
    like: "gmail",
    kind: "notification",
  },
  health: {
    description: "The user's GP practice app: appointments, prescriptions and messages (NHS App)",
    like: "gmail",
    kind: "notification",
  },
  school: {
    description: "The children's school parent app: letters and messages (ParentMail)",
    like: "gmail",
    kind: "mail",
  },
  trips: { description: "The user's travel bookings and itineraries (TripIt)", like: "drive", kind: "doc" },
  residents: {
    description: "The building's residents' portal: notices from the managing agent (Rendall & Rittner)",
    like: "drive",
    kind: "doc",
  },
  tasks: { description: "The user's to-do list (Todoist)", like: "drive", kind: "doc" },
};
export const RARE_SOURCE_IDS = Object.keys(RARE_SOURCES);

const DAY = 86_400_000;

/** Ordinary filler for each rare source: titles and texts that carry nothing a request would need. */
const FILLER: Record<string, [string, string][]> = {
  notes: [
    ["Shopping", "oat milk, eggs, coriander, bin bags, AA batteries, birthday card"],
    ["Book recommendations", "The Overstory; Piranesi; Small Things Like These (from the book club); Tomorrow x3"],
    ["Wifi at mum's", "network is on the router sticker, the 5G one drops upstairs"],
    ["Gift ideas", "nice olive oil, a plant for the hall, that board game with the trains, concert vouchers"],
    ["Paint colours", "living room: Farrow & Ball Skimming Stone; hallway: the lighter grey from the tester pots"],
    ["Recipes to try", "miso aubergine, the lentil soup from the cafe, banana bread with less sugar"],
    ["Bike", "front brake squeaks; tyre pressure 60 psi; the shop on the high street does a free check in spring"],
    ["Ideas for the garden", "raised bed by the fence, move the rosemary, ask next door about the ivy"],
  ],
  whatsapp: [
    ["Family group", "Mum: did everyone get home ok?\nDad: yes thanks, roads were clear"],
    ["Five-a-side", "anyone got a spare bib? we were one short last week"],
    ["Book club", "next one is the short Irish novel, 80 pages, no excuses"],
    ["Neighbours", "parcel for no. 11 left with me if anyone's looking for it"],
    ["Uni friends", "photos from the weekend are in the shared album"],
    ["Cousins", "happy birthday Sam!! 🎉"],
    ["Running club", "Sunday long run from the park gates, 8am, 10k easy"],
    ["Allotment", "the water butts are full again, thanks to whoever fixed the tap"],
  ],
  bank: [
    ["Your statement is ready", "Your monthly statement for your current account is now available in the app."],
    ["Pot update", "You moved money into your Holiday pot. Your pot is 64% of the way to its goal."],
    ["Direct debit set up", "A new direct debit to Thames Water has been set up on your account."],
    ["Card used abroad", "Your card was used in a currency other than pounds. No fees were charged."],
    ["Savings interest paid", "Interest has been paid into your Instant Access savings account."],
    ["Your annual summary", "Here's your spending summary for the year. Groceries were your biggest category."],
    ["App update", "We've updated the app with a new look for your transactions list."],
  ],
  health: [
    ["Your flu vaccination", "Flu vaccinations are now available at the practice for eligible patients. Book online."],
    ["Practice newsletter", "We are recruiting a new practice nurse. Opening hours are unchanged over the summer."],
    ["Test results", "Your recent blood test results have been reviewed. No further action is needed."],
    ["Appointment reminder", "Reminder of your past appointment with the practice nurse. Please rate your visit."],
    ["Online consultation received", "We have received your online consultation and will reply within two days."],
    ["Change to opening hours", "The practice will close at 1pm on the second Wednesday of each month for training."],
  ],
  school: [
    ["Harvest festival", "Thank you for the generous donations to the food bank this year."],
    ["Lost property", "Lost property will be on display in the hall on Friday afternoon. Please label uniform."],
    ["Parents' association", "The PA is looking for volunteers to help run the summer fair cake stall."],
    ["Reading at home", "Please keep reading with your child for ten minutes a day and sign the reading record."],
    ["Uniform shop", "The second-hand uniform shop is open on Thursdays after school in the small hall."],
    ["Term dates", "The term dates for next year are now on the school website."],
    ["Headteacher's newsletter", "Year 4 enjoyed their trip to the science museum. Well done to the chess team."],
  ],
  trips: [
    ["Lisbon, May", "Flight TP1351 London to Lisbon. Hotel Alfama Patio, 3 nights. Confirmation 88213."],
    ["Edinburgh weekend", "Train King's Cross to Edinburgh Waverley, coach C, seats 41-42. Airbnb in Leith."],
    ["Cornwall, August", "Cottage in St Ives, 7 nights. Key safe code sent by the owner a week before."],
    ["Amsterdam work trip", "Eurostar via Brussels. Hotel near Centraal, 2 nights. Expenses to submit after."],
    ["Copenhagen, last spring", "SAS flight from Heathrow; hostel near Nørreport; bike hire booked on arrival."],
    ["Lake District", "Car hire from Penrith station, YHA Ambleside, 4 nights. Return train Sunday."],
  ],
  residents: [
    ["Bin collection changes", "Recycling is now collected every other Tuesday. Please flatten boxes."],
    ["Communal garden", "The gardeners will visit on the first Monday of each month. Please keep paths clear."],
    ["Bike store", "A new bike store key system is in place. Collect your fob from the concierge."],
    ["Service charge budget", "The service charge budget for the year is attached for information."],
    ["Fire safety", "The annual fire alarm test is complete. No issues were found in your block."],
    ["Parcel room", "Parcels uncollected after 14 days will be returned to the sender."],
  ],
  tasks: [
    ["Renew passport", "check the photo rules; the form is on gov.uk"],
    ["Clear out the loft", "charity shop run for the old books and the spare duvet"],
    ["Fix the dripping tap", "washer size? the hardware shop will know"],
    ["Back up the laptop", "external drive is in the desk drawer"],
    ["Call the council about the pothole", "outside no. 23, reported once already"],
    ["Sort photos from the summer", "pick 20 for the album"],
    ["Cancel the unused gym class", "the Tuesday one clashes with work anyway"],
  ],
};

/**
 * Register the eight rare sources in `world.sources` (if not there yet) and add their filler items at the end of
 * `world.items`: 6-8 items each, dated 20-200 days before `world.now`. Idempotent per world. Returns the items added.
 */
export function addRareSources(world: World, seed: number): WorldItem[] {
  if (RARE_SOURCE_IDS.every((id) => id in world.sources)) return [];
  const r = new Rng(seed * 104_723 + 31);
  const added: WorldItem[] = [];
  // A copy: buildWorld hands every world the one shared SOURCES object.
  world.sources = { ...world.sources };
  for (const id of RARE_SOURCE_IDS) {
    const src = RARE_SOURCES[id]!;
    world.sources[id] = src.description;
    for (const [title, text] of FILLER[id]!) {
      const ref = `${src.kind}-${world.items.length}`;
      const item: WorldItem = {
        id: itemId(id, ref),
        sourceId: id,
        ref,
        title,
        text,
        updatedAt: world.now - r.int(20, 200) * DAY - r.int(0, 23) * 3_600_000,
        kind: src.kind,
        facts: [],
        noise: true,
      };
      world.items.push(item);
      added.push(item);
    }
  }
  return added;
}

/**
 * brain-holdout: held-out BrainMemory retrieval gate.
 *
 * Data is generated from a seeded PRNG (SEED below) over five domains that
 * brain-opt / memory-bakeoff do not cover (clinic ops, travel logistics,
 * household, finance/invoicing, sports club) and seven query styles
 * (exact, paraphrase, update, multihop, numeric, negation, distractor).
 * 20-30% of target facts are "buried" inside a 20+ message noise session.
 *
 * Scoring mirrors brain-opt:
 *   miss   = gold regex not matched in BrainMemory.retrieve(q, K) top-K text
 *   junk   = an off-topic probe gets a system memory injected (nothing should fire)
 *   losses = update queries where the stale value outranks / displaces the new one
 *   ms     = p50 retrieve() latency, rounded
 *
 * stdout (machine lines first):
 *   holdout_miss: N
 *   holdout_junk: N
 *   holdout_losses: N
 *   holdout_ms: N
 * then a per-domain / per-style breakdown for humans.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../src/index";
import { BrainMemory } from "../../src/brain-memory";

const SEED = Number(process.env.EDEN_HOLDOUT_SEED || "20260909");
const K = Number(process.env.EDEN_HOLDOUT_K || "5");
const WORLDS_PER_DOMAIN = Number(process.env.EDEN_HOLDOUT_WORLDS || "6");
const ROOT = mkdtempSync(join(tmpdir(), "brain-holdout-"));

// ---------- seeded PRNG ----------
let seed = SEED >>> 0;
function rnd(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
function sample<T>(a: readonly T[], n: number): T[] {
  return shuffle([...a]).slice(0, n);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- domains ----------
type Style = "exact" | "paraphrase" | "update" | "multihop" | "numeric" | "negation" | "distractor";
type Fact = { text: string; buried?: boolean; late?: boolean };
type Query = { q: string; want: RegExp; style: Style; stale?: RegExp; facts: Fact[] };
type Gen = (people: string[]) => Query;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIMES = ["08:15", "09:40", "11:05", "13:30", "15:45", "17:20", "18:50"];
const TZS = ["CET", "JST", "AEST", "BRT", "GMT", "IST", "EAT", "HKT"];

type Domain = { name: string; people: string[]; noise: string[]; gens: Record<Style, Gen[]> };

function pairQuery(
  style: Style,
  text: string,
  q: string,
  want: string | RegExp,
  extra: Partial<Query> = {},
): Query {
  return { style, facts: [{ text }], q, want: typeof want === "string" ? new RegExp(esc(want), "i") : want, ...extra };
}

const clinic: Domain = {
  name: "clinic",
  people: ["Thandiwe", "Bartholomew", "Ingrid", "Rafaela", "Ozan", "Priyanka", "Leopold", "Yusra", "Casimir", "Marisol", "Ebele", "Fionnuala"],
  noise: [
    "the waiting room printer is jammed again",
    "can someone restock the gloves in bay two",
    "reminder to log your lunch breaks in the rota",
    "the vending machine only takes coins now",
    "front desk phone keeps ringing off the hook",
    "does anyone know where the spare thermometer went",
    "the parking gate was stuck open this morning",
    "we ran out of biscuits in the staff kitchen",
    "the fridge in the lab is making a humming noise",
    "who left the window open in the break room",
    "morning huddle ran long today",
    "the new scrubs order still has not arrived",
    "please label your food in the fridge",
    "anyone want to swap a shift next week",
    "lift is out of service until tomorrow",
  ],
  gens: {
    exact: [
      (P) => { const p = pick(P), d = pick(["Okonkwo", "Halvorsen", "Petrakis", "Nakagawa", "Sowande"]); return pairQuery("exact", `${p} is seen by Dr. ${d}.`, `Who is ${p}'s doctor?`, d); },
      (P) => { const p = pick(P), a = pick(["penicillin", "sulfa drugs", "latex", "codeine", "ibuprofen"]); return pairQuery("exact", `${p} is allergic to ${a}.`, `What is ${p} allergic to?`, a.split(" ")[0]!); },
    ],
    paraphrase: [
      (P) => { const p = pick(P), d = pick(["Okonkwo", "Halvorsen", "Petrakis", "Nakagawa", "Sowande"]); return pairQuery("paraphrase", `${p} is seen by Dr. ${d}.`, `Which physician treats ${p}?`, d); },
      (P) => { const p = pick(P), a = pick(["penicillin", "sulfa drugs", "latex", "codeine", "ibuprofen"]); return pairQuery("paraphrase", `${p} is allergic to ${a}.`, `Which medication must ${p} avoid?`, a.split(" ")[0]!); },
    ],
    update: [
      (P) => { const p = pick(P), [t1, t2] = sample(TIMES, 2) as [string, string]; return { style: "update", facts: [{ text: `${p}'s follow-up is at ${t1}.` }, { text: `${p}'s follow-up moved to ${t2}.`, late: true }], q: `When is ${p}'s follow-up?`, want: new RegExp(esc(t2)), stale: new RegExp(esc(t1)) }; },
      (P) => { const p = pick(P), [d1, d2] = sample(["Okonkwo", "Halvorsen", "Petrakis", "Nakagawa", "Sowande"], 2) as [string, string]; return { style: "update", facts: [{ text: `${p} is seen by Dr. ${d1}.` }, { text: `${p} has been transferred to Dr. ${d2}.`, late: true }], q: `Who is ${p}'s doctor now?`, want: new RegExp(d2, "i"), stale: new RegExp(d1, "i") }; },
    ],
    multihop: [
      (P) => { const p = pick(P), d = pick(["Okonkwo", "Halvorsen", "Petrakis", "Nakagawa", "Sowande"]), r = pick(["2A", "3C", "4B", "5D", "6F"]); return { style: "multihop", facts: [{ text: `${p} is seen by Dr. ${d}.` }, { text: `Dr. ${d} works out of room ${r}.` }], q: `Which room should ${p} go to for their appointment?`, want: new RegExp(`\\b${r}\\b`) }; },
    ],
    numeric: [
      (P) => { const p = pick(P), n = 15 + 5 * Math.floor(rnd() * 12); return pairQuery("numeric", `${p}'s copay is $${n}.`, `How much is ${p}'s copay?`, new RegExp(`\\$?${n}\\b`)); },
      (P) => { const p = pick(P), t = pick(TIMES), d = pick(DAYS); return pairQuery("numeric", `${p}'s follow-up is at ${t} on ${d}.`, `What time is ${p}'s follow-up?`, new RegExp(esc(t))); },
    ],
    negation: [
      (P) => { const p = pick(P); return pairQuery("negation", `${p} has no known drug allergies.`, `Does ${p} have any allergies?`, /no known|none|no allerg/i); },
      (P) => { const p = pick(P); return pairQuery("negation", `${p} is not fasting before the blood draw.`, `Is ${p} fasting for the blood test?`, /not fasting|isn't fasting|no/i); },
    ],
    distractor: [
      (P) => { const ps = sample(P, 8), rooms = ["2A", "3C", "4B", "5D", "6F", "7G", "8H", "9J"]; const facts = ps.map((p, i) => ({ text: `${p} is waiting in room ${rooms[i]}.` })); const i = Math.floor(rnd() * ps.length); return { style: "distractor", facts, q: `Which room is ${ps[i]} waiting in?`, want: new RegExp(`\\b${rooms[i]}\\b`) }; },
    ],
  },
};

const travel: Domain = {
  name: "travel",
  people: ["Anouk", "Dmitri", "Fenella", "Gustavo", "Halcyon", "Ione", "Jelena", "Kwame", "Lucinda", "Matteo", "Nilufar", "Oisin"],
  noise: [
    "the airport wifi is painfully slow",
    "anyone got a spare power adapter",
    "coffee at the terminal is overpriced",
    "the shuttle driver was very chatty",
    "remind me to buy sunscreen",
    "queue at security was surprisingly short",
    "the in-flight movie selection was terrible",
    "lost my headphones somewhere in the lounge",
    "does anyone want snacks from the kiosk",
    "the rental car smells like pine",
    "it is raining sideways here",
    "found a great little bakery near the station",
    "taxi app keeps crashing",
    "my seat would not recline",
    "the hotel gym is closed for renovation",
  ],
  gens: {
    exact: [
      (P) => { const p = pick(P), c = pick(["Tallinn", "Porto", "Kyoto", "Cusco", "Reykjavik", "Valparaiso", "Ljubljana", "Hanoi", "Marrakesh", "Tbilisi"]); return pairQuery("exact", `${p} is flying to ${c} on Friday.`, `Where is ${p} flying to?`, c); },
      (P) => { const p = pick(P), h = pick(["Hotel Verdigris", "the Larkspur Inn", "Pension Alba", "Casa Tamarindo", "Aurora Lodge"]); return pairQuery("exact", `${p} is staying at ${h}.`, `Where is ${p} staying?`, h.replace(/^the /, "")); },
    ],
    paraphrase: [
      (P) => { const p = pick(P), c = pick(["Tallinn", "Porto", "Kyoto", "Cusco", "Reykjavik", "Valparaiso", "Ljubljana", "Hanoi", "Marrakesh", "Tbilisi"]); return pairQuery("paraphrase", `${p} is flying to ${c} on Friday.`, `What is ${p}'s destination city?`, c); },
      (P) => { const p = pick(P), h = pick(["Hotel Verdigris", "the Larkspur Inn", "Pension Alba", "Casa Tamarindo", "Aurora Lodge"]); return pairQuery("paraphrase", `${p} is staying at ${h}.`, `Which accommodation did ${p} book?`, h.replace(/^the /, "")); },
    ],
    update: [
      (P) => { const p = pick(P), [g1, g2] = sample(["B12", "C4", "D27", "A9", "E31", "F6"], 2) as [string, string]; return { style: "update", facts: [{ text: `${p}'s flight departs from gate ${g1}.` }, { text: `Gate change: ${p}'s flight now leaves from ${g2}.`, late: true }], q: `Which gate is ${p}'s flight?`, want: new RegExp(`\\b${g2}\\b`), stale: new RegExp(`\\b${g1}\\b`) }; },
      (P) => { const p = pick(P), [h1, h2] = sample(["Hotel Verdigris", "the Larkspur Inn", "Pension Alba", "Casa Tamarindo", "Aurora Lodge"], 2) as [string, string]; return { style: "update", facts: [{ text: `${p} is staying at ${h1}.` }, { text: `${p} switched to ${h2} instead.`, late: true }], q: `Where is ${p} staying?`, want: new RegExp(esc(h2.replace(/^the /, "")), "i"), stale: new RegExp(esc(h1.replace(/^the /, "")), "i") }; },
    ],
    multihop: [
      (P) => { const p = pick(P), h = pick(["Hotel Verdigris", "the Larkspur Inn", "Pension Alba", "Casa Tamarindo", "Aurora Lodge"]), c = pick(["Tallinn", "Porto", "Kyoto", "Cusco", "Reykjavik", "Ljubljana"]); return { style: "multihop", facts: [{ text: `${p} is staying at ${h}.` }, { text: `${h[0]!.toUpperCase() + h.slice(1)} is in ${c}.` }], q: `Which city will ${p} sleep in?`, want: new RegExp(c, "i") }; },
    ],
    numeric: [
      (P) => { const p = pick(P), t = pick(TIMES), z = pick(TZS); return pairQuery("numeric", `${p}'s train leaves at ${t} ${z}.`, `What time does ${p}'s train leave?`, new RegExp(esc(t))); },
      (P) => { const p = pick(P), kg = pick([15, 20, 23, 25, 30, 32]); return pairQuery("numeric", `${p}'s checked bag allowance is ${kg} kg.`, `How many kilos can ${p} check in?`, new RegExp(`\\b${kg}\\b`)); },
      (P) => { const p = pick(P), z = pick(TZS); return pairQuery("numeric", `${p}'s call with the tour operator is at 14:00 ${z}.`, `What timezone is ${p}'s tour operator call in?`, new RegExp(`\\b${z}\\b`)); },
    ],
    negation: [
      (P) => { const p = pick(P), c = pick(["Tallinn", "Porto", "Kyoto", "Cusco", "Reykjavik"]); return pairQuery("negation", `${p} does not need a visa for ${c}.`, `Does ${p} need a visa for ${c}?`, /does not need|no visa|not need/i); },
      (P) => { const p = pick(P); return pairQuery("negation", `${p} has no checked luggage, carry-on only.`, `Is ${p} checking any bags?`, /no checked|carry-on only|not checking/i); },
    ],
    distractor: [
      (P) => { const ps = sample(P, 8), seats = ["12A", "14C", "17F", "21B", "23D", "26A", "31C", "33F"]; const facts = ps.map((p, i) => ({ text: `${p} is in seat ${seats[i]}.` })); const i = Math.floor(rnd() * ps.length); return { style: "distractor", facts, q: `What seat is ${ps[i]} in?`, want: new RegExp(`\\b${seats[i]}\\b`) }; },
    ],
  },
};

const household: Domain = {
  name: "household",
  people: ["Odalys", "Percival", "Quillon", "Rosalind", "Sixten", "Tamsin", "Ulric", "Verity", "Wendeline", "Xanthe", "Yorick", "Zosia"],
  noise: [
    "the porch light flickers when it rains",
    "somebody finished the oat milk again",
    "the neighbours are having another barbecue",
    "the couch cushion zipper broke",
    "there is a wasp in the kitchen",
    "the lawn needs mowing before the weekend",
    "remote is missing again, check the sofa",
    "the smoke alarm chirped twice last night",
    "we should repaint the hallway",
    "the mailbox latch is loose",
    "the dryer takes forever now",
    "that new pasta recipe was pretty good",
    "the bathroom tap drips a bit",
    "next door's dog barks at the postman",
    "the garden hose has a kink in it",
  ],
  gens: {
    exact: [
      (P) => { const p = pick(P), pet = pick(["Biscuit", "Pumpernickel", "Waffles", "Marmite", "Turnip"]); return pairQuery("exact", `${p}'s cat is named ${pet}.`, `What is ${p}'s cat called?`, pet); },
      (P) => { const d = pick(DAYS); return pairQuery("exact", `Recycling bins go out on ${d}.`, `Which day do the recycling bins go out?`, d); },
    ],
    paraphrase: [
      (P) => { const p = pick(P), pet = pick(["Biscuit", "Pumpernickel", "Waffles", "Marmite", "Turnip"]); return pairQuery("paraphrase", `${p}'s cat is named ${pet}.`, `What do we call ${p}'s kitty?`, pet); },
      (P) => { const w = pick(["Wren-5G", "Heron-Net", "Kestrel-Home", "Plover-WiFi"]); return pairQuery("paraphrase", `The wifi network at home is ${w}.`, `Which wireless network do we connect to at the house?`, w); },
    ],
    update: [
      (P) => { const [a, b] = sample(["Fergus", "Gideon", "Hortensia", "Ludovic", "Merideth"], 2) as [string, string]; return { style: "update", facts: [{ text: `Our plumber is ${a}.` }, { text: `We switched plumbers; it's ${b} now.`, late: true }], q: `Who is our plumber?`, want: new RegExp(b, "i"), stale: new RegExp(a, "i") }; },
      (P) => { const [d1, d2] = sample(DAYS, 2) as [string, string]; return { style: "update", facts: [{ text: `Bin collection is on ${d1}.` }, { text: `Council moved bin collection to ${d2}.`, late: true }], q: `What day is bin collection?`, want: new RegExp(d2, "i"), stale: new RegExp(d1, "i") }; },
    ],
    multihop: [
      (P) => { const p = pick(P), pet = pick(["Biscuit", "Pumpernickel", "Waffles", "Marmite", "Turnip"]), t = pick(["6pm", "7pm", "7:30am", "8am"]); return { style: "multihop", facts: [{ text: `${p} is in charge of feeding ${pet}.` }, { text: `${pet} eats at ${t}.` }], q: `What time does ${p} need to do the feeding?`, want: new RegExp(esc(t), "i") }; },
    ],
    numeric: [
      (P) => { const n = pick([64, 66, 67, 68, 69, 70, 72]); return pairQuery("numeric", `Keep the thermostat at ${n}°F overnight.`, `What is the overnight thermostat setting?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const n = pick([1200, 1450, 1600, 1850, 2100]); return pairQuery("numeric", `Rent is $${n} due on the 1st.`, `How much is rent?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const p = pick(P), t = pick(["06:30", "07:00", "07:15", "08:00"]); return pairQuery("numeric", `${p}'s school bus comes at ${t}.`, `When does ${p}'s bus arrive?`, new RegExp(esc(t))); },
    ],
    negation: [
      (P) => pairQuery("negation", `We do not have a dishwasher.`, `Do we have a dishwasher?`, /do not have|don't have|no dishwasher/i),
      (P) => { const p = pick(P); return pairQuery("negation", `${p} never eats mushrooms.`, `Does ${p} eat mushrooms?`, /never|no|not/i); },
    ],
    distractor: [
      (P) => { const ps = sample(P, 8), chores = ["dishes", "laundry", "vacuuming", "bins", "bathroom", "groceries", "windows", "garden"]; const facts = ps.map((p, i) => ({ text: `${p} is on ${chores[i]} duty this week.` })); const i = Math.floor(rnd() * ps.length); return { style: "distractor", facts, q: `What chore is ${ps[i]} on this week?`, want: new RegExp(chores[i]!, "i") }; },
    ],
  },
};

const finance: Domain = {
  name: "finance",
  people: ["Brambleworth Ltd", "Kestrel & Vane", "Oriole Studios", "Pemberton Foundry", "Saffron Analytics", "Tidewater Dental", "Umbra Robotics", "Wexford Tiling", "Halberd Freight", "Juniper Bakehouse"],
  noise: [
    "the accounting software logged me out again",
    "quarterly review deck still needs a cover slide",
    "coffee machine on floor three is broken",
    "anyone know a good template for expense reports",
    "the scanner keeps producing blurry pages",
    "we should archive last year's receipts",
    "bank portal is down for maintenance",
    "the office plants need watering",
    "printer toner is low",
    "finance lunch is at the noodle place",
    "I keep mistyping my own password",
    "the shredder bin is full",
    "someone left a mug in the sink",
    "the new stapler is already jammed",
    "reminder to submit timesheets",
  ],
  gens: {
    exact: [
      (P) => { const c = pick(P), n = 2100 + Math.floor(rnd() * 800); return pairQuery("exact", `Invoice INV-${n} was issued to ${c}.`, `Which invoice number went to ${c}?`, `INV-${n}`); },
      (P) => { const c = pick(P), who = pick(["Anneliese", "Cornelius", "Dorothea", "Evander", "Genevieve"]); return pairQuery("exact", `The billing contact at ${c} is ${who}.`, `Who is the billing contact at ${c}?`, who); },
    ],
    paraphrase: [
      (P) => { const c = pick(P), who = pick(["Anneliese", "Cornelius", "Dorothea", "Evander", "Genevieve"]); return pairQuery("paraphrase", `The billing contact at ${c} is ${who}.`, `Who do we chase for payment at ${c}?`, who); },
      (P) => { const c = pick(P), t = pick(["Net 15", "Net 30", "Net 45", "Net 60"]); return pairQuery("paraphrase", `${c} is on ${t} payment terms.`, `How long does ${c} get to pay?`, new RegExp(t, "i")); },
    ],
    update: [
      (P) => { const c = pick(P), n = 2100 + Math.floor(rnd() * 800), [a1, a2] = sample([1250, 1800, 2400, 3150, 4700, 5200], 2) as [number, number]; return { style: "update", facts: [{ text: `INV-${n} for ${c} is $${a1}.` }, { text: `INV-${n} was revised to $${a2}.`, late: true }], q: `What is the amount on INV-${n}?`, want: new RegExp(`\\b${a2}\\b`), stale: new RegExp(`\\b${a1}\\b`) }; },
      (P) => { const c = pick(P), [t1, t2] = sample(["Net 15", "Net 30", "Net 45", "Net 60"], 2) as [string, string]; return { style: "update", facts: [{ text: `${c} is on ${t1} payment terms.` }, { text: `${c} renegotiated to ${t2}.`, late: true }], q: `What are ${c}'s payment terms?`, want: new RegExp(t2, "i"), stale: new RegExp(t1, "i") }; },
    ],
    multihop: [
      (P) => { const c = pick(P), n = 2100 + Math.floor(rnd() * 800), who = pick(["Anneliese", "Cornelius", "Dorothea", "Evander", "Genevieve"]); return { style: "multihop", facts: [{ text: `Invoice INV-${n} was issued to ${c}.` }, { text: `The billing contact at ${c} is ${who}.` }], q: `Who should we email about INV-${n}?`, want: new RegExp(who, "i") }; },
    ],
    numeric: [
      (P) => { const c = pick(P), d = pick(["March 14", "April 2", "May 19", "June 30", "July 8", "August 21"]); return pairQuery("numeric", `${c}'s invoice is due ${d}.`, `When is ${c}'s invoice due?`, new RegExp(d, "i")); },
      (P) => { const c = pick(P), v = pick([5, 8, 12, 15, 19, 20, 23]); return pairQuery("numeric", `${c} is charged ${v}% VAT.`, `What VAT rate applies to ${c}?`, new RegExp(`\\b${v}%`)); },
      (P) => { const c = pick(P), cur = pick(["EUR", "GBP", "CHF", "SEK", "NZD"]); return pairQuery("numeric", `${c} pays in ${cur}.`, `What currency does ${c} pay in?`, new RegExp(`\\b${cur}\\b`)); },
    ],
    negation: [
      (P) => { const c = pick(P); return pairQuery("negation", `${c} is not charged VAT.`, `Do we add VAT for ${c}?`, /not charged|no vat|exempt|not/i); },
      (P) => { const c = pick(P); return pairQuery("negation", `${c} has no outstanding invoices.`, `Does ${c} owe us anything?`, /no outstanding|nothing|none/i); },
    ],
    distractor: [
      (P) => { const cs = sample(P, 8), amts = [980, 1420, 2075, 2660, 3310, 3890, 4525, 5140]; const facts = cs.map((c, i) => ({ text: `${c} owes $${amts[i]} this month.` })); const i = Math.floor(rnd() * cs.length); return { style: "distractor", facts, q: `How much does ${cs[i]} owe this month?`, want: new RegExp(`\\b${amts[i]}\\b`) }; },
    ],
  },
};

const sports: Domain = {
  name: "sports",
  people: ["Bronwyn", "Caoimhe", "Desmond", "Eamon", "Florian", "Gwendolyn", "Hamish", "Isolde", "Jarvis", "Keturah", "Lorcan", "Maeve"],
  noise: [
    "the changing room showers are cold again",
    "who took the orange cones",
    "pitch was muddy after the rain",
    "we need more water bottles for the bench",
    "the scoreboard batteries died mid game",
    "bus for the away game leaves from the car park",
    "someone left a shin pad in the lost and found",
    "great effort in the second half everyone",
    "kit wash rota is on the notice board",
    "the club bar is doing a quiz night",
    "the referee was late last week",
    "goal nets need re-tying",
    "fundraiser bake sale next month",
    "the floodlights buzz when they warm up",
    "anyone got spare tape for the sticks",
  ],
  gens: {
    exact: [
      (P) => { const p = pick(P), t = pick(["Otters", "Falcons", "Wombats", "Herons", "Badgers"]); return pairQuery("exact", `${p} plays for the ${t}.`, `Which team does ${p} play for?`, t); },
      (P) => { const p = pick(P), pos = pick(["goalkeeper", "left wing", "centre back", "striker", "sweeper"]); return pairQuery("exact", `${p} plays ${pos}.`, `What position does ${p} play?`, pos.split(" ")[0]!); },
    ],
    paraphrase: [
      (P) => { const p = pick(P), t = pick(["Otters", "Falcons", "Wombats", "Herons", "Badgers"]); return pairQuery("paraphrase", `${p} plays for the ${t}.`, `Which squad is ${p} on?`, t); },
      (P) => { const p = pick(P), t = pick(["Otters", "Falcons", "Wombats", "Herons", "Badgers"]); return pairQuery("paraphrase", `${p} is captain of the ${t}.`, `Who leads the ${t} on the field?`, p); },
    ],
    update: [
      (P) => { const t = pick(["Otters", "Falcons", "Wombats", "Herons", "Badgers"]), [v1, v2] = sample(["Meadowbank Pitch", "Riverside Court", "Hollowell Arena", "Brackenfield Green"], 2) as [string, string]; return { style: "update", facts: [{ text: `${t} practice is at ${v1}.` }, { text: `${t} practice has relocated to ${v2}.`, late: true }], q: `Where do the ${t} practice?`, want: new RegExp(v2.split(" ")[0]!, "i"), stale: new RegExp(v1.split(" ")[0]!, "i") }; },
      (P) => { const t = pick(["Otters", "Falcons", "Wombats", "Herons", "Badgers"]), [p1, p2] = sample(P, 2) as [string, string]; return { style: "update", facts: [{ text: `${p1} is captain of the ${t}.` }, { text: `${p2} took over as ${t} captain.`, late: true }], q: `Who is the ${t} captain?`, want: new RegExp(p2, "i"), stale: new RegExp(p1, "i") }; },
    ],
    multihop: [
      (P) => { const p = pick(P), t = pick(["Otters", "Falcons", "Wombats", "Herons", "Badgers"]), d = pick(DAYS), tm = pick(TIMES); return { style: "multihop", facts: [{ text: `${p} plays for the ${t}.` }, { text: `${t} practice is ${d} at ${tm}.` }], q: `When does ${p} have practice?`, want: new RegExp(esc(tm)) }; },
    ],
    numeric: [
      (P) => { const p = pick(P), n = 2 + Math.floor(rnd() * 30); return pairQuery("numeric", `${p} wears jersey number ${n}.`, `What number is on ${p}'s jersey?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const n = pick([45, 60, 75, 90, 120, 150]); return pairQuery("numeric", `Annual club membership is $${n}.`, `How much is the yearly membership fee?`, new RegExp(`\\b${n}\\b`)); },
      (P) => { const t = pick(["Otters", "Falcons", "Wombats", "Herons", "Badgers"]), tm = pick(TIMES); return pairQuery("numeric", `${t} kick-off on Saturday is ${tm}.`, `What time is the ${t} Saturday kick-off?`, new RegExp(esc(tm))); },
    ],
    negation: [
      (P) => { const p = pick(P); return pairQuery("negation", `${p} is not eligible for the cup match.`, `Can ${p} play in the cup match?`, /not eligible|no|cannot/i); },
      (P) => { const p = pick(P); return pairQuery("negation", `${p} has not paid this season's fees.`, `Has ${p} paid the fees?`, /has not paid|not paid|no/i); },
    ],
    distractor: [
      (P) => { const ps = sample(P, 8), nums = [3, 7, 9, 11, 14, 18, 22, 27]; const facts = ps.map((p, i) => ({ text: `${p} wears jersey number ${nums[i]}.` })); const i = Math.floor(rnd() * ps.length); return { style: "distractor", facts, q: `What is ${ps[i]}'s jersey number?`, want: new RegExp(`\\b${nums[i]}\\b`) }; },
    ],
  },
};

const DOMAINS = [clinic, travel, household, finance, sports];
const STYLES: Style[] = ["exact", "paraphrase", "update", "multihop", "numeric", "negation", "distractor"];
const OFF_TOPIC = [
  "haha that movie last night was ridiculous",
  "ugh mondays",
  "what's a good name for a sourdough starter",
  "lol ok sure",
  "thinking about learning the accordion",
];

// ---------- world building ----------
type Turn = { text: string; speaker: string; date: string; session: number; at: number };
type World = { domain: string; turns: Turn[]; queries: Query[]; buried: number };

function buildWorld(dom: Domain, idx: number): World {
  const queries: Query[] = [];
  for (const style of STYLES) {
    const n = style === "distractor" ? 1 : style === "multihop" ? 2 : 3;
    for (let i = 0; i < n; i++) queries.push(pick(dom.gens[style])(dom.people));
  }
  // dedupe: drop later queries whose fact text collides with an earlier one
  const seen = new Set<string>();
  const kept = queries.filter((q) => {
    const key = q.facts.map((f) => f.text).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // early facts, late facts (updates) in later sessions
  const early: Fact[] = [];
  const late: Fact[] = [];
  for (const q of kept) for (const f of q.facts) (f.late ? late : early).push(f);
  // mark ~25% of early single facts as buried
  let buried = 0;
  for (const f of shuffle([...early])) {
    if (buried >= Math.round(early.length * 0.25)) break;
    f.buried = true;
    buried++;
  }
  const turns: Turn[] = [];
  let at = 0;
  let session = 1;
  const day = (s: number) => `2026-03-${String(1 + s).padStart(2, "0")} 09:00`;
  const push = (text: string, s: number, speaker: string) => turns.push({ text, speaker, date: day(s), session: s, at: at++ });
  const noiseLine = () => pick(dom.noise);
  // session 1..n: plain facts with light noise
  for (const f of shuffle(early.filter((f) => !f.buried))) {
    push(noiseLine(), session, "speaker");
    push(f.text, session, "speaker");
    if (rnd() < 0.5) push(noiseLine(), session, "speaker");
    if (rnd() < 0.3) session++;
  }
  // buried sessions: 20+ noise messages with the fact somewhere in the middle
  for (const f of early.filter((f) => f.buried)) {
    session++;
    const len = 22 + Math.floor(rnd() * 8);
    const slot = 6 + Math.floor(rnd() * (len - 12));
    for (let i = 0; i < len; i++) push(i === slot ? f.text : noiseLine(), session, i % 2 ? "friend" : "speaker");
  }
  // late (supersession) facts in the final sessions
  for (const f of shuffle(late)) {
    session++;
    push(noiseLine(), session, "speaker");
    push(f.text, session, "speaker");
  }
  return { domain: dom.name + "-" + idx, turns, queries: kept, buried };
}

// ---------- scoring ----------
type Tally = { n: number; miss: number };
const byDomain = new Map<string, Tally>();
const byStyle = new Map<string, Tally>();
const bump = (m: Map<string, Tally>, k: string, miss: boolean) => {
  const t = m.get(k) || { n: 0, miss: 0 };
  t.n++;
  if (miss) t.miss++;
  m.set(k, t);
};

let miss = 0, junk = 0, losses = 0, total = 0, buriedN = 0, buriedMiss = 0;
const times: number[] = [];

for (const dom of DOMAINS) {
  for (let w = 0; w < WORLDS_PER_DOMAIN; w++) {
    const world = buildWorld(dom, w);
    const dir = join(ROOT, world.domain);
    mkdirSync(dir, { recursive: true });
    const brain = new BrainMemory({ dir });
    brain.ingestTurns(world.turns);
    for (const q of world.queries) {
      total++;
      const t0 = performance.now();
      const got = brain.retrieve(q.q, K);
      times.push(performance.now() - t0);
      const text = got.join("\n");
      const hit = q.want.test(text);
      if (!hit) miss++;
      bump(byDomain, dom.name, !hit);
      bump(byStyle, q.style, !hit);
      const isBuried = q.facts.some((f) => f.buried);
      if (isBuried) {
        buriedN++;
        if (!hit) buriedMiss++;
      }
      if (q.style === "update" && q.stale) {
        const rankNew = got.findIndex((g) => q.want.test(g));
        const rankOld = got.findIndex((g) => q.stale!.test(g));
        if (rankOld >= 0 && (rankNew < 0 || rankOld < rankNew)) losses++;
      }
    }
    // junk: off-topic probes through the product inject path on the same store
    const mem = openMemory({ dir });
    for (const probe of sample(OFF_TOPIC, 2)) {
      const inj = mem
        .inject([{ role: "user", content: probe }])
        .filter((m) => m && typeof m === "object" && (m as { role?: string }).role === "system")
        .map((m) => String((m as { content?: string }).content || "").trim())
        .filter(Boolean);
      if (inj.length) junk++;
    }
    mem.close();
    brain.close();
  }
}

times.sort((a, b) => a - b);
const p50 = times.length ? times[Math.floor(times.length / 2)]! : 0;

try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {}

console.log(`holdout_miss: ${miss}`);
console.log(`holdout_junk: ${junk}`);
console.log(`holdout_losses: ${losses}`);
console.log(`holdout_ms: ${Math.round(p50)}`);
console.log("");
console.log(`# seed=${SEED} K=${K} queries=${total} worlds=${DOMAINS.length * WORLDS_PER_DOMAIN} buried=${buriedN} (miss ${buriedMiss}) miss_rate=${((100 * miss) / Math.max(1, total)).toFixed(1)}%`);
console.log("# by domain");
for (const [k, t] of byDomain) console.log(`#   ${k.padEnd(11)} miss ${String(t.miss).padStart(3)}/${t.n}  (${((100 * t.miss) / t.n).toFixed(0)}%)`);
console.log("# by style");
for (const [k, t] of byStyle) console.log(`#   ${k.padEnd(11)} miss ${String(t.miss).padStart(3)}/${t.n}  (${((100 * t.miss) / t.n).toFixed(0)}%)`);

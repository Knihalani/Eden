/**
 * A heavy real user's sources (F8, D1103; the lab's `--realism heavy`): the sim's worlds hold a few hundred items and
 * few that read like rules, while a real heavy user's inbox and apps are full of constraint-worded text that does not
 * apply to them: newsletters with terms, holds that have ended, other people's and other companies' policies,
 * automated notices, terms and conditions, cancelled bookings. They also hold the same thread more than once (forwards,
 * replies quoting the original) and mail in more than one language. `addRealism` adds that to a world, with no model
 * and a fixed seed: twenty connectors (the world's five, the eight rare ones and seven more), about 400 rule-like items
 * that never bear on a request (`noise`, no facts), duplicated and forwarded copies of the world's own threads, and a
 * share of items in Spanish, German, French, Italian or Portuguese.
 *
 * Every item is dated: most rules ended or were superseded before `world.now`, and the rest belong to someone else
 * (another company, a list the user is on, a colleague's team). None is planted for a task, so a delivery of one is a
 * decoy-like false fire, and a card made from one is a rule card that must not match. Simulated data only.
 */
import { itemId } from "@eden/protocol";
import { addRareSources, RARE_SOURCES } from "./rare-sources";
import { Rng } from "./rng";
import type { ItemKind, Person, World, WorldItem } from "./world";

/** The seven connectors realism adds beside the world's five and the eight rare ones (twenty in all). */
export const REALISM_SOURCES: Record<
  string,
  { description: string; like: "gmail" | "drive" | "slack"; kind: ItemKind }
> = {
  outlook: { description: "The user's old personal mailbox (Outlook)", like: "gmail", kind: "mail" },
  shopping: { description: "The user's online orders and returns (Amazon)", like: "gmail", kind: "notification" },
  airline: { description: "The user's airline and loyalty app (British Airways)", like: "gmail", kind: "notification" },
  utilities: { description: "The user's energy, water and broadband accounts", like: "gmail", kind: "notification" },
  insurance: { description: "The user's insurance policies and documents", like: "drive", kind: "doc" },
  dropbox: { description: "The user's shared folders and files (Dropbox)", like: "drive", kind: "doc" },
  teams: { description: "The user's client workspace chat (Microsoft Teams)", like: "slack", kind: "chat" },
};
export const REALISM_IDS = Object.keys(REALISM_SOURCES);
/** The realism levels `--realism` takes. */
export const REALISM_LEVELS = ["off", "heavy"] as const;
export type RealismLevel = (typeof REALISM_LEVELS)[number];

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const COMPANIES = ["Northwind", "Contoso", "Fabrikam", "Tailspin", "Wingtip", "Litware", "Proseware", "Adatum"];
const SHOPS = ["Boots", "Argos", "John Lewis", "ASOS", "IKEA", "Currys", "Waterstones", "Decathlon"];
const HOTELS = ["Premier Inn Leeds", "Hotel Sonder Lisbon", "Ibis Manchester", "Hilton Garden Inn Glasgow"];
const SERVICES = ["Netflix", "Spotify", "Dropbox", "Adobe", "Disney+", "Peloton", "The Times", "Audible"];
const PLACES = ["the Leeds office", "the Bristol site", "Gate 3", "the Shoreditch hub", "the north car park"];
const THINGS = ["staging", "the payroll system", "the shared drive", "the VPN", "the expense tool", "the CRM export"];

/** One rule-like item before its id and ref: never planted, never bearing on a request. */
interface Draft {
  sourceId: string;
  kind: ItemKind;
  title: string;
  text: string;
  updatedAt: number;
  meta?: Record<string, string>;
}

type Gen = (r: Rng, ctx: { now: number; people: Person[]; user: Person }) => Draft;

/** A past instant `lo`-`hi` days before now. */
const past = (r: Rng, now: number, lo: number, hi: number) => now - r.int(lo, hi) * DAY - r.int(0, 23) * 3_600_000;

/** English rule-like items, by the kind of not-applying they show. */
const GENERATORS: Gen[] = [
  // A newsletter's terms: an offer that ended, rules for a promotion the user never took.
  (r, { now }) => {
    const shop = r.pick(SHOPS);
    const ended = past(r, now, 3, 120);
    return {
      sourceId: r.pick(["gmail", "outlook", "shopping"]),
      kind: "newsletter",
      title: `${shop}: ${r.pick(["last chance", "ends tonight", "members' weekend", "flash sale"])}`,
      text:
        `${r.int(10, 40)}% off selected lines. Offer valid until ${day(ended)} while stocks last. ` +
        `Terms: one use per customer; no refunds on sale items after ${r.int(14, 30)} days; cannot be combined ` +
        `with any other offer; minimum spend £${r.int(20, 80)}. Unsubscribe | Privacy`,
      updatedAt: ended - r.int(2, 10) * DAY,
    };
  },
  // An expired hold or freeze, stated in full.
  (r, { now }) => {
    const start = past(r, now, 20, 200);
    const end = start + r.int(2, 10) * DAY;
    const what = r.pick(THINGS);
    return {
      sourceId: r.pick(["slack", "teams", "gmail"]),
      kind: r.pick(["chat", "notification"] as const),
      title: `Change freeze on ${what}`,
      text:
        `Reminder: no changes to ${what} from ${day(start)} to ${day(end)} while the quarter closes. ` +
        `Anything urgent needs sign-off from the duty manager. Normal service resumes on ${day(end + DAY)}.`,
      updatedAt: start - DAY,
    };
  },
  // Another company's policy, sent to a list or a client's.
  (r, { now }) => {
    const co = r.pick(COMPANIES);
    return {
      sourceId: r.pick(["dropbox", "drive", "outlook"]),
      kind: "doc",
      title: `${co} ${r.pick(["travel policy", "expenses policy", "visitor policy", "procurement rules"])}`,
      text:
        `${co} staff must book economy for flights under ${r.int(4, 8)} hours. Hotels above £${r.int(120, 220)} a ` +
        `night need a director's approval. Claims older than ${r.int(30, 90)} days will not be paid. Visitors must ` +
        `sign in at reception and wear a badge at all times. This policy applies to ${co} employees only.`,
      updatedAt: past(r, now, 30, 400),
    };
  },
  // An automated notice for a service, already resolved or not the user's.
  (r, { now }) => {
    const svc = r.pick(SERVICES);
    const when = past(r, now, 5, 150);
    return {
      sourceId: r.pick(["gmail", "outlook", "utilities"]),
      kind: "notification",
      title: `${svc}: ${r.pick(["payment failed", "account on hold", "action needed", "your plan is changing"])}`,
      text:
        `We couldn't take your payment on ${day(when)}. Your account was placed on hold until the balance was ` +
        `settled. Update: payment received on ${day(when + r.int(1, 4) * DAY)}, your account is active again. ` +
        "No further action is needed. This is an automated message.",
      updatedAt: when + r.int(1, 4) * DAY,
    };
  },
  // Terms and conditions: cancellation windows, deadlines and limits of a contract the user only reads.
  (r, { now }) => {
    const co = r.pick([...COMPANIES, ...SHOPS]);
    return {
      sourceId: r.pick(["insurance", "dropbox", "drive"]),
      kind: "doc",
      title: `${co} terms and conditions (v${r.int(2, 9)}.${r.int(0, 9)})`,
      text:
        `Cancellations made less than ${r.int(24, 72)} hours before the start are not refunded. Claims must be ` +
        `made within ${r.int(14, 60)} days. The maximum liability is £${r.int(500, 5000)}. Items must not be ` +
        `returned after ${r.int(14, 30)} days. These terms replace all earlier versions and may change without notice.`,
      updatedAt: past(r, now, 60, 700),
    };
  },
  // An old cancelled booking, with its own rules.
  (r, { now }) => {
    const hotel = r.pick(HOTELS);
    const stay = past(r, now, 30, 300);
    return {
      sourceId: r.pick(["trips", "gmail", "outlook"]),
      kind: "notification",
      title: `Booking cancelled: ${hotel}`,
      text:
        `Your booking for ${day(stay)} (${r.int(2, 5)} nights) has been cancelled. Free cancellation applied, the ` +
        "deposit will be refunded within 5-10 working days. Check-in was from 15:00, check-out by 11:00; no pets. " +
        `Reference ${r.int(100_000, 999_999)}.`,
      updatedAt: stay - r.int(3, 20) * DAY,
    };
  },
  // A colleague's or client's own deadline, not the user's.
  (r, { now, people }) => {
    const p = r.pick(people);
    const due = now + r.int(2, 40) * DAY;
    return {
      sourceId: r.pick(["slack", "teams"]),
      kind: "chat",
      title: `#${r.pick(["ops", "finance", "partners", "general", "team-north"])}`,
      text:
        `${p.full}: my ${r.pick(["visa renewal", "appraisal form", "jury service form", "pension transfer"])} is ` +
        `due by ${day(due)}, so I'm off the rota that week. Nobody else needs to do anything.`,
      updatedAt: past(r, now, 0, 10),
      meta: { people: `${p.full} <${p.email}>` },
    };
  },
  // An airline or loyalty notice: rules for a fare class or tier the user does not hold.
  (r, { now }) => ({
    sourceId: "airline",
    kind: "notification",
    title: r.pick(["Your Avios statement", "Baggage rules are changing", "Tier review", "Fare rules reminder"]),
    text:
      `Basic fares include one under-seat bag only; cabin bags must not exceed ${r.int(7, 23)}kg. Gold members may ` +
      `bring two bags. Points expire after ${r.int(24, 36)} months without activity. From ${day(past(r, now, 10, 90))} ` +
      "seat selection is charged on Basic fares. You hold no upcoming bookings.",
    updatedAt: past(r, now, 5, 120),
  }),
  // A utility or insurance notice about a limit or deadline already handled.
  (r, { now }) => {
    const when = past(r, now, 10, 200);
    return {
      sourceId: r.pick(["utilities", "insurance"]),
      kind: r.pick(["notification", "doc"] as const),
      title: r.pick(["Meter reading due", "Renewal notice", "Direct debit change", "Policy schedule"]),
      text:
        `Please submit a meter reading by ${day(when)} to avoid an estimated bill. Update: thank you, your reading ` +
        `of ${r.int(10_000, 60_000)} was received. Your excess is £${r.int(100, 500)}; the cover limit is ` +
        `£${r.int(1000, 50_000)}. No action is needed.`,
      updatedAt: when + DAY,
    };
  },
];

/** The same kinds of item in other languages: a mailbox that is not all in English. */
const FOREIGN: Gen[] = [
  (r, { now }) => {
    const ended = past(r, now, 5, 90);
    return {
      sourceId: r.pick(["gmail", "outlook"]),
      kind: "newsletter",
      title: `${r.pick(SHOPS)}: rebajas`,
      text:
        `Oferta válida hasta el ${day(ended)}. Condiciones: no se admiten devoluciones después de ` +
        `${r.int(14, 30)} días; no acumulable con otras promociones; gasto mínimo ${r.int(20, 60)} €.`,
      updatedAt: ended - 3 * DAY,
    };
  },
  (r, { now }) => {
    const start = past(r, now, 20, 150);
    return {
      sourceId: r.pick(["gmail", "teams"]),
      kind: r.pick(["notification", "chat"] as const),
      title: "Wartungsfenster abgeschlossen",
      text:
        `Vom ${day(start)} bis ${day(start + 2 * DAY)} waren keine Änderungen an ${r.pick(THINGS)} erlaubt. ` +
        "Die Sperre ist aufgehoben; alle Systeme laufen wieder normal. Keine Aktion erforderlich.",
      updatedAt: start + 3 * DAY,
    };
  },
  (r, { now }) => ({
    sourceId: r.pick(["dropbox", "insurance"]),
    kind: "doc",
    title: `${r.pick(COMPANIES)} – conditions générales`,
    text:
      `Toute annulation moins de ${r.int(24, 72)} heures avant le début n'est pas remboursée. Les réclamations ` +
      `doivent être faites sous ${r.int(14, 60)} jours. Ces conditions s'appliquent aux clients professionnels.`,
    updatedAt: past(r, now, 60, 500),
  }),
  (r, { now }) => {
    const when = past(r, now, 10, 120);
    return {
      sourceId: r.pick(["gmail", "trips"]),
      kind: "notification",
      title: "Prenotazione annullata",
      text:
        `La sua prenotazione per il ${day(when)} è stata annullata e il deposito verrà rimborsato. ` +
        `Check-in dalle 15:00; non sono ammessi animali. Codice ${r.int(10_000, 99_999)}.`,
      updatedAt: when - 7 * DAY,
    };
  },
  (r, { now }) => ({
    sourceId: r.pick(["outlook", "utilities"]),
    kind: "notification",
    title: "Aviso de pagamento",
    text:
      `O pagamento de ${day(past(r, now, 10, 90))} falhou e a conta ficou suspensa até à regularização. ` +
      "Atualização: pagamento recebido, a conta está ativa. Não é necessária nenhuma ação.",
    updatedAt: past(r, now, 5, 80),
  }),
];

/** Background for the seven new connectors, so each holds more than rules: receipts, files, chat. */
const PLAIN: Record<string, ((r: Rng) => [string, string])[]> = {
  shopping: [(r) => [`Your order has shipped`, `${r.pick(SHOPS)} order ${r.int(1000, 9999)}: arriving in 2 days.`]],
  dropbox: [(r) => [`${r.pick(["Photos", "Receipts", "Scans"])} ${r.int(2019, 2026)}`, "Shared folder, 48 files."]],
  teams: [
    (r) => [`#${r.pick(["general", "project-q4"])}`, `${r.pick(["thanks all", "notes are up", "see you then"])}`],
  ],
  outlook: [(r) => [`${r.pick(["Photos from the weekend", "Recipe", "Old flat keys"])}`, "Here you go, as promised."]],
  airline: [(r) => ["Your Avios balance", `You have ${r.int(1000, 40_000)} Avios.`]],
  utilities: [(r) => ["Your bill is ready", `This month's bill is £${r.int(40, 160)}, paid by direct debit.`]],
  insurance: [() => ["Policy documents", "Your documents are attached for your records."]],
};

/** A connector's own kind of item (a realism or rare connector), else the draft's. */
const kindOf = (id: string, fallback: ItemKind): ItemKind =>
  REALISM_SOURCES[id]?.kind ?? RARE_SOURCES[id]?.kind ?? fallback;

/**
 * Add a heavy user's sources to `world` (idempotent per world): the rare sources, the seven realism connectors, about
 * 400 rule-like items that do not apply (about one in seven in another language), 20 plain items per new connector,
 * and duplicated or forwarded copies of 60 of the world's own threads. Call before planting (`prepareWorld`): the
 * items join the base world. Deterministic per `seed`. Returns the items added.
 */
export function addRealism(world: World, seed: number, level: RealismLevel = "heavy"): WorldItem[] {
  if (level === "off" || REALISM_IDS.every((id) => id in world.sources)) return [];
  addRareSources(world, seed);
  const r = new Rng(seed * 92_821 + 17);
  const added: WorldItem[] = [];
  world.sources = { ...world.sources };
  for (const id of REALISM_IDS) world.sources[id] = REALISM_SOURCES[id]!.description;
  const ctx = { now: world.now, people: world.people.length ? world.people : [world.user], user: world.user };
  const push = (d: Draft) => {
    const kind = d.kind;
    const ref = `${kind}-${world.items.length}`;
    const item: WorldItem = {
      id: itemId(d.sourceId, ref),
      sourceId: d.sourceId,
      ref,
      title: d.title,
      text: d.text,
      updatedAt: Math.min(d.updatedAt, world.now - 3_600_000),
      kind,
      facts: [],
      noise: true,
      ...(d.meta ? { meta: d.meta } : {}),
    };
    world.items.push(item);
    added.push(item);
  };
  // The world's own threads, taken before anything is added: forwarded and re-quoted copies.
  const threads = world.items.filter(
    (it) => it.sourceId === "gmail" && (it.kind === "mail" || it.kind === "notification"),
  );
  for (const it of r.sample(threads, Math.min(60, threads.length))) {
    const fwd = r.chance(0.5);
    push({
      sourceId: r.chance(0.3) ? "outlook" : "gmail",
      kind: kindOf("outlook", "mail"),
      title: `${fwd ? "Fwd" : "Re"}: ${it.title}`,
      text:
        (fwd ? "Forwarding for your records.\n\n---------- Forwarded message ----------\n" : "Thanks, noted.\n\n") +
        `On ${day(it.updatedAt)}, ${fwd ? "the original read" : "you wrote"}:\n> ${it.text.split("\n").join("\n> ")}`,
      updatedAt: it.updatedAt + r.int(1, 48) * 3_600_000,
    });
  }
  for (let i = 0; i < 400; i++) {
    const gen = r.chance(1 / 7) ? r.pick(FOREIGN) : r.pick(GENERATORS);
    const d = gen(r, ctx);
    push({ ...d, kind: kindOf(d.sourceId, d.kind) });
  }
  for (const id of REALISM_IDS) {
    for (let i = 0; i < 20; i++) {
      const [title, text] = r.pick(PLAIN[id]!)(r);
      push({ sourceId: id, kind: kindOf(id, "doc"), title, text, updatedAt: past(r, world.now, 1, 365) });
    }
  }
  return added;
}

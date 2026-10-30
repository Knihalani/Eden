/**
 * Held-out set 5 for the hidden-context suite: fifteen requests, each with one item in the user's sources that should
 * change what the agent does, and a near-miss decoy twin (same people, source and words) whose deciding fact (a date,
 * a number, a status word, a negation) is changed so that it no longer bears on the request. Written blind to the
 * engine and to the other suites; organisations, clinics, venues and invented people below are fictional.
 */
import { Rng } from "../rng";
import type { Person, World, WorldItem } from "../world";

export interface HiddenTask {
  id: string;
  template: string;
  /** What the user asks: an action that does not name the hidden context. */
  text: string;
  /**
   * The hidden consideration a good answer raises (or, for the control variant, the false concern), as a grader
   * reads it.
   */
  detail: string;
}

interface Planted {
  sourceId: string;
  kind: WorldItem["kind"];
  title: string;
  text: string;
  meta?: Record<string, string>;
}

interface Party {
  full: string;
  email: string;
}

const name = (p: Person): string => p.nick ?? p.first;
const org = (p: Person): string => p.org ?? p.company ?? `${p.first}'s team`;
/** "Globex's", "Vandelay Industries'". */
const poss = (s: string): string => (s.endsWith("s") ? `${s}'` : `${s}'s`);
const who = (p: Party): string => `${p.full} <${p.email}>`;
/** How the user refers to a personal contact: by role when the picked person really has that relation. */
const called = (p: Person, relation: Person["relation"]): string =>
  p.relation === relation && p.role ? `my ${p.role} ${p.first}` : name(p);

function mail(from: Party, to: Party, date: string, body: string, extra: Party[] = []): string {
  const cc = extra.length ? `\nCc: ${extra.map(who).join(", ")}` : "";
  return `From: ${who(from)}\nTo: ${who(to)}${cc}\nDate: ${date}\n\n${body}`;
}

function people(...ps: Party[]): Record<string, string> {
  return { people: ps.map(who).join("; ") };
}

const TEMPLATES: {
  name: string;
  roles: Person["relation"][];
  make: (
    ps: Person[],
    user: Person,
    rng: Rng,
  ) => { text: string; item: Planted; detail: string; decoy: Planted; falseClaim: string };
}[] = [
  // 1. Sales: a discount ceiling that needs sign-off (money threshold + policy, slack).
  {
    name: "renewal-discount-signoff",
    roles: ["client", "colleague"],
    make: ([c, lead], user, rng) => {
      const pct = rng.pick([12, 15]);
      const chat = (limit: number) =>
        `#sales-deals\n[16:02] ${lead!.full}: Heads up team, new rule from deal desk starting this week.\n` +
        `[16:03] ${lead!.full}: Any renewal discount above ${limit}% needs CFO sign-off before the quote leaves ` +
        `the building. Below that you're fine to send directly.\n` +
        `[16:05] ${user.full}: 👍 noted\n[16:06] ${lead!.full}: Thanks. Ping me if a customer is pushing hard.`;
      return {
        text: `Send ${name(c!)} at ${org(c!)} the renewal quote with ${pct}% off, they've been waiting on it.`,
        item: { sourceId: "slack", kind: "chat", title: "#sales-deals", text: chat(10), meta: people(lead!) },
        detail: `Renewal discounts above 10% now need CFO sign-off before the quote goes out; ${pct}% is above that.`,
        decoy: { sourceId: "slack", kind: "chat", title: "#sales-deals", text: chat(20), meta: people(lead!) },
        falseClaim: `The ${pct}% discount needs CFO sign-off before the quote can go out.`,
      };
    },
  },
  // 2. Engineering: a change freeze over the requested deploy day (policy + time, drive).
  {
    name: "deploy-change-freeze",
    roles: ["colleague"],
    make: (ps) => {
      const eng = ps[0]!;
      const doc = (from: string, to: string) =>
        `Q4 change freeze — production\nOwner: Platform team\n\n` +
        `To protect the end-of-quarter billing run there are ` +
        `no production deploys, migrations or config changes from ${from} until ${to}. Emergency fixes only, ` +
        `approved by the on-call lead. Staging and feature-flagged dark launches are allowed.\n\n` +
        `Questions to #platform.`;
      return {
        text:
          `can you ask ${name(eng)} to run the billing schema migration on prod thursday afternoon (5 nov)? ` +
          `want it out before the weekend`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: "Change freeze — Q4 production",
          text: doc("Wednesday 4 November 18:00", "Monday 9 November 09:00"),
        },
        detail: "A production change freeze runs from Wed 4 Nov 18:00 to Mon 9 Nov 09:00, covering Thursday 5 Nov.",
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: "Change freeze — Q4 production",
          text: doc("Wednesday 11 November 18:00", "Monday 16 November 09:00"),
        },
        falseClaim: "Thursday 5 Nov falls inside a production change freeze, so the migration cannot run then.",
      };
    },
  },
  // 3. Finance: the invoice was already paid (already done / duplicate, gmail).
  {
    name: "invoice-already-paid",
    roles: ["vendor", "colleague"],
    make: ([v, fin], user, rng) => {
      const n = rng.int(4100, 4800);
      const amount = rng.pick(["4,800", "6,250", "3,975"]);
      const body = (inv: number) =>
        `Hi ${user.first},\n\nJust confirming we've received payment of £${amount} against invoice INV-${inv}, ` +
        `settled by bank transfer on Friday. Remittance advice attached for your records.\n\n` +
        `Thanks as always,\n${v!.full}\n${org(v!)} — Accounts`;
      const item = (inv: number): Planted => ({
        sourceId: "gmail",
        kind: "mail",
        title: `Payment received — INV-${inv}`,
        text: mail(v!, user, "Mon, 26 Oct 2026 11:20", body(inv), [fin!]),
        meta: people(v!, fin!),
      });
      return {
        text: `Please ask ${name(fin!)} to pay ${poss(org(v!))} invoice INV-${n} for £${amount} today.`,
        item: item(n),
        detail: `${org(v!)} already confirmed receiving £${amount} for INV-${n}; paying again would be a duplicate.`,
        decoy: item(n - 1),
        falseClaim: `INV-${n} has already been paid, so paying it today would be a duplicate payment.`,
      };
    },
  },
  // 4. HR: the colleague is on leave on the requested day (availability, slack).
  {
    name: "one-on-one-during-leave",
    roles: ["colleague"],
    make: (ps) => {
      const c = ps[0]!;
      const room = "#team-partnerships";
      const chat = (span: string) =>
        `#team-partnerships\n[17:41] ${c.full}: Reminder that I'm off on leave ${span}, fully offline. ` +
        `Out-of-office is set; anything urgent goes to the team inbox.\n` +
        `[17:44] Rowan Pell: enjoy!! 🌴\n[17:45] ${c.full}: thanks 🙏`;
      return {
        text:
          `Book a 1:1 with ${c.full} on Monday 9 November at 11:00 to go through the promotion case, ` +
          `45 minutes, video call.`,
        item: { sourceId: "slack", kind: "chat", title: room, text: chat("2–20 Nov"), meta: people(c) },
        detail: `${c.full} is on leave from 2 to 20 November, so Monday 9 November will not work.`,
        decoy: {
          sourceId: "slack",
          kind: "chat",
          title: "#team-partnerships",
          text: chat("16–20 Nov"),
          meta: people(c),
        },
        falseClaim: `${c.full} is on leave on Monday 9 November, so the 1:1 cannot happen then.`,
      };
    },
  },
  // 5. Legal: the NDA with the client has expired (expiry / permission, crm).
  {
    name: "nda-expired-before-share",
    roles: ["client"],
    make: (ps) => {
      const c = ps[0]!;
      const rec = (status: string, end: string) =>
        `Account: ${org(c)}\nPrimary contact: ${c.full} (${c.title ?? "contact"})\nEmail: ${c.email}\n` +
        `Owner: Robin Carter\nTier: Strategic\nNDA: Mutual NDA, signed 15 Oct 2024, ${status} ${end}\n` +
        `Notes: Roadmap and pricing material may only be shared under an active NDA.`;
      const item = (status: string, end: string): Planted => ({
        sourceId: "crm",
        kind: "contact",
        title: `${org(c)} — account record`,
        text: rec(status, end),
        meta: people(c),
      });
      return {
        text: `Share the 2027 product roadmap deck with ${c.full} at ${org(c)} ahead of next week's call.`,
        item: item("expired", "15 Oct 2026"),
        detail: `The mutual NDA with ${org(c)} expired on 15 Oct 2026, and roadmap material needs an active NDA.`,
        decoy: item("expires", "15 Oct 2027"),
        falseClaim: `The NDA with ${org(c)} has expired, so the roadmap deck cannot be shared.`,
      };
    },
  },
  // 6. Home: repairs must now go through the agency's portal, not email (communication channel change, gmail).
  {
    name: "repairs-portal-only",
    roles: [],
    make: (_ps, user) => {
      const agent = { full: "Marta Velloso", email: "marta@hollins-lettings.example" };
      const body = (from: string) =>
        `Dear ${user.first},\n\nA quick note on how we handle maintenance. From ${from} all repair requests must be ` +
        `logged through the Hollins tenant portal (portal.hollins-lettings.example). Requests sent by email to this ` +
        `address will not be logged or passed to contractors.\n\nKind regards,\nMarta Velloso\nProperty Manager, ` +
        `Hollins Lettings`;
      const item = (from: string): Planted => ({
        sourceId: "gmail",
        kind: "mail",
        title: "Change to how repairs are reported",
        text: mail(agent, user, "Thu, 15 Oct 2026 10:05", body(from)),
        meta: people(agent),
      });
      return {
        text: "email the letting agent that the boiler's packed in again and ask them to send someone this week",
        item: item("Monday 19 October"),
        detail:
          "Hollins Lettings no longer logs repairs sent by email since 19 Oct; they must go through the tenant portal.",
        decoy: item("Monday 4 January 2027"),
        falseClaim: "Repair requests by email are no longer logged, so the boiler must be reported through the portal.",
      };
    },
  },
  // 7. Family: a shellfish allergy against a seafood restaurant (restriction, gmail).
  {
    name: "seafood-lunch-allergy",
    roles: ["family"],
    make: (ps, user) => {
      const f = ps[0]!;
      const body = (result: string) =>
        `hiya,\n\nfinally got the allergy clinic results back this morning. ${result}\n\n` +
        `anyway how are you? still on for lunch soon?\n\nx ${f.first}`;
      const item = (result: string): Planted => ({
        sourceId: "gmail",
        kind: "mail",
        title: "allergy test results",
        text: mail(f, user, "Wed, 21 Oct 2026 09:48", body(result)),
        meta: people(f),
      });
      return {
        text:
          `Book a table for two at The Copper Pot (the seafood place by the river) for Sunday lunch, 8 November, ` +
          `for me and ${called(f, "family")}.`,
        item: item("I am allergic to shellfish, properly — they've given me an EpiPen to carry from now on."),
        detail: `${f.full} has just been confirmed allergic to shellfish, which matters for a seafood restaurant.`,
        decoy: item("I'm not allergic to shellfish after all — test was negative, so panic over and no EpiPen."),
        falseClaim: `${f.full} is allergic to shellfish, so a seafood restaurant is a bad choice.`,
      };
    },
  },
  // 8. Friends: the birthday drinks were moved to another Saturday (cancelled / moved, gmail).
  {
    name: "birthday-drinks-moved",
    roles: ["friend"],
    make: (ps, user) => {
      const f = ps[0]!;
      const body = (line: string) =>
        `Hey all!\n\nChange of plan for my birthday drinks: ${line} Same plan otherwise, Lantern Room from 8pm.\n\n` +
        `Can't wait 🎉\n${f.first}`;
      const item = (line: string): Planted => ({
        sourceId: "gmail",
        kind: "mail",
        title: "birthday drinks — change of date",
        text: mail(f, user, "Sat, 24 Oct 2026 13:31", body(line)),
        meta: people(f),
      });
      return {
        text: `Reserve a table for 8 at the Lantern Room on Saturday 7 November from 8pm for ${name(f)}'s birthday.`,
        item: item("we're moving it from Saturday 7 Nov to Saturday 14 Nov, as half of you are away on the 7th."),
        detail: `${f.full} moved the birthday drinks from Saturday 7 November to Saturday 14 November.`,
        decoy: item("we're moving it from Saturday 14 Nov to Saturday 7 Nov, as half of you are away on the 14th."),
        falseClaim: "The birthday drinks have moved off Saturday 7 November, so the booking is for the wrong date.",
      };
    },
  },
  // 9. Health: physio has ruled out high-impact exercise over the race date (restriction with a date, gmail).
  {
    name: "race-after-physio-advice",
    roles: [],
    make: (_ps, user) => {
      const physio = { full: "Harbourside Physio", email: "clinic@harbourside-physio.example" };
      const body = (until: string) =>
        `Dear ${user.first},\n\nThank you for coming in for your knee assessment. As discussed, please avoid ` +
        `high-impact exercise (running, jumping, racquet sports) until ${until}, and keep up the strengthening ` +
        `programme twice a day. Cycling and swimming are fine.\n\n` +
        `Best wishes,\nAnya Brightwell, MCSP\nHarbourside Physio`;
      const item = (until: string): Planted => ({
        sourceId: "gmail",
        kind: "mail",
        title: "Your knee assessment — follow-up advice",
        text: mail(physio, user, "Fri, 23 Oct 2026 17:12", body(until)),
        meta: people(physio),
      });
      return {
        text: "sign me up for the Riverside 10k on sunday 15 november, standard entry is fine",
        item: item("at least 1 December, when we'll reassess"),
        detail: "The physio advised no running or other high-impact exercise until at least 1 December, after the 10k.",
        decoy: item("at least 20 October, when we'll reassess"),
        falseClaim: "The physio has ruled out running until after 15 November, so the 10k should not be entered.",
      };
    },
  },
  // 10. Travel: the passport expires before the trip (expiry, drive).
  {
    name: "passport-expiry-trip",
    roles: [],
    make: (_ps, user) => {
      const doc = (expiry: string) =>
        `Travel documents\n\nPassport (UK) — ${user.full}\nNumber: ••••4417\nIssued: 12 Nov 2016\n` +
        `Expires: ${expiry}\n\nGlobal Health Insurance Card — valid to 2030\nTrusted traveller: none\n` +
        `Frequent flyer: see password manager`;
      return {
        text: "Book me return flights to Lisbon, out Thursday 19 November and back Sunday 22 November.",
        item: { sourceId: "drive", kind: "doc", title: "Travel documents", text: doc("12 Nov 2026") },
        detail: "Robin's passport expires on 12 Nov 2026, before the 19 November flight to Lisbon.",
        decoy: { sourceId: "drive", kind: "doc", title: "Travel documents", text: doc("12 Nov 2029") },
        falseClaim: "Robin's passport expires before the Lisbon trip, so it must be renewed before booking.",
      };
    },
  },
  // 11. Sales: the client has moved offices (location change, gmail).
  {
    name: "client-office-moved",
    roles: ["client"],
    make: (ps, user) => {
      const c = ps[0]!;
      const body = (when: string, line: string) =>
        `Hi ${user.first},\n\nLooking forward to Wednesday. One practical note: ${when} ${line}\n\n` +
        `Ask for me at reception and they'll bring you up.\n\nBest,\n${c.full}\n${c.title ?? ""}, ${org(c)}`;
      const item = (when: string, line: string): Planted => ({
        sourceId: "gmail",
        kind: "mail",
        title: "Re: Wednesday's meeting",
        text: mail(c, user, "Mon, 26 Oct 2026 15:37", body(when, line)),
        meta: people(c),
      });
      return {
        text:
          `Order me a car to ${poss(org(c))} office for the 10:00 with ${name(c)} on Wednesday 4 November; ` +
          `use the address on their account.`,
        item: item(
          "we moved offices last week.",
          "We're now at 40 Harrow Lane, Unit 3 — the Kingsway building is closed, so please don't go there.",
        ),
        detail: `${org(c)} has moved to 40 Harrow Lane; the old Kingsway address on the account is closed.`,
        decoy: item(
          "we're moving offices in January.",
          "Until then we're still at the Kingsway building as usual — the new place is 40 Harrow Lane from 2027.",
        ),
        falseClaim: `${org(c)} has moved offices, so the address on the account is out of date for Wednesday.`,
      };
    },
  },
  // 12. Money: penalty-free withdrawals are used up (quantity / capacity, gmail notification).
  {
    name: "savings-withdrawal-limit",
    roles: [],
    make: (_ps, user, rng) => {
      const amount = rng.pick(["2,000", "3,000", "2,500"]);
      const bank = { full: "Marlow Mutual", email: "alerts@marlowmutual.example" };
      const body = (used: string) =>
        `Hello ${user.first},\n\nYour Bonus Saver: you have now used ${used} penalty-free withdrawals for 2026. ` +
        `If you make more withdrawals than that before 1 January, the account earns the base rate of 1.1% instead ` +
        `of 4.6% for the rest of the year.\n\nMarlow Mutual — this is an automated message, please do not reply.`;
      const item = (used: string): Planted => ({
        sourceId: "gmail",
        kind: "notification",
        title: "Your Bonus Saver withdrawal allowance",
        text: mail(bank, user, "Tue, 20 Oct 2026 07:00", body(used)),
        meta: people(bank),
      });
      return {
        text: `Move £${amount} from my Bonus Saver to my current account today please.`,
        item: item("3 of your 3"),
        detail:
          "All 3 penalty-free Bonus Saver withdrawals for 2026 are used; another drops the rate from 4.6% to 1.1%.",
        decoy: item("1 of your 3"),
        falseClaim: "The withdrawal would exceed the penalty-free allowance and cut the savings rate to 1.1%.",
      };
    },
  },
  // 13. Engineering: the feature is blocked on a security review (dependency / status change, slack).
  {
    name: "sso-release-blocked",
    roles: ["client", "colleague"],
    make: ([c, eng]) => {
      const chat = (line: string) =>
        `#release-train\n[10:12] ${eng!.full}: Status on SSO for enterprise accounts: ${line}\n` +
        `[10:14] Rowan Pell: ok, thanks for the update\n[10:15] ${eng!.full}: will post again after standup`;
      const item = (line: string): Planted => ({
        sourceId: "slack",
        kind: "chat",
        title: "#release-train",
        text: chat(line),
        meta: people(eng!),
      });
      return {
        text: `Let ${name(c!)} at ${org(c!)} know SSO will be switched on for their account on Monday 9 November.`,
        item: item("blocked. Security review slipped to 16 Nov, so no release before the 18th at the earliest."),
        detail: "SSO is blocked on a security review moved to 16 Nov and will not ship before 18 Nov.",
        decoy: item("unblocked. Security review signed off on Friday, so we're on track for Monday's release."),
        falseClaim: "SSO is blocked on the security review and will not be ready on Monday 9 November.",
      };
    },
  },
  // 14. Ops: the meeting room's capacity was cut (capacity, drive).
  {
    name: "room-capacity-workshop",
    roles: ["colleague"],
    make: (ps) => {
      const c = ps[0]!;
      const doc = (cap: number) =>
        `Office rooms — after the refit\nUpdated by ${c.full}\n\nOrchard (2nd floor): max ${cap} people, screen + ` +
        `whiteboard\nMeadow (2nd floor): max 6, phone booth style\nHarbour (ground): max 20, needs facilities ` +
        `booking 48h ahead\n\nCapacities are fire-safety limits, please stick to them.`;
      return {
        text:
          "Book the Orchard room for the partner workshop on Tuesday 10 November, 14:00–17:00. " +
          "There'll be 12 of us.",
        item: { sourceId: "drive", kind: "doc", title: "Office rooms — capacities", text: doc(8), meta: people(c) },
        detail: "The Orchard room is now limited to 8 people after the refit, fewer than the 12 attending.",
        decoy: { sourceId: "drive", kind: "doc", title: "Office rooms — capacities", text: doc(16), meta: people(c) },
        falseClaim: "The Orchard room cannot hold 12 people, so the workshop needs a bigger room.",
      };
    },
  },
  // 15. Health / sales: a dentist appointment overlaps the requested call (time clash, calendar).
  {
    name: "call-vs-dentist",
    roles: ["client"],
    make: (ps) => {
      const c = ps[0]!;
      const event = (day: string, iso: string): Planted => ({
        sourceId: "calendar",
        kind: "event",
        title: "Dentist — check-up and hygienist",
        text:
          `When: ${day} 2026, 14:45–15:45\nWhere: Larkfield Dental, 9 Cobb Street\nAttendees: Robin Carter\n\n` +
          `Arrive 10 minutes early. Cancellation needs 48 hours' notice or a £40 fee applies.`,
        meta: { start: iso },
      });
      return {
        text:
          `Set up a call with ${c.full} for Thursday 5 November at 15:00 to walk through the proposal, ` +
          `30 minutes is enough.`,
        item: event("Thursday 5 Nov", "2026-11-05T14:45:00Z"),
        detail: "Robin has a dentist appointment on Thursday 5 November 14:45–15:45, which overlaps the 15:00 call.",
        decoy: event("Thursday 12 Nov", "2026-11-12T14:45:00Z"),
        falseClaim: "The 15:00 call on Thursday 5 November clashes with a dentist appointment.",
      };
    },
  },
];

export function plantHeldout5(world: World, seed: number, variant: "hidden" | "control" = "hidden"): HiddenTask[] {
  const rng = new Rng(seed * 5_000_011);
  const used = new Set<string>();
  const pick = (relation: Person["relation"]): Person => {
    let pool = world.people.filter((p) => p.relation === relation && !used.has(p.id));
    if (pool.length === 0) pool = world.people.filter((p) => p.relation !== "self" && !used.has(p.id));
    if (pool.length === 0) pool = world.people.filter((p) => p.relation !== "self");
    const p = rng.pick(pool);
    used.add(p.id);
    return p;
  };
  const tasks: HiddenTask[] = [];
  TEMPLATES.forEach((t, i) => {
    const ps = t.roles.map(pick);
    const made = t.make(ps, world.user, rng);
    const planted = variant === "hidden" ? made.item : made.decoy;
    const ref = `heldout5-${i}`;
    world.items.push({
      id: `${planted.sourceId}:${ref}`,
      sourceId: planted.sourceId,
      ref,
      title: planted.title,
      text: planted.text,
      updatedAt: world.now - 86_400_000,
      kind: planted.kind,
      facts: [],
      noise: false,
      ...(planted.meta ? { meta: planted.meta } : {}),
    });
    tasks.push({
      id: variant === "hidden" ? `w${seed}:heldout5:${t.name}` : `w${seed}:heldout5-control:${t.name}`,
      template: t.name,
      text: made.text,
      detail: variant === "hidden" ? made.detail : made.falseClaim,
    });
  });
  return tasks;
}

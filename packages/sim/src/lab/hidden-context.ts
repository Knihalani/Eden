/**
 * Tasks whose answer depends on context the request does not ask for (docs/research/agent-hidden.md): "set up dinner
 * on Thursday at 19:00" when the calendar already has parents' evening then; "pay invoice INV-4821" when it was paid
 * yesterday. Each task plants one item stating the hidden fact in a simulated world (≈1,500 other items); the grader
 * checks whether the answer raises it. This is the case Eden is for: the agent was not asked to look, and a search
 * tool only helps if it thinks to.
 *
 * World time is fixed (Tuesday 27 October 2026, 09:00 UTC), so dates are written out.
 */
import { requestedRange, timeWindow } from "@eden/engine";
import { Rng } from "../rng";
import type { Person, World, WorldItem } from "../world";

export interface HiddenTask {
  id: string;
  template: string;
  /** What the user asks: an action that does not name the hidden context. */
  text: string;
  /** The hidden consideration a good answer raises, as the grader reads it. */
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

/** The ten templates: the person(s) they are about, the request, the planted item and the hidden detail. */
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
    name: "calendar-clash",
    roles: ["friend"],
    make: ([p]) => ({
      text: `Set up dinner with ${p!.full} on Thursday 29 October at 19:00 and send ${p!.first} an invite.`,
      item: {
        sourceId: "calendar",
        kind: "event",
        title: "Parents' evening, Highbury Primary",
        text: "Thursday 29 October 2026, 18:30-20:30. Hall B. Bring the reading log.",
        meta: { start: "2026-10-29T18:30:00Z" },
      },
      detail: "a clash: parents' evening at Highbury Primary on Thursday 29 October, 18:30-20:30",
      decoy: {
        sourceId: "calendar",
        kind: "event",
        title: "Parents' evening, Highbury Primary",
        text: "Thursday 5 November 2026, 18:30-20:30. Hall B. Bring the reading log.",
        meta: { start: "2026-11-05T18:30:00Z" },
      },
      falseClaim: "says Thursday 29 October at 19:00 clashes with something or that Robin is busy then",
    }),
  },
  {
    name: "already-paid",
    roles: ["vendor"],
    make: ([p], _u, rng) => {
      const inv = `INV-${4_000 + rng.int(0, 4_999)}`;
      const ref = `PAY-${100_000 + rng.int(0, 799_999)}`;
      const org = p!.org ?? "the supplier";
      return {
        text: `${org} says invoice ${inv} is overdue. Please pay it today.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: `Payment sent: ${inv} to ${org}`,
          text: `Your bank transfer of £4,200.00 to ${org} for invoice ${inv} was sent on Monday 26 October. Reference ${ref}.`,
          meta: { people: "payments@northbank.example" },
        },
        detail: `invoice ${inv} was already paid on Monday 26 October (reference ${ref})`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: `Payment sent: INV-${Number(inv.slice(4)) - 17} to ${org}`,
          text: `Your bank transfer of £3,100.00 to ${org} for invoice INV-${Number(inv.slice(4)) - 17} was sent on Monday 26 October. Reference ${ref}.`,
          meta: { people: "payments@northbank.example" },
        },
        falseClaim: `says invoice ${inv} has already been paid`,
      };
    },
  },
  {
    name: "dietary",
    roles: ["friend"],
    make: ([p]) => ({
      text: `Book a table for me and ${p!.first} somewhere nice on Saturday night.`,
      item: {
        sourceId: "gmail",
        kind: "mail",
        title: "Re: catching up soon?",
        text: "Hey! Would love to. Heads up, I've gone fully vegan since September, so somewhere with proper vegan options please :)",
        meta: { people: who(p!) },
      },
      detail: `${p!.first} is vegan (since September), so the restaurant needs vegan options`,
      decoy: {
        sourceId: "gmail",
        kind: "mail",
        title: "Re: catching up soon?",
        text: "Hey! Would love to. Anywhere is fine by me, I eat everything :) Saturday works.",
        meta: { people: who(p!) },
      },
      falseClaim: `says ${p!.first} has a dietary restriction (vegan, vegetarian, an allergy or similar)`,
    }),
  },
  {
    name: "legal-hold",
    roles: ["client"],
    make: ([p]) => ({
      text: `Reply to ${p!.full} and tell them we'll ship the SSO integration next month.`,
      item: {
        sourceId: "slack",
        kind: "chat",
        title: "#legal",
        text:
          `Reminder from Legal (20 Oct): do not commit delivery dates to ${p!.org ?? "the client"} until the MSA is ` +
          "countersigned. It is still with their counsel.",
      },
      detail: `Legal said not to commit delivery dates to ${p!.org ?? "the client"} until the MSA is countersigned`,
      decoy: {
        sourceId: "slack",
        kind: "chat",
        title: "#legal",
        text: `Reminder from Legal (20 Oct): the MSA with ${p!.org ?? "the client"} is countersigned and filed. Delivery dates can be shared as usual.`,
      },
      falseClaim: "says Legal has told us not to commit delivery dates, or that the MSA is not yet signed",
    }),
  },
  {
    name: "out-of-office",
    roles: ["colleague", "colleague"],
    make: ([p, q]) => ({
      text: `Ask ${p!.first} to review the board deck by Friday.`,
      item: {
        sourceId: "gmail",
        kind: "mail",
        title: "Automatic reply: board deck",
        text:
          "I'm on parental leave until Monday 16 November with no access to email. For anything urgent please " +
          `contact ${q!.full} (${q!.email}).`,
        meta: { people: who(p!) },
      },
      detail: `${p!.first} is on leave until 16 November (the auto-reply names ${q!.first} for urgent things)`,
      decoy: {
        sourceId: "gmail",
        kind: "mail",
        title: "Automatic reply: expenses",
        text: "I was on leave until Monday 19 October and am now catching up on email. Thanks for your patience.",
        meta: { people: who(p!) },
      },
      falseClaim: `says ${p!.first} is on leave or unavailable to review it by Friday`,
    }),
  },
  {
    name: "travel-clash",
    roles: ["client"],
    make: ([p]) => ({
      text: `Accept the invite to the ${p!.org ?? "partner"} workshop on Wednesday 4 November at 10:00.`,
      item: {
        sourceId: "calendar",
        kind: "event",
        title: "Flight BA 492 London Heathrow to Madrid",
        text: "Wednesday 4 November 2026, departs 07:10 LHR T5, arrives 10:35 MAD. Booking ref K8QZT2.",
        meta: { start: "2026-11-04T07:10:00Z" },
      },
      detail: "a flight to Madrid (BA 492) departing 07:10 on Wednesday 4 November, which clashes with the workshop",
      decoy: {
        sourceId: "calendar",
        kind: "event",
        title: "Flight BA 492 London Heathrow to Madrid",
        text: "Thursday 5 November 2026, departs 07:10 LHR T5, arrives 10:35 MAD. Booking ref K8QZT2.",
        meta: { start: "2026-11-05T07:10:00Z" },
      },
      falseClaim: "says Wednesday 4 November at 10:00 clashes with a flight or another commitment",
    }),
  },
  {
    name: "discount-cap",
    roles: ["client"],
    make: ([p]) => ({
      text: `Offer ${p!.org ?? p!.full} 15% off so we can close their renewal this week.`,
      item: {
        sourceId: "slack",
        kind: "chat",
        title: "#finance-approvals",
        text: "Policy for Q4 renewals: discounts above 10% need CFO sign-off before they are offered. (Finance, 19 Oct)",
      },
      detail: "discounts above 10% need CFO sign-off before they are offered (Finance policy for Q4 renewals)",
      decoy: {
        sourceId: "slack",
        kind: "chat",
        title: "#finance-approvals",
        text: "Policy for Q4 renewals: sales can offer discounts of up to 20% without further approval. (Finance, 19 Oct)",
      },
      falseClaim: "says a 15% discount needs extra approval or exceeds a policy limit",
    }),
  },
  {
    name: "allergy",
    roles: ["friend"],
    make: ([p]) => ({
      text: `Order a box of chocolates for ${p!.first}'s birthday.`,
      item: {
        sourceId: "drive",
        kind: "doc",
        title: "People notes",
        text: `${p!.full}: severe nut allergy, always check gifts and restaurants. Loves dark chocolate, hates coconut.`,
      },
      detail: `${p!.first} has a severe nut allergy, so the chocolates must be nut-free`,
      decoy: {
        sourceId: "drive",
        kind: "doc",
        title: "People notes",
        text: `${p!.full}: loves dark chocolate and anything with hazelnuts, hates coconut.`,
      },
      falseClaim: `says ${p!.first} has an allergy or cannot have the chocolates`,
    }),
  },
  {
    name: "moved-call",
    roles: ["client"],
    make: ([p], u) => ({
      text: `Remind ${p!.full} about our 3pm call tomorrow.`,
      item: {
        sourceId: "gmail",
        kind: "mail",
        title: "Tomorrow's call",
        text: `Hi ${u.first}, could we push tomorrow's call to 4:30pm? Something came up at 3. Thanks, ${p!.first}`,
        meta: { people: who(p!) },
      },
      detail: `${p!.first} asked to move tomorrow's call from 3pm to 4:30pm`,
      decoy: {
        sourceId: "gmail",
        kind: "mail",
        title: "Tomorrow's call",
        text: `Hi ${u.first}, all good for 3pm tomorrow, talk then. Thanks, ${p!.first}`,
        meta: { people: who(p!) },
      },
      falseClaim: "says the 3pm call has been moved, rescheduled or cancelled",
    }),
  },
  {
    name: "already-sent",
    roles: ["colleague"],
    make: ([p], u) => ({
      text: `Send ${p!.full} the Q3 report.`,
      item: {
        sourceId: "gmail",
        kind: "mail",
        title: "Q3 report",
        text: `From ${u.full} to ${p!.full}, Tuesday 27 October 08:12: Hi ${p!.first}, attached is the Q3 report (Q3-report-final.pdf).`,
        meta: { people: `${who(u)}; ${who(p!)}` },
      },
      detail: `the Q3 report was already sent to ${p!.first} this morning at 08:12`,
      decoy: {
        sourceId: "gmail",
        kind: "mail",
        title: "Q2 report",
        text: `From ${u.full} to ${p!.full}, Monday 20 July 09:40: Hi ${p!.first}, attached is the Q2 report (Q2-report-final.pdf).`,
        meta: { people: `${who(u)}; ${who(p!)}` },
      },
      falseClaim: "says the Q3 report has already been sent",
    }),
  },
];

/**
 * Plants each template's item in `world` (mutating its items) and returns the tasks, one per template. The "control"
 * variant plants the template's decoy instead: a near-miss about the same people and topic that should change nothing
 * (an event the next week, a different invoice paid, an out-of-office that ended), and its task's `detail` is the
 * false concern a careless answer would raise. Same people and request either way.
 */
export function plantHidden(world: World, seed: number, variant: "hidden" | "control" = "hidden"): HiddenTask[] {
  const rng = new Rng(seed * 104_723);
  const used = new Set<string>();
  const pick = (relation: Person["relation"]) => {
    const pool = world.people.filter((p) => p.relation === relation && !used.has(p.id));
    const p = pool[rng.int(0, pool.length - 1)] ?? world.people.find((x) => x.relation !== "self" && !used.has(x.id))!;
    used.add(p.id);
    return p;
  };
  return TEMPLATES.map((t, i) => {
    const people = t.roles.map(pick);
    const made = t.make(people, world.user, rng);
    const control = variant === "control";
    const item = control ? made.decoy : made.item;
    const ref = `hidden-${i}`;
    world.items.push({
      id: `${item.sourceId}:${ref}`,
      sourceId: item.sourceId,
      ref,
      title: item.title,
      text: item.text,
      updatedAt: world.now - 86_400_000,
      kind: item.kind,
      facts: [],
      noise: false,
      ...(item.meta ? { meta: item.meta } : {}),
    });
    const id = `w${seed}:${control ? "hidden-control" : "hidden"}:${t.name}`;
    return { id, template: t.name, text: made.text, detail: control ? made.falseClaim : made.detail };
  });
}

/**
 * Gives a planted item the world's own formats, so it is as findable as the items around it: mail carries a
 * From/To/Date header (sources search it, as Gmail searches `from:`), events a When/Attendees block, chat timestamped
 * "Name: " lines. Applied to every planted item, of either suite, before the sources are built.
 */
export function dress(world: World, item: WorldItem): void {
  const user = world.user;
  const date = new Date(item.updatedAt)
    .toUTCString()
    .replace(":00 GMT", "")
    .replace(/^(\w+),/, "$1,");
  if (item.kind === "mail" && !/^From: /.test(item.text)) {
    const people = (item.meta?.people ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const sender = people.find((p) => !p.includes(user.email)) ?? `${user.full} <${user.email}>`;
    const sent = sender.includes(user.email) || people.every((p) => p.includes(user.email));
    const from = sent ? `${user.full} <${user.email}>` : sender;
    const to = sent ? (people.find((p) => !p.includes(user.email)) ?? "") : `${user.full} <${user.email}>`;
    item.text = `From: ${from}\nTo: ${to}\nDate: ${date}\n\n${item.text}`;
  } else if (item.kind === "event" && !/^When: /.test(item.text)) {
    const attendees = (item.meta?.people ?? "")
      .split(";")
      .map((s) => s.replace(/<.*>/, "").trim())
      .filter(Boolean);
    item.text = `When: ${item.text}\nAttendees: ${[user.full, ...attendees].join(", ")}`;
  } else if (item.kind === "chat" && !/^\[\d\d:\d\d\]/.test(item.text)) {
    item.text = `[09:14] ${item.text}`;
  }
}

/**
 * Clears the slot a request asks for: a request that names a day and a time of it ("Thursday 29 October at 19:00",
 * "Thursday afternoon") gets the world's other events in that window removed, in both variants, so a clash an answer
 * raises is the planted one or none. Without it, a control task was graded a false alarm when the agent rightly
 * flagged a real event the generated calendar happened to hold then. The window is the named time ±3 hours, or the
 * named part of the day. Never removes a planted item.
 */
export function clearSlot(world: World, text: string, keep: ReadonlySet<string>): number {
  const days = timeWindow(text, world.now)?.days;
  const range = requestedRange(text);
  if (!days || days.size === 0 || !range) return 0;
  const before = world.items.length;
  world.items = world.items.filter((it) => {
    if (keep.has(it.id) || it.kind !== "event" || !it.meta?.start) return true;
    const day = it.meta.start.slice(0, 10);
    const m = /T(\d{2}):(\d{2})/.exec(it.meta.start);
    const at = m ? Number(m[1]) * 60 + Number(m[2]) : -1;
    return !(days.has(day) && at >= range.from && at <= range.to);
  });
  return before - world.items.length;
}

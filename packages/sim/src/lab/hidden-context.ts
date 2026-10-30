/**
 * Tasks whose answer depends on context the request does not ask for (docs/research/agent-hidden.md): "set up dinner
 * on Thursday at 19:00" when the calendar already has parents' evening then; "pay invoice INV-4821" when it was paid
 * yesterday. Each task plants one item stating the hidden fact in a simulated world (≈1,500 other items); the grader
 * checks whether the answer raises it. This is the case Eden is for: the agent was not asked to look, and a search
 * tool only helps if it thinks to.
 *
 * World time is fixed (Tuesday 27 October 2026, 09:00 UTC), so dates are written out.
 */
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
  make: (ps: Person[], user: Person, rng: Rng) => { text: string; item: Planted; detail: string };
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
    }),
  },
];

/** Plants each template's item in `world` (mutating its items) and returns the tasks, one per template. */
export function plantHidden(world: World, seed: number): HiddenTask[] {
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
    const { text, item, detail } = t.make(people, world.user, rng);
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
    return { id: `w${seed}:hidden:${t.name}`, template: t.name, text, detail };
  });
}

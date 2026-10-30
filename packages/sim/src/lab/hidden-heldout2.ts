/**
 * Held-out hidden-context suite 2: fifteen work requests (sales, account management, product, engineering, hiring,
 * finance approvals, board, procurement) whose right answer turns on a fact the request never mentions, stored in a
 * single planted item. The "control" variant plants a near-miss decoy instead: same people, source and topic, with
 * the deciding fact changed so that nothing should change the assistant's plan.
 *
 * Written blind to the engine, so it measures generalisation rather than fit to the other hidden-context suites.
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
const orgOf = (p: Person) => p.org ?? "their company";
const domainOf = (p: Person) => p.email.split("@")[1] ?? "example.com";
const callName = (p: Person) => p.nick ?? p.first;

// Fictional replacement contacts, so a "left the company" fact names someone who is not elsewhere in the world.
const NEW_CONTACTS: [string, string][] = [
  ["Marisol", "Okafor"],
  ["Teodor", "Lindqvist"],
  ["Hollis", "Brennan"],
  ["Anouk", "Varga"],
  ["Desmond", "Achterberg"],
];

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
    // Superseded decision: the discount Robin remembers was pulled after a pricing review.
    name: "discount-superseded",
    roles: ["client", "colleague"],
    make: ([c, s]) => {
      const org = orgOf(c!);
      return {
        text:
          `Please draft an email to ${c!.full} at ${org} offering the 15% multi-year discount on their renewal, ` +
          `and copy ${s!.first}.`,
        item: {
          sourceId: "slack",
          kind: "chat",
          title: "#deal-desk",
          text:
            `${s!.full}: Heads up on ${org}. After Friday's pricing review finance pulled the 15% multi-year ` +
            `discount we floated. The most we can put in writing now is 8%, and only on a three-year term. ` +
            `Anything above that goes back to the deal desk.`,
          meta: { people: who(s!) },
        },
        detail: `Finance withdrew the 15% discount for ${org} after Friday's pricing review; the cap is now 8% on a three-year term.`,
        decoy: {
          sourceId: "slack",
          kind: "chat",
          title: "#deal-desk",
          text:
            `${s!.full}: Update on ${org}. Friday's pricing review signed off the 15% multi-year discount we ` +
            `floated, it's logged in the approvals sheet, so we're clear to put it in writing.`,
          meta: { people: who(s!) },
        },
        falseClaim: `The 15% discount for ${org} has been withdrawn or still needs approval before it can be offered.`,
      };
    },
  },
  {
    // State change: the client contact has left; their mailbox bounces and there is a named replacement.
    name: "contact-left",
    roles: ["client"],
    make: ([c], _user, rng) => {
      const [f, l] = rng.pick(NEW_CONTACTS);
      const org = orgOf(c!);
      const next = `${f} ${l}`;
      const nextEmail = `${f.toLowerCase()}.${l.toLowerCase()}@${domainOf(c!)}`;
      return {
        text: `email ${c!.first} the Q4 onboarding plan`,
        item: {
          sourceId: "crm",
          kind: "contact",
          title: `${c!.full} (${org})`,
          text:
            `Contact: ${c!.full}, ${org}. Status: no longer at ${org} as of 16 Oct 2026; the old address bounces. ` +
            `Primary contact for the account is now ${next} (Head of Procurement), ${nextEmail}.`,
        },
        detail: `${c!.full} left ${org} on 16 Oct 2026; the plan should go to ${next} (${nextEmail}) instead.`,
        decoy: {
          sourceId: "crm",
          kind: "contact",
          title: `${c!.full} (${org})`,
          text:
            `Contact: ${c!.full}, ${org}. Title changed to VP Operations on 16 Oct 2026; same email address. ` +
            `Remains primary contact for the account. ${next} (Head of Procurement, ${nextEmail}) added as a ` +
            `secondary contact for invoicing only.`,
        },
        falseClaim: `${c!.first} has left ${org} and the onboarding plan should go to someone else.`,
      };
    },
  },
  {
    // Someone's constraint: the co-interviewer is offline all day on the requested Thursday.
    name: "interviewer-out",
    roles: ["colleague"],
    make: ([p]) => ({
      text: `set up the backend candidate interview for thursday 2pm, me and ${p!.first} on the panel`,
      item: {
        sourceId: "slack",
        kind: "chat",
        title: `DM with ${p!.full}`,
        text:
          `${p!.full}: fyi I've been called for jury service on Thu 29 Oct. Completely offline all day, no phone ` +
          `in court. Back on Friday.`,
        meta: { people: who(p!) },
      },
      detail: `${p!.first} is on jury service all day Thursday 29 Oct and cannot sit on the 2pm panel.`,
      decoy: {
        sourceId: "slack",
        kind: "chat",
        title: `DM with ${p!.full}`,
        text:
          `${p!.full}: fyi I've been called for jury service on Thu 5 Nov. Completely offline all day, no phone ` +
          `in court. Back the day after.`,
        meta: { people: who(p!) },
      },
      falseClaim: `${p!.first} is unavailable on Thursday 29 Oct for the interview.`,
    }),
  },
  {
    // Conflicting commitment: a vendor walkthrough already sits inside the window Robin wants to block.
    name: "block-clash",
    roles: ["vendor"],
    make: ([v]) => ({
      text: "Block Wednesday 3–5pm for prep on the quarterly pipeline review.",
      item: {
        sourceId: "calendar",
        kind: "event",
        title: `Security audit walkthrough – ${orgOf(v!)}`,
        text:
          `Wed 28 Oct, 15:30–16:30 UTC. ${v!.full} (${orgOf(v!)}) walks us through the remediation items from ` +
          `the annual audit. Organiser: ${v!.full}. Accepted.`,
        meta: { start: "2026-10-28T15:30:00Z", people: who(v!) },
      },
      detail: `Robin has already accepted the ${orgOf(v!)} audit walkthrough on Wednesday 28 Oct at 15:30–16:30.`,
      decoy: {
        sourceId: "calendar",
        kind: "event",
        title: `Security audit walkthrough – ${orgOf(v!)}`,
        text:
          `Wed 28 Oct, 17:15–18:00 UTC. ${v!.full} (${orgOf(v!)}) walks us through the remediation items from ` +
          `the annual audit. Organiser: ${v!.full}. Accepted.`,
        meta: { start: "2026-10-28T17:15:00Z", people: who(v!) },
      },
      falseClaim: `The ${orgOf(v!)} audit walkthrough clashes with the Wednesday 3–5pm block.`,
    }),
  },
  {
    // Policy limit: the amount is over the threshold where CFO sign-off alone is enough.
    name: "po-threshold",
    roles: ["vendor"],
    make: ([v]) => {
      const org = orgOf(v!);
      return {
        text: `Raise a PO for the ${org} annual licence renewal, £48k, and route it to the CFO to sign.`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: "Procurement policy v4",
          text:
            "Procurement policy, version 4, effective 1 October 2026. Purchases under £10,000 need budget-holder " +
            "approval. From £10,000 to £40,000 the CFO approves. Above £40,000, including renewals, two competing " +
            "quotes are required and the Audit Committee approves; CFO sign-off alone is not sufficient.",
        },
        detail: `Procurement policy v4 requires two quotes and Audit Committee approval above £40,000, so CFO sign-off alone won't do for £48k.`,
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: "Procurement policy v4",
          text:
            "Procurement policy, version 4, effective 1 October 2026. Purchases under £10,000 need budget-holder " +
            "approval. From £10,000 to £75,000 the CFO approves. Above £75,000, including renewals, two competing " +
            "quotes are required and the Audit Committee approves; CFO sign-off alone is not sufficient.",
        },
        falseClaim: `The £48k ${org} renewal needs competing quotes or committee approval beyond the CFO.`,
      };
    },
  },
  {
    // Already done: finance has paid the invoice Robin is about to approve.
    name: "invoice-already-paid",
    roles: ["vendor", "colleague"],
    make: ([v, f], _user, rng) => {
      const org = orgOf(v!);
      const inv = `INV-${rng.int(20000, 89999)}`;
      return {
        text: `can you approve ${v!.first}'s october invoice in the finance queue`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: `Remittance: ${org} ${inv}`,
          text:
            `Hi Robin, just closing the loop: we paid ${org}'s October invoice ${inv} by BACS on 23 Oct, ` +
            `remittance below. It was on the urgent run because of their late-payment terms. Thanks, ${f!.first}`,
          meta: { people: who(f!) },
        },
        detail: `${f!.full} already paid ${org}'s October invoice ${inv} by BACS on 23 Oct.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: `Remittance: ${org} ${inv}`,
          text:
            `Hi Robin, just closing the loop: we paid ${org}'s September invoice ${inv} by BACS on 23 Oct, ` +
            `remittance below. It was on the urgent run because of their late-payment terms. Thanks, ${f!.first}`,
          meta: { people: who(f!) },
        },
        falseClaim: `${org}'s October invoice has already been paid.`,
      };
    },
  },
  {
    // Deadline already passed: the client's portal closed yesterday.
    name: "rfp-deadline-passed",
    roles: ["client"],
    make: ([c]) => {
      const org = orgOf(c!);
      return {
        text: `Get our response to the ${org} RFP submitted by the end of the week.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: `${org} supplier tender – submission instructions`,
          text:
            `Dear bidders, responses must be uploaded to the supplier portal by 17:00 UK time on Monday 26 October. ` +
            `The portal locks automatically at that time and late submissions cannot be accepted. Regards, ` +
            `${c!.full}`,
          meta: { people: who(c!) },
        },
        detail: `The ${org} portal closed at 17:00 on Monday 26 Oct, so the end-of-week submission is already too late.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: `${org} supplier tender – submission instructions`,
          text:
            `Dear bidders, responses must be uploaded to the supplier portal by 17:00 UK time on Monday 2 November. ` +
            `The portal locks automatically at that time and late submissions cannot be accepted. Regards, ` +
            `${c!.full}`,
          meta: { people: who(c!) },
        },
        falseClaim: `The ${org} RFP deadline has already passed.`,
      };
    },
  },
  {
    // Confidentiality: the deck holds unannounced material and is internal only.
    name: "roadmap-confidential",
    roles: ["vendor"],
    make: ([v]) => ({
      text: `Forward the H1 2027 roadmap deck to ${v!.full} so they can scope the integration work.`,
      item: {
        sourceId: "drive",
        kind: "doc",
        title: "H1 2027 roadmap (deck)",
        text:
          "H1 2027 roadmap. Strictly internal: slides 6–9 describe the unannounced Halcyon acquisition and the " +
          "pricing changes that follow it. Not to be shared outside Northwind, including partners under NDA, until " +
          "legal clears an external cut (expected 12 Nov).",
      },
      detail:
        "The H1 2027 roadmap deck is internal only (unannounced acquisition) and cannot go to a vendor until legal clears an external cut around 12 Nov.",
      decoy: {
        sourceId: "drive",
        kind: "doc",
        title: "H1 2027 roadmap (deck)",
        text:
          "H1 2027 roadmap, external cut. Legal reviewed this version on 20 Oct and cleared it for partners under " +
          "NDA; the internal draft with acquisition slides is kept separately and is not this file.",
      },
      falseClaim: "The H1 2027 roadmap deck is confidential and must not be sent to the vendor.",
    }),
  },
  {
    // Wrong recipient: the client asked for signed paperwork to go to their legal mailbox.
    name: "contracts-mailbox",
    roles: ["client"],
    make: ([c]) => {
      const org = orgOf(c!);
      const box = `contracts@${domainOf(c!)}`;
      return {
        text: `Send ${c!.first} the countersigned MSA.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: "Paperwork going forward",
          text:
            `Hi Robin, quick process change on our side: under ${org}'s new signing policy I can't accept executed ` +
            `agreements personally any more. Please send all signed contracts to ${box}, and they'll log them. ` +
            `Best, ${c!.first}`,
          meta: { people: who(c!) },
        },
        detail: `${c!.first} asked that all signed contracts go to ${box}, not to them personally.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: "Paperwork going forward",
          text:
            `Hi Robin, quick note: ${box} has the draft MSA logged. When it's countersigned, just send it straight ` +
            `back to me as usual and I'll handle filing on our side. Best, ${c!.first}`,
          meta: { people: who(c!) },
        },
        falseClaim: `The countersigned MSA must go to ${org}'s contracts mailbox instead of ${c!.first}.`,
      };
    },
  },
  {
    // Dependency: the feature date depends on a certification that has slipped.
    name: "sso-blocked",
    roles: ["client", "colleague"],
    make: ([c, e]) => ({
      text: `let ${c!.first} know SSO goes live for them on 10 Nov, ${callName(e!)} said that was the plan`,
      item: {
        sourceId: "slack",
        kind: "chat",
        title: "#eng-identity",
        text:
          `${e!.full}: Enterprise SSO is blocked on the Okta SCIM certification. Their review queue moved us out, ` +
          `cert now not before 24 Nov, so the 10 Nov release date is off until that lands.`,
        meta: { people: who(e!) },
      },
      detail: `SSO is blocked on Okta SCIM certification, now not before 24 Nov, so 10 Nov can't be promised.`,
      decoy: {
        sourceId: "slack",
        kind: "chat",
        title: "#eng-identity",
        text:
          `${e!.full}: Enterprise SSO was blocked on the Okta SCIM certification, but the cert came through ` +
          `yesterday. Nothing else outstanding, so the 10 Nov release date holds.`,
        meta: { people: who(e!) },
      },
      falseClaim: "The SSO launch is blocked and 10 November cannot be promised.",
    }),
  },
  {
    // Policy: a headcount freeze covers the role Robin wants to open.
    name: "hiring-freeze",
    roles: ["colleague"],
    make: ([o]) => ({
      text: "Open a req for a second solutions engineer on my team and get it posted this week.",
      item: {
        sourceId: "gmail",
        kind: "mail",
        title: "Headcount: effective immediately",
        text:
          `All, following the Q3 close we're pausing all net-new headcount from 19 Oct until Q1 planning ` +
          `completes. Backfills only; any exception comes to me with a written business case. ${o!.first}`,
        meta: { people: who(o!) },
      },
      detail: `${o!.full} froze all net-new headcount from 19 Oct until Q1 planning; a second SE needs an exception.`,
      decoy: {
        sourceId: "gmail",
        kind: "mail",
        title: "Headcount: effective immediately",
        text:
          `All, following the Q3 close we're pausing net-new headcount in G&A from 19 Oct until Q1 planning. ` +
          `Revenue teams (Sales, Partnerships, Solutions Engineering) keep hiring to plan. ${o!.first}`,
        meta: { people: who(o!) },
      },
      falseClaim: "A hiring freeze blocks opening the solutions engineer req.",
    }),
  },
  {
    // State change: the meeting moved earlier, so the pack is due today.
    name: "board-moved",
    roles: ["colleague"],
    make: ([a]) => ({
      text: "schedule the board pack send for 48h before next week's board meeting",
      item: {
        sourceId: "calendar",
        kind: "event",
        title: "Board meeting – Q3 review",
        text:
          `Thu 29 Oct, 16:00–18:00 UTC. Moved forward from Thu 5 Nov at the chair's request. Organiser: ` +
          `${a!.full}. Attendees: board, exec team, Robin Carter.`,
        meta: { start: "2026-10-29T16:00:00Z", people: who(a!) },
      },
      detail:
        "The board meeting moved forward to Thursday 29 Oct at 16:00, so a 48h-ahead pack is due today, not next week.",
      decoy: {
        sourceId: "calendar",
        kind: "event",
        title: "Board meeting – Q3 review",
        text:
          `Thu 5 Nov, 16:00–18:00 UTC. Room changed to Boardroom 2 at the chair's request; date and time unchanged. ` +
          `Organiser: ${a!.full}. Attendees: board, exec team, Robin Carter.`,
        meta: { start: "2026-11-05T16:00:00Z", people: who(a!) },
      },
      falseClaim: "The board meeting has moved, so the board pack deadline is different from next week.",
    }),
  },
  {
    // Someone's constraint: the approver is on leave and has delegated signing authority.
    name: "manager-on-leave",
    roles: ["colleague", "colleague", "client"],
    make: ([m, d, c]) => {
      const org = orgOf(c!);
      return {
        text: `Send the ${org} partnership contract to my manager for approval today; it needs signing by Friday.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: "Out of office from Monday",
          text:
            `Hi Robin, reminder that I'm on leave 26 Oct to 6 Nov with no laptop. ${d!.full} has delegated ` +
            `signing authority for partnership contracts while I'm out, so route anything urgent to them. ` +
            `${m!.first} (your manager)`,
          meta: { people: who(m!) },
        },
        detail: `Robin's manager ${m!.full} is on leave until 6 Nov; ${d!.full} holds delegated signing authority.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: "Out of office later in November",
          text:
            `Hi Robin, heads up that I'm on leave 9 to 20 Nov with no laptop. ${d!.full} will have delegated ` +
            `signing authority for partnership contracts while I'm out. ${m!.first} (your manager)`,
          meta: { people: who(m!) },
        },
        falseClaim: "Robin's manager is away this week and cannot approve the contract.",
      };
    },
  },
  {
    // State change plus a stated wish: the deal is closed-lost and the contact asked not to be chased.
    name: "deal-closed-lost",
    roles: ["client"],
    make: ([c], _user, rng) => {
      const org = orgOf(c!);
      const value = rng.int(6, 24) * 10;
      return {
        text: `Add a follow-up task to chase ${c!.full} on the ${org} expansion and draft a friendly check-in email.`,
        item: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} – Expansion`,
          text:
            `Deal: ${org} – Expansion. Amount: £${value}k. Stage: Closed Lost (20 Oct 2026). Reason: chose an ` +
            `incumbent supplier. Note: ${c!.first} asked us not to contact them about expansion before the 2027 ` +
            `budget cycle.`,
        },
        detail: `The ${org} expansion deal was closed-lost on 20 Oct and ${c!.first} asked not to be contacted before the 2027 budget cycle.`,
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} – Expansion`,
          text:
            `Deal: ${org} – Expansion. Amount: £${value}k. Stage: Negotiation (updated 20 Oct 2026). Note: an ` +
            `incumbent supplier is also bidding; ${c!.first} expects a decision in November.`,
        },
        falseClaim: `The ${org} expansion deal is closed or ${c!.first} should not be chased.`,
      };
    },
  },
  {
    // Blocker: the vendor has not cleared security review, so the order form cannot be signed yet.
    name: "vendor-security-review",
    roles: ["vendor"],
    make: ([v]) => {
      const org = orgOf(v!);
      return {
        text: `Go ahead and sign ${org}'s order form for the data pipeline tool and send it back to ${v!.first}.`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: "Vendor risk register – Q4",
          text:
            `${org}: InfoSec status ON HOLD. Their SOC 2 Type II report expired 30 Sep 2026 and no bridge letter has ` +
            `been provided. No contracts or order forms to be signed until InfoSec approves a current report.`,
        },
        detail: `InfoSec has ${org} on hold (SOC 2 report expired 30 Sep, no bridge letter), so no order form can be signed yet.`,
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: "Vendor risk register – Q4",
          text:
            `${org}: InfoSec status APPROVED. Their previous SOC 2 Type II report expired 30 Sep 2026; the renewed ` +
            `report arrived 2 Oct and was accepted. Cleared for contracts and order forms.`,
        },
        falseClaim: `${org} has not cleared security review, so the order form cannot be signed.`,
      };
    },
  },
];

export function plantHeldout2(world: World, seed: number, variant: "hidden" | "control" = "hidden"): HiddenTask[] {
  const rng = new Rng(seed * 2_000_003);
  const used = new Set<string>();
  const tasks: HiddenTask[] = [];
  TEMPLATES.forEach((t, i) => {
    const ps: Person[] = [];
    for (const relation of t.roles) {
      const free = (p: Person) => !used.has(p.id) && !ps.includes(p);
      let pool = world.people.filter((p) => p.relation === relation && free(p));
      if (pool.length === 0) pool = world.people.filter((p) => p.relation !== "self" && free(p));
      if (pool.length === 0) pool = world.people.filter((p) => p.relation !== "self");
      const p = rng.pick(pool);
      used.add(p.id);
      ps.push(p);
    }
    // One call per template in both variants, so hidden and control draw the same people and values.
    const made = t.make(ps, world.user, rng);
    const planted = variant === "hidden" ? made.item : made.decoy;
    const ref = `heldout2-${i}`;
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
      id: variant === "hidden" ? `w${seed}:heldout2:${t.name}` : `w${seed}:heldout2-control:${t.name}`,
      template: t.name,
      text: made.text,
      detail: variant === "hidden" ? made.detail : made.falseClaim,
    });
  });
  return tasks;
}

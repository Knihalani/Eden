/**
 * Held-out suite 4: operations, legal, IT/security, HR and compliance. Each template is a request from Robin to get
 * something done whose right answer turns on one fact the request does not mention, stored in one planted item. The
 * "control" variant plants a near-miss decoy instead (same people, source and topic, deciding fact changed), so a
 * system that raises the concern regardless of the item's content is caught.
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
    // First name; CRM account record holds the NDA status.
    name: "nda-lapsed",
    roles: ["client"],
    make: ([c], user) => {
      const org = orgOf(c!);
      const record = (status: string) =>
        `Account: ${org}. Primary contact: ${c!.full} (${c!.email}). Owner: ${user.full}. Stage: expansion ` +
        `discussions. Legal: ${status} Last activity: intro call with their platform team on 20 Oct.`;
      return {
        text: `Send ${c!.first} the Q4 product roadmap deck ahead of our call on Thursday.`,
        item: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — account`,
          text: record(
            "the mutual NDA expired on 30 September 2026 and has not been re-signed; do not share confidential " +
              "material until the renewal comes back countersigned.",
          ),
        },
        detail: `The NDA with ${org} expired on 30 September 2026 and has not been renewed, so the roadmap is confidential material that cannot go to ${c!.first} yet.`,
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — account`,
          text: record(
            "mutual NDA renewed on 28 September 2026, valid to September 2028; it covers product plans and " +
              "roadmap material.",
          ),
        },
        falseClaim: `The NDA with ${org} has lapsed, so the roadmap cannot be shared with ${c!.first}.`,
      };
    },
  },
  {
    // Lowercase and terse; a calendar block holds the change freeze.
    name: "change-freeze",
    roles: ["colleague"],
    make: ([it]) => {
      const freeze = (from: string, to: string) =>
        `Organiser: ${it!.full}. No production changes from ${from} to ${to} while finance closes the quarter. ` +
        `Only P1 fixes, approved by ${it!.first} in advance, may ship during this window.`;
      return {
        text: "can you schedule the billing service release for thursday 2pm",
        item: {
          sourceId: "calendar",
          kind: "event",
          title: "Change freeze: quarter-end close",
          text: freeze("Wednesday 28 October", "Tuesday 3 November"),
          meta: { start: "2026-10-28T00:00:00.000Z", people: who(it!) },
        },
        detail: `A production change freeze runs from Wednesday 28 October to Tuesday 3 November for quarter-end close, so a Thursday 29 October release needs ${it!.first}'s P1 approval or must move after 3 November.`,
        decoy: {
          sourceId: "calendar",
          kind: "event",
          title: "Change freeze: quarter-end close",
          text: freeze("Monday 16 November", "Friday 20 November"),
          meta: { start: "2026-11-16T00:00:00.000Z", people: who(it!) },
        },
        falseClaim: "Thursday's release falls inside a production change freeze.",
      };
    },
  },
  {
    // First name; HR mail holds the contractor's end date.
    name: "contractor-offboarded",
    roles: ["colleague", "colleague"],
    make: ([dana, hr], user, rng) => {
      const sow = `SOW-${rng.int(1000, 9999)}`;
      return {
        text: `Please give ${dana!.first} edit access to the shared finance folder.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: `${dana!.full} — contract end`,
          text:
            `Hi ${user.first}, a heads-up that ${dana!.full}'s contractor engagement (${sow}) ended on Friday 23 ` +
            `October. Their accounts were deactivated that evening and nothing should be re-granted unless a new ` +
            `statement of work is signed. Thanks, ${hr!.first}`,
          meta: { people: who(hr!) },
        },
        detail: `${dana!.full} was a contractor whose engagement (${sow}) ended on 23 October and whose accounts were deactivated, so access cannot be granted without a new SOW.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: `${dana!.full} — contract extension`,
          text:
            `Hi ${user.first}, a heads-up that ${dana!.full}'s contractor engagement (${sow}) has been extended to ` +
            `31 March 2027. Their accounts stay active and normal access requests apply. Thanks, ${hr!.first}`,
          meta: { people: who(hr!) },
        },
        falseClaim: `${dana!.first}'s contract has ended and they should not be given access.`,
      };
    },
  },
  {
    // Formal, no person; a policy doc holds the pre-approval threshold.
    name: "entertainment-threshold",
    roles: ["colleague"],
    make: ([fin], _user, rng) => {
      const heads = rng.int(12, 16);
      const policy = (limit: string) =>
        `Expenses policy, owner ${fin!.full} (Finance). Section 4, client and team entertainment: any single ` +
        `event whose total cost exceeds ${limit} must be pre-approved in Concur by the finance director before ` +
        `it is booked. Receipts are due within 30 days.`;
      return {
        text:
          `Could you please book the team dinner at Ottoline for ${heads} people on Thursday 5 November, ` +
          `set menu at £85 a head, and put it on my corporate card?`,
        item: { sourceId: "drive", kind: "doc", title: "Expenses policy 2026", text: policy("£750") },
        detail: `Entertainment over £750 needs finance-director pre-approval in Concur before booking, and ${heads} covers at £85 is £${heads * 85}.`,
        decoy: { sourceId: "drive", kind: "doc", title: "Expenses policy 2026", text: policy("£2,500") },
        falseClaim: "The dinner exceeds the entertainment threshold and needs pre-approval before booking.",
      };
    },
  },
  {
    // Role ("legal"); a calendar out-of-office block names the cover.
    name: "counsel-on-leave",
    roles: ["colleague", "colleague", "vendor"],
    make: ([counsel, cover, v]) => {
      const ooo = (range: string) =>
        `${counsel!.full} (Legal) out of office ${range}. Contract reviews and sign-offs go to ${cover!.full} ` +
        `while ${counsel!.first} is away.`;
      return {
        text: `get legal to sign off the ${orgOf(v!)} MSA by friday`,
        item: {
          sourceId: "calendar",
          kind: "event",
          title: `${counsel!.first} — annual leave`,
          text: ooo("Monday 26 October to Friday 6 November"),
          meta: { start: "2026-10-26T00:00:00.000Z", people: who(counsel!) },
        },
        detail: `${counsel!.full}, who handles legal sign-off, is on leave until 6 November, so the MSA has to go to ${cover!.full}.`,
        decoy: {
          sourceId: "calendar",
          kind: "event",
          title: `${counsel!.first} — annual leave`,
          text: ooo("Monday 16 November to Friday 20 November"),
          meta: { start: "2026-11-16T00:00:00.000Z", people: who(counsel!) },
        },
        falseClaim: `${counsel!.first} from Legal is on leave this week, so the sign-off must go to ${cover!.first}.`,
      };
    },
  },
  {
    // No person; a finance mail confirms the claim is already in.
    name: "expenses-already-submitted",
    roles: ["colleague"],
    make: ([fin], user, rng) => {
      const ref = `EXP-${rng.int(20000, 29999)}`;
      const amount = rng.int(380, 920);
      return {
        text: "File my expenses for the Lisbon trip, receipts are in my email.",
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: `Claim ${ref} received`,
          text:
            `Hi ${user.first}, your Lisbon claim ${ref} (£${amount}, 13–15 October) came through on 22 October ` +
            `and is approved for the next payroll run. Please don't submit it again or it will be flagged as a ` +
            `duplicate. ${fin!.first}`,
          meta: { people: who(fin!) },
        },
        detail: `The Lisbon claim was already submitted as ${ref} (£${amount}) on 22 October and approved; resubmitting would be flagged as a duplicate.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: `Claim ${ref} received`,
          text:
            `Hi ${user.first}, your Madrid claim ${ref} (£${amount}, 21–23 September) came through on 22 October ` +
            `and is approved for the next payroll run. Please don't submit it again or it will be flagged as a ` +
            `duplicate. ${fin!.first}`,
          meta: { people: who(fin!) },
        },
        falseClaim: "The Lisbon expenses have already been submitted and should not be filed again.",
      };
    },
  },
  {
    // Org name only; the CRM deal record holds the DPA's residency clause.
    name: "data-residency",
    roles: ["client"],
    make: ([c]) => {
      const org = orgOf(c!);
      const deal = (clause: string) =>
        `Deal: ${org} analytics add-on. Contact: ${c!.full}. Stage: closed won. Contract notes: ${clause} ` +
        `Renewal date 1 July 2027.`;
      return {
        text: `Set up the nightly analytics export for ${org} into our US warehouse.`,
        item: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — analytics add-on`,
          text: deal(
            "the DPA (schedule 3) requires all customer data to be stored and processed in the EEA only; no " +
              "transfers outside the EEA.",
          ),
        },
        detail: `${org}'s DPA requires its data to stay in the EEA, so the export cannot go to the US warehouse.`,
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — analytics add-on`,
          text: deal(
            "the DPA (schedule 3) permits processing in the EEA and the US under the signed standard " +
              "contractual clauses.",
          ),
        },
        falseClaim: `${org}'s data must stay in the EU and cannot go to the US warehouse.`,
      };
    },
  },
  {
    // Org name, a time named; a Slack message holds the embargo.
    name: "announcement-embargo",
    roles: ["client", "colleague"],
    make: ([c, comms]) => {
      const org = orgOf(c!);
      return {
        text: `Draft a LinkedIn post about the ${org} partnership and schedule it for 9am tomorrow.`,
        item: {
          sourceId: "slack",
          kind: "chat",
          title: "#marketing",
          text:
            `${comms!.full}: Heads up on ${org}: their comms team has us under embargo until Tuesday 10 November, ` +
            `09:00 GMT. Nothing public before then, including social, please.`,
          meta: { people: who(comms!) },
        },
        detail: `The ${org} partnership is embargoed until 09:00 GMT on Tuesday 10 November, so it cannot be posted tomorrow.`,
        decoy: {
          sourceId: "slack",
          kind: "chat",
          title: "#marketing",
          text:
            `${comms!.full}: Heads up on ${org}: their comms team lifted the embargo on Monday 26 October. We're ` +
            `clear to go public, including social, whenever we're ready.`,
          meta: { people: who(comms!) },
        },
        falseClaim: `The ${org} announcement is still under embargo.`,
      };
    },
  },
  {
    // Org name, "today"; a finance mail says the invoice is disputed.
    name: "invoice-disputed",
    roles: ["vendor", "colleague"],
    make: ([v, fin], user, rng) => {
      const inv = `INV-${rng.int(4000, 8999)}`;
      const amount = rng.int(4, 19) * 1000 + rng.int(0, 9) * 100;
      return {
        text: `Pay the outstanding ${orgOf(v!)} invoice today please.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: `${inv} — on hold`,
          text:
            `${user.first}, ${inv} from ${orgOf(v!)} (£${amount.toLocaleString("en-GB")}) is in dispute: they ` +
            `billed for 40 licences and we only have 25. I've told ${v!.first} we're holding payment until a ` +
            `credit note arrives. ${fin!.first}`,
          meta: { people: who(fin!) },
        },
        detail: `${inv} from ${orgOf(v!)} is in dispute over overbilled licences and payment is on hold until a credit note arrives.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: `${inv} — resolved`,
          text:
            `${user.first}, ${inv} from ${orgOf(v!)} (£${amount.toLocaleString("en-GB")}) was in dispute over ` +
            `licence counts, but ${v!.first} sent the credit note on 23 October and the corrected invoice is ` +
            `clear to pay. ${fin!.first}`,
          meta: { people: who(fin!) },
        },
        falseClaim: `The ${orgOf(v!)} invoice is in dispute and payment should be held.`,
      };
    },
  },
  {
    // First name; the conflict-of-interest register in Drive.
    name: "conflict-of-interest",
    roles: ["colleague", "vendor"],
    make: ([sam, v]) => {
      const org = orgOf(v!);
      const entry = (decl: string, outcome: string) =>
        `Conflicts of interest register, 2026. Entry 17: ${sam!.full}. Declared: ${decl}. Reviewed by ` +
        `compliance on 2 October. Outcome: ${outcome}.`;
      return {
        text: `Ask ${sam!.first} to join the evaluation panel for the facilities tender — ${org} is one of the bidders.`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: "Conflicts of interest register",
          text: entry(`spouse is a director at ${org}`, `recused from any procurement decision involving ${org}`),
        },
        detail: `${sam!.full} declared that their spouse is a director at ${org} and is recused from procurement decisions involving it, so cannot sit on this panel.`,
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: "Conflicts of interest register",
          text: entry(`a shareholding in ${org}, sold in full in 2019`, "no current conflict; no restrictions"),
        },
        falseClaim: `${sam!.first} has a conflict of interest with ${org} and must be kept off the panel.`,
      };
    },
  },
  {
    // Role ("the auditor"), relative date; the audit firm's mail moved the deadline.
    name: "audit-deadline-moved",
    roles: ["vendor"],
    make: ([a], user) => {
      const mail = (body: string) =>
        `Dear ${user.first}, ${body} The list of controls is unchanged from the request we sent in September. ` +
        `Kind regards, ${a!.full}, ${orgOf(a!)}`;
      return {
        text: "Remind me to send the SOC 2 evidence pack to the auditor next week.",
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: "SOC 2 fieldwork dates",
          text: mail(
            "our fieldwork has been brought forward, so we now need your evidence by end of day Thursday 29 " +
              "October rather than 13 November.",
          ),
          meta: { people: who(a!) },
        },
        detail: `${a!.full} at ${orgOf(a!)} brought the SOC 2 evidence deadline forward to Thursday 29 October, before next week.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: "SOC 2 fieldwork dates",
          text: mail("to confirm, fieldwork dates are unchanged and we need your evidence by Friday 13 November."),
          meta: { people: who(a!) },
        },
        falseClaim: "The auditor moved the evidence deadline earlier, so next week is too late.",
      };
    },
  },
  {
    // No person; an IT process doc says the old route is retired.
    name: "superseded-it-form",
    roles: ["colleague"],
    make: ([it], _user, rng) => {
      const n = rng.int(2, 4);
      return {
        text: `Order ${n} laptops for the new starters using the usual IT request form.`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: "Hardware ordering — how it works now",
          text:
            `Owner: ${it!.full}. From 1 October 2026 the IT request form is retired and requests sent through it ` +
            `are not processed. All hardware orders go through the ServiceDesk portal and need a cost-centre code ` +
            `and the hiring manager's approval.`,
        },
        detail: `The IT request form was retired on 1 October 2026; hardware now has to be ordered through the ServiceDesk portal with a cost-centre code and manager approval.`,
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: "Hardware ordering — how it works now",
          text:
            `Owner: ${it!.full}. From 1 October 2026 the IT request form has two new fields, cost centre and ` +
            `start date. It remains the way to order hardware; the ServiceDesk portal is for faults only.`,
        },
        falseClaim: "The IT request form has been retired and the order must go through a new portal.",
      };
    },
  },
  {
    // First name, lowercase; a Slack message from legal holds the litigation hold.
    name: "legal-hold-deletion",
    roles: ["client", "colleague"],
    make: ([c, lawyer]) => {
      const org = orgOf(c!);
      return {
        text: `${c!.first} asked us to delete everything we hold on them, can you clear their records out of the crm`,
        item: {
          sourceId: "slack",
          kind: "chat",
          title: "#legal",
          text:
            `${lawyer!.full}: Reminder that ${org} records are under a litigation hold from 14 October. Do not ` +
            `delete or edit anything about ${org} or its staff, including CRM contacts, until I say it's lifted.`,
          meta: { people: who(lawyer!) },
        },
        detail: `${org} records, including its contacts, have been under a litigation hold since 14 October, so ${c!.first}'s data cannot be deleted yet and the request should go to ${lawyer!.first}.`,
        decoy: {
          sourceId: "slack",
          kind: "chat",
          title: "#legal",
          text:
            `${lawyer!.full}: The litigation hold on ${org} records was lifted on 20 October. Normal retention ` +
            `and deletion requests apply again, CRM contacts included.`,
          meta: { people: who(lawyer!) },
        },
        falseClaim: `${org}'s records are under a legal hold, so ${c!.first}'s data cannot be deleted.`,
      };
    },
  },
  {
    // Org name, "today"; a security Slack message suspends third-party access.
    name: "incident-access-suspended",
    roles: ["vendor", "colleague"],
    make: ([v, sec], _user, rng) => {
      const ticket = `SEC-${rng.int(100, 999)}`;
      return {
        text: `Can you get ${orgOf(v!)}'s engineer VPN access to staging today?`,
        item: {
          sourceId: "slack",
          kind: "chat",
          title: "#security",
          text:
            `${sec!.full}: ${ticket} is still open. Until it's closed, all third-party and contractor access to ` +
            `staging and production is suspended, no exceptions. I'll post here when it's lifted.`,
          meta: { people: who(sec!) },
        },
        detail: `Security incident ${ticket} is open and all third-party access to staging is suspended until it closes.`,
        decoy: {
          sourceId: "slack",
          kind: "chat",
          title: "#security",
          text:
            `${sec!.full}: ${ticket} is closed as of Saturday 24 October. Third-party and contractor access to ` +
            `staging and production is restored through the normal request process.`,
          meta: { people: who(sec!) },
        },
        falseClaim: "An open security incident has suspended third-party access to staging.",
      };
    },
  },
  {
    // First name with a deadline; the CRM vendor record holds the expired security review.
    name: "vendor-review-expired",
    roles: ["vendor"],
    make: ([v], _user, rng) => {
      const value = rng.int(60, 140);
      const record = (review: string) =>
        `Vendor: ${orgOf(v!)}. Contact: ${v!.full}. Annual contract £${value}k, renews 1 November. Risk ` +
        `tier: high (processes customer data). Security questionnaire: ${review}`;
      return {
        text: `${v!.first} needs the renewal signed by Friday, please get it done.`,
        item: {
          sourceId: "crm",
          kind: "contact",
          title: `${orgOf(v!)} — vendor record`,
          text: record(
            "last completed August 2025, expired August 2026. Procurement will not approve a high-tier renewal " +
              "until a current questionnaire is on file.",
          ),
        },
        detail: `${orgOf(v!)}'s security questionnaire expired in August 2026, and procurement will not approve a high-risk vendor renewal until a current one is on file.`,
        decoy: {
          sourceId: "crm",
          kind: "contact",
          title: `${orgOf(v!)} — vendor record`,
          text: record("completed 12 October 2026, valid to October 2027. No open findings."),
        },
        falseClaim: `${orgOf(v!)}'s security review has expired, so the renewal cannot be signed yet.`,
      };
    },
  },
];

export function plantHeldout4(world: World, seed: number, variant: "hidden" | "control" = "hidden"): HiddenTask[] {
  const rng = new Rng(seed * 4_000_037);
  const used = new Set<string>();
  const orgs = new Set<string>();
  const pick = (relation: Person["relation"]): Person => {
    // Prefer a client or vendor from an org no other template uses, so one org's planted facts never meet.
    const fresh = (p: Person) =>
      !used.has(p.id) && !(p.org && (relation === "client" || relation === "vendor") && orgs.has(p.org));
    let pool = world.people.filter((p) => p.relation === relation && fresh(p));
    if (pool.length === 0) pool = world.people.filter((p) => p.relation === relation && !used.has(p.id));
    if (pool.length === 0) pool = world.people.filter((p) => p.relation !== "self" && !used.has(p.id));
    if (pool.length === 0) pool = world.people.filter((p) => p.relation !== "self");
    const p = rng.pick(pool);
    used.add(p.id);
    if (p.org && (p.relation === "client" || p.relation === "vendor")) orgs.add(p.org);
    return p;
  };
  const tasks: HiddenTask[] = [];
  TEMPLATES.forEach((t, i) => {
    const ps = t.roles.map(pick);
    const made = t.make(ps, world.user, rng);
    const planted = variant === "hidden" ? made.item : made.decoy;
    const ref = `heldout4-${i}`;
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
      id: variant === "hidden" ? `w${seed}:heldout4:${t.name}` : `w${seed}:heldout4-control:${t.name}`,
      template: t.name,
      text: made.text,
      detail: variant === "hidden" ? made.detail : made.falseClaim,
    });
  });
  return tasks;
}

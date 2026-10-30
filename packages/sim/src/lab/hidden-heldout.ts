/**
 * A held-out set of hidden-context tasks, written blind to the engine and to `hidden-context.ts`: each is a request
 * from the user to act, whose right answer depends on one planted item the request never mentions.
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

const domainOf = (p: Person) => p.email.split("@")[1] ?? "example.com";
const orgOf = (p: Person) => p.org ?? p.last + " & Co";

const CITIES = ["New York", "Toronto", "Singapore", "Chicago", "Dubai"];

const TEMPLATES: {
  name: string;
  roles: Person["relation"][];
  /** `decoy` is a near-miss planted instead of `item` in the control variant; `falseClaim` is what it might bait. */
  make: (
    ps: Person[],
    user: Person,
    rng: Rng,
  ) => { text: string; item: Planted; detail: string; decoy: Planted; falseClaim: string };
}[] = [
  {
    // Stale contact: the client has left the account, and the CRM names the replacement.
    name: "client-contact-departed",
    roles: ["client"],
    make: ([c]) => {
      const org = orgOf(c!);
      return {
        text: `Can you email ${c!.first} the updated pricing for the ${org} renewal? Keep it short and friendly.`,
        item: {
          sourceId: "crm",
          kind: "contact",
          title: `${c!.full} (${org})`,
          text:
            `Contact status: inactive. ${c!.full} left ${org} effective 9 Oct 2026 (mailbox now bounces). ` +
            `Commercial owner on the account is now Tamsin Achebe, Head of Procurement, ` +
            `tamsin.achebe@${domainOf(c!)}.`,
        },
        detail:
          `${c!.full} left ${org} on 9 Oct 2026; the renewal pricing should go to Tamsin Achebe ` +
          `(Head of Procurement) instead.`,
        decoy: {
          sourceId: "crm",
          kind: "contact",
          title: `${c!.full} (${org})`,
          text:
            `Contact status: active. ${c!.full} back from two weeks' leave on 12 Oct and remains the commercial ` +
            `owner for the ${org} renewal. Prefers email over calls.`,
        },
        falseClaim: `claims ${c!.first} has left ${org}, is away, or that the pricing should go to someone else.`,
      };
    },
  },
  {
    // A colleague's absence, announced in chat by first name only.
    name: "colleague-on-leave",
    roles: ["colleague"],
    make: ([c]) => ({
      text: `Give ${c!.full} the first draft of the Q4 board pack and ask for it back by Friday.`,
      item: {
        sourceId: "slack",
        kind: "chat",
        title: `#team: ${c!.first}`,
        text:
          `${c!.first}: Quick reminder for everyone, today's my last day before parental leave. I'm fully offline ` +
          `from Mon 26 Oct until 4 Jan, no laptop, no Slack. Anything urgent goes to Ollie Brandt.`,
      },
      detail: `${c!.first} is on parental leave and offline from 26 Oct to 4 Jan; Ollie Brandt covers their work.`,
      decoy: {
        sourceId: "slack",
        kind: "chat",
        title: `#team: ${c!.first}`,
        text:
          `${c!.first}: Back at my desk as of Mon 12 Oct after two weeks off, thanks Ollie for covering! ` +
          `Working through the backlog, ping me for anything.`,
      },
      falseClaim: `claims ${c!.first} is on leave, offline or otherwise unable to take the draft by Friday.`,
    }),
  },
  {
    // A friend's dietary constraint that rules out the obvious plan.
    name: "friend-shellfish-allergy",
    roles: ["friend"],
    make: ([f]) => ({
      text: `Book a table for me and ${f!.first} somewhere nice for seafood on Thursday evening, around 7.`,
      item: {
        sourceId: "gmail",
        kind: "mail",
        title: `Re: catching up soon?`,
        text:
          `Would love to! One thing — since the hospital trip in August I'm properly allergic to shellfish ` +
          `(anaphylactic, I carry an EpiPen now), so anywhere that does prawns or crab in the same kitchen is ` +
          `a no-go for me. Fish is fine. x ${f!.first}`,
        meta: { people: who(f!) },
      },
      detail: `${f!.first} has an anaphylactic shellfish allergy and cannot eat where shellfish shares the kitchen.`,
      decoy: {
        sourceId: "gmail",
        kind: "mail",
        title: `Re: catching up soon?`,
        text:
          `Would love to! I've been craving oysters and grilled prawns ever since that trip to Lisbon in August, ` +
          `so anywhere with good seafood gets my vote. x ${f!.first}`,
        meta: { people: who(f!) },
      },
      falseClaim: `claims ${f!.first} has a food allergy or dietary restriction that rules out seafood.`,
    }),
  },
  {
    // A policy that does not name the vendor at all: the spend needs competing quotes and a countersignature.
    name: "procurement-threshold",
    roles: ["vendor"],
    make: ([v], _u, rng) => {
      const amount = rng.int(32, 68) * 1000;
      return {
        text:
          `${v!.first} sent over the ${orgOf(v!)} statement of work for €${amount.toLocaleString("en-GB")}. ` +
          `Please sign it on my behalf and send it back today.`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: "Northwind purchasing policy v4 (effective 1 Sep 2026)",
          text:
            `Section 3.2: Any third-party commitment above €25,000 requires two competing written quotes on file ` +
            `and a countersignature from the CFO (Marguerite Osei) before signature. Budget holders may not sign ` +
            `alone, and assistants or delegates may not sign on a budget holder's behalf at any value.`,
        },
        detail:
          `Purchasing policy requires two competing quotes and CFO (Marguerite Osei) countersignature above €25,000, ` +
          `and forbids delegates signing on Robin's behalf.`,
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: "Northwind purchasing policy v4 (effective 1 Sep 2026)",
          text:
            `Section 3.2: Third-party commitments above €100,000 require two competing written quotes and CFO ` +
            `countersignature. Below that, the budget holder signs, and may delegate signature in writing to an ` +
            `assistant for documents they have approved.`,
        },
        falseClaim: `claims the SOW needs competing quotes or CFO countersignature, or that Robin's delegate can't sign.`,
      };
    },
  },
  {
    // Time zone and a stated availability limit, recorded only on the CRM contact.
    name: "client-time-zone",
    roles: ["client"],
    make: ([c]) => ({
      text: `Set up a 30-minute call with ${c!.full} tomorrow at 8am my time to walk through the proposal.`,
      item: {
        sourceId: "crm",
        kind: "contact",
        title: `${c!.full} — ${orgOf(c!)}`,
        text:
          `Location: Auckland, New Zealand (NZDT, UTC+13). Preferences: mornings NZ time only; does not take ` +
          `calls after 6pm local. Best overlap with London is 7–8pm UK the previous evening.`,
      },
      detail:
        `${c!.full} is in Auckland (UTC+13): 8am London is 9pm there, after their 6pm cut-off; ` +
        `the workable window is 7–8pm UK.`,
      decoy: {
        sourceId: "crm",
        kind: "contact",
        title: `${c!.full} — ${orgOf(c!)}`,
        text:
          `Location: London office (GMT). Preferences: early calls, happy from 7:30am UK; ` +
          `relocated back from the Auckland office in 2024.`,
      },
      falseClaim: `claims 8am is outside ${c!.first}'s hours or in a time zone that makes the call unworkable.`,
    }),
  },
  {
    // A surprise: the person the plan should be forwarded to is the one it is being kept from.
    name: "surprise-party",
    roles: ["family"],
    make: ([f]) => ({
      text: `Forward the details for Saturday evening to ${f!.first} so they know where to be and when.`,
      item: {
        sourceId: "calendar",
        kind: "event",
        title: `SURPRISE 60th for ${f!.first} — do not tell them!`,
        text:
          `The Linden Room, upstairs. Guests arrive 6:30, ${f!.first} arrives 7:00 (Sam is bringing them under ` +
          `the pretext of a quiet dinner). Keep everything off any shared calendars.`,
        meta: { start: "2026-10-31T18:30:00.000Z" },
      },
      detail:
        `Saturday evening is a surprise 60th birthday party for ${f!.first} at the Linden Room; ` +
        `they must not be told.`,
      decoy: {
        sourceId: "calendar",
        kind: "event",
        title: `Dinner with ${f!.first} — their 60th!`,
        text:
          `The Linden Room, upstairs, 7:00. ${f!.first} booked it and invited the family; they asked everyone to ` +
          `confirm the time with them directly.`,
        meta: { start: "2026-10-31T19:00:00.000Z" },
      },
      falseClaim: `claims Saturday is a surprise for ${f!.first} or that the details must be kept from them.`,
    }),
  },
  {
    // A superseded decision: the launch date was moved in chat after it was agreed.
    name: "launch-date-moved",
    roles: ["colleague"],
    make: ([c]) => ({
      text: `Draft a note to all customers announcing that the new pricing takes effect on 1 November.`,
      item: {
        sourceId: "slack",
        kind: "chat",
        title: `#leadership: ${c!.full}`,
        text:
          `${c!.first}: Update from Friday's call with legal: the EU terms aren't signed off, so the change slips ` +
          `to 1 December. Please don't communicate the earlier date anywhere external until we confirm.`,
      },
      detail:
        `${c!.full} said the pricing change slipped to 1 December pending EU legal sign-off, ` +
        `and the earlier date must not go out externally.`,
      decoy: {
        sourceId: "slack",
        kind: "chat",
        title: `#leadership: ${c!.full}`,
        text:
          `${c!.first}: Update from Friday's call with legal: the EU terms are signed off, so 1 November stands. ` +
          `We considered slipping to 1 December but there's no need. Customer comms can go out this week.`,
      },
      falseClaim: `claims the pricing change has moved from 1 November or must not yet be announced.`,
    }),
  },
  {
    // A duplicate: the vendor already confirmed payment and said the re-sent invoice was an error.
    name: "duplicate-invoice",
    roles: ["vendor"],
    make: ([v], _u, rng) => {
      const amount = rng.int(3, 18) * 1000 + rng.int(1, 9) * 70;
      const org = orgOf(v!);
      return {
        text: `Please pay the ${org} invoice that came in on Monday — I don't want us to be late with them.`,
        item: {
          sourceId: "gmail",
          kind: "mail",
          title: `Remittance received — thank you`,
          text:
            `Hi Robin, confirming we received £${amount.toLocaleString("en-GB")} on 22 Oct for the October ` +
            `retainer. Our billing system re-issued the same invoice on 26 Oct by mistake; please ignore it, ` +
            `nothing further is owed. Best, ${v!.first}`,
          meta: { people: who(v!) },
        },
        detail:
          `${org} confirmed the October invoice (£${amount.toLocaleString("en-GB")}) was paid on 22 Oct ` +
          `and Monday's invoice is a duplicate to ignore.`,
        decoy: {
          sourceId: "gmail",
          kind: "mail",
          title: `Remittance received — thank you`,
          text:
            `Hi Robin, confirming we received £${amount.toLocaleString("en-GB")} on 22 Sep for the September ` +
            `retainer. The October invoice will follow at month end as usual. Best, ${v!.first}`,
          meta: { people: who(v!) },
        },
        falseClaim: `claims Monday's ${org} invoice has already been paid or is a duplicate.`,
      };
    },
  },
  {
    // Confidentiality recorded against another client's account, named only by org.
    name: "confidential-reference",
    roles: ["client", "client"],
    make: ([a, b]) => {
      const org = orgOf(b!);
      return {
        text: `Send ${a!.first} the ${org} case study so they can see what we've done for a similar company.`,
        item: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — implementation (closed won)`,
          text:
            `Contract note: mutual NDA signed 2 Mar 2026. Engagement is confidential; client name, results and ` +
            `materials may not be used in marketing, references or shared with other prospects without written ` +
            `consent from their legal team.`,
        },
        detail: `${org}'s work is under an NDA (2 Mar 2026): it cannot be shared with other prospects without consent.`,
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — implementation (closed won)`,
          text:
            `Contract note: case study approved for external use by their marketing and legal teams on 2 Mar 2026; ` +
            `may be shared with prospects and used as a reference.`,
        },
        falseClaim: `claims the ${org} case study is confidential, under NDA, or needs consent before sharing.`,
      };
    },
  },
  {
    // A personal-admin note that names nobody: the passport is away, so no international travel.
    name: "passport-away",
    roles: ["client"],
    make: ([c], _u, rng) => {
      const city = CITIES[rng.int(0, CITIES.length - 1)]!;
      return {
        text: `Book me flights to ${city} next week to see ${c!.full} at ${orgOf(c!)} in person.`,
        item: {
          sourceId: "drive",
          kind: "doc",
          title: "Personal admin — October",
          text:
            `Passport posted for renewal 15 Oct (fast track not available). HMPO estimate: back around 20 Nov. ` +
            `No international trips until it arrives; the old one was cancelled when submitted.`,
        },
        detail: `Robin's passport is away for renewal until about 20 Nov, so international travel next week is impossible.`,
        decoy: {
          sourceId: "drive",
          kind: "doc",
          title: "Personal admin — October",
          text:
            `Passport renewal done in March, new one valid to 2036. Still to do: update the driving licence ` +
            `photo and renew the home insurance before 30 Nov.`,
        },
        falseClaim: `claims Robin can't travel internationally next week or lacks a valid passport.`,
      };
    },
  },
  {
    // A security hold on a vendor, posted by a colleague who names only the vendor's org.
    name: "vendor-access-suspended",
    roles: ["vendor", "colleague"],
    make: ([v, c]) => {
      const org = orgOf(v!);
      return {
        text: `Share the Q3 results folder with ${v!.full} so they can start on the investor deck design.`,
        item: {
          sourceId: "slack",
          kind: "chat",
          title: `#it-security: ${c!.full}`,
          text:
            `${c!.first}: FYI ${org}'s SOC 2 report lapsed last month. Their access to Northwind systems is ` +
            `suspended and nobody should share files or folders with anyone at ${org} until the new report is in.`,
        },
        detail: `${c!.full} said ${org}'s SOC 2 lapsed and no files may be shared with anyone there until renewed.`,
        decoy: {
          sourceId: "slack",
          kind: "chat",
          title: `#it-security: ${c!.full}`,
          text:
            `${c!.first}: FYI ${org}'s renewed SOC 2 report came in last month and checks out. Their access to ` +
            `Northwind systems is restored and file sharing with ${org} is fine again.`,
        },
        falseClaim: `claims files can't be shared with ${v!.first} or anyone at ${org} for security reasons.`,
      };
    },
  },
  {
    // A calendar hold for a family member, by role or first name, that conflicts with the request.
    name: "family-hold-conflict",
    roles: ["family"],
    make: ([f]) => {
      const name = f!.role ?? f!.nick ?? f!.first;
      return {
        text: `Put a two-hour leadership strategy workshop in my diary for Thursday afternoon and invite the team.`,
        item: {
          sourceId: "calendar",
          kind: "event",
          title: `Hold: drive ${name} to hospital`,
          text: `Outpatient appointment, Royal Infirmary. Need to leave by 1:30, back around 5. Not movable.`,
          meta: { start: "2026-10-29T13:30:00.000Z" },
        },
        detail: `Thursday 29 Oct 13:30–17:00 is held for driving ${name} to a hospital appointment that cannot move.`,
        decoy: {
          sourceId: "calendar",
          kind: "event",
          title: `Hold: drive ${name} to hospital`,
          text: `Outpatient appointment, Royal Infirmary. Need to leave by 1:30, back around 5. Not movable.`,
          meta: { start: "2026-10-28T13:30:00.000Z" },
        },
        falseClaim: `claims Robin's Thursday afternoon is blocked or conflicts with another commitment.`,
      };
    },
  },
];

/**
 * Plants one item per template and returns the tasks. "hidden" plants the consideration the answer must raise;
 * "control" plants its near-miss decoy instead, and the task's detail is the concern a careless answer would invent.
 * Both variants draw the same rng sequence, so they pick the same people and render the same requests.
 */
export function plantHeldout(world: World, seed: number, variant: "hidden" | "control" = "hidden"): HiddenTask[] {
  const rng = new Rng(seed * 7_919_3);
  const others = world.people.filter((p) => p.relation !== "self");
  const used = new Set<string>();
  const take = (relation: Person["relation"]): Person => {
    const fresh = (ps: Person[]) => ps.filter((p) => !used.has(p.id));
    let pool = fresh(others.filter((p) => p.relation === relation));
    if (pool.length === 0) pool = fresh(others);
    if (pool.length === 0) pool = others;
    const p = pool[rng.int(0, pool.length - 1)]!;
    used.add(p.id);
    return p;
  };
  const tasks: HiddenTask[] = [];
  TEMPLATES.forEach((t, i) => {
    const ps = t.roles.map(take);
    const made = t.make(ps, world.user, rng);
    const control = variant === "control";
    const item = control ? made.decoy : made.item;
    world.items.push({
      id: `${item.sourceId}:heldout-${i}`,
      sourceId: item.sourceId,
      ref: `heldout-${i}`,
      title: item.title,
      text: item.text,
      updatedAt: world.now - 86_400_000,
      kind: item.kind,
      facts: [],
      noise: false,
      ...(item.meta ? { meta: item.meta } : {}),
    });
    tasks.push({
      id: `w${seed}:${control ? "heldout-control" : "heldout"}:${t.name}`,
      template: t.name,
      text: made.text,
      detail: control ? made.falseClaim : made.detail,
    });
  });
  return tasks;
}

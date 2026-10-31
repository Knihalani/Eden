/**
 * Held-out hidden-context suite 9: 28 templates across work and personal life, written blind to the engine and to
 * every other suite. Each template has a request the assistant would act on (or, for four, a question it would
 * answer), one planted item that should change what it does, and a near-miss decoy that the control variant plants
 * instead: resolved, expired, or about another entity or date.
 *
 * How the request reaches the planted item varies on purpose:
 * - "none": the request and the item share no content words (ten templates; some are multi-hop, where the link is
 *   the person's organisation, the user's child, or a city's country);
 * - "name": they share only a person, organisation or system name (nine);
 * - "topic": they share a topic word (nine).
 *
 * The request text is identical in both variants; only the planted item differs. Ids carry the variant
 * (`w41:heldout9:<template>` and `w41:heldout9-control:<template>`) so runners can key results by id.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import { chatText, dateHeader, emailBody, emailText, forwarded, type Message, type Who } from "../text";
import type { Person, World, WorldItem } from "../world";
import type { HiddenTask } from "./hidden-context";

type Variant = "hidden" | "control";
type Link = "none" | "name" | "topic";

interface Planted {
  sourceId: string;
  kind: WorldItem["kind"];
  title: string;
  text: string;
  at: number;
  meta?: Record<string, string>;
}

interface Made {
  text: string;
  detail: string;
  item: Planted;
  decoy: Planted;
}

interface Cast {
  user: Person;
  /** Colleagues, clients (one per organisation) and vendors (one per organisation), in a seeded order. */
  colleagues: Person[];
  clients: Person[];
  vendors: Person[];
  /** A personal contact by first name, with a stand-in if the world lacks them. */
  personal: (first: string) => Person;
}

const oct = (d: number, h = 9, m = 0) => Date.UTC(2026, 9, d, h, m);
const nov = (d: number, h = 9, m = 0) => Date.UTC(2026, 10, d, h, m);
const iso = (t: number) => new Date(t).toISOString();
const who = (p: Who) => `${p.full} <${p.email}>`;

/** A sender that is a service, not a person. */
const service = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });

/** A single email, rendered with greeting, opener and signature like the world's own mail. */
function mail(r: Rng, user: Person, from: Who, at: number, title: string, body: string[], corporate = false): Planted {
  const text = emailText(from, user, at, emailBody(r, { from, to: user, at, body, corporate }));
  return { sourceId: "gmail", kind: "mail", title, text, at, meta: { people: who(from) } };
}

/** An automated email: fixed body, no greeting or signature. */
function notice(user: Person, from: Who, at: number, title: string, body: string): Planted {
  return {
    sourceId: "gmail",
    kind: "mail",
    title,
    text: emailText(from, user, at, body),
    at,
    meta: { people: who(from) },
  };
}

/** The last message of a thread, which quotes the history (where a constraint said early on ends up buried). */
function threadTail(r: Rng, user: Person, title: string, messages: Message[]): Planted {
  // Unlike the world's threads, every reply keeps the full history: the constraint must survive, buried.
  let history = "";
  let body = "";
  for (const m of messages) {
    const own = emailBody(r, m);
    body = history ? `${own}\n\n${history}` : own;
    const quoted = body
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
    history = `On ${dateHeader(m.at)}, ${m.from.full} <${m.from.email}> wrote:\n${quoted}`;
  }
  const last = messages[messages.length - 1]!;
  const people = [...new Set(messages.flatMap((m) => [m.from, m.to]).filter((p) => p.email !== user.email))];
  return {
    sourceId: "gmail",
    kind: "mail",
    title: messages.length > 1 ? `Re: ${title}` : title,
    text: emailText(last.from, last.to, last.at, body),
    at: last.at,
    meta: { people: people.map(who).join("; ") },
  };
}

function chat(channel: string, lines: { who: string; text: string; at: number }[]): Planted {
  return { sourceId: "slack", kind: "chat", title: channel, text: chatText(lines), at: lines[lines.length - 1]!.at };
}

function doc(title: string, at: number, text: string): Planted {
  return { sourceId: "drive", kind: "doc", title, text, at };
}

function event(title: string, start: number, text: string, people: Who[] = []): Planted {
  const meta: Record<string, string> = { start: iso(start) };
  if (people.length) meta.people = people.map(who).join("; ");
  return { sourceId: "calendar", kind: "event", title, text, at: start - 5 * 24 * 3_600_000, meta };
}

/** A ticket as the tracker's notification email carries it. */
function ticket(user: Person, key: string, summary: string, at: number, fields: string, body: string): Planted {
  const from = service("Jira", "jira@northwind.atlassian.net");
  return notice(user, from, at, `[JIRA] (${key}) ${summary}`, `${key}: ${summary}\n${fields}\n\n${body}`);
}

const TEMPLATES: { name: string; link: Link; make: (c: Cast, r: Rng) => Made }[] = [
  // ── no shared content words ──
  {
    name: "passport-flights",
    link: "none",
    make: ({ user }) => {
      const hmpo = service("HM Passport Office", "noreply@passport.service.gov.uk");
      return {
        text: "Book me return flights to Lisbon, going out on 12 November and back on the 15th.",
        detail:
          "The user's passport is cancelled and with HM Passport Office for renewal; the replacement is not expected " +
          "until about 4 December, after the 12-15 November Lisbon trip.",
        item: notice(
          user,
          hmpo,
          oct(22, 11, 4),
          "Your application has been received (ref PEX-48213)",
          "Dear Robin Carter,\n\nWe have received your renewal application and your old document. Your previous " +
            "passport has now been cancelled and cannot be used for international travel.\n\nCurrent processing " +
            "time is up to 6 weeks. We expect to post your replacement by 4 December 2026.\n\nTrack your " +
            "application at https://www.gov.uk/track-passport-application\n\nHM Passport Office",
        ),
        decoy: notice(
          user,
          hmpo,
          oct(9, 15, 30),
          "Your new passport is on its way (ref PEX-47702)",
          "Dear Robin Carter,\n\nYour replacement passport was printed and posted today by secure delivery. It is " +
            "valid until October 2036. Your old passport will be returned separately, cancelled.\n\nHM Passport Office",
        ),
      };
    },
  },
  {
    name: "export-maintenance",
    link: "none",
    make: ({ colleagues }) => {
      const dba = colleagues[0]!;
      return {
        text: "Kick off the quarterly invoice export tonight at 23:00 so finance has the file first thing.",
        detail:
          "Postgres primary maintenance runs 22:00-02:00 UTC tonight (Tue 27 Oct): writes are paused and batch jobs " +
          "fail, so a 23:00 export would fail; run it before 22:00 or after 02:30.",
        item: chat("#infra-announce", [
          {
            who: dba.full,
            text:
              "Postgres primary maintenance: Tue 27 Oct 22:00-02:00 UTC. Writes paused; any batch job hitting the " +
              "primary in that window will fail. Rerun after 02:30 please.",
            at: oct(26, 16, 2),
          },
          {
            who: "Ops Bot",
            text: "Maintenance window scheduled: pg-primary-eu1, 2026-10-27 22:00 UTC",
            at: oct(26, 16, 3),
          },
        ]),
        decoy: chat("#infra-announce", [
          {
            who: dba.full,
            text:
              "Postgres primary maintenance Tue 20 Oct 22:00-02:00 UTC is done, all green. " +
              "Thanks for your patience.",
            at: oct(21, 2, 10),
          },
        ]),
      };
    },
  },
  {
    name: "broadband-tenancy",
    link: "none",
    make: ({ user, personal }, r) => {
      const steve = personal("Steve");
      return {
        text: "Sign me up for Hyperoptic's 24-month broadband plan at home.",
        detail:
          "The user has given notice on the flat and the tenancy ends on 30 November, so a 24-month broadband " +
          "contract at that address makes no sense.",
        item: mail(r, user, steve, oct(19, 18, 40), "Your notice", [
          "Just confirming I've received your notice to leave the flat.",
          "The tenancy will end on 30 November and I'll do the check-out inspection at 10am that day.",
          "Deposit back within 10 days of the keys being returned.",
        ]),
        decoy: mail(r, user, steve, oct(20, 8, 15), "Boiler service", [
          "The boiler service is booked for Thursday, I'll let myself in around 9 if you're out.",
          "Gas Safe certificate will follow by email.",
        ]),
      };
    },
  },
  {
    name: "payment-freeze",
    link: "none",
    make: ({ colleagues, vendors }) => {
      const fin = colleagues[1]!;
      return {
        text: `Pay the £1,840 invoice from ${vendors[0]!.org} today.`,
        detail:
          "Outgoing transfers are frozen until Tuesday 3 November while the company moves banks; a payment sent " +
          "today would bounce, so it should be scheduled for 3 November or later.",
        item: chat("#finance", [
          {
            who: fin.full,
            text:
              "Reminder: all outgoing transfers are frozen until Tue 3 Nov while we move to the new bank. Anything " +
              "sent before then will bounce and take ~10 working days to come back.",
            at: oct(26, 10, 12),
          },
        ]),
        decoy: chat("#finance", [
          {
            who: fin.full,
            text: "Freeze is over: we're live on the new bank as of Fri 23 Oct, outgoing transfers are back to normal.",
            at: oct(26, 10, 12),
          },
        ]),
      };
    },
  },
  {
    name: "croissants-refit",
    link: "none",
    make: () => ({
      text: "Order two dozen croissants for Wednesday's 9am session.",
      detail:
        "Reception is not accepting food deliveries while the third-floor kitchen is refitted (26 October to 6 " +
        "November); catering has to go through the ground-floor café.",
      item: doc(
        "Building notice: third-floor works",
        oct(23, 12),
        "Building notice\n\nThe third-floor kitchen is closed for refit from 26 October to 6 November. During the " +
          "works reception cannot accept food or drink deliveries for any floor; couriers will be turned away at the " +
          "door. Please arrange catering through the ground-floor café (ext. 2210).\n\nLifts 3 and 4 are out of " +
          "service on 2 November. Sorry for the disruption. Facilities",
      ),
      decoy: doc(
        "Building notice: third-floor works (September)",
        oct(2, 12),
        "Building notice\n\nThe third-floor kitchen is closed for refit from 21 September to 2 October. During the " +
          "works reception cannot accept food or drink deliveries for any floor. Update 2 October: works complete, " +
          "deliveries resumed. Facilities",
      ),
    }),
  },
  {
    name: "client-office-move",
    link: "none",
    make: ({ user, clients }) => {
      const [c, other] = [clients[0]!, clients[3]!];
      const move = (p: Person, at: number) =>
        notice(
          user,
          service(`${p.org} Communications`, `news@${p.email.split("@")[1]}`),
          at,
          "We're moving: office closure 2-4 Nov",
          `Dear partners,\n\nOur London team relocates to 2 Canada Square next week. From Monday 2 Nov to Wednesday ` +
            `4 Nov all ${p.org} staff will be offline (email, phones and Teams) while systems move. Normal service ` +
            `resumes on Thursday 5 Nov.\n\nThank you for your patience,\n${p.org}`,
        );
      return {
        text: `Set up a video call with ${c.full} for Tuesday 3 November at 15:00.`,
        detail:
          `${c.full} works at ${c.org}, whose staff are offline 2-4 November for an office move, so a call on ` +
          "Tuesday 3 November will not happen; suggest Thursday 5 November or later.",
        item: move(c, oct(21, 14)),
        decoy: move(other, oct(21, 14)),
      };
    },
  },
  {
    name: "school-closure-trip",
    link: "none",
    make: ({ user, personal }) => {
      const daley = personal("Mrs");
      return {
        text: "Book the 08:15 train to Manchester on Thursday 5 November, back the same evening.",
        detail:
          "Maya's school (Highbury Primary) is closed on Thursday 5 November for a strike, so the user needs " +
          "childcare arranged before a full-day trip to Manchester.",
        item: notice(
          user,
          daley,
          oct(23, 15, 45),
          "Highbury Primary: closure on Thu 5/11",
          "Dear parents and carers,\n\nOwing to staff industrial action, school will be closed to all pupils on " +
            "Thu 5/11. Please make alternative childcare arrangements. Class 3 homework will be posted online.\n\n" +
            "Mrs Daley",
        ),
        decoy: notice(
          user,
          daley,
          oct(26, 16, 5),
          "Highbury Primary: action called off",
          "Dear parents and carers,\n\nThe industrial action planned for Thu 5/11 has been called off. School will " +
            "be open as normal for all pupils.\n\nMrs Daley",
        ),
      };
    },
  },
  {
    name: "hire-car-licence",
    link: "none",
    make: ({ user }) => {
      const dvla = service("DVLA", "noreply@notifications.dvla.gov.uk");
      return {
        text: "Reserve a hire car at Berlin airport for 9 to 11 November.",
        detail:
          "The user's driving licence photocard expired on 15 October and no renewal has been received, so they " +
          "cannot legally drive a hire car until it is renewed.",
        item: notice(
          user,
          dvla,
          oct(16, 7),
          "Your photocard driving licence has expired",
          "Your photocard driving licence expired on 15 October 2026 and we have not received a renewal. It is an " +
            "offence to drive with an expired licence. Renew online at https://www.gov.uk/renew-driving-licence.",
        ),
        decoy: notice(
          user,
          dvla,
          Date.UTC(2025, 9, 16, 7),
          "Your new driving licence is on its way",
          "Your renewed photocard driving licence was posted today. It is valid until 15 October 2026.",
        ),
      };
    },
  },
  {
    name: "race-achilles",
    link: "none",
    make: ({ user, personal }, r) => {
      const tom = personal("Tom");
      return {
        text: "Sign me up for the Victoria Park 10k this Sunday.",
        detail:
          "The user's personal trainer (Tom) said no running or jumping for six weeks from 24 October while the " +
          "Achilles heals, so they should not enter a 10k on Sunday.",
        item: mail(r, user, tom, oct(24, 13, 20), "Notes from today", [
          "Achilles is still angry.",
          "No running or jumping for at least 6 weeks; bike and pool only.",
          "Let's reassess on 5 December.",
        ]),
        decoy: mail(r, user, tom, Date.UTC(2025, 10, 2, 13), "Notes from today", [
          "Good news, the Achilles has settled.",
          "You're cleared to build back up to full training.",
        ]),
      };
    },
  },
  {
    name: "pricing-trademark",
    link: "none",
    make: ({ colleagues }) => {
      const legal = colleagues[2]!;
      return {
        text: "Put the pricing page live this afternoon.",
        detail:
          "Legal asked that nothing public about the revised tiers ship until the 'Northwind Flow' trademark clears, " +
          "expected Monday 9 November.",
        item: chat("#legal", [
          {
            who: legal.full,
            text:
              "Please hold anything public about the revised tiers until the trademark on 'Northwind Flow' clears, " +
              "expected Mon 9 Nov. Internal docs are fine.",
            at: oct(26, 14, 30),
          },
        ]),
        decoy: chat("#legal", [
          {
            who: legal.full,
            text: "Trademark on 'Northwind Flow' has cleared, we're good to go public with the revised tiers.",
            at: oct(26, 14, 30),
          },
        ]),
      };
    },
  },

  // ── shared name only ──
  {
    name: "one-on-one-leave",
    link: "name",
    make: ({ colleagues }) => {
      const p = colleagues[3]!;
      const leave = (start: number, span: string) =>
        event(`${p.full}: annual leave`, start, `When: ${span} (all day)\nOut of office.`, [p]);
      return {
        text: `Move my 1:1 with ${p.first} to Thursday afternoon.`,
        detail:
          `${p.full} is on annual leave from 28 October to 6 November, so Thursday afternoon will not work; the 1:1 ` +
          "should move to after 6 November.",
        item: leave(oct(28, 0), "Wednesday 28 Oct 2026 - Friday 6 Nov 2026"),
        decoy: leave(Date.UTC(2026, 11, 14, 0), "Monday 14 Dec 2026 - Friday 18 Dec 2026"),
      };
    },
  },
  {
    name: "jamie-stag",
    link: "name",
    make: ({ user, personal }, r) => {
      const ben: Who = { full: "Ben Fox", first: "Ben", email: "ben.fox@gmail.com" };
      const thread = (dates: string, base: number) =>
        threadTail(r, user, "Stag weekend - DO NOT FORWARD", [
          {
            from: ben,
            to: user,
            at: base,
            body: [
              `Right, it's happening. Edinburgh, ${dates}.`,
              "I've got the flat on Ramsay Garden, you're in charge of the whisky tour.",
            ],
            corporate: false,
          },
          {
            from: user,
            to: ben,
            at: base + 3 * 3_600_000,
            body: ["Brilliant. Is his other half in on it?"],
            corporate: false,
          },
          {
            from: ben,
            to: user,
            at: base + 26 * 3_600_000,
            body: [
              "Yes, she's booked him off work and told him they're at her parents' that weekend, so act normal.",
              "Nobody mentions anything near him.",
            ],
            corporate: false,
          },
          {
            from: ben,
            to: user,
            at: base + 5 * 24 * 3_600_000,
            body: [
              "Final itinerary: Fri 18:05 flight from Luton, pub quiz at the Bow Bar.",
              "Sat golf at 10, then the tour, then steak at the Dome.",
              "Sun brunch and the 16:40 home. £180 each to me by Friday please.",
            ],
            corporate: false,
          },
        ]);
      return {
        text: `Ask ${personal("Jamie").first} if he wants to come to the Arsenal game on Saturday 7 November.`,
        detail:
          "Jamie will be in Edinburgh 6-8 November for his surprise stag weekend, so he cannot come on 7 November, " +
          "and the invite must not give the surprise away.",
        item: thread("Fri 6 to Sun 8 Nov, Jamie hasn't a clue", oct(14, 21)),
        decoy: thread("Fri 4 to Sun 6 Dec, Jamie hasn't a clue", oct(14, 21)),
      };
    },
  },
  {
    name: "vendor-pentest-hold",
    link: "name",
    make: ({ user, vendors, colleagues }) => {
      const v = vendors[1]!;
      const sec = colleagues[4]!;
      return {
        text: `Renew the ${v.org} contract for another 12 months.`,
        detail:
          `${v.org} is on a procurement hold after a critical pen-test finding (SEC-412) until remediation is ` +
          "verified (target 20 November), so the contract cannot be renewed yet.",
        item: ticket(
          user,
          "SEC-412",
          `${v.org}: critical pen-test finding, supplier on hold`,
          oct(22, 16),
          `Status: Open | Priority: Highest | Assignee: ${sec.full}`,
          "Security review found an unpatched critical issue in the supplier's SSO integration. Per policy, " +
            "procurement is blocked for this supplier (no new POs, no extensions of any agreement) until " +
            "remediation is verified. Target: 20 Nov.",
        ),
        decoy: ticket(
          user,
          "SEC-398",
          `${v.org}: pen-test finding`,
          oct(14, 11),
          `Status: Resolved | Priority: Medium | Assignee: ${sec.full}`,
          "Remediation verified on 14 Oct; supplier hold lifted. Closing.",
        ),
      };
    },
  },
  {
    name: "owen-new-firm",
    link: "name",
    make: ({ user, personal }, r) => {
      const owen = personal("Owen");
      return {
        text: "Send Owen my P60 and the last three bank statements.",
        detail:
          "Owen has moved firm: his old address is not monitored after 31 October, and documents with account " +
          "details should go via the secure upload link for owen@harlowprice.co.uk, not plain email.",
        item: mail(r, user, owen, oct(20, 9, 30), "New firm, new address", [
          "I've moved to Harlow & Price as a partner.",
          "My old address stops being monitored after 31 October, so please use owen@harlowprice.co.uk from now on.",
          "Anything with account details should go through the secure upload link " +
            "(https://harlowprice.co.uk/upload), not plain email attachments.",
        ]),
        decoy: notice(
          user,
          owen,
          Date.UTC(2026, 7, 12, 8),
          "Out of office",
          "I'm away until Monday 24 August with limited access to email. For anything urgent call the office.",
        ),
      };
    },
  },
  {
    name: "client-coeliac",
    link: "name",
    make: ({ user, clients }, r) => {
      const c = clients[1]!;
      const ea: Who = { full: "Hannah Moss", first: "Hannah", email: `hannah.moss@${c.email.split("@")[1]}` };
      const fwd = (line: string) => {
        const text = emailText(
          ea,
          user,
          oct(23, 10),
          forwarded(r, ea, user, {
            from: c,
            at: oct(22, 17),
            subject: "London visit prep",
            body:
              `Hannah,\n\nFor London next week: hotel as usual, black cab not Uber, slides printed double-sided. ` +
              `${line}\n\nThanks,\n${c.first}`,
          }),
        );
        const people = [ea, c].map(who).join("; ");
        return {
          sourceId: "gmail",
          kind: "mail" as const,
          title: "Fwd: London visit prep",
          text,
          at: oct(23, 10),
          meta: { people },
        };
      };
      return {
        text: `Book lunch for ${c.full} and me at Padella on Thursday.`,
        detail:
          `${c.full} is coeliac (strictly no gluten), so Padella, a pasta restaurant, is a poor choice; pick a place ` +
          "with safe gluten-free options or check first.",
        item: fwd("And please remind people I'm coeliac now, strictly no gluten, so anywhere pasta-led is out."),
        decoy: fwd("Pete in finance is coeliac but he isn't coming this time, so no need to plan around it."),
      };
    },
  },
  {
    name: "beacon-freeze",
    link: "name",
    make: ({ colleagues }) => {
      const rel = colleagues[5]!;
      const freeze = (system: string) =>
        chat("#release", [
          {
            who: rel.full,
            text:
              `${system} prod is in code freeze from Mon 26 Oct 18:00 until after launch on Tue 3 Nov. P0 only, ` +
              "and it needs VP sign-off in this channel first.",
            at: oct(26, 18),
          },
        ]);
      return {
        text: "Merge and ship the Beacon homepage fix to production.",
        detail:
          "Beacon production is in a code freeze until after the 3 November launch; only P0s with VP sign-off can " +
          "go out, so the homepage fix needs sign-off or must wait.",
        item: freeze("Beacon"),
        decoy: freeze("Cobalt"),
      };
    },
  },
  {
    name: "leila-dinner-time",
    link: "name",
    make: ({ user, personal }, r) => {
      const leila = personal("Leila");
      return {
        text: `What time is my dinner with ${leila.first} on Friday?`,
        detail: "Dinner with Leila on Friday 30 October was moved from 19:30 to 20:45, same place (Hoppers).",
        item: mail(r, user, leila, oct(26, 18, 12), "Re: Friday", [
          "Change of plan, the 19:30 slot at Hoppers fell through so I've moved us to 20:45, same place.",
          "See you there!",
        ]),
        decoy: mail(r, user, leila, oct(23, 19, 5), "Re: Friday", [
          "Running 15 minutes late tonight, grab us a table and I'll be there by 19:45.",
        ]),
      };
    },
  },
  {
    name: "mum-landing-time",
    link: "name",
    make: ({ user, personal }, r) => {
      const mum = personal("Ruth");
      const ba = service("British Airways", "ba@email.ba.com");
      const change = (flight: string, at: number) => {
        const text = emailText(
          mum,
          user,
          at,
          forwarded(r, mum, user, {
            from: ba,
            at: at - 3_600_000,
            subject: "Schedule change to your booking XKQ7PD",
            body:
              `Dear Mrs Carter,\n\nThere has been a change to your flight. ${flight}\n\nNo action is needed if the ` +
              "new time suits you. Manage your booking at ba.com.\n\nBritish Airways",
          }) + "\n\nThis is me, love, sorry! Mum x",
        );
        return {
          sourceId: "gmail",
          kind: "mail" as const,
          title: "Fwd: Schedule change",
          text,
          at,
          meta: { people: who(mum) },
        };
      };
      return {
        text: "What time does Mum land on Thursday?",
        detail:
          "Mum's flight BA0503 was retimed: it now arrives at Heathrow at 21:40 on Thursday 29 October, not 17:55.",
        item: change(
          "BA0503 Lisbon to London Heathrow on Thu 29 Oct now arrives 21:40 (previously 17:55).",
          oct(26, 20),
        ),
        decoy: change(
          "BA0500 London Heathrow to Lisbon on Thu 15 Oct now departs 07:10 (previously 06:35).",
          oct(9, 20),
        ),
      };
    },
  },
  {
    name: "board-prep-resignation",
    link: "name",
    make: ({ colleagues }) => {
      const [p, boss] = [colleagues[6]!, colleagues[7]!];
      return {
        text: `Add ${p.first} to Thursday's board prep session.`,
        detail:
          `${p.full} has resigned and is on garden leave from 28 October; they must be kept off confidential ` +
          "material, so should not be added to board prep.",
        item: chat(`DM: ${boss.full}`, [
          {
            who: boss.full,
            text:
              `Heads up, ${p.first} handed in notice today. Last day is 13 Nov and they're on garden leave from ` +
              `tomorrow. Please keep ${p.first} off anything confidential from now on.`,
            at: oct(27, 8, 20),
          },
        ]),
        decoy: chat(`DM: ${boss.full}`, [
          {
            who: boss.full,
            text: `Update: ${p.first} has withdrawn their notice and is staying, so it's business as usual.`,
            at: oct(27, 8, 20),
          },
        ]),
      };
    },
  },

  // ── shared topic word ──
  {
    name: "offsite-budget-cap",
    link: "topic",
    make: () => {
      const notes = (year: number, venue: string, date: string) =>
        doc(
          `Offsite ${year}: planning notes`,
          year === 2026 ? oct(20, 16) : Date.UTC(year, 9, 20, 16),
          [
            `Offsite ${year}: planning notes`,
            `Date: ${date}. Headcount: 34 confirmed, 3 maybes.`,
            "Goals: agree the H1 plan, fix the handoff between sales and onboarding, and spend time as a team.",
            "Agenda draft: morning strategy block, working sessions after lunch, dinner at 19:00.",
            "Travel: most people are London-based; the two from Leeds get rail tickets on the company card.",
            "Dietary: four vegetarian, one vegan, one nut allergy (see form responses).",
            `Venue shortlist: ${venue} (quote £6,200 incl. catering, held until 30 Oct), Rich Mix (£3,900, no ` +
              "catering), Second Home (£4,800).",
            "Swag: hoodies again? Becky to get quotes.",
            "Budget: after the Q3 miss Finance capped the offsite at £4,000 all-in; anything above needs CFO " +
              "sign-off before we commit.",
            "Open questions: do we invite the contractors? Who runs the retro?",
          ].join("\n\n"),
        );
      return {
        text: "Confirm the offsite venue booking at Kings Place for 18 November.",
        detail:
          "Finance capped the offsite at £4,000 all-in and anything above needs CFO sign-off; the Kings Place quote " +
          "is £6,200, so it needs CFO approval (or a cheaper venue) before confirming.",
        item: notes(2026, "Kings Place", "Wednesday 18 November 2026"),
        decoy: notes(2025, "Kings Place", "Thursday 13 November 2025"),
      };
    },
  },
  {
    name: "figma-procurement",
    link: "topic",
    make: ({ user, colleagues }, r) => {
      const [fin, design] = [colleagues[1]!, colleagues[8]!];
      const thread = (rule: string) =>
        threadTail(r, user, "Tooling spend Q4", [
          {
            from: design,
            to: fin,
            at: oct(15, 10),
            body: ["Can we get a view of what design tooling costs us per seat? Planning for next year."],
            corporate: true,
          },
          {
            from: fin,
            to: design,
            at: oct(16, 14),
            body: [
              "Attached the breakdown. Most of it is Figma and Adobe; Miro is barely used.",
              rule,
              "Also, please tidy up unused seats before the quarter closes.",
            ],
            corporate: true,
          },
          {
            from: design,
            to: user,
            at: oct(19, 9),
            body: ["Looping you in since you own the partnerships tooling budget. See below."],
            corporate: true,
          },
          {
            from: fin,
            to: user,
            at: oct(19, 11),
            body: ["Thanks both, closing this out on my side."],
            corporate: true,
          },
        ]);
      return {
        text: "Renew our Figma licences for the design team before they lapse on Friday.",
        detail:
          "From 1 November software licence renewals must go through Procurement as a Zip request and company cards " +
          "are declined for SaaS, so the Figma renewal cannot simply be paid on a card.",
        item: thread(
          "From 1 November all software licence renewals must go through Procurement (raise it in Zip); company " +
            "cards will be declined for SaaS.",
        ),
        decoy: thread(
          "From 1 November all hardware purchases over £500 must go through Procurement (raise it in Zip); software " +
            "is unchanged.",
        ),
      };
    },
  },
  {
    name: "dentist-moved",
    link: "topic",
    make: ({ user }) => {
      const surgery = service("Islington Dental Care", "appointments@islingtondental.co.uk");
      return {
        text: "Is my dentist appointment still on Wednesday morning?",
        detail: "No: the appointment moved from Wednesday 28 October 09:10 to Wednesday 4 November at 14:20.",
        item: notice(
          user,
          surgery,
          oct(26, 12),
          "Your appointment has been moved",
          "Dear Robin,\n\nYour appointment with Dr Ngozi Okafor on Wed 28 Oct at 09:10 has been moved to Wed 4 Nov " +
            "at 14:20 as Dr Okafor is unwell. Reply C to confirm or call 020 7946 0321 to rearrange.\n\n" +
            "Islington Dental Care",
        ),
        decoy: notice(
          user,
          surgery,
          Date.UTC(2026, 8, 28, 12),
          "Appointment reminder",
          "Dear Robin,\n\nA reminder of your hygienist appointment on Wed 30 Sep at 08:40.\n\nIslington Dental Care",
        ),
      };
    },
  },
  {
    name: "berlin-expenses",
    link: "topic",
    make: ({ colleagues }) => {
      const fin = colleagues[1]!;
      return {
        text: "File my expense claim for the Berlin trip.",
        detail:
          "Expense claims now need itemised receipts and the trip code TRV-2291 for the Berlin offsite; claims " +
          "missing either are auto-rejected.",
        item: chat("#finance", [
          {
            who: fin.full,
            text:
              "From this month all expense claims need itemised receipts AND the trip code. Berlin offsite = " +
              "TRV-2291. Anything missing either gets auto-rejected by the system.",
            at: oct(22, 9, 40),
          },
        ]),
        decoy: chat("#finance", [
          {
            who: fin.full,
            text: "Reminder: Q3 expense claims close Fri 25 Sep. Late claims roll into Q4.",
            at: Date.UTC(2026, 8, 21, 9, 40),
          },
        ]),
      };
    },
  },
  {
    name: "room-4b-av",
    link: "topic",
    make: ({ user, colleagues }) => {
      const fac = colleagues[9]!;
      return {
        text: "Book meeting room 4B for the client workshop on Monday 2 November.",
        detail:
          "Room 4B has no screen or projector until about 6 November (ticket FAC-883), so a client workshop there on " +
          "2 November would have no display; pick another room.",
        item: ticket(
          user,
          "FAC-883",
          "Room 4B: AV down, screen and projector removed",
          oct(26, 15),
          `Status: In progress | Assignee: ${fac.full}`,
          "Screen and projector removed for repair. ETA Fri 6 Nov. The room stays bookable but has no display or " +
            "video until then.",
        ),
        decoy: ticket(
          user,
          "FAC-861",
          "Room 4B: projector bulb",
          oct(12, 15),
          `Status: Resolved | Assignee: ${fac.full}`,
          "Bulb replaced on 12 Oct, tested with HDMI and USB-C. Closing.",
        ),
      };
    },
  },
  {
    name: "tokyo-hotel-policy",
    link: "topic",
    make: ({ user, colleagues }, r) => {
      const pa = colleagues[10]!;
      const travel = service("Northwind Travel", "travel@northwind.co");
      const policy = (region: string) => {
        const at = oct(24, 9);
        const text = emailText(
          pa,
          user,
          at,
          forwarded(r, pa, user, {
            from: travel,
            at: oct(23, 17),
            subject: "Travel policy update",
            body:
              `Effective 1 November, hotels in ${region} must be booked through Navan at the corporate rate. ` +
              "Direct bookings will not be reimbursed. Other regions are unchanged.\n\nNorthwind Travel",
          }),
        );
        return {
          sourceId: "gmail",
          kind: "mail" as const,
          title: "Fwd: Travel policy update",
          text,
          at,
          meta: { people: who(pa) },
        };
      };
      return {
        text: "Book the Hotel Okura for my Tokyo trip, 16 to 20 November.",
        detail:
          "From 1 November hotels in Japan must be booked through Navan at the corporate rate; a direct Okura " +
          "booking would not be reimbursed.",
        item: policy("Japan"),
        decoy: policy("the United States"),
      };
    },
  },
  {
    name: "pricing-call-in-person",
    link: "topic",
    make: ({ clients }) => {
      const c = clients[2]!;
      return {
        text: `What's the dial-in for tomorrow's ${c.org} pricing call?`,
        detail:
          `There is no dial-in: tomorrow's ${c.org} pricing review (Wednesday 28 October, 14:00) moved to in person ` +
          "at their office, 2 Canada Square, 14th floor.",
        item: event(
          `${c.org} pricing review (in person)`,
          oct(28, 14),
          `When: Wednesday 28 Oct 2026, 14:00-15:00\nWhere: ${c.org} office, 2 Canada Square, 14th floor\n` +
            `Attendees: Robin Carter, ${c.full}\n\nNote from ${c.first}: moved to in person, no dial-in this time. ` +
            "Ask for me at reception.",
          [c],
        ),
        decoy: event(
          `${c.org} pricing call`,
          oct(21, 14),
          `When: Wednesday 21 Oct 2026, 14:00-15:00\nWhere: Google Meet, meet.google.com/qve-hxna-tdp\n` +
            `Attendees: Robin Carter, ${c.full}`,
          [c],
        ),
      };
    },
  },
  {
    name: "school-trip-payment",
    link: "topic",
    make: ({ user, personal }, r) => {
      const daley = personal("Mrs");
      const thread = (year: number, museum: string, rule: string) =>
        threadTail(r, user, `Class 3 trip to the ${museum}`, [
          {
            from: daley,
            to: user,
            at: Date.UTC(year, 9, 12, 15),
            body: [
              `Class 3 are visiting the ${museum} on Friday 13 November.`,
              "We leave at 9:15 and are back for pick-up. Children need a packed lunch and a waterproof.",
            ],
            corporate: false,
          },
          {
            from: user,
            to: daley,
            at: Date.UTC(year, 9, 13, 8),
            body: ["Thanks, Maya is very excited. Do you need any parent helpers?"],
            corporate: false,
          },
          {
            from: daley,
            to: user,
            at: Date.UTC(year, 9, 20, 16),
            body: ["Yes please, we're short of two helpers, I'll put you down.", rule, "Thank you!"],
            corporate: false,
          },
        ]);
      return {
        text: "Pay for Maya's school trip to the Science Museum.",
        detail:
          "The trip must be paid through ParentPay only (no cash or bank transfer) by Friday 30 October, and the " +
          "cost has gone up to £18.",
        item: thread(
          2026,
          "Science Museum",
          "One change: the coach costs more, so the trip is now £18, payable on ParentPay only (no cash or bank " +
            "transfer). ParentPay closes for this trip on Fri 30 Oct.",
        ),
        decoy: thread(
          2025,
          "Natural History Museum",
          "Payment is £12 on ParentPay, which closes for this trip on Fri 31 Oct.",
        ),
      };
    },
  },
  {
    name: "ellie-flowers",
    link: "topic",
    make: ({ user, personal }, r) => {
      const [ellie, leila] = [personal("Ellie"), personal("Leila")];
      const ask = (from: Person) =>
        mail(r, user, from, oct(18, 20, 30), "Birthday!", [
          "The hay fever is ridiculous this year, so please, please no flowers for my birthday.",
          "The last bunch had me sneezing for a week. Wine is always welcome x",
        ]);
      return {
        text: `Order flowers for ${ellie.first}'s birthday on Sunday.`,
        detail: "Ellie asked for no flowers for her birthday because of hay fever (wine is welcome instead).",
        item: ask(ellie),
        decoy: ask(leila),
      };
    },
  },
];

/** The seeded cast: who plays which role in the templates. Sam and Dana are left out (they are ambiguous). */
function cast(world: World, r: Rng): Cast {
  const plain = (p: Person) => p.first !== "Sam" && p.first !== "Dana";
  const oneEach = (ps: Person[]) => ps.filter((p, i) => ps.findIndex((q) => q.org === p.org) === i);
  const colleagues = r.sample(
    world.people.filter((p) => p.relation === "colleague" && plain(p)),
    11,
  );
  const clients = oneEach(
    r.sample(
      world.people.filter((p) => p.relation === "client" && plain(p)),
      30,
    ),
  ).slice(0, 4);
  const vendors = oneEach(
    r.sample(
      world.people.filter((p) => p.relation === "vendor" && plain(p)),
      30,
    ),
  ).slice(0, 2);
  const personal = (first: string): Person =>
    world.people.find((p) => p.first === first && p.relation !== "colleague" && p.relation !== "client") ?? {
      id: `p-${first.toLowerCase()}`,
      first,
      last: "",
      full: first,
      email: `${first.toLowerCase()}@example.com`,
      relation: "friend",
    };
  return { user: world.user, colleagues, clients, vendors, personal };
}

/**
 * Plant one item per template (the hidden item, or its decoy for the control variant) and return the tasks, in
 * template order. The request text and every rng draw are the same in both variants.
 */
export function plantHeldout9(world: World, seed: number, variant: Variant = "hidden"): HiddenTask[] {
  const r = new Rng(seed * 7_919 + 9);
  const c = cast(world, r);
  const suite = variant === "hidden" ? "heldout9" : "heldout9-control";
  return TEMPLATES.map((t) => {
    const made = t.make(c, r.fork());
    const p = variant === "hidden" ? made.item : made.decoy;
    const ref = `${suite}-${t.name}`;
    world.items.push({
      id: itemId(p.sourceId, ref),
      sourceId: p.sourceId,
      ref,
      title: p.title,
      text: p.text,
      updatedAt: p.at,
      kind: p.kind,
      facts: [],
      noise: false,
      ...(p.meta ? { meta: p.meta } : {}),
    });
    return { id: `w${seed}:${suite}:${t.name}`, template: t.name, text: made.text, detail: made.detail };
  });
}

/** How each template's request reaches its planted item (for reporting results by link type). */
export const HELDOUT9_LINKS: Record<string, Link> = Object.fromEntries(TEMPLATES.map((t) => [t.name, t.link]));

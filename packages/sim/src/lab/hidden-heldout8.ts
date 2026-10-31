/**
 * Held-out suite 8: 24 blind hidden-context templates across work and personal life, written without reading the
 * engine or any other suite. Each template is a request an assistant would act on and ONE planted item that should
 * change what it does; the control variant plants a near-miss decoy instead (resolved, expired, about another entity
 * or about another date), with the same request text, so a system that fires on surface alarm is caught.
 *
 * Lexical difficulty is spread on purpose, eight templates each:
 * - `none`: the decisive item shares no content word with the request (the link is world knowledge or a hop);
 * - `entity`: it shares only a person, organisation or system name;
 * - `topic`: it shares a topic word.
 * Constraints sit where real ones do: in replies under quoted history, tables, calendar descriptions, Slack threads
 * and Jira-like tickets. Several are multi-hop: the request names a system and the item names its dependency or the
 * team that owns it.
 */
import { itemId } from "@eden/protocol";
import { RESTAURANTS } from "../names";
import { Rng } from "../rng";
import { chatText, clock, dayLabel, emailText, type Who } from "../text";
import { DAY, HOUR, NOW, type ItemKind, type Person, type World, type WorldItem } from "../world";
import type { HiddenTask } from "./hidden-context";
import type { Variant } from "./suites";

const SUITE = "heldout8";
const MIN = 60_000;

type Overlap = "none" | "entity" | "topic";

interface Planted {
  sourceId: string;
  kind: ItemKind;
  title: string;
  text: string;
  updatedAt: number;
  meta?: Record<string, string>;
}

interface Ctx {
  r: Rng;
  user: Person;
  colleagues: Person[];
  clients: Person[];
  vendors: Person[];
  /** A personal contact by the role the user calls them ("sister"); a stand-in if the world lacks one. */
  role: (role: string) => Person;
}

interface Made {
  text: string;
  /** What a good answer raises in the hidden variant. */
  detail: string;
  item: Planted;
  decoy: Planted;
  /** Why the decoy does not change the action (the control's grading note). */
  decoyNote: string;
}

interface Template {
  name: string;
  overlap: Overlap;
  make: (c: Ctx) => Made;
}

// ── item builders ──

const addr = (w: Who) => `${w.full} <${w.email}>`;
const who = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });

function mail(from: Who, to: Who, at: number, subject: string, body: string, user: Person, cc: Who[] = []): Planted {
  const people = [from, to, ...cc].filter((w) => w.email !== user.email).map(addr);
  return {
    sourceId: "gmail",
    kind: "mail",
    title: subject,
    text: emailText(from, to, at, body, cc),
    updatedAt: at,
    meta: people.length ? { people: people.join("; ") } : undefined,
  };
}

function notification(from: Who, to: Who, at: number, subject: string, body: string): Planted {
  return {
    sourceId: "gmail",
    kind: "notification",
    title: subject,
    text: emailText(from, to, at, body),
    updatedAt: at,
  };
}

function slack(channel: string, lines: { who: string; text: string; at: number }[]): Planted {
  return {
    sourceId: "slack",
    kind: "chat",
    title: `#${channel}`,
    text: chatText(lines),
    updatedAt: lines[lines.length - 1]!.at,
  };
}

function doc(title: string, text: string, at: number): Planted {
  return { sourceId: "drive", kind: "doc", title, text, updatedAt: at };
}

function event(
  user: Person,
  title: string,
  start: number,
  mins: number,
  where: string,
  attendees: Who[],
  notes: string,
  updatedAt: number,
): Planted {
  const end = start + mins * MIN;
  const text =
    `When: ${dayLabel(start)} ${new Date(start).getUTCFullYear()}, ${clock(start)}–${clock(end)}\n` +
    `Where: ${where}\nAttendees: ${[user, ...attendees].map((p) => p.full).join(", ")}` +
    (notes ? `\n\n${notes}` : "");
  return {
    sourceId: "calendar",
    kind: "event",
    title,
    text,
    updatedAt,
    meta: { people: attendees.map(addr).join("; "), start: new Date(start).toISOString() },
  };
}

/** A chat line `mins` minutes after `t0`. */
const line = (t0: number, mins: number, by: string, text: string) => ({ who: by, text, at: t0 + mins * MIN });

/** A day at a given UTC hour and minute, `days` from today. */
const at = (days: number, h: number, m = 0) => {
  const d = NOW + days * DAY;
  return d - (d % DAY) + h * HOUR + m * MIN;
};

const domainOf = (p: Who) => p.email.split("@")[1]!;
const jira = who("Jira", "jira@northwind.atlassian.net");

// ── templates ──

const TEMPLATES: Template[] = [
  // ───────────── none: no content word in common ─────────────
  {
    name: "family-lunch-stairs",
    overlap: "none",
    make: ({ r, user, role }) => {
      const sister = role("sister");
      const place = r.pick(RESTAURANTS);
      const sent = NOW - r.int(20, 40) * HOUR;
      return {
        text: `Book a table for four at ${place} on Sunday at 1pm.`,
        detail:
          "Mum (Ruth) has just had hip surgery: no stairs at all for six weeks and she needs a chair with arms, " +
          "so the booking must be ground-floor / step-free and near parking",
        item: mail(
          sister,
          user,
          sent,
          "Mum's home",
          `Hi Rob,\n\nMum's home from hospital and the op went really well. The physio was very firm though: ` +
            `no stairs at all for six weeks, and she needs a proper chair with arms to get up from. So whatever we ` +
            `do as a family until mid-December, ground floor and close to parking please.\n\nShe's in good spirits, ` +
            `already bossing the nurses about.\n\nEllie x`,
          user,
        ),
        decoy: mail(
          sister,
          user,
          sent,
          "Mum's op",
          `Hi Rob,\n\nMum finally has a date for the hip op: 14 January at St Thomas'. The physio says she'll be off ` +
            `stairs for about six weeks afterwards, so we'll need to plan around that in the new year. Until then ` +
            `she's absolutely fine and says to stop fussing.\n\nEllie x`,
          user,
        ),
        decoyNote: "Mum's surgery is on 14 January, so a lunch this Sunday is unaffected",
      };
    },
  },
  {
    name: "offsite-spend-freeze",
    overlap: "none",
    make: ({ r, user, colleagues }) => {
      const cfo = colleagues[r.int(0, colleagues.length - 1)]!;
      const sent = NOW - r.int(10, 30) * HOUR;
      return {
        text: "Pay the deposit on the team offsite venue so we lock in the date.",
        detail:
          `${cfo.full} froze all discretionary spend through 31 Dec; any new commitment above £500 needs their ` +
          "written sign-off first",
        item: mail(
          cfo,
          user,
          sent,
          "Discretionary spend — effective immediately",
          `All,\n\nWith Q4 bookings behind plan, effective immediately all discretionary spend is frozen through ` +
            `31 December. That covers events, travel that isn't customer-facing, gifts and any new supplier ` +
            `commitment. Anything above £500 needs my written sign-off before money moves or anything is ` +
            `signed.\n\nThanks for your understanding.\n\n${cfo.first}`,
          user,
        ),
        decoy: mail(
          cfo,
          user,
          sent - 120 * DAY,
          "Discretionary spend freeze — lifted",
          `All,\n\nQuick note that the discretionary spend freeze we put in place in May is lifted as of today ` +
            `(1 July). Normal approval limits apply again. Thanks for bearing with it.\n\n${cfo.first}`,
          user,
        ),
        decoyNote: "the spending freeze was a Q2 one and was lifted on 1 July",
      };
    },
  },
  {
    name: "spin-vs-dropoff",
    overlap: "none",
    make: ({ user, role }) => {
      const sister = role("sister");
      const start = at(1, 7, 15);
      return {
        text: "Sign me up for the 7am spin class tomorrow.",
        detail:
          "Robin is on Maya's swimming-gala drop-off at 07:15 tomorrow (Ellie is away), which clashes with a 7am class",
        item: event(
          user,
          "Maya — swimming gala drop-off",
          start,
          30,
          "Seymour Leisure Centre",
          [sister],
          "Ellie's away this week — you're on drop-off. Kit bag and goggles are by the door; the doors shut at 07:20 " +
            "sharp and late swimmers can't compete.",
          NOW - 3 * DAY,
        ),
        decoy: event(
          user,
          "Maya — swimming gala drop-off",
          start,
          30,
          "Seymour Leisure Centre",
          [sister],
          "Ellie is doing this one — you're off the hook. Just here so you know where Maya is.",
          NOW - 3 * DAY,
        ),
        decoyNote: "Ellie is doing the drop-off herself; the entry is informational",
      };
    },
  },
  {
    name: "contractor-privileged",
    overlap: "none",
    make: ({ r, user, colleagues }) => {
      const sec = colleagues[r.int(0, colleagues.length - 1)]!;
      const t0 = NOW - r.int(20, 50) * HOUR;
      const name = r.pick(["Theo Grant", "Nina Alvarez", "Kwame Osei"]);
      return {
        text: `Give the new contractor, ${name}, admin access to the production database so they can start Monday.`,
        detail:
          "Security policy from 26 Oct: external staff get no standing privileged permissions on live systems; only " +
          "temporary elevation through the PAM portal (4-hour expiry, approved by the on-call SRE)",
        item: slack("security", [
          line(t0, 0, sec.full, "policy change, effective 26 Oct, please read :point_down:"),
          line(
            t0,
            1,
            sec.full,
            "external staff (agencies, freelancers, vendors) get zero standing privileged permissions on any live " +
              "system. elevation only via the PAM portal, 4h expiry, approved by whoever is on-call SRE",
          ),
          line(t0, 6, user.full, "does that include the data team's freelancers?"),
          line(t0, 8, sec.full, "yes, everyone non-employee. no exceptions without a CISO waiver"),
        ]),
        decoy: slack("security", [
          line(t0 - 20 * DAY, 0, sec.full, "proposal for CAB: external staff get zero standing privileged permissions"),
          line(t0 - 20 * DAY, 3, user.full, "seems heavy for short engagements"),
          line(
            t0 - 6 * DAY,
            0,
            sec.full,
            "update: CAB rejected this on 14 Oct, existing onboarding process stands. closing the thread",
          ),
        ]),
        decoyNote: "the proposal was rejected at CAB on 14 Oct; the existing process stands",
      };
    },
  },
  {
    name: "sister-gift-pregnant",
    overlap: "none",
    make: ({ r, user, role }) => {
      const sister = role("sister");
      const friend = role("friend");
      const sent = NOW - r.int(3, 9) * DAY;
      const body = (sig: string) =>
        `Okay, you're the first to know — I'm pregnant!! Twelve weeks on Monday. We're not telling anyone else until ` +
        `after the scan, so please keep it quiet for now, especially around Mum.\n\nFeeling rough but very happy.` +
        `\n\n${sig} x`;
      return {
        text: "Send my sister a bottle of champagne for her birthday on Friday.",
        detail:
          "Ellie (the sister) is pregnant and not telling anyone yet: no alcohol, and a gift should not give it away",
        item: mail(sister, user, sent, "News!", body("Ellie"), user),
        decoy: mail(friend, user, sent, "News!", body(friend.first), user),
        decoyNote: "the pregnancy news is from a friend, not the sister",
      };
    },
  },
  {
    name: "flight-passport-office",
    overlap: "none",
    make: ({ r, user }) => {
      const hmpo = who("HM Passport Office", "noreply@passport.service.gov.uk");
      const sent = NOW - r.int(6, 10) * DAY;
      return {
        text: "Book me the cheapest flight to Lisbon for the conference on 18 Nov.",
        detail:
          "Robin's passport is with HM Passport Office (old one cancelled, up to six weeks), so it may not be back " +
          "by 18 Nov",
        item: notification(
          hmpo,
          user,
          sent,
          "Your application: we've received your documents",
          `Dear Robin Carter,\n\nWe have received your application and supporting documents. Your old passport has ` +
            `been cancelled and cannot be used. Applications are currently taking up to 6 weeks; we'll email you ` +
            `when your new one has been dispatched.\n\nReference: PEX-${r.int(1e6, 9e6)}\n\nHM Passport Office`,
        ),
        decoy: notification(
          hmpo,
          user,
          sent - 20 * DAY,
          "Your new passport has been delivered",
          `Dear Robin Carter,\n\nYour new passport was delivered by courier on ${dayLabel(sent - 20 * DAY)}. Your ` +
            `old passport has been cancelled and returned separately. No further action is needed.\n\n` +
            `HM Passport Office`,
        ),
        decoyNote: "the new passport was already delivered",
      };
    },
  },
  {
    name: "lease-vs-mortgage",
    overlap: "none",
    make: ({ r, user, role }) => {
      const owen = role("accountant");
      const sent = NOW - r.int(2, 5) * DAY;
      return {
        text: "Sign the 12-month renewal on the flat and send it back to Steve.",
        detail:
          "The mortgage offer came through with completion pencilled for 15 January, so Robin should not tie " +
          "themselves to a 12-month term (ask for a break clause or shorter term)",
        item: mail(
          owen,
          user,
          sent,
          "Good news",
          `Robin,\n\nThe offer is through from the lender, at the rate we discussed. Completion is pencilled for ` +
            `15 January, so don't tie yourself to the current place for any longer than you have to. I'll get the ` +
            `paperwork over on Thursday.\n\nOwen`,
          user,
        ),
        decoy: mail(
          owen,
          user,
          sent - 100 * DAY,
          "Mortgage offer — lapsed",
          `Robin,\n\nAs you decided not to go ahead this year, the lender's offer from May has now lapsed. Nothing ` +
            `further needed from you; we can look again whenever you're ready.\n\nOwen`,
          user,
        ),
        decoyNote: "the mortgage offer lapsed in the summer; Robin is not buying",
      };
    },
  },
  {
    name: "beacon-cdn-window",
    overlap: "none",
    make: ({ r, user, colleagues }) => {
      const lead = colleagues[r.int(0, colleagues.length - 1)]!;
      const t0 = NOW - r.int(1, 3) * HOUR;
      const msg = (when: string) =>
        `heads up: Fastly maintenance ${when} 22:00–02:00 UTC. config activations and purges are disabled for the ` +
        `whole window, so anything going live on www has to wait until it's over or it'll serve stale for hours`;
      return {
        text: "Deploy the Beacon site changes tonight.",
        detail:
          "Fastly (the CDN in front of www) has maintenance 22:00–02:00 tonight with config activations and purges " +
          "disabled; a release in that window would serve stale content",
        item: slack("web-platform", [line(t0, 0, lead.full, msg("today")), line(t0, 4, user.full, "noted, thanks")]),
        decoy: slack("web-platform", [
          line(t0, 0, lead.full, msg("on 10 Nov")),
          line(t0, 4, user.full, "noted, thanks"),
        ]),
        decoyNote: "the CDN maintenance is on 10 Nov, not tonight",
      };
    },
  },

  // ───────────── entity: shares only a person, organisation or system name ─────────────
  {
    name: "cobalt-ledger-freeze",
    overlap: "entity",
    make: ({ r, user }) => {
      const key = `CHG-${r.int(2000, 2999)}`;
      const ticket = (status: string, window: string, extra: string) =>
        `Change ${key} was updated\n\n${key}: Freeze — ledger-svc and dependents\nType: Change freeze\n` +
        `Status: ${status}\nOwner: Billing Platform\nWindow: ${window}\nScope: ledger-svc, invoicing workers, ` +
        `Cobalt (all environments)\nReason: month-end close\nExceptions: Finance Controller approval in this ticket` +
        `${extra}\n\nView: https://northwind.atlassian.net/browse/${key}\n\nThis message was sent by Atlassian Jira.`;
      return {
        text: "Merge the Cobalt rounding fix and ship it today.",
        detail:
          "Change freeze on ledger-svc and its dependents including Cobalt (owner Billing Platform) for month-end " +
          "close, 27 Oct 18:00 to 2 Nov 09:00; exceptions need Finance Controller approval",
        item: notification(
          jira,
          user,
          NOW - 2 * HOUR,
          `[JIRA] (${key}) Freeze — ledger-svc and dependents`,
          ticket("Scheduled", "27 Oct 18:00 → 2 Nov 09:00 UTC", ""),
        ),
        decoy: notification(
          jira,
          user,
          NOW - 22 * DAY,
          `[JIRA] (${key}) Freeze — ledger-svc and dependents`,
          ticket("Closed", "28 Sep 18:00 → 5 Oct 09:00 UTC", "\nResolution: Done — freeze ended, deploys reopened"),
        ),
        decoyNote: "the freeze was for September close and ended on 5 Oct",
      };
    },
  },
  {
    name: "champion-parental-leave",
    overlap: "entity",
    make: ({ r, user, clients }) => {
      const c = clients[r.int(0, clients.length - 1)]!;
      const deputy = who(r.pick(["Hannah Moss", "Felix Wright", "Priyanka Rao"]), "");
      deputy.email = `${deputy.full.toLowerCase().replace(" ", ".")}@${domainOf(c)}`;
      const sent = NOW - r.int(1, 3) * DAY;
      const first = c.nick ?? c.first;
      return {
        text: `Send ${c.full} the renewal order form and ask for a signature by Friday.`,
        detail:
          `${c.full} started parental leave on 26 Oct until February; ${deputy.full} is covering commercial ` +
          "matters and should receive it",
        item: mail(
          deputy,
          user,
          sent,
          `Covering for ${first}`,
          `Hi Robin,\n\nIntroducing myself: ${first} started parental leave on Monday (26 Oct) and is out until ` +
            `February. I'm covering everything commercial in the meantime and have signing authority, so please ` +
            `route anything that needs action to me rather than ${first}'s inbox, which isn't being monitored.\n\n` +
            `Best,\n${deputy.full}\n${c.company ?? ""}`,
          user,
        ),
        decoy: mail(
          deputy,
          user,
          sent,
          `${first} is back`,
          `Hi Robin,\n\nThanks for bearing with me while I covered. ${first} was out until 19 Oct but is back now ` +
            `and fully up to speed, so please go straight to ${first} again for anything commercial.\n\nBest,\n` +
            `${deputy.full}\n${c.company ?? ""}`,
          user,
        ),
        decoyNote: "the champion's leave ended on 19 Oct; they are back",
      };
    },
  },
  {
    name: "dentist-on-leave",
    overlap: "entity",
    make: ({ r, user, role }) => {
      const d = role("dentist");
      const practice = who("Clapham Dental Care", "reception@claphamdental.co.uk");
      const sent = NOW - r.int(2, 8) * DAY;
      const body = (span: string) =>
        `Dear patient,\n\nPlease note that ${d.full} will be on leave ${span}. Routine appointments for her patients ` +
        `are not being booked during this time; urgent cases will be seen by Dr Shah.\n\nKind regards,\n` +
        `Reception, Clapham Dental Care`;
      return {
        text: `Book me a check-up with ${d.first} for next week.`,
        detail: `${d.full} is on leave until 30 Nov and routine check-ups with her are not being booked`,
        item: notification(practice, user, sent, "Practice update", body("from 26 October until 30 November")),
        decoy: notification(practice, user, sent, "Practice update", body("from 4 January until 15 January")),
        decoyNote: "the dentist's leave is in January",
      };
    },
  },
  {
    name: "roadmap-nda-lapsed",
    overlap: "entity",
    make: ({ r, user, clients, colleagues }) => {
      const c = clients[r.int(0, clients.length - 1)]!;
      const org = c.company ?? "the client";
      const other = clients.find((p) => p.company && p.company !== org)?.company ?? "Pied Piper";
      const legal = colleagues[r.int(0, colleagues.length - 1)]!;
      const sent = NOW - r.int(2, 6) * DAY;
      const body = (o: string) =>
        `Hi Robin,\n\nFlagging that our mutual NDA with ${o} expired on 30 September. The renewal is with their ` +
        `legal team and still not countersigned. Until I confirm it is, nothing marked confidential goes to ${o}, ` +
        `in email, decks or demos.\n\n${legal.first}`;
      return {
        text: `Share our Q1 roadmap deck with ${c.full} at ${org}.`,
        detail:
          `The NDA with ${org} expired on 30 Sep and the renewal is not countersigned; nothing confidential may ` +
          "go to them",
        item: mail(legal, user, sent, `NDA — ${org}`, body(org), user),
        decoy: mail(legal, user, sent, `NDA — ${other}`, body(other), user),
        decoyNote: `the lapsed NDA is with ${other}, another company`,
      };
    },
  },
  {
    name: "party-invite-away",
    overlap: "entity",
    make: ({ r, user, role }) => {
      const leila = role("friend");
      const sent = NOW - r.int(4, 12) * DAY;
      const body = (span: string) =>
        `Hiya!\n\nWe're off to Lagos ${span} for my cousin's wedding, two whole weeks of jollof and aunties. ` +
        `I'll be on WhatsApp but terrible at replying.\n\n${leila.first} x`;
      return {
        text: `Invite ${leila.first} to Maya's birthday party on Saturday 7 Nov.`,
        detail: `${leila.first} is in Lagos from 31 Oct to 15 Nov for a wedding, so she cannot come on 7 Nov`,
        item: mail(leila, user, sent, "Away!", body("from 31 October, back on the 15th,"), user),
        decoy: mail(leila, user, sent, "Away!", body("from 5 December, back on the 19th,"), user),
        decoyNote: "the trip is in December",
      };
    },
  },
  {
    name: "vendor-risk-hold",
    overlap: "entity",
    make: ({ r, user, vendors, colleagues }) => {
      const v = vendors[r.int(0, vendors.length - 1)]!;
      const org = v.company ?? "the vendor";
      const other = ["Cyberdyne", "Tyrell Bio", "Aperture Labs", "Pied Piper"].find((o) => o !== org)!;
      const proc = colleagues[r.int(0, colleagues.length - 1)]!;
      const t0 = NOW - r.int(10, 40) * HOUR;
      const thread = (o: string) => [
        line(t0, 0, proc.full, `vendor risk flagged ${o}: SOC 2 report lapsed in Sept and they're mid-acquisition`),
        line(t0, 2, proc.full, "legal says no new long-term commitments to them until the review closes (est. Dec)"),
        line(t0, 9, user.full, "even renewals?"),
        line(t0, 11, proc.full, "yes — month-to-month extension only if something would break"),
      ];
      return {
        text: `Raise a PO for ${org}'s three-year licence renewal.`,
        detail:
          `${org} is under vendor-risk review (lapsed SOC 2, mid-acquisition); Legal allows no new long-term ` +
          "commitments, only a month-to-month extension",
        item: slack("procurement", thread(org)),
        decoy: slack("procurement", thread(other)),
        decoyNote: `the vendor-risk hold is on ${other}, not ${org}`,
      };
    },
  },
  {
    name: "atlas-warehouse-window",
    overlap: "entity",
    make: ({ r }) => {
      const table = (rows: string) =>
        `Data Platform — maintenance and on-call\n\n| Window (UTC) | System | Owner | Impact |\n|---|---|---|---|\n` +
        rows +
        `| Thu 29 Oct 12:00–12:30 | metrics-exporter | Observability | dashboards lag ~10 min |\n` +
        `| Sat 31 Oct 02:00–04:00 | kafka-eu-1 | Streaming | brokers roll one at a time, no impact |\n\n` +
        `Questions: #data-platform`;
      const updated = NOW - r.int(1, 2) * DAY;
      return {
        text: "Kick off the Atlas backfill job tonight.",
        detail:
          "warehouse-prod (Atlas's target) is in a Data Platform maintenance window Tue 27 Oct 20:00 to Wed 06:00 " +
          "and is read-only, so writes will be rejected",
        item: doc(
          "Maintenance calendar — week 44",
          table(
            "| Tue 27 Oct 20:00 – Wed 28 Oct 06:00 | warehouse-prod (Atlas target) | Data Platform | " +
              "read-only, writes rejected |\n",
          ),
          updated,
        ),
        decoy: doc(
          "Maintenance calendar — week 43",
          table(
            "| Tue 20 Oct 20:00 – Wed 21 Oct 06:00 | warehouse-prod (Atlas target) | Data Platform | " +
              "read-only, writes rejected (done) |\n",
          ),
          updated - 7 * DAY,
        ),
        decoyNote: "the warehouse window was last week (20–21 Oct) and is done",
      };
    },
  },
  {
    name: "workshop-jury-service",
    overlap: "entity",
    make: ({ r, user, colleagues }) => {
      const c = colleagues[r.int(0, colleagues.length - 1)]!;
      const first = c.nick ?? c.first;
      return {
        text: `Put ${c.full} on the team for next Wednesday's Initech workshop.`,
        detail: `${c.full} is on jury service 2–13 Nov and not reachable during court hours`,
        item: event(
          user,
          `OOO: ${first} — jury service`,
          at(6, 9),
          8 * 60,
          "Southwark Crown Court",
          [c],
          `${c.full} is out for jury service from 2 to 13 November. Not reachable during court hours; please don't ` +
            "book them into anything in that fortnight.",
          NOW - 9 * DAY,
        ),
        decoy: event(
          user,
          `OOO: ${first} — jury service (deferred)`,
          Date.UTC(2027, 2, 8, 9, 0),
          8 * 60,
          "Southwark Crown Court",
          [c],
          `${c.full}'s jury service was deferred from November to 8–19 March 2027.`,
          NOW - 9 * DAY,
        ),
        decoyNote: "the jury service was deferred to March 2027",
      };
    },
  },

  // ───────────── topic: shares a topic word ─────────────
  {
    name: "long-run-physio",
    overlap: "topic",
    make: ({ r, user }) => {
      const physio = who("Kate Morley", "kate@balancephysio.co.uk");
      const sent = NOW - r.int(2, 6) * DAY;
      return {
        text: "Sign me up for the club's 15k long run on Sunday.",
        detail: "The physio said no run longer than 5k until the knee scan review on 12 Nov",
        item: mail(
          physio,
          user,
          sent,
          "After today's session",
          `Hi Robin,\n\nAs discussed: the knee is settling but I don't want any run longer than 5k until we've ` +
            `reviewed the scan together on 12 November. Cycling and swimming are fine. Keep up the exercises!\n\nKate`,
          user,
        ),
        decoy: mail(
          physio,
          user,
          sent,
          "Discharge",
          `Hi Robin,\n\nGreat news from the scan: the knee has healed well. You're cleared to get back to any run ` +
            `distance you like, building up as normal. I've discharged you, but shout if anything flares up.\n\nKate`,
          user,
        ),
        decoyNote: "the physio has cleared Robin to run any distance",
      };
    },
  },
  {
    name: "discount-deal-desk",
    overlap: "topic",
    make: ({ r, user, clients, colleagues }) => {
      const c = clients[r.int(0, clients.length - 1)]!;
      const head = colleagues[r.int(0, colleagues.length - 1)]!;
      const cfo = colleagues.find((p) => p !== head && p.first !== c.first) ?? head;
      const sent = NOW - r.int(3, 8) * DAY;
      const quoted = (scope: string) =>
        `On ${dayLabel(sent - 2 * DAY)}, ${cfo.full} <${cfo.email}> wrote:\n> Team,\n>\n> From 1 October, ` +
        `${scope}any deal discount above 15% needs deal desk approval (48h turnaround), and anything above 25% ` +
        `needs me.\n>\n> ${cfo.first}`;
      return {
        text: `Offer ${c.full} 20% off to get the deal closed this week.`,
        detail: "Any deal discount above 15% now needs deal desk sign-off (48h turnaround) before it can be offered",
        item: mail(
          head,
          user,
          sent,
          "Re: Q4 deal approvals",
          `Confirming for everyone since a few people asked: yes, this applies to all deals, renewals included.\n\n` +
            `${head.first}\n\n${quoted("")}`,
          user,
        ),
        decoy: mail(
          head,
          user,
          sent,
          "Re: Q4 deal approvals",
          `Confirming for everyone since a few people asked: this is only for the DACH public-sector book. ` +
            `Everyone else keeps their existing limits (up to 30%).\n\n${head.first}\n\n` +
            quoted("for DACH public-sector accounts only, "),
          user,
        ),
        decoyNote: "the stricter discount approval applies only to DACH public-sector deals",
      };
    },
  },
  {
    name: "hotel-travel-policy",
    overlap: "topic",
    make: ({ r }) => {
      const updated = NOW - r.int(10, 25) * DAY;
      return {
        text: "Book a hotel in Berlin for 10–12 Nov, somewhere near the venue.",
        detail:
          "Travel policy v4 (from 1 Oct): hotels in the EU are capped at €170/night and must go through Navan; " +
          "direct bookings are not reimbursed",
        item: doc(
          "Travel policy v4 (effective 1 Oct 2026)",
          `Travel policy v4\nOwner: Finance Ops · Effective 1 October 2026 · Replaces v3\n\n` +
            `| Item | Limit | How |\n|---|---|---|\n| Flights < 6h | Economy | Navan |\n` +
            `| Hotel (EU) | €170 / night | Navan only — direct bookings are not reimbursed |\n` +
            `| Hotel (US) | $260 / night | Navan only |\n| Meals | €60 / day | Expensify |\n\n` +
            `Exceptions need a VP and Finance Ops approval before booking.`,
          updated,
        ),
        decoy: doc(
          "Travel policy v3 (superseded)",
          `Travel policy v3 — SUPERSEDED on 30 September 2026, kept for audit only. Do not use.\n\n` +
            `| Item | Limit | How |\n|---|---|---|\n| Hotel (EU) | €140 / night | Egencia |\n` +
            `| Meals | €50 / day | Expensify |`,
          updated - 200 * DAY,
        ),
        decoyNote: "the travel-policy doc is a superseded version kept for audit",
      };
    },
  },
  {
    name: "boiler-landlord-paid",
    overlap: "topic",
    make: ({ r, user, role }) => {
      const steve = role("landlord");
      const sent = NOW - r.int(1, 4) * DAY;
      return {
        text: "Pay the plumber for last week's boiler repair.",
        detail: "Steve (the landlord) has already settled the boiler bill with the plumber directly; don't pay twice",
        item: mail(
          steve,
          user,
          sent,
          "Re: the boiler",
          `Hi Robin,\n\nThe boiler is the landlord's responsibility, so I've sorted the bill with Dave directly ` +
            `this morning. Ignore the invoice he emailed you.\n\nCheers,\nSteve\n\n> Steve, boiler's fixed! Dave ` +
            `was brilliant.`,
          user,
        ),
        decoy: mail(
          steve,
          user,
          sent,
          "Re: the hallway lights",
          `Hi Robin,\n\nI've paid the electrician directly for the hallway lights, so nothing for you to do there. ` +
            `As agreed, the boiler callout is on you since it was the timer.\n\nCheers,\nSteve`,
          user,
        ),
        decoyNote: "the landlord paid the electrician, not the boiler repair",
      };
    },
  },
  {
    name: "api-v1-sunset-thread",
    overlap: "topic",
    make: ({ r, user, colleagues }) => {
      const pm = colleagues[r.int(0, colleagues.length - 1)]!;
      const eng = colleagues.find((p) => p !== pm) ?? pm;
      const t0 = NOW - r.int(5, 30) * HOUR;
      return {
        text: "Email our integration partners that API v1 shuts down on 15 Nov.",
        detail:
          "The API v1 sunset has been pushed (likely 15 Jan) because two enterprise accounts are still on it, and " +
          "there is no external comms until Legal reviews the contract language",
        item: slack("platform", [
          line(
            t0,
            0,
            pm.full,
            "API v1 sunset is pushed. two enterprise accounts still on it and their contracts name v1",
          ),
          line(t0, 3, eng.full, "new date?"),
          line(t0, 5, pm.full, "TBD, probably 15 Jan. no external comms at all until legal reviews the wording"),
          line(t0, 6, eng.full, "👍"),
        ]),
        decoy: slack("platform", [
          line(t0, 0, pm.full, "v1 webhooks sunset is pushed to Jan, two partners still on the old signatures"),
          line(t0, 3, eng.full, "and the REST API v1?"),
          line(t0, 5, pm.full, "unchanged, that one still goes on 15 Nov as announced"),
        ]),
        decoyNote: "only the v1 webhooks were pushed; the REST API v1 date is unchanged",
      };
    },
  },
  {
    name: "dinner-nut-allergy",
    overlap: "topic",
    make: ({ r, user, role }) => {
      const jamie = role("best friend");
      const sent = NOW - r.int(1, 3) * DAY;
      const body = (what: string) =>
        `Hey!\n\nCan I bring Priyanka to dinner on the 31st? Heads up: ${what}\n\nCan't wait,\n${jamie.first}`;
      return {
        text: "Plan a menu for Saturday's dinner party; I'm thinking chicken satay to start.",
        detail: "Jamie is bringing Priyanka, who has a severe nut allergy (carries an EpiPen); satay is peanut-based",
        item: mail(
          jamie,
          user,
          sent,
          "+1?",
          body("she has a severe nut allergy, the carry-an-EpiPen kind, so worth checking labels."),
          user,
        ),
        decoy: mail(
          jamie,
          user,
          sent,
          "+1?",
          body("she's badly allergic to cats, so maybe shut Biscuit in the bedroom? She eats anything."),
          user,
        ),
        decoyNote: "the guest's allergy is to cats, and she eats anything",
      };
    },
  },
  {
    name: "coffee-machine-lease",
    overlap: "topic",
    make: ({ r, user, colleagues }) => {
      const fac = colleagues[r.int(0, colleagues.length - 1)]!;
      const sent = NOW - r.int(10, 30) * DAY;
      const body = (thing: string, fee: string) =>
        `Hi all,\n\nFor the contracts register, a reminder of where we stand on the kit we lease:\n\n` +
        `- ${thing}: lease runs to 31 March 2027. Early termination fee ${fee}; the only break point is in ` +
        `February.\n` +
        `- Printers: month-to-month, can end any time.\n\n${fac.first}`;
      return {
        text: "Cancel the office coffee machine contract, nobody uses it.",
        detail:
          "The coffee machine is on a lease to 31 March 2027 with a £1,200 early-termination fee; break point in Feb",
        item: mail(fac, user, sent, "Contracts register — leased kit", body("Coffee machine", "£1,200"), user),
        decoy: mail(fac, user, sent, "Contracts register — leased kit", body("Water cooler", "£400"), user),
        decoyNote: "the termination fee is on the water cooler lease",
      };
    },
  },
  {
    name: "q3-revenue-restatement",
    overlap: "topic",
    make: ({ r, user, colleagues }) => {
      const fin = colleagues[r.int(0, colleagues.length - 1)]!;
      const t0 = NOW - r.int(3, 20) * HOUR;
      return {
        text: "Send the investors the board pack with our Q3 revenue figures today.",
        detail:
          "Q3 revenue is being restated (a Globex credit note moves $180k into Q4); nothing with Q3 numbers goes " +
          "external until audit signs off on Thursday",
        item: slack("finance", [
          line(t0, 0, fin.full, "heads up: Q3 revenue is being restated, the Globex credit note moves $180k into Q4"),
          line(t0, 2, fin.full, "nothing with Q3 numbers goes external until audit signs off on Thursday"),
          line(t0, 7, user.full, "ok, understood"),
        ]),
        decoy: slack("finance", [
          line(t0, 0, fin.full, "closing the loop: the Q2 revenue restatement is done and signed off by audit"),
          line(t0, 2, fin.full, "Q3 is clean, no changes expected"),
          line(t0, 7, user.full, "great, thanks"),
        ]),
        decoyNote: "the restatement was Q2's and is finished; Q3 is clean",
      };
    },
  },
];

// ── planting ──

function context(world: World, seed: number): Ctx {
  const by = (rel: Person["relation"]) => world.people.filter((p) => p.relation === rel);
  const fallback = (p: Person[], rel: Person["relation"]) =>
    (p.length ? p : world.people.filter((q) => q !== world.user).slice(0, 4)).map((q) => ({ ...q, relation: rel }));
  return {
    r: new Rng(seed * 7919 + 88),
    user: world.user,
    colleagues: fallback(by("colleague"), "colleague"),
    clients: fallback(by("client"), "client"),
    vendors: fallback(by("vendor"), "vendor"),
    role: (role) => {
      const p = world.people.find((q) => q.role === role);
      if (p) return p;
      const first = role.split(" ").pop()!;
      return {
        id: `p-h8-${first}`,
        first: capital(first),
        last: "Doe",
        full: `${capital(first)} Doe`,
        email: `${first}@example.com`,
        role,
        relation: "friend",
      };
    },
  };
}

const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Plants one item per template (the decisive one, or the decoy in the control) and returns the tasks. */
export function plantHeldout8(world: World, seed: number, variant: Variant): HiddenTask[] {
  const ctx = context(world, seed);
  const tasks: HiddenTask[] = [];
  for (const t of TEMPLATES) {
    const m = t.make(ctx);
    const p = variant === "hidden" ? m.item : m.decoy;
    const ref = `${SUITE}-${t.name}${variant === "hidden" ? "" : "-control"}`;
    const item: WorldItem = {
      id: itemId(p.sourceId, ref),
      sourceId: p.sourceId,
      ref,
      title: p.title,
      text: p.text,
      updatedAt: p.updatedAt,
      kind: p.kind,
      facts: [],
      noise: false,
      ...(p.meta ? { meta: p.meta } : {}),
    };
    world.items.push(item);
    tasks.push({
      id: `w${seed}:${SUITE}:${t.name}`,
      template: t.name,
      text: m.text,
      detail:
        variant === "hidden"
          ? m.detail
          : `Nothing planted changes the action (${m.decoyNote}); a good answer does not invent this constraint: ` +
            m.detail,
    });
  }
  return tasks;
}

/** The templates' lexical-overlap classes, for reporting. */
export const HELDOUT8_OVERLAP: Record<string, Overlap> = Object.fromEntries(TEMPLATES.map((t) => [t.name, t.overlap]));

/**
 * Tuning suite dev20a (F8, a dev20 tuning set; not held out: tune on it), written by an isolated author. Its flavour
 * is work and admin: vendor renewals, credit holds, release freezes, expense and travel policy, payroll cut-offs,
 * occupational health, LPAs, school forms, licences, insurance, council tax and building rules.
 *
 * 40 templates, five in each life area (work, family, health, money, travel, home, admin, social, in that order).
 * Each is a request the user types (it does not name the hidden context), the consideration a good answer raises, a
 * planted item stating it (variant `hidden`) and a near-miss look-alike that does not apply (`control`); `neutral`
 * plants nothing. Request and detail are the same in every variant.
 *
 * Counts, from the comment above each template:
 * - overlap: none 27, name 7, topic-word 6.
 * - decoys: (a) resolved/expired/superseded 13, (b) other entity or date 14, (c) condition met 13.
 * - phrasing: imperative 12, plan or statement 18 (17 plan, 1 statement), question 10.
 * - languages: English 30; German 2, Spanish 2, French 1, Polish 1, Swedish 1, Turkish 1, Japanese (romaji) 1,
 *   Brazilian Portuguese 1.
 * - anchored 14; rare 12 (school 2, notes 2, tasks 2, residents 2, whatsapp 1, health 1, bank 1, trips 1).
 * - silent edits 10 (calendar 3, drive 2, trips 1, residents 1, tasks 1, notes 1, school 1).
 * - sources of the other 28: gmail 11 (8 notifications, 3 mail), calendar 7, slack 4, drive 3, crm 3.
 * - world knowledge 8: dad-joint-signatory-visit (unregistered LPA), molar-appointment-self-drive (IV sedation),
 *   sunbed-sessions-pre-wedding (doxycycline photosensitivity), gulf-expo-air-tickets (UAE six-month passport rule),
 *   boston-kickoff-departure (pending ESTA), erste-klasse-montag (London-Manchester under 3 hours),
 *   post-off-passport-form (renewal surrenders the passport), golf-road-tax-renewal (no tax without an MOT).
 *
 * World time is Tuesday 27 October 2026, 09:00 UTC. Weekdays checked with Date.UTC: Fri 11 Sep, Mon 14 Sep,
 * Fri 25 Sep, Fri 2 Oct, Fri 9 Oct, Mon 12 Oct, Wed 14 Oct, Thu 15 Oct, Mon 19 Oct, Tue 20 Oct, Thu 22 Oct,
 * Mon 26 Oct, Tue 27 Oct, Wed 28 Oct, Thu 29 Oct, Fri 30 Oct, Sat 31 Oct, Sun 1 Nov, Mon 2 Nov, Tue 3 Nov, Wed 4 Nov,
 * Thu 5 Nov, Fri 6 Nov, Sat 7 Nov, Tue 10 Nov, Thu 12 Nov, Fri 13 Nov, Sat 14 Nov, Mon 16 Nov, Wed 18 Nov,
 * Fri 20 Nov, Thu 26 Nov, Fri 27 Nov, Mon 7 Dec, Fri 18 Dec (all 2026); Sun 31 Jan 2027.
 */
import { itemId } from "@eden/protocol";
import { addRareSources, RARE_SOURCES } from "../rare-sources";
import { Rng } from "../rng";
import { chatText, emailBody, emailText, type Who } from "../text";
import type { ItemKind, Person, World } from "../world";
import type { HiddenTask } from "./hidden-context";

/** A UTC instant in 2026 (month is 1-based), so the dates in this file read as written. */
const at = (month: number, day: number, h = 9, min = 0, year = 2026) => Date.UTC(year, month - 1, day, h, min);

/** One item to plant: everything but the id and ref, which the suite assigns. */
interface Plant {
  sourceId: string;
  kind: ItemKind;
  title: string;
  text: string;
  updatedAt: number;
  meta?: Record<string, string>;
}

interface Spec {
  text: string;
  detail: string;
  hidden: Plant;
  decoy: Plant;
  /**
   * Silent-change templates only (DEV20A_SILENT): the planted item as it read before someone edited it at the
   * source without telling anyone (same sourceId, kind and title as `hidden`, an earlier updatedAt, the old detail).
   * The suite plants `hidden` (the edited copy); a days harness can plant `before` first and swap in `hidden`
   * with no notice. Omit for every other template.
   */
  before?: Plant;
}

/**
 * What a template gets: `r` for every draw that shapes the task (people, numbers), and two forked streams for the
 * prose of the hidden item and of the decoy. Both items are always built, so the draws on `r` are identical across
 * variants and the three suites describe the same people and numbers.
 */
interface Ctx {
  r: Rng;
  ta: Rng;
  tb: Rng;
  user: Person;
  colleagues(k: number): Person[];
  clients(k: number): Person[];
  role(role: string, fallback: [string, string]): Person;
}

const bot = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });

const people = (user: Person, ws: Who[]) =>
  ws
    .filter((w) => w.email !== user.email)
    .map((w) => `${w.full} <${w.email}>`)
    .join("; ");

/** A person-written email, with the greeting, signature and quirks text.ts gives real mail. */
function mail(
  c: Ctx,
  t: Rng,
  m: { from: Who; when: number; title: string; body: string[]; corporate?: boolean },
): Plant {
  const body = emailBody(t, { from: m.from, to: c.user, at: m.when, body: m.body, corporate: m.corporate ?? false });
  return {
    sourceId: "gmail",
    kind: "mail",
    title: m.title,
    text: emailText(m.from, c.user, m.when, body),
    updatedAt: m.when,
    meta: { people: people(c.user, [m.from, c.user]) },
  };
}

/** An automated email: no greeting or signature, a reference and a footer, as service mail has. */
function notice(c: Ctx, t: Rng, m: { from: Who; when: number; title: string; body: string }): Plant {
  const footer = t.pick([
    "This is an automated message. Replies to this address are not read. Manage your preferences | Privacy notice",
    "Please do not reply to this email. For help, visit our website or sign in to your account. Terms | Privacy",
    "You are receiving this because you have an account with us. Update your contact preferences at any time.",
  ]);
  return {
    sourceId: "gmail",
    kind: "notification",
    title: m.title,
    text: emailText(
      m.from,
      c.user,
      m.when,
      `${m.body}\n\nReference: ${t.token("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8)}\n\n${footer}`,
    ),
    updatedAt: m.when,
  };
}

/** A Slack channel excerpt: an unrelated line before the message that matters, as a search hit usually shows. */
function chat(t: Rng, channel: string, lines: { who: Person; text: string; when: number }[], bystander: Person): Plant {
  const chatter = t.pick([
    "is the wifi on 3 dropping for anyone else or just me",
    "fire alarm test at 11, don't panic",
    "lost a black umbrella in the kitchen, shout if you've seen it",
    "all-hands moved to 4pm today btw",
  ]);
  const first = lines[0]!.when - t.int(5, 45) * 60_000;
  const all = [
    { who: bystander.full, text: chatter, at: first },
    ...lines.map((l) => ({ ...l, who: l.who.full, at: l.when })),
  ];
  return {
    sourceId: "slack",
    kind: "chat",
    title: `#${channel}`,
    text: chatText(all),
    updatedAt: lines[lines.length - 1]!.when,
    meta: { people: lines.map((l) => `${l.who.full} <${l.who.email}>`).join("; ") },
  };
}

/** A calendar entry. The date line is written by the template, so it can avoid the request's own date wording. */
function event(m: { title: string; start: number; when: string; where: string; notes: string; edited: number }): Plant {
  return {
    sourceId: "calendar",
    kind: "event",
    title: m.title,
    text: `When: ${m.when}\nWhere: ${m.where}\n\n${m.notes}`,
    updatedAt: m.edited,
    meta: { start: new Date(m.start).toISOString() },
  };
}

/** A document in Drive / Notion. */
const doc = (title: string, text: string, edited: number): Plant => ({
  sourceId: "drive",
  kind: "doc",
  title,
  text: `${title}\n\n${text}`,
  updatedAt: edited,
});

/** The client's company, with a stand-in for a pool member that has none. */
const orgOf = (p: Person) => p.org ?? p.company ?? "Globex";

/** A client at another company than `p`, so a decoy about "the same kind of rule" names a different customer. */
function otherClient(c: Ctx, p: Person): Person {
  const found = c.clients(6).find((q) => orgOf(q) !== orgOf(p));
  if (found) return found;
  const org = orgOf(p) === "Hooli" ? "Initech" : "Hooli";
  return {
    id: "p-lee-brennan",
    first: "Lee",
    last: "Brennan",
    full: "Lee Brennan",
    email: `lee.brennan@${org.toLowerCase()}.com`,
    relation: "client",
    org,
    company: org,
  };
}

/** The user's home address in this suite's items (the world gives the user none). */

/**
 * An item in one of the rarely used connectors (RARE_SOURCES in ../rare-sources.ts: notes, whatsapp, bank, health,
 * school, trips, residents, tasks). Use the connector's kind; write the text the way that app shows it.
 */
const rare = (
  sourceId: string,
  title: string,
  text: string,
  updatedAt: number,
  meta?: Record<string, string>,
): Plant => {
  const src = RARE_SOURCES[sourceId];
  if (!src) throw new Error(`not a rare source: ${sourceId}`);
  return { sourceId, kind: src.kind, title, text, updatedAt, ...(meta ? { meta } : {}) };
};

// Each template is preceded by one labelled comment (wrapped at 120 columns) of this shape:
// overlap: none|name|topic-word · decoy: (a) resolved/expired/superseded|(b) other entity or date|(c) condition met
//   · phrasing: imperative|plan|statement|question · source: <sourceId> (<kind>)
//   · anchored: yes|no · silent: yes|no · rare: yes|no · knowledge: yes|no · language: <English|German|…>
/** A first name from a small bank, for people the world has no pool for (a babysitter, a partner). */
const firstOf = (c: Ctx, xs: string[]) => c.r.pick(xs);

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ---------------------------------------------------------------- work
  // overlap: topic-word · decoy: (b) other entity or date · phrasing: imperative · source: drive (doc)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "vendor-renewal-after-christmas",
    build: (c) => {
      const fee = c.r.int(18, 46) * 1_000;
      const other = c.r.int(6, 15) * 1_000;
      const rows = (t: Rng, focus: string) =>
        [
          "Tool | Owner | Term | Renewal | Notice",
          `Slack (Business+) | IT | annual | 14 Mar 2027 | 30 days | £${t.int(20, 40)}k`,
          focus,
          `Figma (Org) | Design | annual | 1 Jun 2027 | 60 days | £${t.int(8, 19)}k`,
          `1Password | IT | annual | 19 Aug 2027 | none, card billing | £${t.int(2, 5)}k`,
          "",
          t.pick([
            "All auto-renewing contracts: written notice to the vendor's legal address, copy procurement@.",
            "Notice must be in writing (email to the vendor's contract contact counts). Procurement keeps copies.",
          ]),
        ].join("\n");
      return {
        text: "Tell the dashboards supplier we'll decide on the renewal after Christmas.",
        detail:
          `Quantly BI (product analytics) auto-renews for 12 months (£${fee.toLocaleString("en-GB")}) on 31 Jan 2027 ` +
          "unless written notice is given 90 days before, i.e. by Monday 2 November 2026; deciding after Christmas " +
          "means it renews automatically.",
        hidden: doc(
          "Software contracts register FY26/27",
          rows(
            c.ta,
            `Quantly BI (product analytics) | Data | annual, auto-renews 12m | 31 Jan 2027 | 90 days ` +
              `→ notice by Mon 2 Nov 2026 | £${fee.toLocaleString("en-GB")}`,
          ),
          at(10, 9, 15, 20),
        ),
        decoy: doc(
          "Software contracts register FY26/27",
          rows(
            c.tb,
            `Peoplely HRIS | People Ops | annual, auto-renews 12m | 31 Jan 2027 | 90 days ` +
              `→ notice by Mon 2 Nov 2026 | £${other.toLocaleString("en-GB")}`,
          ),
          at(10, 9, 15, 20),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: calendar (event)
  //   · anchored: yes · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "hiring-panel-friday-pm",
    build: (c) => {
      const [vp] = c.colleagues(1);
      const room = c.r.pick(["4.02", "3.11", "the War Room"]);
      const notes = (t: Rng) =>
        `Code freeze from 12:00. You are release captain: you run the bridge and make the call. ` +
        `${vp!.full} asked for no delegate this time. ${t.pick(["Checklist in the release doc.", "Rollback plan reviewed Thu."])}`;
      return {
        text: "I'll join the hiring panel on Friday afternoon.",
        detail:
          "Friday 30 October 14:00-15:30 is the Q4 release go/no-go, which was moved there from Monday 2 November " +
          "without notice; the user is release captain and cannot delegate, so the panel clashes.",
        hidden: event({
          title: "Q4 release go/no-go (release captain)",
          start: at(10, 30, 14),
          when: "Fri 30 Oct 2026, 14:00-15:30",
          where: `Zoom bridge + ${room}`,
          notes: notes(c.ta),
          edited: at(10, 26, 17, 5),
        }),
        before: event({
          title: "Q4 release go/no-go (release captain)",
          start: at(11, 2, 14),
          when: "Mon 2 Nov 2026, 14:00-15:30",
          where: `Zoom bridge + ${room}`,
          notes: notes(c.ta),
          edited: at(10, 12, 10, 0),
        }),
        decoy: event({
          title: "CANCELLED: Q4 release go/no-go (release captain)",
          start: at(10, 30, 14),
          when: "Fri 30 Oct 2026, 14:00-15:30",
          where: `Zoom bridge + ${room}`,
          notes: `Cancelled: the release has slipped to January, no go/no-go this quarter. ${c.tb.pick(["", "Freeze lifted."])}`,
          edited: at(10, 26, 17, 5),
        }),
      };
    },
  },
  // overlap: topic-word · decoy: (b) other entity or date · phrasing: question · source: slack (chat)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "team-dinner-hawksmoor-card",
    build: (c) => {
      const [fin, by] = c.colleagues(2);
      const cap = c.r.pick([45, 50, 55]);
      const total = c.r.pick([250, 300, 400]);
      return {
        text: "Can I put the team dinner at Hawksmoor on my card and claim it back?",
        detail:
          `New entertainment policy (effective now): staff dinners are capped at £${cap} a head including drinks, ` +
          `and anything over £${total} in total needs director pre-approval in Spendwise before booking; no ` +
          "retrospective approval, so a Hawksmoor dinner needs approval first and will likely exceed the cap.",
        hidden: chat(
          c.ta,
          "finance-announcements",
          [
            {
              who: fin!,
              text:
                `Policy change, effective today: staff dinners and entertainment are capped at £${cap} per head incl. ` +
                `drinks. Over £${total} total needs director pre-approval in Spendwise BEFORE you reserve. We can't ` +
                "approve retrospectively any more (audit finding).",
              when: at(10, 26, 11, 2),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "finance-announcements",
          [
            {
              who: fin!,
              text:
                "Policy change from 1 Nov: mileage for business journeys in your own vehicle goes to 48p/mile for " +
                "the first 10,000 miles. Log trips in Spendwise as usual.",
              when: at(10, 26, 11, 2),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: name · decoy: (c) condition met / item allows it · phrasing: plan · source: crm (deal)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "conference-talk-churn-figures",
    build: (c) => {
      const [p] = c.clients(1);
      const org = orgOf(p!);
      const arr = c.r.int(80, 400) * 1_000;
      const base = (status: string) =>
        `Account: ${org}\nOwner: ${c.user.full}\nTier: Enterprise\nARR: $${arr.toLocaleString("en-US")}\n` +
        `Champion: ${p!.full}\nRenewal: 2027-03-31\n${status}\nLast activity: 2026-10-21`;
      return {
        text: `I'm going to show ${org}'s churn numbers in my conference talk.`,
        detail:
          `${org}'s MSA (section 14.2) forbids any public use of their name, logo or data without written consent ` +
          "and the CRM records marketing consent as NO, so their numbers cannot go in a public talk.",
        hidden: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — Account`,
          text: base(
            "Marketing consent: NO. MSA §14.2: no public use of customer name, logo or usage data without prior " +
              `written consent (Legal note, ${c.ta.pick(["2026-09-02", "2026-08-19"])}).`,
          ),
          updatedAt: at(10, 21, 16, 40),
        },
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — Account`,
          text: base(
            `Marketing consent: YES. Case study and logo use approved by ${p!.full} (signed 2026-03-11); public ` +
              `reference OK incl. anonymised usage metrics (${c.tb.pick(["Legal", "Marketing"])} note).`,
          ),
          updatedAt: at(10, 21, 16, 40),
        },
      };
    },
  },
  // overlap: name · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: crm (deal)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "seat-expansion-order-form",
    build: (c) => {
      const [p] = c.clients(1);
      const org = orgOf(p!);
      const seats = c.r.pick([10, 15, 20, 25]);
      const owed = c.r.int(12, 60) * 1_000;
      const head = `Deal: ${org} — Expansion\nStage: Proposal\nOwner: ${c.user.full}\nChampion: ${p!.full}\n`;
      return {
        text: `Send ${org} the order form for the extra ${seats} seats.`,
        detail:
          `${org} is on credit hold (set by Finance 19 Oct): two invoices over 60 days overdue ($` +
          `${owed.toLocaleString("en-US")}); no new order forms or upgrades until accounts receivable clears it.`,
        hidden: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — Expansion 2026`,
          text:
            head +
            `Account status: CREDIT HOLD (Finance, 2026-10-19). 2 invoices 60+ days overdue, $` +
            `${owed.toLocaleString("en-US")} outstanding. No new orders, upgrades or order forms until AR clears.\n` +
            `Next step: ${c.ta.pick(["chase AP contact", "AR call booked"])}`,
          updatedAt: at(10, 19, 14, 12),
        },
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — Expansion 2026`,
          text:
            head +
            "Account status: good standing. Credit hold lifted 2026-10-02 after the overdue balance was paid in " +
            `full.\nNext step: ${c.tb.pick(["send revised order form", "pricing call"])}`,
          updatedAt: at(10, 19, 14, 12),
        },
      };
    },
  },
  // ---------------------------------------------------------------- family
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: school (mail)
  //   · anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "outing-slip-on-the-weekend",
    build: (c) => {
      const fee = c.r.pick([8, 12, 14, 16]);
      const letter = (t: Rng, year: string, place: string, day: string, due: string) =>
        `Dear ${year} parents and carers,\n\n${day} ${year} will visit ${place}. ` +
        `Please give consent and pay £${fee} on ParentPay by 12 noon on ${due}. We have to confirm coach numbers ` +
        `with the company that afternoon, so we are unable to accept late replies. Children need a packed lunch, ` +
        `${t.pick(["a waterproof coat", "sensible shoes and a coat"])} and a named water bottle.\n\n` +
        `Kind regards,\n${year} team`;
      return {
        text: "Remind me to sign Maya's outing slip on Sunday.",
        detail:
          `The Year 4 Kew Gardens visit (Thu 5 Nov) needs consent and £${fee} on ParentPay by 12 noon Friday ` +
          "30 October; late replies are not accepted, so Sunday is too late.",
        hidden: rare(
          "school",
          "Year 4 visit to Kew Gardens: consent and payment",
          letter(c.ta, "Year 4", "Kew Gardens", "On Thursday 5 November", "Friday 30 October"),
          at(10, 20, 15, 30),
        ),
        decoy: rare(
          "school",
          "Year 6 visit to the Science Museum: consent and payment",
          letter(c.tb, "Year 6", "the Science Museum", "On Thursday 26 November", "Friday 20 November"),
          at(10, 20, 15, 30),
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: calendar (event)
  //   · anchored: no · silent: yes · rare: no · knowledge: no · language: Polish
  {
    name: "babcia-thursday-collection",
    build: (c) => {
      const fee = c.r.pick([10, 15, 20]);
      const where = "Oakfield Primary, side gate";
      return {
        text: "Mama odbiera dzieci w czwartek o 18, napisz jej, że nie musi się spieszyć.",
        detail:
          "The after-school club closes early on Thursday 29 October (staff training): collection by 17:15, not " +
          `18:00, with a £${fee} late fee per 10 minutes, so grandma does need to hurry.`,
        hidden: event({
          title: "Kids: after-school club collection",
          start: at(10, 29, 17, 15),
          when: "Thu 29 Oct, by 17:15",
          where,
          notes:
            `Club closes early this week (staff INSET training). Late collection £${fee} per 10 min. ` +
            c.ta.pick(["Bring the PE bags home.", "Book bags go home too."]),
          edited: at(10, 23, 13, 0),
        }),
        before: event({
          title: "Kids: after-school club collection",
          start: at(10, 29, 18),
          when: "Thu 29 Oct, by 18:00",
          where,
          notes: `Usual collection. Late collection £${fee} per 10 min.`,
          edited: at(9, 1, 8, 0),
        }),
        decoy: event({
          title: "Kids: after-school club collection",
          start: at(11, 12, 17, 15),
          when: "Thu 12 Nov, by 17:15",
          where,
          notes:
            `Club closes early that week (staff INSET training). Late collection £${fee} per 10 min. ` +
            c.tb.pick(["Bring the PE bags home.", "Book bags go home too."]),
          edited: at(10, 23, 13, 0),
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met / item allows it · phrasing: plan · source: gmail (mail)
  //   · anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "dad-joint-signatory-visit",
    build: (c) => {
      const sol = c.role("solicitor", ["Harriet", "Lowe"]);
      const weeks = c.r.pick(["16-20", "14-18", "18-22"]);
      const from: Who = { ...sol, company: "Lowe & Partners LLP", title: "Partner" };
      return {
        text: "Taking Dad to his bank on Friday to get me added to his accounts.",
        detail:
          "Dad's Lasting Power of Attorney (property and financial affairs) was only sent to the Office of the " +
          `Public Guardian on 14 October and registration takes ${weeks} weeks; an unregistered LPA cannot be used, ` +
          "so the bank will not act on it on Friday.",
        hidden: mail(c, c.ta, {
          from,
          when: at(10, 16, 11, 20),
          title: "Your father's LPA (property and financial affairs)",
          corporate: true,
          body: [
            "The signed LPA went to the Office of the Public Guardian on 14 October.",
            `They are currently quoting ${weeks} weeks to register, and I'll forward the stamped original as soon ` +
              "as it comes back to us.",
            "Our invoice for the drafting will follow separately.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from,
          when: at(10, 16, 11, 20),
          title: "Your father's LPA (property and financial affairs)",
          corporate: true,
          body: [
            "Good news: the Office of the Public Guardian has registered the LPA.",
            "The stamped original is in the post to you today, and I've ordered three certified copies for " +
              "institutions that ask for one.",
            "Our invoice for the drafting will follow separately.",
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: gmail (notification)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: German
  {
    name: "oma-sunday-with-kids",
    build: (c) => {
      const floor = c.r.pick(["Rowan", "Beech", "Hazel"]);
      const from = bot("Willow Court Care Home", "families@willowcourtcare.co.uk");
      return {
        text: "Können wir Oma am Sonntag im Heim besuchen, mit den Kindern?",
        detail:
          `Willow Court has suspended visiting until at least Monday 2 November because of a norovirus outbreak ` +
          `(${floor} floor); only essential visits by arrangement and no under-16s, so Sunday 1 Nov with the ` +
          "children is not possible.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 25, 18, 10),
          title: "Visiting update from Willow Court",
          body:
            `Dear families,\n\nFollowing confirmed cases of norovirus on ${floor} floor, and on the advice of the ` +
            "UKHSA health protection team, visiting is suspended until at least Monday 2 November. Essential visits " +
            "(for example end of life) can be arranged with the nurse in charge only, and no under-16s may visit " +
            "while restrictions are in place.\n\nWe will write again as soon as things change. Thank you for your " +
            "patience.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 25, 18, 10),
          title: "Visiting update from Willow Court",
          body:
            `Dear families,\n\nWe are pleased to say the norovirus outbreak on ${floor} floor was declared over on ` +
            "20 October. Normal visiting resumes: 10:00-20:00 every day, and children are very welcome again.\n\n" +
            "Thank you for your patience over the last fortnight.",
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: whatsapp (chat)
  //   · anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "dishoom-for-two-midweek",
    build: (c) => {
      const sitter = firstOf(c, ["Chloe", "Megan", "Holly", "Ruby"]);
      const reason = c.r.pick(["a mock exam the morning after", "a uni deadline the day after"]);
      return {
        text: "Book a table for two at Dishoom next Wednesday at 7.",
        detail:
          `${sitter}, the babysitter, has cancelled for Wednesday 4 November (${reason}), so there is no ` +
          "childcare that evening unless someone else is found or the dinner moves (she offered Thu 5th).",
        hidden: rare(
          "whatsapp",
          `${sitter} (babysitter)`,
          `[Mon 26 Oct 21:14] ${sitter}: Hiya! Really sorry but I can't do Weds 4th any more 😩 I've got ${reason}\n` +
            `[21:15] ${sitter}: I could do Thu 5th instead if that helps?\n` +
            `[21:40] You: ${c.ta.pick(["no worries, I'll sort something x", "ah ok, leave it with me x"])}`,
          at(10, 26, 21, 40),
        ),
        decoy: rare(
          "whatsapp",
          `${sitter} (babysitter)`,
          `[Mon 26 Oct 21:14] ${sitter}: Hiya! Really sorry but I can't do Sat 14th any more 😩 I've got ${reason}\n` +
            `[21:15] ${sitter}: Weds 4th is still fine though!\n` +
            `[21:40] You: ${c.tb.pick(["no worries, thanks x", "perfect, see you then x"])}`,
          at(10, 26, 21, 40),
        ),
      };
    },
  },
  // ---------------------------------------------------------------- health
  // overlap: none · decoy: (c) condition met / item allows it · phrasing: plan · source: health (notification)
  //   · anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "thyroid-tablets-pickup",
    build: (c) => {
      const dose = c.r.pick(["100 microgram", "75 microgram", "125 microgram"]);
      const head = `Your request for: Levothyroxine sodium ${dose}, 28 x1\nNominated pharmacy: Boots, High Street\n`;
      return {
        text: "I'll grab my thyroid tablets from the chemist on Thursday.",
        detail:
          `The repeat prescription request for levothyroxine ${dose} was rejected by the practice on 26 October ` +
          "because a medication review is overdue; nothing will be at the pharmacy until a review with the " +
          "clinical pharmacist is booked.",
        hidden: rare(
          "health",
          "Prescription request update",
          head +
            "Status: Rejected by practice (26 Oct 2026)\nReason: medication review overdue. Please book a review " +
            `with the clinical pharmacist before further issues. ${c.ta.pick(["Book online or call reception.", ""])}`,
          at(10, 26, 15, 2),
        ),
        decoy: rare(
          "health",
          "Prescription request update",
          head +
            "Status: Approved and sent to pharmacy (26 Oct 2026)\nUsually ready to collect within 2 working days. " +
            c.tb.pick(["Your next review is due in March.", ""]),
          at(10, 26, 15, 2),
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: calendar (event)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: Swedish
  {
    name: "berlin-offsite-yes-or-no",
    build: (c) => {
      const provider = c.r.pick(["Medigold Health", "Health Partners", "PAM OH"]);
      return {
        text: "Ska jag tacka ja till offsiten i Berlin den 12:e?",
        detail:
          `The mandatory occupational health assessment (${provider}, video) is Thursday 12 November 10:00-11:00; ` +
          "it is required before sign-off for full duties and travel and needs 5 working days' notice to move.",
        hidden: event({
          title: "Occupational health assessment (return-to-work)",
          start: at(11, 12, 10),
          when: "Thu 12 Nov 2026, 10:00-11:00",
          where: `Video call, ${provider}`,
          notes:
            "Mandatory before you're signed off for full duties and travel. Rescheduling needs 5 working days' " +
            `notice via HR. ${c.ta.pick(["Have your fit notes to hand.", "Link sent the day before."])}`,
          edited: at(10, 20, 9, 30),
        }),
        decoy: event({
          title: "Occupational health assessment (return-to-work)",
          start: at(10, 15, 10),
          when: "Thu 15 Oct 2026, 10:00-11:00",
          where: `Video call, ${provider}`,
          notes:
            "Completed. Outcome: fit for full duties including travel; no follow-up needed. " +
            c.tb.pick(["Report sent to HR.", "Letter on file."]),
          edited: at(10, 15, 11, 10),
        }),
      };
    },
  },
  // overlap: none · decoy: (c) condition met / item allows it · phrasing: plan · source: gmail (notification)
  //   · anchored: yes · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "molar-appointment-self-drive",
    build: (c) => {
      const time = c.r.pick(["08:30", "08:45", "09:15"]);
      const from = bot("Brightsmile Dental", "appointments@brightsmiledental.co.uk");
      const body = (treatment: string, prep: string) =>
        `Patient: ${c.user.full}\nAppointment: Mon 2 Nov 2026, ${time}, with Dr N. Okafor\nTreatment: ${treatment}\n\n` +
        `${prep}\nCancellation fee for less than 48 hours' notice: £50.`;
      return {
        text: "I'll drive myself to the dentist on Monday then head into work.",
        detail:
          `Monday 2 November ${time} is a wisdom tooth extraction under IV sedation (midazolam): after sedation ` +
          "you must not drive or work for the rest of the day and need an adult to take you home.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 22, 12, 0),
          title: "Appointment confirmation",
          body: body(
            "removal of lower left wisdom tooth under IV sedation (midazolam)",
            "Please have nothing to eat for 2 hours beforehand, bring a list of current medicines and arrive 10 " +
              "minutes early.",
          ),
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 22, 12, 0),
          title: "Appointment confirmation",
          body: body(
            "6-monthly check-up and hygienist clean",
            "Please arrive 5 minutes early and let us know of any change to your medicines.",
          ),
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: gmail (mail)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: Spanish
  {
    name: "vuelta-jornada-completa",
    build: (c) => {
      const [hr] = c.colleagues(1);
      const from: Who = { ...hr!, title: "People Partner", company: "Northwind" };
      return {
        text: "El lunes vuelvo a jornada completa, avísale al equipo.",
        detail:
          "The agreed phased return runs to Friday 13 November: Monday to Wednesday only, 10:00-15:00, from home, " +
          "no client travel; returning full-time on Monday 2 November is not what was agreed with HR/OH.",
        hidden: mail(c, c.ta, {
          from,
          when: at(10, 19, 16, 45),
          title: "Your phased return plan",
          corporate: true,
          body: [
            "Following your fit note and the call with occupational health, here's what we agreed.",
            "Weeks 1-2 (to Fri 13 Nov): Monday, Tuesday and Wednesday only, 10:00-15:00, from home, no client travel.",
            "From 16 Nov we'll review together and, if all's well, step up to four days.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from,
          when: at(10, 9, 16, 45),
          title: "Your phased return plan",
          corporate: true,
          body: [
            "Just confirming your phased return finished today, Friday 9 October.",
            "From Monday 12 October you're back on your normal contract hours and duties, no restrictions.",
            "Glad it went smoothly.",
          ],
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: notes (doc)
  //   · anchored: no · silent: no · rare: yes · knowledge: yes · language: English
  {
    name: "sunbed-sessions-pre-wedding",
    build: (c) => {
      const gp = c.r.pick(["Dr Shah", "Dr Mensah", "Dr Lowry"]);
      const rest = (t: Rng) =>
        `Vitamin D: 1 a day (Oct-Mar)\nCetirizine as needed\n${t.pick(["Flu jab done 3 Oct", "Flu jab: book"])}`;
      return {
        text: "Thinking of doing a couple of sunbed sessions before the wedding next week.",
        detail:
          `The user is taking doxycycline (26 Oct to 8 Nov, prescribed by ${gp}), which makes skin photosensitive; ` +
          "sunbeds risk severe burns until the course ends.",
        hidden: rare(
          "notes",
          "Meds",
          `Doxycycline 100mg: 1 twice a day, 26 Oct → 8 Nov (tick bite, ${gp})\n- take upright with a full glass ` +
            `of water\n- not with milk/yoghurt\n${rest(c.ta)}`,
          at(10, 26, 19, 30),
        ),
        decoy: rare(
          "notes",
          "Meds",
          `Doxycycline 100mg: 12 Aug → 19 Aug, finished ✓ (tick bite, ${gp})\n${rest(c.tb)}`,
          at(10, 26, 19, 30),
        ),
      };
    },
  },
  // ---------------------------------------------------------------- money
  // overlap: name · decoy: (b) other entity or date · phrasing: imperative · source: bank (notification)
  //   · anchored: no · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "september-invoice-chaser",
    build: (c) => {
      const [p] = c.clients(1);
      const org = orgOf(p!);
      const other = orgOf(otherClient(c, p!));
      const amt = c.r.int(18, 64) * 100;
      const bal = c.r.int(40, 90) * 100;
      const line = (t: Rng, who: string, ref: string) =>
        `+£${amt.toLocaleString("en-GB")}.00 from ${who.toUpperCase()} LTD\nReference: ${ref}\nMon 26 Oct · ` +
        `Faster Payment\nBalance after: £${(bal + amt).toLocaleString("en-GB")}.${t.int(10, 99)}`;
      return {
        text: `Send ${org} a chaser for my September invoice.`,
        detail:
          `${org} paid £${amt.toLocaleString("en-GB")} on Monday 26 October (reference INV-0917 SEPT); the ` +
          "September invoice is settled, so no chaser is needed.",
        hidden: rare("bank", "Payment received", line(c.ta, org, "INV-0917 SEPT"), at(10, 26, 10, 12)),
        decoy: rare("bank", "Payment received", line(c.tb, other, "INV-0921 SEPT"), at(10, 26, 10, 12)),
      };
    },
  },
  // overlap: none · decoy: (c) condition met / item allows it · phrasing: plan · source: gmail (mail)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: French
  {
    name: "declaration-pendant-les-fetes",
    build: (c) => {
      const acc = c.role("accountant", ["Owen", "Price"]);
      const close = c.r.pick(["18 December", "17 December"]);
      return {
        text: "Je ferai ma déclaration d'impôts pendant les fêtes, j'ai largement le temps.",
        detail:
          "The accountant needs the 2025-26 Self Assessment figures (income and expenses, P60, pension statements) " +
          `by Friday 20 November; the practice closes on ${close} and cannot promise to file anything later before ` +
          "31 January.",
        hidden: mail(c, c.ta, {
          from: acc,
          when: at(10, 21, 10, 5),
          title: "Self Assessment 2025-26",
          body: [
            "To file your 2025-26 return I'll need your income and expenses spreadsheet, your P60 and your pension " +
              "statements.",
            `Please get everything to me by Friday 20 November. We close for the year on ${close}, and I can't ` +
              "promise to file anything that arrives after the 20th before the 31 January deadline.",
          ],
        }),
        decoy: mail(c, c.tb, {
          from: acc,
          when: at(10, 21, 10, 5),
          title: "Self Assessment 2025-26",
          body: [
            "Everything for your 2025-26 return has arrived: spreadsheet, P60 and pension statements.",
            "I'll file it in early January; there's nothing more I need from you.",
          ],
        }),
      };
    },
  },
  // overlap: topic-word · decoy: (c) condition met / item allows it · phrasing: question · source: drive (doc)
  //   · anchored: no · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "pension-up-to-fifteen",
    build: (c) => {
      const [ops] = c.colleagues(1);
      const cal = (oct: string) =>
        [
          "Pay date | Cut-off for changes (starters, leavers, salary sacrifice incl. pension %, bank details)",
          "September: Fri 25 Sep | Fri 11 Sep",
          `October: Fri 30 Oct | ${oct}`,
          "November: Fri 27 Nov | Wed 18 Nov",
          "December: Fri 18 Dec | Mon 7 Dec",
          "",
          `Changes received after a cut-off roll into the following month. Questions: ${ops!.full}.`,
        ].join("\n");
      return {
        text: "Can I bump my pension contributions to 15% this month?",
        detail:
          "The payroll calendar's October cut-off for salary-sacrifice and pension changes is Tuesday 20 October " +
          "(it was quietly moved from Thursday 29 October), so a change now only applies from the November payroll " +
          "(cut-off Wed 18 Nov).",
        hidden: doc("Payroll calendar 2026", cal("Tue 20 Oct"), at(10, 14, 12, 0)),
        before: doc("Payroll calendar 2026", cal("Thu 29 Oct"), at(9, 1, 9, 0)),
        decoy: doc("Payroll calendar 2026", cal("Thu 29 Oct"), at(10, 14, 12, 0)),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: slack (chat)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "landlord-transfer-on-the-28th",
    build: (c) => {
      const [ops, by] = c.colleagues(2);
      return {
        text: "I'll pay the rent on the 28th like always.",
        detail:
          "October salaries arrive on Friday 30 October, not Wednesday 28 October, because of the switch to a " +
          "new payroll provider; paying on the 28th may go out before the salary lands.",
        hidden: chat(
          c.ta,
          "announcements",
          [
            {
              who: ops!,
              text:
                "Heads up all: because of the switch to the new payroll provider, October salaries land on Friday " +
                "30th instead of Wednesday. Sorry for the hassle. If that causes a real problem DM me and we can " +
                "look at an advance.",
              when: at(10, 23, 10, 15),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "announcements",
          [
            {
              who: ops!,
              text:
                "Update on September salaries: the bank delay is sorted and everyone should now see the money in " +
                "their accounts. October is unaffected and goes out as normal.",
              when: at(9, 29, 10, 15),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: Turkish
  {
    name: "su-faturasi-odensin-mi",
    build: (c) => {
      const amt = c.r.int(380, 720);
      const fixed = c.r.int(150, 260);
      const from = bot("Thames Water", "no-reply@thameswater.co.uk");
      return {
        text: "Su faturasını şimdi ödeyeyim mi, yoksa bekleyeyim mi?",
        detail:
          `The £${amt} water bill is on hold while Thames Water checks the disputed meter reading; nothing needs ` +
          "paying now and a corrected bill will follow within 28 days.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 22, 8, 30),
          title: "We've put your account on hold",
          body:
            `We're looking into the reading you queried on your latest bill (£${amt}.00). While we check it, ` +
            "your account is on hold: you don't need to pay anything for now and we won't take any recovery " +
            "action. We'll send you a corrected bill within 28 days.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 22, 8, 30),
          title: "We've put your account on hold",
          body:
            `Update: we've finished checking the reading you queried on your bill of £${amt}.00 and the hold on ` +
            `your account has now been removed. Your corrected bill is £${fixed}.00, due by 10 November.`,
        }),
      };
    },
  },
  // ---------------------------------------------------------------- travel
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: tasks (doc)
  //   · anchored: no · silent: no · rare: yes · knowledge: yes · language: English
  {
    name: "gulf-expo-air-tickets",
    build: (c) => {
      const exp = c.r.pick(["3 May 2027", "21 Apr 2027", "9 Jun 2027"]);
      return {
        text: "Book my flights for the Dubai trade show in February.",
        detail:
          `The user's passport expires ${exp}; the UAE requires six months' validity on entry, so a February trip ` +
          "needs the passport renewed first (and renewal takes weeks).",
        hidden: rare(
          "tasks",
          "Renew passport",
          `No due date · Priority 4 · Project: Admin\nCurrent one expires ${exp}, sort in spring\n` +
            `[ ] new photo  [ ] countersignatory? ${c.ta.pick(["ask Leila", "ask a neighbour"])}`,
          at(9, 3, 20, 0),
        ),
        decoy: rare(
          "tasks",
          "Renew passport",
          `✓ Completed 2 Oct · Project: Admin\nNew one arrived, valid to Oct 2036. ` +
            c.tb.pick(["Old one cut and returned.", "Shred the old photos."]),
          at(10, 2, 18, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met / item allows it · phrasing: plan · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "boston-kickoff-departure",
    build: (c) => {
      const n = c.r.token("0123456789ABCDEFGHJKLMNPQRSTUVWXYZ", 16);
      const from = bot("ESTA, U.S. Customs and Border Protection", "esta@cbp.dhs.gov");
      const head = `Application number: ${n}\nApplicant: ${c.user.full.toUpperCase()}\nSubmitted: 26 Oct 2026 22:41\n`;
      return {
        text: "I'm flying out to Boston the day after tomorrow for the kickoff.",
        detail:
          "The ESTA submitted on 26 October is still Authorization Pending (decisions take up to 72 hours); without " +
          "an approved ESTA the airline will not board the user on Thursday 29 October.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 26, 22, 45),
          title: "ESTA application status",
          body:
            head +
            "Status: AUTHORIZATION PENDING\n\nA determination is usually made within 72 hours. You can check " +
            "your status online using your application number.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 26, 22, 45),
          title: "ESTA application status",
          body: head + "Status: AUTHORIZATION APPROVED\n\nValid until 26 Oct 2028 or until your passport expires.",
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: drive (doc)
  //   · anchored: no · silent: yes · rare: no · knowledge: yes · language: German
  {
    name: "erste-klasse-montag",
    build: (c) => {
      const ver = c.r.int(4, 7);
      const air =
        "3.3 Air: economy for flights under 6 hours; premium economy over 6 hours with line-manager approval.";
      const hotel = "3.4 Hotels: up to £160/night in London, £120 elsewhere in the UK, booked through Navan.";
      return {
        text: "Buch mir für Montag ein Erste-Klasse-Ticket nach Manchester.",
        detail:
          "The travel policy (edited 15 Oct) allows only standard class on rail journeys under 3 hours unless a " +
          "director approves first class in advance; London to Manchester is about 2 hours 10 minutes.",
        hidden: doc(
          `Travel & Expenses Policy v${ver}`,
          "3.2 Rail: standard class for all journeys under 3 hours. First class only with prior Director " +
            `approval in Navan.\n${air}\n${hotel}`,
          at(10, 15, 16, 0),
        ),
        before: doc(
          `Travel & Expenses Policy v${ver}`,
          "3.2 Rail: standard class for journeys under 2 hours; first class permitted for longer journeys.\n" +
            `${air}\n${hotel}`,
          at(4, 1, 9, 0),
        ),
        decoy: doc(
          `Travel & Expenses Policy v${ver}`,
          "3.2 Rail: first class permitted for journeys over 2 hours.\n" +
            "3.3 Air: economy for all flights under 8 hours. Premium economy and business class now need CFO " +
            `approval in Navan.\n${hotel}`,
          at(10, 15, 16, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met / item allows it · phrasing: question · source: slack (chat)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: Spanish
  {
    name: "premier-inn-leeds-gasto",
    build: (c) => {
      const [fin, by] = c.colleagues(2);
      const cap = c.r.pick([110, 120, 130]);
      return {
        text: "¿Puedo reservar yo mismo el Premier Inn para el viaje a Leeds y luego pasarlo como gasto?",
        detail:
          "From 1 November every hotel stay must go through Navan; hotels reserved outside it will not be " +
          "reimbursed, so the user should not book the Premier Inn directly.",
        hidden: chat(
          c.ta,
          "travel",
          [
            {
              who: fin!,
              text:
                "Reminder from Finance: from 1 Nov every hotel stay goes through Navan. Anything reserved outside it " +
                "won't be reimbursed, no exceptions (audit finding).",
              when: at(10, 22, 14, 3),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "travel",
          [
            {
              who: fin!,
              text:
                `Quick clarification on hotels: Navan is optional for stays under £${cap}/night, fine to reserve ` +
                "those directly and submit the receipt as normal.",
              when: at(10, 22, 14, 3),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: question · source: trips (doc)
  //   · anchored: yes · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "cph-thursday-departure-time",
    build: (c) => {
      const conf = c.r.token("ABCDEFGHJKLMNPQRSTUVWXYZ", 6);
      const seat = `${c.r.int(8, 28)}${c.r.pick(["A", "C", "D", "F"])}`;
      const trip = (out: string, back: string) =>
        `Thu 29 Oct - Fri 30 Oct 2026 · Confirmation ${conf}\n\nOutbound · Thu 29 Oct\n${out}\nSeat ${seat}\n\n` +
        `Return · Fri 30 Oct\n${back}\n\nHotel: Scandic Copenhagen, 1 night`;
      const heathrow = "SK502 · London Heathrow (LHR) Terminal 2, 11:40 → Copenhagen (CPH) 14:30";
      return {
        text: "What time should I leave for my Thursday flight to Copenhagen?",
        detail:
          "The outbound flight was changed (TripIt updated 24 Oct): it now leaves London Gatwick North Terminal at " +
          "07:05 on Thursday 29 October, not Heathrow at 11:40, so the user must leave around 04:45.",
        hidden: rare(
          "trips",
          "Copenhagen: client workshop",
          trip(
            "SK1530 · London Gatwick (LGW) North Terminal, 07:05 → Copenhagen (CPH) 09:55",
            "SK503 · CPH 17:20 → LHR 18:05",
          ),
          at(10, 24, 6, 30),
        ),
        before: rare(
          "trips",
          "Copenhagen: client workshop",
          trip(heathrow, "SK503 · CPH 17:20 → LHR 18:05"),
          at(10, 2, 12, 0),
        ),
        decoy: rare(
          "trips",
          "Copenhagen: client workshop",
          trip(heathrow, "SK1531 · CPH 20:40 → London Gatwick (LGW) North Terminal 21:35 (changed)"),
          at(10, 24, 6, 30),
        ),
      };
    },
  },
  // ---------------------------------------------------------------- home
  // overlap: topic-word · decoy: (c) condition met / item allows it · phrasing: imperative
  //   · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "ergonomic-seat-on-company",
    build: (c) => {
      const used = c.r.int(30, 37) * 10;
      const from = bot("Northwind Benefits", "benefits@perks.northwind.co");
      return {
        text: "Order the ergonomic chair I bookmarked and put it on the company.",
        detail:
          `Only £${400 - used} of the £400 home-working equipment allowance is left (£${used} used in May); ` +
          "anything over the remaining balance cannot be claimed, so the chair will mostly be out of pocket.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 12, 9, 0),
          title: "Your home-working equipment allowance",
          body:
            `Allowance for 2026/27: £400\nUsed: £${used} (desk riser, monitor; May 2026)\nRemaining: £${400 - used}\n\n` +
            "Eligible items: chair, desk, monitor, keyboard, headset. Items over your remaining balance can't be " +
            "claimed. Orders go through the IT equipment portal. Allowance resets on 1 April.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 12, 9, 0),
          title: "Your home-working equipment allowance",
          body:
            "Allowance for 2026/27: £400\nUsed: £0\nRemaining: £400\n\n" +
            "Eligible items: chair, desk, monitor, keyboard, headset. Orders go through the IT equipment portal. " +
            "Allowance resets on 1 April.",
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: statement · source: residents (doc)
  //   · anchored: yes · silent: no · rare: yes · knowledge: no · language: English
  {
    name: "settee-arriving-saturday",
    build: (c) => {
      const block = c.r.pick(["Block A", "Block B", "Maple House"]);
      return {
        text: "The new sofa's being delivered on Saturday.",
        detail:
          `The goods lift in ${block} is out of service from Friday 30 October to Friday 6 November; no large ` +
          "deliveries can take place and the passenger lift may not be used for furniture, so a Saturday 31 " +
          "October delivery cannot go ahead.",
        hidden: rare(
          "residents",
          "Goods lift out of service",
          `Dear residents,\n\nThe goods lift in ${block} will be out of service from Fri 30 Oct to Fri 6 Nov for ` +
            "refurbishment. Large deliveries and removals cannot take place in this period, and the passenger " +
            "lift must not be used for furniture. Bookings already made for these dates are cancelled.\n\n" +
            `${c.ta.pick(["Apologies for the inconvenience.", "Thank you for your patience."])}\nEstate Office`,
          at(10, 21, 12, 0),
        ),
        decoy: rare(
          "residents",
          "Goods lift out of service",
          `Dear residents,\n\nThe goods lift in ${block} is back in service after its refurbishment (14-25 Sep). ` +
            "Deliveries and removals can be booked again through the concierge as normal.\n\n" +
            `${c.tb.pick(["Thank you for your patience.", "Apologies for the inconvenience."])}\nEstate Office`,
          at(9, 25, 16, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met / item allows it · phrasing: plan · source: residents (doc)
  //   · anchored: yes · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "early-diy-wednesday",
    build: (c) => {
      const agent = c.r.pick(["Rendall & Rittner", "the managing agent"]);
      const rules = (hours: string) =>
        `1. Noisy work (drilling, hammering, sanding) is permitted ${hours} only, never on bank holidays.\n` +
        "2. Please let neighbours on either side and below know a day ahead.\n" +
        "3. Building waste must not go in the communal bins.\n" +
        `Breaches can be reported to ${agent}.`;
      return {
        text: "Tomorrow I'm putting up shelves in the study, starting at 8.",
        detail:
          "The building's house rules (updated 19 Oct) allow drilling only Monday to Friday 09:30-17:00; starting " +
          "at 08:00 on Wednesday 28 October breaks them.",
        hidden: rare(
          "residents",
          "House rules: noise and building work",
          rules("Monday to Friday 09:30-17:00"),
          at(10, 19, 11, 0),
        ),
        before: rare(
          "residents",
          "House rules: noise and building work",
          rules("Monday to Friday 08:00-18:00 and Saturday 09:00-13:00"),
          at(3, 2, 11, 0),
        ),
        decoy: rare(
          "residents",
          "House rules: noise and building work",
          rules("Monday to Saturday 08:00-18:00"),
          at(10, 19, 11, 0),
        ),
      };
    },
  },
  // overlap: none · decoy: (c) condition met / item allows it · phrasing: plan · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: Japanese
  {
    name: "atarashii-heya-terewaaku",
    build: (c) => {
      const flat = c.r.int(2, 48);
      const from = bot("Hyperoptic", "hello@hyperoptic.com");
      const body = (live: string) =>
        `New address: Flat ${flat}, Albion Wharf\n${live}\nYour service at your current address will stop on ` +
        "Fri 30 Oct.\n\nNeed to stay connected sooner? Ask us about a 4G backup router.";
      return {
        text: "Raishuu no getsuyoubi kara atarashii heya de terewaaku suru yotei desu.",
        detail:
          "Broadband at the new flat is only activated on Tuesday 10 November (engineer visit), and the old line " +
          "stops on 30 October, so there is no home internet for remote work from Monday 2 November.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 20, 13, 0),
          title: "Your home move: what happens next",
          body: body("Your service at the new address will be activated on Tue 10 Nov, 8am-1pm (engineer visit)."),
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 20, 13, 0),
          title: "Your home move: what happens next",
          body: body("Your service at the new address will be activated on Fri 30 Oct, 8am-1pm (engineer visit)."),
        }),
      };
    },
  },
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: question · source: calendar (event)
  //   · anchored: yes · silent: yes · rare: no · knowledge: no · language: English
  {
    name: "away-from-flat-thursday",
    build: (c) => {
      const ref = c.r.token("0123456789", 8);
      const notes = `Job ref ${ref}. Someone over 18 must be in; supply off ~2 hours. Meter cupboard under the stairs.`;
      return {
        text: "Is it fine if I'm out all day on Thursday?",
        detail:
          "The smart meter installation (British Gas) was moved to Thursday 29 October, 08:00-12:00 arrival " +
          "window, and someone over 18 must be in.",
        hidden: event({
          title: "Smart meter installation: British Gas",
          start: at(10, 29, 8),
          when: "Thu 29 Oct, 08:00-12:00 (arrival window)",
          where: "Home",
          notes,
          edited: at(10, 24, 9, 12),
        }),
        before: event({
          title: "Smart meter installation: British Gas",
          start: at(11, 6, 8),
          when: "Fri 6 Nov, 08:00-12:00 (arrival window)",
          where: "Home",
          notes,
          edited: at(10, 5, 15, 0),
        }),
        decoy: event({
          title: "CANCELLED: Smart meter installation: British Gas",
          start: at(10, 29, 8),
          when: "Thu 29 Oct, 08:00-12:00 (arrival window)",
          where: "Home",
          notes: `Job ref ${ref}. Cancelled by you on 20 Oct; ${c.tb.pick(["rebook in spring.", "not needed."])}`,
          edited: at(10, 20, 9, 12),
        }),
      };
    },
  },
  // ---------------------------------------------------------------- admin
  // overlap: none · decoy: (a) resolved/expired/superseded · phrasing: plan · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "highlands-rental-motor",
    build: (c) => {
      const num = `${c.user.last.toUpperCase().slice(0, 5).padEnd(5, "9")}${c.r.token("0123456789", 6)}`;
      const from = bot("DVLA", "noreply@dvla.gov.uk");
      return {
        text: "Planning to hire a car in Scotland next weekend.",
        detail:
          "The user's photocard driving licence expired on 12 October 2026 and has not been renewed; hire " +
          "companies will not accept an expired licence.",
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 13, 7, 0),
          title: "Your photocard driving licence has expired",
          body:
            `Our records show that the photocard for driving licence ${num} expired on 12 October 2026. You must ` +
            "renew your photocard. You can do this online at GOV.UK; it costs £14 and usually arrives within a week.",
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 13, 7, 0),
          title: "Your photocard driving licence has been renewed",
          body:
            `Your new photocard for driving licence ${num} has been sent. It is valid until 12 October 2036. ` +
            "Please destroy your old photocard.",
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: imperative · source: tasks (doc)
  //   · anchored: no · silent: yes · rare: yes · knowledge: no · language: Brazilian Portuguese
  {
    name: "debito-imposto-prefeitura",
    build: (c) => {
      const ref = `CTX-${c.r.token("0123456789", 6)}`;
      const amt = (c.r.int(1500, 2400) / 10).toFixed(2);
      return {
        text: "Configura o débito automático da taxa da prefeitura pro dia 1º de cada mês.",
        detail:
          `The council tax direct debit is already set up (done 22 Oct, ref ${ref}): 10 monthly instalments of ` +
          `£${amt} on the 15th, first on 15 November; setting up a second one would double-pay.`,
        hidden: rare(
          "tasks",
          "Council tax direct debit",
          `✓ Completed 22 Oct · Project: Flat\nSet up with Camden: 10 monthly instalments of £${amt} on the 15th, ` +
            `first 15 Nov. Ref ${ref}.`,
          at(10, 22, 18, 30),
        ),
        before: rare(
          "tasks",
          "Council tax direct debit",
          `Due Fri 30 Oct · Priority 2 · Project: Flat\nCall Camden or do it online, ref ${ref}.`,
          at(10, 4, 18, 30),
        ),
        decoy: rare(
          "tasks",
          "TV licence direct debit",
          `✓ Completed 22 Oct · Project: Flat\nSet up: monthly £14.54 on the 15th. ` +
            c.tb.pick(["Licence number in the email.", "Old address cancelled."]),
          at(10, 22, 18, 30),
        ),
      };
    },
  },
  // overlap: topic-word · decoy: (c) condition met / item allows it · phrasing: plan · source: gmail (notification)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "eurotunnel-christmas-drive",
    build: (c) => {
      const pol = `P${c.r.token("0123456789", 9)}`;
      const add = c.r.pick([39, 45, 52]);
      const from = bot("Admiral", "renewals@admiral.com");
      const body = (abroad: string) =>
        `Policy ${pol} renewed on 1 Oct 2026.\nCover: comprehensive\n${abroad}\nNamed drivers: you only\n` +
        "Your documents are in your online account.";
      return {
        text: "Let's take the car over to France on the Eurotunnel at Christmas.",
        detail:
          "The renewed car insurance (from 1 Oct) does not include European cover; driving abroad needs it added " +
          `(£${add}) before the trip.`,
        hidden: notice(c, c.ta, {
          from,
          when: at(10, 1, 6, 0),
          title: "Your car insurance has renewed",
          body: body(`Driving in Europe: NOT included. You can add it in your online account for £${add}.`),
        }),
        decoy: notice(c, c.tb, {
          from,
          when: at(10, 1, 6, 0),
          title: "Your car insurance has renewed",
          body: body("Driving in Europe: included, up to 90 days per trip, same level of cover."),
        }),
      };
    },
  },
  // overlap: topic-word · decoy: (b) other entity or date · phrasing: question · source: calendar (event)
  //   · anchored: no · silent: no · rare: no · knowledge: yes · language: English
  {
    name: "post-off-passport-form",
    build: (c) => {
      const [p] = c.clients(1);
      const org = orgOf(p!);
      const ref = c.r.token("ABCDEFGHJKLMNPQRSTUVWXYZ", 6);
      return {
        text: "Should I post off my passport renewal this week?",
        detail:
          `The user travels by Eurostar to Amsterdam on Thursday 12 November (${org} offsite), which needs a ` +
          "passport; posting a renewal surrenders the old passport and takes about three weeks.",
        hidden: event({
          title: `Amsterdam: Eurostar to ${org} offsite`,
          start: at(11, 12, 7, 1),
          when: "Thu 12 Nov, 07:01 from St Pancras",
          where: "London St Pancras International",
          notes:
            `Booking ${ref}. Passport needed at check-in (UK/Schengen border). Return Fri 13 Nov 18:00. ` +
            c.ta.pick(["Arrive 60 min early.", "Gate closes 30 min before."]),
          edited: at(10, 16, 14, 0),
        }),
        decoy: event({
          title: `Edinburgh: LNER to ${org} offsite`,
          start: at(11, 12, 7, 0),
          when: "Thu 12 Nov, 07:00 from King's Cross",
          where: "London King's Cross",
          notes:
            `Booking ${ref}. E-ticket on the app, no ID needed. Return Fri 13 Nov 18:00. ` +
            c.tb.pick(["Coach C.", "Quiet coach."]),
          edited: at(10, 16, 14, 0),
        }),
      };
    },
  },
  // overlap: name · decoy: (c) condition met / item allows it · phrasing: imperative · source: notes (doc)
  //   · anchored: no · silent: yes · rare: yes · knowledge: yes · language: English
  {
    name: "golf-road-tax-renewal",
    build: (c) => {
      const reg = `${c.r.pick(["LK", "LD", "LR"])}${c.r.int(15, 19)} ${c.r.token("ABCDEFGHJKLMNPRSTUVWXYZ", 3)}`;
      const note = (mot: string) =>
        `VW Golf (${reg})\n${mot}\nService: due Jan\nInsurance: Admiral, renewed 1 Oct\nTyres 36 psi front`;
      return {
        text: "Renew the road tax on the Golf.",
        detail:
          "The Golf failed its MOT on 28 July (brake discs, tyre) and the old certificate ran out on 1 August with " +
          "no retest; a car cannot be taxed without a valid MOT.",
        hidden: rare(
          "notes",
          "Car",
          note("MOT: FAILED 28 Jul (front brake discs + nearside tyre). Old cert ran out 1 Aug. Not retested yet"),
          at(8, 2, 20, 0),
        ),
        before: rare("notes", "Car", note("MOT: booked 28 Jul, Kwik Fit Holloway Rd, 9am"), at(7, 10, 20, 0)),
        decoy: rare("notes", "Car", note("MOT: passed 14 Sep, valid to 13 Sep 2027 ✓"), at(9, 14, 20, 0)),
      };
    },
  },
  // ---------------------------------------------------------------- social
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: calendar (event)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "farewell-pints-end-of-week",
    build: (c) => {
      const [col] = c.colleagues(1);
      const partner = firstOf(c, ["Chris", "Ali", "Robin"]);
      const notes =
        `${partner} is in Leeds overnight, so you're on collection: club at 17:30, then swimming at the ` +
        "leisure centre 18:00-18:45. Kit bags by the door.";
      return {
        text: `I'll head to ${col!.first}'s leaving drinks after work on Friday.`,
        detail:
          `On Friday 30 October the user is on the children's collection (17:30) and swimming 18:00-18:45 because ` +
          `${partner} is away in Leeds overnight, so the drinks clash.`,
        hidden: event({
          title: "Kids: collection + swimming (you)",
          start: at(10, 30, 17, 30),
          when: "Fri 30 Oct, 17:30-19:00",
          where: "Oakfield Primary, then Kingsway leisure centre",
          notes,
          edited: at(10, 21, 20, 0),
        }),
        decoy: event({
          title: "Kids: collection + swimming (you)",
          start: at(11, 6, 17, 30),
          when: "Fri 6 Nov, 17:30-19:00",
          where: "Oakfield Primary, then Kingsway leisure centre",
          notes,
          edited: at(10, 21, 20, 0),
        }),
      };
    },
  },
  // overlap: name · decoy: (b) other entity or date · phrasing: plan · source: slack (chat)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "fudge-cake-for-colleague",
    build: (c) => {
      const [bday, other, poster, by] = c.colleagues(4);
      return {
        text: `I'll order a chocolate fudge cake for ${bday!.first}'s birthday on Thursday.`,
        detail:
          `${bday!.full} is coeliac: anything for them must be properly gluten-free (prepared separately); an ` +
          "ordinary chocolate fudge cake is out.",
        hidden: chat(
          c.ta,
          "team-social",
          [
            {
              who: poster!,
              text:
                `for anyone doing treats for ${bday!.first}'s birthday thurs: they're coeliac, so properly gluten ` +
                "free only please (sealed, separate knife). Bakery on Exmouth Market does a good one.",
              when: at(10, 26, 15, 20),
            },
          ],
          by!,
        ),
        decoy: chat(
          c.tb,
          "team-social",
          [
            {
              who: poster!,
              text:
                `for anyone doing treats for ${other!.first}'s birthday next month: they're vegan, so no dairy or ` +
                "eggs please. Bakery on Exmouth Market does a good one.",
              when: at(10, 26, 15, 20),
            },
          ],
          by!,
        ),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: question · source: calendar (event)
  //   · anchored: yes · silent: no · rare: no · knowledge: no · language: English
  {
    name: "old-classmates-dinner-20th",
    build: (c) => {
      const hotel = c.r.pick(["Mercure Grand", "Hotel du Vin", "Bristol Harbour Hotel"]);
      const notes =
        `Overnight at the ${hotel}; trains booked by the office. Attendance required for all directors. ` +
        "Evening meal with the board included.";
      return {
        text: "Should I say yes to the alumni dinner on the 20th?",
        detail:
          "Friday 20 November is the board strategy day in Bristol, 09:00-21:30 including the evening meal, with " +
          "an overnight stay; attendance is required, so the evening is taken.",
        hidden: event({
          title: "Board strategy day: Bristol",
          start: at(11, 20, 9),
          when: "Fri 20 Nov, 09:00-21:30",
          where: `${hotel}, Bristol`,
          notes,
          edited: at(10, 8, 12, 0),
        }),
        decoy: event({
          title: "Board strategy day: Bristol",
          start: at(11, 27, 9),
          when: "Fri 27 Nov, 09:00-21:30",
          where: `${hotel}, Bristol`,
          notes,
          edited: at(10, 8, 12, 0),
        }),
      };
    },
  },
  // overlap: none · decoy: (b) other entity or date · phrasing: plan · source: school (mail)
  //   · anchored: yes · silent: yes · rare: yes · knowledge: no · language: English
  {
    name: "fintech-mixer-tue-night",
    build: (c) => {
      const part = c.r.pick(["a speaking part", "a short solo", "a line in the play"]);
      const letter = (year: string, when: string, extra: string) =>
        `Dear ${year} parents and carers,\n\nThe ${year} winter concert ${when} at 18:00 in the main hall. ` +
        `${extra}Children should arrive at 17:30 in school uniform. Every child has ${part}, so please do come.\n\n` +
        `${year} team`;
      return {
        text: "Thinking of going to the fintech mixer next Tuesday evening.",
        detail:
          "Maya's Year 4 winter concert was moved to Tuesday 3 November at 18:00 (drop-off 17:30, every child has " +
          "a part); the school letter was changed in the app without a new notice.",
        hidden: rare(
          "school",
          "Year 4 winter concert",
          letter("Year 4", "will now take place on Tue 3 Nov", "(Moved from Thu 5 Nov because of hall works.) "),
          at(10, 23, 16, 0),
        ),
        before: rare("school", "Year 4 winter concert", letter("Year 4", "is on Thu 5 Nov", ""), at(10, 2, 16, 0)),
        decoy: rare("school", "Year 2 winter concert", letter("Year 2", "is on Tue 3 Nov", ""), at(10, 23, 16, 0)),
      };
    },
  },
  // overlap: name · decoy: (a) resolved/expired/superseded · phrasing: imperative · source: crm (deal)
  //   · anchored: no · silent: no · rare: no · knowledge: no · language: English
  {
    name: "emirates-box-invite",
    build: (c) => {
      const [p] = c.clients(1);
      const org = orgOf(p!);
      const amt = c.r.int(120, 480) * 1_000;
      const head =
        `Deal: ${org} — Renewal 2027\nAmount: $${amt.toLocaleString("en-US")}\nOwner: ${c.user.full}\n` +
        `Champion: ${p!.full}\n`;
      return {
        text: `Say yes to ${org}'s invite to the Emirates box on the 7th.`,
        detail:
          `${org} is running a formal RFP for the renewal until 30 November; Legal's note says no gifts or ` +
          `hospitality may be accepted from anyone at ${org} while it is open, so the invitation must be declined ` +
          "and declared.",
        hidden: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — Renewal 2027`,
          text:
            head +
            "Stage: RFP / Negotiation\nNote (Legal, 2026-10-21): procurement is running a formal RFP until 30 Nov. " +
            "Do not accept gifts or hospitality from anyone there while it is open; declare offers in the gifts " +
            "register.",
          updatedAt: at(10, 21, 11, 0),
        },
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${org} — Renewal 2027`,
          text:
            head +
            "Stage: Closed won (2026-10-02)\nNote (Legal): the RFP is closed, hospitality rules are back to normal " +
            "(register anything over £100).",
          updatedAt: at(10, 21, 11, 0),
        },
      };
    },
  },
];

/** Templates whose request names one person, thing or date the planted item words differently. */
export const DEV20A_ANCHORED: readonly string[] = [
  "hiring-panel-friday-pm",
  "outing-slip-on-the-weekend",
  "oma-sunday-with-kids",
  "dishoom-for-two-midweek",
  "thyroid-tablets-pickup",
  "berlin-offsite-yes-or-no",
  "molar-appointment-self-drive",
  "landlord-transfer-on-the-28th",
  "cph-thursday-departure-time",
  "settee-arriving-saturday",
  "early-diy-wednesday",
  "away-from-flat-thursday",
  "old-classmates-dinner-20th",
  "fintech-mixer-tue-night",
];
/** Templates whose planted item (both variants) sits in a rare source (RARE_SOURCES). */
export const DEV20A_RARE: readonly string[] = [
  "outing-slip-on-the-weekend",
  "dishoom-for-two-midweek",
  "thyroid-tablets-pickup",
  "sunbed-sessions-pre-wedding",
  "september-invoice-chaser",
  "gulf-expo-air-tickets",
  "cph-thursday-departure-time",
  "settee-arriving-saturday",
  "early-diy-wednesday",
  "debito-imposto-prefeitura",
  "golf-road-tax-renewal",
  "fintech-mixer-tue-night",
];
/** Templates whose fact is a silent edit at the source (their Spec has `before`). */
export const DEV20A_SILENT: readonly string[] = [
  "hiring-panel-friday-pm",
  "babcia-thursday-collection",
  "pension-up-to-fifteen",
  "erste-klasse-montag",
  "cph-thursday-departure-time",
  "early-diy-wednesday",
  "away-from-flat-thursday",
  "debito-imposto-prefeitura",
  "golf-road-tax-renewal",
  "fintech-mixer-tue-night",
];
/** Templates whose request is not in English (name the language in the template's comment). */
export const DEV20A_NON_ENGLISH: readonly string[] = [
  "babcia-thursday-collection",
  "oma-sunday-with-kids",
  "berlin-offsite-yes-or-no",
  "vuelta-jornada-completa",
  "declaration-pendant-les-fetes",
  "su-faturasi-odensin-mi",
  "erste-klasse-montag",
  "premier-inn-leeds-gasto",
  "atarashii-heya-terewaaku",
  "debito-imposto-prefeitura",
];
/** Templates whose request is a question (a subset of DEV20A_INDIRECT). */
export const DEV20A_QUESTION: readonly string[] = [
  "team-dinner-hawksmoor-card",
  "oma-sunday-with-kids",
  "berlin-offsite-yes-or-no",
  "pension-up-to-fifteen",
  "su-faturasi-odensin-mi",
  "premier-inn-leeds-gasto",
  "cph-thursday-departure-time",
  "away-from-flat-thursday",
  "post-off-passport-form",
  "old-classmates-dinner-20th",
];
/** Templates whose request is indirect or a question ("Should I…", "I need to…", "We should…", "Can we…?"). */
export const DEV20A_INDIRECT: readonly string[] = [
  "hiring-panel-friday-pm",
  "conference-talk-churn-figures",
  "outing-slip-on-the-weekend",
  "dad-joint-signatory-visit",
  "thyroid-tablets-pickup",
  "molar-appointment-self-drive",
  "sunbed-sessions-pre-wedding",
  "declaration-pendant-les-fetes",
  "landlord-transfer-on-the-28th",
  "boston-kickoff-departure",
  "settee-arriving-saturday",
  "early-diy-wednesday",
  "atarashii-heya-terewaaku",
  "highlands-rental-motor",
  "eurotunnel-christmas-drive",
  "farewell-pints-end-of-week",
  "fudge-cake-for-colleague",
  "fintech-mixer-tue-night",
  ...DEV20A_QUESTION,
];
/**
 * Templates whose fact connects to the request only through world knowledge (a drug and alcohol, asbestos
 * and a drill).
 */
export const DEV20A_KNOWLEDGE: readonly string[] = [
  "dad-joint-signatory-visit",
  "molar-appointment-self-drive",
  "sunbed-sessions-pre-wedding",
  "gulf-expo-air-tickets",
  "boston-kickoff-departure",
  "erste-klasse-montag",
  "post-off-passport-form",
  "golf-road-tax-renewal",
];
/** Templates whose request shares no word with the planted item (overlap: none). */
export const DEV20A_NO_OVERLAP: readonly string[] = [
  "hiring-panel-friday-pm",
  "outing-slip-on-the-weekend",
  "babcia-thursday-collection",
  "dad-joint-signatory-visit",
  "oma-sunday-with-kids",
  "dishoom-for-two-midweek",
  "thyroid-tablets-pickup",
  "berlin-offsite-yes-or-no",
  "molar-appointment-self-drive",
  "vuelta-jornada-completa",
  "sunbed-sessions-pre-wedding",
  "declaration-pendant-les-fetes",
  "landlord-transfer-on-the-28th",
  "su-faturasi-odensin-mi",
  "gulf-expo-air-tickets",
  "boston-kickoff-departure",
  "erste-klasse-montag",
  "premier-inn-leeds-gasto",
  "settee-arriving-saturday",
  "early-diy-wednesday",
  "atarashii-heya-terewaaku",
  "away-from-flat-thursday",
  "highlands-rental-motor",
  "debito-imposto-prefeitura",
  "farewell-pints-end-of-week",
  "old-classmates-dinner-20th",
  "fintech-mixer-tue-night",
];

/** Each silent-change template's `before` item, for a days harness (same RNG draws as the planting function). */
export function dev20aBefore(world: World, seed: number): { template: string; before: Plant }[] {
  return build(world, seed).flatMap(({ name, spec }) => (spec.before ? [{ template: name, before: spec.before }] : []));
}

/** Build every template's spec, in order, with the suite's own streams (no world change). */
function build(world: World, seed: number): { name: string; spec: Spec }[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 2001);
  const by = (rel: string) => world.people.filter((p) => p.relation === rel);
  const pools = { colleague: by("colleague"), client: by("client") };
  // Never run out: a pool too small for k distinct people repeats, and an empty one falls back to a stand-in.
  const draw = (pool: Person[], k: number, stand: Person): Person[] => {
    if (pool.length === 0) return Array.from({ length: k }, () => stand);
    const out = r.sample(pool, Math.min(k, pool.length));
    while (out.length < k) out.push(r.pick(pool));
    return out;
  };
  const standIn = (first: string, last: string, relation: Person["relation"], org?: string): Person => ({
    id: `p-${first}-${last}`.toLowerCase(),
    first,
    last,
    full: `${first} ${last}`,
    email: `${first}.${last}@${org ? `${org.toLowerCase().replace(/\W+/g, "")}.com` : "gmail.com"}`.toLowerCase(),
    relation,
    org,
    company: org,
  });
  const relationOf = (role: string): Person["relation"] =>
    role === "friend" || role === "best friend" ? "friend" : role === "mum" || role === "sister" ? "family" : "service";
  return TEMPLATES.map((t) => {
    const ta = r.fork();
    const tb = r.fork();
    const ctx: Ctx = {
      r,
      ta,
      tb,
      user: world.user,
      colleagues: (k) => draw(pools.colleague, k, standIn("Alex", "Morgan", "colleague", world.user.company)),
      clients: (k) => draw(pools.client, k, standIn("Jordan", "Blake", "client", "Globex")),
      role: (role, [first, last]) =>
        world.people.find((p) => p.role === role) ?? standIn(first, last, relationOf(role)),
    };
    return { name: t.name, spec: t.build(ctx) };
  });
}

/**
 * Plant one item per template (the real one for `hidden`, the decoy for `control`, nothing for `neutral`) and return
 * the tasks. The rare sources and their filler are added in every variant, so the three see the same connectors.
 */
export function plantDev20a(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  addRareSources(world, seed);
  const suite = variant === "hidden" ? "dev20a" : `dev20a-${variant}`;
  const tasks: HiddenTask[] = [];
  for (const { name, spec } of build(world, seed)) {
    if (variant !== "neutral") {
      const p = variant === "hidden" ? spec.hidden : spec.decoy;
      // The same ref in hidden and control, of the base world's shape (`<kind>-<index>`): a ref naming the template or
      // marking the item as planted would tell the agent.
      const ref = `${p.kind}-${world.items.length}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    tasks.push({ id: `w${seed}:${suite}:${name}`, template: name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}

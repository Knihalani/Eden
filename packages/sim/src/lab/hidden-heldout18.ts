/**
 * Held-out hidden-context suite 18: written blind for the askNudge confirmation (heldout18), by an author who saw
 * only the suite scaffold (helpers, types and the planting function), the training suites hidden-train1.ts and
 * hidden-train2.ts, the `HiddenTask` interface (hidden-context.ts lines 1-30) and the sim world API (world.ts,
 * names.ts, text.ts, rng.ts). No engine, ranking, reader, prompt, card or intent code, no other held-out or dev suite,
 * no docs and no replay cache were read, and no funnel, eval, agent or model was run. Measurement only: never tune on
 * it.
 *
 * 32 templates, four in each life area (work, family, health, money, travel, home, admin, social, in that order).
 * Each is a request the user types (an action that does not name the hidden context), the consideration a good answer
 * raises, a planted item stating it (variant `hidden`) and a near-miss look-alike that does not apply (`control`);
 * `neutral` plants nothing. Request and detail are the same in every variant.
 *
 * Counts (from the comment above each template):
 * Word overlap between request and planted item: 10 none, 11 a name only, 11 one topic word.
 * Decoys: 11 resolved/expired/superseded (a), 11 another entity or date of the same kind (b), 10 condition met or the
 * item allows the request (c).
 *
 * HELDOUT18_LATE: eight templates, one per area, whose fact reads as arriving later the same day; their items (both
 * variants) are dated 27 October 2026 between 08:00 and 08:59 UTC. HELDOUT18_ANCHORED: thirteen short requests (12
 * words or fewer) naming one person, thing or date that the planted item refers to the way real messages do (first
 * name, surname, role, card or order reference, numeric date) rather than echoing the request.
 *
 * Weekdays checked against the 2026 calendar (Date.UTC): Tue 27 Oct, Wed 28 Oct, Thu 29 Oct, Fri 30 Oct, Sat 31 Oct,
 * Mon 2 Nov, Tue 3 Nov, Thu 5 Nov, Fri 6 Nov, Sat 7 Nov, Sun 8 Nov, Mon 9 Nov, Tue 10 Nov, Thu 12 Nov, Fri 13 Nov,
 * Sun 15 Nov, Mon 16 Nov, Tue 17 Nov, Wed 18 Nov, Thu 19 Nov, Fri 20 Nov, Sun 22 Nov, Mon 23 Nov, Wed 25 Nov,
 * Fri 27 Nov, Mon 30 Nov, Thu 3 Dec, Fri 4 Dec, Mon 7 Dec, Fri 11 Dec, Sat 12 Dec, Thu 24 Dec, Sun 27 Dec,
 * Tue 22 Sep, Thu 8 Oct, Mon 12 Oct, Thu 22 Oct, Mon 26 Oct, and Mon 15 Mar 2027.
 */
import { itemId } from "@eden/protocol";
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
const HOME = "Flat 2, 9 Ferncroft Road, Ashdown AS3 2LP";

const TEMPLATES: { name: string; build: (c: Ctx) => Spec }[] = [
  // ── work ──
  // Overlap: none (the client is named by surname and company, the deck is "commercial material"). Decoy (b): the
  // same rule from another client's company. Late: posted this morning.
  {
    name: "pricing-deck-via-supplier-portal",
    build: (c) => {
      const cl = c.clients(1)[0]!;
      const other = otherClient(c, cl);
      const [poster, asker, bystander] = c.colleagues(3);
      const post = (t: Rng, org: string, last: string) =>
        chat(
          t,
          "deals",
          [
            {
              who: poster!,
              text:
                `heads up from ${org}'s legal team this morning: from today nothing commercial goes direct to ` +
                `${last}'s team by email. rate cards, proposals, the lot`,
              when: at(10, 27, 8, 41),
            },
            {
              who: poster!,
              text: "it all has to be uploaded to their supplier portal (Coupa) so procurement sees it first. emailed attachments count as a breach of the NDA",
              when: at(10, 27, 8, 43),
            },
            { who: asker!, text: "even drafts?", when: at(10, 27, 8, 50) },
            { who: poster!, text: "even drafts. everything", when: at(10, 27, 8, 52) },
          ],
          bystander!,
        );
      return {
        text: `Send ${cl.nick ?? cl.first} the updated pricing deck.`,
        detail:
          `${poster!.full} posted in Slack (#deals) on 27 October 2026 that ${orgOf(cl)} now requires every ` +
          `commercial document for ${cl.full}'s team to go through its supplier portal (Coupa), not by email, so ` +
          "the deck should be uploaded there rather than sent to them directly.",
        hidden: post(c.ta, orgOf(cl), cl.last),
        decoy: post(c.tb, orgOf(other), other.last),
      };
    },
  },
  // Overlap: none (retro vs company offsite, the date as 06/11). Decoy (a): the offsite was cancelled.
  {
    name: "retro-vs-company-offsite",
    build: () => {
      const offsite = (title: string, notes: string, edited: number) =>
        event({
          title,
          start: at(11, 6, 9, 0),
          when: "Fri 06/11, 09:00–17:30",
          where: "Hever Barns, Kent",
          notes,
          edited,
        });
      return {
        text: "Book a 30-minute team retro for Friday 6 November at 2pm.",
        detail:
          "Northwind's all-day company offsite at Hever Barns, Kent is on Friday 6 November 2026 (09:00–17:30, " +
          "coaches back around 19:00; calendar), so the team is away for a 2pm retro that day.",
        hidden: offsite(
          "Northwind company offsite (all day)",
          "Whole company. Coaches leave HQ at 08:15 and are back around 19:00. Please keep the day clear of other " +
            "meetings.",
          at(9, 30, 11, 5),
        ),
        decoy: offsite(
          "Cancelled: Northwind company offsite",
          "This event was cancelled by the organiser. The offsite moves to the spring; a new date will follow.",
          at(10, 19, 16, 40),
        ),
      };
    },
  },
  // Overlap: one topic word ("leave"; the colleague is named by surname on a rota). Decoy (c): they were moved off the
  // rota and their time off is already agreed.
  {
    name: "leave-during-cutover-week",
    build: (c) => {
      const [col, lead] = c.colleagues(2);
      const plan = (rota: string) =>
        doc(
          "Billing platform cutover – plan v4",
          "Cutover window: Mon 16 Nov – Fri 20 Nov 2026\nChange freeze from Fri 13 Nov, 18:00.\n\n" +
            `${rota}\n\nRollback: decision by ${lead!.last} by 14:00 on the Tuesday if reconciliation is more than ` +
            "0.5% out. Comms to customers go out from the support team, not from individual account owners.",
          at(10, 20, 17, 25),
        );
      return {
        text: `Approve ${col!.nick ?? col!.first}'s annual leave request for 16 to 20 November.`,
        detail:
          `The billing cutover plan in Drive (edited 20 October 2026) puts ${col!.full} on the cutover rota for ` +
          `Monday 16 to Friday 20 November 2026, a week with no leave for anyone on the rota unless ${lead!.full} ` +
          "agrees cover.",
        hidden: plan(
          `Cutover rota (agreed with the COO): ${lead!.last} (lead), ${col!.last}, Ferreira, Obi.\n` +
            `No leave for anyone on the rota during the cutover week; cover has to be agreed with ${lead!.last} first.`,
        ),
        decoy: plan(
          `Cutover rota (agreed with the COO): ${lead!.last} (lead), Ferreira, Obi.\n` +
            `${col!.last}: moved off the rota on 19 Oct; leave that week signed off, Obi covering.`,
        ),
      };
    },
  },
  // Overlap: a name only (the client's company). Decoy (b): another client changed its PO.
  {
    name: "invoice-needs-new-po",
    build: (c) => {
      const cl = c.clients(1)[0]!;
      const other = otherClient(c, cl);
      const note = (t: Rng, from: Person, po: string, old: string) =>
        mail(c, t, {
          from,
          when: at(10, 20, 11, 50),
          title: "New PO for FY27",
          corporate: true,
          body: [
            `Quick admin note from our side: ${orgOf(from)}'s new financial year started on 1 October, and every ` +
              `invoice dated from then on has to quote our new purchase order, ${po}.`,
            `Anything that still carries the old PO (${old}) is rejected automatically by our AP system, and it ` +
              "can take a month to get it back into the queue.",
            "Could you pass this on to whoever raises your invoices?",
          ],
        });
      return {
        text: `Bill ${orgOf(cl)} for October's consulting days today.`,
        detail:
          `${cl.full} emailed on 20 October 2026 that from 1 October 2026 ${orgOf(cl)} invoices must quote the new ` +
          "purchase order 4500-118203; invoices with the old PO 4500-097441 are rejected by their accounts payable.",
        hidden: note(c.ta, cl, "4500-118203", "4500-097441"),
        decoy: note(c.tb, other, "4500-220957", "4500-186310"),
      };
    },
  },

  // ── family ──
  // Overlap: a name only ("Mum"). Decoy (a): Mum's wish for lunch at home was dropped.
  {
    name: "mum-seventieth-at-home",
    build: (c) => {
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: ellie, when: at(10, 24, 19, 12), title: "Mum's 70th", body });
      return {
        text: "Book a table for six at Padella for Mum's birthday, Sunday 15 November.",
        detail:
          `${ellie.first} emailed on 24 October 2026 that Mum wants her 70th on Sunday 15 November 2026 as lunch at ` +
          `her house, not a restaurant, and ${ellie.first} has already ordered the cake, so nothing should be booked.`,
        hidden: note(c.ta, [
          "Had a long chat with Mum about her 70th on Sunday 15th.",
          "She doesn't want a fuss or a restaurant, she wants everyone at hers for lunch, and I've already ordered " +
            "the cake from Bettina's.",
          "So please don't book anywhere! Can you bring a pudding instead?",
        ]),
        decoy: note(c.tb, [
          "Had a long chat with Mum about her 70th on Sunday 15th.",
          "Last week she said she'd rather just do lunch at hers, but she's come round to going out after all, she " +
            "quite fancies Italian.",
          "So go ahead and book somewhere for all of us!",
        ]),
      };
    },
  },
  // Overlap: none (the notice names the class, not the child or the school run). Decoy (b): another year group's
  // trip. Late: sent this morning.
  {
    name: "class-trip-early-coach",
    build: (c) => {
      const teacher = c.role("Maya's teacher", ["Mrs", "Daley"]);
      const office = bot("Ashgrove Primary", "office@ashgrove-primary.org.uk");
      return {
        text: "Plan tomorrow's school run so Maya's at the gate for 8:40.",
        detail:
          "Ashgrove Primary's notice of 27 October 2026 says the Year 4 trip coach on Wednesday 28 October 2026 now " +
          `leaves at 08:15, so Maya (Year 4, ${teacher.full}'s class) must be in class by 08:00, not arriving at 8:40.`,
        hidden: notice(c, c.ta, {
          from: office,
          when: at(10, 27, 8, 12),
          title: "Year 4 trip tomorrow: earlier start",
          body:
            `Year 4 (${teacher.full}'s class): Science Museum trip, Wednesday 28 October\n\nThe coach company has ` +
            "brought our departure forward to 08:15 because of roadworks on the A3. Children in Year 4 need to be in " +
            "class by 08:00 tomorrow; anyone arriving after 08:15 cannot join the trip. Packed lunch and a " +
            "waterproof, please.\n\nAll other year groups: normal start.",
        }),
        decoy: notice(c, c.tb, {
          from: office,
          when: at(10, 27, 8, 12),
          title: "Year 6 trip tomorrow: earlier start",
          body:
            "Year 6 (Mr Okoro's class): Natural History Museum trip, Wednesday 28 October\n\nThe coach company has " +
            "brought our departure forward to 08:15 because of roadworks on the A3. Children in Year 6 need to be in " +
            "class by 08:00 tomorrow.\n\nAll other year groups, including Year 4: normal start at 08:40.",
        }),
      };
    },
  },
  // Overlap: a name only ("Maya"; the sister is "your sister"). Decoy (a): the weekend away was cancelled.
  {
    name: "sister-away-sleepover",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const ellie = c.role("sister", ["Ellie", "Carter"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: mum, when: at(10, 23, 18, 5), title: "the weekend", body });
      return {
        text: `Ask ${ellie.first} if Maya can sleep over at hers on Saturday.`,
        detail:
          `Mum emailed on 23 October 2026 that ${ellie.first} is away in Lisbon from Friday 30 October to Monday ` +
          `2 November 2026, so she can't have Maya on Saturday 31 October 2026; Mum offered to have Maya instead.`,
        hidden: note(c.ta, [
          "Just so you know, your sister and Dan are off to Lisbon from Friday to Monday for their anniversary, so " +
            "don't go asking her for favours this weekend.",
          "If you need Maya minded, I'm around, she can stay with me.",
          "Dad says the roof man finally came.",
        ]),
        decoy: note(c.tb, [
          "Your sister was meant to be off to Lisbon this weekend for their anniversary, but Dan's work cancelled " +
            "it, so they're home after all.",
          "Dad says the roof man finally came.",
        ]),
      };
    },
  },
  // Overlap: one topic word ("Christmas"). Decoy (c): the plan has the user hosting and buying the turkey.
  {
    name: "christmas-hosted-in-york",
    build: () => {
      const plan = (body: string) =>
        doc(
          "Carter Christmas 2026 – who's doing what",
          `Dates: Thu 24 Dec – Sun 27 Dec\nHeadcount: 12\n\n${body}\nEllie & Dan: pudding, Christmas Eve dinner\n` +
            "Mum: bringing the stockings\n\nSecret Santa: £20 limit, names drawn on the family chat.",
          at(10, 22, 20, 40),
        );
      return {
        text: "Order the Christmas turkey from Hollins Butchers for 12 people, collection 24 December.",
        detail:
          "The shared 'Carter Christmas 2026' plan in Drive (edited 22 October 2026) has Christmas at Dan's " +
          "parents' in York, Thursday 24 to Sunday 27 December 2026, with all the food (the bird included) already " +
          "ordered by them; Robin and Alex are down for wine, crackers and cheese, not a turkey.",
        hidden: plan(
          "Where: Pat & Geoff's, 4 Minster View, York (Dan's parents offered, Mum agreed)\n" +
            "Food: Pat & Geoff have ordered everything from their farm shop, the bird included. Please don't buy " +
            "any meat!\nRobin & Alex: wine, crackers, cheeseboard",
        ),
        decoy: plan(
          "Where: Robin & Alex's\nFood: Robin & Alex: turkey and the trimmings (order from the butcher's)\n" +
            "Pat & Geoff: wine, crackers, cheeseboard",
        ),
      };
    },
  },

  // ── health ──
  // Overlap: none ("10k" vs "running"). Decoy (c): the physio has cleared the user to run.
  {
    name: "ten-k-after-ankle",
    build: (c) => {
      const base = c.role("physio", ["Hannah", "Doyle"]);
      const physio: Who = { ...base, title: "Physiotherapist", company: "Moveright Physio" };
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: physio, when: at(10, 20, 17, 30), title: "After today's session", body, corporate: true });
      return {
        text: "Sign me up for the Richmond Park 10k on Sunday 22 November.",
        detail:
          `The physio (${base.full} at Moveright Physio) emailed on 20 October 2026 after the ankle assessment: no ` +
          "running for six weeks, nothing before 1 December 2026, which rules out a 10k on Sunday 22 November 2026.",
        hidden: note(c.ta, [
          "Thanks for coming in today.",
          "The ankle is healing, but the ligament isn't ready for impact yet: no running at all for the next six " +
            "weeks, so nothing before 1 December.",
          "Cycling and swimming are fine, and keep up the band exercises twice a day.",
          "I'll see you again on 17 November.",
        ]),
        decoy: note(c.tb, [
          "Thanks for coming in today.",
          "Good news: the ankle has healed well and you're cleared to run again.",
          "Build up over the next few weeks; a 10k towards the end of November is absolutely fine as long as you " +
            "keep up the band exercises.",
        ]),
      };
    },
  },
  // Overlap: a name only ("Westbury"). Decoy (c): the pre-authorisation and GP referral are already in place.
  {
    name: "dermatology-needs-preauth",
    build: (c) => {
      const westbury = bot("Westbury Health", "members@westburyhealth.co.uk");
      return {
        text: "Book me in with a dermatologist at the Lister clinic through Westbury Health.",
        detail:
          "Westbury Health wrote on 8 October 2026 that from 1 October 2026 every outpatient consultation needs a GP " +
          "referral and a Westbury pre-authorisation number before the appointment, or it will not be paid.",
        hidden: notice(c, c.ta, {
          from: westbury,
          when: at(10, 8, 10, 0),
          title: "Changes to how you claim for outpatient care",
          body:
            "Membership: WH-6620418\n\nFrom 1 October 2026, every outpatient consultation needs two things before " +
            "the appointment takes place: an open GP referral letter and a pre-authorisation number from us. Call " +
            "0345 019 2210 or use the Westbury app to get one. Consultations booked without a pre-authorisation " +
            "number will not be paid.",
        }),
        decoy: notice(c, c.tb, {
          from: westbury,
          when: at(10, 22, 14, 20),
          title: "Your pre-authorisation is confirmed",
          body:
            "Membership: WH-6620418\n\nPre-authorisation: PA-77310\nSpecialty: Dermatology (outpatient " +
            "consultation)\nGP referral: received from Lakeside Surgery, 19 October 2026\n\nYou can now book with " +
            "any recognised consultant on our list. Quote PA-77310 when booking.",
        }),
      };
    },
  },
  // Overlap: one topic word ("repeat prescription"). Decoy (b): Mum's prescription is the one on hold. Late: the
  // surgery's answer came this morning.
  {
    name: "repeat-prescription-on-hold",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const nhs = bot("NHS App", "noreply@notifications.nhsapp.service.gov.uk");
      const held = (who: string, drug: string, after: string) =>
        `${who}Lakeside Surgery has reviewed the repeat prescription request for:\n\n${drug} (28)\n\nStatus: On ` +
        "hold\nReason: a medication review is due. Please book a medication review with a GP or the practice " +
        "pharmacist. The prescription will not be sent to the nominated pharmacy until the review has taken " +
        `place.${after}`;
      return {
        text: "Pick up my repeat prescription from Boots after work today.",
        detail:
          "An NHS App message at 08:40 on 27 October 2026 says Lakeside Surgery has put the repeat prescription for " +
          "sertraline 50mg on hold until a medication review is booked, so nothing has gone to the pharmacy to " +
          "collect today.",
        hidden: notice(c, c.ta, {
          from: nhs,
          when: at(10, 27, 8, 40),
          title: "Update on your prescription request",
          body: held("", "Sertraline 50mg tablets", ""),
        }),
        decoy: notice(c, c.tb, {
          from: nhs,
          when: at(10, 27, 8, 40),
          title: "Update on a prescription request",
          body: held(
            `You are acting on behalf of ${mum.full}.\n\n`,
            "Amlodipine 5mg tablets",
            "\n\nRequests on your own account are not affected.",
          ),
        }),
      };
    },
  },
  // Overlap: none (the dentist is "Ngozi"-style first name, the bill is "invoice"). Decoy (a): an earlier hold on the
  // invoice has been lifted.
  {
    name: "crown-invoice-cancelled",
    build: (c) => {
      const dentist = c.role("dentist", ["Ngozi", "Okafor"]);
      const manager: Who = {
        ...bot("Carla Mendes", "carla@elmbridgesmile.co.uk"),
        title: "Practice Manager",
        company: "Elmbridge Smile Studio",
      };
      const note = (t: Rng, title: string, body: string[]) =>
        mail(c, t, { from: manager, when: at(10, 23, 12, 15), title, body, corporate: true });
      return {
        text: `Pay Dr ${dentist.last}'s dental bill today.`,
        detail:
          "Elmbridge Smile Studio emailed on 23 October 2026 that the £640 crown invoice EB-20931 (sent 14 October " +
          "2026) has been cancelled because the lab is remaking the crown; a new invoice follows the fitting on " +
          "Thursday 19 November 2026, so there is nothing to pay now.",
        hidden: note(c.ta, "Your crown – please ignore our invoice", [
          `${dentist.first} has asked me to let you know that the lab made your crown in the wrong shade, so it's ` +
            "being remade at no cost to you.",
          "Please ignore the invoice we sent on 14 October (EB-20931, £640): it has been cancelled.",
          "We'll issue a new one after the fitting on Thursday 19 November at 10:30.",
        ]),
        decoy: note(c.tb, "Your crown – invoice EB-20931", [
          `Last week I asked you to hold off paying EB-20931 while ${dentist.first} checked the shade with the lab.`,
          "The crown has been checked and is a perfect match, so the invoice (£640, sent 14 October) is due as " +
            "normal.",
          "Your fitting is on Thursday 19 November at 10:30.",
        ]),
      };
    },
  },

  // ── money ──
  // Overlap: one topic word ("account"). Decoy (b): only contractor payments are late. Late: posted this morning.
  {
    name: "transfer-before-late-payroll",
    build: (c) => {
      const [fin, asker, bystander] = c.colleagues(3);
      const post = (t: Rng, first: string, second: string, question: string, answer: string) =>
        chat(
          t,
          "announcements",
          [
            { who: fin!, text: first, when: at(10, 27, 8, 31) },
            { who: fin!, text: second, when: at(10, 27, 8, 32) },
            { who: asker!, text: question, when: at(10, 27, 8, 44) },
            { who: fin!, text: answer, when: at(10, 27, 8, 47) },
          ],
          bystander!,
        );
      return {
        text: "Move £1,500 from my current account into savings this morning.",
        detail:
          `${fin!.full} posted in Slack (#announcements) on the morning of 27 October 2026 that October salaries ` +
          "will not arrive today but on Thursday 29 October 2026 (the bank rejected the payroll file), so the " +
          "current account may not hold enough for a £1,500 transfer today.",
        hidden: post(
          c.ta,
          "Payroll update: October salaries won't reach accounts today as planned. The bank rejected our payment file overnight and it's been resubmitted for Thursday 29 October.",
          "Really sorry everyone. If this causes anyone a problem with a bill or an overdraft, message me and we can arrange an advance.",
          "so Thursday for sure?",
          "Thursday, confirmed with the bank",
        ),
        decoy: post(
          c.tb,
          "Payroll update: October salaries have gone out as normal and should be in accounts today.",
          "The only delay is contractor invoices: those will be paid on Thursday 29 October instead of today.",
          "staff all fine then?",
          "yes, staff pay is all through",
        ),
      };
    },
  },
  // Overlap: a name only (the landlord, in the From line; "rent" is "the monthly amount"). Decoy (a): the rise was
  // withdrawn.
  {
    name: "rent-rise-from-november",
    build: (c) => {
      const steve = c.role("landlord", ["Steve", "Hargreaves"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: steve, when: at(10, 2, 18, 20), title: "Flat 2 from November", body });
      return {
        text: `Set up the November rent payment to ${steve.first}, £1,350 as usual.`,
        detail:
          `The landlord, ${steve.first}, emailed on 2 October 2026 that the rent rises to £1,425 a month from ` +
          "1 November 2026, so a £1,350 payment would be £75 short.",
        hidden: note(c.ta, [
          "Following the notice I sent over in August, just a reminder that from 1 November the monthly amount for " +
            "the flat goes up to £1,425.",
          "Could you update your standing order before then? Same account as always.",
          "I'll pop round to check the smoke alarms in December.",
        ]),
        decoy: note(c.tb, [
          "I know I said in August that it'd go up in November, but I've thought about it and I'm keeping it at " +
            "£1,350 for another year.",
          "You've been great tenants, so no need to change anything.",
          "I'll pop round to check the smoke alarms in December.",
        ]),
      };
    },
  },
  // Overlap: one topic word ("minimum"; the card is "account ending 4402"). Decoy (b): the 0% offer that ends is a
  // year later.
  {
    name: "card-zero-percent-ending",
    build: (c) => {
      const lumen = bot("Lumen", "statements@lumen-money.co.uk");
      const statement = (t: Rng, important: string) =>
        notice(c, t, {
          from: lumen,
          when: at(10, 16, 6, 30),
          title: "Your October statement is ready",
          body:
            "Account ending 4402\nStatement date: 16 October 2026\nBalance: £2,140.37\nMinimum payment: £25.00, due " +
            `10 November 2026\n\nImportant: ${important}`,
        });
      return {
        text: "Just pay the minimum on my credit card this month.",
        detail:
          "Lumen's October statement (16 October 2026) says the 0% promotional rate on purchases ends on 3 November " +
          "2026 and the remaining £2,140.37 is charged at 24.9% APR from 4 November 2026, so paying only the minimum " +
          "will start costing interest.",
        hidden: statement(
          c.ta,
          "your 0% promotional rate on purchases ends on 3 November 2026. From 4 November 2026, any balance " +
            "remaining is charged at our standard rate of 24.9% APR. Paying only the minimum will mean you pay " +
            "interest.",
        ),
        decoy: statement(
          c.tb,
          "your 0% promotional rate on purchases ends on 3 November 2027. Until then no interest is charged on " +
            "purchases, as long as you make at least the minimum payment each month.",
        ),
      };
    },
  },
  // Overlap: none (the friend is "L HADDAD"-style initial and surname, the tickets are "gig tix"). Decoy (c): the
  // friend's payment request is still open.
  {
    name: "gig-tickets-already-repaid",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      const app = bot("Brookline", "hello@brookline.money");
      const payee = `${leila.first[0]} ${leila.last.toUpperCase()}`;
      return {
        text: `Pay ${leila.first} back for the concert tickets.`,
        detail:
          `A Brookline payment notification of 12 October 2026 shows £86.00 already sent to ${payee} ` +
          `(${leila.first}) with the reference 'gig tix x2', so the concert tickets have been paid back.`,
        hidden: notice(c, c.ta, {
          from: app,
          when: at(10, 12, 21, 4),
          title: `You sent £86.00 to ${payee}`,
          body:
            `You sent £86.00 to ${payee}\nReference: gig tix x2\nFrom: Personal account ending 7731\nWhen: Monday ` +
            "12 October 2026, 21:04\n\nIt should arrive within a few seconds.",
        }),
        decoy: notice(c, c.tb, {
          from: app,
          when: at(10, 12, 21, 4),
          title: `${payee} requested £86.00`,
          body:
            `${payee} has requested £86.00 from you\nReference: gig tix x2\nRequested: Monday 12 October 2026, ` +
            "21:04\n\nTap to pay in the app. Requests expire after 30 days.",
        }),
      };
    },
  },

  // ── travel ──
  // Overlap: a name only ("Heathrow"). Decoy (c): a ten-minute retime the 7:30 cab still covers. Late: the airline's
  // mail came this morning.
  {
    name: "airport-cab-flight-retimed",
    build: (c) => {
      const airline = bot("Albion Airways", "bookings@albionairways.com");
      const change = (t: Rng, times: string, after: string) =>
        notice(c, t, {
          from: airline,
          when: at(10, 27, 8, 22),
          title: "Important: a change to your flight",
          body:
            "Booking reference: QX7R2M\n\nWe've had to change the time of your flight.\n\nAW472 London Heathrow " +
            `(T5) → Madrid\nFriday 30 October 2026\n${times}\n\n${after}`,
        });
      return {
        text: "Book me a cab to Heathrow for 7:30 on Friday morning.",
        detail:
          "Albion Airways emailed at 08:22 on 27 October 2026 that flight AW472 to Madrid on Friday 30 October 2026 " +
          "now leaves Heathrow at 07:40 instead of 10:15, so a 7:30 cab would miss it.",
        hidden: change(
          c.ta,
          "New departure: 07:40 (was 10:15)\nNew arrival: 11:05",
          "Check-in and bag drop close 60 minutes before departure. If the new time doesn't work for you, you can " +
            "move to another flight on the same day or ask for a refund in Manage My Booking.",
        ),
        decoy: change(
          c.tb,
          "New departure: 10:25 (was 10:15)\nNew arrival: 13:50",
          "This is a minor change and you don't need to do anything.",
        ),
      };
    },
  },
  // Overlap: one topic word ("flights"). Decoy (c): the authorisation is approved to 2028.
  {
    name: "boston-trip-esta-expiring",
    build: (c) => {
      const cbp = bot("ESTA U.S. Customs and Border Protection", "esta-noreply@cbp.dhs.gov");
      const head = "Application number: J4K8M2Q7X1P9Z3\nApplicant: CARTER, ROBIN\n\n";
      return {
        text: "Book my flights to Boston for the conference, 7 to 11 December.",
        detail:
          "A U.S. Customs and Border Protection email of 2 October 2026 says the user's ESTA expires on 19 November " +
          "2026, before the 7–11 December 2026 Boston trip, so a new ESTA is needed before flying.",
        hidden: notice(c, c.ta, {
          from: cbp,
          when: at(10, 2, 13, 0),
          title: "Your ESTA travel authorisation will expire soon",
          body:
            head +
            "Your travel authorisation under the Visa Waiver Program expires on 19 November 2026. After that date " +
            "you will need a new approved ESTA before you board flights to the United States. Apply at least 72 " +
            "hours before travel.",
        }),
        decoy: notice(c, c.tb, {
          from: cbp,
          when: at(10, 2, 13, 0),
          title: "Your ESTA application has been approved",
          body:
            head +
            "Status: AUTHORIZATION APPROVED\nValid until: 2 September 2028, or until your passport expires, " +
            "whichever comes first.\n\nYou may travel to the United States under the Visa Waiver Program for up to " +
            "90 days per visit.",
        }),
      };
    },
  },
  // Overlap: none (the train is "the 07:01 from St Pancras", the date 03/12). Decoy (b): the same train booked for a
  // colleague.
  {
    name: "paris-train-already-booked",
    build: (c) => {
      const [ops, mate, bystander] = c.colleagues(3);
      const post = (t: Rng, who: Person, reply: string) =>
        chat(
          t,
          "partnerships-team",
          [
            {
              who: ops!,
              text: `@${who.first} sorted your travel for the Rive Gauche workshop: 07:01 from St Pancras on 03/12, back on the 19:12 on 04/12, Standard Premier`,
              when: at(10, 22, 15, 10),
            },
            {
              who: ops!,
              text: "e-tickets are in your inbox, it went on the team card so no need to expense it",
              when: at(10, 22, 15, 11),
            },
            { who, text: reply, when: at(10, 22, 15, 26) },
          ],
          bystander!,
        );
      return {
        text: "Book me a Eurostar to Paris for Thursday 3 December.",
        detail:
          `${ops!.full} said in Slack on 22 October 2026 that they already booked the user's 07:01 train from St ` +
          "Pancras on Thursday 3 December 2026 (back on the 19:12 on 4 December 2026) for the Rive Gauche " +
          "workshop, so booking again would duplicate it.",
        hidden: post(c.ta, c.user, "amazing, thank you"),
        decoy: post(c.tb, mate!, "legend, thanks"),
      };
    },
  },
  // Overlap: a name only ("Manchester"). Decoy (a): the strike was called off.
  {
    name: "manchester-strike-day",
    build: (c) => {
      const rail = bot("Northline Trains", "travel-updates@northlinetrains.co.uk");
      return {
        text: "Book me a return to Manchester for Monday 9 November.",
        detail:
          "Northline Trains emailed on 23 October 2026 that no trains will run between London Euston and Manchester " +
          "Piccadilly on Monday 9 November 2026 because of strike action.",
        hidden: notice(c, c.ta, {
          from: rail,
          when: at(10, 23, 16, 0),
          title: "Strike action: Monday 9 November",
          body:
            "Due to strike action by the RMT, we will run no trains at all on Monday 9 November 2026 between London " +
            "Euston, Birmingham New Street and Manchester Piccadilly. Tickets for that day can be refunded with no " +
            "fee or used on Sunday 8 or Tuesday 10 November instead. Please do not travel.",
        }),
        decoy: notice(c, c.tb, {
          from: rail,
          when: at(10, 26, 12, 30),
          title: "Strike called off: Monday 9 November",
          body:
            "The RMT has called off the strike planned for Monday 9 November 2026. A full timetable will run between " +
            "London Euston, Birmingham New Street and Manchester Piccadilly, and tickets for that day are valid as " +
            "normal.",
        }),
      };
    },
  },

  // ── home ──
  // Overlap: none (installation vs water supply). Decoy (b): the burst main is on another street. Late: sent this
  // morning.
  {
    name: "washer-install-water-off",
    build: (c) => {
      const water = bot("Ashdown Water", "incidents@ashdownwater.co.uk");
      const outage = (t: Rng, street: string, after: string) =>
        notice(c, t, {
          from: water,
          when: at(10, 27, 8, 15),
          title: "Emergency repair in your area today",
          body:
            `We're carrying out an emergency repair to a burst main on ${street}.\n\nSupply will be off from 12:00 ` +
            `to 17:00 today, Tuesday 27 October. ${after}`,
        });
      return {
        text: "Confirm the 2pm washing machine installation for today with Currys.",
        detail:
          "Ashdown Water emailed at 08:15 on 27 October 2026 that the water supply on Ferncroft Road (the user's " +
          "street) is off from 12:00 to 17:00 today for an emergency repair, so the washing machine can't be " +
          "connected and tested at 2pm.",
        hidden: outage(
          c.ta,
          "Ferncroft Road, Ashdown AS3",
          "When it comes back the water may look cloudy for a short while; run the cold tap until it clears.",
        ),
        decoy: outage(
          c.tb,
          "Calloway Street, Ashdown AS4",
          "Only Calloway Street and Mill Lane are affected; Ferncroft Road and the streets around it are not.",
        ),
      };
    },
  },
  // Overlap: one topic word ("recycling"). Decoy (a): the change of day was postponed.
  {
    name: "recycling-day-moving",
    build: (c) => {
      const council = bot("Ashdown District Council", "waste@ashdown.gov.uk");
      return {
        text: "Set a weekly reminder for Wednesday nights to put the recycling out.",
        detail:
          "Ashdown District Council wrote on 12 October 2026 that from Monday 2 November 2026 recycling at Ferncroft " +
          "Road is collected on Tuesdays instead of Thursdays, so a Wednesday-night reminder would come a day late.",
        hidden: notice(c, c.ta, {
          from: council,
          when: at(10, 12, 10, 0),
          title: "Your bin collection days are changing",
          body:
            `Address: ${HOME}\n\nFrom Monday 2 November 2026 your collection days change:\nRecycling (blue lid): ` +
            "Tuesdays, fortnightly (was Thursdays)\nGeneral waste (black lid): Tuesdays, fortnightly (was " +
            "Thursdays)\nFood waste: every Tuesday\n\nPlease have your containers out by 7am on collection day.",
        }),
        decoy: notice(c, c.tb, {
          from: council,
          when: at(10, 20, 10, 0),
          title: "Update: your collection days are not changing",
          body:
            `Address: ${HOME}\n\nWe wrote recently about new collection days from 2 November. Following feedback, ` +
            "the change has been postponed indefinitely. Your recycling and general waste will still be collected " +
            "on Thursdays.",
        }),
      };
    },
  },
  // Overlap: a name only ("Loftworks"; the armchair is "Halden accent chair, slate", order LW-48812). Decoy (c): a
  // later delivery whose window is still open.
  {
    name: "armchair-return-window",
    build: (c) => {
      const shop = bot("Loftworks", "orders@loftworks.co.uk");
      const delivered = (t: Rng, when: number, day: string, by: string) =>
        notice(c, t, {
          from: shop,
          when,
          title: "Delivered: order LW-48812",
          body:
            `Order LW-48812\nItem: Halden accent chair, slate bouclé\nDelivered: ${day}\n\nChanged your mind? You ` +
            `can send unused items back within 30 days of delivery, so by ${by}. After that we can't take items ` +
            "back, though faults are always covered by our two-year guarantee.",
        });
      return {
        text: "Return the grey armchair to Loftworks for a refund.",
        detail:
          "Loftworks' delivery note for order LW-48812 (the Halden accent chair in slate, delivered 22 September " +
          "2026) says items can only be sent back within 30 days, by 22 October 2026, so the chair can no longer be " +
          "returned for a refund.",
        hidden: delivered(c.ta, at(9, 22, 15, 30), "Tuesday 22 September 2026", "Thursday 22 October 2026"),
        decoy: delivered(c.tb, at(10, 8, 15, 30), "Thursday 8 October 2026", "Saturday 7 November 2026"),
      };
    },
  },
  // Overlap: one topic word ("carpet"; the date as 16/11). Decoy (b): the floor work is the following week.
  {
    name: "carpet-clean-vs-floor-sanding",
    build: () => {
      const job = (start: number, when: string) =>
        event({
          title: "Hawthorn Floors – hall & landing",
          start,
          when,
          where: "Home",
          notes:
            "Lift the hall and landing carpet, sand and seal the boards underneath. Three coats, 24h drying between " +
            "each. Keep everyone off the floors and the rooms empty. Deposit paid (£300).",
          edited: at(10, 14, 19, 0),
        });
      return {
        text: "Have the carpet cleaners come on Monday 16 November.",
        detail:
          "Hawthorn Floors are booked on the calendar from Monday 16 to Wednesday 18 November 2026 to lift the hall " +
          "and landing carpet and sand the boards, with the rooms kept empty, so carpet cleaners can't come on " +
          "16 November 2026.",
        hidden: job(at(11, 16, 8, 0), "Mon 16/11 – Wed 18/11, from 08:00 each day"),
        decoy: job(at(11, 23, 8, 0), "Mon 23/11 – Wed 25/11, from 08:00 each day"),
      };
    },
  },

  // ── admin ──
  // Overlap: one topic word ("tenancy"). Decoy (a): the agent took back its own e-signing instruction. Late: sent
  // this morning.
  {
    name: "tenancy-papers-e-sign",
    build: (c) => {
      const agent: Who = {
        ...bot("Marta Kowalczyk", "marta@harlowfinch.co.uk"),
        title: "Lettings Negotiator",
        company: "Harlow & Finch Lettings",
      };
      const note = (t: Rng, body: string[]) =>
        mail(c, t, {
          from: agent,
          when: at(10, 27, 8, 35),
          title: "Flat 2, 9 Ferncroft Road – paperwork",
          body,
          corporate: true,
        });
      return {
        text: "Post the signed tenancy renewal back to the letting agent today, recorded delivery.",
        detail:
          "Harlow & Finch Lettings (Marta Kowalczyk) emailed at 08:35 on 27 October 2026 not to send the paper " +
          "tenancy pack back: renewals are now done through a DocuSign link sent that morning, and mail to the old " +
          "office won't reach them.",
        hidden: note(c.ta, [
          "Just a heads-up before you send anything back: please don't return the paper tenancy pack.",
          "We've moved to DocuSign this week, and your link went out at 8.30 this morning.",
          "Anything mailed to our old office won't reach us, as we've now moved to 22 Market Hill.",
        ]),
        decoy: note(c.tb, [
          "Please ignore my email from earlier about DocuSign: it isn't set up for existing tenants yet.",
          "Paper is fine, so carry on and send back the tenancy pack as normal to the usual address.",
          "Sorry for the confusion!",
        ]),
      };
    },
  },
  // Overlap: none (summit vs jury service; the date as 16/11/2026 for ten working days). Decoy (a): the service was
  // deferred to 2027.
  {
    name: "summit-vs-jury-service",
    build: (c) => {
      const jury = bot("Jury Central Summoning Bureau", "jury.summoning@justice.gov.uk");
      return {
        text: "Say yes to the partner summit on Wednesday 18 November.",
        detail:
          "A jury summons (Jury Central Summoning Bureau, 5 October 2026) requires attendance at Southwark Crown " +
          "Court for up to ten working days from Monday 16 November to Friday 27 November 2026, which covers " +
          "Wednesday 18 November 2026.",
        hidden: notice(c, c.ta, {
          from: jury,
          when: at(10, 5, 11, 0),
          title: "Jury summons",
          body:
            "Juror number: 418877320\n\nYou have been summoned for jury service at Southwark Crown Court.\nDate of " +
            "attendance: Monday 16/11/2026 at 09:30\nLength of service: up to 10 working days (to Friday " +
            "27/11/2026)\n\nYou must attend unless a request to defer or be excused has been granted in writing. " +
            "Employers must release you for jury service.",
        }),
        decoy: notice(c, c.tb, {
          from: jury,
          when: at(10, 19, 11, 0),
          title: "Your request to defer has been granted",
          body:
            "Juror number: 418877320\n\nYour request to defer jury service has been granted.\nOriginal date: " +
            "Monday 16/11/2026\nNew date of attendance: Monday 15/03/2027 at 09:30\n\nYou do not need to attend on " +
            "the original date.",
        }),
      };
    },
  },
  // Overlap: one topic word ("TV licence"). Decoy (b): Mum's licence was the one cancelled.
  {
    name: "tv-licence-already-cancelled",
    build: (c) => {
      const mum = c.role("mum", ["Ruth", "Carter"]);
      const tvl = bot("TV Licensing", "donotreply@tvlicensing.co.uk");
      const done = (t: Rng, number: string, address: string) =>
        notice(c, t, {
          from: tvl,
          when: at(10, 2, 9, 30),
          title: "Confirmation: your licence has been cancelled",
          body:
            `Licence number: ${number}\nAddress: ${address}\n\nWe've cancelled this licence from 1 October 2026, as ` +
            "we were told it's no longer needed to watch or record live TV or use BBC iPlayer. A refund of £84.50 " +
            "for the unused months will be paid to the bank account we hold within 21 days.",
        });
      return {
        text: "Get rid of the TV licence, we only stream things now.",
        detail:
          "TV Licensing confirmed on 2 October 2026 that the licence for Flat 2, 9 Ferncroft Road was already " +
          "cancelled from 1 October 2026, with an £84.50 refund on its way, so there is nothing left to cancel.",
        hidden: done(c.ta, "3184 2207 6610", HOME),
        decoy: done(c.tb, "3184 5519 0021", `27 Orchard Rise, Bath BA2 4QT (licence holder: ${mum.full})`),
      };
    },
  },
  // Overlap: none (the accountant is "Mr <surname>", the P60 is "year-end paperwork"). Decoy (a): he is back and the
  // cover has ended.
  {
    name: "accountant-on-leave",
    build: (c) => {
      const owen = c.role("accountant", ["Owen", "Price"]);
      const firm = `${owen.last} & Co`;
      const domain = `${owen.last.toLowerCase().replace(/[^a-z]/g, "")}andco.co.uk`;
      const manager: Who = { ...bot("Priti Shah", `priti@${domain}`), title: "Practice Manager", company: firm };
      const note = (t: Rng, when: number, body: string[]) =>
        mail(c, t, { from: manager, when, title: "Out of office cover", body, corporate: true });
      return {
        text: `Send ${owen.first} my P60.`,
        detail:
          `${firm}'s practice manager, Priti Shah, emailed on 9 October 2026 that ${owen.full} is on leave until ` +
          `Monday 30 November 2026 with his inbox unmonitored; documents should go to her (priti@${domain}) instead.`,
        hidden: note(c.ta, at(10, 9, 10, 15), [
          `A quick note to all of Mr ${owen.last}'s clients: he's on leave until Monday 30 November and his inbox ` +
            "isn't being monitored.",
          "Please send any documents or year-end paperwork to me at this address in the meantime and I'll make sure " +
            "they're filed against your record.",
          "Anything urgent, call the office on 01632 960 418.",
        ]),
        decoy: note(c.tb, at(10, 19, 10, 15), [
          `A quick note to all of Mr ${owen.last}'s clients: he's back from leave from today and is picking up his ` +
            "own inbox again.",
          "Please send documents straight to him as usual; my cover arrangement has ended.",
        ]),
      };
    },
  },

  // ── social ──
  // Overlap: a name only (the friend, in the From line). Decoy (b): they drop out of a different evening. Late: sent
  // this morning.
  {
    name: "dinner-friends-drop-out",
    build: (c) => {
      const jamie = c.role("best friend", ["Jamie", "Fox"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: jamie, when: at(10, 27, 8, 26), title: "this week", body });
      return {
        text: `Book a table for four at Kricket on Thursday: us, ${jamie.first} and Sasha.`,
        detail:
          `${jamie.first} emailed at 08:26 on 27 October 2026 that he and Sasha have to pull out of Thursday ` +
          "29 October 2026 (Kai has chickenpox), so a table for four that night would be two people short.",
        hidden: note(c.ta, [
          "Mate, really sorry, we're going to have to bail on Thursday.",
          "Kai's come out in chickenpox spots this morning and Sasha's mum can't have him, so we're stuck at home " +
            "for the week.",
          "Rain check for when he's not contagious?",
        ]),
        decoy: note(c.tb, [
          "Mate, heads up, we can't do Friday's thing at Leila's after all, Sasha's on nights.",
          "Thursday's still very much on though, looking forward to it!",
        ]),
      };
    },
  },
  // Overlap: one topic word ("drinks"; the leaver by first name or nickname). Decoy (c): the drinks are confirmed for
  // the Thursday.
  {
    name: "leaving-drinks-moved",
    build: (c) => {
      const [leaver, organiser, replier, bystander] = c.colleagues(4);
      const name = leaver!.nick ?? leaver!.first;
      const post = (t: Rng, first: string, reply: string, last: string) =>
        chat(
          t,
          "social",
          [
            { who: organiser!, text: first, when: at(10, 26, 16, 5) },
            { who: replier!, text: reply, when: at(10, 26, 16, 12) },
            { who: organiser!, text: last, when: at(10, 26, 16, 14) },
          ],
          bystander!,
        );
      return {
        text: `Put ${leaver!.full}'s leaving drinks on Thursday 5 November in my calendar.`,
        detail:
          `${organiser!.full} posted in Slack (#social) on 26 October 2026 that ${leaver!.full}'s leaving drinks ` +
          "moved from Thursday 5 November 2026 to Friday 6 November 2026, from 17:30 at The Lamb.",
        hidden: post(
          c.ta,
          `change of plan for ${name}'s drinks: The Lamb can't do Thursday the 5th, so we've moved it to Friday the 6th, from 5:30, same pub`,
          "friday works better tbh",
          "I'll update the invite tonight",
        ),
        decoy: post(
          c.tb,
          `all confirmed for ${name}'s drinks: The Lamb, Thursday the 5th, from 5:30, they've reserved the back room for us`,
          "nice one",
          "card's going round tomorrow, sign it if you haven't",
        ),
      };
    },
  },
  // Overlap: a name only ("Hattie"). Decoy (a): the move back to Hattie's after the building work was postponed.
  {
    name: "book-club-venue-moved",
    build: (c) => {
      const leila = c.role("friend", ["Leila", "Haddad"]);
      const note = (t: Rng, body: string[]) =>
        mail(c, t, { from: leila, when: at(10, 24, 11, 40), title: "book club this week", body });
      return {
        text: "Bring a bottle of red to Hattie's on Thursday evening.",
        detail:
          `${leila.first} emailed on 24 October 2026 that Thursday's book club (29 October 2026, 7.30pm) has moved ` +
          `from Hattie's to ${leila.first}'s flat because Hattie's kitchen is being ripped out.`,
        hidden: note(c.ta, [
          "Change of venue for Thursday: we're at mine this time, as Hattie's having her kitchen ripped out.",
          "Same time, 7.30. Still on the Elena Ferrante, so don't panic if you haven't finished it.",
          "Flat 4B, buzzer's broken, just text.",
        ]),
        decoy: note(c.tb, [
          "Hattie's kitchen work has been pushed back to December, so we're at hers on Thursday after all, not mine.",
          "Same time, 7.30. Still on the Elena Ferrante, so don't panic if you haven't finished it.",
        ]),
      };
    },
  },
  // Overlap: a name only ("Sophie"). Decoy (c): children are welcome.
  {
    name: "wedding-adults-only",
    build: () => {
      const wedding = (invite: string) =>
        event({
          title: "Sophie & Tom's wedding",
          start: at(12, 12, 13, 0),
          when: "Saturday 12 December 2026, ceremony 13:00",
          where: "Farleigh House, Hampshire",
          notes: `From the invitation: '${invite} RSVP by 6 November.' Dress code: winter formal.`,
          edited: at(9, 28, 20, 10),
        });
      return {
        text: "Let Sophie know Alex, Maya and I are coming on the 12th.",
        detail:
          "Sophie and Tom's wedding invitation (calendar, Saturday 12 December 2026 at Farleigh House) says the day " +
          "is adults-only, so Maya can't come.",
        hidden: wedding("We love your little ones, but we're keeping the day adults-only."),
        decoy: wedding("Children very welcome: there'll be a kids' table and an entertainer during the speeches."),
      };
    },
  },
];

/**
 * The templates whose fact reads as arriving later the same day (one per area): their items, hidden and decoy, are
 * dated 27 October 2026 between 08:00 and 08:59 UTC, so a late-release harness can hold them back until the request
 * has been answered and the change still matters.
 */
export const HELDOUT18_LATE: readonly string[] = [
  "pricing-deck-via-supplier-portal",
  "class-trip-early-coach",
  "repeat-prescription-on-hold",
  "transfer-before-late-payroll",
  "airport-cab-flight-retimed",
  "washer-install-water-off",
  "tenancy-papers-e-sign",
  "dinner-friends-drop-out",
];

/**
 * Short requests (12 words or fewer) anchored on one person, thing or date that the planted item refers to the way
 * real messages do (first name, surname, role, an account or order reference, a numeric date) rather than in the
 * request's words. Person: pricing-deck, leave-during-cutover, sister-away, crown-invoice, gig-tickets,
 * accountant-on-leave, leaving-drinks. Date: retro-vs-offsite, paris-train, carpet-clean, summit-vs-jury. Thing:
 * card-zero-percent, armchair-return.
 */
export const HELDOUT18_ANCHORED: readonly string[] = [
  "pricing-deck-via-supplier-portal",
  "retro-vs-company-offsite",
  "leave-during-cutover-week",
  "sister-away-sleepover",
  "crown-invoice-cancelled",
  "card-zero-percent-ending",
  "gig-tickets-already-repaid",
  "paris-train-already-booked",
  "armchair-return-window",
  "carpet-clean-vs-floor-sanding",
  "summit-vs-jury-service",
  "accountant-on-leave",
  "leaving-drinks-moved",
];

/**
 * Plant one item per template (the real one for `hidden`, the decoy for `control`, nothing for `neutral`) and return
 * the tasks. Builds both items every time so RNG draws, and so the people and numbers in each task, match across the
 * three variants.
 */
export function plantHeldout18(world: World, seed: number, variant: "hidden" | "control" | "neutral"): HiddenTask[] {
  // A stream of our own: the world's generator state is not shared, and other suites' draws cannot shift ours.
  const r = new Rng(seed * 7_919 + 1_818);
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
  const suite = variant === "hidden" ? "heldout18" : `heldout18-${variant}`;
  const tasks: HiddenTask[] = [];
  for (const t of TEMPLATES) {
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
    const spec = t.build(ctx);
    if (variant !== "neutral") {
      const p = variant === "hidden" ? spec.hidden : spec.decoy;
      // The same ref in hidden and control, so the item id does not tell a grader or a model which variant it is.
      // A ref of the base world's shape (`<kind>-<index>`): the tools arm sees refs, so one naming the template or
      // marking the item as planted would tell the agent. The same index in hidden and control, since both plant one
      // item per template in order.
      const ref = `${p.kind}-${world.items.length}`;
      world.items.push({ ...p, id: itemId(p.sourceId, ref), ref, facts: [], noise: false });
    }
    tasks.push({ id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail });
  }
  return tasks;
}

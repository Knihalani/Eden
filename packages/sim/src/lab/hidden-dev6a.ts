/**
 * Development suite dev6a: thirty hidden-context templates across work and personal life, written after D72 to tune
 * on. Each template is a request an assistant would act on or answer, one planted item that should change the answer
 * (hidden variant) and a near-miss decoy in its place (control variant), with the same request text in both.
 *
 * The templates come in three lexical bands, ten each, so a tuning run shows where retrieval stops working:
 *  - none: the decisive item shares no content word with the request (the link is a person's role, an organisation
 *    behind a person, a place on a route, or plain meaning);
 *  - name: it shares only a person, organisation or system name;
 *  - topic: it shares a topic word ("pension", "invoice", "offsite").
 * Decoys are resolved, expired, or about another entity or date, so a control answer that raises the hidden
 * consideration is a false fire.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import { chatText, dayLabel, emailText, threadBodies, type Message, type Who } from "../text";
import type { Person, World, WorldItem } from "../world";
import type { HiddenTask } from "./hidden-context";
import type { Variant } from "./suites";

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
  item: Planted;
  decoy: Planted;
  /** What a good hidden-variant answer raises. */
  detail: string;
  /** What a control answer must not claim (the decoy does not support it). */
  falseClaim: string;
}

interface Ctx {
  user: Person;
  r: Rng;
  colleague: () => Person;
  client: () => Person;
  role: (role: string) => Person;
}

/** A time relative to the simulation's present (Tuesday 27 October 2026): day offset, then UTC hour and minute. */
const at = (d: number, h = 9, m = 0) => Date.UTC(2026, 9, 27 + d, h, m);
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const who = (w: Who) => `${w.full} <${w.email}>`;
const sender = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });

function mail(from: Who, to: Who, t: number, subject: string, body: string[], cc: Who[] = []): Planted {
  // Every planted mail is addressed to the user, so the participants a connector reports are the sender and Cc.
  const people = [from, ...cc];
  return {
    sourceId: "gmail",
    kind: "mail",
    title: subject,
    text: emailText(from, to, t, body.join("\n\n"), cc),
    at: t,
    meta: { people: people.map(who).join("; ") },
  };
}

/** The newest message of a thread, quoting the ones before it as mail clients do. */
function thread(r: Rng, user: Person, subject: string, messages: Message[]): Planted {
  const bodies = threadBodies(r, messages);
  const last = messages[messages.length - 1]!;
  const people = new Map<string, Who>();
  for (const m of messages) for (const p of [m.from, m.to]) if (p.email !== user.email) people.set(p.email, p);
  return {
    sourceId: "gmail",
    kind: "mail",
    title: `Re: ${subject}`,
    text: emailText(last.from, last.to, last.at, bodies[bodies.length - 1]!),
    at: last.at,
    meta: { people: [...people.values()].map(who).join("; ") },
  };
}

function chat(channel: string, day: number, lines: [Person | string, string, number, number][]): Planted {
  const t = (l: (typeof lines)[number]) => at(day, l[2], l[3]);
  return {
    sourceId: "slack",
    kind: "chat",
    title: `#${channel}`,
    text:
      `#${channel} · ${dayLabel(at(day))}\n` +
      chatText(lines.map((l) => ({ who: typeof l[0] === "string" ? l[0] : l[0].full, text: l[1], at: t(l) }))),
    at: t(lines[lines.length - 1]!),
  };
}

function event(title: string, start: number, minutes: number, description: string[]): Planted {
  const end = start + minutes * 60_000;
  const hm = (t: number) => new Date(t).toISOString().slice(11, 16);
  return {
    sourceId: "calendar",
    kind: "event",
    title,
    text: `${title}\n${dayLabel(start)} 2026, ${hm(start)}-${hm(end)}\n\n${description.join("\n")}`,
    at: start - 7 * 24 * 3_600_000,
    meta: { start: iso(start) },
  };
}

function doc(title: string, t: number, lines: string[]): Planted {
  return { sourceId: "drive", kind: "doc", title, text: `${title}\n\n${lines.join("\n")}`, at: t };
}

/** A ticket notification as an issue tracker mails it. */
function ticket(
  key: string,
  summary: string,
  t: number,
  fields: [string, string][],
  comment: { by: Person; text: string },
): Planted {
  const tracker = sender("Jira", "jira@northwind.atlassian.net");
  const body = [
    `${comment.by.full} commented on ${key}`,
    `${key}: ${summary}`,
    fields.map(([k, v]) => `${k}: ${v}`).join("\n"),
    `"${comment.text}"`,
    `View issue: https://northwind.atlassian.net/browse/${key}`,
  ];
  return {
    sourceId: "gmail",
    kind: "notification",
    title: `[JIRA] (${key}) ${summary}`,
    text: emailText(tracker, sender("Robin Carter", "robin@northwind.co"), t, body.join("\n\n")),
    at: t,
  };
}

const TEMPLATES: { name: string; make: (c: Ctx) => Made }[] = [
  // ── band "none": no content word in common with the request ──
  {
    name: "second-signature",
    make: ({ r, colleague }) => {
      const fin = colleague();
      const second = colleague();
      const other = colleague();
      const amount = `£${r.int(6, 9)},${r.pick(["200", "450", "800"])}`;
      return {
        text: `Approve the ${amount} order for twelve laptops from the IT reseller and tell them to go ahead.`,
        item: chat("finance", -5, [
          [other, "anyone know if the expenses portal is down?", 10, 2],
          [fin, "it's back now", 10, 9],
          [
            fin,
            "Reminder for anyone with spending authority: until the auditors wrap up on Friday 13 November, any " +
              `commitment above £5,000 needs a second signature. ${second.full} is the second signer for Partnerships.`,
            10,
            31,
          ],
          [other, "noted, thanks", 10, 40],
        ]),
        decoy: chat("finance", -4, [
          [
            fin,
            "Update: the auditors wrapped up early, so the second-signature rule for commitments above £5,000 ended " +
              "on Friday 23 October. Single signature is back for everyone.",
            15,
            12,
          ],
          [other, "great news", 15, 20],
        ]),
        detail:
          `Commitments above £5,000 need a second signature (${second.full}) until 13 November, so Robin cannot ` +
          `approve the ${amount} laptop order alone.`,
        falseClaim: "The laptop order needs a second signature before it can go ahead.",
      };
    },
  },
  {
    name: "licence-lapsed",
    make: ({ user }) => {
      const dvla = sender("DVLA", "noreply@dvla.gov.uk");
      return {
        text: "Reserve a hire car for the Cornwall weekend, 14-16 November, picking up at Exeter St Davids.",
        item: mail(dvla, user, at(-8, 7, 15), "Your driving licence application", [
          `Dear ${user.full},`,
          "Your photocard driving licence expired on 30 September 2026. We received your renewal application on " +
            "19 October 2026. Applications are currently taking up to 3 weeks to process.",
          "Because your application includes a medical declaration, you must not drive until you receive your " +
            "new licence.",
          "Driver and Vehicle Licensing Agency, Swansea SA6 7JL",
        ]),
        decoy: mail(dvla, user, at(-26, 7, 15), "Your new driving licence is on its way", [
          `Dear ${user.full},`,
          "Your new photocard driving licence was dispatched on 2 October 2026 and is valid until 1 October 2036. " +
            "Your previous licence is no longer valid; please destroy it.",
          "Driver and Vehicle Licensing Agency, Swansea SA6 7JL",
        ]),
        detail:
          "Robin's driving licence expired on 30 September and the renewal (received 19 October, up to 3 weeks) " +
          "may not arrive in time; Robin must not drive until it does.",
        falseClaim: "Robin may not have a valid driving licence for the trip.",
      };
    },
  },
  {
    name: "board-pack",
    make: ({ colleague }) => {
      const cosec = colleague();
      const desc = (when: string) => [
        "Owner: Robin Carter",
        `Final numbers and commentary for the Partnerships section to the company secretary (${cosec.full}) by ` +
          `15:00 ${when}. Packs that miss the cut-off go to the board without the section.`,
      ];
      return {
        text: "Is it fine if I take Friday afternoon off this week?",
        item: event("Board pack: Partnerships section due", at(3, 15), 30, desc("on the day")),
        decoy: event("Board pack: Partnerships section due", at(-4, 15), 30, desc("on the day")),
        detail: `Robin owns the board pack section due to ${cosec.full} by 15:00 on Friday 30 October.`,
        falseClaim: "Robin has a board pack section due on Friday afternoon.",
      };
    },
  },
  {
    name: "tenancy-clause",
    make: ({ role }) => {
      const landlord = role("landlord");
      const agreement = (address: string, term: string) => [
        `Landlord: ${landlord.full}. Tenant: Robin Carter. Premises: ${address}. Term: ${term}.`,
        "",
        "| Clause | Term |",
        "|---|---|",
        "| 9 | Rent is payable monthly in advance on the 28th by standing order |",
        "| 12 | The Tenant shall keep the Premises in good and clean condition |",
        "| 14 | The Tenant shall not sublet, take in lodgers or permit short-term holiday occupation of the Premises " +
          "without the Landlord's prior written consent |",
        "| 17 | No pets without consent, not to be unreasonably withheld |",
      ];
      return {
        text: "Reply to the Airbnb guest and confirm they can stay at mine from 6 to 9 December while I'm abroad.",
        item: doc(
          "Assured Shorthold Tenancy - Flat 2, 41 Cranbrook Road",
          at(-140),
          agreement("Flat 2, 41 Cranbrook Road", "12 months from 1 July 2026"),
        ),
        decoy: doc(
          "Assured Shorthold Tenancy - 14 Rye Lane (ended 30 June 2025)",
          at(-500),
          agreement("14 Rye Lane", "1 July 2023 to 30 June 2025 (ended; deposit returned)"),
        ),
        detail:
          `Clause 14 of Robin's tenancy bars short-term holiday lets without ${landlord.full}'s prior written ` +
          "consent, so Robin needs the landlord's consent before confirming the guest.",
        falseClaim: "Robin's tenancy forbids short-term lets without the landlord's written consent.",
      };
    },
  },
  {
    name: "physio-advice",
    make: ({ r, user }) => {
      const physio = sender("Hannah Moss", "hannah@bodyworksclinic.co.uk");
      const ask: Message = {
        from: user,
        to: physio,
        at: at(-8, 18),
        body: ["Did the scan show anything? Leg still sore on the stairs."],
        corporate: false,
      };
      const advice = (body: string[]): Message => ({ from: physio, to: user, at: at(-7, 11), body, corporate: true });
      const thanks: Message = {
        from: user,
        to: physio,
        at: at(-7, 13),
        body: ["Thanks Hannah, that's clear. See you on the 1st."],
        corporate: false,
      };
      return {
        text: "Sign me up for the Royal Parks charity half marathon on 22 November.",
        item: thread(r, user, "Scan results", [
          ask,
          advice([
            "The scan shows a grade 2 stress reaction in the left tibia.",
            "No running or jumping for six weeks from 20 October; cycling and swimming are fine.",
            "We'll reassess on 1 December.",
          ]),
          thanks,
        ]),
        decoy: thread(r, user, "Scan results", [
          ask,
          advice([
            "Good news: the scan is clear, it was soft-tissue irritation only.",
            "You're cleared to build back up to full training from this week.",
          ]),
          thanks,
        ]),
        detail:
          "Robin's physio ruled out running for six weeks from 20 October (stress reaction, reassessment on 1 " +
          "December), so the 22 November half marathon is off.",
        falseClaim: "Robin has been told not to run until December.",
      };
    },
  },
  {
    name: "sister-moved",
    make: ({ user, role }) => {
      const sister = role("sister");
      return {
        text: "Order flowers for my sister's birthday on Saturday and have them delivered to her place.",
        item: mail(sister, user, at(-3, 20, 12), "We got the keys!", [
          `Hi ${user.first},`,
          "Dev and I are in from Friday 30th. New address: Flat 3, 22 Gilbert Road, Cambridge CB4 3PE. The old " +
            "flat goes back to the agent on Friday so don't send anything there.",
          `${sister.first} x`,
        ]),
        decoy: mail(sister, user, at(-3, 20, 12), "Gilbert Road", [
          `Hi ${user.first},`,
          "We didn't get the Gilbert Road flat in the end, someone outbid us. Staying where we are for now.",
          `${sister.first} x`,
        ]),
        detail: `${sister.first} has moved: deliver to Flat 3, 22 Gilbert Road, Cambridge CB4 3PE, not the old address.`,
        falseClaim: "Robin's sister has moved to a new address.",
      };
    },
  },
  {
    name: "client-kickoff",
    make: ({ client, colleague }) => {
      const p = client();
      const other = client();
      const am = colleague();
      const line = (org: string) =>
        `FYI everyone at ${org} is at their company kickoff in Reykjavik 10-13 November, they've told us nobody ` +
        "on their side is free that week.";
      return {
        text: `Invite ${p.full} to our customer dinner in London on Thursday 12 November.`,
        item: chat("accounts", -2, [[am, line(p.org!), 14, 5]]),
        decoy: chat("accounts", -2, [[am, line(other.org!), 14, 5]]),
        detail: `${p.full}'s company ${p.org} is at its kickoff in Reykjavik 10-13 November, so ${p.first} can't come.`,
        falseClaim: `${p.full} will be away at ${p.org}'s company kickoff on 12 November.`,
      };
    },
  },
  {
    name: "rail-works",
    make: ({ user }) => {
      const lner = sender("LNER", "travel@info.lner.co.uk");
      const notice = (day: string) => [
        `Hello ${user.first},`,
        `Planned engineering work: ${day}, no trains will run between Doncaster and Wakefield Westgate before ` +
          "11:00. Rail replacement buses will run and add around 50 minutes to your journey.",
        "Check before you travel at lner.co.uk/travel-updates.",
      ];
      return {
        text: "What's the best way to get to the Leeds office for the 9:30 on Monday?",
        item: mail(lner, user, at(-4, 6), "Planned engineering work on your route", notice("Monday 2 November")),
        decoy: mail(lner, user, at(-12, 6), "Planned engineering work on your route", notice("Sunday 25 October")),
        detail:
          "No trains between Doncaster and Wakefield before 11:00 on Monday 2 November (buses add ~50 minutes), so " +
          "the usual train will not make the 9:30; travel the night before or leave much earlier.",
        falseClaim: "Engineering works disrupt the train to Leeds on Monday morning.",
      };
    },
  },
  {
    name: "contrast-blocker",
    make: ({ r, colleague }) => {
      const dev = colleague();
      const key = `WEB-${r.int(300, 899)}`;
      const summary = "Night theme fails WCAG 2.2 AA contrast on 14 screens";
      return {
        text: "Can we ship the dark mode toggle to everyone tomorrow?",
        item: ticket(
          key,
          summary,
          at(-1, 16),
          [
            ["Status", "Open"],
            ["Priority", "Release blocker"],
            ["Assignee", dev.full],
          ],
          {
            by: dev,
            text: "Legal confirmed we can't GA anything that fails AA under the public-sector contract.",
          },
        ),
        decoy: ticket(
          key,
          summary,
          at(-1, 16),
          [
            ["Status", "Done"],
            ["Resolution", "Fixed in 4.18"],
            ["Assignee", dev.full],
          ],
          { by: dev, text: "Re-audited after the palette change: all 14 screens pass AA now. Closing." },
        ),
        detail: `${key}: the night theme fails WCAG AA contrast on 14 screens and is an open release blocker.`,
        falseClaim: "An open accessibility blocker stops dark mode from shipping.",
      };
    },
  },
  {
    name: "child-passport",
    make: ({ user }) => {
      const hmpo = sender("HM Passport Office", "noreply@passport.service.gov.uk");
      return {
        text: "Book us a week in the Algarve over February half-term.",
        item: mail(hmpo, user, at(-6, 8), "Passport expiry reminder", [
          `Dear ${user.full},`,
          "The passport for MAYA CARTER expires on 12 January 2027. Standard renewals take about 3 weeks. You can " +
            "renew online at gov.uk/renew-child-passport.",
        ]),
        decoy: mail(hmpo, user, at(-6, 8), "Your passport is on its way", [
          `Dear ${user.full},`,
          "The new passport for MAYA CARTER has been printed and posted. It is valid until 10 October 2031.",
        ]),
        detail:
          "Maya's passport expires on 12 January 2027, before February half-term; renew it (about 3 weeks) first.",
        falseClaim: "Maya's passport will have expired by February half-term.",
      };
    },
  },

  // ── band "name": only a person, organisation or system name in common ──
  {
    name: "reload-done",
    make: ({ r, colleague }) => {
      const eng = colleague();
      const other = colleague();
      const key = `OPS-${r.int(40, 160)}`;
      const line = `Atlas: the reload for last month finished at 03:12, row counts match the ledger. Closing ${key}.`;
      return {
        text: "Can someone rerun the Atlas backfill for September before the finance close?",
        item: chat("data-eng", -5, [
          [eng, line, 8, 41],
          [other, "nice one", 8, 50],
        ]),
        decoy: chat("data-eng", -53, [
          [eng, line, 8, 41],
          [other, "nice one", 8, 50],
        ]),
        detail: `${eng.full} already reran September's Atlas load (finished 03:12, reconciled, ${key} closed).`,
        falseClaim: "The September Atlas backfill has already been rerun.",
      };
    },
  },
  {
    name: "quiet-notice",
    make: ({ user, colleague }) => {
      const p = colleague();
      const other = colleague();
      const hr = colleague();
      const note = (q: Person): string[] => [
        `Hi ${user.first},`,
        `Confidential: ${q.full} handed in notice yesterday; last day Friday 20 November. Please keep this to ` +
          "yourself until their team is told on Friday.",
        hr.first,
      ];
      return {
        text: `Book a 30-minute catch-up with ${p.full} next week to go over their promotion case.`,
        item: mail(hr, user, at(-1, 17, 40), "Confidential - team change", note(p)),
        decoy: mail(hr, user, at(-1, 17, 40), "Confidential - team change", note(other)),
        detail: `${p.full} has resigned (last day 20 November; confidential until Friday), so the promotion case is moot.`,
        falseClaim: `${p.full} has resigned.`,
      };
    },
  },
  {
    name: "processor-register",
    make: ({ r }) => {
      const [agency, other1, other2] = r.sample(["Brightline", "Foxglove Studio", "Northlight", "Paper Kite"], 3);
      const register = (status: string, allowed: string) => [
        "Last reviewed 21 Oct 2026 by Legal.",
        "",
        "| Processor | Purpose | Data categories | DPA | Personal data allowed |",
        "|---|---|---|---|---|",
        `| ${other1} | Event logistics | names, emails | signed 3 Mar 2026 | yes |`,
        `| ${agency} | Seasonal marketing | contacts, purchase history | ${status} | ${allowed} |`,
        `| ${other2} | Print | none | n/a | no |`,
      ];
      return {
        text: `Send the full customer list export to ${agency} so they can start the holiday campaign.`,
        item: doc("Processor register (GDPR Art. 30)", at(-6), register("NOT SIGNED - legal chasing", "NO")),
        decoy: doc("Processor register (GDPR Art. 30)", at(-6), register("signed 2 Oct 2026", "yes")),
        detail: `${agency} has no signed DPA and the register says no personal data may go to them yet.`,
        falseClaim: `${agency} has no signed data processing agreement.`,
      };
    },
  },
  {
    name: "credit-hold",
    make: ({ r, client, colleague }) => {
      const p = client();
      const fin = colleague();
      const a = r.int(4000, 9000);
      const b = r.int(1000, 3999);
      const record = (status: string[]) => [
        `Account: ${p.org}`,
        `Primary contact: ${p.full}`,
        `Account owner: Robin Carter`,
        ...status,
      ];
      return {
        text: `Confirm the 40-pallet order for ${p.org} on our usual 30-day terms.`,
        item: {
          sourceId: "crm",
          kind: "deal",
          title: `${p.org} - account`,
          at: at(-8),
          text: record([
            "Status: CREDIT HOLD since 19 Oct 2026",
            `Reason: two invoices 60+ days overdue (INV-20${a} £${a * 2}, INV-20${b} £${b * 3})`,
            `Note (Finance, ${fin.full}): prepayment only until both are cleared.`,
          ]).join("\n"),
        },
        decoy: {
          sourceId: "crm",
          kind: "deal",
          title: `${p.org} - account`,
          at: at(-15),
          text: record([
            "Status: Active",
            `Note (Finance, ${fin.full}): credit hold lifted 12 Oct 2026 after the overdue invoices were paid.`,
          ]).join("\n"),
        },
        detail: `${p.org} is on credit hold (two invoices 60+ days overdue); Finance requires prepayment, not 30 days.`,
        falseClaim: `${p.org} is on credit hold.`,
      };
    },
  },
  {
    name: "seat-cleanup",
    make: ({ r, colleague }) => {
      const [sys, other] = r.sample(["Looker", "Tableau", "Metabase"], 2);
      const it = colleague();
      const line = (s: string) =>
        `Seat clean-up done: removed ${s} access for 23 inactive accounts, incl. svc-reports. Shout in ITS-2231 if ` +
        "something breaks.";
      return {
        text: `Restart the nightly ${sys} export job, it failed again last night.`,
        item: chat("it-ops", -1, [[it, line(sys!), 11, 20]]),
        decoy: chat("it-ops", -1, [[it, line(other!), 11, 20]]),
        detail:
          `The svc-reports account lost ${sys} access in Monday's seat clean-up (ITS-2231); a restart won't help ` +
          "until access is restored.",
        falseClaim: `The ${sys} export fails because its service account lost access.`,
      };
    },
  },
  {
    name: "accountant-needs",
    make: ({ r, user, role }) => {
      const acc = role("accountant");
      const m = (from: Who, to: Who, d: number, body: string[]): Message => ({
        from,
        to,
        at: at(d, 10),
        body,
        corporate: from === acc,
      });
      return {
        text: `Do I need to send ${acc.first} anything before the end of January?`,
        item: thread(r, user, "2025/26 return", [
          m(acc, user, -20, [
            "To file your 2025/26 return I still need two things: the P11D from Northwind and your rental income " +
              "summary for the Hackney flat. Could I have both by 30 November?",
          ]),
          m(user, acc, -19, ["Will do, the P11D should land in a week or so."]),
          m(acc, user, -18, ["Great. Fee is unchanged from last year, invoice to follow once filed."]),
          m(user, acc, -18, ["Perfect, thanks."]),
        ]),
        decoy: thread(r, user, "2025/26 return", [
          m(acc, user, -40, ["Could you send the P11D and the rental summary when you have them?"]),
          m(user, acc, -30, ["Both attached."]),
          m(acc, user, -13, ["Got everything I need: return filed on 14 October, nothing more needed from you."]),
          m(user, acc, -13, ["Perfect, thanks."]),
        ]),
        detail: `${acc.full} still needs the P11D and the rental income summary by 30 November for the 2025/26 return.`,
        falseClaim: `${acc.first} still needs documents from Robin.`,
      };
    },
  },
  {
    name: "friend-car",
    make: ({ user, role }) => {
      const friend = role("best friend");
      return {
        text: `Text ${friend.first} and ask if he can pick me up from Gatwick on Saturday morning.`,
        item: mail(friend, user, at(-2, 21), "pub quiz", [
          "Quiz is on for Wednesday, Leila's coming too.",
          "Also the Golf's in the garage till the 10th, new clutch, so I'm on the bus for a bit.",
          friend.first,
        ]),
        decoy: mail(friend, user, at(-2, 21), "pub quiz", [
          "Quiz is on for Wednesday, Leila's coming too.",
          "Golf's back from the garage, new clutch, drives like a dream.",
          friend.first,
        ]),
        detail: `${friend.first}'s car is in the garage until 10 November, so he can't drive to Gatwick on Saturday.`,
        falseClaim: `${friend.first} has no car this weekend.`,
      };
    },
  },
  {
    name: "class-photo",
    make: () => {
      const desc = ["Brace fitting with Dr Shah, about 90 minutes.", "Collect Maya from school at 10:00."];
      return {
        text: "Reply to Mrs Daley saying Maya will be there for the class photo on Thursday morning.",
        item: event("Maya - orthodontist", at(2, 10, 40), 90, desc),
        decoy: event("Maya - orthodontist", at(-5, 10, 40), 90, desc),
        detail:
          "Maya is out of school from 10:00 on Thursday 29 October for an orthodontist appointment (10:40-12:10).",
        falseClaim: "Maya is out of school on Thursday morning for an orthodontist appointment.",
      };
    },
  },
  {
    name: "nda-lapsed",
    make: ({ r, user, client, colleague }) => {
      const p = client();
      const legal = colleague();
      const m = (from: Who, to: Who, d: number, h: number, body: string[]): Message => ({
        from,
        to,
        at: at(d, h),
        body,
        corporate: true,
      });
      const ask = m(user, legal, -9, 10, [`Is our NDA with ${p.org} still in place?`]);
      return {
        text: `Can I share our pricing model with ${p.org} on Thursday's call?`,
        item: thread(r, user, `${p.org} NDA`, [
          ask,
          m(legal, user, -9, 14, [
            "It expired on 30 September. I sent the renewal on 5 October and they haven't signed it.",
            "Until they do, treat anything commercial as not covered.",
          ]),
          m(user, legal, -9, 15, ["Ok, I'll chase them."]),
        ]),
        decoy: thread(r, user, `${p.org} NDA`, [
          ask,
          m(legal, user, -9, 14, ["Yes: countersigned copy attached, the mutual NDA runs to 30 September 2028."]),
          m(user, legal, -9, 15, ["Great, thanks."]),
        ]),
        detail: `The NDA with ${p.org} expired on 30 September and the renewal is unsigned, so pricing isn't covered.`,
        falseClaim: `There is no NDA in force with ${p.org}.`,
      };
    },
  },
  {
    name: "prod-keys",
    make: ({ r, client, colleague }) => {
      const p = client();
      const eng = colleague();
      const key = `INT-${r.int(20, 140)}`;
      const summary = `${p.org}: production credentials`;
      return {
        text: `Draft the go-live announcement for the ${p.org} integration for Thursday.`,
        item: ticket(
          key,
          summary,
          at(-1, 12),
          [
            ["Status", "Waiting on customer"],
            ["Assignee", eng.full],
          ],
          {
            by: eng,
            text:
              "Their security questionnaire is still outstanding and they won't issue prod keys until it's back. " +
              "Earliest realistic date is 9 Nov.",
          },
        ),
        decoy: ticket(
          key,
          summary,
          at(-6, 12),
          [
            ["Status", "Done"],
            ["Assignee", eng.full],
          ],
          { by: eng, text: "Prod keys issued 21 Oct, smoke tests green. Closing." },
        ),
        detail: `${key}: ${p.org}'s production keys wait on their security questionnaire; earliest go-live is 9 November.`,
        falseClaim: `The ${p.org} integration cannot go live on Thursday.`,
      };
    },
  },

  // ── band "topic": a topic word in common ──
  {
    name: "pension-mpaa",
    make: ({ user, role }) => {
      const mum = role("mum");
      const provider = sender("Harbour Pensions", "letters@harbourpensions.co.uk");
      const letter = (name: string) =>
        `Dear ${name}, following your flexible withdrawal on 3 March 2026, the Money Purchase Annual Allowance ` +
        "applies: tax-relieved contributions to your defined contribution pension savings are now limited to " +
        "£10,000 a year.";
      return {
        text: "How much can I pay into my pension before April without a tax charge?",
        item: mail(provider, user, at(-30), "Important information about your pension", [
          letter(user.full),
          "Harbour Pensions",
        ]),
        decoy: mail(mum, user, at(-3, 19), "Fwd: Important information about your pension", [
          `${user.first} can you read this, is it bad? Mum x`,
          "---------- Forwarded message ---------",
          `From: ${who(provider)}`,
          letter(mum.full),
        ]),
        detail:
          "The Money Purchase Annual Allowance applies to Robin since March: £10,000 a year, not the usual £60,000.",
        falseClaim: "Robin's pension contributions are capped at £10,000 a year.",
      };
    },
  },
  {
    name: "fixed-saver",
    make: ({ user }) => {
      const bank = sender("Monzo Savings", "savings@monzo.example");
      return {
        text: "Move £3,000 from my savings into the current account tomorrow to cover the builder's deposit.",
        item: mail(bank, user, at(-10), "Your Fixed Rate Saver", [
          "Your 1 Year Fixed Rate Saver (ending 4471) matures on 9 November 2026.",
          "Withdrawals aren't possible before maturity; closing early costs 90 days' interest.",
        ]),
        decoy: mail(bank, user, at(-18), "Your Fixed Rate Saver has matured", [
          "Your 1 Year Fixed Rate Saver (ending 4471) matured on 9 October 2026 and the balance has moved to your " +
            "Easy Access Saver. You can withdraw at any time.",
        ]),
        detail:
          "Robin's savings are in a fixed saver that matures on 9 November; withdrawing earlier isn't possible " +
          "without closing it and losing 90 days' interest.",
        falseClaim: "Robin's savings are locked in a fixed saver until 9 November.",
      };
    },
  },
  {
    name: "landlord-pays",
    make: ({ r, user, role }) => {
      const landlord = role("landlord");
      const m = (from: Who, to: Who, d: number, body: string[]): Message => ({
        from,
        to,
        at: at(d, 9),
        body,
        corporate: false,
      });
      const report = m(user, landlord, -6, ["The plumber came for the boiler yesterday, all fixed."]);
      return {
        text: "Pay the plumber's invoice for the boiler repair today, it's in my inbox.",
        item: thread(r, user, "Boiler", [
          report,
          m(landlord, user, -5, [
            "Boiler's my responsibility under the lease. Ask the plumber to send the invoice to me and I'll pay it " +
              "direct. Please don't pay it yourself, I can't reimburse through the agent.",
          ]),
        ]),
        decoy: thread(r, user, "Boiler", [
          report,
          m(landlord, user, -5, [
            "Glad it's sorted. The electrician's invoice for the extra sockets you asked for is yours, as agreed.",
          ]),
        ]),
        detail: `${landlord.full} said he pays the plumber directly and Robin should not pay the boiler invoice.`,
        falseClaim: "The landlord is paying the plumber's invoice.",
      };
    },
  },
  {
    name: "offsite-headcount",
    make: ({ r, colleague }) => {
      const names = Array.from({ length: 12 }, () => colleague());
      const table = (title: string, yes: number, pending: number) => {
        const rows = names.map((p, i) => {
          const status = i < yes ? "yes" : i < yes + pending ? "pending" : "no";
          return `| ${p.full} | ${status} | ${i % 4 === 0 ? "vegetarian" : "-"} |`;
        });
        return [title, "", "| Name | Attending | Dietary |", "|---|---|---|", ...rows];
      };
      const yes = r.int(6, 8);
      return {
        text: "Order catering for the team offsite on Thursday 5 November for 24 people.",
        item: doc("Offsite 5 Nov - RSVPs", at(-1), [
          ...table("Team offsite, Thursday 5 November", yes, 2),
          "",
          `Partners team (12): 9 yes, 1 pending. Total confirmed: ${yes + 9}.`,
        ]),
        decoy: doc("Summer offsite 18 June - RSVPs", at(-140), [
          ...table("Team offsite, Thursday 18 June", 12, 0),
          "",
          "Partners team (12): 12 yes. Total confirmed: 24.",
        ]),
        detail: `Only ${yes + 9} people have confirmed for 5 November (3 pending), not 24.`,
        falseClaim: "Fewer than 24 people have confirmed for the offsite.",
      };
    },
  },
  {
    name: "talk-deadline",
    make: ({ user }) => {
      const pc = sender("DataDay Europe programme committee", "speakers@datadayeurope.example");
      return {
        text: "Submit my talk abstract for the conference before tonight's deadline.",
        item: mail(pc, user, at(-1, 16), "DataDay Europe: call for talks extended", [
          "The call for talks has been extended to Friday 13 November, 23:59 CET.",
          "Please note abstracts are now limited to 150 words.",
        ]),
        decoy: mail(pc, user, at(-1, 16), "DataDay Europe: workshop deadline extended", [
          "The workshop track deadline has been extended to Friday 13 November.",
          "Talk proposals still close tonight at 23:59 CET.",
        ]),
        detail: "The talk deadline is extended to 13 November and abstracts are now limited to 150 words.",
        falseClaim: "The talk deadline has been extended.",
      };
    },
  },
  {
    name: "design-seats",
    make: ({ user, colleague }) => {
      const fin = colleague();
      const audit = (tool: string) => [
        `Hi ${user.first},`,
        `Seat audit for the ${tool}: only 7 of our 12 seats have been used since August. Finance wants us to drop ` +
          "to 7 at renewal and move the other 5 people to free viewer access.",
        fin.first,
      ];
      return {
        text: "Renew our design tool subscription at 12 seats before it lapses on Friday.",
        item: mail(fin, user, at(-2, 12), "Seat audit", audit("design tool")),
        decoy: mail(fin, user, at(-2, 12), "Seat audit", audit("analytics tool")),
        detail: "Finance wants the design tool renewed at 7 seats, not 12 (only 7 used since August).",
        falseClaim: "Finance wants the design tool renewed at 7 seats.",
      };
    },
  },
  {
    name: "venue-deposit",
    make: ({ r, user }) => {
      const venue = sender("Grace Fenwick", "events@thebellhighgate.example");
      const m = (from: Who, to: Who, d: number, body: string[]): Message => ({
        from,
        to,
        at: at(d, 11),
        body,
        corporate: from === venue,
      });
      const opening = [
        m(user, venue, -12, ["Could we book the function room for my mum's 70th on Saturday 14 November, ~40 people?"]),
        m(venue, user, -11, [
          "Lovely, we're holding the function room for you provisionally. We need the £500 deposit by Friday 30 " +
            "October or the hold lapses and it goes to the waiting list.",
        ]),
      ];
      return {
        text: "Confirm the venue booking for Mum's 70th on Saturday 14 November.",
        item: thread(r, user, "Function room 14 Nov", [
          ...opening,
          m(user, venue, -4, ["Great. Can we do a buffet rather than sit-down?"]),
          m(venue, user, -3, ["Of course, I'll send the buffet menu over this week."]),
        ]),
        decoy: thread(r, user, "Function room 14 Nov", [
          ...opening,
          m(user, venue, -4, ["Deposit sent this morning."]),
          m(venue, user, -3, ["Deposit received with thanks, your booking for 14 November is confirmed."]),
        ]),
        detail: "The venue holds the room only provisionally: the £500 deposit is due by Friday 30 October.",
        falseClaim: "The venue still needs a £500 deposit by 30 October.",
      };
    },
  },
  {
    name: "rent-change",
    make: ({ user, role }) => {
      const landlord = role("landlord");
      return {
        text: "When is November's rent due, and how much is it?",
        item: mail(landlord, user, at(-9, 18), "Rent from November", [
          `Hi ${user.first},`,
          "From November the rent is due on the 1st rather than the 28th, and it goes up to £1,925 as per the " +
            "renewal we signed.",
          landlord.first,
        ]),
        decoy: mail(landlord, user, at(-9, 18), "Parking bay rent", [
          `Hi ${user.first},`,
          "Small one: from November the parking bay rent (£85) is due on the 1st, separately from the flat.",
          landlord.first,
        ]),
        detail: "November's rent is due on 1 November (not the 28th) and is £1,925 after the renewal.",
        falseClaim: "November's rent is £1,925, due on the 1st.",
      };
    },
  },
  {
    name: "csv-vendor",
    make: ({ r, client, colleague }) => {
      const p = client();
      const eng = colleague();
      const n = r.int(500, 999);
      return {
        text: `Reply to ${p.full} and promise a fix for their CSV import bug by Friday.`,
        item: ticket(
          `BILL-${n}`,
          "CSV import drops rows with semicolon delimiters",
          at(-1, 15),
          [
            ["Status", "Blocked"],
            ["Assignee", eng.full],
          ],
          {
            by: eng,
            text: "Root cause is in the vendor's parsing library. Vendor fix ETA is 18 Nov; no safe workaround our side.",
          },
        ),
        decoy: ticket(
          `BILL-${n + 1}`,
          "CSV export writes dates in US format",
          at(-1, 15),
          [
            ["Status", "Done"],
            ["Assignee", eng.full],
          ],
          { by: eng, text: "Fixed and deployed this morning." },
        ),
        detail: `BILL-${n}: the CSV import bug is blocked on a vendor fix due 18 November, so Friday can't be promised.`,
        falseClaim: "The CSV import fix is blocked on a vendor until 18 November.",
      };
    },
  },
  {
    name: "merch-minutes",
    make: ({ colleague }) => {
      const lead = colleague();
      const owner = colleague();
      const minutes = (date: string, decisions: string[]) => [
        `Date: ${date}. Attendees: ${lead.full}, ${owner.full}, Robin Carter.`,
        "",
        "Decisions:",
        ...decisions.map((d) => `- ${d}`),
      ];
      return {
        text: "Order the 200 branded hoodies for our booth at the trade show.",
        item: doc(
          "Marketing sync - minutes 21 Oct",
          at(-6),
          minutes("21 Oct 2026", [
            `Q4 merch budget cut to £1,500; hoodies dropped in favour of stickers and tote bags (owner: ${owner.full}).`,
            "Booth graphics reuse the spring design.",
          ]),
        ),
        decoy: doc(
          "Marketing sync - minutes 15 Apr",
          at(-195),
          minutes("15 Apr 2026", ["Hoodies approved for the summer events, 150 units.", "Booth graphics refreshed."]),
        ),
        detail:
          "The 21 October marketing sync dropped hoodies (merch budget cut to £1,500; stickers and totes instead).",
        falseClaim: "Hoodies were dropped from the merch plan.",
      };
    },
  },
];

/** Plants one item per template (the decisive item, or its decoy in the control variant) and returns the tasks. */
export function plantDev6a(world: World, seed: number, variant: Variant): HiddenTask[] {
  const r = new Rng(seed * 7919 + 601);
  const colleagues = r.sample(
    world.people.filter((p) => p.relation === "colleague"),
    1_000,
  );
  const clients = r.sample(
    world.people.filter((p) => p.relation === "client"),
    1_000,
  );
  let ci = 0;
  const usedOrgs = new Set<string>();
  const ctx: Ctx = {
    user: world.user,
    r,
    // Cycles through a shuffled list: distinct people within a template, as far as the world allows.
    colleague: () => colleagues[ci++ % colleagues.length]!,
    // One client per organisation, so a decoy about "another organisation" is never the same one.
    client: () => {
      const p = clients.find((c) => !usedOrgs.has(c.org!)) ?? clients[usedOrgs.size % clients.length]!;
      usedOrgs.add(p.org!);
      return p;
    },
    role: (role) => {
      const p = world.people.find((q) => q.role === role);
      if (!p) throw new Error(`dev6a: the world has no "${role}"`);
      return p;
    },
  };
  const suite = variant === "hidden" ? "dev6a" : "dev6a-control";
  return TEMPLATES.map((t) => {
    // Both variants are always built, so the draws (and the request text) are the same in each.
    const made = t.make(ctx);
    const p = variant === "hidden" ? made.item : made.decoy;
    const ref = `dev6a-${t.name}-${variant}`;
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
    return {
      id: `w${seed}:${suite}:${t.name}`,
      template: t.name,
      text: made.text,
      detail: variant === "hidden" ? made.detail : made.falseClaim,
    };
  });
}

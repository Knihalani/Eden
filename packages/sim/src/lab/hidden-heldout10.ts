/**
 * heldout10: a blind hidden-context suite, written after D79 by an author who had read only the world generator,
 * the Rng, the name and text banks, the suite registry and the `HiddenTask` interface. It is for measurement only:
 * never tune on it.
 *
 * Each of the 32 templates is a request an assistant would act on or answer, one planted item that should change
 * the answer, and a near-miss decoy that replaces it in the control variant (resolved, expired, or about another
 * entity or date). The request text is the same in both variants. The planted item relates to the request in one
 * of three ways, about a third each:
 *   - `none`: it shares no content word with the request (the link is a hop: "Mum" is Ruth Carter, "the marketing
 *     site" is northwind.co, a Peak District hike is out of signal);
 *   - `name`: it shares only a name (a person, a pet, a project, a domain);
 *   - `topic`: it shares a topic word ("incubator", "rapidplay", "fonts").
 * Themes were chosen away from the stock scenarios of earlier suites: hobbies and clubs, vehicles, gardens, pets,
 * volunteering, open source, lab work, music, peer review, DNS, warranties, recalls, neighbours, caring, culture,
 * tool retention quirks, on-call, image and font licences, customs.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import { emailText, chatText, threadBodies, type Message, type Who } from "../text";
import { DAY, NOW, type ItemKind, type Person, type World } from "../world";
import type { HiddenTask } from "./hidden-context";

type Link = "none" | "name" | "topic";

interface Planted {
  sourceId: "gmail" | "calendar" | "drive" | "slack";
  kind: ItemKind;
  title: string;
  text: string;
  /** When the item was last updated (always before the simulation's present). */
  at: number;
  /** A calendar item's start. */
  start?: number;
  /** A mail's participants other than the user, as a connector reports them. */
  people?: Who[];
}

interface Made {
  text: string;
  item: Planted;
  decoy: Planted;
  /** The consideration a good answer raises in the hidden variant. */
  detail: string;
  /** What an answer would wrongly claim in the control variant, misreading the decoy. */
  falseClaim: string;
}

interface Ctx {
  user: Person;
  rng: Rng;
  /** A person of the world by full name, or a stand-in with that name when the world has none. */
  who: (full: string, email?: string) => Who;
  colleagues: Person[];
}

/** 2026 dates in UTC: `d(10, 29, 8, 15)` is 29 October 08:15. */
const d = (month: number, day: number, h = 9, m = 0) => Date.UTC(2026, month - 1, day, h, m);

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (t: number) => `${pad(new Date(t).getUTCHours())}:${pad(new Date(t).getUTCMinutes())}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (t: number) => `${new Date(t).getUTCDate()} ${MONTHS[new Date(t).getUTCMonth()]}`;

/** A calendar description without a weekday, so a `none` or `name` item does not share the request's day word. */
function event(title: string, start: number, mins: number, where: string, notes: string): Planted {
  const end = start + mins * 60_000;
  return {
    sourceId: "calendar",
    kind: "event",
    title,
    text: `When: ${dayMonth(start)} 2026, ${hm(start)}–${hm(end)}\nWhere: ${where}\n\n${notes}`,
    // Created a little before it happens, and always before the simulation's present.
    at: Math.min(start - 9 * DAY, NOW - DAY),
    start,
  };
}

function mail(title: string, from: Who, to: Who, at: number, body: string, kind: ItemKind = "mail"): Planted {
  return { sourceId: "gmail", kind, title, text: emailText(from, to, at, body), at, people: [from] };
}

/** The last message of a mail thread, quoting the history before it as most clients do. */
function thread(rng: Rng, title: string, user: Who, messages: Message[]): Planted {
  const bodies = threadBodies(rng, messages);
  const last = messages[messages.length - 1]!;
  const others = [...new Set(messages.flatMap((m) => [m.from, m.to]))].filter((w) => w.email !== user.email);
  return {
    sourceId: "gmail",
    kind: "mail",
    title: messages.length > 1 ? `Re: ${title}` : title,
    text: emailText(last.from, last.to, last.at, bodies[bodies.length - 1]!),
    at: last.at,
    people: others,
  };
}

function doc(title: string, at: number, lines: string[]): Planted {
  return { sourceId: "drive", kind: "doc", title, text: lines.join("\n"), at };
}

function chat(channel: string, lines: { who: string; text: string; at: number }[]): Planted {
  return { sourceId: "slack", kind: "chat", title: channel, text: chatText(lines), at: lines[lines.length - 1]!.at };
}

const NOTICE_FOOTER =
  "You are receiving this because of your account settings. Manage notifications | Privacy | Help. " +
  "Please do not reply to this message; this mailbox is not monitored.";

const TEMPLATES: { name: string; link: Link; make: (c: Ctx) => Made }[] = [
  {
    name: "dns-transfer-lock",
    link: "none",
    make: ({ user, rng }) => {
      const reg: Who = { full: "Hostlane Domains", first: "Hostlane", email: "no-reply@hostlane-domains.com" };
      const ref = `TRF-${rng.token("0123456789", 7)}`;
      const body = (lines: string[]) => [`Hello ${user.full},`, ...lines, `Request ID: ${ref}`, NOTICE_FOOTER];
      return {
        text: "Point the marketing site at the new Vercel deployment tonight.",
        item: mail(
          "northwind.co: inter-registrar move in progress",
          reg,
          user,
          d(10, 24, 11, 5),
          body([
            "The move of northwind.co from Hostlane Domains to Cloudreg was approved on 24 Oct 2026.",
            "While it completes the zone is read-only: DNS records and nameservers cannot be edited at either " +
              "registrar. Completion is expected by 3 Nov 2026 at the latest. Edits submitted before then are rejected.",
          ]).join("\n\n"),
          "notification",
        ),
        decoy: mail(
          "northwind.co: inter-registrar move completed",
          reg,
          user,
          d(10, 2, 15, 40),
          body([
            "The move of northwind.co from Hostlane Domains to Cloudreg completed on 2 Oct 2026.",
            "DNS records and nameservers are editable again from your Cloudreg dashboard.",
          ]).join("\n\n"),
          "notification",
        ),
        detail:
          "northwind.co (the marketing site's domain) is mid-transfer between registrars and its DNS is read-only " +
          "until about 3 Nov, so the record cannot be repointed tonight",
        falseClaim: "that northwind.co's DNS is locked by a registrar transfer (the transfer completed on 2 Oct)",
      };
    },
  },
  {
    name: "font-embedding",
    link: "topic",
    make: () => {
      const register = (tiempos: string, sohne: string) =>
        doc("Font licence register", d(10, 20, 14), [
          "Font licence register (Design team, last reviewed 20 Oct 2026)",
          "",
          "| Family | Used in | Licence | Seats | Embedding / third-party output |",
          "|---|---|---|---|---|",
          "| Inter | web, slides | SIL OFL | n/a | permitted |",
          `| Tiempos Text | brochure body copy, annual report | ${tiempos} |`,
          `| Söhne | logo lockups, headings | ${sohne} |`,
          "| Source Serif 4 | internal docs | SIL OFL | n/a | permitted |",
          "",
          "Ask Design before using any family not on this list.",
        ]);
      return {
        text: "Send the print shop the brochure PDF with all fonts embedded so they can run it on Friday.",
        item: register(
          "Klim desktop | 4 | NOT permitted: a printer needs its own licence, or convert text to outlines before handoff",
          "Klim desktop | 4 | outlines only in files leaving the company",
        ),
        decoy: register(
          "Klim desktop + print/production add-on (bought 20 Oct) | 4 | permitted, incl. commercial printers",
          "Klim desktop + print/production add-on (bought 20 Oct) | 4 | permitted, incl. commercial printers",
        ),
        detail:
          "Tiempos Text, the brochure's body font, is licensed desktop-only: it may not be embedded in files sent " +
          "to a printer, so outline the text or have the printer license it",
        falseClaim: "that the brochure fonts cannot be embedded for the printer (the print add-on was bought 20 Oct)",
      };
    },
  },
  {
    name: "vet-nil-by-mouth",
    link: "name",
    make: () => {
      const notes =
        "Dental scale and polish, two extractions likely, under general anaesthetic.\n" +
        "Pre-op: nil by mouth from 22:00 the night before. Water is fine until drop-off.\n" +
        "Collect from 16:00. Bring his lead and the insurance form. Ref: Elm Lane Vets, patient 30418.";
      return {
        text: "What time should I give Biscuit his breakfast on Thursday?",
        item: event("Biscuit: dental at Elm Lane Vets", d(10, 29, 8, 15), 30, "Elm Lane Veterinary Surgery", notes),
        decoy: event("Biscuit: dental at Elm Lane Vets", d(10, 22, 8, 15), 30, "Elm Lane Veterinary Surgery", notes),
        detail:
          "Biscuit has a dental under general anaesthetic on Thursday 29 Oct (drop-off 08:15) and must have " +
          "nothing to eat from 22:00 the night before: no breakfast that morning",
        falseClaim: "that Biscuit must fast on Thursday (his dental was on 22 Oct and is done)",
      };
    },
  },
  {
    name: "grommets-water",
    link: "name",
    make: ({ user }) => {
      const ent: Who = {
        full: "Riverside Children's Hospital ENT",
        first: "ENT",
        email: "ent.letters@riverside-ch.nhs.uk",
      };
      return {
        text: "Book Maya into the 10:00 swimming lesson at the leisure centre this Saturday.",
        item: mail(
          "Discharge summary: Maya Carter",
          ent,
          user,
          d(10, 22, 17, 30),
          [
            "Discharge summary: Maya Carter (DOB 14/03/2017)",
            "Procedure: bilateral grommet insertion under GA, 22/10/2026. Uneventful.",
            "Aftercare: keep both ears dry. No pools, and no putting her head under water until she is reviewed " +
              "in clinic on 19/11/2026. Cotton wool with petroleum jelly for hair washing. Paracetamol as needed.",
            "Ring the ward on 020 7946 0321 if there is discharge with a smell, or a temperature above 38.",
          ].join("\n\n"),
        ),
        decoy: mail(
          "Clinic letter: Maya Carter",
          ent,
          user,
          d(10, 15, 12, 10),
          [
            "Clinic letter: Maya Carter (DOB 14/03/2017)",
            "Reviewed today, 15/10/2026, four months after bilateral grommet insertion. Both grommets in place and " +
              "patent, ears dry.",
            "No restrictions: pools are fine, earplugs optional. Discharged to GP; routine review in 12 months.",
          ].join("\n\n"),
        ),
        detail: "Maya had grommets fitted on 22 Oct and must not swim until her ENT review on 19 Nov",
        falseClaim: "that Maya cannot swim because of her grommets (she was cleared for swimming on 15 Oct)",
      };
    },
  },
  {
    name: "antibiotic-sleepover",
    link: "name",
    make: () => {
      const chart = (title: string, course: string, rows: string[], note: string) =>
        doc(title, d(10, 26, 8), [
          title,
          course,
          "",
          "| Date | 07:00 | 14:00 | 21:00 |",
          "|---|---|---|---|",
          ...rows,
          "",
          note,
        ]);
      return {
        text: "Tell Leila it's fine for Maya to sleep over at hers on Friday.",
        item: chart(
          "Maya: medicine chart (on the fridge)",
          "Amoxicillin 250 mg/5 ml oral suspension: 5 ml three times a day, 7-day course 26/10 to 01/11.",
          [
            "| 26/10 | ✓ | ✓ | ✓ |",
            "| 27/10 | ✓ | | |",
            "| 28/10 | | | |",
            "| 29/10 | | | |",
            "| 30/10 | | | |",
          ].concat(["| 31/10 | | | |", "| 01/11 | | | |"]),
          "Keep the bottle in the fridge. Don't skip doses; finish the course even if she seems better.",
        ),
        decoy: {
          ...chart(
            "Maya: medicine chart (on the fridge)",
            "Amoxicillin 250 mg/5 ml oral suspension: 5 ml three times a day, 7-day course 12/10 to 18/10.",
            ["| 12/10 | ✓ | ✓ | ✓ |", "| 13/10 | ✓ | ✓ | ✓ |", "| … | | | |", "| 18/10 | ✓ | ✓ | ✓ |"],
            "Course finished 18/10. Bottle returned to the pharmacy.",
          ),
          at: d(10, 18, 21),
        },
        detail:
          "Maya is on a 7-day amoxicillin course to 1 Nov (07:00, 14:00, 21:00, kept in the fridge): Leila needs the " +
          "medicine and the evening and morning doses for the sleepover",
        falseClaim: "that Maya needs medicine during the sleepover (her antibiotic course ended on 18 Oct)",
      };
    },
  },
  {
    name: "allotment-burning",
    link: "topic",
    make: ({ user, rng }) => {
      const sec: Who = { full: "Pat Greenhalgh", first: "Pat", email: "secretary@hillsideallotments.org.uk" };
      const derek: Who = { full: "Derek Moss", first: "Derek", email: "derek.moss58@btinternet.com" };
      const all: Who = { full: "Hillside plot holders", first: "all", email: "members@hillsideallotments.org.uk" };
      const make = (first: string, reply: string, close: string, t0: number) =>
        thread(rng, "Bonfires on site", user, [
          { from: sec, to: all, at: t0, body: [first], corporate: false },
          { from: derek, to: sec, at: t0 + 26 * 3_600_000, body: [reply], corporate: false },
          { from: sec, to: all, at: t0 + 30 * 3_600_000, body: [close], corporate: false },
        ]);
      return {
        text: "Remind me to burn the old bean canes and weeds at the Hillside plot on Sunday morning.",
        item: make(
          "Following two complaints from Ashby Road residents and a letter from the council, the committee has " +
            "agreed that from 1 November there is no burning of any kind on Hillside plots. A green waste skip " +
            "will be by the main gate from 7 November.",
          "What about blight-infected material? We were always told to burn it.",
          "Bag it and take it to the tip, Derek. No exceptions: plot holders who burn will get a warning letter, " +
            "and a second one means losing the plot.",
          d(10, 19, 18),
        ),
        decoy: make(
          "Now that we've had some proper rain, the dry-weather burning ban from July is lifted from 1 October. " +
            "Usual courtesy applies: small fires, attended, and out by dusk.",
          "Does that include blight-infected material?",
          "Yes, Derek, that's exactly what it's for.",
          d(9, 28, 18),
        ),
        detail:
          "Hillside Allotment Society banned all burning on plots from 1 Nov (green waste skip from 7 Nov), so " +
          "Sunday's bonfire isn't allowed",
        falseClaim: "that burning is banned on the Hillside plots (the dry-weather ban was lifted on 1 Oct)",
      };
    },
  },
  {
    name: "cracked-fork",
    link: "none",
    make: ({ user, rng }) => {
      const shop: Who = {
        full: "Spokes & Sprockets Workshop",
        first: "Spokes",
        email: "workshop@spokesandsprockets.co.uk",
      };
      const ticket = `W-${rng.int(4000, 4999)}`;
      const card = (status: string, findings: string[]) =>
        [
          `Workshop ticket #${ticket}`,
          "Customer: R. Carter | Item: Canyon Endurace CF 7 (frame no. WCF22-08817)",
          `Status: ${status}`,
          "",
          "Findings:",
          ...findings,
          "",
          "Questions? Reply to this email or call the workshop on 020 7946 0555.",
        ].join("\n");
      return {
        text: "Lend Jamie my road bike for Sunday's sportive.",
        item: mail(
          `Ticket #${ticket}: awaiting parts`,
          shop,
          user,
          d(10, 23, 16, 20),
          card("AWAITING PARTS", [
            "- Hairline crack at the fork crown found during the full service. UNSAFE TO RIDE.",
            "- Replacement fork ordered from Canyon, ETA 9 to 13 Nov.",
            "- It stays with us until the fork is fitted; please don't collect it to ride in the meantime.",
          ]),
        ),
        decoy: mail(
          `Ticket #${ticket}: collected`,
          shop,
          user,
          d(10, 21, 12, 5),
          card("COLLECTED 21/10", [
            "- Replacement fork fitted, headset regreased, torque-checked to spec.",
            "- Test-ridden by the mechanic: all good. Paid in full.",
          ]),
        ),
        detail:
          "the road bike (Canyon Endurace) is in the workshop with a cracked fork, unsafe to ride, with the new fork " +
          "due 9-13 Nov: it can't be lent for Sunday",
        falseClaim:
          "that the road bike is unsafe or in the workshop (the fork was replaced and it was collected 21 Oct)",
      };
    },
  },
  {
    name: "washer-warranty",
    link: "topic",
    make: () => {
      const cert = (from: string, to: string, at: number) =>
        doc("Bosch washing machine: extended warranty certificate", at, [
          "Bosch Serie 6 washing machine WGG244A9GB, serial 0412-8833-5571",
          `Extended warranty: parts and labour, from ${from} to ${to}.`,
          "Conditions:",
          "1. Repairs must be booked through Bosch Service on 0344 000 1234 or online.",
          "2. Any repair or attempted repair by a third party voids this cover.",
          "3. Accidental damage and consumables (filters, seals) are not covered.",
        ]);
      return {
        text: "Which local repair shop is cheapest for fixing the washing machine's noisy drum bearing?",
        item: cert("14/03/2024", "13/03/2029", d(3, 20)),
        decoy: cert("14/03/2023", "13/03/2025", Date.UTC(2023, 2, 20, 9)),
        detail:
          "the washing machine is under a Bosch warranty to March 2029 that a third-party repair would void: book " +
          "Bosch Service (free) instead of a local shop",
        falseClaim: "that the washing machine is under warranty (it expired on 13 Mar 2025)",
      };
    },
  },
  {
    name: "oss-embargo",
    link: "name",
    make: ({ user, rng }) => {
      const gh: Who = { full: "GitHub", first: "GitHub", email: "notifications@github.com" };
      const ghsa = `GHSA-${rng.token("23456789cfghjmpqrvwx", 4)}-${rng.token("23456789cfghjmpqrvwx", 4)}`;
      return {
        text: "Tag tinyparse v3.2.0 and publish the release notes today.",
        item: mail(
          `[tinyparse] Draft security advisory ${ghsa}`,
          gh,
          user,
          d(10, 20, 10, 12),
          [
            `Draft advisory ${ghsa}: out-of-bounds read in the chunk decoder (severity: high).`,
            "Coordinated disclosure: 3 Nov 2026, 14:00 UTC, agreed with the Debian and Fedora security teams.",
            "Until then do not merge the private fork, ship packages that contain the patch, or mention the issue " +
              "or its commit anywhere public.",
            NOTICE_FOOTER,
          ].join("\n\n"),
          "notification",
        ),
        decoy: mail(
          `[tinyparse] Security advisory ${ghsa} published`,
          gh,
          user,
          d(10, 13, 15, 2),
          [
            `Advisory ${ghsa} (out-of-bounds read in the chunk decoder) was published on 13 Oct 2026.`,
            "Patched in 3.1.4. CVE-2026-41877 assigned. Dependabot alerts have gone out to dependents.",
            NOTICE_FOOTER,
          ].join("\n\n"),
          "notification",
        ),
        detail:
          "tinyparse has an embargoed security advisory (disclosure 3 Nov 14:00 UTC): a release containing the fix " +
          "must not go out or be described publicly before then",
        falseClaim: "that the tinyparse release is under a security embargo (the advisory was published on 13 Oct)",
      };
    },
  },
  {
    name: "incubator-decon",
    link: "topic",
    make: ({ who }) => {
      const nadia = who("Nadia Petrova").first;
      const tanaka = who("Aiko Tanaka").first;
      return {
        text: "Put the HEK293 plates in incubator 2 when I get to the lab tomorrow morning.",
        item: chat("#lab-ops", [
          { who: nadia, text: "heads up all: incubator 2 failed its CO2 check today", at: d(10, 26, 16, 41) },
          {
            who: nadia,
            text: "and there's fungal growth on the bottom shelf. out of service for decon",
            at: d(10, 26, 16, 42),
          },
          { who: tanaka, text: "how long?", at: d(10, 26, 16, 50) },
          {
            who: nadia,
            text: "until Friday at least. use incubator 4, top two shelves are free",
            at: d(10, 26, 16, 52),
          },
        ]),
        decoy: chat("#lab-ops", [
          { who: nadia, text: "incubator 2 decon is done, recalibrated at 5% CO2", at: d(10, 26, 11, 3) },
          {
            who: nadia,
            text: "back in service as of now, shelves wiped. thanks for your patience",
            at: d(10, 26, 11, 4),
          },
          { who: tanaka, text: "🙌", at: d(10, 26, 11, 9) },
        ]),
        detail: "incubator 2 is out of service for decontamination until at least Friday; use incubator 4",
        falseClaim: "that incubator 2 is out of service (it was back in service on 26 Oct)",
      };
    },
  },
  {
    name: "review-conflict",
    link: "name",
    make: ({ user, rng, who }) => {
      const hana = who("Hana Kim", "hana.kim@cs.kcl.ac.uk");
      const at = Date.UTC(2025, 5, 12, 8, 40);
      return {
        text: "Accept the program committee's assignment to review submission #412 from Hana Kim's group.",
        item: thread(rng, "VLDB!!", user, [
          {
            from: hana,
            to: user,
            at,
            body: [
              "Fantastic news: our paper 'Streaming joins under memory pressure' (Kim, Carter, Okonkwo) got into " +
                "VLDB 2025!",
              "Camera-ready is due 1 July. I'll take the intro and related work if you can tighten section 4.",
            ],
            corporate: false,
          },
          {
            from: user,
            to: hana,
            at: at + 3 * 3_600_000,
            body: ["Brilliant! Section 4 is mine, I'll send it to you by the 24th."],
            corporate: false,
          },
        ]),
        decoy: mail(
          "Lyon",
          hana,
          user,
          Date.UTC(2025, 8, 20, 18),
          "Hi Robin,\n\nGreat to meet you at the poster session in Lyon, I enjoyed your talk on cost models. " +
            "If you're ever at King's, come and say hello.\n\nHana",
        ),
        detail:
          "Robin co-authored a VLDB 2025 paper with Hana Kim, a conflict of interest under usual PC rules: declare it " +
          "and decline the review instead of accepting",
        falseClaim: "that Robin has a conflict of interest with Hana Kim (they only met at a conference)",
      };
    },
  },
  {
    name: "choir-venue",
    link: "name",
    make: ({ user }) => {
      const sec: Who = { full: "Margaret Ellison", first: "Margaret", email: "cantilena.secretary@gmail.com" };
      const to: Who = { full: "Cantilena members", first: "all", email: "cantilena-members@googlegroups.com" };
      return {
        text: "Put Cantilena's Wednesday rehearsal in my calendar at the usual 19:00 in St Mary's church hall.",
        item: mail(
          "Cantilena: this week only",
          sec,
          to,
          d(10, 26, 20, 15),
          "Dear all,\n\nThis week (the 28th) we're in the crypt at St Anne's, Dean Street, starting at 19:30 sharp, " +
            "because the organ is being tuned. Bring the Fauré and a pencil. Back to normal the following week." +
            `\n\nMargaret\n\nTo: ${user.full} and 41 others`,
        ),
        decoy: mail(
          "Cantilena: tonight only",
          sec,
          to,
          d(10, 21, 12, 30),
          "Dear all,\n\nTonight (the 21st) we're in the crypt at St Anne's, Dean Street, from 19:30, because the " +
            `organ is being tuned. Back to normal next week.\n\nMargaret\n\nTo: ${user.full} and 41 others`,
        ),
        detail:
          "this Wednesday (28 Oct) only, Cantilena meets at 19:30 in the crypt at St Anne's, Dean Street, not 19:00 " +
          "at St Mary's",
        falseClaim: "that this week's rehearsal has moved (the crypt change was for 21 Oct only)",
      };
    },
  },
  {
    name: "gig-backline",
    link: "topic",
    make: ({ user, rng }) => {
      const promoter: Who = { full: "Kez Obi", first: "Kez", email: "kez@southpawpromotions.co.uk" };
      const drummer: Who = { full: "Tash Reilly", first: "Tash", email: "tash.reilly@gmail.com" };
      const make = (venue: string, date: string, at: number) =>
        thread(rng, `Advance: ${venue}, ${date}`, user, [
          {
            from: promoter,
            to: drummer,
            at,
            body: [
              `Advancing ${venue} on ${date}. Load-in 18:00, doors 19:30, you're on second at 20:45 for 40 minutes.`,
              "Backline: the house provides an Ampeg SVT-4 head with an 8x10 cab for bass and a Gretsch kit " +
                "(bring breakables). Guitarists bring their own amps.",
            ],
            corporate: false,
          },
          {
            from: drummer,
            to: promoter,
            at: at + 5 * 3_600_000,
            body: ["Perfect, so our bassist can leave the amp at home and just bring the pedalboard and DI."],
            corporate: false,
          },
        ]);
      return {
        text: "Do I need to bring my bass amp to the Half Moon gig on Saturday?",
        item: make("the Half Moon", "Saturday 31 Oct", d(10, 22, 11)),
        decoy: make("the Windmill", "Saturday 12 Dec", d(10, 24, 11)),
        detail: "the Half Moon provides a house bass rig (Ampeg SVT-4 + 8x10) on Saturday: no amp needed, just pedals",
        falseClaim: "that the Half Moon provides a bass rig (the house rig is at the Windmill on 12 Dec)",
      };
    },
  },
  {
    name: "oncall-week",
    link: "none",
    make: ({ user, rng, colleagues }) => {
      const [a, b, c] = rng.sample(colleagues, 3);
      const rota = (w45: string, w47: string) =>
        doc("Platform on-call rota: Q4", d(10, 5), [
          "Platform on-call rota, Q4 2026 (handover Mondays 10:00)",
          "",
          "| Wk | From | To | Primary | Secondary |",
          "|---|---|---|---|---|",
          `| 44 | 26/10 | 02/11 | ${a!.full} | ${b!.full} |`,
          `| 45 | 02/11 | 09/11 | ${w45} | ${c!.full} |`,
          `| 46 | 09/11 | 16/11 | ${b!.full} | ${a!.full} |`,
          `| 47 | 16/11 | 23/11 | ${w47} | ${b!.full} |`,
          "",
          "Primary acks pages within 15 minutes and stays within 30 minutes of a laptop with mobile signal.",
          "Swaps: agree with someone, then update PagerDuty and this table.",
        ]);
      return {
        text: "Plan a full-day hike in the Peak District with Jamie on Saturday 7 November.",
        item: rota(user.full, c!.full),
        decoy: rota(c!.full, user.full),
        detail:
          "Robin is primary on-call for week 45 (2-9 Nov, which includes Sat 7 Nov) and must ack pages within 15 " +
          "minutes with a laptop and signal: swap the shift or pick another date",
        falseClaim: "that Robin is on call on 7 Nov (Robin's primary week is 47, 16-23 Nov)",
      };
    },
  },
  {
    name: "foodbank-shift",
    link: "none",
    make: ({ user }) => {
      const coord: Who = { full: "Bernadette Quinn", first: "Bernadette", email: "rota@riversidefoodbank.org" };
      const rota = (sun1: string, sun8: string, at: number) =>
        mail(
          "Warehouse rota + van keys",
          coord,
          user,
          at,
          [
            "Hi all, here's the warehouse rota for the next fortnight. Shout if anything clashes.",
            [
              "| Date | Shift | Volunteers |",
              "|---|---|---|",
              "| Sat 31/10 | 09:00-12:00 | Yusuf D., Grace L. |",
              `| Sun 01/11 | 11:00-15:00 | ${sun1} |`,
              "| Sat 07/11 | 09:00-12:00 | Mia R., Kofi B. |",
              `| Sun 08/11 | 11:00-15:00 | ${sun8} |`,
            ].join("\n"),
            "Whoever leads a weekend van run collects the keys from me the day before.",
            "Bernadette",
          ].join("\n\n"),
        );
      return {
        text: "Accept Ellie's invitation to Sunday lunch on 1 November.",
        item: rota("Robin C. (leads the van run), Mia R.", "Yusuf D., Tomás S.", d(10, 24, 10)),
        decoy: rota("Yusuf D., Tomás S.", "Robin C. (leads the van run), Mia R.", d(10, 24, 10)),
        detail:
          "Robin is on the food bank warehouse rota 11:00-15:00 on Sunday 1 Nov and leads the van run: find cover " +
          "or move the lunch",
        falseClaim: "that Robin has a food bank shift on 1 Nov (Robin's shift is 8 Nov)",
      };
    },
  },
  {
    name: "shabbat-sundown",
    link: "name",
    make: ({ user, who }) => {
      const dan = who("Daniel Cohen");
      const ethan = who("Ethan Brooks");
      const note = (from: Who) =>
        mail(
          "Planning for the winter",
          from,
          user,
          d(9, 3, 9, 30),
          `Hi Robin,\n\nSmall heads-up for planning: I keep Shabbat, so once the clocks go back I'm offline from ` +
            "mid-afternoon at the end of the week (sundown is around 16:20 once the clocks have changed). Anything that " +
            `needs me should finish by 15:30 on those days.\n\nThanks for being accommodating,\n${from.first}`,
        );
      return {
        text: "Set up the workshop with Daniel Cohen for Friday 6 November, 15:00 to 18:00, and send him the invite.",
        item: note(dan),
        decoy: note(ethan),
        detail:
          "Daniel keeps Shabbat, which starts around 16:20 on Friday in early November: he needs to finish by 15:30, " +
          "so move the workshop earlier or to another day",
        falseClaim: "that Daniel Cohen keeps Shabbat (it was Ethan Brooks who said so)",
      };
    },
  },
  {
    name: "photo-licence",
    link: "topic",
    make: ({ rng }) => {
      const id = rng.int(1_200_000_000, 1_299_999_999);
      const register = (licence: string, use: string) =>
        doc("Image licences", d(7, 3, 11), [
          "Image licences (Brand team)",
          "",
          "| Image | Stockshot ID | Licence | Permitted use | Expires |",
          "|---|---|---|---|---|",
          `| London skyline at dusk (photo) | ${id} | ${licence} | ${use} |`,
          "| Team offsite group shot | own | n/a | any | n/a |",
          "| Abstract gradient 04 | 88123011 | Royalty-free standard | any, < 500k print run | perpetual |",
        ]);
      return {
        text: "Use the London skyline photo from the Q3 board deck as the hero image on the public homepage.",
        item: register("Rights-managed", "internal presentations only; web and marketing NOT licensed | 03/07/2027"),
        decoy: register("Royalty-free extended", "any media incl. web, ads and merchandise | perpetual"),
        detail:
          "the skyline photo is rights-managed for internal presentations only: web use isn't licensed and needs a " +
          "new licence",
        falseClaim: "that the skyline photo isn't licensed for the website (it has an extended royalty-free licence)",
      };
    },
  },
  {
    name: "returned-goods-customs",
    link: "name",
    make: ({ user, who }) => {
      const lars = who("Lars Nilsen");
      return {
        text: "Ship Lars's Juno-106 back to Oslo now it's fixed, cheapest tracked service.",
        item: mail(
          "Paperwork for the way home",
          lars,
          user,
          d(10, 16, 19, 10),
          "Hei Robin,\n\nOne thing before the Roland comes home: please put it on the paperwork as 'returned goods " +
            "after repair' and declare only your invoice (£180) as the value. Otherwise Tolletaten charges 25% VAT " +
            "on the whole ~£1,400. And it needs a courier that does the clearance for me (DHL or UPS); Posten " +
            "parcels sit in customs for weeks and they'll assess the full value.\n\nTakk!\nLars",
        ),
        decoy: mail(
          "Pedal arrived",
          lars,
          user,
          d(9, 30, 19, 10),
          "Hei Robin,\n\nThe Jupiter pedal you posted in September arrived today, customs all settled and paid " +
            "on my side. Sounds great, thanks!\n\nLars",
        ),
        detail:
          "Lars asked for it to be declared as returned goods after repair with only the £180 repair as value, " +
          "sent by a courier that clears customs (DHL/UPS), not the cheapest post, or he pays 25% VAT on ~£1,400",
        falseClaim:
          "that the return needs special customs paperwork (Lars's message was about a pedal already delivered)",
      };
    },
  },
  {
    name: "boundary-agreement",
    link: "none",
    make: () => {
      const base = [
        "Boundary agreement: 12 and 14 Ashby Road (signed 3 May 2024)",
        "",
        "1. The conifer screen on the rear boundary is jointly owned by both households.",
        "2. Neither household will fell, remove or reduce it below 2 m without the other's written consent.",
        "3. Trimming costs are split equally; whoever arranges the work gets two quotes first.",
        "",
        "Signed: Robin Carter (No. 12); Funmi and Kayode Okoro (No. 14)",
      ];
      return {
        text: "Get the tree surgeon round on Monday to take down the leylandii along the back fence.",
        item: doc("Boundary agreement, 12 & 14 Ashby Road", Date.UTC(2024, 4, 3, 12), base),
        decoy: doc("Boundary agreement, 12 & 14 Ashby Road", d(10, 18, 12), [
          ...base,
          "",
          "Addendum (18 Oct 2026): Funmi and Kayode Okoro give their written consent to the conifer screen being " +
            "felled at No. 12's cost, provided timber panels replace it. Signed F.O., K.O.",
        ]),
        detail:
          "the leylandii are a jointly owned screen under a signed boundary agreement: felling them needs the " +
          "Okoros' (No. 14) written consent first",
        falseClaim: "that felling the conifers still needs the Okoros' consent (they gave it in writing on 18 Oct)",
      };
    },
  },
  {
    name: "midday-insulin",
    link: "none",
    make: () => {
      const plan = (visits: string, midday: string, at: number) =>
        doc("Care plan: Ruth Carter", at, [
          "Care plan: Ruth Carter, 4 Mill Lane (Brightwell Home Care)",
          `Visits: ${visits}`,
          "",
          midday,
          "If Ruth will be away from home at a visit time, phone the office on 01632 960 118 before 18:00 the " +
            "previous day so the visit can be rearranged.",
          "Falls risk: walking frame indoors and out.",
        ]);
      return {
        text: "Take Mum out for a long lunch at Dishoom on Sunday, table for two at 13:00.",
        item: plan(
          "08:00 (30 min), 12:15-12:45, 18:00 (30 min), 21:00 (15 min)",
          "Midday visit: the carer gives her NovoRapid insulin with her meal and checks her blood sugar. Missed " +
            "insulin needs GP advice.",
          d(10, 14, 15),
        ),
        decoy: plan(
          "08:00 (30 min), 18:00 (30 min), 21:00 (15 min)",
          "Changed 20/10: the midday visit has stopped. Long-acting insulin is now given at the 08:00 visit only.",
          d(10, 20, 15),
        ),
        detail:
          "Ruth (Mum) has a carer visit 12:15-12:45 for her midday insulin with a meal: tell Brightwell by 18:00 the " +
          "day before and plan the insulin around the 13:00 lunch",
        falseClaim: "that Mum's midday insulin visit has to be rearranged (the midday visit stopped on 20 Oct)",
      };
    },
  },
  {
    name: "rapidplay-bye",
    link: "topic",
    make: ({ user }) => {
      const tc: Who = { full: "Graham Pike", first: "Graham", email: "controller@kingstonchessclub.org.uk" };
      const pairings = (date: string, at: number) =>
        mail(
          `Rapidplay ${date}: round 1 pairings`,
          tc,
          user,
          at,
          [
            `Kingston Chess Club Rapidplay, ${date}. Open section, round 1 pairings:`,
            [
              "| Bd | White | Black |",
              "|---|---|---|",
              "| 1 | S. Akhtar (2105) | J. Lowe (1880) |",
              "| 2 | P. Doyle (1842) | M. Fenwick (2011) |",
              "| 3 | H. Grant (1795) | T. Ashworth (1790) |",
              "| … | … | … |",
              "| 17 | K. Mensah (1402) | B. Hale (1388) |",
            ].join("\n"),
            "Bye (half point, odd numbers): R. Carter.",
            "Round times: R1 10:00, R2 11:30, R3 13:30, R4 15:00. Clocks 15+10. Please arrive 15 minutes early.",
            "Graham (TC)",
          ].join("\n\n"),
        );
      return {
        text: "What time is my first game at the club rapidplay on Saturday?",
        item: pairings("Sat 31 Oct", d(10, 26, 21)),
        decoy: pairings("Sat 26 Sep", d(9, 24, 21)),
        detail: "Robin has a half-point bye in round 1, so the first game is round 2 at 11:30, not 10:00",
        falseClaim: "that Robin has a round-1 bye on Saturday (that bye was at the September rapidplay)",
      };
    },
  },
  {
    name: "squash-ladder",
    link: "topic",
    make: ({ user }) => {
      const cap: Who = { full: "Imogen Fairley", first: "Imogen", email: "captain@ealingsquash.club" };
      const ladder = (rows: string[]) =>
        mail(
          "Winter leagues: entries and the new rule",
          cap,
          user,
          d(10, 25, 19),
          [
            "Hi all, winter league entries close on 1 November.",
            "New rule this season, agreed at the AGM: anyone in the top 20 of the ladder on 1 November plays in " +
              "the A league. Everyone else may choose A or B.",
            ["Current ladder (extract):", "| Pos | Player |", "|---|---|", ...rows].join("\n"),
            "Imogen (club captain)",
          ].join("\n\n"),
        );
      return {
        text: "Enter me in the B league for the winter season at the squash club.",
        item: ladder(["| 16 | N. Brandt |", "| 17 | A. Chen |", "| 18 | R. Carter |", "| 19 | O. Hughes |"]),
        decoy: ladder(["| 19 | O. Hughes |", "| 20 | P. Sandhu |", "| … | … |", "| 26 | R. Carter |"]),
        detail: "Robin is 18th on the ladder and the new rule puts the top 20 on 1 Nov in the A league, not B",
        falseClaim: "that Robin must play in the A league (Robin is 26th, outside the top 20)",
      };
    },
  },
  {
    name: "timing-belt",
    link: "none",
    make: ({ rng }) => {
      const job = rng.int(7000, 7999);
      const card = (lines: string[], at: number) =>
        doc(`Halford Road Garage: job card ${job}`, at, [
          `Halford Road Garage: job card ${job}`,
          "VW Golf 1.5 TSI, reg WK19 HZP. Customer: R. Carter",
          ...lines,
        ]);
      return {
        text: "Drive up to Edinburgh on Friday 6 November and back on the Sunday.",
        item: card(
          [
            "Odometer: 59,640 mi",
            "Advisory (AMBER): timing belt and water pump due at 60,000 mi or 7 years (fitted 2019).",
            "Recommend replacing before any long journey: if it snaps the engine is written off.",
            "Quote: £520, one working day. Customer to book.",
          ],
          d(10, 12, 16),
        ),
        decoy: card(
          [
            "Odometer: 59,610 mi",
            "Work done 09/10: timing belt, tensioner and water pump replaced. Next due at 119,610 mi.",
            "No advisories.",
          ],
          d(10, 9, 16),
        ),
        detail:
          "the car is at ~59,640 miles with the timing belt due at 60,000: the ~800-mile Edinburgh round trip takes " +
          "it past, so get the belt replaced first",
        falseClaim: "that the timing belt is due (it was replaced on 9 Oct)",
      };
    },
  },
  {
    name: "recording-retention",
    link: "topic",
    make: ({ user }) => {
      const zoom: Who = { full: "Zoom", first: "Zoom", email: "no-reply@zoom.us" };
      const notice = (year: number, at: number) =>
        mail(
          "Cloud recordings deleted under your retention policy",
          zoom,
          user,
          at,
          [
            "Your account's cloud recording policy deletes recordings automatically 120 days after they were made.",
            `6 recordings were moved to trash and permanently deleted 30 days later, including 'Initech kickoff' ` +
              `(14 May ${year}) and 'Partner sync' (2 Jun ${year}).`,
            "Deleted recordings cannot be recovered. Your admin can change the policy under Settings > Recording.",
            NOTICE_FOOTER,
          ].join("\n\n"),
          "notification",
        );
      return {
        text: "Can you dig out the Zoom recording of the Initech kickoff from 14 May and share it with Bo?",
        item: notice(2026, d(10, 11, 3)),
        decoy: notice(2025, Date.UTC(2025, 9, 11, 3)),
        detail:
          "Zoom's 120-day retention deleted the 14 May Initech kickoff recording (permanently, by 11 Oct): it can't " +
          "be shared",
        falseClaim: "that this year's 14 May kickoff recording was deleted (the deleted one was from May 2025)",
      };
    },
  },
  {
    name: "chat-history-limit",
    link: "none",
    make: () => ({
      text: "What did Marcus say about Kestrel pricing in #partners back in June?",
      item: chat("#general", [
        {
          who: "Slackbot",
          text:
            "Northwind's workspace moved to the Free plan on 1 Aug. Messages and files older than 90 days are now " +
            "hidden. Upgrade within a year to restore them.",
          at: d(8, 1, 0, 5),
        },
      ]),
      decoy: chat("#general", [
        {
          who: "Slackbot",
          text:
            "Northwind's workspace upgraded to Pro on 20 Oct. All message and file history is available again, " +
            "including anything hidden while on the Free plan.",
          at: d(10, 20, 0, 5),
        },
      ]),
      detail:
        "the workspace has been on the free plan since 1 Aug, so June messages are hidden (90-day limit) and can't " +
        "be retrieved unless it is upgraded",
      falseClaim: "that June's messages are hidden by the free plan (Pro was restored on 20 Oct)",
    }),
  },
  {
    name: "cat-thyroid",
    link: "name",
    make: ({ user }) => {
      const vet: Who = { full: "Dr Helen Marsh", first: "Helen", email: "helen.marsh@elmlanevets.co.uk" };
      return {
        text: "Ask Jamie to feed Pepper while I'm in Lisbon next weekend.",
        item: mail(
          "Pepper's blood results",
          vet,
          user,
          d(10, 23, 14, 20),
          "Hi Robin,\n\nPepper's T4 is still raised, so please carry on with the methimazole: 2.5 mg twice daily, " +
            "12 hours apart, with a meal. Please don't let doses lapse, even for a day or two, as her heart rate " +
            "climbs quickly. Recheck bloods on 20 Nov.\n\nHelen Marsh MRCVS\nElm Lane Veterinary Surgery",
        ),
        decoy: mail(
          "Pepper's blood results",
          vet,
          user,
          d(10, 23, 14, 20),
          "Hi Robin,\n\nGood news: Pepper's T4 is back in the normal range after the radioiodine, so you can stop " +
            "the methimazole now. No more tablets, and no recheck needed until her annual.\n\nHelen Marsh MRCVS",
        ),
        detail:
          "Pepper needs methimazole 2.5 mg twice daily, 12 hours apart, with a meal, and must not miss doses: Jamie " +
          "has to give her tablets too",
        falseClaim: "that Pepper needs tablets while Robin is away (the vet stopped them)",
      };
    },
  },
  {
    name: "org-2fa",
    link: "name",
    make: ({ user, who }) => {
      const olu = who("Olu Adebayo");
      const gh: Who = { full: "GitHub", first: "GitHub", email: "noreply@github.com" };
      return {
        text: "Add Olu as a maintainer on the quillmark repo so he can merge and cut releases.",
        item: mail(
          "[quill-collective] Members without two-factor authentication",
          gh,
          user,
          d(10, 22, 7),
          [
            "The quill-collective organisation now requires two-factor authentication.",
            `These accounts don't have it enabled: ${olu.full} (@${olu.first.toLowerCase()}ade).`,
            "They cannot be invited to teams or given repository roles, and will be removed from the organisation " +
              "on 5 Nov 2026 unless they enable it.",
            NOTICE_FOOTER,
          ].join("\n\n"),
          "notification",
        ),
        decoy: mail(
          "[quill-collective] Two-factor authentication enabled",
          gh,
          user,
          d(10, 22, 7),
          [
            `${olu.full} (@${olu.first.toLowerCase()}ade) has enabled two-factor authentication.`,
            "All members of quill-collective now meet the organisation's 2FA requirement.",
            NOTICE_FOOTER,
          ].join("\n\n"),
          "notification",
        ),
        detail:
          "the org requires 2FA and Olu hasn't enabled it, so he can't be given a repo role (and is removed on 5 Nov) " +
          "until he turns it on",
        falseClaim: "that Olu can't be added because of 2FA (he has enabled it)",
      };
    },
  },
  {
    name: "domain-registrant",
    link: "name",
    make: ({ who }) => {
      const bo = who("Bo Jensen").first;
      const al = who("Al Chen").full;
      return {
        text: "Who should I ask to renew kestrelapp.io before it lapses on 20 November?",
        item: chat("#ops", [
          { who: bo, text: `so it turns out kestrelapp.io never moved to the company Namecheap`, at: d(10, 19, 15, 2) },
          { who: bo, text: `it's still on ${al}'s personal account, his login and his card`, at: d(10, 19, 15, 3) },
          {
            who: bo,
            text: "he left in March but still answers on LinkedIn. nobody here can touch it",
            at: d(10, 19, 15, 3),
          },
        ]),
        decoy: chat("#ops", [
          { who: bo, text: `done: moved kestrelapp.io off ${al}'s personal account`, at: d(10, 19, 15, 2) },
          {
            who: bo,
            text: "it's in the company Namecheap now, finance card on file, auto-renew on",
            at: d(10, 19, 15, 3),
          },
        ]),
        detail:
          `kestrelapp.io is still in ${al}'s personal registrar account (he left in March): only he can renew it or ` +
          "move it to the company account, so contact him",
        falseClaim: `that only ${al} can renew kestrelapp.io (it was moved to the company account)`,
      };
    },
  },
  {
    name: "dryer-modification",
    link: "none",
    make: ({ user, rng }) => {
      const maker: Who = {
        full: "Calder Appliances Safety Team",
        first: "Calder",
        email: "safety@calder-appliances.co.uk",
      };
      const serial = `CDV780-${rng.token("0123456789", 8)}`;
      return {
        text: "Run the tumble dryer overnight on Friday while we're away.",
        item: mail(
          "Important safety notice for your registered appliance",
          maker,
          user,
          d(10, 20, 10),
          [
            `Registered appliance: Calder CDV-780 condenser, serial ${serial}.`,
            "A fault in this model can let fluff reach the heating element. Until our engineer fits the free " +
              "modification (booked for 12 Nov, 08:00-13:00), only use it while you are at home and awake, and " +
              "clean the filter after every cycle.",
            NOTICE_FOOTER,
          ].join("\n\n"),
          "notification",
        ),
        decoy: mail(
          "Your appliance modification is complete",
          maker,
          user,
          d(10, 3, 15),
          [
            `Registered appliance: Calder CDV-780 condenser, serial ${serial}.`,
            "Our engineer fitted the safety modification on 3 Oct. Your appliance is safe to use normally.",
            NOTICE_FOOTER,
          ].join("\n\n"),
          "notification",
        ),
        detail:
          "the dryer is under a fire-risk safety notice: until the modification on 12 Nov it must only run while " +
          "someone is home and awake, so not overnight while away",
        falseClaim: "that the dryer can't run unattended (the safety modification was fitted on 3 Oct)",
      };
    },
  },
  {
    name: "ethics-sharing",
    link: "topic",
    make: () => {
      const base = [
        "Ethics approval REC-26/114: 'Small-business adoption of AI agents' (pilot study)",
        "Approved 2 Jun 2026. Principal investigator: R. Carter.",
        "Conditions:",
        "4. Interview transcripts, including pseudonymised ones, may be shared only with the named research " +
          "team: R. Carter, A. Okonkwo.",
        "5. Sharing with anyone else, including external coders, needs an approved amendment.",
        "6. Transfer only through the university SharePoint, never by email.",
      ];
      return {
        text: "Email the pilot study interview transcripts to Grace Liu at Initech so she can help code them.",
        item: doc("REC-26/114 approval conditions", d(6, 2, 12), base),
        decoy: doc("REC-26/114 approval conditions", d(10, 19, 12), [
          ...base.slice(0, 3),
          "Amendment 1 (approved 19 Oct 2026) replaces conditions 4-6: Grace Liu (Initech) joins the research team " +
            "as a coder, and transcripts may be sent to the team by encrypted email.",
        ]),
        detail:
          "the ethics approval allows transcripts only within the named team (not Grace Liu) and never by email: an " +
          "amendment is needed first, and transfer must use SharePoint",
        falseClaim: "that Grace Liu can't receive the transcripts (amendment 1 added her on 19 Oct)",
      };
    },
  },
  {
    name: "teatime-visit",
    link: "none",
    make: () => {
      const notes =
        "Carers leave at 17:00. Stay until Ellie arrives at 19:00: Mum mustn't be on her own in the evenings " +
        "since the fall. Her tea is in the freezer, 25 min in the oven.";
      return {
        text: "Accept Mateo's invite for a call on Thursday at 17:30.",
        item: event("Teatime with Ruth (my turn)", d(10, 29, 17), 120, "4 Mill Lane", notes),
        decoy: event("Teatime with Ruth (my turn)", d(11, 5, 17), 120, "4 Mill Lane", notes),
        detail:
          "Robin is with Mum (Ruth) 17:00-19:00 on Thursday 29 Oct because she mustn't be left alone: decline or " +
          "move the 17:30 call",
        falseClaim: "that Robin is with Mum on Thursday 29 Oct (that visit is on 5 Nov)",
      };
    },
  },
  {
    name: "apiary-treatment",
    link: "none",
    make: () => {
      const notes =
        "Oxalic acid vaporising, all three colonies. Wear the respirator and goggles. Keep people and pets at " +
        "least 10 m away during and for an hour after; colonies will be defensive for the rest of the day.";
      return {
        text: "Can Leila bring her kids round to see the beehives on Saturday afternoon?",
        item: event("Apiary: varroa treatment", d(10, 31, 13), 120, "Bottom of the garden", notes),
        decoy: event("Apiary: varroa treatment", d(10, 17, 13), 120, "Bottom of the garden", notes),
        detail:
          "the colonies are being treated with oxalic acid vapour 13:00-15:00 on Saturday 31 Oct and will be " +
          "defensive afterwards: keep visitors 10 m away, so not that afternoon",
        falseClaim: "that the bees are being treated on Saturday (the treatment was on 17 Oct)",
      };
    },
  },
];

/**
 * Plants one item per template (the hidden item, or the decoy for the control variant) and returns the tasks. The
 * request text does not depend on the variant.
 */
export function plantHeldout10(world: World, seed: number, variant: "hidden" | "control"): HiddenTask[] {
  const rng = new Rng(seed * 7919 + 1010);
  const byName = new Map(world.people.map((p) => [p.full, p]));
  const who = (full: string, email?: string): Who => {
    const p = byName.get(full);
    if (p) return email ? { ...p, email } : p;
    const first = full.split(" ")[0]!;
    return { full, first, email: email ?? `${full.toLowerCase().replace(/[^a-z]+/g, ".")}@gmail.com` };
  };
  const colleagues = world.people.filter((p) => p.relation === "colleague");
  const suite = variant === "hidden" ? "heldout10" : "heldout10-control";
  const tasks: HiddenTask[] = [];
  for (const t of TEMPLATES) {
    // Each template draws from its own fork, so both variants and every template see the same stream.
    const made = t.make({ user: world.user, rng: rng.fork(), who, colleagues });
    const p = variant === "hidden" ? made.item : made.decoy;
    const ref = `h10-${t.name}`;
    const meta: Record<string, string> = {};
    if (p.start !== undefined) meta.start = new Date(p.start).toISOString();
    if (p.people?.length) meta.people = p.people.map((w) => `${w.full} <${w.email}>`).join("; ");
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
      ...(Object.keys(meta).length ? { meta } : {}),
    });
    tasks.push({
      id: `w${seed}:${suite}:${t.name}`,
      template: t.name,
      text: made.text,
      detail: variant === "hidden" ? made.detail : made.falseClaim,
    });
  }
  return tasks;
}

/** How each template's planted item relates to its request (for analysis by link type). */
export const HELDOUT10_LINKS: Record<string, Link> = Object.fromEntries(TEMPLATES.map((t) => [t.name, t.link]));

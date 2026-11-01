/**
 * Held-out hidden-context suite 12: blind, written after D85 by an author who read only the world generator and the
 * suite registry, never the engine or another suite. Measurement only: never tune on it.
 *
 * Thirty-two templates, each a request (eight phrased as questions) whose good answer raises one planted item the
 * request does not ask about, plus a near-miss decoy that looks relevant and is not (another person, another team,
 * a past or settled version of the same thing). The templates split three ways by how the planted item's words
 * relate to the request's:
 * - `none`: the item shares no content word with the request (dates written differently, no names, no topic words);
 * - `name`: the item shares a person's or organisation's name and nothing else;
 * - `topic`: the item shares a topic word and no name.
 *
 * The `hidden` variant plants the item and the decoy; the `control` variant plants the decoy only, with the same
 * request and detail, so a control answer that raises the detail is a false claim. World time is fixed (Tuesday 27
 * October 2026, 09:00 UTC), so dates are written out.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import { chatText, emailText, type Who } from "../text";
import { DAY, HOUR, NOW, type ItemKind, type Person, type World } from "../world";
import type { HiddenTask } from "./hidden-context";

type Overlap = "none" | "name" | "topic";

interface Planted {
  sourceId: string;
  kind: ItemKind;
  title: string;
  text: string;
  at: number;
  meta?: Record<string, string>;
}

interface Made {
  text: string;
  item: Planted;
  decoy: Planted;
  detail: string;
}

interface Ctx {
  r: Rng;
  user: Person;
  colleague(): Person;
  client(): Person;
  vendor(): Person;
  personal(role: string): Person;
  /** A time `days` (± a few hours) before now. */
  ago(days: number): number;
}

const who = (p: Who) => `${p.full} <${p.email}>`;
const ext = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z]/g, "");

function mail(from: Who, to: Who, at: number, title: string, body: string): Planted {
  return {
    sourceId: "gmail",
    kind: "mail",
    title,
    text: emailText(from, to, at, body),
    at,
    meta: { people: who(from) },
  };
}

function chat(channel: string, from: Who, at: number, line: string): Planted {
  const text = chatText([{ who: from.full, text: line, at }]);
  return { sourceId: "slack", kind: "chat", title: channel, text, at, meta: { people: who(from) } };
}

function doc(title: string, at: number, body: string): Planted {
  return { sourceId: "drive", kind: "doc", title, text: `${title}\n\n${body}`, at };
}

function event(title: string, start: string, at: number, body: string): Planted {
  return { sourceId: "calendar", kind: "event", title, text: body, at, meta: { start } };
}

const TEMPLATES: { name: string; overlap: Overlap; make: (c: Ctx) => Made }[] = [
  {
    name: "piano-exam",
    overlap: "name",
    make: (c) => {
      const exams = ext("Northgate Music Exams", "entries@northgatemusic.org.uk");
      return {
        text: "Book Maya's swimming lesson at the leisure centre for Saturday 7 November at 9:30.",
        item: mail(
          exams,
          c.user,
          c.ago(9),
          "Entry confirmed: Maya Carter, Grade 2 Piano",
          "Dear Parent/Guardian,\n\nMaya's Grade 2 piano exam is confirmed for 07/11/2026 at 09:40, St Anne's Hall, " +
            "Upper Street. Candidates should arrive fifteen minutes early to warm up.\n\nNorthgate Music Exams",
        ),
        decoy: mail(
          exams,
          c.user,
          c.ago(200),
          "Result: Maya Carter, Grade 1 Piano",
          "Dear Parent/Guardian,\n\nMaya passed Grade 1 piano with merit (exam held 14 March). The certificate will " +
            "follow by post.\n\nNorthgate Music Exams",
        ),
        detail: "Maya's piano exam is Saturday 7 November at 09:40",
      };
    },
  },
  {
    name: "jury-summons",
    overlap: "none",
    make: (c) => {
      const ellie = c.personal("sister");
      return {
        text: "Accept the Globex invitation to the two-day partner workshop starting Monday 16 November.",
        item: doc(
          "Scan: summons letter",
          c.ago(30),
          "Jury Central Summoning Bureau\n\nYou are required to attend for jury service at Snaresbrook Crown Court " +
            "from 16/11/2026, for up to ten working days. Deferral requests must reach us within seven days of this " +
            "letter.",
        ),
        decoy: mail(
          ellie,
          c.user,
          c.ago(12),
          "phew",
          `Hi ${c.user.first},\n\nGot my jury service deferred to March, so I'm around for the half-term after all.` +
            `\n\n${ellie.first}`,
        ),
        detail: "jury service at Snaresbrook Crown Court from 16 November, for up to ten working days",
      };
    },
  },
  {
    name: "talk-slides",
    overlap: "none",
    make: (c) => {
      const org = ext("Hannah Greer", "speakers@partnercon.events");
      return {
        text: "Block out Friday afternoon for focused work on the Atlas data migration plan.",
        item: mail(
          org,
          c.user,
          c.ago(4),
          "PartnerCon: speaker decks",
          `Hi ${c.user.first},\n\nA reminder that speaker decks are due with us by 17:00 on 30/10 so the AV crew ` +
            "can load and test them. Anything later goes on stage as a PDF without the animations." +
            "\n\nHannah\nPartnerCon",
        ),
        decoy: mail(
          org,
          c.user,
          c.ago(6),
          "PartnerCon 2027: call for speakers",
          "Our call for speakers for PartnerCon 2027 opens in January. Past speakers will get first look at the " +
            "tracks.\n\nPartnerCon",
        ),
        detail: "PartnerCon talk slides are due Friday 30 October at 17:00",
      };
    },
  },
  {
    name: "smart-meter",
    overlap: "none",
    make: (c) => {
      const energy = ext("Brightwell Energy", "noreply@brightwell-energy.co.uk");
      const host = c.colleague();
      return {
        text: `Accept ${host.full}'s invite to the in-person workshop in Reading on Wednesday 4 November.`,
        item: mail(
          energy,
          c.user,
          c.ago(8),
          "Your smart meter installation",
          "Your smart meter installation is booked for 04/11/2026 between 08:00 and 12:00. An adult must be at the " +
            "property to let the engineer in, and the electricity will be off for about an hour.\n\nBrightwell Energy",
        ),
        decoy: mail(
          energy,
          c.user,
          c.ago(3),
          "Meter reading due",
          "Please submit a meter reading by 10/11/2026 so your next statement is accurate.\n\nBrightwell Energy",
        ),
        detail: "smart meter installation at home on Wednesday 4 November, 08:00-12:00; an adult must be in",
      };
    },
  },
  {
    name: "blood-donation",
    overlap: "none",
    make: (c) => {
      const centre = ext("Give Blood", "appointments@giveblood.example.org");
      return {
        text: "Can I play in the five-a-side football game on Thursday evening?",
        item: mail(
          centre,
          c.user,
          c.ago(10),
          "Your donation appointment",
          "Your donation appointment is at 15:15 on 29/10/2026, West End Donor Centre. Please avoid strenuous " +
            "exercise or heavy lifting for the rest of the day after donating.",
        ),
        decoy: mail(
          centre,
          c.user,
          c.ago(95),
          "Your donation has been used",
          "Thank you. The blood you gave in July has been issued to a hospital.",
        ),
        detail: "blood donation Thursday 29 October 15:15; no strenuous exercise for the rest of that day",
      };
    },
  },
  {
    name: "payroll-giving",
    overlap: "topic",
    make: (c) => {
      const hr = c.colleague();
      const ethan = c.colleague();
      return {
        text: "Donate £200 to Shelter from my personal card before the end of the month.",
        item: chat(
          "#announcements",
          hr,
          c.ago(5),
          "Payroll giving: Northwind will match whatever you donate through the giving portal until 30 Nov, up to " +
            "£500 each. Gifts made straight to a charity can't be matched.",
        ),
        decoy: chat(
          "#random",
          ethan,
          c.ago(2),
          "Growing a terrible moustache for November, donate if you can bear to look at it",
        ),
        detail: "Northwind matches donations made through the payroll giving portal until 30 November (up to £500)",
      };
    },
  },
  {
    name: "lock-change",
    overlap: "none",
    make: (c) => {
      const facilities = c.colleague();
      return {
        text: "Tell the cleaner she can let herself in on Friday as usual.",
        item: doc(
          "House admin",
          c.ago(5),
          "- New front door lock fitted 22/10: the old keys no longer work\n- Spare keys: key safe by the bins, " +
            "code 4471\n- Boiler cover renews in spring",
        ),
        decoy: chat(
          "#office",
          facilities,
          c.ago(3),
          "Replacement door fobs for the Northwind office are ready at reception",
        ),
        detail: "the front door lock was changed on 22 October: old keys don't work; spare keys in the key safe (4471)",
      };
    },
  },
  {
    name: "no-bots",
    overlap: "name",
    make: (c) => {
      const p = c.client();
      const other = c.client();
      return {
        text: `Set up a 30-minute catch-up with ${p.full} next Tuesday at 15:00 and add the AI notetaker.`,
        item: mail(
          p,
          c.user,
          c.ago(12),
          "One housekeeping point",
          `Hi ${c.user.first},\n\nOne housekeeping point: our compliance team doesn't allow third-party bots or ` +
            `automated transcription in meetings with ${p.company}, so please leave those off.\n\n${p.first}`,
        ),
        decoy: mail(
          other,
          c.user,
          c.ago(7),
          "Transcript",
          `Hi ${c.user.first},\n\nThe automated transcript of our last session was really handy, thanks for ` +
            `sending it.\n\n${other.first}`,
        ),
        detail: `${p.full}'s compliance team does not allow bots or automated transcription in meetings`,
      };
    },
  },
  {
    name: "screen-reader",
    overlap: "name",
    make: (c) => {
      const p = c.colleague();
      const other = c.colleague();
      return {
        text: `Send ${p.full} the Q4 deck as flattened images so it looks right on any device.`,
        item: chat(
          `DM with ${p.full}`,
          p,
          c.ago(20),
          "small ask: I use a screen reader (JAWS), so text PDFs or slides with alt text work far better for me. " +
            "Pictures of slides come through as nothing at all",
        ),
        decoy: chat(
          `DM with ${other.full}`,
          other,
          c.ago(4),
          "reading everything on my phone this week, screenshots are fine",
        ),
        detail: `${p.full} uses a screen reader: images are unreadable, send text with alt text`,
      };
    },
  },
  {
    name: "singapore",
    overlap: "name",
    make: (c) => {
      const p = c.client();
      const other = c.client();
      return {
        text: `Is Monday 2 November at 16:00 a good slot for a call with ${p.full}?`,
        item: mail(
          p,
          c.user,
          c.ago(6),
          "Heads-up",
          `Hi ${c.user.first},\n\nQuick heads-up: I've moved to our Singapore office as of this week, so I'm on ` +
            `GMT+8 now. Mornings your side suit me best.\n\n${p.first}`,
        ),
        decoy: mail(
          other,
          c.user,
          c.ago(40),
          "Back from Singapore",
          `Hi ${c.user.first},\n\nBack in London after two weeks at our Singapore office, normal hours again.` +
            `\n\n${other.first}`,
        ),
        detail: `${p.full} is now in Singapore (GMT+8): 16:00 London is midnight there`,
      };
    },
  },
  {
    name: "surname-change",
    overlap: "name",
    make: (c) => {
      const p = c.colleague();
      const other = c.colleague();
      const last = c.r.pick(["Okoro", "Lindahl", "Faulkner", "Moreau"].filter((l) => l !== p.last));
      const local = slug(p.nick ?? p.first);
      const fresh = `${local}.${slug(last)}@northwind.co`;
      return {
        text: `Email ${p.full} the signed partner agreement.`,
        item: chat(
          "#general",
          p,
          c.ago(9),
          `Hi all, I got married over the summer and I'm now ${p.first} ${last}. My old address ${p.email} stops ` +
            `forwarding on 1 Nov, so please use ${fresh}`,
        ),
        decoy: chat(
          "#general",
          other,
          c.ago(9),
          `Congrats ${p.first}! Also, I've added a shorter alias for myself, the old address still works too`,
        ),
        detail: `${p.first} is now ${p.first} ${last}; the old address stops forwarding on 1 November (use ${fresh})`,
      };
    },
  },
  {
    name: "cost-centre",
    overlap: "topic",
    make: (c) => {
      const finance = c.colleague();
      return {
        text: "Raise a purchase order for the Beacon agency's November design work.",
        item: chat(
          "#finance",
          finance,
          c.ago(4),
          "From 1 Nov all website relaunch spend moves to cost centre CC-4410. Any purchase order raised on the old " +
            "code CC-2200 will be rejected",
        ),
        decoy: chat(
          "#finance",
          finance,
          c.ago(11),
          "Billing rewrite: each purchase order over £10k now needs a second approver",
        ),
        detail: "website relaunch spend moved to cost centre CC-4410 from 1 November; the old code CC-2200 is rejected",
      };
    },
  },
  {
    name: "rebrand",
    overlap: "none",
    make: (c) => {
      const brand = c.colleague();
      return {
        text: "Send the printers our business card artwork for the two new hires.",
        item: doc(
          "Brand refresh: rollout notes",
          c.ago(6),
          "The old wordmark is retired from 2 Nov. Only the v3 logo files in /Brand/2026 may be used on anything " +
            "produced after that date.",
        ),
        decoy: chat(
          "#brand",
          brand,
          c.ago(30),
          "Brand refresh survey is closed, thanks everyone for voting on the colour palette",
        ),
        detail: "the old logo is retired from 2 November; only the v3 logo files may be used",
      };
    },
  },
  {
    name: "visitor-badges",
    overlap: "topic",
    make: (c) => {
      const facilities = c.colleague();
      const p = c.client();
      return {
        text: `Invite the ${p.company} team to our office for a workshop on Thursday 5 November.`,
        item: chat(
          "#office",
          facilities,
          c.ago(7),
          "Reminder: every office visitor must be registered with reception at least 48 hours ahead, or they won't " +
            "be issued a badge on the day",
        ),
        decoy: chat(
          "#office",
          facilities,
          c.ago(2),
          "The office plants are being replaced on Thursday morning, please don't water them",
        ),
        detail: "office visitors must be registered with reception 48 hours ahead to get a badge",
      };
    },
  },
  {
    name: "fire-drill",
    overlap: "none",
    make: (c) => {
      const facilities = c.colleague();
      const p = c.client();
      return {
        text: `Is the boardroom free for the ${p.company} demo on Wednesday at 11:00?`,
        item: mail(
          facilities,
          c.user,
          c.ago(5),
          "Planned evacuation drill",
          "All,\n\nPlanned evacuation drill on 28/10 between 10:50 and 11:30. Alarms will sound and the building " +
            `must be cleared, guests included.\n\n${facilities.first}`,
        ),
        decoy: mail(
          facilities,
          c.user,
          c.ago(60),
          "Alarm testing",
          `All,\n\nThe alarm is tested every Monday at 09:00: a short bell, no need to leave.\n\n${facilities.first}`,
        ),
        detail: "fire evacuation drill on Wednesday 28 October, 10:50-11:30",
      };
    },
  },
  {
    name: "remortgage",
    overlap: "none",
    make: (c) => {
      const broker = ext("Nina Shah", "nina@harbourmortgages.co.uk");
      return {
        text: "Should I get a store card to spread the cost of the kitchen refit?",
        item: mail(
          broker,
          c.user,
          c.ago(9),
          "Next steps with the lender",
          `Hi ${c.user.first},\n\nWhile the remortgage is with the lender (offer expected by 30/11), please don't ` +
            "take out any new credit: it triggers a fresh search and can derail the offer.\n\nNina",
        ),
        decoy: mail(
          broker,
          c.user,
          c.ago(25),
          "Harbour Mortgages: market update",
          "Fixed rates edged down again this month. If your deal ends next year, it's worth a chat.\n\nNina",
        ),
        detail: "the mortgage broker said not to take out new credit until the remortgage offer (expected 30 November)",
      };
    },
  },
  {
    name: "bulky-collection",
    overlap: "topic",
    make: (c) => {
      const council = ext("Islington Council", "noreply@islington.example.gov.uk");
      return {
        text: "Put the old sofa out for collection on Tuesday morning.",
        item: mail(
          council,
          c.user,
          c.ago(14),
          "Changes to bulky item services",
          "From November, bulky item collection runs on Thursdays only and must be booked online. Items left on the " +
            "pavement without a booking may be fined.",
        ),
        decoy: mail(
          council,
          c.user,
          c.ago(20),
          "Garden waste",
          "Garden waste collection pauses for the winter and resumes in March.",
        ),
        detail: "bulky collection is Thursdays only and must be booked; unbooked items left out may be fined",
      };
    },
  },
  {
    name: "us-clocks",
    overlap: "name",
    make: (c) => {
      const p = c.client();
      const other = c.client();
      return {
        text: `Is 14:00 on Friday right for ${p.full}, and is that 9am their side?`,
        item: mail(
          p,
          c.user,
          c.ago(3),
          "Before we speak",
          `Hi ${c.user.first},\n\nReminder that I'm in New York and our clocks only go back on 1 Nov, so this week ` +
            `we're four hours behind you, not five.\n\n${p.first}`,
        ),
        decoy: mail(
          other,
          c.user,
          c.ago(250),
          "Hours",
          `Hi ${c.user.first},\n\nI'm in Chicago, six hours behind you, so afternoons your side work best.` +
            `\n\n${other.first}`,
        ),
        detail: `the US clocks change on 1 November: this week 14:00 London is 10:00 in New York for ${p.full}`,
      };
    },
  },
  {
    name: "anchor-days",
    overlap: "topic",
    make: (c) => {
      const lead = c.colleague();
      const eng = c.colleague();
      return {
        text: "Book a team lunch in the office on Monday 9 November.",
        item: chat(
          "#partnerships",
          lead,
          c.ago(6),
          "From November our team's in-office anchor days move to Tuesday and Thursday. Mondays are remote",
        ),
        decoy: chat(
          "#engineering",
          eng,
          c.ago(6),
          "Engineering team anchor days stay Monday and Wednesday, no change for us",
        ),
        detail: "the Partnerships team's office days moved to Tuesday and Thursday; Mondays are remote",
      };
    },
  },
  {
    name: "sister-wedding",
    overlap: "none",
    make: (c) => {
      const ellie = c.personal("sister");
      const jamie = c.personal("best friend");
      const p = c.client();
      return {
        text: `Accept the ${p.company} quarterly review in New York on Thursday 19 November.`,
        item: mail(
          ellie,
          c.user,
          c.ago(15),
          "the big weekend!!",
          `${c.user.first}!\n\nRehearsal dinner is 19/11 at 7pm, then the wedding itself on the 21st. You're doing ` +
            `a reading, don't forget.\n\n${ellie.first} x`,
        ),
        decoy: mail(
          jamie,
          c.user,
          c.ago(70),
          "photos",
          `Our wedding photos from last year are finally up, link below.\n\n${jamie.first}`,
        ),
        detail:
          "sister Ellie's wedding rehearsal dinner is 19 November (wedding on the 21st); the user gives a reading",
      };
    },
  },
  {
    name: "bereavement",
    overlap: "name",
    make: (c) => {
      const p = c.client();
      const other = c.client();
      return {
        text: `Chase ${p.full} today for the signed order form.`,
        item: mail(
          p,
          c.user,
          c.ago(4),
          "Apologies",
          `Hi ${c.user.first},\n\nApologies for going quiet. My father passed away last week and I'm dealing with ` +
            `the funeral. I'll pick things up as soon as I can.\n\n${p.first}`,
        ),
        decoy: mail(
          other,
          c.user,
          c.ago(4),
          "Signed form",
          `Hi ${c.user.first},\n\nSorry for the delay, our signatory was travelling. Signed copy attached.` +
            `\n\n${other.first}`,
        ),
        detail: `${p.full}'s father died last week; go gently rather than chasing`,
      };
    },
  },
  {
    name: "eu-residency",
    overlap: "topic",
    make: (c) => ({
      text: "Spin up the Umbrella Health pilot environment on our US cluster this week.",
      item: doc(
        "Healthcare pilot: contract schedule 4",
        c.ago(30),
        "4.2 All customer data processed during the pilot must be stored and processed in the EU (Frankfurt or " +
          "Dublin regions). Transfers outside the EU require prior written consent.",
      ),
      decoy: doc(
        "Search pilot: hosting notes",
        c.ago(12),
        "Hosting for the search pilot: US region approved by their security team.",
      ),
      detail: "the healthcare pilot's contract requires customer data to stay in the EU (Frankfurt or Dublin)",
    }),
  },
  {
    name: "conflict-of-interest",
    overlap: "name",
    make: (c) => {
      const p = c.colleague();
      const other = c.colleague();
      const v = c.vendor();
      const w = c.vendor();
      const elsewhere = w.company === v.company ? "Pied Piper" : w.company;
      return {
        text: `Ask ${p.full} to score the ${v.company} proposal by Friday.`,
        item: chat(
          "#procurement",
          p,
          c.ago(25),
          `Declaring for the register: my partner joined ${v.company} last month, so I'll step out of anything ` +
            "involving them",
        ),
        decoy: chat(
          "#procurement",
          other,
          c.ago(40),
          `Declaring for the register: my brother does contract work for ${elsewhere}`,
        ),
        detail: `${p.full} declared a conflict of interest: their partner works at ${v.company}`,
      };
    },
  },
  {
    name: "parking-suspension",
    overlap: "none",
    make: (c) => {
      const council = ext("Islington Council", "parking@islington.example.gov.uk");
      return {
        text: "Arrange delivery of the new wardrobe for Thursday 5 November.",
        item: mail(
          council,
          c.user,
          c.ago(6),
          "Bay suspension notice: Elm Road",
          "Bays on Elm Road are suspended on 05/11/2026 from 07:00 to 19:00 for scaffolding. Vehicles parked or " +
            "loading in the bays may be removed.",
        ),
        decoy: mail(
          council,
          c.user,
          c.ago(10),
          "Resident permit",
          "Your resident permit expires on 31/01/2027. You can renew from 1 January.",
        ),
        detail: "the street's bays are suspended Thursday 5 November 07:00-19:00 for scaffolding; no loading",
      };
    },
  },
  {
    name: "pronouns",
    overlap: "name",
    make: (c) => {
      const p = c.colleague();
      const other = c.colleague();
      const q = c.client();
      return {
        text: `Write an email introducing ${p.full} to ${q.full}.`,
        item: chat(
          "#general",
          p,
          c.ago(14),
          "Hi all, I'm using they/them pronouns from now on. Thanks for being great about it",
        ),
        decoy: chat("#general", other, c.ago(14), "Updated my display name to drop the middle initial"),
        detail: `${p.full} uses they/them pronouns`,
      };
    },
  },
  {
    name: "pricing-sheet",
    overlap: "topic",
    make: (c) => {
      const p = c.client();
      const sales = c.colleague();
      const leak = p.company === "Initech" ? "Hooli" : "Initech";
      return {
        text: `Share the partner pricing sheet with ${p.full}.`,
        item: chat(
          "#sales",
          sales,
          c.ago(3),
          `Heads-up: tab 3 of the partner pricing sheet still has ${leak}'s discounted rates. Strip it before ` +
            "anything goes external",
        ),
        decoy: chat("#sales", sales, c.ago(30), "Pricing FAQ updated with the new support tiers"),
        detail: `tab 3 of the pricing sheet holds ${leak}'s discounted rates; remove it before sharing externally`,
      };
    },
  },
  {
    name: "houseguest",
    overlap: "none",
    make: (c) => {
      const mum = c.personal("mum");
      const jamie = c.personal("best friend");
      const guest = c.colleague();
      return {
        text: `Can ${guest.first} stay in our spare room from 10 to 13 November?`,
        item: mail(
          mum,
          c.user,
          c.ago(8),
          "train booked",
          "Booked my train! Arriving on the 9th and heading home on the 16th. Can't wait to see Maya.\n\nMum x",
        ),
        decoy: mail(
          jamie,
          c.user,
          c.ago(80),
          "thank you",
          `Thanks for having me in August, the sofa bed was very comfy.\n\n${jamie.first}`,
        ),
        detail: "mum (Ruth) is staying 9-16 November",
      };
    },
  },
  {
    name: "broadband",
    overlap: "topic",
    make: (c) => {
      const isp = ext("FibreNest", "hello@fibrenest.example.co.uk");
      const p = c.client();
      return {
        text: `Accept the 10:00 video pitch with ${p.company} on Tuesday 3 November and take it from home.`,
        item: mail(
          isp,
          c.user,
          c.ago(10),
          "Your switch date",
          "Your home broadband switch to FibreNest completes on 03/11. Expect no internet between 09:00 and 13:00 " +
            "while the line is moved.",
        ),
        decoy: mail(isp, c.user, c.ago(2), "Upgrade available", "A faster home plan is now available at your address."),
        detail: "the broadband switchover on Tuesday 3 November means no internet 09:00-13:00",
      };
    },
  },
  {
    name: "layoffs",
    overlap: "name",
    make: (c) => {
      const p = c.client();
      const other = c.client();
      return {
        text: `Send ${p.full} our 'record quarter' customer newsletter with a congratulations note.`,
        item: mail(
          p,
          c.user,
          c.ago(3),
          "This week",
          `Hi ${c.user.first},\n\nAs you may have seen, ${p.company} announced redundancies affecting a third of ` +
            `staff this week. Things are raw here, so we're keeping comms low-key for now.\n\n${p.first}`,
        ),
        decoy: mail(
          other,
          c.user,
          c.ago(5),
          "Hiring",
          `Hi ${c.user.first},\n\nWe're hiring like mad at the moment, so forgive slow replies.\n\n${other.first}`,
        ),
        detail: `${p.company} just announced redundancies of a third of staff; ${p.full} asked for low-key comms`,
      };
    },
  },
  {
    name: "expense-approver",
    overlap: "topic",
    make: (c) => {
      const old = c.colleague();
      // The item may share no name with the request: skip anyone sharing a first or last name with the old approver.
      const unlike = () => {
        let p = c.colleague();
        while ([p.first, p.last].some((n) => [old.first, old.last].includes(n))) p = c.colleague();
        return p;
      };
      const fresh = unlike();
      const finance = unlike();
      return {
        text: `Send my October expenses to ${old.full} for approval.`,
        item: chat(
          "#finance",
          finance,
          c.ago(5),
          `From 1 Nov, Partnerships expenses are approved by ${fresh.full}. Claims sent to the previous approver ` +
            "will bounce",
        ),
        decoy: chat("#finance", finance, c.ago(9), "Expenses reminder: receipts over £25 need an itemised photo"),
        detail: `Partnerships expenses are approved by ${fresh.full} from 1 November`,
      };
    },
  },
  {
    name: "interpreter",
    overlap: "name",
    make: (c) => {
      const p = c.client();
      const other = c.client();
      return {
        text: `What should I prepare for Friday's meeting with ${p.full}?`,
        item: mail(
          p,
          c.user,
          c.ago(4),
          "Joining on our side",
          `Hi ${c.user.first},\n\nMy director Mr Sato will join us. His English is limited, so we'll need a ` +
            `Japanese interpreter. Could your side book one at least 48 hours ahead?\n\n${p.first}`,
        ),
        decoy: mail(
          other,
          c.user,
          c.ago(4),
          "Joining on our side",
          `Hi ${c.user.first},\n\nMy director will also dial in, no special requirements.\n\n${other.first}`,
        ),
        detail: `${p.full}'s director Mr Sato joins and needs a Japanese interpreter booked 48 hours ahead`,
      };
    },
  },
  {
    name: "hackathon",
    overlap: "topic",
    make: (c) => {
      const organiser = c.colleague();
      return {
        text: "Am I free for a weekend city break in Lisbon on 14-15 November?",
        item: chat(
          `DM with ${organiser.full}`,
          organiser,
          c.ago(12),
          "Thanks for agreeing to judge the student hackathon! Judging takes the Saturday of that weekend, " +
            "14 Nov, 10:00-16:00 at the office",
        ),
        decoy: chat("#general", organiser, c.ago(300), "Photos from last year's student hackathon are in the drive"),
        detail: "the user agreed to judge the student hackathon on Saturday 14 November, 10:00-16:00",
      };
    },
  },
];

/** Adds the suite's items to `world` (item and decoy, or decoy only for the control) and returns its tasks. */
export function plantHeldout12(world: World, seed: number, variant: "hidden" | "control"): HiddenTask[] {
  const r = new Rng(seed * 7919 + 1212);
  const pools = new Map<string, Person[]>();
  const take = (relation: Person["relation"]) => {
    if (!pools.get(relation)?.length) {
      const all = world.people.filter((p) => p.relation === relation);
      pools.set(relation, r.sample(all, all.length));
    }
    return pools.get(relation)!.shift()!;
  };
  const ctx: Ctx = {
    r,
    user: world.user,
    colleague: () => take("colleague"),
    client: () => take("client"),
    vendor: () => take("vendor"),
    personal: (role) => world.people.find((p) => p.role === role)!,
    ago: (days) => NOW - days * DAY - r.int(1, 9) * HOUR,
  };
  const plant = (p: Planted, ref: string, noise: boolean) =>
    world.items.push({
      id: itemId(p.sourceId, ref),
      ref,
      sourceId: p.sourceId,
      kind: p.kind,
      title: p.title,
      text: p.text,
      updatedAt: p.at,
      facts: [],
      noise,
      ...(p.meta ? { meta: p.meta } : {}),
    });
  const suite = variant === "hidden" ? "heldout12" : "heldout12-control";
  return TEMPLATES.map((t) => {
    const m = t.make(ctx);
    if (variant === "hidden") plant(m.item, `heldout12-${t.name}`, false);
    plant(m.decoy, `heldout12-${t.name}-decoy`, true);
    return { id: `w${seed}:${suite}:${t.name}`, template: t.name, text: m.text, detail: m.detail };
  });
}

/** Template names by how the planted item's words relate to the request's (for reports). */
export const HELDOUT12_OVERLAP: Record<string, Overlap> = Object.fromEntries(TEMPLATES.map((t) => [t.name, t.overlap]));

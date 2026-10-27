/**
 * Rendering of simulated items into text shaped like the real thing: emails with greetings, sign-offs, corporate
 * signatures, disclaimers, quoted reply chains and forwards; newsletters; automated notifications; calendar entries;
 * CRM records; chat logs. The engine sees only this text, so its realism decides how much a simulation result means.
 */
import { MONTHS, WEEKDAYS } from "./names";
import type { Rng } from "./rng";

export interface Who {
  full: string;
  first: string;
  email: string;
  title?: string;
  company?: string;
  phone?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Tue, 21 Oct 2026 09:14" (an email Date header, UTC). */
export function dateHeader(t: number): string {
  const d = new Date(t);
  const day = WEEKDAYS[(d.getUTCDay() + 6) % 7]!.slice(0, 3);
  return `${day}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "Thursday 23 Oct". */
export function dayLabel(t: number): string {
  const d = new Date(t);
  return `${WEEKDAYS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Thursday". */
export function weekday(t: number): string {
  return WEEKDAYS[(new Date(t).getUTCDay() + 6) % 7]!;
}

/** "12:30". */
export function clock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "2026-11-30". */
export function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

const GREETINGS = ["Hi {first},", "Hey {first},", "Hi {first} -", "Morning {first},", "{first},", "Hello {first},", ""];
const OPENERS = [
  "Hope your week is going well.",
  "Thanks for getting back to me so quickly.",
  "Quick one from me.",
  "Following up on the below.",
  "Sorry for the slow reply, it's been a week.",
  "Thanks again for your time yesterday.",
  "",
  "",
];
const CLOSERS = [
  "Let me know if that works for you.",
  "Shout if you have any questions.",
  "Happy to jump on a call if easier.",
  "Thanks in advance.",
  "Speak soon.",
  "Let me know what you think.",
  "",
];
const SIGNOFFS = ["Best,", "Thanks,", "Cheers,", "Best regards,", "Kind regards,", "Thanks!", "All the best,", "—"];
const DISCLAIMER =
  "CONFIDENTIALITY NOTICE: This email and any attachments are confidential and may be legally privileged. If you are " +
  "not the intended recipient, please notify the sender and delete it. Any unauthorised use, disclosure or copying " +
  "is prohibited.";

function signature(r: Rng, from: Who, corporate: boolean): string {
  const signoff = r.pick(SIGNOFFS);
  const name = r.chance(0.3) ? from.first : r.chance(0.15) ? from.first[0]! : from.full;
  const lines = [`${signoff}\n${name}`];
  if (corporate && from.title && r.chance(0.7)) {
    lines.push(`--\n${from.full}\n${from.title}${from.company ? ` | ${from.company}` : ""}`);
    if (from.phone && r.chance(0.6)) lines.push(`M: ${from.phone}`);
  }
  if (!corporate && r.chance(0.25)) lines.push("Sent from my iPhone");
  if (corporate && r.chance(0.2)) lines.push(DISCLAIMER);
  return lines.join("\n");
}

export interface Message {
  from: Who;
  to: Who;
  at: number;
  /** The sentences that carry the message's content, in order. */
  body: string[];
  corporate: boolean;
}

/** One email body: greeting, opener, content, closer, signature. No quoted history. */
export function emailBody(r: Rng, m: Message): string {
  const greeting = r.pick(GREETINGS).replace("{first}", m.to.first);
  const parts = [greeting, [r.pick(OPENERS), ...m.body, r.pick(CLOSERS)].filter(Boolean).join(" ")];
  return [...parts.filter(Boolean), signature(r, m.from, m.corporate)].join("\n\n");
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

/**
 * The messages of a thread as stored by a mail provider: each message after the first quotes the one before it
 * (with its own quoted history), as most clients do on reply.
 */
export function threadBodies(r: Rng, messages: Message[]): string[] {
  const out: string[] = [];
  let history = "";
  for (const m of messages) {
    const own = emailBody(r, m);
    const full = history ? `${own}\n\n${history}` : own;
    out.push(full);
    // Some clients trim history; most keep it all.
    const keep = r.chance(0.85);
    history = keep ? `On ${dateHeader(m.at)}, ${m.from.full} <${m.from.email}> wrote:\n${quote(full)}` : "";
  }
  return out;
}

/** An email as a search result: headers, then body. */
export function emailText(from: Who, to: Who, at: number, body: string, cc: Who[] = []): string {
  const ccLine = cc.length ? `\nCc: ${cc.map((c) => `${c.full} <${c.email}>`).join(", ")}` : "";
  return `From: ${from.full} <${from.email}>\nTo: ${to.full} <${to.email}>${ccLine}\nDate: ${dateHeader(at)}\n\n${body}`;
}

/** A forwarded message, as Gmail renders it. */
export function forwarded(
  r: Rng,
  by: Who,
  to: Who,
  original: { from: Who; at: number; subject: string; body: string },
) {
  const note = r.pick(["FYI", "See below", "Forwarding for context", "Can you take a look?", ""]);
  return (
    `${note}\n\n---------- Forwarded message ---------\nFrom: ${original.from.full} <${original.from.email}>\n` +
    `Date: ${dateHeader(original.at)}\nSubject: ${original.subject}\nTo: ${to.full} <${to.email}>\n\n${original.body}`
  ).trim();
}

const NEWS_FILLER = [
  "We looked at {n} companies and the pattern was hard to miss.",
  "The teams that did best kept it simple, measured weekly, and said no to most requests.",
  "Here's what we learned, and what we'd do differently next time.",
  "Read time: {m} minutes.",
  "This week's sponsor helps you close the books faster. Try it free for 30 days.",
  "Three charts that explain the quarter.",
  "A reader asked us about this last month, so we dug in.",
  "If you only read one thing this week, make it this.",
  "Upcoming events: our annual summit is back in San Francisco, early-bird tickets end Friday.",
  "You are receiving this email because you subscribed. Unsubscribe | Manage preferences | View in browser.",
];

/** A newsletter: long, link-heavy, sharing vocabulary with real work. */
export function newsletterText(r: Rng, sender: string, topics: string[]): string {
  const paras: string[] = [];
  const sections = r.int(6, 14);
  for (let s = 0; s < sections; s++) {
    const t = r.pick(topics);
    const t2 = r.pick(topics);
    const sentences = [
      `${capitalise(t)}: what the best operators are doing differently this quarter.`,
      r.pick(NEWS_FILLER),
      `We spoke to founders about ${t} and ${t2}; most said the hardest part was getting started.`,
      r.pick(NEWS_FILLER),
      `Read more → https://${sender.toLowerCase().replace(/[^a-z]+/g, "")}.com/p/${t.toLowerCase().replace(/\W+/g, "-")}-${r.int(100, 999)}`,
    ];
    paras.push(
      sentences
        .join(" ")
        .replace("{n}", String(r.int(40, 900)))
        .replace("{m}", String(r.int(3, 14))),
    );
  }
  paras.push(NEWS_FILLER[NEWS_FILLER.length - 1]!);
  return paras.join("\n\n");
}

export function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** A chat log as a search result: one line per message. */
export function chatText(lines: { who: string; text: string; at: number }[]): string {
  return lines.map((l) => `[${clock(l.at)}] ${l.who}: ${l.text}`).join("\n");
}

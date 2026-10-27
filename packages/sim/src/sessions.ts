/**
 * Sessions with ground truth, generated from a world. A session is a run of tasks as a personal agent sees them:
 * the user asks for something; the agent may call its own tools (and so fetch part of what it needs itself); it
 * answers, mentioning what it knows; the user may follow up or say thanks. Other turns need nothing: chatter,
 * requests the user's data cannot help with, mentions of known people with no information need, inbound events.
 *
 * Every turn carries a label:
 * - `need`: the facts that should reach the agent for this turn (`must`), and others that are fine to deliver
 *   (`ok`): anything else delivered is a false positive;
 * - `context`: a turn inside a task that needs nothing new (agent turns, follow-ups): deliveries count as relevant
 *   only if they are in `ok`;
 * - `silent`: nothing should be delivered; `soft` marks a turn where a delivery is merely unhelpful (a passing
 *   mention of a known person), reported apart from hard false fires.
 *
 * How the user refers to things is recorded per task (`style`), so results can be broken down by it: by full name,
 * first name (sometimes shared by two people), nickname, role ("my landlord"), organisation, id, or topic alone.
 */
import type { AgentEvent } from "@eden/protocol";
import { Rng } from "./rng";
import type { Arc, World, WorldItem } from "./world";

export type TurnEvent = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, "tenantId" | "userId" | "sessionId" | "at">
    : never
  : never;

export type Label =
  | { kind: "need"; must: string[]; ok: string[] }
  | { kind: "context"; ok: string[] }
  | { kind: "silent"; soft?: boolean };

export type RefStyle = "full" | "first" | "nick" | "role" | "org" | "id" | "topic" | "none";

export interface SimTurn {
  event: TurnEvent;
  label: Label;
  /** Agent messages: the facts the agent mentions when it knows them (they decide the message text at run time). */
  uses?: string[];
  /** Tool results: the facts the agent fetched itself. */
  fetched?: string[];
}

export interface SimTask {
  type: string;
  style: RefStyle;
  /** The first name is shared by another person in the world. */
  ambiguous?: boolean;
  arc?: string;
  turns: SimTurn[];
}

export interface SimSession {
  id: string;
  tasks: SimTask[];
}

export interface AskCase {
  question: string;
  must: string[];
  ok: string[];
  style: RefStyle;
  arc: string;
}

const OFFWORLD = [
  "Write a haiku about autumn in London",
  "What's 17% of 2,340?",
  "Explain how a mortgage offset account works",
  "Translate 'see you tomorrow' into Portuguese",
  "Suggest a name for a golden retriever puppy",
  "What's a good stretch for lower back pain?",
  "Give me three ideas for a 10-minute team icebreaker",
  "How long should I boil an egg for a jammy yolk?",
  "Summarise the plot of Middlemarch in two sentences",
  "What's the difference between a Roth IRA and a traditional IRA?",
  "Draft a polite out-of-office message for next week",
  "Recommend a podcast about the history of maths",
  "How do I convert 180°C to Fahrenheit?",
  "Write a limerick about a cat who hates Mondays",
  "What are the rules of padel, briefly?",
  "Brainstorm names for a book club",
  "Is it 'affect' or 'effect' in 'the change will ___ everyone'?",
  "What time zone is Singapore in?",
];

const CHATTER = [
  "thanks!",
  "ok",
  "perfect, thank you",
  "great",
  "lol",
  "sounds good",
  "cool",
  "ty",
  "👍",
  "nice one",
  "ok cool",
];

const NOVEL = [
  "Book a table for me and Hannah at Kiln on Saturday night",
  "Can you find a plumber near Highbury who can come this week?",
  "Remind me to call Theo about the bike at 6",
  "Order more printer paper for the home office",
  "Look up opening hours for the Barbican conservatory",
  "Find me a yoga class on Sunday mornings in Islington",
];

export interface SessionOptions {
  seed: number;
  sessions: number;
  /** Probability the agent fetches part of what it needs with its own tool before answering. */
  agentToolRate?: number;
}

export function buildSessions(world: World, options: SessionOptions): { sessions: SimSession[]; asks: AskCase[] } {
  const g = new Gen(world, new Rng(options.seed), options.agentToolRate ?? 0.4);
  const sessions: SimSession[] = [];
  for (let s = 0; s < options.sessions; s++) sessions.push({ id: `s${s}`, tasks: g.session() });
  return { sessions, asks: g.asks() };
}

class Gen {
  private readonly firstCounts = new Map<string, number>();

  constructor(
    private readonly w: World,
    private readonly r: Rng,
    private readonly toolRate: number,
  ) {
    for (const p of w.people) this.firstCounts.set(p.first, (this.firstCounts.get(p.first) ?? 0) + 1);
  }

  session(): SimTask[] {
    const r = this.r;
    const n = r.int(1, 4);
    const tasks: SimTask[] = [];
    for (let i = 0; i < n; i++) {
      const x = r.next();
      if (x < 0.58) tasks.push(this.needTask());
      else if (x < 0.7) tasks.push(this.external());
      else if (x < 0.82) tasks.push(this.silentTask("offworld", r.pick(OFFWORLD)));
      else if (x < 0.88) tasks.push(this.silentTask("novel", r.pick(NOVEL)));
      else if (x < 0.94) tasks.push(this.softMention());
      else
        tasks.push({
          type: "chatter",
          style: "none",
          turns: [{ event: user(r.pick(CHATTER)), label: { kind: "silent" } }],
        });
    }
    return tasks;
  }

  // ── wording helpers ──

  private shared(first: string): boolean {
    return (this.firstCounts.get(first) ?? 0) > 1;
  }

  /** A user utterance with realistic sloppiness: sometimes all lowercase, sometimes a typo in a word. */
  private say(text: string): string {
    const r = this.r;
    let t = text;
    if (r.chance(0.05)) {
      const ws = t.split(" ");
      const i = r.int(0, ws.length - 1);
      const w = ws[i]!;
      if (w.length > 4) {
        const j = r.int(1, w.length - 3);
        ws[i] = w.slice(0, j) + w[j + 1] + w[j] + w.slice(j + 2);
      }
      t = ws.join(" ");
    }
    if (r.chance(0.2)) t = t.toLowerCase();
    return t;
  }

  /** How the user names the arc's person in this task. */
  private personRef(arc: Arc): { text: string; style: RefStyle; ambiguous: boolean } {
    const p = arc.person!;
    const r = this.r;
    const options: [string, RefStyle][] = [
      [p.full, "full"],
      [p.first, "first"],
    ];
    if (p.nick) options.push([p.nick, "nick"]);
    const [text, style] = r.pick(options);
    return { text, style, ambiguous: style === "first" && this.shared(p.first) };
  }

  private arcs(kind: Arc["kind"]): Arc[] {
    return this.w.arcs.filter((a) => a.kind === kind);
  }

  // ── tasks that need context ──

  private needTask(): SimTask {
    const r = this.r;
    const makers: (() => SimTask | null)[] = [
      () => this.meeting(),
      () => this.meeting(),
      () => this.deal(),
      () => this.deal(),
      () => this.travel(),
      () => this.ticket(),
      () => this.invoice(),
      () => this.personal(),
      () => this.personal(),
    ];
    for (;;) {
      const t = r.pick(makers)();
      if (t) return t;
    }
  }

  /** Wraps a user request into a task: optional agent tool use, the agent's answer, a follow-up, thanks. */
  private task(
    type: string,
    arc: Arc,
    ref: { style: RefStyle; ambiguous?: boolean },
    ask: string,
    must: string[],
    ok: string[],
    answer: { lead: string; tool: string; query: string; followUp?: string },
  ): SimTask {
    const r = this.r;
    const all = [...new Set([...must, ...ok])];
    const turns: SimTurn[] = [{ event: user(this.say(ask)), label: { kind: "need", must, ok } }];
    if (r.chance(this.toolRate)) {
      // The agent looks something up itself: it gets one of the needed facts (the item a real tool would return).
      const fact = r.pick(must);
      const item = this.itemFor(fact);
      turns.push({
        event: { kind: "tool_call", tool: answer.tool, input: { query: answer.query } },
        label: { kind: "context", ok: all },
      });
      turns.push({
        event: {
          kind: "tool_result",
          tool: answer.tool,
          output: item ? `${item.title}\n${item.text.slice(0, 1_500)}` : "[]",
        },
        label: { kind: "context", ok: all },
        fetched: item ? item.facts : [],
      });
    }
    turns.push({ event: { kind: "agent_message", text: answer.lead }, label: { kind: "context", ok: all }, uses: all });
    if (answer.followUp && r.chance(0.4))
      turns.push({ event: user(this.say(answer.followUp)), label: { kind: "context", ok: all } });
    if (r.chance(0.35)) turns.push({ event: user(r.pick(CHATTER)), label: { kind: "silent" } });
    return { type, style: ref.style, ambiguous: ref.ambiguous, arc: arc.id, turns };
  }

  private itemFor(fact: string): WorldItem | undefined {
    const ids = this.w.facts.get(fact)?.items ?? [];
    const id = ids.length ? this.r.pick(ids) : undefined;
    return this.w.items.find((i) => i.id === id);
  }

  private meeting(): SimTask | null {
    const r = this.r;
    const arc = r.pick(this.arcs("meeting"));
    const s = arc.slots;
    const ref = this.personRef(arc);
    const f = arc.facts;
    const byTopic = r.chance(0.15);
    const who = byTopic ? `on ${s.day}` : `with ${ref.text}`;
    const style: RefStyle = byTopic ? "topic" : ref.style;
    if (r.chance(0.55)) {
      return this.task(
        "reschedule",
        arc,
        { style, ambiguous: !byTopic && ref.ambiguous },
        r.pick([
          `Can you move my ${s.activity} ${who} to Friday?`,
          `I need to push ${s.activity} ${who}, can you find another slot next week?`,
          `Please reschedule the ${s.activity} ${who}, something came up`,
        ]),
        [f.event!, f.constraint!],
        [],
        {
          lead: `I'll move your ${s.activity} ${who}.`,
          tool: "calendar.search",
          query: `${s.activity} ${s.name}`,
          followUp: r.pick([
            "Actually make it the week after",
            "And let them know I'm sorry for the shuffle",
            "make it 30 mins later instead",
          ]),
        },
      );
    }
    return this.task(
      "when-meeting",
      arc,
      { style, ambiguous: !byTopic && ref.ambiguous },
      r.pick([
        `When's my ${s.activity} ${who}?`,
        `What time am I seeing ${byTopic ? "them" : ref.text} for ${s.activity}?`,
        `Where are we having ${s.activity} ${who}?`,
      ]),
      [f.event!],
      [f.constraint!],
      { lead: `Let me check your ${s.activity} ${who}.`, tool: "calendar.search", query: `${s.activity} ${s.name}` },
    );
  }

  private deal(): SimTask | null {
    const r = this.r;
    const arc = r.pick(this.arcs("deal"));
    const s = arc.slots;
    const f = arc.facts;
    const ref = r.chance(0.5) ? { text: s.org!, style: "org" as RefStyle, ambiguous: false } : this.personRef(arc);
    const x = r.next();
    if (x < 0.4) {
      return this.task(
        "meeting-prep",
        arc,
        ref,
        r.pick([
          `Prep me for the ${s.org} call`,
          `I've got the ${s.org} call coming up, what do I need to know?`,
          `Give me a briefing before my call with ${ref.text}`,
        ]),
        [f.pricing!, f.notes!],
        [f.record!, f.call!],
        {
          lead: `Here's your briefing for ${s.org}.`,
          tool: "crm.search",
          query: s.org!,
          followUp: "What should I push back on?",
        },
      );
    }
    if (x < 0.75) {
      return this.task(
        "reply-pricing",
        arc,
        ref,
        r.pick([
          `Draft a reply to ${ref.text} about the discount`,
          `${ref.text} asked about pricing again, can you write back?`,
          `help me answer ${ref.text}'s email on the ${s.kind} pricing`,
        ]),
        [f.pricing!],
        [f.record!, f.notes!],
        {
          lead: `Drafting a reply to ${ref.text}.`,
          tool: "gmail.search",
          query: `${s.org} pricing`,
          followUp: "Make it a bit warmer",
        },
      );
    }
    return this.task(
      "deal-status",
      arc,
      ref,
      r.pick([
        `Where are we with the ${s.org} deal?`,
        `What stage is ${s.org} at?`,
        `Status on the ${ref.text} ${s.kind}?`,
      ]),
      [f.record!],
      [f.pricing!, f.notes!, f.call!],
      { lead: `Checking the ${s.org} deal.`, tool: "crm.search", query: s.org! },
    );
  }

  private travel(): SimTask | null {
    const r = this.r;
    const arcs = this.arcs("travel");
    if (!arcs.length) return null;
    const arc = r.pick(arcs);
    const s = arc.slots;
    const f = arc.facts;
    const x = r.next();
    if (x < 0.4) {
      return this.task(
        "flight-time",
        arc,
        { style: "topic" },
        r.pick([`When do I fly to ${s.city}?`, `What time is my ${s.city} flight?`]),
        [f.flight!],
        [f.hotel!],
        {
          lead: `Looking up your ${s.city} flight.`,
          tool: "gmail.search",
          query: `flight ${s.city}`,
        },
      );
    }
    if (x < 0.7) {
      return this.task(
        "airport-cab",
        arc,
        { style: "topic" },
        r.pick([
          `Book me a cab to the airport for the ${s.city} trip`,
          `I need a ride to Heathrow for ${s.city}, can you sort it?`,
        ]),
        [f.flight!],
        [f.hotel!],
        {
          lead: "I'll book a cab to Heathrow.",
          tool: "calendar.search",
          query: `flight ${s.city}`,
          followUp: "Make it an estate car, I have a big bag",
        },
      );
    }
    return this.task(
      "hotel",
      arc,
      { style: "topic" },
      r.pick([`Which hotel am I in for ${s.city}?`, `remind me where I'm staying in ${s.city}`]),
      [f.hotel!],
      [f.flight!],
      {
        lead: `Checking your ${s.city} hotel.`,
        tool: "gmail.search",
        query: `hotel ${s.city}`,
      },
    );
  }

  private ticket(): SimTask | null {
    const r = this.r;
    const arc = r.pick(this.arcs("ticket"));
    const s = arc.slots;
    const f = arc.facts;
    const x = r.next();
    if (x < 0.45) {
      return this.task(
        "ticket-status",
        arc,
        { style: "id" },
        r.pick([`What's the status of ${s.key}?`, `is ${s.key} done yet?`]),
        [f.status!],
        [f.blocker!],
        {
          lead: `Checking ${s.key}.`,
          tool: "jira.get",
          query: s.key!,
        },
      );
    }
    if (x < 0.75) {
      return this.task(
        "ticket-topic",
        arc,
        { style: "topic" },
        r.pick([`How's the ${s.topic} going?`, `Any blockers on ${s.project}?`]),
        [f.blocker!],
        [f.status!],
        { lead: `Let me check on ${s.project}.`, tool: "slack.search", query: s.project! },
      );
    }
    const ref = this.personRef(arc);
    return this.task(
      "ticket-ping",
      arc,
      ref,
      `Ping ${ref.text} about the ${s.project} blocker`,
      [f.blocker!],
      [f.status!],
      { lead: `Messaging ${ref.text}.`, tool: "slack.search", query: s.project! },
    );
  }

  private invoice(): SimTask | null {
    const r = this.r;
    const arc = r.pick(this.arcs("invoice"));
    const s = arc.slots;
    const f = arc.facts;
    if (f.paid && r.chance(0.6)) {
      return this.task(
        "invoice-paid",
        arc,
        { style: "org" },
        r.pick([`Did we pay the ${s.org} invoice?`, `Has ${s.org} been paid?`]),
        [f.paid],
        [f.invoice!],
        {
          lead: `Checking payments to ${s.org}.`,
          tool: "gmail.search",
          query: `${s.org} invoice`,
        },
      );
    }
    return this.task(
      "invoice-amount",
      arc,
      { style: "org" },
      r.pick([`How much do we owe ${s.org}?`, `When is the ${s.org} invoice due?`]),
      [f.invoice!],
      f.paid ? [f.paid] : [],
      {
        lead: `Looking at the ${s.org} invoice.`,
        tool: "gmail.search",
        query: `${s.org} invoice`,
      },
    );
  }

  private personal(): SimTask | null {
    const r = this.r;
    const kind = r.pick(["landlord", "dentist", "gift", "school", "oneonone"] as const);
    const arc = this.arcs(kind)[0];
    if (!arc) return null;
    const f = arc.facts;
    switch (kind) {
      case "landlord":
        return this.task(
          "landlord",
          arc,
          { style: "role" },
          r.pick([
            "When is the boiler engineer coming?",
            "Did my landlord say when someone's coming to fix the boiler?",
            "remind me when the boiler guy is coming",
          ]),
          [f.visit!],
          [],
          {
            lead: "Checking with your landlord's last email.",
            tool: "gmail.search",
            query: "boiler",
            followUp: "Can you put it in my calendar?",
          },
        );
      case "dentist":
        return this.task(
          "dentist",
          arc,
          { style: "role" },
          r.pick(["When's my dentist appointment?", "I need to move the dentist, when is it again?"]),
          [f.appt!],
          [],
          {
            lead: "Looking at your dentist appointment.",
            tool: "calendar.search",
            query: "dentist",
          },
        );
      case "gift": {
        const ref = this.personRef(arc);
        return this.task(
          "gift",
          arc,
          ref,
          r.pick([`What should I get ${ref.text} for their birthday?`, `any gift ideas for ${ref.text}?`]),
          [f.idea!],
          [f.birthday!],
          {
            lead: `Here are gift ideas for ${ref.text}.`,
            tool: "drive.search",
            query: "gift ideas",
          },
        );
      }
      case "school":
        return this.task(
          "school",
          arc,
          { style: "role" },
          r.pick(["Anything I need to do for Maya's school trip?", "Did Maya's teacher send anything about the trip?"]),
          [f.trip!],
          [],
          {
            lead: "Checking the school emails.",
            tool: "gmail.search",
            query: "school trip",
          },
        );
      case "oneonone": {
        const ref = this.personRef(arc);
        return this.task(
          "oneonone",
          arc,
          ref,
          r.pick([`Prep me for my 1:1 with ${ref.text}`, `What's on the agenda with ${ref.text} this week?`]),
          [f.agenda!],
          [],
          {
            lead: `Pulling together your 1:1 agenda.`,
            tool: "drive.search",
            query: "1:1 notes",
          },
        );
      }
    }
  }

  // ── inbound events ──

  private external(): SimTask {
    const r = this.r;
    for (;;) {
      const x = r.next();
      if (x < 0.35) {
        const arc = r.pick(this.arcs("meeting"));
        const s = arc.slots;
        const text = `New email from ${s.full}: "${r.pick(["Running a bit late, still ok to meet?", "Can we push our plans?", `Still on for ${s.activity}?`])}"`;
        return this.externalTask("external-meeting", arc, text, [arc.facts.event!], [arc.facts.constraint!]);
      }
      if (x < 0.65) {
        const arc = r.pick(this.arcs("deal"));
        const s = arc.slots;
        const text = `New email from ${s.full} (${s.org}): "${r.pick(["Can we get on a call about the contract this week?", "Any update on the pricing?", "Legal is asking for the order form"])}"`;
        return this.externalTask(
          "external-deal",
          arc,
          text,
          [arc.facts.pricing!],
          [arc.facts.record!, arc.facts.notes!, arc.facts.call!],
        );
      }
      if (x < 0.85) {
        const arc = r.pick(this.arcs("ticket"));
        const s = arc.slots;
        const text = `Jira: ${s.key} was updated by ${s.full}`;
        return this.externalTask("external-ticket", arc, text, [arc.facts.blocker!], [arc.facts.status!]);
      }
      const arcs = this.arcs("invoice");
      const arc = r.pick(arcs);
      const s = arc.slots;
      const text = `New email from ${s.org}: "Reminder: invoice ${s.no} is overdue"`;
      const f = arc.facts;
      return this.externalTask(
        "external-invoice",
        arc,
        text,
        f.paid ? [f.paid] : [f.invoice!],
        f.paid ? [f.invoice!] : [],
      );
    }
  }

  private externalTask(type: string, arc: Arc, text: string, must: string[], ok: string[]): SimTask {
    const all = [...new Set([...must, ...ok])];
    return {
      type,
      style: "none",
      arc: arc.id,
      turns: [
        { event: { kind: "external", source: "gmail", text }, label: { kind: "need", must, ok } },
        {
          event: { kind: "agent_message", text: "You have a new message." },
          label: { kind: "context", ok: all },
          uses: all,
        },
      ],
    };
  }

  // ── tasks that need nothing ──

  private silentTask(type: string, text: string): SimTask {
    const turns: SimTurn[] = [
      { event: user(this.say(text)), label: { kind: "silent" } },
      { event: { kind: "agent_message", text: "Here you go." }, label: { kind: "silent" } },
    ];
    return { type, style: "none", turns };
  }

  /** A passing mention of someone the world knows, with no information need. */
  private softMention(): SimTask {
    const r = this.r;
    const arc = r.pick(this.w.arcs.filter((a) => a.person));
    const p = arc.person!;
    const name = r.chance(0.5) ? p.first : p.full;
    const text = r.pick([
      `haha ${name} just sent me the funniest meme`,
      `${name} says hi by the way`,
      `ugh I keep forgetting to reply to ${name}'s wedding photos`,
      `${name} recommended a great book on negotiation, what was it about again?`,
    ]);
    return {
      type: "soft-mention",
      style: "none",
      arc: arc.id,
      turns: [{ event: user(this.say(text)), label: { kind: "silent", soft: true } }],
    };
  }

  // ── questions for ask() ──

  asks(): AskCase[] {
    const out: AskCase[] = [];
    for (const arc of this.w.arcs) {
      const s = arc.slots;
      const f = arc.facts;
      const ref = arc.person ? this.personRef(arc) : { text: "", style: "none" as RefStyle };
      switch (arc.kind) {
        case "meeting":
          out.push({
            question: `When is my ${s.activity} with ${ref.text}?`,
            must: [f.event!],
            ok: [f.constraint!],
            style: ref.style,
            arc: arc.id,
          });
          out.push({
            question: `Any constraints for ${s.activity} with ${ref.text}?`,
            must: [f.constraint!],
            ok: [f.event!],
            style: ref.style,
            arc: arc.id,
          });
          break;
        case "deal":
          out.push({
            question: `What discount did ${s.org} ask for?`,
            must: [f.pricing!],
            ok: [f.record!, f.notes!],
            style: "org",
            arc: arc.id,
          });
          out.push({
            question: `What stage is the ${s.org} deal in?`,
            must: [f.record!],
            ok: [f.pricing!, f.notes!, f.call!],
            style: "org",
            arc: arc.id,
          });
          break;
        case "travel":
          out.push({
            question: `What's my flight to ${s.city}?`,
            must: [f.flight!],
            ok: [f.hotel!],
            style: "topic",
            arc: arc.id,
          });
          break;
        case "ticket":
          out.push({
            question: `What is blocking ${s.key}?`,
            must: [f.blocker!],
            ok: [f.status!],
            style: "id",
            arc: arc.id,
          });
          break;
        case "invoice":
          out.push({
            question: `How much is the ${s.org} invoice and when is it due?`,
            must: [f.invoice!],
            ok: f.paid ? [f.paid] : [],
            style: "org",
            arc: arc.id,
          });
          break;
        case "landlord":
          out.push({
            question: "When is the boiler engineer coming?",
            must: [f.visit!],
            ok: [],
            style: "role",
            arc: arc.id,
          });
          break;
        case "dentist":
          out.push({
            question: "When is my dentist appointment?",
            must: [f.appt!],
            ok: [],
            style: "role",
            arc: arc.id,
          });
          break;
        case "gift":
          out.push({
            question: `What gift ideas do I have for ${ref.text}?`,
            must: [f.idea!],
            ok: [f.birthday!],
            style: ref.style,
            arc: arc.id,
          });
          break;
        case "school":
          out.push({
            question: "What do I need to do for Maya's school trip?",
            must: [f.trip!],
            ok: [],
            style: "role",
            arc: arc.id,
          });
          break;
        case "oneonone":
          out.push({
            question: `What's on my 1:1 agenda with ${ref.text}?`,
            must: [f.agenda!],
            ok: [],
            style: ref.style,
            arc: arc.id,
          });
          break;
      }
    }
    return out;
  }
}

function user(text: string): TurnEvent {
  return { kind: "user_message", text };
}

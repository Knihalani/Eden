/**
 * A realistic synthetic workload for the engine, for end-to-end measurement (pipeline.bench.ts): one user's sources
 * (mail, calendar, docs, CRM) with items of varied length mentioning a few hundred people and organisations, and a
 * session event stream with a realistic mix of chatter, requests, agent turns, tool calls and external events.
 *
 * Sources answer instantly from a precomputed entity index, so the benchmark measures Eden's own CPU, not a source's.
 * Deterministic (seeded), so runs compare.
 */
import type { AgentEvent, ContextItem, Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST =
  "Dana Priya Bill Sam Zoë Mateo Aiko Lars Fatima Chen Olu Ingrid Raj Sofia Tomás Hana Kofi Elena Yusuf Mia".split(" ");
const LAST =
  "Lee Raman Lumbergh Ortiz Müller Tanaka Berg Haddad Wei Adeyemi Nilsen Patel Rossi García Kim Mensah Ivanova Demir Novak".split(
    " ",
  );
const ORGS =
  "Globex Initech Umbrella Hooli Vandelay Stark Wayne Acme Soylent Cyberdyne Wonka Tyrell Gringotts Oscorp Aperture".split(
    " ",
  );
const TOPICS = (
  "renewal contract pricing discount invoice budget roadmap launch hiring offsite flight hotel visa dentist " +
  "school pickup birthday dinner reservation insurance mortgage tax refund subscription onboarding migration " +
  "security audit incident postmortem quarterly review board deck proposal partnership support ticket"
).split(" ");
const FILLER = (
  "please let me know if that works for you thanks again for the quick reply we should sync next week about " +
  "the details as discussed on our call I have attached the latest version and shared notes with the team " +
  "looking forward to it best regards following up on this before the deadline can you confirm the time"
).split(" ");

export interface Workload {
  scope: Scope;
  sources: Source[];
  events: AgentEvent[];
  items: number;
  people: string[];
}

export function buildWorkload(options: { itemsPerSource: number; events: number; seed: number }): Workload {
  const r = rng(options.seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const people = Array.from({ length: 300 }, () => `${pick(FIRST)} ${pick(LAST)}`);
  const entities = [...new Set([...people, ...ORGS])];
  const scope = { tenantId: "bench", userId: "u1" };

  const sentence = () => {
    const words: string[] = [];
    const n = 6 + Math.floor(r() * 14);
    for (let i = 0; i < n; i++) {
      const x = r();
      words.push(x < 0.08 ? pick(entities) : x < 0.2 ? pick(TOPICS) : pick(FILLER));
    }
    return words.join(" ") + (r() < 0.2 ? `, ref ${pick(["OPS", "FIN", "HR"])}-${Math.floor(r() * 900 + 100)}.` : ".");
  };
  const body = (minBytes: number, maxBytes: number) => {
    const target = minBytes + Math.floor(r() ** 2 * (maxBytes - minBytes)); // skewed short, long tail
    let out = "";
    while (out.length < target) out += sentence() + " ";
    return out;
  };

  const make = (sourceId: string, i: number, title: string, text: string, mentions: string[]): Indexed => ({
    item: { id: `${sourceId}:${i}`, sourceId, ref: String(i), title, text },
    mentions: mentions.map((m) => m.toLowerCase()),
  });
  type Indexed = { item: ContextItem; mentions: string[] };
  const kinds: [string, (i: number) => Indexed][] = [
    [
      "gmail",
      (i) => {
        const who = pick(people);
        const org = pick(ORGS);
        return make("gmail", i, `Re: ${org} ${pick(TOPICS)}`, `${who}: ${body(150, 6_000)}`, [who, org]);
      },
    ],
    [
      "calendar",
      (i) => {
        const who = pick(people);
        return make(
          "calendar",
          i,
          `${pick(TOPICS)} with ${who}`,
          `${pick(["Mon", "Tue", "Wed", "Thu", "Fri"])} ${8 + Math.floor(r() * 10)}:00 ${body(40, 300)}`,
          [who],
        );
      },
    ],
    [
      "docs",
      (i) => {
        const org = pick(ORGS);
        return make("docs", i, `${org} ${pick(TOPICS)} notes`, body(500, 12_000), [org]);
      },
    ],
    [
      "crm",
      (i) => {
        const org = pick(ORGS);
        const who = pick(people);
        return make("crm", i, `${org} account`, `Contact ${who}. ${body(100, 1_200)}`, [org, who]);
      },
    ],
  ];

  const sources: Source[] = kinds.map(([id, gen]) => {
    const rows = Array.from({ length: options.itemsPerSource }, (_, i) => gen(i));
    const byEntity = new Map<string, ContextItem[]>();
    for (const row of rows) {
      for (const m of row.mentions) {
        const list = byEntity.get(m) ?? [];
        list.push(row.item);
        byEntity.set(m, list);
      }
    }
    return {
      id,
      kind: "bench",
      description: id,
      async search(q: SearchQuery): Promise<ContextItem[]> {
        const out: ContextItem[] = [];
        for (const e of q.entities)
          for (const it of byEntity.get(e.toLowerCase()) ?? []) if (out.length < q.limit) out.push(it);
        return out;
      },
    };
  });

  const events: AgentEvent[] = [];
  let at = Date.UTC(2026, 9, 1);
  const ev = (e: Record<string, unknown>) =>
    events.push({ ...scope, sessionId: `s${Math.floor(events.length / 40)}`, at: at++, ...e } as AgentEvent);
  for (let i = 0; i < options.events; i++) {
    const x = r();
    if (x < 0.3)
      ev({
        kind: "user_message",
        text: `Can you ${pick(TOPICS)} with ${pick(people)} about ${pick(ORGS)} ${pick(TOPICS)}?`,
      });
    else if (x < 0.45)
      ev({ kind: "user_message", text: pick(["thanks!", "ok", "sounds good", "yes please", "great"]) });
    else if (x < 0.7) ev({ kind: "agent_message", text: body(80, 1_500) });
    else if (x < 0.85)
      ev({ kind: "tool_call", tool: "gmail.search", input: { query: `${pick(people)} ${pick(TOPICS)}` } });
    else if (x < 0.95) ev({ kind: "tool_result", tool: "gmail.search", output: body(200, 4_000) });
    else ev({ kind: "external", source: "gmail", text: `New email from ${pick(people)}: ${body(100, 800)}` });
  }
  return { scope, sources, events, items: options.itemsPerSource * kinds.length, people };
}

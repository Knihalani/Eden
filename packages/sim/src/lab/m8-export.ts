/**
 * M8 (router, D940–D949; docs/research/m8-router.md): turns M2's synthetic worlds (`eden-synth` v2) into the router's
 * offline examples with Eden's own tokenizer, so the Python trainers never tokenize and the TypeScript router reads the
 * same features by construction. Each term is `fnv1a` of the shared tokenizer's folded term (`@eden/primitives`).
 *
 *   bun packages/sim/src/lab/m8-export.ts IN.jsonl OUT.jsonl
 *
 * One line a world: its sources (id, description terms), items (source, time, terms, names) and tasks (the fact's
 * source, rare, family, timing, the task's own item indexes, requests with their terms and names). Simulated data
 * only; lab tooling, nothing in a product package imports it.
 */
import { createReadStream, writeFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { routerTerms, routerNames } from "@eden/engine";

/** Descriptions of the five common sources, which M2's worlds do not carry (rare ones carry theirs). */
export const COMMON_DESCRIPTIONS: Record<string, string> = {
  gmail: "The user's email (Gmail): messages, receipts, newsletters and threads",
  calendar: "The user's calendar (Google Calendar): events, meetings and invitations",
  drive: "The user's documents (Google Drive): docs, sheets and shared files",
  slack: "The user's work chat (Slack): channels and direct messages",
  crm: "The user's CRM (HubSpot): contacts, deals and notes",
};

interface M2Item {
  id: string;
  source: string;
  title: string;
  text: string;
  at: number;
}
interface M2Task {
  family: string;
  timing: string;
  rare: boolean;
  fact: string;
  decoy: string;
  neutrals: string[];
  area: string;
  requests: { text: string; at: number; lang: string; style: string }[];
}
interface M2World {
  id: string;
  split: string;
  sources: Record<string, string>;
  items: M2Item[];
  tasks: M2Task[];
}

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) throw new Error("usage: m8-export.ts IN.jsonl OUT.jsonl");
  writeFileSync(outPath, "");
  const lines = createInterface({ input: createReadStream(inPath) });
  let n = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const w = JSON.parse(line) as M2World;
    const ids = new Set(w.items.map((i) => i.source));
    for (const s of Object.keys(w.sources)) ids.add(s);
    const sources = [...ids].sort().map((id) => ({
      id,
      d: routerTerms(`${id} ${w.sources[id] ?? COMMON_DESCRIPTIONS[id] ?? ""}`),
    }));
    const index = new Map(w.items.map((it, k) => [it.id, k]));
    const items = w.items.map((it) => ({
      s: it.source,
      at: it.at,
      h: routerTerms(`${it.title}\n${it.text}`),
      n: routerNames(`${it.title}\n${it.text}`),
    }));
    const tasks = w.tasks.map((t) => {
      const fact = w.items[index.get(t.fact)!];
      return {
        src: fact?.source ?? "",
        fact: index.get(t.fact) ?? -1,
        rare: t.rare,
        family: t.family,
        area: t.area,
        timing: t.timing,
        own: [t.fact, t.decoy, ...t.neutrals].map((x) => index.get(x)).filter((x) => x !== undefined),
        reqs: t.requests.map((r) => ({
          at: r.at,
          lang: r.lang,
          style: r.style,
          h: routerTerms(r.text),
          n: routerNames(r.text),
        })),
      };
    });
    appendFileSync(outPath, `${JSON.stringify({ id: w.id, split: w.split, sources, items, tasks })}\n`);
    n++;
  }
  console.log(`m8-export: ${n} worlds -> ${outPath}`);
}

if (import.meta.main) await main();

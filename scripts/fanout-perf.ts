/** A5 lookup latency: fan-out over 6 stub connectors — 4 fast (1-3ms), 1 slow (200ms), 1 dead (throws). */
import { SourceFanout } from "../packages/sources/src/guarded";
import type { ContextItem, Scope } from "../packages/protocol/src/index";
import type { SearchQuery, Source } from "../packages/sources/src/source";

const scope: Scope = { tenantId: "t", userId: "u" };
const q = (i: number): SearchQuery => ({ scope, text: `morning ${i}`, entities: [], limit: 10 });
const mk = (src: string, i: number, text: string): ContextItem => ({
  id: `${src}:${i}`,
  sourceId: src,
  ref: `${i}`,
  title: "",
  text,
});

function stub(id: string, ms: number | null, items = 2): Source {
  return {
    id,
    description: "",
    search: async (query: SearchQuery, signal?: AbortSignal) => {
      if (ms === null) throw new Error("down");
      await new Promise((r) => setTimeout(r, ms));
      if (signal?.aborted) throw new Error("aborted");
      return Array.from({ length: items }, (_, i) => mk(id, i, `doc ${i} ${query.text}`));
    },
  } as Source;
}

const fanout = new SourceFanout({ sanitize: (x) => x, ratePerSec: 10000, burst: 10000 });
const sources = [
  stub("cal", 2),
  stub("crm", 1),
  stub("drive", 3),
  stub("notes", 1),
  stub("gmail-slow", 200),
  stub("dead", null),
];

const times: number[] = [];
let items = 0;
let statuses: Record<string, number> = {};
for (let i = 0; i < 60; i++) {
  const t = performance.now();
  const out = await fanout.search(sources, q(i), { timeoutMs: 60 });
  times.push(performance.now() - t);
  items = out.filter((o) => o.status === "ok").reduce((n, o) => n + o.items.length, 0);
  statuses = {};
  for (const o of out) statuses[o.status] = (statuses[o.status] ?? 0) + 1;
}
times.sort((a, b) => a - b);
const p = (x: number) => times[Math.min(times.length - 1, Math.floor(times.length * x))]!.toFixed(1);
console.log(`lookups=60 sources=6 (one 200ms slow, one dead) timeoutMs=60`);
console.log(
  `p50=${p(0.5)}ms p95=${p(0.95)}ms max=${times.at(-1)!.toFixed(1)}ms items/lookup=${items} statuses=${JSON.stringify(statuses)}`,
);

/** Per-item cost of storing a source result: redaction, tokenizing, indexing, entity extraction (one user). */
import { SparseIndex, Vocab } from "@eden/primitives";
import { sanitizeForStore } from "@eden/redact";
import { bench, report } from "../../primitives/bench/harness";
import { extractTypedEntities, termIds } from "../src/text";
import { buildWorkload } from "./workload";

const w = buildWorkload({ itemsPerSource: 200, events: 1, seed: 7 });
const items = (
  await Promise.all(
    w.sources.map((s) => s.search({ scope: w.scope, text: "", entities: w.people.slice(0, 80), limit: 64 })),
  )
).flat();
const avg = Math.round(items.reduce((s, i) => s + i.text.length, 0) / items.length);
const vocab = new Vocab();
const idx = new SparseIndex({ fields: 2, weights: [2, 1] });
let i = 0;
const next = () => items[i++ % items.length]!;
console.log(`${items.length} items, avg text ${avg} chars`);
report([
  bench(
    "sanitizeForStore(title) + (text)",
    () => {
      const it = next();
      return sanitizeForStore(it.title) + sanitizeForStore(it.text);
    },
    { batch: 20 },
  ),
  bench(
    "termIds(title) + termIds(text)",
    () => {
      const it = next();
      return termIds(it.title, vocab, true).n + termIds(it.text, vocab, true).n;
    },
    { batch: 20 },
  ),
  bench(
    "SparseIndex.addFields + remove",
    () => {
      const it = next();
      const t = termIds(it.text, vocab, true);
      const d = idx.addFields([new Uint32Array(0), t.ids], [0, t.n]);
      idx.remove(d);
      return d;
    },
    { batch: 20 },
  ),
  bench(
    "extractTypedEntities(title + text)",
    () => {
      const it = next();
      return extractTypedEntities(`${it.title}. ${it.text}`).length;
    },
    { batch: 20 },
  ),
]);

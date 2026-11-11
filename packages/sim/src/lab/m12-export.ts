/**
 * M12's training export (lab only; docs/research/m12-pool.md): texts as the engine's index and query see them.
 *
 * `--synth F.jsonl` reads M2 worlds (packages/sim/lab/synth/README.md); `--corpus F.jsonl` reads a funnel or
 * days-calls `--corpus-dump`. Writes one JSON line a world: `items` (id, title terms, text terms: the shared
 * tokenizer's folded terms, as `ItemCache` indexes them) and `requests` (id or template, the query's terms: folded,
 * stopwords out, as `rank` builds its query), plus the labels the input carries (fact, decoy, neutrals; planted).
 *
 *   bun packages/sim/src/lab/m12-export.ts --synth .local/m2/synth/worlds/val.jsonl --out sval.terms.jsonl
 *   bun packages/sim/src/lab/m12-export.ts --corpus fit-corpus.jsonl --out fit.terms.jsonl
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { isStopword } from "@eden/engine";
import { tokenize, Vocab } from "@eden/primitives";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const synth = opt("synth");
const corpus = opt("corpus");
const outPath = opt("out");
if ((!synth && !corpus) || !outPath) throw new Error("usage: --synth F | --corpus F, --out F");

const vocab = new Vocab();
const terms = (s: string) => tokenize(s, vocab);
const query = (s: string) => terms(s).filter((t) => !isStopword(t));

const out = createWriteStream(outPath);
const lines = createInterface({ input: createReadStream((synth ?? corpus)!), crlfDelay: Infinity });
let n = 0;
for await (const line of lines) {
  if (!line.trim()) continue;
  const w = JSON.parse(line);
  const items = (
    w.items as { id?: string; key?: string; title?: string; text?: string; source?: string; at?: number }[]
  ).map((it) => ({
    id: it.id ?? it.key,
    source: it.source ?? (it.id ?? "").split(":")[0],
    at: it.at ?? null,
    title: terms(it.title ?? ""),
    text: terms(it.text ?? ""),
    chars: (it.text ?? "").length,
  }));
  if (synth) {
    const tasks = (w.tasks as any[]).map((t) => ({
      id: t.id,
      family: t.family,
      fact: t.fact,
      decoy: t.decoy,
      neutrals: t.neutrals ?? [],
      requests: (t.requests as any[]).map((r) => ({
        id: r.id,
        style: r.style,
        lang: r.lang,
        at: r.at,
        q: query(r.text),
      })),
    }));
    out.write(`${JSON.stringify({ world: w.id, split: w.split, items, tasks })}\n`);
  } else {
    const tasks = (w.tasks as any[]).map((t) => ({ template: t.template, planted: t.planted, q: query(t.request) }));
    out.write(`${JSON.stringify({ suite: w.suite, seed: w.seed, variant: w.variant, items, tasks })}\n`);
  }
  n++;
}
out.end();
console.error(`m12-export: ${n} worlds → ${outPath}`);

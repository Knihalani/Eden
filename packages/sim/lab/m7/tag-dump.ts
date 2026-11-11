/**
 * M7 (D930): the constraint tagger's nine logits for every item of a `--check-dump` file, as the engine's `TagMemo`
 * reads them (the cached item's `title\ntext`), written beside it (`<dump>.tags.jsonl`, one line a row: logits per
 * item). The tagger module is M3's (`tagger.ts`, D908), passed by path until it is on main.
 *
 *   bun packages/sim/lab/m7/tag-dump.ts TAGGER_TS DUMP.jsonl [...]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [taggerPath, ...dumps] = process.argv.slice(2);
if (!taggerPath || dumps.length === 0) throw new Error("usage: tag-dump.ts TAGGER_TS DUMP.jsonl ...");
const mod = (await import(taggerPath)) as {
  sharedTagger: () => { logits(text: string): number[]; header: { tags: string[] } } | null;
};
const tagger = mod.sharedTagger();
if (!tagger) throw new Error("no tagger");
const memo = new Map<string, number[]>();
for (const file of dumps) {
  const out: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { items: { title: string; text: string; full?: string }[] };
    const logits = row.items.map((it) => {
      const text = it.full || `${it.title}\n${it.text}`;
      let l = memo.get(text);
      if (!l) memo.set(text, (l = tagger.logits(text).map((x) => Math.round(x * 1e4) / 1e4)));
      return l;
    });
    out.push(JSON.stringify({ tags: tagger.header.tags, logits }));
  }
  writeFileSync(file.replace(/\.jsonl$/, ".tags.jsonl"), out.join("\n") + "\n");
  console.log(`${file}: ${out.length} rows, ${memo.size} distinct items so far`);
}

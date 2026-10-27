// Sanity: dev/test leakage; lexical overlap of cues with their gold memories (rare = df<=5 over live docs).
import { writeFileSync } from "node:fs";
import { BM25F, toks } from "./lex";
const mems: any[] = await Bun.file("fixture/memories.json").json();
const cues: any[] = await Bun.file("fixture/cues.json").json();
const live = mems.filter((m) => !m.superseded_by);
const byId = new Map(live.map((m) => [m.id, m]));
const bm = new BM25F(live, false);
// leakage
const goldSplit = new Map<string, Set<string>>();
for (const c of cues) for (const g of c.gold) (goldSplit.get(g) ?? goldSplit.set(g, new Set()).get(g)!).add(c.split);
const straddle = [...goldSplit].filter(([, s]) => s.size > 1).map(([g]) => g);
const norm = (s: string) => new Set(toks(s));
const jac = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / Math.max(1, a.size + b.size - i);
};
const dev = cues.filter((c) => c.split === "dev"),
  test = cues.filter((c) => c.split === "test");
let exact = 0,
  near: string[] = [];
for (const a of test)
  for (const b of dev) {
    if (a.cue.toLowerCase() === b.cue.toLowerCase()) exact++;
    else if (jac(norm(a.cue), norm(b.cue)) >= 0.8) near.push(`${a.id}~${b.id}: "${a.cue}" / "${b.cue}"`);
  }
// overlap
const ov: Record<string, string> = {};
const tally: Record<string, Record<string, number>> = {};
for (const c of cues) {
  if (!c.gold.length) continue;
  const q = new Set(toks(c.cue));
  let cls = "none";
  for (const g of c.gold) {
    const d = byId.get(g)!;
    const dt = new Set(toks(`${d.subject} ${d.text}`));
    for (const t of q)
      if (dt.has(t)) {
        const df = bm.df.get(t) ?? 0;
        if (df <= 5) cls = "rare";
        else if (cls === "none") cls = "common";
      }
  }
  ov[c.id] = cls;
  const key = `${c.cat}/${c.author}`;
  (tally[key] ??= { none: 0, common: 0, rare: 0 })[cls]++;
}
writeFileSync("out/overlap.json", JSON.stringify(ov));
// negatives sharing rare tokens with any visible memory
let negRare = 0,
  negAny = 0;
const negs = cues.filter((c) => !c.gold.length);
for (const c of negs) {
  const q = toks(c.cue);
  if (q.some((t) => (bm.df.get(t) ?? 0) > 0)) negAny++;
  if (
    q.some((t) => {
      const df = bm.df.get(t) ?? 0;
      return df > 0 && df <= 5;
    })
  )
    negRare++;
}
console.log(
  JSON.stringify(
    {
      memories_straddling_splits: straddle,
      exact_dup_cues_across_splits: exact,
      near_dup_cues_across_splits: near.length,
      near_examples: near.slice(0, 8),
      overlap_by_cat_author: tally,
      negatives: negs.length,
      negatives_sharing_any_indexed_token: negAny,
      negatives_sharing_rare_token_df_le5: negRare,
    },
    null,
    1,
  ),
);

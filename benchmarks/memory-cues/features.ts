// Computes per-(cue, visible live doc) features for M1/M2/M3/M4/M7. Output: out/features-ts.json
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("out", { recursive: true });
import { BM25F, ctxCue, toks, trigrams, triCos, visible, type Doc } from "./lex";
import { loadM2V } from "./m2v";

const mems: (Doc & { superseded_by: string | null })[] = await Bun.file("fixture/memories.json").json();
const cues: any[] = await Bun.file("fixture/cues.json").json();
const aliasPath = process.env.ALIASES ?? "fixture/aliases.json";
const aliases: Record<string, string[]> = existsSync(aliasPath) ? await Bun.file(aliasPath).json() : {};
const live = mems.filter((m) => !m.superseded_by);
const docsA = live.map((d) => ({ ...d, aliases: aliases[d.id] ?? [] }));
const bm = new BM25F(live, false),
  bmA = new BM25F(docsA, true);
// A2 §2.3 cap: keep an alias phrase only if every token it adds stays rare (df over text+aliases <= ALIAS_DF_CAP) — no fat postings from expansion
const ALIAS_DF_CAP = Number(process.env.ALIAS_DF_CAP ?? 6);
const docsC = docsA.map((d) => ({
  ...d,
  aliases: d.aliases.filter((a) => toks(a).every((t) => (bmA.df.get(t) ?? 0) <= ALIAS_DF_CAP)),
}));
const bmC = new BM25F(docsC, true);
writeFileSync("out/aliases-capped.json", JSON.stringify(Object.fromEntries(docsC.map((d) => [d.id, d.aliases]))));
const docTri = live.map((d) => trigrams(toks(`${d.subject} ${d.text}`)));
const models = { b8: loadM2V("m2v/potion-base-8M"), r32: loadM2V("m2v/potion-retrieval-32M") };
const docVec: Record<string, Float32Array[]> = {},
  docVecA: Record<string, Float32Array[]> = {};
for (const [k, m] of Object.entries(models)) {
  docVec[k] = live.map((d) => m.embed(`${d.subject}: ${d.text}`));
  docVecA[k] = docsA.map((d) => m.embed(`${d.subject}: ${d.text} ${d.aliases.join(", ")}`));
}
const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

const out: Record<string, any> = {};
for (const c of cues) {
  const vis = live.map((d, i) => [d, i] as const).filter(([d]) => visible(c.scope, d));
  const rec: any = { docs: vis.map(([d]) => d.id), f: {} as Record<string, number[]> };
  for (const [tag, text] of [
    ["", c.cue],
    ["_ctx", ctxCue(c.cue, c.last_paths, c.prev_turn)],
  ] as const) {
    const q = toks(text),
      qt = trigrams(q);
    const s1 = vis.map(([, i]) => bm.score(q, i)),
      s3 = vis.map(([, i]) => bmA.score(q, i));
    rec.f["bm25" + tag] = s1.map((x) => x.s);
    rec.f["maxidf" + tag] = s1.map((x) => x.maxIdf);
    rec.f["nmatch" + tag] = s1.map((x) => x.nMatch);
    rec.f["mindf" + tag] = s1.map((x) => (x.dfs.length ? Math.min(...x.dfs) : 1e9));
    for (const D of [10, 25, 50]) rec.f[`n${D}` + tag] = s1.map((x) => x.dfs.filter((d) => d <= D).length);
    rec.f["bm25a" + tag] = s3.map((x) => x.s);
    rec.f["maxidfa" + tag] = s3.map((x) => x.maxIdf);
    rec.f["bm25c" + tag] = vis.map(([, i]) => bmC.score(q, i).s);
    rec.f["tri" + tag] = vis.map(([, i]) => triCos(qt, docTri[i]!));
    for (const [k, m] of Object.entries(models)) {
      const v = m.embed(text);
      rec.f[`cos_${k}${tag}`] = vis.map(([, i]) => dot(v, docVec[k]![i]!));
      rec.f[`cosa_${k}${tag}`] = vis.map(([, i]) => dot(v, docVecA[k]![i]!));
    }
  }
  out[c.id] = rec;
}
mkdirSync("out", { recursive: true });
writeFileSync("out/features-ts.json", JSON.stringify(out));
writeFileSync(
  "out/ctx.json",
  JSON.stringify(Object.fromEntries(cues.map((c) => [c.id, ctxCue(c.cue, c.last_paths, c.prev_turn)]))),
);
console.log("features for", cues.length, "cues;", live.length, "live docs; aliases for", Object.keys(aliases).length);

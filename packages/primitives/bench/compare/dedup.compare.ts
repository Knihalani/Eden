/**
 * Our reply stripper and sketches against the npm libraries for the same jobs, on the same corpus and workloads.
 * The libraries are not repo dependencies: install them in a scratch directory and point LIBEVAL at it.
 *
 *   mkdir -p /tmp/libeval && cd /tmp/libeval && echo '{}' > package.json && bun add email-reply-parser@2.3.9 \
 *     planer@1.2.0 talonjs@1.0.28 node-email-reply-parser@0.1.4 parse-reply@0.0.4 minhash@0.0.9 minhashjs@1.0.1 \
 *     simhash-js@1.0.0 simhash@0.1.0
 *   LIBEVAL=/tmp/libeval bun packages/primitives/bench/compare/dedup.compare.ts
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { hamming64, minhashSimilarity, TextSketcher } from "../../src/dedup";
import { dedupText, stripReply } from "../../src/reply";
import { tokenize } from "../../src/tokenize";
import { Vocab } from "../../src/vocab";
import { dedupCorpus } from "../dedup-corpus";
import { jaccard, keptLines, prf, scorePairs, StripScorer } from "../dedup-eval";
import { bench, flat, report } from "../harness";

const dir = process.env.LIBEVAL;
if (!dir) throw new Error("set LIBEVAL to the directory with the libraries installed");
const req = createRequire(join(dir, "package.json"));
const mod = (name: string) => join(dir, "node_modules", name);

const EmailReplyParser = (await import(join(mod("email-reply-parser"), "dist/emailreplyparser.js"))).default;
const planer = req("planer");
const talon = req("talonjs");
const nerp = req("node-email-reply-parser");
const parseReply = req("parse-reply");
const { Minhash } = req("minhash");
// minhashjs's ESM entry re-exports the CommonJS module object as `MinHash` (not a constructor): load the file.
const MinHashJs = req(join(mod("minhashjs"), "MinHash.js")).MinHash;
const SimHashJs = req("simhash-js").SimHash;
const simhashCrc = req("simhash")();

const SEED = Number(process.env.SEED ?? 2);
const items = dedupCorpus(SEED, { threads: 150, docs: 60, notifications: 48 });

const strippers: [string, (t: string) => string][] = [
  ["ours: stripReply", (t) => stripReply(t)],
  ["email-reply-parser 2.3.9", (t) => new EmailReplyParser().read(t).getVisibleText()],
  ["planer 1.2.0 (talon port)", (t) => planer.extractFromPlain(t)],
  ["talonjs 1.0.28", (t) => talon.quotations.extractFromPlain(t).body],
  ["node-email-reply-parser 0.1.4", (t) => nerp(t).getVisibleText()],
  ["parse-reply 0.0.4", (t) => parseReply(t)],
];

const SECTIONS = (process.env.SECTIONS ?? "strip,sketch").split(",");
const mid = flat(items.find((it) => it.kind === "reply" && it.text.length >= 1800 && it.text.length < 2600)!.text);
if (SECTIONS.includes("strip")) compareStrippers();

function compareStrippers(): void {
  console.log(
    `## Reply stripping, line level, seed ${SEED} (forwards scored separately: libraries keep forwarded text)`,
  );
  for (const [name, strip] of strippers) {
    const replies = new StripScorer();
    const forwards = new StripScorer();
    let errors = 0;
    for (const it of items) {
      if (it.labels === null) continue;
      let out: string;
      try {
        out = strip(it.text);
      } catch {
        errors++;
        out = it.text;
      }
      (it.kind.startsWith("fwd") ? forwards : replies).add(it, keptLines(it.lines!, out));
    }
    const r = replies.score();
    const f = forwards.score();
    const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";
    console.log(
      `${name.padEnd(30)} replies: own kept ${pct(r.ownKept)} removed ${pct(r.removed)} exact ${pct(r.exact)} | ` +
        `forwards: own kept ${pct(f.ownKept)} removed ${pct(f.removed)}${errors ? ` | threw ${errors}` : ""}`,
    );
  }

  console.log("\n## Reply stripping speed");
  const colons = flat(Array.from({ length: 2000 }, (_, i) => `Note ${i}: the agenda item number ${i} is:`).join("\n"));
  const oneLine = flat("On Monday the team ".repeat(5_000) + "wrote:");
  const rows = [];
  for (const [name, strip] of strippers) {
    rows.push(bench(`${name}  2 KB reply`, () => strip(mid), { batch: 10, batches: 100 }));
  }
  for (const [name, strip] of strippers) {
    rows.push(bench(`${name}  2000 lines ending ':' (84 KB)`, () => strip(colons), { batch: 1, batches: 20 }));
    rows.push(bench(`${name}  one 95 KB line`, () => strip(oneLine), { batch: 1, batches: 20 }));
  }
  report(rows);
}

if (!SECTIONS.includes("sketch")) process.exit(0);

// MinHash: estimator error against exact Jaccard, on the shingle sets of the corpus (stripped), same shingles fed
// to every implementation as strings "t1 t2 t3".
console.log("\n## MinHash implementations: error against exact Jaccard (corpus pairs with Jaccard >= 0.3), speed");
const vocab = new Vocab(4096);
const shingleStrings = items.map((it) => {
  const terms = tokenize(dedupText(it.text, 6), vocab);
  const out = new Set<string>();
  if (terms.length < 3) out.add(terms.join(" "));
  for (let i = 0; i + 3 <= terms.length; i++) out.add(terms.slice(i, i + 3).join(" "));
  return [...out];
});
const sk = new TextSketcher(new Vocab(4096), 8192, 3);
const buf = new Uint32Array(8192);
const ours = items.map((it) => {
  sk.load(dedupText(it.text, 6));
  const sig = new Uint32Array(128);
  sk.minhash(sig);
  const n = sk.copyShingles(buf);
  return { sig, set: Uint32Array.from(new Set(buf.subarray(0, n))).sort() };
});
const duhaime = shingleStrings.map((s) => {
  const m = new Minhash({ numPerm: 128 });
  for (const x of s) m.update(x);
  return m;
});
const datasketch = shingleStrings.slice(0, 300).map((s) => {
  const m = new MinHashJs({ num_perm: 128 });
  for (const x of s) m.update(x);
  return m;
});
const errs: Record<string, number[]> = { ours: [], "minhash 0.0.9": [], "minhashjs 1.0.1 (first 300 items)": [] };
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    const J = jaccard(ours[i]!.set, ours[j]!.set);
    if (J < 0.3) continue;
    errs.ours!.push(minhashSimilarity(ours[i]!.sig, ours[j]!.sig) - J);
    errs["minhash 0.0.9"]!.push(duhaime[i]!.jaccard(duhaime[j]!) - J);
    if (j < 300) errs["minhashjs 1.0.1 (first 300 items)"]!.push(datasketch[i]!.jaccard(datasketch[j]!) - J);
  }
}
for (const [name, e] of Object.entries(errs)) {
  const bias = e.reduce((s, x) => s + x, 0) / e.length;
  const rmse = Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length);
  console.log(
    `${name.padEnd(36)} pairs ${e.length}  bias ${bias.toFixed(4)}  rmse ${rmse.toFixed(4)} (theory ~ <= 0.044)`,
  );
}
const midShingles = shingleStrings[items.indexOf(items.find((it) => it.text === mid) ?? items[0]!)]!;
const sig = new Uint32Array(128);
const midText = dedupText(mid, 6);
report([
  bench(`ours: load + minhash (${midShingles.length} shingles)`, () => (sk.load(midText), sk.minhash(sig)), {
    batch: 10,
  }),
  bench(
    "minhash 0.0.9: update per shingle string",
    () => {
      const m = new Minhash({ numPerm: 128 });
      for (const x of midShingles) m.update(x);
      return m;
    },
    { batch: 2, batches: 50 },
  ),
  bench(
    "minhashjs 1.0.1: update per shingle string",
    () => {
      const m = new MinHashJs({ num_perm: 128 });
      for (const x of midShingles) m.update(x);
      return m;
    },
    { batch: 1, batches: 20 },
  ),
]);

console.log("\n## SimHash implementations: pair quality on stripped text at each one's best threshold");
const sim = new Uint32Array(2);
const ourSim = items.map((it) => {
  sk.load(dedupText(it.text, 6));
  sk.simhash(sim);
  return [sim[0]!, sim[1]!] as const;
});
const sjs = new SimHashJs();
const simJs = items.map((it) => sjs.hash(dedupText(it.text, 6)) >>> 0);
const simCrc = shingleStrings.map((s) => {
  const bits: number[] = simhashCrc(s);
  let v = 0;
  for (let b = 0; b < 32; b++) if (bits[b]) v |= 1 << b;
  return v >>> 0;
});
const thresholds = [0, 1, 2, 3, 4, 6, 8, 10];
const names = [
  ...thresholds.map((t) => `ours 64-bit <= ${t}`),
  ...thresholds.map((t) => `simhash-js 32-bit <= ${t}`),
  ...thresholds.map((t) => `simhash (crc32) 32-bit <= ${t}`),
];
const res = scorePairs(items, names, (i, j, out) => {
  const h = hamming64(ourSim[i]![0], ourSim[i]![1], ourSim[j]![0], ourSim[j]![1]);
  const hj = hamming64(simJs[i]!, 0, simJs[j]!, 0);
  const hc = hamming64(simCrc[i]!, 0, simCrc[j]!, 0);
  thresholds.forEach((t, k) => {
    out[k] = h <= t;
    out[thresholds.length + k] = hj <= t;
    out[2 * thresholds.length + k] = hc <= t;
  });
});
names.forEach((n, m) => console.log(`${n.padEnd(32)} ${prf(res.counts[m]!)}`));
report([
  bench("ours: load + simhash", () => (sk.load(midText), sk.simhash(sim)), { batch: 10 }),
  bench("simhash-js: hash(text)", () => sjs.hash(midText), { batch: 10 }),
  bench("simhash (crc32): hash(shingle strings)", () => simhashCrc(midShingles), { batch: 5 }),
]);

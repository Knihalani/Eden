/**
 * O1 (docs/research/o1-earn.md §2c): what `sourceYieldEarn`'s table of rare words (`RareTerms`) weighs for a user of
 * the lab's noise connectors, beside the default's sketches, and how well each says which sources hold a word.
 *   bun packages/sim/src/lab/o1-rare-bytes.ts [sources=995] [vocab=1000] [items=20]
 */
import { RareTerms } from "../../../engine/src/rare-terms";
import { TermSketch, sketchTerms, termHashes } from "../../../engine/src/sketch";
import { buildWorld } from "../world";
import { noiseSources } from "./noise-sources";

const [n = 995, vocab = 1000, items = 20] = process.argv.slice(2).map(Number);
const world = buildWorld({ seed: 41 });
const sources = noiseSources(world, n, items, 0, 41, vocab);
const rare = new RareTerms();
const sketches: TermSketch[] = [];
let sketchBytes = 0;
let pairs = 0;
const distinct = new Set<string>();
for (const s of sources) {
  const seen = new Set<string>();
  // A listing can fail by the profile's error draws: read until the page comes.
  for (let tries = 0; tries < 20; tries++) {
    try {
      const page = await s.list({ tenantId: "t", userId: "u" }, undefined, 1_000, new AbortController().signal);
      for (const it of page.items) for (const t of sketchTerms(`${it.title} ${it.text}`)) seen.add(t);
      break;
    } catch {
      // Tried again.
    }
  }
  const sk = new TermSketch();
  for (const t of seen) {
    const [h1, h2] = termHashes(t);
    sk.add(h1, h2);
    rare.add(s.id, h1, h2);
    distinct.add(t);
  }
  sk.fold();
  sketchBytes += sk.bytes;
  pairs += seen.size;
  sketches.push(sk);
}
// Words no source holds: every holder named is a false one.
const probes = 500;
let bySketch = 0;
let byTable = 0;
for (let i = 0; i < probes; i++) {
  const [h1, h2] = termHashes(`unseen-${i}`);
  bySketch += sketches.filter((sk) => sk.has(h1, h2)).length;
  byTable += rare.holders(h1, h2, 2).length;
}
console.log(
  JSON.stringify({
    sources: n,
    termsPerSource: Math.round(pairs / n),
    distinctTerms: distinct.size,
    sketchBytesPerUser: sketchBytes,
    sketchFalseHoldersPerWord: +(bySketch / probes).toFixed(2),
    tableBytesPerUser: rare.bytes,
    tableWords: rare.size,
    tableWordsNotAdded: rare.dropped,
    tableFalseHoldersPerWord: +(byTable / probes).toFixed(3),
  }),
);

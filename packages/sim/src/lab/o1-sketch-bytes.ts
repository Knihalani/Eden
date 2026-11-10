/**
 * O1 (docs/research/o1-earn.md): what a user's sketches weigh with two and with four probes, and how many false
 * holders `Sync.sketchRare` would see, over the lab's noise connectors with words of their own.
 *   bun packages/sim/src/lab/o1-sketch-bytes.ts [sources=995] [vocab=1000] [items=20]
 */
import { TermSketch, sketchTerms, termHashes } from "../../../engine/src/sketch";
import { buildWorld } from "../world";
import { noiseSources } from "./noise-sources";

const [n = 995, vocab = 1000, items = 20] = process.argv.slice(2).map(Number);
const world = buildWorld({ seed: 41 });
const sources = noiseSources(world, n, items, 0, 41, vocab);
for (const probes of [2, 4] as const) {
  let bytes = 0;
  let terms = 0;
  const sketches: TermSketch[] = [];
  for (const s of sources) {
    const sk = new TermSketch(probes);
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
    for (const t of seen) sk.add(...termHashes(t));
    sk.fold();
    terms += seen.size;
    bytes += sk.bytes;
    sketches.push(sk);
  }
  // Words no source holds: every holder is a false match.
  let holders = 0;
  let rare = 0;
  const probesN = 500;
  for (let i = 0; i < probesN; i++) {
    const h = termHashes(`unseen-${i}`);
    const c = sketches.filter((sk) => sk.has(h[0], h[1])).length;
    holders += c;
    if (c <= 1) rare++;
  }
  console.log(
    JSON.stringify({
      probes,
      sources: n,
      termsPerSource: Math.round(terms / n),
      sketchBytesPerUser: bytes,
      meanFalseHolders: +(holders / probesN).toFixed(2),
      unseenWordsWithAtMostOneFalseHolder: `${rare}/${probesN}`,
    }),
  );
}

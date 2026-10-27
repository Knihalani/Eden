import { contentTerms } from "../../engine/src/text";
import { tokenizeInto } from "../src/tokenize";
import { Vocab } from "../src/vocab";
import { bench, consume, corpus, report } from "./harness";

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu;
const results = [];
for (const [size, nonAscii] of [
  [2048, false],
  [2048, true],
  [16384, false],
] as const) {
  const text = corpus(size, { nonAscii });
  const vocab = new Vocab(4096);
  const out = new Uint32Array(text.length);
  tokenizeInto(text, vocab, true, out, null); // warm vocabulary: steady state for a user's index
  const map = new Map<string, number>();
  const label = `${size}B${nonAscii ? " +10% non-ASCII" : ""}`;
  results.push(
    bench(`engine contentTerms (regex, today)  ${label}`, () => contentTerms(text), { batch: 20 }),
    bench(
      `regex match + toLowerCase + Map     ${label}`,
      () => {
        let n = 0;
        for (const m of text.toLowerCase().matchAll(WORD)) {
          let id = map.get(m[0]);
          if (id === undefined) map.set(m[0], (id = map.size));
          n += id;
        }
        return n;
      },
      { batch: 20 },
    ),
    bench(`tokenizeInto (fused, steady state)  ${label}`, () => tokenizeInto(text, vocab, true, out, null), {
      batch: 20,
    }),
    bench(`tokenizeInto (lookup only)          ${label}`, () => tokenizeInto(text, vocab, false, out, null), {
      batch: 20,
    }),
  );
}
report(results);
consume(0);

/** The same primitives under whichever runtime runs this file (see runtime.sh). No Bun-only APIs. */
import { S3FifoCache } from "../src/cache";
import { MultiMatcher } from "../src/matcher";
import { TopK } from "../src/topk";
import { tokenizeInto } from "../src/tokenize";
import { Vocab } from "../src/vocab";
import { bench, corpus, report } from "./harness";

const text = corpus(2048);
const accented = corpus(2048, { nonAscii: true });
const vocab = new Vocab(4096);
const out = new Uint32Array(4096);
tokenizeInto(text, vocab, true, out, null);
tokenizeInto(accented, vocab, true, out, null);
const keywords =
  "access_token api_key apikey auth bearer client_secret credential password private_key secret token".split(" ");
const matcher = new MultiMatcher(keywords);
const hits = new Uint8Array(keywords.length);
const cache = new S3FifoCache<number, number>({ maxBytes: 10_000 });
let p = 0;
const topk = new TopK(10);
const scores = Float64Array.from({ length: 10_000 }, (_, i) => Math.sin(i) * 1000);
const ids = new Int32Array(10);
report([
  bench("tokenizeInto 2 KB ASCII", () => tokenizeInto(text, vocab, true, out, null), { batch: 20 }),
  bench("tokenizeInto 2 KB +10% non-ASCII", () => tokenizeInto(accented, vocab, true, out, null), { batch: 20 }),
  bench(
    "MultiMatcher.markHits 11 kw, 2 KB",
    () => {
      hits.fill(0);
      return matcher.markHits(text, hits);
    },
    { batch: 20 },
  ),
  bench(
    "S3FifoCache get/set",
    () => {
      const k = (Math.imul(p++, 2654435761) >>> 0) % 30_000;
      const v = cache.get(k);
      if (v === undefined) cache.set(k, k);
      return v;
    },
    { batch: 1000 },
  ),
  bench(
    "TopK(10) pushDense over 10k",
    () => {
      topk.pushDense(scores, 0, scores.length, -Infinity);
      return topk.drain(ids, null);
    },
    { batch: 5 },
  ),
]);

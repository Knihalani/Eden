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
// The same with groups (as SourceFanout's results cache): 300 groups of 100 keys.
const grouped = new S3FifoCache<number, number>({ maxBytes: 10_000, group: (k) => k % 300 });
let pg = 0;
// One (user, source) pair's drop from 10,000 pages in 500 pairs of 20, then the pair's pages set again.
const pageKey = (pair: number, i: number) => `tenant/user${pair}|src|5|query text number ${i} with words`;
const pairOf = (k: string) => k.slice(0, k.indexOf("|", k.indexOf("|") + 1));
const pages = (group: boolean) => {
  const c = new S3FifoCache<string, number>(group ? { maxBytes: 1e12, group: pairOf } : { maxBytes: 1e12 });
  for (let pair = 0; pair < 500; pair++) for (let i = 0; i < 20; i++) c.set(pageKey(pair, i), i);
  return c;
};
const byScan = pages(false);
const byGroup = pages(true);
let dw = 0;
let dg = 0;
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
    "S3FifoCache get/set, grouped",
    () => {
      const k = (Math.imul(pg++, 2654435761) >>> 0) % 30_000;
      const v = grouped.get(k);
      if (v === undefined) grouped.set(k, k);
      return v;
    },
    { batch: 1000 },
  ),
  bench(
    "S3FifoCache drop 1 pair of 10k: deleteWhere + refill",
    () => {
      const pair = dw++ % 500;
      const n = byScan.deleteWhere((k) => k.startsWith(`tenant/user${pair}|src|`));
      for (let i = 0; i < 20; i++) byScan.set(pageKey(pair, i), i);
      return n;
    },
    { batch: 1, batches: 300 },
  ),
  bench(
    "S3FifoCache drop 1 pair of 10k: deleteGroup + refill",
    () => {
      const pair = dg++ % 500;
      const n = byGroup.deleteGroup(`tenant/user${pair}|src`);
      for (let i = 0; i < 20; i++) byGroup.set(pageKey(pair, i), i);
      return n;
    },
    { batch: 1, batches: 300 },
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

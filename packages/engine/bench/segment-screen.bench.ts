/**
 * O4's screen for O2's segment redesign (docs/research/o4-segment-screens.md): would a user's postings as delta-coded
 * varints be small enough, and how much slower is a search that decodes them? A screen, not product code: the
 * varint segment here is read-only and built in one go from a user's docs.
 *
 * Same corpus and queries as `index-memory.bench.ts` (a sim world, title and text as two fields, weights 2 and 1,
 * 4-term queries, k 20). For each user size it prints:
 *
 * - bytes an item of the packed `SparseIndex` by part (its typed arrays' sizes, settled), and of three encodings of
 *   the same postings: `key` (one list per (term, field): a varint doc gap and a tf byte; a Uint32 offset per key),
 *   `term` (one list per term: a varint doc gap and one byte for both fields' tf; a Uint32 offset per 16 terms and a
 *   length before each list), and the forward arena (each doc's sorted term ids, which `termsOf`, `containsAll` and
 *   removal need) as it is today and as varint gaps;
 * - search time of each, interleaved in one process, and whether every result (docs, scores, coverage, matched) is
 *   identical to the packed index's. `term` is searched in two passes a term (field 0's postings, then field 1's:
 *   the packed index's order, so ties in top-k fall the same way) and in one pass (faster; ties may differ).
 *
 * Two more screens, each its own mode:
 *
 * - `columns [n]`: the heap of `n` entries as objects (today's shape, without text and index) against typed-array
 *   columns with one byte arena for the strings;
 * - `text [n] [--prose]`: bytes an item and the time to read one item's text, each item deflated on its own (today)
 *   against zstd over blocks of 1, 16 and 32 items; `--prose` reads this repository's notes instead of the sim's
 *   templated text, which repeats far more between items.
 *
 * Run: `bun packages/engine/bench/segment-screen.bench.ts [sizes…]`. No model, no network. Times vary ±30% on a
 * shared VM; the implementations are interleaved query by query, so their ratio is steadier than either figure.
 */
import { SparseIndex, TopK, Vocab, tokenizeInto } from "@eden/primitives";
import { buildWorld } from "../../sim/src/world";

const world = buildWorld({ seed: 1, noiseScale: 5 });
const ITEMS = world.items;
const F = 2;
const K1 = 1.2;
const B_FIELD = 0.75;
const WEIGHTS = [2, 1];
const DOC_SPAN = 4_194_304;
/**
 * What an escaped term frequency is charged in the `term` form's size: one more byte in the list, as an inline
 * escape would cost. Sized only: the search here reads escaped values from a Map.
 */
const BIG_ENTRY = 1;

interface Doc {
  title: Uint32Array;
  body: Uint32Array;
}

const buf = new Uint32Array(1 << 16);
function tokenize(vocab: Vocab, text: string): Uint32Array {
  return buf.slice(0, tokenizeInto(text, vocab, true, buf, null));
}

interface Results {
  count: number;
  docs: Int32Array;
  scores: Float64Array;
  coverage: Float32Array;
  matched: Uint8Array;
}

/** What every encoding shares with the packed index: per-doc field lengths, df, and the query scratch. */
interface Shared {
  n: number;
  df: Uint32Array;
  lens: Float32Array;
  avg: number[];
  acc: Float32Array;
  cov: Float32Array;
  hit: Uint32Array;
  stamp: Uint32Array;
  touched: Int32Array;
  termStamp: Uint32Array;
  queryNo: number;
  termQueryNo: number;
}

function varintSize(x: number): number {
  return x < 128 ? 1 : x < 16_384 ? 2 : x < 2_097_152 ? 3 : 4;
}

function putVarint(out: Uint8Array, at: number, x: number): number {
  while (x >= 128) {
    out[at++] = (x & 127) | 128;
    x >>>= 7;
  }
  out[at++] = x;
  return at;
}

/** Per term: the docs that hold it (ascending) with each field's tf. */
function postingsOf(docs: Doc[], terms: number): { doc: number[]; tf: number[][] }[] {
  const lists = Array.from({ length: terms }, () => ({ doc: [] as number[], tf: [[], []] as number[][] }));
  const count = [new Map<number, number>(), new Map<number, number>()];
  docs.forEach((d, n) => {
    const fields = [d.title, d.body];
    for (let f = 0; f < F; f++) {
      count[f]!.clear();
      for (const t of fields[f]!) count[f]!.set(t, (count[f]!.get(t) ?? 0) + 1);
    }
    for (const t of new Set([...d.title, ...d.body])) {
      const l = lists[t]!;
      l.doc.push(n);
      for (let f = 0; f < F; f++) l.tf[f]!.push(count[f]!.get(t) ?? 0);
    }
  });
  return lists;
}

/** `key`: a list per (term, field) of [varint doc gap, tf byte]; `start[key]` is its byte offset. */
class KeySegment {
  readonly start: Uint32Array;
  readonly data: Uint8Array;
  constructor(lists: { doc: number[]; tf: number[][] }[]) {
    this.start = new Uint32Array(lists.length * F + 1);
    let bytes = 0;
    for (const l of lists) {
      for (let f = 0; f < F; f++) {
        let prev = -1;
        for (let i = 0; i < l.doc.length; i++) {
          if (l.tf[f]![i] === 0) continue;
          bytes += varintSize(l.doc[i]! - prev) + 1;
          prev = l.doc[i]!;
        }
      }
    }
    this.data = new Uint8Array(bytes);
    let at = 0;
    lists.forEach((l, t) => {
      for (let f = 0; f < F; f++) {
        this.start[t * F + f] = at;
        let prev = -1;
        for (let i = 0; i < l.doc.length; i++) {
          const tf = l.tf[f]![i]!;
          if (tf === 0) continue;
          if (tf > 254) throw new Error("tf escape not modelled");
          at = putVarint(this.data, at, l.doc[i]! - prev);
          this.data[at++] = tf;
          prev = l.doc[i]!;
        }
      }
    });
    this.start[lists.length * F] = at;
  }
  get bytes(): number {
    return this.start.byteLength + this.data.byteLength;
  }

  search(s: Shared, query: ArrayLike<number>, n: number, k: number): Results {
    const { acc, cov, hit, stamp, touched, lens, df, termStamp } = s;
    const data = this.data;
    const start = this.start;
    const k1p1 = K1 + 1;
    let touchedN = 0;
    let totalIdf = 0;
    const queryMark = ++s.termQueryNo;
    for (let q = 0; q < n; q++) {
      const t = query[q]!;
      if (t >= df.length || df[t] === 0) continue;
      if (termStamp[t] === queryMark) continue;
      termStamp[t] = queryMark;
      const idf = Math.log(1 + (s.n - df[t]! + 0.5) / (df[t]! + 0.5));
      totalIdf += idf;
      const mark = ++s.queryNo;
      for (let f = 0; f < F; f++) {
        const A = K1 * (1 - B_FIELD);
        const B = (K1 * B_FIELD) / s.avg[f]!;
        const w = WEIGHTS[f]! * idf;
        const end = start[t * F + f + 1]!;
        let d = -1;
        for (let p = start[t * F + f]!; p < end;) {
          let b = data[p++]!;
          let gap = b & 127;
          if (b & 128) {
            b = data[p++]!;
            gap |= (b & 127) << 7;
            if (b & 128) gap |= data[p++]! << 14;
          }
          d += gap;
          const tf = data[p++]!;
          if (hit[d] === 0) touched[touchedN++] = d;
          acc[d]! += w * ((tf * k1p1) / (tf + A + B * lens[d * F + f]!));
          if (stamp[d] !== mark) {
            stamp[d] = mark;
            cov[d]! += idf;
            hit[d]!++;
          }
        }
      }
    }
    return finish(s, touchedN, totalIdf, k);
  }
}

/**
 * `term`: a list per term of [varint doc gap, tf byte: field 0 in the high four bits, field 1 in the low four],
 * each list behind its varint byte length; `block[t >> 4]` is the byte offset of term `16 * (t >> 4)`'s list.
 */
class TermSegment {
  readonly block: Uint32Array;
  readonly data: Uint8Array;
  /** Term frequencies of 15 or more, by (key, doc). */
  readonly big = new Map<number, number>();
  constructor(lists: { doc: number[]; tf: number[][] }[]) {
    this.block = new Uint32Array((lists.length >> 4) + 2);
    const size = (l: { doc: number[] }) => {
      let bytes = 0;
      let prev = -1;
      for (const d of l.doc) {
        bytes += varintSize(d - prev) + 1;
        prev = d;
      }
      return bytes;
    };
    let total = 0;
    for (const l of lists) {
      const b = size(l);
      total += b + varintSize(b);
    }
    this.data = new Uint8Array(total);
    let at = 0;
    lists.forEach((l, t) => {
      if ((t & 15) === 0) this.block[t >> 4] = at;
      at = putVarint(this.data, at, size(l));
      let prev = -1;
      for (let i = 0; i < l.doc.length; i++) {
        const a = l.tf[0]![i]!;
        const b = l.tf[1]![i]!;
        // 15 means "look it up", as 255 does in the packed index.
        if (a > 14) this.big.set(t * F * DOC_SPAN + l.doc[i]!, a);
        if (b > 14) this.big.set((t * F + 1) * DOC_SPAN + l.doc[i]!, b);
        at = putVarint(this.data, at, l.doc[i]! - prev);
        this.data[at++] = (Math.min(a, 15) << 4) | Math.min(b, 15);
        prev = l.doc[i]!;
      }
    });
  }
  get bytes(): number {
    return this.block.byteLength + this.data.byteLength + BIG_ENTRY * this.big.size;
  }

  search(s: Shared, query: ArrayLike<number>, n: number, k: number, onePass: boolean): Results {
    const { acc, cov, hit, stamp, touched, lens, df, termStamp } = s;
    const data = this.data;
    const k1p1 = K1 + 1;
    const A = K1 * (1 - B_FIELD);
    const B0 = (K1 * B_FIELD) / s.avg[0]!;
    const B1 = (K1 * B_FIELD) / s.avg[1]!;
    let touchedN = 0;
    let totalIdf = 0;
    const queryMark = ++s.termQueryNo;
    for (let q = 0; q < n; q++) {
      const t = query[q]!;
      if (t >= df.length || df[t] === 0) continue;
      if (termStamp[t] === queryMark) continue;
      termStamp[t] = queryMark;
      const idf = Math.log(1 + (s.n - df[t]! + 0.5) / (df[t]! + 0.5));
      totalIdf += idf;
      const mark = ++s.queryNo;
      const w0 = WEIGHTS[0]! * idf;
      const w1 = WEIGHTS[1]! * idf;
      // Find the list: skip the lists before it in its block of 16 by their lengths.
      let p = this.block[t >> 4]!;
      let len = 0;
      for (let skip = t & 15; ; skip--) {
        let b = data[p++]!;
        len = b & 127;
        if (b & 128) {
          b = data[p++]!;
          len |= (b & 127) << 7;
          if (b & 128) len |= data[p++]! << 14;
        }
        if (skip === 0) break;
        p += len;
      }
      const from = p;
      const end = p + len;
      if (onePass) {
        let d = -1;
        while (p < end) {
          let b = data[p++]!;
          let gap = b & 127;
          if (b & 128) {
            b = data[p++]!;
            gap |= (b & 127) << 7;
            if (b & 128) gap |= data[p++]! << 14;
          }
          d += gap;
          const tfs = data[p++]!;
          let tf0 = tfs >> 4;
          let tf1 = tfs & 15;
          if (tf0 === 15) tf0 = this.big.get(t * F * DOC_SPAN + d)!;
          if (tf1 === 15) tf1 = this.big.get((t * F + 1) * DOC_SPAN + d)!;
          if (hit[d] === 0) touched[touchedN++] = d;
          if (tf0 !== 0) acc[d]! += w0 * ((tf0 * k1p1) / (tf0 + A + B0 * lens[d * F]!));
          if (tf1 !== 0) acc[d]! += w1 * ((tf1 * k1p1) / (tf1 + A + B1 * lens[d * F + 1]!));
          stamp[d] = mark;
          cov[d]! += idf;
          hit[d]!++;
        }
        continue;
      }
      for (let f = 0; f < F; f++) {
        const w = f === 0 ? w0 : w1;
        const B = f === 0 ? B0 : B1;
        const shift = f === 0 ? 4 : 0;
        let d = -1;
        p = from;
        while (p < end) {
          let b = data[p++]!;
          let gap = b & 127;
          if (b & 128) {
            b = data[p++]!;
            gap |= (b & 127) << 7;
            if (b & 128) gap |= data[p++]! << 14;
          }
          d += gap;
          let tf = (data[p++]! >> shift) & 15;
          if (tf === 0) continue;
          if (tf === 15) tf = this.big.get((t * F + f) * DOC_SPAN + d)!;
          if (hit[d] === 0) touched[touchedN++] = d;
          acc[d]! += w * ((tf * k1p1) / (tf + A + B * lens[d * F + f]!));
          if (stamp[d] !== mark) {
            stamp[d] = mark;
            cov[d]! += idf;
            hit[d]!++;
          }
        }
      }
    }
    return finish(s, touchedN, totalIdf, k);
  }
}

function finish(s: Shared, touchedN: number, totalIdf: number, k: number): Results {
  const { acc, cov, hit, touched } = s;
  const top = new TopK(Math.max(1, k));
  for (let i = 0; i < touchedN; i++) top.push(touched[i]!, acc[touched[i]!]!);
  const count = top.size;
  const r: Results = {
    count,
    docs: new Int32Array(count),
    scores: new Float64Array(count),
    coverage: new Float32Array(count),
    matched: new Uint8Array(count),
  };
  top.drain(r.docs, r.scores);
  for (let j = 0; j < count; j++) {
    const d = r.docs[j]!;
    r.coverage[j] = totalIdf > 0 ? cov[d]! / totalIdf : 0;
    r.matched[j] = Math.min(hit[d]!, 255);
  }
  for (let i = 0; i < touchedN; i++) {
    const d = touched[i]!;
    acc[d] = 0;
    cov[d] = 0;
    hit[d] = 0;
  }
  return r;
}

function same(a: Results, b: Results): boolean {
  if (a.count !== b.count) return false;
  for (let i = 0; i < a.count; i++) {
    if (a.docs[i] !== b.docs[i] || a.scores[i] !== b.scores[i]) return false;
    if (a.coverage[i] !== b.coverage[i] || a.matched[i] !== b.matched[i]) return false;
  }
  return true;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

/** The packed index's typed arrays by part, in bytes (private fields, read for the report only). */
function packedParts(ix: SparseIndex): Record<string, number> {
  const o = ix as unknown as Record<string, { byteLength?: number } | null>;
  const size = (...names: string[]) => names.reduce((n, k) => n + (o[k]?.byteLength ?? 0), 0);
  return {
    "postings (docs + tf)": size("fDocs", "fTfs"),
    "key offsets": size("keyStart"),
    "forward arena": size("fFwd", "fwdStart", "fwdLen"),
    delta: size("dFwd", "dTf", "deltaDocs", "dHead", "dNext", "dDoc"),
    "per doc and term (df, lens, where, nPost)": size("df", "lens", "where", "nPost"),
  };
}

function run(n: number): void {
  const vocab = new Vocab(256);
  const docs: Doc[] = ITEMS.slice(0, n).map((it) => ({
    title: tokenize(vocab, it.title),
    body: tokenize(vocab, it.text),
  }));
  const ix = new SparseIndex({ fields: F, weights: WEIGHTS });
  for (const d of docs) ix.addFields([d.title, d.body], [d.title.length, d.body.length]);
  ix.settle();
  const priv = ix as unknown as { df: Uint32Array; lens: Float32Array; totalLens: Float64Array };
  // Term ids in use (the df array's length is its capacity).
  let terms = priv.df.length;
  while (terms > 0 && priv.df[terms - 1] === 0) terms--;
  const lists = postingsOf(docs, terms);
  const keySeg = new KeySegment(lists);
  const termSeg = new TermSegment(lists);
  let slots = 1_024;
  while (slots < n) slots *= 2;
  const shared: Shared = {
    n,
    df: priv.df,
    lens: priv.lens,
    avg: [priv.totalLens[0]! / n || 1, priv.totalLens[1]! / n || 1],
    acc: new Float32Array(slots),
    cov: new Float32Array(slots),
    hit: new Uint32Array(slots),
    stamp: new Uint32Array(slots),
    touched: new Int32Array(slots),
    termStamp: new Uint32Array(terms),
    queryNo: 0,
    termQueryNo: 0,
  };

  // Bytes.
  const parts = packedParts(ix);
  const packedTotal = Object.values(parts).reduce((a, b) => a + b, 0);
  const postings = lists.reduce(
    (s, l) => s + l.tf[0]!.filter((x) => x > 0).length + l.tf[1]!.filter((x) => x > 0).length,
    0,
  );
  const fwdSlots = lists.reduce((s, l) => s + l.doc.length, 0);
  const liveTerms = lists.filter((l) => l.doc.length > 0).length;
  // The forward arena as varint gaps between a doc's sorted term ids, a Uint32 start per doc.
  const perDoc: number[][] = Array.from({ length: n }, () => []);
  lists.forEach((l, t) => {
    for (const d of l.doc) perDoc[d]!.push(t);
  });
  let fwdVarint = 4 * (n + 1);
  for (const own of perDoc) {
    let prev = -1;
    for (const t of own) {
      fwdVarint += varintSize(t - prev);
      prev = t;
    }
  }
  const fwdToday = parts["forward arena"]!;
  const shareOfDocs = parts["per doc and term (df, lens, where, nPost)"]!;
  const per = (b: number) => `${(b / n).toFixed(0).padStart(5)} B/item`;
  console.log(
    `\n== ${n} items: ${liveTerms} terms, ${(postings / n).toFixed(0)} postings and ${(fwdSlots / n).toFixed(0)} distinct terms an item`,
  );
  for (const [name, b] of Object.entries(parts)) console.log(`  packed  ${name.padEnd(44)} ${per(b)}`);
  console.log(`  packed  ${"total".padEnd(44)} ${per(packedTotal)}`);
  console.log(`  varint  ${"key: postings".padEnd(44)} ${per(keySeg.data.byteLength)}`);
  console.log(`  varint  ${"key: offsets".padEnd(44)} ${per(keySeg.start.byteLength)}`);
  console.log(`  varint  ${"term: postings with lengths".padEnd(44)} ${per(termSeg.data.byteLength)}`);
  console.log(`  varint  ${"term: block offsets".padEnd(44)} ${per(termSeg.block.byteLength)}`);
  console.log(
    `  varint  ${`term: ${termSeg.big.size} tf of 15 or more, a byte each`.padEnd(44)} ${per(BIG_ENTRY * termSeg.big.size)}`,
  );
  console.log(`  varint  ${"forward arena as varint gaps".padEnd(44)} ${per(fwdVarint)}`);
  const totals: [string, number][] = [
    ["key + today's forward arena", keySeg.bytes + fwdToday + shareOfDocs],
    ["key + varint forward arena", keySeg.bytes + fwdVarint + shareOfDocs],
    ["key, no forward arena", keySeg.bytes + shareOfDocs],
    ["term + today's forward arena", termSeg.bytes + fwdToday + shareOfDocs],
    ["term + varint forward arena", termSeg.bytes + fwdVarint + shareOfDocs],
    ["term, no forward arena (O2's sizing)", termSeg.bytes + shareOfDocs],
  ];
  for (const [name, b] of totals) {
    console.log(`  total   ${name.padEnd(44)} ${per(b)}   ${(packedTotal / b).toFixed(2)}x smaller than packed`);
  }

  // Search: the same queries as index-memory.bench.ts, every implementation in turn on each query.
  const queries = docs.slice(0, 200).map((d, i) => {
    const pool = [...d.title, ...docs[(i * 7) % docs.length]!.body.subarray(0, 20)];
    return Uint32Array.from({ length: 4 }, (_, j) => pool[(i + j * 5) % pool.length]!);
  });
  const impls: [string, (q: Uint32Array) => Results][] = [
    ["packed", (q) => ix.search(q, q.length, 20)],
    ["key", (q) => keySeg.search(shared, q, q.length, 20)],
    ["term, two passes", (q) => termSeg.search(shared, q, q.length, 20, false)],
    ["term, one pass", (q) => termSeg.search(shared, q, q.length, 20, true)],
  ];
  const times: number[][] = impls.map(() => []);
  const differ = impls.map(() => 0);
  let sink = 0;
  const ROUNDS = 40;
  for (let r = 0; r < ROUNDS; r++) {
    for (const q of queries) {
      let want: Results | null = null;
      // Rotate who goes first, so no implementation always runs on the cache the one before warmed.
      for (let i = 0; i < impls.length; i++) {
        const at = (i + r) % impls.length;
        const t0 = performance.now();
        const got = impls[at]![1](q);
        const ms = performance.now() - t0;
        sink += got.count;
        if (r >= 5) times[at]!.push(ms);
        if (r === 0) {
          if (at === 0) want = got;
          else if (want && !same(want, got)) differ[at]!++;
        }
      }
    }
  }
  void sink;
  // Round 0 starts with the packed index (r % 4 === 0), so `want` is set before the others are compared.
  const base = times[0]!;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  impls.forEach(([name], i) => {
    const t = times[i]!;
    console.log(
      `  search  ${name.padEnd(18)} p50 ${(pct(t, 0.5) * 1e3).toFixed(1).padStart(6)} µs  p99 ${(pct(t, 0.99) * 1e3).toFixed(1).padStart(6)} µs` +
        `  mean ${(mean(t) * 1e3).toFixed(1).padStart(6)} µs  (${(mean(t) / mean(base)).toFixed(2)}x packed's mean)` +
        (i > 0 ? `  results differing from packed: ${differ[i]} of ${queries.length}` : ""),
    );
  });
}

function heapBytes(): number {
  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    Bun.sleepSync(20);
  }
  return process.memoryUsage().heapUsed;
}

/**
 * Screen 2, entries as columns: the heap of `n` items' entries as the cache holds them today (an entry object, its
 * item object with its strings, a Map by id; text left out: screen 3's) against the same fields in typed arrays, one
 * byte arena for the strings and an open-addressed id table. Child process, heap after less heap before.
 */
const own = (text: string): string => JSON.parse(JSON.stringify(text)) as string;

function columnsChild(mode: string, n: number): void {
  const items = ITEMS.slice(0, n);
  const keep: unknown[] = [];
  const before = heapBytes();
  if (mode === "objects") {
    const byId = new Map<string, unknown>();
    let prev: { next: unknown } | null = null;
    items.forEach((it, i) => {
      // Copies of the strings, as a listing's parse gives each item its own (`own`: a slice or a template would
      // share the world's string, which is held before the first reading and so would not be counted).
      const item = {
        id: own(it.id),
        sourceId: it.sourceId,
        ref: own(it.ref),
        title: own(it.title),
        updatedAt: it.updatedAt,
        url: it.url === undefined ? undefined : own(it.url),
        meta: it.meta ? structuredClone(it.meta) : undefined,
      };
      const e = {
        item,
        fetchedAt: world.now,
        readMark: 1,
        doc: i,
        sketch: undefined,
        synced: true,
        prev,
        next: null,
        raw: i * 7919.5,
        seq: i,
      };
      if (prev) prev.next = e;
      prev = e;
      byId.set(item.id, e);
    });
    keep.push(byId);
  } else {
    const enc = new TextEncoder();
    const fetchedAt = new Float64Array(n);
    const updatedAt = new Float64Array(n);
    const raw = new Float64Array(n);
    const readMark = new Uint32Array(n);
    const seq = new Uint32Array(n);
    const prev = new Int32Array(n);
    const next = new Int32Array(n);
    const flags = new Uint8Array(n);
    const source = new Uint16Array(n);
    const start = new Uint32Array(n + 1);
    const sources = new Map<string, number>();
    const chunks: Uint8Array[] = [];
    let at = 0;
    items.forEach((it, i) => {
      fetchedAt[i] = world.now;
      updatedAt[i] = it.updatedAt ?? 0;
      raw[i] = i * 7919.5;
      readMark[i] = 1;
      seq[i] = i;
      prev[i] = i - 1;
      next[i] = i + 1;
      flags[i] = 1;
      if (!sources.has(it.sourceId)) sources.set(it.sourceId, sources.size);
      source[i] = sources.get(it.sourceId)!;
      // id, ref, title, url and meta as one record of length-prefixed UTF-8 strings.
      const rec = enc.encode(
        [it.id, it.ref, it.title, it.url ?? "", it.meta ? JSON.stringify(it.meta) : ""].join("\u0000"),
      );
      start[i] = at;
      at += rec.byteLength;
      chunks.push(rec);
    });
    start[n] = at;
    const arena = new Uint8Array(at);
    let o = 0;
    for (const c of chunks) {
      arena.set(c, o);
      o += c.byteLength;
    }
    chunks.length = 0;
    // The id table: open addressing over a hash of the id, a slot per two items.
    let slots = 1_024;
    while (slots < 2 * n) slots *= 2;
    const table = new Int32Array(slots).fill(-1);
    items.forEach((it, i) => {
      let h = Number(Bun.hash(it.id) & 0x7fff_ffffn) & (slots - 1);
      while (table[h] !== -1) h = (h + 1) & (slots - 1);
      table[h] = i;
    });
    keep.push(fetchedAt, updatedAt, raw, readMark, seq, prev, next, flags, source, start, arena, table, sources);
  }
  const after = heapBytes();
  console.log(JSON.stringify({ perItem: (after - before) / n, held: keep.length }));
}

/**
 * Screen 3, text in zstd blocks: bytes an item and the time to read one item's text, for each item deflated on its
 * own (today, `packed-text.ts`) and for zstd over blocks of 1, 16 and 32 items.
 */
function textScreen(n: number, prose: boolean): void {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let texts = ITEMS.slice(0, n).map((it) => it.text);
  if (prose) {
    // A stand-in for text that is not generated from templates: this repository's own notes (one author's English
    // prose and tables), cut into pieces of 1,100 characters. Not users' mail; the sim's text repeats far more.
    const dir = new URL("../../../docs/research/", import.meta.url).pathname;
    // Notes up to O2's, so the corpus does not grow with later notes (this screen's own among them).
    const all = [...new Bun.Glob("*.md").scanSync(dir)]
      .filter((f) => !/^(o[3-9]|[p-z])/.test(f))
      .sort()
      .map((f) => require("node:fs").readFileSync(dir + f, "utf8"));
    const joined = all.join("\n");
    texts = Array.from({ length: Math.min(n, Math.floor(joined.length / 1_100)) }, (_, i) =>
      joined.slice(i * 1_100, (i + 1) * 1_100),
    );
    n = texts.length;
  }
  const chars = texts.reduce((s, t) => s + t.length, 0);
  console.log(
    `\n== text${prose ? " (the repository's notes, 1,100-character pieces)" : ""}: ${n} items, ${(chars / n).toFixed(0)} characters an item`,
  );
  const order = Array.from({ length: 2_000 }, (_, i) => (i * 7_919) % n);
  const report = (name: string, bytes: number, read: (i: number) => string) => {
    for (const i of order.slice(0, 200)) if (read(i) !== texts[i]) throw new Error(`${name}: text ${i} differs`);
    const times: number[] = [];
    for (let r = 0; r < 3; r++) {
      for (const i of order) {
        const t0 = performance.now();
        read(i);
        if (r > 0) times.push(performance.now() - t0);
      }
    }
    console.log(
      `  ${name.padEnd(34)} ${(bytes / n).toFixed(0).padStart(5)} B/item   read one item p50 ` +
        `${(pct(times, 0.5) * 1e3).toFixed(1).padStart(6)} µs  p99 ${(pct(times, 0.99) * 1e3).toFixed(1).padStart(6)} µs`,
    );
  };
  const deflated = texts.map((t) => Bun.deflateSync(enc.encode(t)));
  report(
    "deflate, each item (today)",
    deflated.reduce((s, b) => s + b.byteLength, 0),
    (i) => dec.decode(Bun.inflateSync(deflated[i]!)),
  );
  for (const size of [1, 16, 32]) {
    const blocks: Uint8Array[] = [];
    const offsets: number[][] = [];
    for (let i = 0; i < n; i += size) {
      const parts = texts.slice(i, i + size).map((t) => enc.encode(t));
      const offs = [0];
      for (const p of parts) offs.push(offs.at(-1)! + p.byteLength);
      const all = new Uint8Array(offs.at(-1)!);
      parts.forEach((p, j) => all.set(p, offs[j]!));
      blocks.push(Bun.zstdCompressSync(all, { level: 3 }));
      offsets.push(offs);
    }
    // 4 bytes an item for its offset within the block.
    const bytes = blocks.reduce((s, b) => s + b.byteLength, 0) + 4 * n;
    report(`zstd 3, blocks of ${size}`, bytes, (i) => {
      const b = (i / size) | 0;
      const raw = Bun.zstdDecompressSync(blocks[b]!);
      const offs = offsets[b]!;
      return dec.decode(raw.subarray(offs[i % size]!, offs[(i % size) + 1]!));
    });
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "columns-child") columnsChild(rest[0]!, Number(rest[1]));
else if (mode === "columns") {
  const n = Number(rest[0] ?? 3_000);
  const child = (m: string) => {
    const out = Bun.spawnSync([process.execPath, import.meta.path, "columns-child", m, String(n)], {
      stderr: "inherit",
    });
    return (JSON.parse(out.stdout.toString().trim()) as { perItem: number }).perItem;
  };
  const a = child("objects");
  const b = child("columns");
  console.log(`\n== entries: ${n} items (ids, refs, titles, urls, meta and the per-entry fields; no text, no index)`);
  console.log(`  objects (today's shape)   ${a.toFixed(0).padStart(5)} B/item`);
  console.log(`  columns and a byte arena  ${b.toFixed(0).padStart(5)} B/item   ${(a / b).toFixed(2)}x smaller`);
} else if (mode === "text") textScreen(Number(rest.find((x) => Number(x) > 0) ?? 3_000), rest.includes("--prose"));
else {
  const sizes = process.argv
    .slice(2)
    .map(Number)
    .filter((x) => x > 0);
  console.log(`corpus: ${ITEMS.length} sim items`);
  for (const n of sizes.length > 0 ? sizes : [500, 2_000, 3_000, ITEMS.length]) run(Math.min(n, ITEMS.length));
}

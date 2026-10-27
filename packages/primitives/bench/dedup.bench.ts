/**
 * Quality and cost of reply stripping (reply.ts) and duplicate detection (dedup.ts) on the synthetic mailbox of
 * dedup-corpus.ts. Parameters were chosen on seed 1; this reports seed 2 unless `SEED` says otherwise.
 *
 *   bun packages/primitives/bench/dedup.bench.ts            # everything
 *   SECTIONS=quality bun packages/primitives/bench/dedup.bench.ts
 */
import { lshCandidateProbability, minhashSimilarity, hamming64, MinHashIndex, TextSketcher } from "../src/dedup";
import { dedupText, PART_OWN, ReplyLines, splitReply, stripReply } from "../src/reply";
import { Vocab } from "../src/vocab";
import { dedupCorpus, type Item } from "./dedup-corpus";
import { fmtKinds, jaccard, keptLines, prf, scorePairs, StripScorer } from "./dedup-eval";
import { mix32 } from "../src/hash";
import { bench, consume, flat, report } from "./harness";

const SEED = Number(process.env.SEED ?? 2);
const SECTIONS = (process.env.SECTIONS ?? "strip,quality,lsh,perm,speed").split(",");
const SIZE = { threads: 150, docs: 60, notifications: 48 };
const MIN_OWN = 6;
const K = 128;

const items = dedupCorpus(SEED, SIZE);
console.log(`corpus seed ${SEED}: ${items.length} items`);

if (SECTIONS.includes("strip")) {
  console.log("\n## splitReply, line level (labelled email items)");
  const lines = new ReplyLines(256);
  const all = new StripScorer();
  const byStyle = new Map<string, StripScorer>();
  for (const it of items) {
    if (it.labels === null) continue;
    const n = splitReply(it.text, lines, true);
    const kept: boolean[] = [];
    for (let i = 0; i < n; i++) kept.push(lines.kinds[i] === PART_OWN);
    all.add(it, kept);
    const key = it.kind.startsWith("fwd") ? `forward (${it.style})` : it.style;
    if (!byStyle.has(key)) byStyle.set(key, new StripScorer());
    byStyle.get(key)!.add(it, kept);
    // The joined output must agree with the per-line kinds.
    const viaText = keptLines(it.lines!, stripReply(it.text));
    for (let i = 0; i < kept.length; i++) {
      if (it.lines![i]!.trim() !== "" && viaText[i] !== kept[i]) throw new Error(`stripReply disagrees on ${it.id}`);
    }
  }
  const row = (name: string, s: StripScorer) => {
    const r = s.score();
    const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";
    console.log(
      `${name.padEnd(22)} items ${String(r.items).padStart(4)}  own kept ${pct(r.ownKept)}  ` +
        `quoted/header/sig removed ${pct(r.removed)}  items exact ${pct(r.exact)}`,
    );
  };
  row("all", all);
  for (const [k, s] of [...byStyle.entries()].sort()) row(k, s);
}

interface Sketched {
  text: string;
  fp0: number;
  fp1: number;
  sig: Uint32Array;
  simLo: number;
  simHi: number;
  num: number;
  set: Uint32Array;
  terms: number;
}

function sketchAll(its: Item[], strip: boolean, minOwn: number, w: number): Sketched[] {
  const sk = new TextSketcher(new Vocab(4096), 8192, w);
  const fp = new Uint32Array(2);
  const sim = new Uint32Array(2);
  const buf = new Uint32Array(8192);
  return its.map((it) => {
    const text = strip ? dedupText(it.text, minOwn) : it.text;
    sk.load(text);
    sk.fingerprint(fp);
    const sig = new Uint32Array(K);
    sk.minhash(sig);
    sk.simhash(sim);
    const n = sk.copyShingles(buf);
    const set = Uint32Array.from(new Set(buf.subarray(0, n))).sort();
    return {
      text,
      fp0: fp[0]!,
      fp1: fp[1]!,
      sig,
      simLo: sim[0]!,
      simHi: sim[1]!,
      num: sk.numberKey,
      set,
      terms: sk.termCount,
    };
  });
}

if (SECTIONS.includes("quality")) {
  console.log(`\n## Pair quality, seed ${SEED} (minOwnTerms ${MIN_OWN}, k ${K}, word 3-shingles unless noted)`);
  const configs: [string, boolean, number, number][] = [
    ["no stripping, w=3", false, MIN_OWN, 3],
    ["stripped, w=1", true, MIN_OWN, 1],
    ["stripped, w=2", true, MIN_OWN, 2],
    ["stripped, w=3", true, MIN_OWN, 3],
    ["stripped, w=4", true, MIN_OWN, 4],
    ["stripped, w=3, minOwnTerms 3", true, 3, 3],
    ["stripped, w=3, minOwnTerms 10", true, 10, 3],
  ];
  for (const [label, strip, minOwn, w] of configs) {
    const s = sketchAll(items, strip, minOwn, w);
    const full = label === "stripped, w=3";
    const names = full
      ? [
          "exact fingerprint",
          "exact Jaccard >= 0.8 (oracle)",
          "MinHash >= 0.6",
          "MinHash >= 0.7",
          "MinHash >= 0.8",
          "MinHash >= 0.9",
          "SimHash <= 3 bits",
          "SimHash <= 6 bits",
          "SimHash <= 8 bits",
          "SimHash <= 10 bits",
          "SimHash <= 12 bits",
          "exact or (MinHash >= 0.8 and same numbers)",
          "exact or (SimHash <= 8 and same numbers)",
        ]
      : ["exact fingerprint", "MinHash >= 0.8", "SimHash <= 8 bits"];
    const res = scorePairs(items, names, (i, j, out) => {
      const a = s[i]!;
      const b = s[j]!;
      const exact = a.fp0 === b.fp0 && a.fp1 === b.fp1;
      const est = minhashSimilarity(a.sig, b.sig);
      const ham = hamming64(a.simLo, a.simHi, b.simLo, b.simHi);
      if (!full) {
        out[0] = exact;
        out[1] = est >= 0.8;
        out[2] = ham <= 8;
        return;
      }
      const sameNum = a.num === b.num;
      out[0] = exact;
      out[1] = jaccard(a.set, b.set) >= 0.8;
      out[2] = est >= 0.6;
      out[3] = est >= 0.7;
      out[4] = est >= 0.8;
      out[5] = est >= 0.9;
      out[6] = ham <= 3;
      out[7] = ham <= 6;
      out[8] = ham <= 8;
      out[9] = ham <= 10;
      out[10] = ham <= 12;
      out[11] = exact || (est >= 0.8 && sameNum);
      out[12] = exact || (ham <= 8 && sameNum);
    });
    console.log(`\n### ${label}  (${res.positives} duplicate pairs)`);
    names.forEach((n, m) => console.log(`${n.padEnd(44)} ${prf(res.counts[m]!)}`));
    if (full) {
      for (const m of [0, 4, 8, 11]) {
        console.log(`  ${names[m]}: missed by kind: ${fmtKinds(res.fnKinds[m]!)}`);
        console.log(`  ${names[m]}: false pairs by kinds: ${fmtKinds(res.fpKinds[m]!)}`);
      }
    }
  }
}

if (SECTIONS.includes("lsh")) {
  console.log("\n## LSH banding (stripped, w=3): pairs with MinHash >= 0.8 that share a band, candidates per query");
  const s = sketchAll(items, true, MIN_OWN, 3);
  for (const [b, r] of [
    [16, 8],
    [32, 4],
    [20, 6],
    [12, 10],
  ] as const) {
    const index = new MinHashIndex(b, r, items.length);
    s.forEach((x, i) => index.add(i, x.sig));
    const out = new Int32Array(items.length);
    let wanted = 0;
    let found = 0;
    let truthWanted = 0;
    let truthFound = 0;
    let candidates = 0;
    for (let i = 0; i < s.length; i++) {
      const n = index.candidates(s[i]!.sig, out);
      candidates += n - 1; // itself
      const set = new Set(out.subarray(0, n));
      for (let j = 0; j < s.length; j++) {
        if (j === i) continue;
        const est = minhashSimilarity(s[i]!.sig, s[j]!.sig);
        if (est >= 0.8) {
          wanted++;
          if (set.has(j)) found++;
        }
        if (items[i]!.group === items[j]!.group) {
          truthWanted++;
          if (set.has(j)) truthFound++;
        }
      }
    }
    const theory = lshCandidateProbability(0.8, b, r).toFixed(3);
    console.log(
      `b=${b} r=${r}: est>=0.8 pairs found ${(found / wanted).toFixed(3)} (theory at s=0.8: ${theory}), ` +
        `true duplicate pairs found ${(truthFound / truthWanted).toFixed(3)}, ` +
        `candidates per query ${(candidates / s.length).toFixed(2)} of ${s.length - 1}`,
    );
  }
}

if (SECTIONS.includes("perm")) {
  // The MinHash permutation family: estimator bias and RMSE against exact Jaccard, and cost, for the shipped
  // xor-multiply-xorshift, a full murmur finalizer (the reference), and the common linear (a·x + b) mod 2^32.
  // Inputs are random (well-mixed, as shingleHash produces) or structured (consecutive integers: a stress case).
  console.log("\n## MinHash permutation family (k=128, 400 set pairs per cell)");
  let x = 12345;
  const rnd = () => (x = mix32((x + 0x9e3779b9) | 0));
  const seeds = Uint32Array.from({ length: K }, () => rnd());
  const mulA = Uint32Array.from({ length: K }, () => rnd() | 1);
  const addB = Uint32Array.from({ length: K }, () => rnd());
  type Family = (sh: Uint32Array, n: number, sig: Uint32Array) => void;
  const families: [string, Family][] = [
    [
      "xor-mul-xorshift (shipped)",
      (sh, n, sig) => {
        for (let i = 0; i < K; i++) {
          const s = seeds[i]!;
          let m = 0xffffffff;
          for (let j = 0; j < n; j++) {
            let v = Math.imul(sh[j]! ^ s, 0x85ebca6b);
            v = (v ^ (v >>> 13)) >>> 0;
            if (v < m) m = v;
          }
          sig[i] = m;
        }
      },
    ],
    [
      "full fmix32 (reference)",
      (sh, n, sig) => {
        for (let i = 0; i < K; i++) {
          const s = seeds[i]!;
          let m = 0xffffffff;
          for (let j = 0; j < n; j++) {
            let v = sh[j]! ^ s;
            v ^= v >>> 16;
            v = Math.imul(v, 0x85ebca6b);
            v ^= v >>> 13;
            v = Math.imul(v, 0xc2b2ae35);
            v = (v ^ (v >>> 16)) >>> 0;
            if (v < m) m = v;
          }
          sig[i] = m;
        }
      },
    ],
    [
      "linear a*x+b mod 2^32",
      (sh, n, sig) => {
        for (let i = 0; i < K; i++) {
          const a = mulA[i]!;
          const b = addB[i]!;
          let m = 0xffffffff;
          for (let j = 0; j < n; j++) {
            const v = (Math.imul(sh[j]!, a) + b) >>> 0;
            if (v < m) m = v;
          }
          sig[i] = m;
        }
      },
    ],
  ];
  const sa = new Uint32Array(K);
  const sb = new Uint32Array(K);
  for (const structured of [false, true]) {
    for (const size of [20, 200]) {
      for (const J of [0.5, 0.8, 0.95]) {
        const c = Math.round((2 * size * J) / (1 + J));
        const cells = families.map(([name, f]) => {
          let sum = 0;
          let sq = 0;
          for (let t = 0; t < 400; t++) {
            const a = new Uint32Array(size);
            const b = new Uint32Array(size);
            let id = t * 100_000;
            const v = () => (structured ? id++ : rnd());
            for (let i = 0; i < c; i++) a[i] = b[i] = v();
            for (let i = c; i < size; i++) a[i] = v();
            for (let i = c; i < size; i++) b[i] = v();
            f(a, size, sa);
            f(b, size, sb);
            const e = minhashSimilarity(sa, sb) - c / (2 * size - c);
            sum += e;
            sq += e * e;
          }
          return `${name} bias ${(sum / 400).toFixed(4)} rmse ${Math.sqrt(sq / 400).toFixed(4)}`;
        });
        const theory = Math.sqrt((J * (1 - J)) / K).toFixed(4);
        console.log(
          `${structured ? "structured" : "random"} n=${size} J=${J} (theory rmse ${theory}): ${cells.join("; ")}`,
        );
      }
    }
  }
  const sh = Uint32Array.from({ length: 300 }, () => rnd());
  const sig = new Uint32Array(K);
  report(families.map(([name, f]) => bench(`${name}, 300 shingles`, () => f(sh, 300, sig), { batch: 20 })));
  consume(sig[0]);
}

if (SECTIONS.includes("speed")) {
  console.log("\n## Speed");
  const byLen = (lo: number, hi: number) =>
    items.find((it) => it.kind === "reply" && it.text.length >= lo && it.text.length < hi)!;
  const short = flat(items.find((it) => it.kind === "ack" && it.text.length < 1200)!.text);
  const mid = flat(byLen(1800, 2600).text);
  // A deep thread: messages nested by quoting, as a long reply chain looks, to ~16 KB.
  let deep = byLen(1000, 2000).text;
  for (let i = 0; deep.length < 16_384; i++) {
    const own = stripReply(items[(i * 37) % items.length]!.text) || "ok";
    deep =
      `${own}\n\nOn Tue, Oct 27, 2026 at 3:14 PM Dana Lee <dana@acme.com> wrote:\n\n` +
      deep
        .split("\n")
        .map((l) => "> " + l)
        .join("\n");
  }
  deep = flat(deep);
  // Worst cases for the line classifier: every line a regex candidate.
  const quoted = flat(
    Array.from({ length: 2000 }, (_, i) => `> line ${i} of a very long quoted message body text`).join("\n"),
  );
  const colons = flat(Array.from({ length: 2000 }, (_, i) => `Note ${i}: the agenda item number ${i} is:`).join("\n"));
  const froms = flat(
    Array.from({ length: 2000 }, (_, i) => `From: person${i} at the vendor about item ${i}`).join("\n"),
  );
  const oneLine = flat("On Monday the team ".repeat(5_000) + "wrote:");
  console.log(
    `texts: short ${short.length} B, mid ${mid.length} B, deep ${deep.length} B, worst cases ${quoted.length}, ` +
      `${colons.length}, ${froms.length}, ${oneLine.length} B`,
  );
  const lines = new ReplyLines(4096);
  report([
    bench(`splitReply  short reply (${short.length} B)`, () => splitReply(short, lines, true), { batch: 50 }),
    bench(`splitReply  2 KB reply (${mid.length} B)`, () => splitReply(mid, lines, true), { batch: 20 }),
    bench(`splitReply  deep thread (${deep.length} B)`, () => splitReply(deep, lines, true), { batch: 5 }),
    bench(`dedupText   short ack, falls back to the quoted message`, () => dedupText(short, MIN_OWN), { batch: 50 }),
    bench(`dedupText   2 KB reply`, () => dedupText(mid, MIN_OWN), { batch: 20 }),
    bench(`dedupText   deep thread`, () => dedupText(deep, MIN_OWN), { batch: 5 }),
    bench(`worst: 2000 '>' lines (${quoted.length} B)`, () => splitReply(quoted, lines, true), {
      batch: 2,
      batches: 50,
    }),
    bench(`worst: 2000 lines ending ':' (${colons.length} B)`, () => splitReply(colons, lines, true), {
      batch: 2,
      batches: 50,
    }),
    bench(`worst: 2000 'From:' lines (${froms.length} B)`, () => splitReply(froms, lines, true), {
      batch: 2,
      batches: 50,
    }),
    bench(`worst: one ${oneLine.length} B line ending 'wrote:'`, () => splitReply(oneLine, lines, true), {
      batch: 2,
      batches: 50,
    }),
  ]);

  const vocab = new Vocab(4096);
  const sk = new TextSketcher(vocab, 8192, 3);
  const fp = new Uint32Array(2);
  const sig = new Uint32Array(K);
  const sim = new Uint32Array(2);
  const texts = [
    ["300 B", stripReply(short) || short],
    ["2 KB", mid],
    ["16 KB", deep],
  ] as const;
  for (const [, t] of texts) sk.load(t); // warm vocabulary: steady state for a user's mailbox
  const rows = [];
  for (const [label, t] of texts) {
    const batch = t.length > 8000 ? 5 : 20;
    rows.push(
      bench(`load (tokenize + shingle)  ${label}`, () => sk.load(t), { batch }),
      bench(`load + fingerprint         ${label}`, () => (sk.load(t), sk.fingerprint(fp)), { batch }),
      bench(`load + minhash k=128       ${label}`, () => (sk.load(t), sk.minhash(sig)), { batch }),
      bench(`load + simhash 64          ${label}`, () => (sk.load(t), sk.simhash(sim)), { batch }),
    );
  }
  report(rows);

  // Lookup cost against a user's store of N items: SimHash scan, MinHash scan, LSH candidates + verification.
  const pool = sketchAll(dedupCorpus(SEED + 100, { threads: 800, docs: 300, notifications: 200 }), true, MIN_OWN, 3);
  console.log(`store: ${pool.length} distinct corpus items, then synthetic random signatures up to N`);
  const scanRows = [];
  let seed = 99;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  for (const N of [2_000, 100_000]) {
    const lo = new Uint32Array(N);
    const hi = new Uint32Array(N);
    const sigs = new Uint32Array(N * K);
    const index = new MinHashIndex(16, 8, N);
    const fake = new Uint32Array(K);
    for (let i = 0; i < N; i++) {
      const p = i < pool.length ? pool[i]! : null;
      if (p === null) for (let k = 0; k < K; k++) fake[k] = rnd();
      lo[i] = p ? p.simLo : rnd();
      hi[i] = p ? p.simHi : rnd();
      sigs.set(p ? p.sig : fake, i * K);
      index.add(i, p ? p.sig : fake);
    }
    const qs = pool[7]!.sig;
    const qLo = pool[7]!.simLo;
    const qHi = pool[7]!.simHi;
    const need = Math.ceil(0.8 * K);
    const out = new Int32Array(N);
    scanRows.push(
      bench(
        `SimHash scan, N=${N}`,
        () => {
          let hits = 0;
          for (let i = 0; i < N; i++) if (hamming64(qLo, qHi, lo[i]!, hi[i]!) <= 8) hits++;
          return hits;
        },
        { batch: N > 10_000 ? 2 : 20, batches: 50 },
      ),
      bench(
        `MinHash scan (k=128), N=${N}`,
        () => {
          let hits = 0;
          for (let i = 0; i < N; i++) {
            let eq = 0;
            const base = i * K;
            for (let k = 0; k < K; k++) if (sigs[base + k] === qs[k]) eq++;
            if (eq >= need) hits++;
          }
          return hits;
        },
        { batch: N > 10_000 ? 1 : 5, batches: 30 },
      ),
      bench(
        `LSH 16x8 candidates + verify, N=${N}`,
        () => {
          const n = index.candidates(qs, out);
          let hits = 0;
          for (let c = 0; c < n; c++) {
            const base = out[c]! * K;
            let eq = 0;
            for (let k = 0; k < K; k++) if (sigs[base + k] === qs[k]) eq++;
            if (eq >= need) hits++;
          }
          return hits;
        },
        { batch: 20, batches: 100 },
      ),
    );
    console.log(`N=${N}: LSH entries ${index.size}, candidates for the query ${index.candidates(qs, out)}`);
  }
  // Churn: a TTL cache adds and removes items constantly; backward-shift deletion keeps probes short.
  const churn = new MinHashIndex(16, 8, 2_000);
  for (let i = 0; i < 2_000; i++) churn.add(i, pool[i % pool.length]!.sig);
  let next = 2_000;
  scanRows.push(
    bench(
      "LSH remove oldest + add new (2k live items)",
      () => {
        const old = next - 2_000;
        churn.remove(old % 4_096, pool[old % pool.length]!.sig);
        churn.add(next % 4_096, pool[next % pool.length]!.sig);
        next++;
      },
      { batch: 200 },
    ),
  );
  report(scanRows);
}

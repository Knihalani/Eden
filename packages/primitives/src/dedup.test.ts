import { describe, expect, test } from "bun:test";
import {
  hamming64,
  isUnsegmented,
  lshCandidateProbability,
  MAX_PERMUTATIONS,
  minhashSimilarity,
  MinHashIndex,
  popcount32,
  TextSketcher,
} from "./dedup";
import { mix32 } from "./hash";
import { Vocab } from "./vocab";

const sketcher = (w = 3) => new TextSketcher(new Vocab(256), 4096, w);

function fp(sk: TextSketcher, text: string): string {
  sk.load(text);
  const out = new Uint32Array(2);
  sk.fingerprint(out);
  return `${out[0]}:${out[1]}`;
}

function sig(sk: TextSketcher, text: string, k = 128): Uint32Array {
  sk.load(text);
  const s = new Uint32Array(k);
  sk.minhash(s);
  return s;
}

function shingleSet(sk: TextSketcher, text: string): Set<number> {
  sk.load(text);
  const buf = new Uint32Array(sk.shingles);
  sk.copyShingles(buf);
  return new Set(buf);
}

const exactJaccard = (a: Set<number>, b: Set<number>) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return a.size + b.size === 0 ? 1 : inter / (a.size + b.size - inter);
};

let seed = 1;
const rnd = (n: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
const WORDS = (
  "renewal call contract pricing legal thursday friday invoice budget review migration launch team offsite " +
  "hotel flight agenda notes deadline quarter revenue discount security audit hiring plan roadmap demo slides " +
  "customer escalation vendor shortlist board meeting expense report travel lisbon berlin osaka"
).split(" ");
const sentence = (n: number) => Array.from({ length: n }, () => WORDS[rnd(WORDS.length)]).join(" ");

describe("TextSketcher.fingerprint", () => {
  test("equal for the same words whatever the case, accents, punctuation, whitespace and line endings", () => {
    const sk = sketcher();
    const a = fp(sk, "Zoë's renewal — call on Thursday, 10:30?");
    for (const b of [
      "zoe's RENEWAL call on thursday 10 30",
      "Zoë's  renewal\r\ncall on Thursday,\n10:30 ?",
      "ZOË’S renewal... call; on Thursday (10:30)",
    ]) {
      expect(fp(sk, b)).toBe(a);
    }
  });

  test("differs for a different word, word order or number", () => {
    const sk = sketcher();
    const a = fp(sk, "move the call to Thursday at 10");
    expect(fp(sk, "move the call to Friday at 10")).not.toBe(a);
    expect(fp(sk, "the call move to Thursday at 10")).not.toBe(a);
    expect(fp(sk, "move the call to Thursday at 11")).not.toBe(a);
  });

  test("stable across sketchers and vocabularies (hashes come from the term, not the vocabulary id)", () => {
    const a = sketcher();
    const b = sketcher();
    fp(b, "a completely different text interned first so ids differ");
    const text = "Legal flagged two clauses in the Globex contract";
    expect(fp(a, text)).toBe(fp(b, text));
    expect([...sig(a, text)]).toEqual([...sig(b, text)]);
  });

  test("no collisions among 20,000 distinct random texts", () => {
    const sk = sketcher();
    const seen = new Set<string>();
    const texts = new Set<string>();
    for (let i = 0; i < 20_000; i++) texts.add(sentence(3 + rnd(8)));
    for (const t of texts) seen.add(fp(sk, t));
    expect(seen.size).toBe(texts.size);
  });
});

describe("TextSketcher.numberKey", () => {
  test("order-independent; differs when a number differs; 0 without numbers", () => {
    const sk = sketcher();
    sk.load("order 1043 ships on Oct 28 with 3 items");
    const a = sk.numberKey;
    sk.load("with 3 items order 1043 ships Oct 28");
    expect(sk.numberKey).toBe(a);
    sk.load("order 1044 ships on Oct 28 with 3 items");
    expect(sk.numberKey).not.toBe(a);
    sk.load("no numbers here at all");
    expect(sk.numberKey).toBe(0);
  });
});

describe("TextSketcher shingles", () => {
  test("text shorter than the shingle size is one shingle; empty text has none", () => {
    const sk = sketcher(3);
    sk.load("two words");
    expect(sk.shingles).toBe(1);
    sk.load("");
    expect(sk.shingles).toBe(0);
    const s = new Uint32Array(8);
    sk.minhash(s);
    expect([...s]).toEqual(new Array(8).fill(0xffffffff));
    const sim = new Uint32Array(2);
    sk.simhash(sim);
    expect([...sim]).toEqual([0, 0]);
  });

  test("scripts without spaces are split into character bigrams", () => {
    const sk = sketcher(1);
    expect(sk.load("東京の会議")).toBe(4); // 東京 京の の会 会議
    expect(sk.load("Osakaの小さなホテル")).toBe(1 + 6);
    expect(sk.load("東")).toBe(0); // the shared tokenizer drops one-character terms, in every script
    expect(isUnsegmented("東".charCodeAt(0))).toBe(true);
    expect(isUnsegmented("한".charCodeAt(0))).toBe(false); // Korean separates words with spaces
    // One edited character changes a few shingles, not the whole sentence.
    const sk3 = sketcher(3);
    const a = shingleSet(sk3, "共有フォルダにドラフトを置きました。火曜日までにコメントをお願いします。");
    const b = shingleSet(sk3, "共有フォルダにドラフトを置きました。水曜日までにコメントをお願いします。");
    expect(exactJaccard(a, b)).toBeGreaterThan(0.6);
  });

  test("maxTerms caps the units read", () => {
    const sk = new TextSketcher(new Vocab(64), 10, 3);
    expect(sk.load(sentence(50))).toBe(10);
    expect(sk.shingles).toBe(8);
  });

  test("shingle size is validated", () => {
    expect(() => new TextSketcher(new Vocab(16), 16, 0)).toThrow(RangeError);
    expect(() => new TextSketcher(new Vocab(16), 16, 9)).toThrow(RangeError);
  });
});

describe("MinHash", () => {
  test("estimates track exact Jaccard: unbiased, with error near the 1/sqrt(k) theory", () => {
    const sk = sketcher();
    let bias = 0;
    let sq = 0;
    let n = 0;
    for (let t = 0; t < 300; t++) {
      const base = Array.from({ length: 10 + rnd(60) }, () => WORDS[rnd(WORDS.length)]!);
      const edited = base.slice();
      const edits = rnd(Math.ceil(base.length / 2));
      for (let e = 0; e < edits; e++) edited[rnd(edited.length)] = WORDS[rnd(WORDS.length)]!;
      const a = base.join(" ");
      const b = edited.join(" ");
      const J = exactJaccard(shingleSet(sk, a), shingleSet(sk, b));
      const est = minhashSimilarity(sig(sk, a), sig(sk, b));
      bias += est - J;
      sq += (est - J) ** 2;
      n++;
    }
    expect(Math.abs(bias / n)).toBeLessThan(0.01);
    expect(Math.sqrt(sq / n)).toBeLessThan(0.05); // theory: sqrt(J(1-J)/128) <= 0.044
  });

  test("the shipped permutation matches a full-finalizer reference family on the same shingles", () => {
    // Reference: min over mix32(shingle ^ seed_i) with independent seeds (the textbook construction).
    const sk = sketcher();
    const seeds = Array.from({ length: 128 }, (_, i) => mix32(i * 0x9e3779b9 + 7));
    const reference = (set: Set<number>) =>
      seeds.map((s) => {
        let m = 0xffffffff;
        for (const h of set) m = Math.min(m, mix32(h ^ s));
        return m;
      });
    let ours = 0;
    let ref = 0;
    for (let t = 0; t < 200; t++) {
      const a = sentence(30);
      const b = a.split(" ").slice(0, 20).join(" ") + " " + sentence(10);
      const sa = shingleSet(sk, a);
      const sb = shingleSet(sk, b);
      const J = exactJaccard(sa, sb);
      ours += (minhashSimilarity(sig(sk, a), sig(sk, b)) - J) ** 2;
      const ra = reference(sa);
      const rb = reference(sb);
      ref += (ra.filter((v, i) => v === rb[i]).length / 128 - J) ** 2;
    }
    expect(Math.sqrt(ours / 200)).toBeLessThan(Math.sqrt(ref / 200) * 1.3);
  });

  test("identical texts are 1, disjoint texts near 0; lengths must match; k is bounded", () => {
    const sk = sketcher();
    expect(minhashSimilarity(sig(sk, "alpha beta gamma delta"), sig(sk, "alpha beta gamma delta"))).toBe(1);
    expect(minhashSimilarity(sig(sk, sentence(40)), sig(sk, "zz yy xx ww vv uu tt"))).toBeLessThan(0.05);
    expect(() => minhashSimilarity(new Uint32Array(4), new Uint32Array(8))).toThrow(RangeError);
    expect(() => sk.minhash(new Uint32Array(MAX_PERMUTATIONS + 1))).toThrow(RangeError);
  });
});

describe("SimHash, hamming64, popcount32", () => {
  test("popcount and hamming agree with a naive bit count", () => {
    const naive = (x: number) => x.toString(2).split("1").length - 1;
    for (let i = 0; i < 2_000; i++) {
      const a = mix32(i);
      const b = mix32(i * 31 + 7);
      expect(popcount32(a)).toBe(naive(a >>> 0));
      expect(hamming64(a, b, b, a)).toBe(naive((a ^ b) >>> 0) * 2);
    }
    expect(popcount32(0xffffffff)).toBe(32);
  });

  test("near-identical texts differ in few bits, unrelated ones in about half", () => {
    const sk = sketcher();
    const sim = (t: string) => {
      sk.load(t);
      const o = new Uint32Array(2);
      sk.simhash(o);
      return o;
    };
    const base = sentence(80);
    const a = sim(base);
    const b = sim(base.replace(/\S+$/, "changed"));
    expect(hamming64(a[0]!, a[1]!, b[0]!, b[1]!)).toBeLessThanOrEqual(6);
    let total = 0;
    for (let t = 0; t < 50; t++) {
      const c = sim(sentence(80));
      total += hamming64(a[0]!, a[1]!, c[0]!, c[1]!);
    }
    expect(total / 50).toBeGreaterThan(20);
  });
});

describe("MinHashIndex", () => {
  const randomSig = (k: number) => Uint32Array.from({ length: k }, () => mix32(rnd(0x7fffffff)));

  /** A naive banding reference: a Map from "band:values" to ids. */
  class Naive {
    readonly buckets = new Map<string, Set<number>>();
    constructor(
      readonly b: number,
      readonly r: number,
    ) {}
    private keys(s: Uint32Array) {
      return Array.from({ length: this.b }, (_, i) => `${i}:${s.slice(i * this.r, (i + 1) * this.r).join(",")}`);
    }
    add(id: number, s: Uint32Array) {
      for (const k of this.keys(s)) {
        if (!this.buckets.has(k)) this.buckets.set(k, new Set());
        this.buckets.get(k)!.add(id);
      }
    }
    remove(id: number, s: Uint32Array) {
      for (const k of this.keys(s)) this.buckets.get(k)?.delete(id);
    }
    candidates(s: Uint32Array) {
      const out = new Set<number>();
      for (const k of this.keys(s)) for (const id of this.buckets.get(k) ?? []) out.add(id);
      return [...out].sort((a, b) => a - b);
    }
  }

  test("agrees with naive banding under random adds and removes (with shared bands and table growth)", () => {
    const b = 8;
    const r = 2;
    const index = new MinHashIndex(b, r, 4); // tiny: forces resizes
    const naive = new Naive(b, r);
    const live = new Map<number, Uint32Array>();
    const pool = Array.from({ length: 40 }, () => randomSig(b * r));
    // Variants share bands with pool members, so buckets hold several ids.
    const make = () => {
      const s = pool[rnd(pool.length)]!.slice();
      for (let j = 0; j < s.length; j++) if (rnd(3) === 0) s[j] = mix32(rnd(1000));
      return s;
    };
    const out = new Int32Array(1_000);
    for (let step = 0; step < 5_000; step++) {
      const op = rnd(10);
      if (op < 5 || live.size === 0) {
        const id = rnd(300);
        if (live.has(id)) continue;
        const s = make();
        live.set(id, s);
        index.add(id, s);
        naive.add(id, s);
      } else if (op < 8) {
        const ids = [...live.keys()];
        const id = ids[rnd(ids.length)]!;
        index.remove(id, live.get(id)!);
        naive.remove(id, live.get(id)!);
        live.delete(id);
      } else {
        const q = make();
        const n = index.candidates(q, out);
        expect([...out.subarray(0, n)].sort((x, y) => x - y)).toEqual(naive.candidates(q));
      }
    }
    expect(index.size).toBe([...naive.buckets.values()].reduce((s, x) => s + x.size, 0));
  });

  test("adding the same id with the same signature twice is a no-op", () => {
    const index = new MinHashIndex(4, 4, 16);
    const s = randomSig(16);
    index.add(3, s);
    index.add(3, s);
    expect(index.size).toBe(4);
    const out = new Int32Array(4);
    expect(index.candidates(s, out)).toBe(1);
    expect(out[0]).toBe(3);
  });

  test("candidates respects the output length; short signatures are rejected", () => {
    const index = new MinHashIndex(2, 2, 16);
    const s = randomSig(4);
    for (let id = 0; id < 10; id++) index.add(id, s);
    expect(index.candidates(s, new Int32Array(3))).toBe(3);
    expect(() => index.add(0, new Uint32Array(3))).toThrow(RangeError);
  });

  test("lshCandidateProbability follows 1-(1-s^r)^b", () => {
    expect(lshCandidateProbability(0.8, 16, 8)).toBeCloseTo(0.9473, 3);
    expect(lshCandidateProbability(0.5, 16, 8)).toBeCloseTo(0.0606, 3);
    expect(lshCandidateProbability(1, 16, 8)).toBe(1);
  });
});

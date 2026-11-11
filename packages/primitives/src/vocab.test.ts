import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { FOLD, FOLD_DROP, FOLD_EXPAND, foldOf, foldString } from "./charclass";
import { fnv1a } from "./hash";
import { Xoshiro128 } from "./random";
import { clearTermMemo, Vocab } from "./vocab";

/** `foldString` as it was before it built a flat string (one `+=` per code unit): the output it must still equal. */
function foldStringRope(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const f = c < 128 ? FOLD[c]! : foldOf(c);
    if (f === FOLD_DROP) continue;
    if (f === FOLD_EXPAND) {
      const expanded = String.fromCharCode(c).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
      for (let j = 0; j < expanded.length; j++) {
        const e = expanded.charCodeAt(j);
        const g = e < 128 ? FOLD[e]! : foldOf(e);
        if (g !== FOLD_DROP && g !== FOLD_EXPAND) out += String.fromCharCode(g);
      }
      continue;
    }
    out += String.fromCharCode(f);
  }
  return out;
}

describe("foldString builds a flat string", () => {
  test("identical to the per-character rope on a Unicode corpus, final sigma and ligatures included", () => {
    const corpus = [
      "",
      "a",
      "Renewal",
      "ΟΔΥΣΣΕΥΣ",
      "Οδυσσεύς",
      "ς",
      "ϲ",
      "ﬁnance ﬂow ﬀ",
      "ﷺ",
      "İstanbul ıi",
      "Straße STRASSE",
      "Ångström café naïve",
      "é́",
      "Dana’s",
      "日本語のテキスト",
      "Привет МИР",
      "😀 emoji \ud83d lone \udc00 surrogates",
      "Ⅻ ①②③ ㎏ ½",
      "x".repeat(4_095),
      "Y".repeat(4_096),
      "Zé".repeat(5_000),
      "ﬁ".repeat(3_000),
    ];
    for (const s of corpus) expect(foldString(s)).toBe(foldStringRope(s));
    // Every BMP code unit alone, and runs of them (the scratch reused across calls of different lengths).
    for (let c = 0; c < 65_536; c++) {
      const ch = String.fromCharCode(c);
      expect(foldString(ch)).toBe(foldStringRope(ch));
    }
    const rnd = new Xoshiro128(5);
    for (let k = 0; k < 2_000; k++) {
      let s = "";
      const n = Math.floor(rnd.uniform() * 40);
      for (let i = 0; i < n; i++) s += String.fromCharCode(Math.floor(rnd.uniform() * 0x3000));
      expect(foldString(s)).toBe(foldStringRope(s));
    }
  });

  test("at most 80 B of heap per stored term at 100k interned terms (heapStats slope)", () => {
    // Terms of 9-22 characters, each a slice of one flat text, as the tokenizer hands them over. Measured 42 B/term
    // flat; the per-character rope was 575 B/term.
    const rnd = new Xoshiro128(11);
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const parts: string[] = [];
    for (let i = 0; i < 120_000; i++) {
      let w = "";
      for (let j = 8 + Math.floor(rnd.uniform() * 10); j > 0; j--) w += letters[Math.floor(rnd.uniform() * 52)];
      parts.push(`${w}${i}`);
    }
    const flat = parts.join(" ");
    parts.length = 0;
    const v = new Vocab(1 << 18);
    let at = 0;
    const intern = (n: number) => {
      for (let k = 0; k < n; k++) {
        let e = flat.indexOf(" ", at);
        if (e < 0) e = flat.length;
        v.intern(flat.slice(at, e));
        at = e + 1;
      }
    };
    const heap = () => {
      Bun.gc(true);
      Bun.gc(true);
      return heapStats().heapSize;
    };
    intern(20_000);
    const before = heap();
    intern(100_000);
    const perTerm = (heap() - before) / 100_000;
    expect(v.live).toBe(120_000);
    expect(perTerm).toBeLessThanOrEqual(80);
  });
});

describe("Vocab.release", () => {
  test("a released term is gone, its id is reused, and the others are still found", () => {
    const v = new Vocab(16);
    const a = v.intern("renewal");
    const b = v.intern("quentavious");
    const c = v.intern("globex");
    const heard: number[] = [];
    v.onRelease((id) => heard.push(id));
    v.release(b);
    expect(heard).toEqual([b]);
    expect(v.lookup("quentavious")).toBe(-1);
    expect(v.term(b)).toBe("");
    expect([v.size, v.live]).toEqual([3, 2]);
    expect([v.lookup("renewal"), v.lookup("globex")]).toEqual([a, c]);
    v.release(b); // twice: ignored
    v.release(99); // unknown: ignored
    expect(heard).toEqual([b]);
    const d = v.intern("initech");
    expect(d).toBe(b); // the free id, not a new one
    expect([v.size, v.live, v.term(d), v.lookup("initech")]).toEqual([3, 3, "initech", d]);
    expect(v.lookup("quentavious")).toBe(-1);
  });

  test("random interns and releases agree with a Map, through rehashes and wrapped probe runs", () => {
    const rnd = new Xoshiro128(7);
    const v = new Vocab(16);
    const model = new Map<string, number>();
    for (let step = 0; step < 40_000; step++) {
      // A small universe, so terms come back after release and probe runs crowd and wrap the table.
      const w = `w${Math.floor(rnd.uniform() * 3_000)}`;
      if (rnd.uniform() < 0.45 && model.has(w)) {
        v.release(model.get(w)!);
        model.delete(w);
      } else {
        const id = v.intern(w);
        if (model.has(w)) expect(id).toBe(model.get(w)!);
        model.set(w, id);
      }
      if (step % 4_000 === 0 || step === 39_999) {
        for (const [t, id] of model) {
          expect(v.lookup(t)).toBe(id);
          expect(v.term(id)).toBe(t);
        }
        expect(v.live).toBe(model.size);
        // Ids are reused: the capacity stays near the most terms ever held at once, not the terms ever seen.
        expect(v.size).toBeLessThanOrEqual(3_000);
      }
    }
    for (let i = 0; i < 3_000; i++) if (!model.has(`w${i}`)) expect(v.lookup(`w${i}`)).toBe(-1);
  });
});

describe("Vocab's term arena (D998)", () => {
  test("terms stay exact through growth, releases, reuse and compaction, Latin-1 or not", () => {
    const v = new Vocab(16);
    const model = new Map<number, string>();
    let seed = 7;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    const words = ["zoë", "東京", "a", "x".repeat(300), "naïve", "3pm", "€uro", "ﬁ"];
    for (let round = 0; round < 20_000; round++) {
      const w = round % 7 === 0 ? `${words[rnd() % words.length]}${round}` : `w${rnd() % 5_000}`;
      const id = v.intern(w);
      model.set(id, v.term(id));
      expect(v.lookup(w)).toBe(id);
      if (rnd() % 3 === 0) {
        const gone = [...model.keys()][rnd() % model.size]!;
        v.release(gone);
        model.delete(gone);
      }
    }
    for (const [id, t] of model) {
      expect(v.term(id)).toBe(t);
      expect(v.lookup(t)).toBe(id);
    }
    // Compaction happened: the arena holds about what the live terms need, not every term ever added.
    const arena = (v as unknown as { bytes: Uint8Array }).bytes.length;
    const live = [...model.values()].reduce((n, t) => n + t.length, 0);
    expect(arena).toBeLessThanOrEqual(Math.max(256, 4 * live));
  });

  test("termFnv and termHasDigit read the arena as fnv1a and a digit test read the string", () => {
    const v = new Vocab(16);
    for (const w of ["renewal", "3pm", "zoë", "東京", "2026-11-20", "x".repeat(70_000)]) {
      const id = v.intern(w);
      const t = v.term(id);
      const latin1 = [...t].every((c) => c.charCodeAt(0) <= 0xff) && t.length < 0xffff;
      expect(v.termFnv(id)).toBe(latin1 ? fnv1a(t, 0, t.length) : -1);
      expect(v.termHasDigit(id)).toBe(latin1 && /[0-9]/.test(t));
    }
  });
});

test("a released term's bytes are zeroed in the arena (D998)", () => {
  const v = new Vocab(16);
  const id = v.intern("globexsecret");
  v.intern("kept");
  v.release(id);
  const bytes = (v as unknown as { bytes: Buffer }).bytes;
  expect(bytes.toString("latin1")).not.toContain("globexsecret");
  expect(v.term(v.lookup("kept"))).toBe("kept");
});

test("the decoded-term memo answers each vocabulary with its own terms, and forgets released ones (D998)", () => {
  // Two vocabularies give the same ids to different terms: neither reads the other's from the memo.
  const a = new Vocab(16);
  const b = new Vocab(16);
  for (let i = 0; i < 2_000; i++) {
    a.intern(`alpha${i}`);
    b.intern(`beta${i}`);
  }
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 2_000; i++) {
      expect(a.term(i)).toBe(`alpha${i}`);
      expect(b.term(i)).toBe(`beta${i}`);
    }
  }
  // A released id reused by a new term reads the new term, never the memo's old one.
  const id = a.lookup("alpha7");
  expect(a.term(id)).toBe("alpha7");
  a.release(id);
  expect(a.term(id)).toBe("");
  expect(a.intern("gamma")).toBe(id);
  expect(a.term(id)).toBe("gamma");
  clearTermMemo();
  expect(a.term(id)).toBe("gamma");
  expect(b.term(7)).toBe("beta7");
});

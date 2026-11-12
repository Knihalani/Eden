/**
 * A Unigram (sentencepiece) tokenizer read from a Hugging Face `tokenizer.json`, in TypeScript with no dependency
 * (F2, docs/research/f2-semantic-pool.md §4): Python's `tokenizers` held about 295 MB a process for the multilingual
 * e5 vocabulary; this holds one `Map` of the pieces and their scores in a typed array (about 55 MB for 250,002
 * pieces). It matched HF's ids on 440 of 440 sim texts (`packages/sim/lab/f2-pool/encoder-probe.ts`).
 *
 * The rules, as the e5 tokenizer has them: NFKC stands in for sentencepiece's precompiled `nmt_nfkc` map, whitespace
 * runs collapse, each word gets the "▁" prefix (Metaspace), and Viterbi picks the best-scoring split of each word over
 * the pieces by code point; a character no piece starts with is `<unk>`, and consecutive `<unk>`s fuse into one. The
 * output is wrapped in `<s>` … `</s>` and cut to `max` ids.
 */

/** The ids a tokenizer.json reserves for the specials the e5 (XLM-R) vocabulary uses. */
export interface Specials {
  bos: number;
  eos: number;
  unk: number;
}

const XLMR: Specials = { bos: 0, eos: 2, unk: 3 };

export class UnigramTokenizer {
  private readonly index = new Map<string, number>();
  private readonly scores: Float32Array;
  private readonly maxLen: number;

  constructor(
    vocab: readonly (readonly [string, number])[],
    private readonly specials: Specials = XLMR,
  ) {
    this.scores = new Float32Array(vocab.length);
    let max = 1;
    for (let i = 0; i < vocab.length; i++) {
      const [piece, score] = vocab[i]!;
      // The specials (<s>, <pad>, </s>, <unk>: ids 0–3 in XLM-R) are never matched inside text.
      if (i <= 3) continue;
      this.index.set(piece, i);
      this.scores[i] = score;
      max = Math.max(max, [...piece].length);
    }
    this.maxLen = max;
  }

  /** Reads `tokenizer.json`'s Unigram model (the `vocab` list of [piece, score]); throws on any other model. */
  static fromJson(json: string): UnigramTokenizer {
    const parsed = JSON.parse(json) as { model?: { type?: string; vocab?: [string, number][] } };
    if (parsed.model?.type !== "Unigram" || !Array.isArray(parsed.model.vocab))
      throw new Error("encoder: tokenizer.json is not a Unigram model");
    return new UnigramTokenizer(parsed.model.vocab);
  }

  get size(): number {
    return this.scores.length;
  }

  /** The best split of one "▁word" by Viterbi over code points. */
  word(w: string): number[] {
    const cps = [...w];
    const n = cps.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1);
    const id = new Int32Array(n + 1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let s = "";
      let starts = false;
      for (let j = i; j < Math.min(n, i + this.maxLen); j++) {
        s += cps[j];
        const k = this.index.get(s);
        if (k === undefined) continue;
        if (j === i) starts = true;
        const v = best[i]! + this.scores[k]!;
        if (v > best[j + 1]!) {
          best[j + 1] = v;
          from[j + 1] = i;
          id[j + 1] = k;
        }
      }
      if (!starts) {
        // No piece starts with this character: <unk>, scored below any piece (sentencepiece's unknown penalty).
        const v = best[i]! - 110;
        if (v > best[i + 1]!) {
          best[i + 1] = v;
          from[i + 1] = i;
          id[i + 1] = this.specials.unk;
        }
      }
    }
    const out: number[] = [];
    for (let j = n; j > 0; j = from[j]!) out.push(id[j]!);
    out.reverse();
    return out.filter((x, i) => !(x === this.specials.unk && out[i - 1] === this.specials.unk));
  }

  /** The ids of `text`, `<s>` first and `</s>` last, at most `max` in all. */
  encode(text: string, max = 128): number[] {
    const ids = [this.specials.bos];
    const words = text.normalize("NFKC").replace(/\s+/g, " ").trim().split(" ");
    outer: for (const w of words) {
      if (!w) continue;
      for (const k of this.word("▁" + w)) {
        if (ids.length >= max - 1) break outer;
        ids.push(k);
      }
    }
    ids.push(this.specials.eos);
    return ids;
  }
}

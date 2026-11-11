/**
 * M3 (D907): the binnet `supersede` (H10) and `tags` (H13) networks in plain TypeScript, from export_net.py's flat
 * files. Hashed n-grams (CRC-32 as Python's zlib), the encoder's sum over its table (ternary or float) with the folded
 * batch norm and a sign (binary) or tanh (float), then the network's layers. Checks its logits against PyTorch's on the
 * exported held-out inputs and times an item's encoding and a pair's or an item's score.
 *
 *   bun packages/sim/lab/m3r/twin-forward.ts DIR [DIR...]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Meta = {
  arch: "supersede" | "tags";
  tags?: string[];
  float: boolean;
  bits: number;
  buckets: number;
  arrays: Record<string, { dtype: string; shape: number[] }>;
  checks: { a?: string; b?: string; text?: string; logit?: number; logits?: number[] }[];
};

function load(dir: string) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
  const arr = (name: string) => {
    const buf = readFileSync(join(dir, `${name}.bin`));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return meta.arrays[name]!.dtype === "int8" ? new Int8Array(ab) : new Float32Array(ab);
  };
  return { meta, arr };
}

const WORD = /[a-z0-9£$€]+/g;

/** binnet.py's `grams`: words, character 3- and 4-grams inside words, word bigrams; hashed, sorted, at most 300. */
export function grams(text: string, buckets: number, cap = 300): number[] {
  const words = (text.toLowerCase().match(WORD) ?? []).slice(0, 150);
  const out = new Set<number>();
  for (const w of words) {
    out.add(Bun.hash.crc32(`w${w}`) % buckets);
    const p = `<${w}>`;
    for (const n of [3, 4])
      for (let k = 0; k + n <= p.length; k++) out.add(Bun.hash.crc32(`c${p.slice(k, k + n)}`) % buckets);
  }
  for (let k = 0; k + 1 < words.length; k++) out.add(Bun.hash.crc32(`b${words[k]} ${words[k + 1]}`) % buckets);
  return [...out].sort((a, b) => a - b).slice(0, cap);
}

export function network(dir: string) {
  const { meta, arr } = load(dir);
  const B = meta.bits;
  const enc = arr("enc");
  const encScale = (arr("enc_scale") as Float32Array)[0]!;
  const bnS0 = arr("enc_bn_s") as Float32Array;
  const bnH0 = arr("enc_bn_h") as Float32Array;
  const l1 = arr("l1");
  const l1Scale = arr("l1_scale") as Float32Array;
  const bnS1 = arr("l1_bn_s") as Float32Array;
  const bnH1 = arr("l1_bn_h") as Float32Array;
  const headW = arr("head_w") as Float32Array;
  const headB = arr("head_b") as Float32Array;
  const H1 = meta.arrays.l1!.shape[0]!;
  const IN1 = meta.arrays.l1!.shape[1]!;
  const OUT = meta.arrays.head_b!.shape[0]!;
  const act = meta.float ? Math.tanh : (x: number) => (x >= 0 ? 1 : -1);
  const acc = new Float32Array(B);

  /** An item's (or request's) code: B values in {-1, +1} (binary) or (-1, 1) (float). */
  const encode = (text: string): Float32Array => {
    acc.fill(0);
    for (const g of grams(text, meta.buckets)) {
      const base = g * B;
      for (let b = 0; b < B; b++) acc[b]! += enc[base + b]!;
    }
    const out = new Float32Array(B);
    for (let b = 0; b < B; b++) out[b] = act(acc[b]! * encScale * bnS0[b]! + bnH0[b]!);
    return out;
  };

  const x = new Float32Array(IN1);
  const h = new Float32Array(H1);
  const layers = (): number[] => {
    for (let o = 0; o < H1; o++) {
      let s = 0;
      const base = o * IN1;
      for (let i = 0; i < IN1; i++) s += x[i]! * l1[base + i]!;
      h[o] = act(s * l1Scale[o]! * bnS1[o]! + bnH1[o]!);
    }
    const out: number[] = [];
    for (let c = 0; c < OUT; c++) {
      let s = headB[c]!;
      for (let o = 0; o < H1; o++) s += h[o]! * headW[c * H1 + o]!;
      out.push(s);
    }
    return out;
  };

  /** H10: logit that `newer` replaces `older` (codes from `encode`). */
  const replaces = (a: Float32Array, b: Float32Array): number => {
    for (let k = 0; k < B; k++) {
      x[k] = a[k]!;
      x[B + k] = b[k]!;
      x[2 * B + k] = a[k]! * b[k]!;
    }
    return layers()[0]!;
  };
  /** H13: the tag logits of an item's code. */
  const tags = (a: Float32Array): number[] => {
    x.set(a);
    return layers();
  };
  return { meta, encode, replaces, tags };
}

if (import.meta.main) {
  for (const dir of process.argv.slice(2)) {
    const net = network(dir);
    const { meta } = net;
    let maxErr = 0;
    let signAgree = 0;
    const t0 = performance.now();
    let n = 0;
    for (const c of meta.checks) {
      if (meta.arch === "supersede") {
        const got = net.replaces(net.encode(c.a!), net.encode(c.b!));
        maxErr = Math.max(maxErr, Math.abs(got - c.logit!));
        signAgree += Math.sign(got) === Math.sign(c.logit!) ? 1 : 0;
      } else {
        const got = net.tags(net.encode(c.text!));
        for (let k = 0; k < got.length; k++) maxErr = Math.max(maxErr, Math.abs(got[k]! - c.logits![k]!));
        signAgree += got.indexOf(Math.max(...got)) === c.logits!.indexOf(Math.max(...c.logits!)) ? 1 : 0;
      }
      n++;
    }
    const checkMs = performance.now() - t0;
    // Timing: an item's encoding, and the scoring step on codes already held (what a request pays a pair or item).
    const text = meta.checks[0]!.a ?? meta.checks[0]!.text!;
    const reps = 400;
    let t = performance.now();
    let codes = net.encode(text);
    for (let r = 0; r < reps; r++) codes = net.encode(text);
    const encodeUs = ((performance.now() - t) * 1_000) / reps;
    t = performance.now();
    let sink = 0;
    for (let r = 0; r < reps * 10; r++)
      sink += meta.arch === "supersede" ? net.replaces(codes, codes) : net.tags(codes)[0]!;
    const scoreUs = ((performance.now() - t) * 1_000) / (reps * 10);
    console.log(
      JSON.stringify({
        dir,
        arch: meta.arch,
        float: meta.float,
        checks: n,
        max_abs_err_vs_torch: +maxErr.toFixed(4),
        same_decision: signAgree,
        encode_us_item: +encodeUs.toFixed(1),
        score_us: +scoreUs.toFixed(2),
        check_ms: +checkMs.toFixed(1),
        sink: Math.sign(sink),
      }),
    );
  }
}

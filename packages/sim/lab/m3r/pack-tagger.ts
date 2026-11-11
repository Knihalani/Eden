/**
 * M3 (D908): packs an exported binnet `tags` network (export_net.py's flat files) into the engine's shipped file
 * (`packages/engine/models/tags-v1.bin`, read by `@eden/engine`'s `tagger.ts`): the ternary encoder at two bits a
 * weight, the binary layer at one bit, the scales, folded norms and head as float32, and a JSON header with a few of
 * the export's PyTorch checks so the engine's parity test needs nothing else.
 *
 *   bun packages/sim/lab/m3r/pack-tagger.ts .local/m3/nets/tags-bin packages/engine/models/tags-v1.bin
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error("usage: pack-tagger.ts EXPORT_DIR OUT");
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
if (meta.arch !== "tags" || meta.float) throw new Error("pack-tagger: a binary `tags` export only");
const raw = (name: string) => {
  const b = readFileSync(join(dir, `${name}.bin`));
  return meta.arrays[name].dtype === "int8"
    ? new Int8Array(b.buffer, b.byteOffset, b.byteLength)
    : new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const enc = raw("enc") as Int8Array;
const l1 = raw("l1") as Int8Array;
// Two bits a ternary weight (0 → 0, +1 → 1, −1 → 2), four to a byte, low bits first.
const encPacked = new Uint8Array(Math.ceil(enc.length / 4));
for (let i = 0; i < enc.length; i++) {
  const v = enc[i]!;
  if (v !== 0 && v !== 1 && v !== -1) throw new Error(`pack-tagger: enc[${i}] = ${v} is not ternary`);
  encPacked[i >> 2]! |= (v === 0 ? 0 : v === 1 ? 1 : 2) << ((i & 3) * 2);
}
// One bit a binary weight (1 → +1, 0 → −1).
const l1Packed = new Uint8Array(Math.ceil(l1.length / 8));
for (let i = 0; i < l1.length; i++) {
  if (l1[i] !== 1 && l1[i] !== -1) throw new Error(`pack-tagger: l1[${i}] = ${l1[i]} is not binary`);
  if (l1[i] === 1) l1Packed[i >> 3]! |= 1 << (i & 7);
}
const floats = ["enc_scale", "enc_bn_s", "enc_bn_h", "l1_scale", "l1_bn_s", "l1_bn_h", "head_w", "head_b"];
const header = {
  version: 1,
  bits: meta.bits,
  buckets: meta.buckets,
  hidden: meta.arrays.l1.shape[0],
  tags: meta.tags,
  floats: floats.map((n) => ({ name: n, length: meta.arrays[n].shape.reduce((a: number, b: number) => a * b, 1) })),
  // Sim-world item texts (generated, no user data) with PyTorch's logits, for the parity test.
  checks: meta.checks.slice(0, 16),
};
const head = Buffer.from(JSON.stringify(header), "utf8");
const parts: Uint8Array[] = [Buffer.from("EDT1"), new Uint8Array(new Uint32Array([head.length]).buffer), head];
const pad = (n: number) => new Uint8Array((4 - (n % 4)) % 4);
let at = 8 + head.length;
parts.push(pad(at));
at += pad(at).length;
parts.push(encPacked, l1Packed);
at += encPacked.length + l1Packed.length;
parts.push(pad(at));
for (const n of floats) parts.push(new Uint8Array((raw(n) as Float32Array).buffer));
writeFileSync(out, Buffer.concat(parts));
console.log(JSON.stringify({ out, bytes: Buffer.concat(parts).length }));

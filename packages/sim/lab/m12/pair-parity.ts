/**
 * M12: the engine's EP12 forward (`loadPoolPair`) against export_pair.py's PyTorch-path cases: every request code,
 * item code, scan score and pair score must match, then the timings and size the bar reads.
 *
 *   bun packages/sim/lab/m12/pair-parity.ts OUT.ep12 OUT.checks.json
 */
import { readFileSync } from "node:fs";
import { loadPoolPair } from "@eden/engine";

const [model, checks] = process.argv.slice(2);
if (!model || !checks) throw new Error("usage: pair-parity.ts MODEL.ep12 CHECKS.json");
const net = loadPoolPair(new Uint8Array(readFileSync(model)));
const { cases } = JSON.parse(readFileSync(checks, "utf8")) as {
  cases: { q: string[]; title: string[]; text: string[]; qcode: number[]; icode: number[]; dot: number; score: number }[];
};
const bits = (c: Int32Array) => Array.from({ length: net.bits }, (_, b) => ((c[b >>> 5]! >>> (b & 31)) & 1 ? 1 : -1));
let ok = 0;
let worst = 0;
for (const c of cases) {
  const q = net.code(c.q, "request");
  const i = net.itemCode(c.title, c.text);
  const sameQ = bits(q).every((v, k) => v === c.qcode[k]);
  const sameI = bits(i).every((v, k) => v === c.icode[k]);
  const ds = Math.abs(net.scan(q, i) - c.dot);
  const ps = Math.abs(net.score(q, i) - c.score);
  worst = Math.max(worst, ds, ps);
  if (sameQ && sameI && ds < 1e-3 && ps < 1e-3) ok++;
}
console.log(`parity ${ok}/${cases.length}, worst score difference ${worst.toExponential(2)}`);
// Timings: an item's code, a scan over 3,000 codes, 100 pair scores.
const item = cases[0]!;
let t = performance.now();
for (let k = 0; k < 500; k++) net.itemCode(item.title, item.text);
const codeUs = ((performance.now() - t) / 500) * 1000;
const codes = cases.map((c) => net.itemCode(c.title, c.text));
const q = net.code(cases[0]!.q, "request");
t = performance.now();
let sink = 0;
for (let r = 0; r < 50; r++) for (let k = 0; k < 3000; k++) sink += net.scan(q, codes[k % codes.length]!);
const scanMs = (performance.now() - t) / 50;
t = performance.now();
for (let r = 0; r < 50; r++) for (let k = 0; k < 100; k++) sink += net.score(q, codes[k % codes.length]!);
const pairMs = (performance.now() - t) / 50;
console.log(
  `model ${net.bytes} bytes; item code ${codeUs.toFixed(1)} µs; scan of 3,000 items ${scanMs.toFixed(3)} ms; ` +
    `100 pair scores ${pairMs.toFixed(3)} ms; code ${net.bits / 8} bytes an item (${sink > 0 ? "" : ""}checksum)`,
);
process.exit(ok === cases.length ? 0 : 1);

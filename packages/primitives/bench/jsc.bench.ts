/** JavaScriptCore behaviours that shaped the primitives, each isolated on a 2 KB string. */
import { bench, corpus, report } from "./harness";

const flat = corpus(2048);
let rope = "";
for (const word of flat.split(" ")) rope += word + " "; // built with +=: a rope until something flattens it

function withDefaults(s: string, start = 0, end = s.length) {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function hoisted(s: string) {
  let h = 0x811c9dc5;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function fused(s: string, start: number, end: number) {
  let h = 0x811c9dc5 | 0;
  for (let i = start; i < end; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
function readOnly(s: string) {
  let h = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) h = (h + s.charCodeAt(i)) | 0;
  return h;
}
report([
  bench("FNV loop, default parameters", () => withDefaults(flat), { batch: 50 }),
  bench("FNV loop, length hoisted", () => hoisted(flat), { batch: 50 }),
  bench("FNV loop, explicit range, fused imul", () => fused(flat, 0, flat.length), { batch: 50 }),
  bench("read every char only (floor)", () => readOnly(flat), { batch: 50 }),
  bench("read every char of a += rope", () => readOnly(rope), { batch: 50 }),
]);

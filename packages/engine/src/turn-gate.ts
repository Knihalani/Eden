/**
 * M13's turn gate (D1010-D1019, docs/research/m13-gate.md): a tiny learned model that reads one user turn and says
 * whether it starts the push (an acting request or a question about acting) and what kind of turn it is. Features
 * are hashed character and word n-grams (no tokenizer, no pretrained table), so it reads any language. The Python
 * twin is packages/sim/lab/m13/feats.py: the two must give the same ids for the same text (`turn-gate.test.ts`).
 */

const FNV0 = 2166136261;
const FNVP = 16777619;
/** Code points read after normalising: a turn is decided on its head (a bound on work, not a heuristic). */
const MAXCP = 300;
const WS = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
const WORD = /[\p{L}\p{M}\p{N}'’]/u;

/** NFKC, lower case, ASCII digits to 0, white space runs to one space, the first `MAXCP` code points. */
export function gateNorm(s: string): string {
  const head = Array.from(s.slice(0, 8 * MAXCP))
    .slice(0, 4 * MAXCP)
    .join("");
  const t = head
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[0-9]/g, "0")
    .replace(WS, " ")
    .replace(/^ +| +$/g, "");
  return Array.from(t).slice(0, MAXCP).join("");
}

function hashOf(salt: number, cps: ArrayLike<number>, from = 0, to = cps.length): number {
  let x = Math.imul(FNV0 ^ salt, FNVP) >>> 0;
  for (let i = from; i < to; i++) x = Math.imul(x ^ cps[i]!, FNVP) >>> 0;
  return x;
}

function grams(cps: number[], lo: number, hi: number, salt: number, out: Set<number>, mask: number): void {
  for (let k = lo; k <= hi; k++)
    for (let i = 0; i + k <= cps.length; i++) out.add(hashOf(salt + k, cps, i, i + k) & mask);
}

function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

export function gateWords(t: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of t)
    if (WORD.test(ch)) cur += ch;
    else if (cur) {
      out.push(cur);
      cur = "";
    }
  if (cur) out.push(cur);
  return out;
}

/** The turn's feature ids (sorted, unique), as feats.py's `featurise` with groups "chewp". */
export function gateFeatures(text: string, bits: number, skeleton?: ReadonlySet<string>): number[] {
  const mask = (1 << bits) - 1;
  const t = gateNorm(text);
  const cps = codePoints(t);
  const out = new Set<number>();
  grams([2, ...cps, 3], 1, 4, 100, out, mask);
  grams([2, ...cps].slice(0, 20), 2, 4, 200, out, mask);
  grams([...cps, 3].slice(-10), 1, 3, 300, out, mask);
  const ws = gateWords(t).map(codePoints);
  for (const w of ws) out.add(hashOf(400, w) & mask);
  for (let i = 0; i + 1 < ws.length; i++) out.add(hashOf(401, [...ws[i]!, 32, ...ws[i + 1]!]) & mask);
  for (let i = 0; i < Math.min(3, ws.length); i++) out.add(hashOf(500 + i, ws[i]!) & mask);
  if (ws.length) out.add(hashOf(510, ws[ws.length - 1]!) & mask);
  out.add(hashOf(520, [Math.min(ws.length, 20)]) & mask);
  if (skeleton) {
    const seq: number[][] = [[2]];
    for (const w of gateWords(t).slice(0, 40)) seq.push(codePoints(skeleton.has(w) ? w : w.includes("0") ? "0" : "x"));
    seq.push([3]);
    for (let n = 1; n <= 3; n++)
      for (let i = 0; i + n <= seq.length; i++) {
        const cps2: number[] = [];
        for (const w of seq.slice(i, i + n)) cps2.push(...w, 32);
        out.add(hashOf(700 + n + (i === 0 ? 10 : 0), cps2) & mask);
      }
  }
  return [...out].sort((a, b) => a - b);
}

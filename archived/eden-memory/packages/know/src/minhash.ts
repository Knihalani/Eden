/** FineWeb-shaped MinHash: word 5-grams, 14 bands × 8 hashes. Band hit ⇒ near-dup. */

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

function grams(ws: string[], n = 5): string[] {
  if (ws.length < n) return ws.length ? [ws.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i <= ws.length - n; i++) out.push(ws.slice(i, i + n).join(" "));
  return out;
}

function fnv(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const BANDS = 14;
const ROW = 8;
const SEEDS = Array.from({ length: BANDS * ROW }, (_, i) => (i + 1) * 2654435761);

export function minhashBands(text: string): string[] {
  const g = grams(words(text));
  if (!g.length) return [];
  const bands: string[] = [];
  for (let b = 0; b < BANDS; b++) {
    const mins: number[] = [];
    for (let r = 0; r < ROW; r++) {
      const seed = SEEDS[b * ROW + r]!;
      let m = 0xffffffff;
      for (const gram of g) {
        const h = fnv(gram, seed);
        if (h < m) m = h;
      }
      mins.push(m);
    }
    bands.push(mins.join("."));
  }
  return bands;
}

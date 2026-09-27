import { STOP, codeToks, contentToks, properNames, stem } from "./text";

const QUERY_LIGHT = new Set(
  ["country", "citizen", "author", "name", "city", "position", "sport", "nationality"].map(stem),
);

export function rareCueToks(q: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const t = String(raw ?? "").toLowerCase().trim();
    if (!t || t.length < 2 || STOP.has(t) || QUERY_LIGHT.has(stem(t)) || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const n of properNames(q)) add(n);
  for (const c of codeToks(q)) add(c);
  for (const t of contentToks(q)) {
    if (/\d/.test(t) || t.includes("-")) add(t);
  }
  for (const t of [...out]) {
    if (!t.includes("-")) continue;
    for (const p of t.split("-")) {
      if (p.length >= 4 || (/\d/.test(p) && /[a-z]/i.test(p))) add(p);
    }
  }
  return out;
}

export function rareTermHits(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const hay = String(text ?? "").toLowerCase();
  if (!hay) return 0;
  const toks = new Set(contentToks(hay));
  for (const w of (String(hay ?? "").toLowerCase().match(/[a-z0-9]+(?:[.'\-][a-z0-9]+)*/g) ?? [])) toks.add(w);
  let n = 0;
  for (const t of terms) {
    if (toks.has(t) || toks.has(stem(t))) n++;
  }
  return n;
}

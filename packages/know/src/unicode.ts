/** Unicode UCD Blocks.txt → `Unicode Block Basic Latin is U+0000..U+007F`. */

import type { Triple } from "./extract";

export const UNICODE_BLOCKS_URL = "https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt";

export function parseUnicodeBlocks(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^([0-9A-Fa-f]{4,6})\.\.([0-9A-Fa-f]{4,6});\s*(.+)$/.exec(t);
    if (!m) continue;
    const name = m[3]!.replace(/\s+/g, " ").trim();
    if (name.length < 3 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const a = m[1]!.toUpperCase();
    const b = m[2]!.toUpperCase();
    out.push({ s: `Unicode Block ${name}`, p: "is", o: `U+${a}..U+${b}`, e: "" });
  }
  return out;
}

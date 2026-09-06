/** Unicode PropertyValueAliases `sc` → `Unicode Script Latn is Latin`. */

import type { Triple } from "./extract";
import { UNICODE_SCRIPT_KEEP } from "./names";

export const UNICODE_SCRIPTS_URL = "https://www.unicode.org/Public/UCD/latest/ucd/PropertyValueAliases.txt";

export function parseUnicodeScripts(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split(";").map((x) => x.trim());
    if (parts[0] !== "sc" || parts.length < 3) continue;
    const code = parts[1]!;
    const name = parts[2]!;
    if (!/^[A-Z][a-z]{3}$/.test(code) || name.length < 3 || seen.has(code)) continue;
    if (!UNICODE_SCRIPT_KEEP.has(code)) continue;
    seen.add(code);
    out.push({ s: `Unicode Script ${code}`, p: "is", o: name.slice(0, 72), e: "" });
  }
  return out;
}

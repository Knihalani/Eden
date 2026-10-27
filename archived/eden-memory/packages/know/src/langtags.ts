/** IANA language-subtag-registry → `IANA language en is English`. 2-letter only. */

import type { Triple } from "./extract";
import { LANG_KEEP } from "./names";

export const LANG_SUBTAG_URL = "https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry";

export function parseLangSubtags(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  const chunks = text.split("%%");
  for (const chunk of chunks) {
    if (!/Type:\s*language\b/i.test(chunk)) continue;
    if (/Scope:\s*(collection|macrolanguage|special)/i.test(chunk)) continue;
    const sub = chunk.match(/Subtag:\s*([a-z]{2})\b/i)?.[1]?.toLowerCase();
    const desc = chunk
      .match(/Description:\s*([^\n]+)/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    if (!sub || !desc || desc.length < 2 || seen.has(sub)) continue;
    if (/private use|reserved/i.test(desc)) continue;
    if (!LANG_KEEP.has(sub)) continue;
    seen.add(sub);
    out.push({ s: `IANA language ${sub}`, p: "is", o: desc.slice(0, 72), e: "" });
  }
  return out;
}

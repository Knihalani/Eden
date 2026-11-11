/**
 * M11 (D970): the intent micro-expansion replayed from a file, for the $0 screens while a Python model is screened
 * (`hidden-funnel.ts --micro FILE`). The file maps an item's card key (`cardKey`: its redacted title and text) to its
 * terms and weights, `{h: {term: tf}}`; the expander repeats each term `tf` times (at most 3), as the model's own
 * forward gives them. An item the file does not hold gets no terms.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { cardKey, type IntentExpander } from "@eden/engine";

export function replayExpander(file: string): IntentExpander & { found: number; missed: number } {
  const raw = readFileSync(file);
  const map = JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as Record<
    string,
    Record<string, number>
  >;
  const out = {
    found: 0,
    missed: 0,
    expand(title: string, text: string): readonly string[] {
      const e = map[cardKey({ title, text } as Parameters<typeof cardKey>[0])];
      if (!e) {
        out.missed++;
        return [];
      }
      out.found++;
      const terms: string[] = [];
      for (const [t, w] of Object.entries(e)) for (let i = 0; i < Math.min(3, Math.max(1, w)); i++) terms.push(t);
      return terms;
    },
  };
  return out;
}

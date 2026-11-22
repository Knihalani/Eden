import { truncateUtf8 } from "@eden/primitives";
import { sanitizeForStore, secretHits } from "@eden/redact";
import { safeLine } from "./line";

const tokens = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+(?:[./:-][\p{L}\p{N}]+)*/gu) ?? [];

/** Check-authored source data: lexical faithfulness is deliberately stricter than paraphrase. */
export function checkedFact(value: unknown, text: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.slice(0, 4096);
  if (secretHits(raw).length) return undefined;
  const clean = sanitizeForStore(raw);
  const own = new Set(tokens(text));
  const normalized = safeLine(clean).replace(/"/g, "'");
  const words = tokens(normalized);
  if (!words.length || words.some((word) => !own.has(word))) return undefined;
  if (secretHits(normalized).length) return undefined;
  const line = normalized.split(/\s+/).slice(0, 20).join(" ");
  let bounded = truncateUtf8(line, 160).trim();
  if (bounded !== line && tokens(bounded).some((word) => !own.has(word))) bounded = bounded.replace(/\S+$/u, "").trim();
  return bounded && !secretHits(bounded).length ? bounded : undefined;
}

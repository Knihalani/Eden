import { hostOf } from "./extract";

const JUNK_TLD = /\.(xyz|top|click|loan|win|gq|cf|tk|ml|ga|icu|buzz|work|rest)$/i;
const JUNK_HOST = /(googleusercontent\.com|\.onion$|^[\d.]+$)/i;

export function cheapSkip(url: string, text: string): string | undefined {
  const h = hostOf(url);
  if (JUNK_TLD.test(h) || JUNK_HOST.test(h)) return "junk-host";
  if (text.length < 80) return "thin";
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (toks.length < 12) return "thin";
  const uniq = new Set(toks);
  if (uniq.size / toks.length < 0.18) return "boilerplate";
  let digits = 0;
  for (const t of toks) if (/^\d+$/.test(t)) digits++;
  if (digits / toks.length > 0.45) return "digit-spam";
  const blob = toks.slice(0, 80).join(" ");
  if (/\b(bahis|casino|slot gacor|crypto pump)\b/.test(blob) && !/\brfc\b|\bietf\b|\bnist\b/.test(blob)) {
    return "spam-vertical";
  }
  return undefined;
}

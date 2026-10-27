/**
 * Deterministic email-like text for the benchmarks: sentences mixing common words, names, ticket ids, emails, URLs,
 * dates and amounts, repeated and trimmed to a target size in UTF-8 bytes. The `nonAscii` variant swaps in
 * accented and CJK names and phrases so roughly a tenth of the characters are non-ASCII.
 */

/** mulberry32: a small, fixed-seed PRNG so every run and runtime sees the same text. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "the a to and of in for on with is that this it we can you be will at as are from have please let me know " +
  "about our team meeting update review draft deck budget plan launch customer follow-up notes call thanks " +
  "tomorrow today next week before after friday monday quarter numbers invoice contract renewal deadline " +
  "shipping it's we're don't can't migration rollout incident postmortem roadmap hiring offer onboarding"
).split(" ");
const NAMES = ["Dana Lee", "Priya Raman", "Marcus Chen", "Globex", "Initech", "Sam O'Neil", "Acme Corp", "Jordan"];
const NAMES_INTL = [
  "José Muñoz",
  "Zoë Björk",
  "François Lefèvre",
  "山田太郎",
  "Łukasz Żółw",
  "Müller GmbH",
  "東京支社",
];
const PHRASES_INTL = ["会議の資料", "résumé", "naïve café", "señor", "größe", "日程調整", "Ölçüm", "프로젝트"];
const DOMAINS = ["globex.com", "initech.io", "acme.co.uk", "example.org"];

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function sentence(rand: () => number, nonAscii: boolean): string {
  const parts: string[] = [];
  const words = 6 + Math.floor(rand() * 10);
  for (let i = 0; i < words; i++) {
    const roll = rand();
    if (roll < 0.08) parts.push(nonAscii && rand() < 0.85 ? pick(rand, NAMES_INTL) : pick(rand, NAMES));
    else if (roll < 0.11) parts.push(`OPS-${100 + Math.floor(rand() * 900)}`);
    else if (roll < 0.13) parts.push(`${pick(rand, ["dana", "priya.raman", "m.chen"])}@${pick(rand, DOMAINS)}`);
    else if (roll < 0.15) parts.push(`https://${pick(rand, DOMAINS)}/t/${Math.floor(rand() * 1e6)}`);
    else if (roll < 0.17) parts.push(`2026-${1 + Math.floor(rand() * 12)}-${1 + Math.floor(rand() * 28)}`);
    else if (roll < 0.19) parts.push(`$${(rand() * 20000).toFixed(2)}`);
    else if (nonAscii && roll < 0.33) parts.push(pick(rand, PHRASES_INTL));
    else parts.push(pick(rand, WORDS));
  }
  const text = parts.join(" ");
  return text[0]!.toUpperCase() + text.slice(1) + pick(rand, [".", ".", "?", "!"]);
}

const encoder = new TextEncoder();

/** Text of at most `bytes` UTF-8 bytes (trimmed on a character boundary), from a fixed seed. */
export function emailText(bytes: number, nonAscii = false, seed = 42): string {
  const rand = prng(seed);
  let text = "";
  while (encoder.encode(text).length < bytes) {
    text += sentence(rand, nonAscii) + (rand() < 0.2 ? "\n\n" : " ");
  }
  // Trim by code points so no surrogate pair is split.
  const chars = Array.from(text);
  let size = encoder.encode(text).length;
  while (size > bytes) size -= encoder.encode(chars.pop()!).length;
  return chars.join("");
}

/** The share of a text's characters (code points) that are non-ASCII. */
export function nonAsciiShare(text: string): number {
  const chars = Array.from(text);
  return chars.filter((char) => char.charCodeAt(0) > 127).length / chars.length;
}

export const SIZES = [256, 2048, 16384] as const;

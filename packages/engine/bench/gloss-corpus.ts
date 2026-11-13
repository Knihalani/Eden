/**
 * Requests for the glossary's differential test and benchmark (D1710): a sweep that looks up every glossed word,
 * function word and English word of the shipped glossary, and seeded fuzzed requests in its 26 languages. Built from
 * the glossary's word lists alone (`GlossWords`), so the same seed gives the same requests whatever reads the file.
 */

/** One language's words as the glossary holds them: function words in file order, glossed words sorted. */
export interface GlossWords {
  code: string;
  fn: string[];
  keys: string[];
}

/** mulberry32: a small seeded generator, so a corpus is the same on every run and machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** English requests, what most traffic is: the glossary must leave them alone, and fast. */
export const ENGLISH = [
  "Move £5,000 from my current account into my Marlow cash ISA this week.",
  "Book a table at Le Petit Bistro for Anna and Jens on Thursday.",
  "Email Jean-Pierre about the dinner at Café du Monde et la Gare on Friday.",
  "Can you remind me to renew the car insurance before it lapses next month?",
  "Pay the van der Berg invoice for the extension and copy Pieter van den Heuvel.",
  "What did Sarah say about the quarterly budget review in yesterday's thread?",
  "Cancel my Vitalis gym membership, I've not been in since the summer.",
  "Schedule a call with the plumber from Fixhub to look at the kitchen sink.",
  "Forward the Los Angeles del Mar contract to Maria dos Santos e Silva.",
  "I need to send the signed lease back to the letting agent by Monday.",
  // Contractions and possessives: `\p{L}+` splits "What's" into "what" and "s", and such clitics are function words
  // in other languages ("s" in Czech, "ve" in Czech and Turkish). D1710's review: they must not read the lexicons.
  "What's the plan for Friday's dinner with Tom's parents?",
  "I've booked the dentist, but I'll need to move Sarah's appointment.",
  "Don't forget we're meeting at the client's office; they'd like the slides.",
  "Can't find Mum's email about the flight, it's from last week.",
  "Who's picking up the kids' bikes from Dave's garage?",
  "I'm not sure the landlord's reply covers what we'd agreed.",
  "She'd said the invoice isn't due until next month, hasn't she?",
  "Let's check if the bank's transfer went through, I haven't seen it.",
  "You're right, the team's offsite moved; we'll need new train tickets.",
  "Where's the receipt for the boiler's repair? I'd filed it somewhere.",
];

const PUNCT = [" ", " ", " ", " ", ", ", ". ", "? ", "! ", " - ", ": ", " (", ") ", ' "', '" '];
const LINKS = ["", "s", "e", "en", "n", "er"];
const COMPOUNDING = new Set(["de", "nl", "sv", "da", "no"]);

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** One fuzzed request in `l`, with words of other languages, English, compounds, junk, case and spacing mixed in. */
function fuzzed(r: () => number, l: GlossWords, all: readonly GlossWords[], english: readonly string[]): string {
  const n = 2 + Math.floor(r() * 30);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    let w: string;
    if (roll < 0.3 && l.fn.length) w = pick(r, l.fn);
    else if (roll < 0.72 && l.keys.length) w = pick(r, l.keys);
    else if (roll < 0.8) w = pick(r, english);
    else if (roll < 0.86) {
      const o = pick(r, all);
      w = o.keys.length && r() < 0.7 ? pick(r, o.keys) : pick(r, o.fn.length ? o.fn : english);
    } else if (roll < 0.93 && l.keys.length) {
      // A compound: two known words with a linking letter, the splitter's case (and a near miss for the others).
      w = pick(r, l.keys) + (COMPOUNDING.has(l.code) ? pick(r, LINKS) : "") + pick(r, l.keys);
    } else if (roll < 0.96) {
      // A known word cut short or run on: the binary search's near misses.
      const k = l.keys.length ? pick(r, l.keys) : pick(r, english);
      w = r() < 0.5 ? k.slice(0, Math.max(1, k.length - 1 - Math.floor(r() * 3))) : k + pick(r, ["a", "é", "ß", "ı"]);
    } else {
      w = pick(r, ["5.000", "£1,450", "12:30", "2026", "€", "x", "ÀÉÎ", "naïve", "ﬁ", "İstanbul", "́", "日本"]);
    }
    const c = r();
    if (i === 0 || c < 0.08) w = cap(w);
    else if (c < 0.11) w = w.toUpperCase();
    parts.push(w, pick(r, PUNCT));
  }
  let text = parts.join("");
  // Past the 400 characters read, now and then: the cut must fall in the same place.
  if (r() < 0.05) text = text.repeat(1 + Math.floor(r() * 4));
  return r() < 0.1 ? text.normalize("NFD") : text;
}

/** `count` fuzzed requests spread over every language, from `seed`. */
export function fuzzCorpus(words: readonly GlossWords[], english: readonly string[], count: number, seed = 1710) {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(fuzzed(r, words[i % words.length]!, words, english));
  return out;
}

/**
 * Requests that, between them, look up every glossed word (three a request, after two function words so the
 * language is read), every function word, and every English word the glosses use (three a request, beside two
 * function words of each language in turn: English then outnumbers the language, and only the count decides).
 */
export function sweepCorpus(words: readonly GlossWords[], english: readonly string[]): string[] {
  const out: string[] = [];
  const head = (l: GlossWords) => l.fn.slice(0, 2).join(" ");
  for (const l of words) {
    for (let i = 0; i < l.keys.length; i += 3) out.push(`${head(l)} ${l.keys.slice(i, i + 3).join(" ")}`);
    for (let i = 0; i < l.fn.length; i += 2) out.push(`${l.fn.slice(i, i + 2).join(" ")} ${l.keys[0] ?? ""}`);
  }
  for (let i = 0; i < english.length; i += 3)
    out.push(`${head(words[(i / 3) % words.length]!)} ${english.slice(i, i + 3).join(" ")}`);
  return out;
}

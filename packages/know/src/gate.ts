import { hostOf } from "./extract";

const JUNK_TLD = /\.(xyz|top|click|loan|win|gq|cf|tk|ml|ga|icu|buzz|work|rest)$/i;
const JUNK_HOST = /(googleusercontent\.com|\.onion$|^[\d.]+$)/i;
const PAYWALL_HOST = /(^|\.)(wsj|ft|economist|nytimes|washingtonpost|bloomberg|wired|theathletic)\.com$/i;

/** Hostname without `www.` — same class as `hostOf`, no URL() on the WET skip path. */
export function fastHost(url: string): string {
  if (url.includes("@") || url.includes("[")) return hostOf(url);
  const scheme = url.indexOf("://");
  if (scheme < 0) return "";
  const s = scheme + 3;
  const n = url.length;
  let e = s;
  while (e < n) {
    const c = url.charCodeAt(e);
    if (c === 47 || c === 63 || c === 35 || c === 58) break;
    e++;
  }
  let h = url.slice(s, e).toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

/** URI-only junk (FineWeb URLFilter). Safe before body decode. */
export function cheapSkipHost(url: string): string | undefined {
  const h = fastHost(url);
  if (JUNK_TLD.test(h) || JUNK_HOST.test(h)) return "junk-host";
  return undefined;
}

/** Paywall + junk + bad host without constructing URL on the common path. */
export function headerSkipHost(url: string): boolean {
  const h = fastHost(url);
  if (!h) return true;
  if (PAYWALL_HOST.test(h) || JUNK_TLD.test(h) || JUNK_HOST.test(h)) return true;
  return false;
}

/** Gopher / MassiveText stop-word probe (no fastText). ≥2 hits ⇒ English-like. */
const GOPHER_STOP = new Set([
  "the",
  "be",
  "to",
  "of",
  "and",
  "that",
  "have",
  "with",
  "for",
  "this",
  "you",
  "not",
  "are",
  "from",
  "they",
  "his",
  "which",
  "or",
  "were",
  "but",
  "had",
  "was",
  "one",
  "our",
  "out",
  "has",
  "been",
  "is",
  "in",
  "on",
  "as",
  "by",
  "at",
  "an",
  "it",
]);

export function cheapSkip(url: string, text: string): string | undefined {
  const hostSkip = cheapSkipHost(url);
  if (hostSkip) return hostSkip;
  if (text.length < 80) return "thin";
  const toks = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
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

/**
 * Cheap Gopher / MassiveText quality (FineWeb spirit, no 100MB fastText).
 * Word count, mean word length, symbol/digit/alpha ratio, stop words, repetition.
 * Floor is 12 words so short WET fact pages still pass; dump-scale Gopher used 50.
 */
export function gopherSkip(text: string): string | undefined {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 12 || words.length > 100_000) return "gopher-words";
  let letterLen = 0;
  let letterWords = 0;
  let symbolish = 0;
  let digits = 0;
  const counts = new Map<string, number>();
  for (const w of words) {
    if (/[#…]|\.{3}|!{2,}/.test(w)) symbolish++;
    const core = w.replace(/[^A-Za-z0-9]/g, "");
    if (!core) {
      symbolish++;
      continue;
    }
    if (/^\d+$/.test(core)) digits++;
    const letters = (core.match(/[A-Za-z]/g) || []).length;
    if (letters) {
      letterLen += letters;
      letterWords++;
    }
    const k = core.toLowerCase();
    if (k.length > 1) counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (letterWords < 12) return "gopher-words";
  const mean = letterLen / letterWords;
  if (mean < 3 || mean > 10) return "gopher-mean";
  if (symbolish / words.length > 0.1) return "gopher-symbol";
  if (digits / words.length > 0.3) return "gopher-digit";
  if (letterWords / words.length < 0.8) return "gopher-alpha";
  let stops = 0;
  for (const s of GOPHER_STOP) if (counts.has(s)) stops++;
  if (stops < 2) return "gopher-stop";
  let maxc = 0;
  let n = 0;
  let uniq = 0;
  for (const c of counts.values()) {
    uniq++;
    n += c;
    if (c > maxc) maxc = c;
  }
  if (n && maxc / n > 0.45) return "gopher-repeat";
  if (n && uniq / n < 0.18) return "gopher-repeat";
  const lines = text
    .split(/\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 20);
  if (lines.length >= 4) {
    const seen = new Set<string>();
    let dup = 0;
    for (const l of lines) {
      if (seen.has(l)) dup++;
      else seen.add(l);
    }
    if (dup / lines.length > 0.3) return "gopher-repeat";
  }
  return undefined;
}

/** Casino / gambling spam. No RFC exemption — a slot page that name-drops RFC 9110 is still junk. */
export function wetSpam(text: string): boolean {
  const head = text.slice(0, 2500).toLowerCase();
  return /\b(bahis|casino|slot gacor|crypto pump)\b/.test(head);
}

/** Forum/how-to signal: problem + solution, not encyclopedia. */
export function wetTalkBearing(text: string): boolean {
  const head = text.slice(0, 12_000);
  return (
    /\bhow (?:do i|does one|can i|to|should i)\b/i.test(head) ||
    /\bwhat(?:'s| is) the (?:best|right|proper|correct|usual) way\b/i.test(head) ||
    /\bis there a (?:way|tool)\b/i.test(head) ||
    /\blooking for a (?:way|tool) to\b/i.test(head) ||
    /\banyone know how to\b/i.test(head) ||
    /\binstead of\b.{0,40}\buse\b/i.test(head) ||
    /\bdon(?:['’])?t use\b.{0,48}\buse\b/i.test(head) ||
    /\b(?:I|we)\s+used\s+[A-Za-z][\w.+-]{1,40}\s+(?:to|for)\b/i.test(head) ||
    /\b(?:fixed|solved|resolved)\b[\s\S]{0,48}\busing\b/i.test(head) ||
    /\b(?:workaround|this (?:fixed|solved|worked)|the (?:fix|solution|workaround) (?:is|was))\b/i.test(head) ||
    /\btry (?:using |to use )?[A-Za-z][\w.+-]{1,40}\s+(?:to|for)\b/i.test(head) ||
    /\byou (?:should|can|want to) use\b/i.test(head) ||
    /\brecommended way to\b|\bbest tool for\b/i.test(head)
  );
}

/** Typed-fact pages worth a WET keep: not “any long English”, not first-800 “capital of ” only. */
export function wetFactBearing(text: string): boolean {
  const head = text.slice(0, 12_000);
  if (
    /\bcapital of\b|\bis the capital\b|\bwas the capital of\b|\bcapital city of\b|\bofficial language\b|\bthe currency of\b/i.test(
      head,
    )
  ) {
    return true;
  }
  if (/\bis a country in\b|\bnational capitals?\b|\bISO\s*3166(?:-1)?\b/i.test(head)) return true;
  if (/\bis a (?:city|company|university|protocol|standard|language)\b/i.test(head)) return true;
  if (
    /\bis an?\s+(?:incredibly\s+|fast\s+|open[- ]source\s+|high[- ]level\s+)*(?:javascript\s+|python\s+|rust\s+|go\s+|ruby\s+|java\s+|typescript\s+|web\s+)?(?:runtime|compiler|bundler|package manager|programming language|web framework|testing framework|container runtime|version control system|build tool|command-line tool|cli(?:\s+tool)?|library|framework)\b/i.test(
      head,
    )
  ) {
    return true;
  }
  if (
    /\bis\s+(?:(?:also|often|commonly|typically|primarily|mainly|widely)\s+)?(?:used|designed|meant|intended)\s+(?:to|for)\b/i.test(
      head,
    ) ||
    /\bis\s+(?:the\s+)?(?:recommended|standard|usual|preferred|common)\s+(?:way|tool|method)\s+(?:to|for)\b/i.test(head)
  ) {
    return true;
  }
  if (wetTalkBearing(head)) return true;
  if (/\bheadquarters\b|\bfounded in\b|\bwas founded\b/i.test(head)) return true;
  if (/\bRFC\s*\d{3,5}\b/i.test(head)) return true;
  if (/\b(?:application|text|image|audio|video|font)\/[a-z0-9][a-z0-9!#$&^_.+-]*/i.test(head)) return true;
  if (/\bSPDX(?:-License-Identifier)?\s*:?\s*[A-Za-z0-9.+-]+/i.test(head)) return true;
  if (/\bIANA\b/i.test(head)) return true;
  if (/\barXiv:\d{4}\.\d{4,5}(?:v\d+)?\b/i.test(head)) return true;
  if (/\bPMID[:\s]\s*\d{5,}\b/i.test(head) || /\bPMC\d{5,}\b/i.test(head)) return true;
  if (/\bdoi:\s*10\.\d{4,9}\/\S+/i.test(head)) return true;
  if (/\bis a (?:preprint|journal|dataset)\b/i.test(head)) return true;
  return false;
}

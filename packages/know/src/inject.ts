import { detectNeed, isHotStaleRfc, isHotSuccessorRfc, type NeedInput } from "./need";
import { citeableUrl, knowQuery } from "./query";

type KnowSearch = {
  search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[];
  close?: () => void;
};

export const KNOW_INJECT_MARK = "Eden Know:";

const GAP_STOP = new Set(["the", "of", "is", "a", "an", "on", "to", "and", "in", "or", "for"]);

function fillGapToks(s: string, into: Set<string>) {
  let w = "";
  const n = s.length;
  for (let i = 0; i <= n; i++) {
    let d = i < n ? s.charCodeAt(i) : 32;
    if (d >= 65 && d <= 90) d += 32;
    if ((d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 46 || d === 45) {
      w += String.fromCharCode(d);
    } else if (w.length) {
      if (w.length > 1 && !GAP_STOP.has(w)) into.add(w);
      w = "";
    }
  }
}

function infoGap(fact: string, prompt: Set<string>): number {
  const seen = new Set<string>();
  fillGapToks(fact, seen);
  let n = 0;
  for (const t of seen) if (!prompt.has(t)) n++;
  return n;
}

/** Prefer implementer docs over encyclopedia hosts when two cards are otherwise tied. */
function sourceBump(url?: string): number {
  const u = citeableUrl(url);
  if (!u) return 0;
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (h === "www.rfc-editor.org" || h === "datatracker.ietf.org" || h.endsWith(".ietf.org")) return 1;
    if (h.endsWith(".github.io") || h.endsWith(".readthedocs.io")) return 2;
    if (h === "github.com") return 1;
    if (h === "bun.sh" || h === "jqlang.github.io" || h === "docs.python.org" || h === "go.dev" || h === "doc.rust-lang.org" || h === "docs.astral.sh") return 2;
  } catch {
    return 0;
  }
  return 0;
}

function pickScore(card: InjectCard, prompt: Set<string>): number {
  const stale = /\bRFC\s+\d{1,5}\s+(?:obsoletes|updates|is obsoleted by|is updated by)\b/i.test(card.fact) ? 100 : 0;
  return stale + infoGap(card.fact, prompt) * 4 + sourceBump(card.url);
}

/**
 * Wrap inject is for cards that change what the agent does: techniques
 * (`X is used for Y`) and protocol edges (`RFC A obsoletes RFC B`).
 * Capitals, RFC titles, IANA tautologies, licenses stay out — models already know those.
 */
export function usefulInjectFact(fact: string): boolean {
  const f = fact.trim();
  if (!f) return false;
  if (/ is used for /i.test(f)) return true;
  if (/\bRFC\s+\d{1,5}\s+obsoletes\s+RFC\s+\d/i.test(f)) return true;
  if (/\bRFC\s+\d{1,5}\s+updates\s+RFC\s+\d/i.test(f)) return true;
  if (/\bRFC\s+\d{1,5}\s+is obsoleted by\s+RFC\s+\d/i.test(f)) return true;
  if (/\bRFC\s+\d{1,5}\s+is updated by\s+RFC\s+\d/i.test(f)) return true;
  return false;
}

/** Queries that can produce a wrap card. Catalog flash is never worth a pack open. */
export function injectWorthQuery(q: string): boolean {
  const ql = q.trim().toLowerCase();
  if (ql.startsWith("used for ")) return true;
  if (/\bobsolet/.test(ql) || /\bupdates\b/.test(ql) || /\bupdated by\b/.test(ql)) return true;
  return false;
}

export type InjectCard = { fact: string; url?: string };

function cardFromKnow(q: string, store?: KnowSearch): InjectCard | undefined {
  const card = knowQuery(q, store);
  if (!("fact" in card) || !card.fact || !usefulInjectFact(card.fact)) return;
  const url = citeableUrl(card.url);
  return url ? { fact: card.fact, url } : { fact: card.fact };
}

function factFor(q: string, store?: KnowSearch): InjectCard | undefined {
  if (!injectWorthQuery(q)) return;
  return cardFromKnow(q, store);
}

/** Packed successor when the hot stale map does not list this RFC. Store only — wrap stays off the pack. */
function successorQueries(text: string, store: KnowSearch, already: string[]): string[] {
  const have = new Set(already.map((q) => q.toLowerCase()));
  const out: string[] = [];
  const re = /\bRFC[\s#:-]*(\d{1,5})\b/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) && n < 4) {
    const num = m[1]!;
    if (isHotStaleRfc(num) || isHotSuccessorRfc(num)) continue;
    n++;
    try {
      const hits = store.search(`RFC ${num}`, 8);
      for (const h of hits) {
        let q = "";
        if (h.p === "is" && new RegExp(`^RFC\\s*${num}$`, "i").test(h.s.trim())) {
          const dest = /(?:obsoleted|updated) by RFC\s*(\d{1,5})/i.exec(h.o);
          if (dest) q = /updated/i.test(h.o) ? `RFC ${dest[1]} updates` : `RFC ${dest[1]} obsoletes`;
        } else if (h.p === "obsoletes" && new RegExp(`RFC\\s*${num}\\b`, "i").test(h.o)) {
          const src = /^RFC\s+(\d{1,5})/i.exec(h.s);
          if (src) q = `RFC ${src[1]} obsoletes`;
        } else if (h.p === "updates" && new RegExp(`RFC\\s*${num}\\b`, "i").test(h.o)) {
          const src = /^RFC\s+(\d{1,5})/i.exec(h.s);
          if (src) q = `RFC ${src[1]} updates`;
        }
        if (q && !have.has(q.toLowerCase()) && !out.some((x) => x.toLowerCase() === q.toLowerCase())) {
          out.push(q);
          break;
        }
      }
    } catch {
      /* fail-open */
    }
  }
  return out;
}

const SUBJECT_ESC = /[.*+?^${}()|[\]\\]/g;

const TOOL_ALIASES: Record<string, string[]> = {
  ripgrep: ["ripgrep", "rg"],
  fd: ["fd", "fdfind", "fd-find"],
  jq: ["jq"],
  uv: ["uv"],
  bun: ["bun", "bunx"],
  cargo: ["cargo"],
};

function boundMention(text: string, token: string): boolean {
  if (!token) return false;
  const pat = token.replace(SUBJECT_ESC, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9.+-])${pat}(?:[^A-Za-z0-9.+-]|$)`, "i").test(text);
}

function rfcRelationQuestion(text: string): boolean {
  return /\b(?:does|did|do|is|was|which|what|has)\b[^?!.]{0,120}\b(?:obsolete|obsoletes|obsoleted|update|updates|updated|successor|replaces|replaced)\b/i.test(
    text,
  );
}

/** True when the card's tool / successor RFC is already in the prompt. */
export function subjectMentioned(text: string, fact: string): boolean {
  const f = fact.trim();
  const used = /^(.+?) is used for /i.exec(f);
  const edge = /^(RFC\s+\d{1,5})\s+(?:obsoletes|updates|is obsoleted by|is updated by)\b/i.exec(f);
  const subject = (used?.[1] || edge?.[1] || "").trim();
  if (!subject || subject.length < 2) return false;
  if (/^RFC\s+\d/i.test(subject)) {
    if (rfcRelationQuestion(text)) return false;
    const n = subject.replace(/^RFC\s+/i, "");
    return new RegExp(`\\brfc[\\s#:-]*${n}\\b`, "i").test(text);
  }
  const key = subject.toLowerCase();
  const aliases = TOOL_ALIASES[key] || [subject];
  for (const a of aliases) {
    if (boundMention(text, a)) return true;
  }
  return false;
}

/**
 * Technique / wrong-way / stale first. Frozen catalog flash never ships.
 * Coverage-over-silence only among *useful* grounded cards.
 * SkipIdent: wrap never scans RFC/IANA/capital needles.
 * Already-known: if the tool or successor RFC is in the prompt, try the next card.
 */
export function injectFromRequest(input: NeedInput, store?: KnowSearch): InjectCard | undefined {
  if (process.env.EDEN_KNOW === "0") return undefined;
  try {
    const text = input.text || "";
    const need = detectNeed(input, { skipIdent: true });
    const queries = store ? [...need.queries, ...successorQueries(text, store, need.queries)] : need.queries;
    const prompt = new Set<string>();
    fillGapToks(text, prompt);
    let best: InjectCard | undefined;
    let bestScore = -1;
    const n = Math.min(queries.length, 8);
    for (let i = 0; i < n; i++) {
      const q = queries[i]!;
      if (!injectWorthQuery(q)) continue;
      const card = factFor(q, store);
      if (!card) continue;
      if (subjectMentioned(text, card.fact)) continue;
      const g = pickScore(card, prompt);
      if (g > bestScore) {
        bestScore = g;
        best = card;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

/** Pull grounded needles from prompt/CoT; return one card or nothing. Fail-open. */
export function injectFromText(text: string, store?: KnowSearch): InjectCard | undefined {
  return injectFromRequest({ text }, store);
}

/** System note the model can cite. Fact sentence stays URL-free; source is a separate field. */
export function injectNote(card: InjectCard): string {
  const fact = card.fact.trim();
  const url = citeableUrl(card.url);
  if (!url) return `${KNOW_INJECT_MARK} ${fact}`;
  const sentence = fact.endsWith(".") ? fact : `${fact}.`;
  return `${KNOW_INJECT_MARK} ${sentence} Source: ${url}`;
}

export function alreadyInjected(blob: string): boolean {
  return blob.includes(KNOW_INJECT_MARK);
}

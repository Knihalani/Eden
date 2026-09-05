import { detectNeed, isHotStaleRfc, isHotSuccessorRfc, hotStaleQuery, type NeedInput } from "./need";
import { citeableUrl, knowQuery } from "./query";

type KnowSearch = {
  search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[];
  close?: () => void;
};

export const KNOW_INJECT_MARK = "Eden Know:";

export function usefulInjectFact(fact: string): boolean {
  const f = fact.trim();
  if (!f) return false;
  if (/ is used for /i.test(f)) return true;
  return /\bRFC\s+\d{1,5}\s+(?:obsoletes|updates|is obsoleted by|is updated by)\s+RFC\s+\d/i.test(f);
}

export function injectWorthQuery(q: string): boolean {
  const ql = q.trim().toLowerCase();
  return ql.startsWith("used for ") || /\bobsolet|\bupdates?\b/.test(ql);
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
  if (store) {
    let m = FACT_MEMO.get(store);
    if (!m) {
      m = new Map();
      FACT_MEMO.set(store, m);
    }
    const k = q.toLowerCase();
    if (m.has(k)) return m.get(k);
    const card = cardFromKnow(q, store);
    m.set(k, card);
    return card;
  }
  return cardFromKnow(q, store);
}

const FACT_MEMO = new WeakMap<object, Map<string, InjectCard | undefined>>();

function rfcCopulaQueries(text: string): string[] {
  const out: string[] = [];
  const re = /\bRFC\s+is\s+(\d{1,5})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const q = hotStaleQuery(m[1]!);
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}

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
      const subj = new RegExp(`^RFC\\s*${num}$`, "i");
      const inObj = new RegExp(`RFC\\s*${num}\\b`, "i");
      for (const h of hits) {
        let q = "";
        if (h.p === "is" && subj.test(h.s.trim())) {
          const dest = /(?:obsoleted|updated) by RFC\s*(\d{1,5})/i.exec(h.o);
          if (dest) q = /updated/i.test(h.o) ? `RFC ${dest[1]} updates` : `RFC ${dest[1]} obsoletes`;
        } else if (h.p === "obsoletes" && inObj.test(h.o)) {
          const src = /^RFC\s+(\d{1,5})/i.exec(h.s);
          if (src) q = `RFC ${src[1]} obsoletes`;
        } else if (h.p === "updates" && inObj.test(h.o)) {
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
  return (TOOL_ALIASES[key] || [subject]).some((a) => boundMention(text, a));
}

export function injectFromRequest(input: NeedInput, store?: KnowSearch): InjectCard | undefined {
  if (process.env.EDEN_KNOW === "0") return undefined;
  try {
    const text = input.text || "";
    const hasRfc = text.indexOf("RFC") >= 0 || text.indexOf("rfc") >= 0;
    const copula = hasRfc ? rfcCopulaQueries(text) : [];
    for (const cq of copula) {
      const card = factFor(cq, store);
      if (card && !subjectMentioned(text, card.fact)) return card;
    }
    const need = detectNeed(input, { skipIdent: true });
    const queries =
      store && hasRfc
        ? [...need.queries, ...successorQueries(text, store, need.queries)]
        : need.queries;
    const n = Math.min(queries.length, 8);
    for (let i = 0; i < n; i++) {
      const q = queries[i]!;
      if (!injectWorthQuery(q)) continue;
      const card = factFor(q, store);
      if (!card) continue;
      if (subjectMentioned(text, card.fact)) continue;
      return card;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function injectFromText(text: string, store?: KnowSearch): InjectCard | undefined {
  return injectFromRequest({ text }, store);
}

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

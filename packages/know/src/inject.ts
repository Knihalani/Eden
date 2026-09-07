import { detectNeed, isHotStaleRfc, isHotSuccessorRfc, hotStaleQuery, type NeedInput } from "./need";
import { citeableUrl, knowQuery } from "./query";

type KnowSearch = {
  search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[];
  close?: () => void;
};

export const KNOW_INJECT_MARK = "Eden Know:";

export function usefulInjectFact(fact: string): boolean {
  return !!fact && (/ is used for /i.test(fact) || (fact.indexOf("RFC") >= 0 && /\bRFC\s+\d{1,5}\s+(?:obsoletes|updates|is obsoleted by|is updated by)\s+RFC\s+\d/i.test(fact)));
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
  if (!store) return cardFromKnow(q, store);
  let m = FACT_MEMO.get(store); if (!m) FACT_MEMO.set(store, m = new Map());
  const k = q.toLowerCase();
  return m.has(k) ? m.get(k) : (m.set(k, cardFromKnow(q, store)), m.get(k));
}

const FACT_MEMO = new WeakMap<object, Map<string, InjectCard | undefined>>();

function successorQueries(text: string, store: KnowSearch, already: string[]): string[] {
  const have = new Set(already.map((q) => q.toLowerCase())), out: string[] = [];
  const re = /\bRFC[\s#:-]*(\d{1,5})\b/gi;
  for (let m, n = 0; (m = re.exec(text)) && n < 4; ) {
    const num = m[1]!;
    if (isHotStaleRfc(num) || isHotSuccessorRfc(num)) continue;
    n++;
    try {
      const hits = store.search(`RFC ${num}`, 3), subj = new RegExp(`^RFC\\s*${num}$`, "i"), inObj = new RegExp(`RFC\\s*${num}\\b`, "i");
      for (const h of hits) {
        let q = "";
        if (h.p === "is" && subj.test(h.s.trim())) { const dest = /(?:obsoleted|updated) by RFC\s*(\d{1,5})/i.exec(h.o); if (dest) q = /updated/i.test(h.o) ? `RFC ${dest[1]} updates` : `RFC ${dest[1]} obsoletes`; }
        else if ((h.p === "obsoletes" || h.p === "updates") && inObj.test(h.o)) { const src = /^RFC\s+(\d{1,5})/i.exec(h.s); if (src) q = `RFC ${src[1]} ${h.p}`; }
        if (q && !have.has(q.toLowerCase()) && !out.some((x) => x.toLowerCase() === q.toLowerCase())) { out.push(q); break; }
      }
    } catch {}
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
  return (text.indexOf("obsolet") >= 0 || text.indexOf("update") >= 0 || text.indexOf("successor") >= 0 || text.indexOf("replac") >= 0) && /\b(?:does|did|do|is|was|which|what|has)\b[^?!.]{0,120}\b(?:obsolete|obsoletes|obsoleted|update|updates|updated|successor|replaces|replaced)\b/i.test(text);
}

export function subjectMentioned(text: string, fact: string): boolean {
  const subject = (/^(.+?) is used for /i.exec(fact)?.[1] || /^(RFC\s+\d{1,5})\s+(?:obsoletes|updates|is obsoleted by|is updated by)\b/i.exec(fact)?.[1] || "").trim();
  if (!subject || subject.length < 2) return false;
  if (/^RFC\s+\d/i.test(subject)) return rfcRelationQuestion(text) ? false : new RegExp(`\\brfc[\\s#:-]*${subject.replace(/^RFC\s+/i, "")}\\b`, "i").test(text);
  return (TOOL_ALIASES[subject.toLowerCase()] || [subject]).some((a) => boundMention(text, a));
}

export function injectFromRequest(input: NeedInput, store?: KnowSearch): InjectCard | undefined {
  if (process.env.EDEN_KNOW === "0") return;
  try {
    const text = input.text || "", hasRfc = /rfc/i.test(text);
    if (hasRfc && text.indexOf(" is ") >= 0) for (let m, re = /\bRFC\s+is\s+(\d{1,5})\b/gi; (m = re.exec(text)); ) {
      const q = hotStaleQuery(m[1]!), card = q ? factFor(q, store) : undefined;
      if (card && !subjectMentioned(text, card.fact)) return card;
    }
    const qs = detectNeed(input, { skipIdent: true }).queries;
    for (const q of (store && hasRfc && /\d/.test(text) ? qs.concat(successorQueries(text, store, qs)) : qs).slice(0, 8)) {
      const card = factFor(q, store);
      if (card && !subjectMentioned(text, card.fact)) return card;
    }
  } catch {}
}

export function injectFromText(text: string, store?: KnowSearch): InjectCard | undefined {
  return injectFromRequest({ text }, store);
}

export function injectNote(card: InjectCard): string {
  const fact = card.fact.trim(), url = citeableUrl(card.url);
  return url ? `${KNOW_INJECT_MARK} ${fact.endsWith(".") ? fact : `${fact}.`} Source: ${url}` : `${KNOW_INJECT_MARK} ${fact}`;
}

export function alreadyInjected(blob: string): boolean {
  return blob.includes(KNOW_INJECT_MARK);
}

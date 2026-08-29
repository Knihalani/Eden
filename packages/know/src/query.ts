import { looksLikeCode, shortTitle } from "./extract";
import { openStore } from "./store";

const STOP = new Set(["the", "of", "is", "a", "an", "on", "to", "and", "in"]);
const MAX_TOKENS = 48;

function toks(s: string): string[] {
  const expanded = s.replace(/\b(rfc)(\d{1,5})\b/gi, "$1 $2").replace(/\b(w3c)([a-z0-9-]+)/gi, "$1 $2");
  return expanded
    .toLowerCase()
    .split(/[^a-z0-9+.-]+/)
    .filter((t) => t.length > 1);
}

function capTokens(s: string, n = MAX_TOKENS): string {
  const parts = s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/);
  if (parts.length <= n) return parts.join(" ");
  return parts.slice(0, n).join(" ");
}

export function formatCard(q: string, hits: { s: string; p: string; o: string; e: string }[]): {
  fact: string;
  as_of?: string;
  ttl_days?: number;
  confidence: number;
} | { unknown: true } {
  const n = hits[0];
  if (!n) return { unknown: true };
  if (looksLikeCode(`${n.o} ${n.e}`) || n.p === "about" || n.p === "date") return { unknown: true };
  let fact = "";
  if (n.p === "capital") fact = `The capital of ${n.s} is ${n.o}.`;
  else if (/^RFC\s+\d/i.test(n.s) && n.p === "is") {
    const title = shortTitle((n.e || n.o).replace(/^RFC\s*\d+\s*[:\-–]\s*/i, ""));
    fact = `${n.s} is ${title}.`;
  }
  else if (/^W3C\s+/i.test(n.s) && n.p === "is") fact = `${n.s} is ${n.o}.`;
  else if (/^(IANA|SPDX|WHATWG|Unicode)\s+/i.test(n.s) && n.p === "is") fact = `${n.s} is ${n.o}.`;
  else if (n.p === "obsoletes") fact = `${n.s} obsoletes ${n.o}.`;
  else if (n.p === "updates") fact = `${n.s} updates ${n.o}.`;
  else if (n.p === "is") fact = `The ${n.s} is ${n.o}.`;
  else fact = capTokens(`${n.s} ${n.p} ${n.o}`, 32);
  fact = capTokens(fact, MAX_TOKENS);
  const blob = `${n.s} ${n.p} ${n.o} ${n.e}`.toLowerCase();
  const qtoks = toks(q).filter((t) => !STOP.has(t));
  const queryHit = !qtoks.length || qtoks.every((t) => blob.includes(t));
  const grounded = toks(fact)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1)
    .every((t) => STOP.has(t) || blob.includes(t));
  if (!grounded || !queryHit || !fact.trim()) return { unknown: true };
  const typed = n.p === "capital" || n.p === "is" || n.p === "obsoletes" || n.p === "updates";
  return { fact, confidence: typed ? 0.6 : 0.5 };
}

export function knowQuery(q: string) {
  const store = openStore();
  try {
    let hits = store.search(q, 8).filter((h) => h.p !== "about" && h.p !== "date" && !looksLikeCode(`${h.o} ${h.e}`));
    if (/\b(obsoletes|updates)\b/i.test(q)) {
      const want = /\bupdates\b/i.test(q) ? "updates" : "obsoletes";
      const edge = hits.find((h) => h.p === want);
      if (edge) hits = [edge, ...hits.filter((h) => h !== edge)];
    }
    return formatCard(q, hits);
  } finally {
    store.close();
  }
}

export { MAX_TOKENS };

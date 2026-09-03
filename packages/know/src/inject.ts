import { firstRfcNeedle } from "./rfc-needle";
import { rfcTitleHot } from "./rfc-hot";
import { needleLane, needleRank, needlesFromText } from "./needles";
import { flashCard, knowQuery } from "./query";

type KnowSearch = {
  search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[];
  close?: () => void;
};

export const KNOW_INJECT_MARK = "Eden Know:";

const HOT_CARD = new Map<number, { fact: string }>();
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

function factFor(q: string, store?: KnowSearch): string | undefined {
  const flash = flashCard(q);
  if (flash?.fact) return flash.fact;
  if (needleLane(q) === "token") return;
  const card = knowQuery(q, store);
  if ("fact" in card && card.fact) return card.fact;
}

/**
 * Ranked needles. Flash typed catalogs first so wrap never inflates the pack
 * on GET/json/404/UTF-8/MIT/TCP/https/AAAA/Accept/Kenya. Cold RFC still one
 * pack lookup. Never skip a higher-rank pack hit for a later flash.
 * Equal rank only: pick the card with more tokens not already in the prompt.
 */
function restInject(text: string, store?: KnowSearch): { fact: string } | undefined {
  const qs = needlesFromText(text);
  const n = qs.length;
  if (!n) return;
  let i = 0;
  while (i < n) {
    const r = needleRank(qs[i]!);
    let j = i + 1;
    while (j < n && needleRank(qs[j]!) === r) j++;
    if (j === i + 1) {
      const fact = factFor(qs[i]!, store);
      if (fact) return { fact };
      i = j;
      continue;
    }
    let best: string | undefined;
    let bestGap = -1;
    let prompt: Set<string> | undefined;
    for (let k = i; k < j; k++) {
      const fact = factFor(qs[k]!, store);
      if (!fact) continue;
      if (!prompt) {
        prompt = new Set();
        fillGapToks(text, prompt);
      }
      const g = infoGap(fact, prompt);
      if (g > bestGap) {
        bestGap = g;
        best = fact;
      }
    }
    if (best) return { fact: best };
    i = j;
  }
}

/** Pull grounded needles from prompt/CoT; return one card or nothing. Fail-open. */
export function injectFromText(text: string, store?: KnowSearch): { fact: string } | undefined {
  if (process.env.EDEN_KNOW === "0") return undefined;
  try {
    const rfc = firstRfcNeedle(text);
    if (rfc) {
      const n = +rfc.slice(4);
      const title = rfcTitleHot(n);
      if (title) {
        let card = HOT_CARD.get(n);
        if (!card) {
          card = { fact: `RFC ${n} is ${title}.` };
          HOT_CARD.set(n, card);
        }
        return card;
      }
    }
    return restInject(text, store);
  } catch {
    return undefined;
  }
}

export function alreadyInjected(blob: string): boolean {
  return blob.includes(KNOW_INJECT_MARK);
}

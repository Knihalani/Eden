/**
 * Did the agent use what it was given? Inferred, without a model, from what it does next: an injection counts as
 * used when a later agent message or tool call repeats its distinctive tokens (tokens the session had not seen
 * before the injection, such as a name, a number or an id from the cited item). Coarse, but free, and it is what
 * the source map learns from. Integrations that know better report explicit feedback instead.
 */
import { contentTerms } from "./text";

export interface Outstanding {
  injectionId: string;
  sourceIds: string[];
  situation: string;
  tokens: Set<string>;
  deliveredTurn: number;
}

/** Tokens of the injected text the session had not seen: the evidence a later turn used it. */
export function distinctiveTokens(injected: string, seen: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of contentTerms(injected)) {
    if (seen.has(t)) continue;
    if (t.length >= 4 || /\d/.test(t)) out.add(t);
  }
  return out;
}

/** True when `text` repeats at least two distinctive tokens, or one that holds a digit (a date, an amount, an id). */
export function showsUse(text: string, tokens: Set<string>): boolean {
  let hits = 0;
  for (const t of new Set(contentTerms(text))) {
    if (!tokens.has(t)) continue;
    if (/\d/.test(t)) return true;
    if (++hits >= 2) return true;
  }
  return false;
}

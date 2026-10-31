/**
 * Did the agent use what it was given? Inferred, without a model, from what it does next: an injection counts as
 * used when a later agent message or tool call repeats its distinctive terms (terms the session had not seen before
 * the injection, such as a name, a number or an id from the cited item). Coarse, but free, and it is what the source
 * map learns from. Integrations that know better report explicit feedback instead.
 *
 * Terms are ids in the session's vocabulary (`@eden/primitives` Vocab): no strings are built per event.
 */
import type { Vocab } from "@eden/primitives";
import { isStopword } from "./text";

export interface Outstanding {
  injectionId: string;
  sourceIds: string[];
  situation: string;
  tokens: Set<number>;
  deliveredTurn: number;
  /** Edge types (`kg.ts` `EDGE`) the knowledge graph reached the injection's items by; 0 when it reached none. */
  graphMask?: number;
}

const hasDigit = (t: string) => /\d/.test(t);

/** Terms of the injected text (`ids[0..n)`) the session had not seen: the evidence a later turn used it. */
export function distinctiveTokens(ids: Uint32Array, n: number, seen: Set<number>, vocab: Vocab): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < n; i++) {
    const id = ids[i]!;
    if (seen.has(id) || out.has(id)) continue;
    const t = vocab.term(id);
    if (isStopword(t)) continue;
    if (t.length >= 4 || hasDigit(t)) out.add(id);
  }
  return out;
}

/**
 * True when the text's distinct term ids (`distinctTermIds`) repeat at least two distinctive terms, or one long
 * term that holds a digit (a date, an amount with its unit, an id). Short numbers ("30", "12") are too common to
 * count alone.
 */
export function showsUse(ids: ArrayLike<number>, tokens: Set<number>, vocab: Vocab): boolean {
  if (tokens.size === 0) return false;
  let hits = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (!tokens.has(id)) continue;
    const t = vocab.term(id);
    if (hasDigit(t) && t.length >= 4) return true;
    if (++hits >= 2) return true;
  }
  return false;
}

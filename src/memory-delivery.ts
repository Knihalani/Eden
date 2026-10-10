/**
 * A4 §5.1's steps between retrieval and the packet's shape, shared by every point that answers a prompt: the memory
 * hook's Submit and the wrap's turn (D29, `memory-wrap.ts`).
 * - **Validity** (step 5): each note without the sentences an invalidation has made invalid.
 * - **The gate** (step 6, A7 §4): an episode the user did not type needs evidence from the cue's parts.
 * - **Novelty** (step 7): what the last turns already say (D26's residual), then what the window was already given.
 *   The second is the caller's: the hook reads its window's ledger, the wrap the packets still in its request.
 *
 * The shape and wording (step 8) are `memory-hook-packet.ts`'s.
 */
import type { MemoryRecord } from "./index";
import { admitNotes, type CueParts } from "./memory-gate";
import { noteKindToken } from "./memory-provenance";
import { isResidualNote, residualSentences } from "./memory-residual";
import { asksHistory, isForget, validText, type Invalidation } from "./memory-validity";

const INTENTION_TAG = /^(?:intention|intent|rule|constraint|never|always|must|prefer)$/i;

/** A rule the user pinned: a constraint row, or one tagged as a pin or an intention. */
export function isPinnedIntention(r: MemoryRecord): boolean {
  return r.kind === "constraint" || (r.tags ?? []).some((t) => t.toLowerCase() === "pin" || INTENTION_TAG.test(t));
}

/**
 * Step 5: each note without the sentences an invalidation has made invalid; a note left empty is dropped. A rule
 * sentence yields only to a revocation (`validText`). When the cue asks about history, episodes keep what they say
 * (D31 `stale_for`), except what the user asked to forget (A6 §3); facts and rules do not.
 */
export function stillValid(notes: MemoryRecord[], invalid: readonly Invalidation[], prompt: string): MemoryRecord[] {
  if (!invalid.length) return notes;
  const history = asksHistory(prompt);
  return notes.flatMap((note) => {
    const kind = noteKindToken(note);
    const episode = kind !== "rule" && kind !== "fact" && !isPinnedIntention(note);
    const text = validText(note.text, note.at, history && episode ? invalid.filter(isForget) : invalid);
    return text ? [{ ...note, text }] : [];
  });
}

/** What a prompt's answer is read against: the prompt, the cue's parts, the residual and the invalidations. */
export interface DeliveryCue {
  prompt: string;
  parts: CueParts;
  /** D26's residual texts: the prompt, the last 2 typed prompts and the assistant text between them. */
  residual: readonly string[];
  invalid: readonly Invalidation[];
}

/** How many notes each step dropped, in the order the steps run. */
export interface DeliveryDrops {
  validity: number;
  gate: number;
  residual: number;
  refractory: number;
}

/** Steps 5–7 on the retrieved notes (see the header); `refractory` keeps the notes the window may be given again. */
export function selectNotes(
  notes: MemoryRecord[],
  cue: DeliveryCue,
  refractory: (notes: MemoryRecord[]) => MemoryRecord[],
): { notes: MemoryRecord[]; drops: DeliveryDrops } {
  const valid = stillValid(notes, cue.invalid, cue.prompt);
  const admitted = admitNotes(valid, cue.parts);
  const residual = residualSentences(cue.residual);
  const fresh = admitted.filter((note) => !isResidualNote(note, residual));
  const novel = refractory(fresh);
  return {
    notes: novel,
    drops: {
      validity: notes.length - valid.length,
      gate: valid.length - admitted.length,
      residual: admitted.length - fresh.length,
      refractory: fresh.length - novel.length,
    },
  };
}

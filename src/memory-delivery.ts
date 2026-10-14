/**
 * A4 §5.1's steps between retrieval and the packet's shape, shared by every point that answers a prompt: the memory
 * hook's Submit and the wrap's turn (D29, `memory-wrap.ts`).
 * - **Validity** (step 5): each note without the sentences an invalidation has made invalid.
 * - **The gate** (step 6, A7 §4): an episode the user did not type needs evidence from the cue's parts.
 * - **Novelty** (step 7): what the last turns already say (D26's residual) and what the window's instruction files
 *   state (D27's shadow set, `memory-shadow.ts`, which drops the sentences it states: `unsaidText`), then what the
 *   window was already given. The last is the caller's: the hook reads its window's ledger, the wrap the packets still
 *   in its request.
 *
 * The shape and wording (step 8) are `memory-hook-packet.ts`'s.
 */
import type { MemoryRecord } from "./index";
import { admitNotes, type CueParts } from "./memory-gate";
import { noteKindToken, type ProvenanceNote } from "./memory-provenance";
import { isResidualNote, residualSentences, unsaidText, type Said } from "./memory-residual";
import { asksHistory, isForget, validText, withoutExpiredIntents, type Invalidation } from "./memory-validity";

const INTENTION_TAG = /^(?:intention|intent|rule|constraint|never|always|must|prefer)$/i;

/** A rule the user pinned: a constraint row, or one tagged as a pin or an intention. */
export function isPinnedIntention(r: MemoryRecord): boolean {
  return r.kind === "constraint" || (r.tags ?? []).some((t) => t.toLowerCase() === "pin" || INTENTION_TAG.test(t));
}

/**
 * Step 5: each note without the sentences an invalidation has made invalid, and without its intents' clauses once
 * they expired (`withoutExpiredIntents`); a note left empty is dropped. A rule sentence yields only to a revocation
 * or an opposition. When the cue asks about history, episodes keep what they say (D31 `stale_for`), except what the
 * user asked to forget (A6 §3); facts and rules do not.
 */
export function stillValid(
  notes: MemoryRecord[],
  invalid: readonly Invalidation[],
  prompt: string,
  readSet: readonly string[] = [],
  catalog?: readonly string[],
): MemoryRecord[] {
  const history = asksHistory(prompt);
  return notes.flatMap((note) => {
    const kind = noteKindToken(note);
    const episode = kind !== "rule" && kind !== "fact" && !isPinnedIntention(note);
    const said = withoutExpiredIntents(note.text, note.at);
    const records = history && episode ? invalid.filter(isForget) : invalid;
    const text = validText(said, note.at, records, note.scope, readSet, catalog);
    return text ? [{ ...note, text }] : [];
  });
}

/** What a prompt's answer is read against: the prompt, the cue's parts, the residual and the invalidations. */
export interface DeliveryCue {
  prompt: string;
  parts: CueParts;
  /** D26's residual texts: the prompt, the last 2 typed prompts and the assistant text between them. */
  residual: readonly string[];
  /** D27's shadow set: the sentences of the instruction files in the window (none for a caller without one). */
  shadow?: readonly Said[];
  invalid: readonly Invalidation[];
  /** The folders the prompt is read at (A4 §2's read set), when the caller knows its place. */
  readSet?: readonly string[];
  /** The repo's scope catalog (D3), when the caller has one: it tells a clause's own folder (`validText`). */
  catalog?: readonly string[];
}

/** How many notes each step dropped, in the order the steps run. */
export interface DeliveryDrops {
  validity: number;
  gate: number;
  residual: number;
  shadow: number;
  refractory: number;
}

/** The notes with what the window already states left out (`unsaidText`); a note it states in full is dropped. */
export function unsaidNotes<T extends ProvenanceNote>(notes: readonly T[], said: readonly Said[]): T[] {
  return notes.flatMap((note) => {
    const text = unsaidText(note, said);
    if (text === note.text) return [note];
    return text ? [{ ...note, text }] : [];
  });
}

/** Steps 5–7 on the retrieved notes (see the header); `refractory` keeps the notes the window may be given again. */
export function selectNotes(
  notes: MemoryRecord[],
  cue: DeliveryCue,
  refractory: (notes: MemoryRecord[]) => MemoryRecord[],
): { notes: MemoryRecord[]; drops: DeliveryDrops } {
  const valid = stillValid(notes, cue.invalid, cue.prompt, cue.readSet, cue.catalog);
  const admitted = admitNotes(valid, cue.parts);
  const residual = residualSentences(cue.residual);
  const said = admitted.filter((note) => !isResidualNote(note, residual));
  const fresh = unsaidNotes(said, cue.shadow ?? []);
  const novel = refractory(fresh);
  return {
    notes: novel,
    drops: {
      validity: notes.length - valid.length,
      gate: valid.length - admitted.length,
      residual: admitted.length - said.length,
      shadow: said.length - fresh.length,
      refractory: fresh.length - novel.length,
    },
  };
}

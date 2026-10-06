/**
 * A7 §4's admission of an episode, as far as P0.2 can tell one: a row whose source shows the user did not type it
 * (`src:tool`, `src:assistant`) is an episode (A4 §3.0, "everything else, including assistant, tool and paste text"),
 * delivered "lexically, only with MEDIUM+ evidence" (A4 §3.1). A7 §4 admits it on one STRONG match, or on MEDIUM
 * evidence from at least two different cue parts:
 * - **STRONG**: an identifier-shaped token it shares with the prompt: a path, a filename with an extension (or a
 *   dotted name, `vitest.config`), an `ERR_*` or `E123` code, a CLI flag, a version string, an id mixing letters and
 *   digits, a symbol with an inner capital or underscore.
 * - **MEDIUM**: a content word it shares with a cue part. The parts available before P4.1's situation cue are the
 *   prompt, the previous typed prompt (`q_turn`) and the agent's last message (`q_prev`); a common word is WEAK and
 *   never counts.
 *
 * BM25F and τ_repo, which A7 also asks of an episode, arrive with P4.2 and P4.3. Rows the user typed, rows of
 * unknown source and gists keep today's lexical admission.
 */
import type { ProvenanceNote } from "./memory-provenance";
import { stripPacketLabel } from "./memory-provenance";

const IDENTIFIER_SHAPES = [
  /^[\w@.-]*\/[\w@./-]*\w$/, // a path: apps/web, ./src/auth.ts
  /^[\w-]{2,}(?:\.[\w-]+)*\.[a-z][a-z0-9]{0,4}$/i, // a filename with an extension: vitest.config.ts, not "e.g"
  /^[a-z_][\w-]+(?:\.[a-z_][\w-]+)+$/i, // a dotted name: vitest.config, fly.io
  /^(?:ERR_[A-Z0-9_]+|E\d{2,})$/, // an error code
  /^--?[a-z][\w-]*$/i, // a CLI flag
  /^v?\d+(?:\.\d+)+$/i, // a version
  /^(?=[\w-]*[a-z])(?=[\w-]*\d)[a-z][\w-]*$/i, // an id mixing letters and digits: c0042, p0b-canary
  /^[a-z]+[A-Z]\w*$|^[A-Z][a-z]+[A-Z]\w*$/, // a symbol with an inner capital: getUser, ClerkProvider
  /^[a-z]\w*_\w+$/i, // a symbol with an underscore: user_id
];

/** Function words: WEAK evidence, which never admits (A7 §4). P4.3 replaces this list with the repo's df. */
const COMMON = new Set(
  (
    "the and for with that this from have has had was were are not but you your our their its can will would " +
    "should could into about there here what which when where why how all any some more most other such than " +
    "then them they these those very just also only"
  ).split(" "),
);

/** Strips what never belongs to an identifier: quotes, brackets and sentence punctuation around it. */
function bare(token: string): string {
  return token.replace(/^[`'"([{<]+/, "").replace(/[`'")\]}>,;:!?.]+$/, "");
}

/** The identifier-shaped tokens of a text, lowercased (`vitest.config.ts` also yields `vitest.config`). */
export function identifierTokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const raw of String(text ?? "").split(/\s+/)) {
    const token = bare(raw);
    if (token.length < 2 || !IDENTIFIER_SHAPES.some((shape) => shape.test(token))) continue;
    const lower = token.toLowerCase().replace(/^\.\//, "");
    found.add(lower);
    const stem = /^(.+\.[\w-]+)\.[a-z][a-z0-9]{0,4}$/i.exec(lower)?.[1];
    if (stem) found.add(stem);
  }
  return found;
}

function contentWords(text: string): Set<string> {
  return new Set(
    (
      String(text ?? "")
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? []
    ).filter((w) => w.length >= 3 && !COMMON.has(w)),
  );
}

function shares(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/** Whether a row's source shows the user did not type it: an episode by A4 §3.0. */
export function isUntyped(note: ProvenanceNote): boolean {
  return (note.tags ?? []).some((tag) => tag === "src:tool" || tag === "src:assistant");
}

/** The cue parts P0.2 has: the prompt, the previous typed prompt and the agent's last message. */
export interface CueParts {
  prompt: string;
  turn?: string;
  prev?: string;
}

/** Whether A7 §4 admits an episode on this cue (see the header). */
export function admitsEpisode(note: ProvenanceNote, cue: CueParts): boolean {
  const body = stripPacketLabel(String(note.text ?? "")).body;
  const ids = identifierTokens(cue.prompt);
  if (ids.size && shares(identifierTokens(body), ids)) return true;
  const words = contentWords(body);
  const parts = [cue.prompt, cue.turn ?? "", cue.prev ?? ""].filter((part) => shares(words, contentWords(part)));
  return parts.length >= 2;
}

/** The notes the gate admits, in their order: an untyped row only on A7 §4's evidence, every other row as today. */
export function admitNotes<T extends ProvenanceNote>(notes: readonly T[], cue: CueParts): T[] {
  return notes.filter((note) => !isUntyped(note) || admitsEpisode(note, cue));
}

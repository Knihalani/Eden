/**
 * A7 §4's admission of an episode, as far as the lexical path can tell one: a row whose source shows the user did not
 * type it (`src:tool`, `src:agent`) is an episode (A4 §3.0, "everything else, including assistant, tool and paste
 * text"), delivered "lexically, only with MEDIUM+ evidence" (A4 §3.1). A7 §4 admits it on one STRONG match, or on
 * MEDIUM evidence from at least two different cue parts:
 * - **STRONG**: an identifier-shaped token it shares with the prompt, or, on a continuation, with the agent's last
 *   message (A7 §2): a path, a filename with an extension (or a dotted name, `vitest.config`), an `ERR_*` or `E123`
 *   code, a CLI flag, a version string, an id mixing letters and digits, a symbol with an inner capital or underscore.
 * - **MEDIUM**: a content word it shares with a cue part: the prompt, the previous typed prompt (`q_turn`), the paths
 *   just touched (`q_path`) and the agent's last message without Eden's own words (`q_prev`, P4.1's situation cue,
 *   `memory-cue.ts`). A function word is WEAK and never counts.
 *
 * The lexical path ranks by BM25F since P4.2; τ_repo, which A7 also asks of an episode, is P4.3's. Rows the user
 * typed, rows mined from the repo's files (D8), rows of unknown source and gists keep today's lexical admission.
 */
import { isCited, isUntyped, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { contentWords as words } from "./memory-transcript";

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

/**
 * Whether two sets of identifier-shaped tokens share one (A7 §4's STRONG match): the same token, or a bare filename
 * and a path ending in it (`middleware.ts`, `apps/web/middleware.ts`). Two paths match only whole: `server.ts` of one
 * package is not another's.
 */
export function sharesIdentifier(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const ends = (path: string, name: string) => !name.includes("/") && path.endsWith(`/${name}`);
  for (const x of a) if (b.has(x)) return true;
  for (const x of a) for (const y of b) if (ends(x, y) || ends(y, x)) return true;
  return false;
}

/** A7 §4's MEDIUM words: content words of three letters or more (a function word is WEAK, never evidence). */
function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((word) => word.length >= 3));
}

function shares(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/**
 * The cue parts the gate reads: the prompt, the previous typed prompt, the paths just touched and the agent's last
 * message, as text; and, on a continuation, the identifier forms of the agent's last message that are STRONG.
 */
export interface CueParts {
  prompt: string;
  turn?: string;
  path?: string;
  prev?: string;
  strong?: ReadonlySet<string>;
}

/** Whether A7 §4 admits an episode on this cue (see the header). */
export function admitsEpisode(note: ProvenanceNote, cue: CueParts): boolean {
  const body = stripPacketLabel(String(note.text ?? "")).body;
  const own = identifierTokens(body);
  if (sharesIdentifier(own, identifierTokens(cue.prompt)) || (cue.strong && sharesIdentifier(own, cue.strong)))
    return true;
  const words = contentWords(body);
  const parts = [cue.prompt, cue.turn, cue.path, cue.prev].filter((part) => part && shares(words, contentWords(part)));
  return parts.length >= 2;
}

/**
 * The notes the gate admits, in their order: an untyped row only on A7 §4's evidence, every other row as today. A
 * row mined from the repo's files (D8) is a slot fact, not an episode (A4 §3.1): it is admitted as a typed one is.
 */
export function admitNotes<T extends ProvenanceNote>(notes: readonly T[], cue: CueParts): T[] {
  return notes.filter((note) => !isUntyped(note) || isCited(note) || admitsEpisode(note, cue));
}

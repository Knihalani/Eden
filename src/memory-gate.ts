/**
 * A7 §4's admission of an episode (`isEpisode`): a row whose source shows the user did not type it (`src:tool`,
 * `src:agent`; A4 §3.0, "everything else, including assistant, tool and paste text"), or a request the user typed,
 * delivered "lexically, only with MEDIUM+ evidence" (A4 §3.1). A7 §4 admits it on one STRONG match, or on MEDIUM
 * evidence from at least two different cue parts:
 * - **STRONG**: an identifier-shaped token it shares with the prompt, or, on a continuation, with the agent's last
 *   message (A7 §2): a path, a filename with an extension (or a dotted name, `vitest.config`), an `ERR_*` or `E123`
 *   code, a CLI flag, a version string, an id mixing letters and digits, a symbol with an inner capital or underscore.
 *   With P4.3's gate on, a name that starts with a capital and has an inner one ("TypeScript", "GitHub", "BullMQ") or
 *   a product named like a script ("Next.js") is a word, not an identifier (`identifierTokens`' `strict`).
 * - **MEDIUM**: a content word it shares with a cue part: the prompt, the previous typed prompt (`q_turn`), the paths
 *   just touched (`q_path`) and the agent's last message without Eden's own words (`q_prev`, P4.1's situation cue,
 *   `memory-cue.ts`). A function word is WEAK and never counts.
 *
 * The lexical path (`AgentMemory.relevant`) also asks an episode for τ_repo (P4.3), and applies A7 §4 to every row
 * there; this check is the delivery's (A4 §5.1 step 6), for the rows every lane gives. Rows the user typed that state
 * something, rows mined from the repo's files (D8), rows of unknown source and gists pass it.
 */
import { isCited, isUntyped, noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { contentWords as words } from "./memory-transcript";

const IDENTIFIER_SHAPES = [
  /^[\w@.-]*\/[\w@./-]*\w$/, // a path: apps/web, ./src/auth.ts
  /^[\w-]{2,}(?:\.[\w-]+)*\.[a-z][a-z0-9]{0,4}$/i, // a filename with an extension: vitest.config.ts, not "e.g"
  /^[a-z_][\w-]+(?:\.[a-z_][\w-]+)+$/i, // a dotted name: vitest.config, fly.io
  /^(?:ERR_[A-Z0-9_]+|E\d{2,})$/, // an error code
  /^--?[a-z][\w-]*$/i, // a CLI flag
  /^v?\d+(?:\.\d+)+$/i, // a version
  /^(?=[\w-]*[a-z])(?=[\w-]*\d)[a-z][\w-]*$/i, // an id mixing letters and digits: c0042, p0b-canary
  /^[a-z]+[A-Z]\w*$/, // a camelCase symbol: getUser, noUncheckedIndexedAccess
  /^[a-z]\w*_\w+$/i, // a symbol with an underscore: user_id
];
/**
 * A name that starts with a capital and has an inner one: a class (`ClerkProvider`) as often as a product named in prose
 * ("TypeScript", "GitHub", "BullMQ"). Before P4.3's gate it is an identifier; the gate reads it as a word (`strict`).
 */
const CAPITALIZED_SYMBOL = /^[A-Z][a-z]+[A-Z]\w*$/;
/** A product named like a script ("Next.js", "Node.js"), a word to the gate; a file is lowercase (`next.config.js`). */
const PRODUCT_SCRIPT = /^[A-Z][a-zA-Z]*\.js$/;

/** Strips what never belongs to an identifier: quotes, brackets and sentence punctuation around it. */
function bare(token: string): string {
  return token.replace(/^[`'"([{<]+/, "").replace(/[`'")\]}>,;:!?.]+$/, "");
}

/**
 * The identifier-shaped tokens of a text, lowercased (`vitest.config.ts` also yields `vitest.config`). `strict` (P4.3's
 * gate, A7 §4): a capitalized name with an inner capital and a product named like a script are words, not identifiers.
 * R8's 98 silence-set negatives fired on "TypeScript", "GitHub", "BullMQ" and "Next.js" as STRONG matches.
 */
export function identifierTokens(text: string, strict = false): Set<string> {
  const found = new Set<string>();
  for (const raw of String(text ?? "").split(/\s+/)) {
    const token = bare(raw);
    if (token.length < 2 || (strict && PRODUCT_SCRIPT.test(token))) continue;
    const shaped = IDENTIFIER_SHAPES.some((shape) => shape.test(token));
    if (!shaped && (strict || !CAPITALIZED_SYMBOL.test(token))) continue;
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
  /**
   * Whether P4.3's gate is on (`gate.tau`): a typed request is then an episode (`isEpisode`), and identifiers are read
   * strictly (`identifierTokens`).
   */
  gate?: boolean;
}

/** Whether A7 §4 admits an episode on this cue (see the header). */
export function admitsEpisode(note: ProvenanceNote, cue: CueParts): boolean {
  const body = stripPacketLabel(String(note.text ?? "")).body;
  const own = identifierTokens(body, cue.gate);
  if (
    sharesIdentifier(own, identifierTokens(cue.prompt, cue.gate)) ||
    (cue.strong && sharesIdentifier(own, cue.strong))
  )
    return true;
  const words = contentWords(body);
  const parts = [cue.prompt, cue.turn, cue.path, cue.prev].filter((part) => part && shares(words, contentWords(part)));
  return parts.length >= 2;
}

/**
 * A request's opening: a request verb, after a few discourse words, then a space ("Now add a logout button …", "please
 * fix the build", "update deps", "Reply with just OK"). The verbs leave out those that often open a statement as a
 * noun ("List endpoints use cursor pagination") or a standing rule ("Make sure …", "Keep diffs small").
 */
const REQUEST = new RegExp(
  String.raw`^\s*(?:(?:now|then|ok|okay|also|next|please|so|and|first)[,!.]?\s+)*(?:let'?s|add|fix|create|write|` +
    String.raw`update|remove|delete|rename|move|refactor|implement|try|explain|find|open|close|help|clean|debug|` +
    String.raw`investigate|dig|research|reply|tell|give|go|continue|show|look|review)\s`,
  "i",
);
/**
 * A verb that states what is after a request's opening: the opening's verb was a noun ("Help text for the CLI lives in
 * …", "Fix versions in Jira map to …", "Review apps deploy to …"), so the row is a statement.
 */
const STATED =
  /\b(?:is|are|was|were|lives|live|uses|runs|goes|go|maps|map|deploys|deploy|points|holds|has|have|means|sits|stays)\b/i;

/** Whether a row's text is a request the user typed (see `REQUEST`, `STATED`). */
function isRequest(body: string): boolean {
  const opening = REQUEST.exec(body);
  return !!opening && !STATED.test(body.slice(opening[0].length));
}

/**
 * An episode as A7 §4's gate reads it: a row the user did not type (D17 as built in P0.2; a mined slot fact is not
 * one), or, with `requests` (the gate on, `gate.tau`), a request the user typed, stored as an episode: it states what
 * they asked for, not what is true (A4 §3.0; P0.2's one-off imperatives, "Reply with just OK"). A statement the user
 * typed ("The billing service runs on port 8080") is admitted as a fact is, on τ_repo.
 */
export function isEpisode(note: ProvenanceNote, requests = true): boolean {
  if (isUntyped(note)) return !isCited(note);
  return requests && noteKindToken(note) === "episode" && isRequest(stripPacketLabel(String(note.text ?? "")).body);
}

/** The notes the gate admits, in their order: an episode (`isEpisode`) only on A7 §4's evidence, every other row. */
export function admitNotes<T extends ProvenanceNote>(notes: readonly T[], cue: CueParts): T[] {
  return notes.filter((note) => !isEpisode(note, cue.gate ?? false) || admitsEpisode(note, cue));
}

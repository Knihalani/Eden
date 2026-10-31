/**
 * The "user is typing" lead-in the anticipation experiments give a request (docs/research/moon-anticipate.md). Neither
 * the hidden-context suites nor the generated sessions carry what a user typed before sending, so a draft is made
 * from the request itself. A simulation assumption, labelled as such in every report:
 *
 * - "clause": the request's first clause (to its first comma, semicolon, sentence end or dash, or its first "and",
 *   "but" or "so"): what a chat box holds a moment before a one-clause request is sent, and most of one that has more;
 * - "half": its first half, by words, a harsher one: the user is mid-sentence and the names at its end are not typed.
 *
 * Linear: one bounded scan with a fixed alternation, no nested quantifiers.
 */
export type DraftMode = "clause" | "half";

/** Characters of a request read for its draft. */
const DRAFT_CHARS = 2_000;
/** A clause ends at punctuation followed by a space (or the end), or before a joining word. */
const CLAUSE_END = /[,;.?!—–](?=\s|$)|\s(?:and|but|so)\s/i;

export function draftOf(text: string, mode: DraftMode): string {
  const t = text.slice(0, DRAFT_CHARS).trim();
  if (mode === "half") {
    const words = t.split(/\s+/);
    return words.slice(0, Math.ceil(words.length / 2)).join(" ");
  }
  const m = CLAUSE_END.exec(t);
  return (m ? t.slice(0, m.index) : t).trim();
}

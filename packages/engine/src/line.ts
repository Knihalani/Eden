/**
 * The one line sanitiser (D221). Source text and event text are untrusted (D11, D19): put on a line of a packet, an
 * ask answer or a model prompt, a line break in it starts a line of its own, which can pose as another item, another
 * source or another candidate; a tag in it can close the envelope or fence it sits in. The forged-line bug appeared
 * in three places on its own (render.ts's packet, the MCP answer's Sources block, the judge's prompt), so every such
 * line goes through here and the rules live in one place.
 */

/**
 * Removed outright: C0 and C1 control characters other than the whitespace ones (a terminal escape, a NUL; Python's
 * `splitlines` also breaks on U+001C–U+001E), and the bidi embeddings, overrides and isolates, which reorder what a
 * person reading the line sees without changing what a model reads, with the direction marks (U+061C, U+200E,
 * U+200F); and the Unicode tag characters (U+E0000-U+E007F), invisible to a person but read by a model, a known way
 * to hide instructions. Zero-width joiners stay (emoji need them; a split tag is escaped anyway). NEL (U+0085) is a
 * line break, handled below.
 */
const CONTROLS =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;
/**
 * Whitespace runs, line breaks included. `\s` covers LF, CR, VT, FF, U+2028 and U+2029 but not NEL (U+0085), which
 * some readers treat as a line break.
 */
const SPACES = /[\s\u0085]+/g;
/** Every line break a reader may honour, CRLF first so it becomes one LF, not two. */
const BREAKS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g;
/**
 * A tag opener: `<`, and the full-width and small look-alikes a model reads as one. `&lt;` keeps the text readable;
 * nothing in it can open or close the `<context>` envelope or a prompt's fence. A superset of render.ts's
 * `inert`, which escapes only ASCII `<`.
 */
const OPENERS = /[<\uFF1C\uFE64]/g;

/**
 * `text` made safe as part of one line: no line break of any kind, no control or bidi character, no tag opener,
 * whitespace collapsed and the ends trimmed. Idempotent. Callers clip before calling it, not after, so a clip cannot
 * cut an escape in half.
 */
export function safeLine(text: string): string {
  return text.replace(CONTROLS, "").replace(SPACES, " ").replace(OPENERS, "&lt;").trim();
}

/**
 * `text` made safe as a fenced block of lines (a conversation window, an answer's body): the same rules as
 * `safeLine`, but its lines are kept, every kind of break written as one LF, so a reader that splits only on LF and
 * one that also splits on U+2028 or NEL count the same lines.
 */
export function safeBlock(text: string): string {
  return text.replace(CONTROLS, "").replace(BREAKS, "\n").replace(OPENERS, "&lt;");
}

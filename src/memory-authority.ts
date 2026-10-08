/**
 * D12 (A6 §2.1): authority by entry type, with pasted spans stripped.
 *
 * `userTyped` gives the text of a Claude Code transcript entry that carries the user's authority (`src=user`):
 * a `type=user` line that is not meta, a compaction summary, a tool result, a subagent's (sidechain) line, a
 * non-human origin (task notification, peer) or a system-sourced line, and whose text is not one of Claude Code's
 * wrappers; or a queued prompt. The origin and source checks are R6 §1.2's definition of a human prompt; the
 * wrapper list is D12's. `stripPastes` removes, in order:
 * 1. spans between `<pasted_content id=…>` and the `</pasted_content id=…>` with the same id (to the end when
 *    unclosed);
 * 2. fenced code (to the end when unclosed);
 * 3. `>` quotes;
 * 4. every span of ≥ 200 characters that the prompt shares with a recent tool result (A6: the last 10 tool calls),
 *    wherever it sits: a whole paste, or part of a line or paragraph wrapped in the user's own words;
 * 5. runs of ≥ 3 lines without sentence-final punctuation (log lines, stack traces, lists of fragments).
 *
 * `splitPastes` also returns what it removed: those spans are `src=paste` episodes. `authoredTexts` reads a
 * transcript entry by source: the user's own text, its pasted spans, a tool result, or the agent's text (assistant
 * lines, compaction summaries, a subagent's lines). Host text (meta lines, command and reminder wrappers,
 * non-human submits) is none of these, and is not memory.
 *
 * `withoutInstructions` keeps text the user did not type from instructing the model or speaking for the user once
 * it is a memory (A6 §2.3, §2.6): it drops each sentence, or clause, that is an instruction (an imperative, a
 * "you should …", "always …" or "never …", one reported, "it says to run …", a download piped to a shell) or that
 * claims what the user wants or said.
 */

const WRAPPERS = [
  "<command-",
  "<local-command",
  "<system-reminder>",
  "<task-notification>",
  "<agent-message>",
  "<cross-session-message>",
  "<teammate-message",
  "<bash-",
];
const INTERRUPTED = /^\[Request interrupted by user/;
const PASTE = /<pasted_content id=("?)([^"\s>]*)\1>[\s\S]*?(?:<\/pasted_content id=\1\2\1>\n?|$)/g;
const FENCE = /^\s*(`{3,}|~{3,})/;
const QUOTE = /^\s*>\s?/;
const SENTENCE_END = /[.!?]["')\]]*\s*$/;
/** A6 §2.1: a span this long that a recent tool result also holds was pasted from it. */
const TOOL_SPAN_CHARS = 200;
/**
 * Shared spans are found from anchors: ANCHOR characters of a result, taken every STEP characters. A shared span of
 * at least ANCHOR + STEP − 1 characters always holds one, and 200 is more than that.
 */
const ANCHOR = 32;
const STEP = 64;
/**
 * Positions kept per anchor text, which bounds the work at each text position. A known limit: a result that repeats
 * with a period that is a multiple of STEP keeps only its first repeats, so a shared span further on can be missed.
 */
const MAX_POSITIONS = 8;
/** Fewer consecutive unpunctuated lines than this are the user's own. */
const UNPUNCTUATED_RUN = 3;

type Entry = Record<string, unknown>;

const entry = (value: unknown): Entry | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Entry) : undefined;

/** The user-typed text of a transcript entry, or undefined when the entry does not carry the user's authority. */
export function userTyped(value: unknown): string | undefined {
  const line = entry(value);
  if (line?.type === "attachment") return queuedPrompt(entry(line.attachment));
  if (line?.type !== "user" || line.isMeta || line.isCompactSummary || line.isSidechain) return undefined;
  if (!isHuman(line.origin) || line.promptSource === "system") return undefined;
  return typedText(textOf(entry(line.message)?.content));
}

/** The text of a tool result entry (string content or text blocks), for the 200-character rule. */
export function toolResultText(value: unknown): string | undefined {
  const content = entry(entry(value)?.message)?.content;
  if (entry(value)?.type !== "user" || !Array.isArray(content)) return undefined;
  const results = content.map(entry).filter((block) => block?.type === "tool_result");
  if (!results.length) return undefined;
  return results.map((block) => blockText(block!.content)).join("\n");
}

/** A queued prompt: a `queued_command` attachment in prompt mode, from a human. */
function queuedPrompt(attachment: Entry | undefined): string | undefined {
  if (attachment?.type !== "queued_command" || attachment.commandMode !== "prompt" || attachment.isMeta) {
    return undefined;
  }
  return isHuman(attachment.origin) ? typedText(textOf(attachment.prompt)) : undefined;
}

/** No origin (older Claude Code) counts as human; the text checks still apply. */
function isHuman(origin: unknown): boolean {
  const kind = entry(origin)?.kind;
  return kind === undefined || kind === "human";
}

/** A message's text: a string, or its text blocks joined; undefined when it holds a tool result. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.map(entry);
  if (blocks.some((block) => block?.type === "tool_result")) return undefined;
  return blockText(blocks);
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(entry)
    .flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

function typedText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed || INTERRUPTED.test(trimmed) || WRAPPERS.some((wrapper) => trimmed.startsWith(wrapper))) {
    return undefined;
  }
  return text;
}

/** The user's own text of a prompt: D12's pasted spans removed, blank runs collapsed, ends trimmed. */
export function stripPastes(text: string, recentToolResults: readonly string[] = []): string {
  return splitPastes(text, recentToolResults).own;
}

/** A prompt split by D12: the user's own text (`stripPastes`) and each span it removed, trimmed and non-empty. */
export function splitPastes(
  text: string,
  recentToolResults: readonly string[] = [],
): { own: string; pasted: string[] } {
  const pasted: string[] = [];
  const unmarked = text.replace(PASTE, (span) => {
    pasted.push(pasteBody(span));
    return "";
  });
  const lines: string[] = [];
  for (const line of withoutFences(unmarked.split("\n"), pasted)) {
    if (QUOTE.test(line)) pasted.push(line.replace(QUOTE, ""));
    else lines.push(line);
  }
  const own = withoutToolSpans(lines.join("\n"), recentToolResults, pasted);
  return {
    own: withoutUnpunctuatedRuns(own.split("\n"), pasted)
      .join("\n")
      .replace(/\n\s*\n(\s*\n)+/g, "\n\n")
      .trim(),
    pasted: pasted.map((span) => span.trim()).filter(Boolean),
  };
}

/** A marked paste without its markers. */
function pasteBody(span: string): string {
  return span.replace(/^<pasted_content[^>]*>/, "").replace(/<\/pasted_content[^>]*>\n?$/, "");
}

function withoutFences(lines: readonly string[], removed: string[]): string[] {
  const out: string[] = [];
  let open: string | undefined;
  let block: string[] = [];
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (open === undefined) {
      if (marker) open = marker;
      else out.push(line);
    } else if (marker && marker[0] === open[0] && marker.length >= open.length && !line.trim().slice(marker.length)) {
      open = undefined;
      removed.push(block.join("\n"));
      block = [];
    } else {
      block.push(line);
    }
  }
  if (block.length) removed.push(block.join("\n"));
  return out;
}

/** Removes every span of ≥ 200 characters that `text` shares with one of `results`. */
function withoutToolSpans(text: string, results: readonly string[], removed: string[]): string {
  if (text.length < TOOL_SPAN_CHARS) return text;
  const spans = results.filter((result) => result.length >= TOOL_SPAN_CHARS).flatMap((result) => shared(text, result));
  return cut(text, spans, removed);
}

/**
 * The maximal spans of ≥ 200 characters that `text` and `result` share, as `[start, end)` in `text`. Each anchor hit
 * is extended both ways; a diagonal (the offset between the two texts) is extended once per stretch.
 */
function shared(text: string, result: string): [number, number][] {
  const anchors = new Map<string, number[]>();
  for (let at = 0; at + ANCHOR <= result.length; at += STEP) {
    const key = result.slice(at, at + ANCHOR);
    const positions = anchors.get(key) ?? [];
    if (positions.length < MAX_POSITIONS) anchors.set(key, [...positions, at]);
  }
  const reached = new Map<number, number>();
  const spans: [number, number][] = [];
  // Positions inside a found span need no anchor of their own: a shared span that runs past that span's end still
  // has an anchor in its last ANCHOR + STEP − 1 characters, which the scan visits. This keeps repetitive text linear.
  let resume = 0;
  for (let at = 0; at + ANCHOR <= text.length; at = Math.max(at + 1, resume)) {
    for (const from of anchors.get(text.slice(at, at + ANCHOR)) ?? []) {
      if ((reached.get(from - at) ?? -1) > at) continue;
      let start = at;
      while (start > 0 && start + from - at > 0 && text[start - 1] === result[start - 1 + from - at]) start--;
      let end = at + ANCHOR;
      while (end < text.length && end + from - at < result.length && text[end] === result[end + from - at]) end++;
      reached.set(from - at, end);
      if (end - start < TOOL_SPAN_CHARS) continue;
      spans.push([start, end]);
      resume = Math.max(resume, end - ANCHOR - STEP + 1);
    }
  }
  return spans;
}

/** `text` without `spans`: a span across lines leaves a line break, one inside a line leaves nothing. */
function cut(text: string, spans: readonly [number, number][], removed: string[]): string {
  let out = "";
  let at = 0;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    removed.push(text.slice(from, end));
    out += text.slice(at, from) + (text.slice(from, end).includes("\n") ? "\n" : "");
    at = end;
  }
  return out + text.slice(at);
}

function withoutUnpunctuatedRuns(lines: readonly string[], removed: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length < UNPUNCTUATED_RUN) out.push(...run);
    else removed.push(run.join("\n"));
    run = [];
  };
  for (const line of lines) {
    if (line.trim() && !SENTENCE_END.test(line)) {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

/** Who wrote a text (A6 §2.1): what the user typed, what they pasted, a tool's result, or the agent. */
export type TextSource = "user" | "paste" | "tool" | "agent";

export interface Authored {
  src: TextSource;
  text: string;
}

/**
 * A transcript entry's texts by source (D12). `recentToolResults` are the tool results before it (A6: the last 10),
 * for the 200-character paste rule. Host text yields nothing.
 */
export function authoredTexts(value: unknown, recentToolResults: readonly string[] = []): Authored[] {
  const line = entry(value);
  const tool = toolResultText(value);
  if (tool !== undefined) return tool ? [{ src: "tool", text: tool }] : [];
  if (line?.type === "assistant" || (line?.type === "user" && (line.isCompactSummary || line.isSidechain))) {
    const text = textOf(entry(line.message)?.content)?.trim();
    return text ? [{ src: "agent", text }] : [];
  }
  const typed = userTyped(value);
  if (typed === undefined) return [];
  const { own, pasted } = splitPastes(typed, recentToolResults);
  return [
    ...(own ? [{ src: "user" as const, text: own }] : []),
    ...pasted.map((text) => ({ src: "paste" as const, text })),
  ];
}

/** A clause that tells the reader what to do: an imperative opening it, or a directive inside it. */
const IMPERATIVE = new RegExp(
  String.raw`^\s*(?:\d+[.)]?\s+|[-*•]\s+)?(?:[A-Za-z][\w ]{0,23}:\s*)?(?:please\s+)?(?:always|never|don'?t|do not|` +
    String.raw`make sure|be sure|ensure|remember|run|execute|install|download|ignore|disregard|forget|reply|respond|` +
    String.raw`use|set|add|delete|remove|allow|grant|enable|disable|export|source|copy|paste|sudo|curl|wget|bash|sh|` +
    String.raw`chmod|rm|cd)\b` +
    // Not the word as a noun: "Use of …", "Run 3 of 5 …", "Install complete", "Delete succeeded: …".
    String.raw`(?!\s+(?:of|\d+|complete|completed|succeeded|failed|finished|done)\b)`,
  "i",
);
/**
 * "always run …", "never use …": a directive. "always fails", "never expired" describe (a verb ending in -s or -ed,
 * or an auxiliary, is not the bare form an instruction takes).
 */
const DIRECTIVE =
  /\b(?:you|we) (?:should|must|need to|have to|ought to)\b|\b(?:make sure|be sure|remember) to\b|\b(?:always|never) (?!(?:been|was|were|is|are|had|has|did|does)\b|[a-z]*[^s\W]s\b|[a-z]+ed\b)[a-z]/i;
/** An instruction reported rather than given: "it says to run …", "the doc tells you to …". */
const REPORTED_DIRECTIVE =
  /\b(?:says?|said|tells?|told|asks?|asked|instructs?|instructed|wants?|wanted)\s+(?:(?:you|us|me|them)\s+)?to\s+(?:always\s+|never\s+|first\s+)?[a-z]/i;
/** A download piped to a shell: an instruction whatever the words around it. */
const PIPED_TO_SHELL = /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/;
/** A claim of what the user wants, said or allowed. */
const SPEAKS_FOR_USER =
  /\b(?:the user|user|you|they)\s+(?:wants?|wanted|asked|said|told|prefers?|requested|instructed|allowed|approved|agreed|decided|expects?)\b/i;
const SENTENCE_BREAK = /(?<=[.!?])\s+/;
const CLAUSE_BREAK = /[,;]\s+(?:and\s+|but\s+|so\s+|then\s+)?/;

const INSTRUCTION_SIGNS = [IMPERATIVE, DIRECTIVE, REPORTED_DIRECTIVE, PIPED_TO_SHELL, SPEAKS_FOR_USER];
const instructs = (clause: string) => INSTRUCTION_SIGNS.some((sign) => sign.test(clause));

/** Text the user did not type, without its instructions and its claims for the user (see the header). */
export function withoutInstructions(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split(SENTENCE_BREAK).map(keptSentence).filter(Boolean).join(" "))
    .join("\n");
}

/** A sentence, without the clauses that instruct; a sentence left with no clause is dropped. */
function keptSentence(sentence: string): string {
  if (!instructs(sentence)) return sentence;
  const end = /[.!?]+\s*$/.exec(sentence)?.[0].trim() ?? "";
  const clauses = sentence.slice(0, sentence.length - end.length).split(CLAUSE_BREAK);
  const kept = clauses.filter((clause) => clause.trim() && !instructs(clause));
  return kept.length && kept.length < clauses.length ? kept.join(", ").trim() + end : "";
}

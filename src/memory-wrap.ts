/**
 * The wrap's delivery (D29, A4 §5.9), for the Anthropic and OpenAI-shaped proxies and `AgentMemory.inject`.
 *
 * A wrap client re-sends its whole history with every request, without what the wrap added to earlier ones.
 * - **Placement (D29).** A turn's packet goes at the tail of the turn's human user message, never into `system` or
 *   before the history, where a new packet invalidates the cached conversation (A1 annex §E). Every later request
 *   carries the same text on that message: each tool-loop step of the turn, and each later turn, as the hook's
 *   packet stays in Claude Code's transcript. So each request repeats the previous one's prefix byte for byte.
 * - **Turns.** A message is keyed by a hash chain over itself and every message before it, read without
 *   `cache_control` markers, place fields and the wrap's own tail: a re-sent message keeps its key, and two
 *   conversations share none. A turn's packet is chosen when its human message ends the request, and reused while
 *   later messages (the tool loop) follow it. A turn unused for an hour is forgotten: by then the provider's cache
 *   of that prefix has expired too.
 * - **Authority (D12).** Messages are read as transcript entries are: `system` and `developer` text is the host's,
 *   not memory; assistant text is the agent's. A user message's text blocks are the user's when D12 says they were
 *   typed (not a wrapper, not D24's non-human submit), its pasted spans `paste` episodes. A tool result (an
 *   Anthropic `tool_result` block, an OpenAI `tool` message, a Gemini `functionResponse`) is not encoded here: the
 *   wrap's tool-trace observer records it (`observeToolTraces`, M23.2's experience files for page trees); it is the
 *   evidence D12's paste rule compares a prompt with.
 * - **Encode once.** A message is encoded the first time a request carries it: a client's A4 §3.3 delta. History a
 *   process has never seen (it restarted mid-conversation) is read again (`reread`) and records no forgets.
 * - **Delivery.** A new turn is answered as the hook answers a Submit (A4 §5.1): the user's forgets, the turn mode,
 *   retrieval, validity, the episode gate and the residual of the request's own messages (D26), then the window's
 *   refractory rule, read from the packets the request still carries (A4 §4's distances, in the bytes after the
 *   message carrying each), and the shape and wording (D28, D14).
 */
import { createHash } from "node:crypto";
import type { MemoryRecord, ObserveOptions } from "./index";
import { authoredTexts, splitPastes, userTyped, type TextSource } from "./memory-authority";
import { memoryNow } from "./memory-clock";
import { selectNotes } from "./memory-delivery";
import { packetOf, shapePacket } from "./memory-hook-packet";
import { ledgerKey, REFRACTORY_BYTES, type LedgerKey } from "./memory-ledger";
import { MEMORY_PACKET_MARKS } from "./memory-sota";
import { nonHumanKind, turnMode } from "./memory-turn";
import { readInvalidations, recordInvalidations, withoutForgets, type Invalidation } from "./memory-validity";

/** Fields a wrap request may carry place paths in: they name what is open, not what was said. */
export const PLACE_FIELDS = [
  "open_files",
  "openFiles",
  "files",
  "file_paths",
  "filePaths",
  "file_path",
  "filePath",
  "recently_viewed_files",
  "recentlyViewedFiles",
] as const;

/** Fields that never change what a message says: left out of its key. */
const KEYLESS_FIELDS = new Set<string>(["cache_control", ...PLACE_FIELDS]);
/** A6 §2.1: the tool results before a prompt that the paste rule reads. */
const RECENT_TOOL_RESULTS = 10;
/** D26: the typed prompts before the current one that the residual reads. */
const TYPED_PROMPTS = 2;
/** The longest prompt-cache lifetime a provider offers (Anthropic's 1 h); a turn unused for longer is forgotten. */
const TURN_TTL_MS = 3_600_000;
const MAX_TURNS = 4096;
const MAX_SEEN = 65_536;

/** What a turn's human message carries at its tail, and the ledger keys of the notes its packet delivered. */
export interface TurnTail {
  texts: string[];
  given: LedgerKey[];
}

/** The wrap's memory of one process: the tail of each turn, and the messages it has encoded. Both are bounded. */
export class WrapTurns {
  private tails = new Map<string, { tail: TurnTail; used: number }>();
  private encoded = new Map<string, true>();

  tail(key: string, now: number): TurnTail | undefined {
    const hit = this.tails.get(key);
    if (!hit || now - hit.used > TURN_TTL_MS) return undefined;
    this.tails.delete(key);
    this.tails.set(key, { tail: hit.tail, used: now });
    return hit.tail;
  }

  setTail(key: string, tail: TurnTail, now: number): void {
    this.tails.delete(key);
    this.tails.set(key, { tail, used: now });
    evict(this.tails, MAX_TURNS);
  }

  wasEncoded(key: string): boolean {
    return this.encoded.has(key);
  }

  markEncoded(key: string): void {
    this.encoded.delete(key);
    this.encoded.set(key, true);
    evict(this.encoded, MAX_SEEN);
  }
}

function evict(map: Map<string, unknown>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

/** What the wrap needs of a memory (`AgentMemory`). */
export interface WrapMemory {
  readonly dir: string;
  readonly turns: WrapTurns;
  recall(messages: unknown[], encode?: unknown[]): MemoryRecord[];
  observeCue(messages: unknown[], cue?: string, encode?: unknown[]): void;
  observe(messages: unknown[], opts?: ObserveOptions): MemoryRecord[];
  forget(records: readonly Invalidation[]): void;
  storableText(text: string): string;
  noteActivity(): void;
  /** Whether memory may be written (`EDEN_MEMORY` on, not read-only). */
  writable(): boolean;
}

export interface InjectOptions {
  /** Paths the request names outside its messages (open files, a header): place cues for a new turn. */
  paths?: readonly string[];
  /** More text for a new turn's tail, after its packet (the Anthropic wrap's Know card). */
  extra?: () => string | undefined;
  /** The marks `extra`'s texts begin with, so a client that echoes a tail back is recognised. */
  extraMarks?: readonly string[];
  /**
   * Attach the tail as text blocks, a string content becoming its one block (Anthropic): the message then has one
   * shape whether or not it ends the request, where the proxy turns the last message's string into blocks.
   */
  blocks?: boolean;
}

type Message = Record<string, unknown>;
type Authored = { role: string; content: string; src: TextSource };

/** One message as the wrap reads it. */
interface Read {
  key: string;
  /** Its size as keyed: the bytes it adds to the window. */
  bytes: number;
  /** The text the user typed, when it is a human turn. */
  typed?: string;
  /** A tool result's text. */
  tool?: string;
  /** The agent's text. */
  agent?: string;
  /** Whether it already carries a tail (a client that echoes what the wrap sent). */
  tailed: boolean;
}

const record = (value: unknown): Message | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Message) : undefined;

/** A Gemini part or an OpenAI content part as an Anthropic-style block. */
function block(part: unknown): unknown {
  const p = record(part);
  if (!p) return part;
  if (typeof p.text === "string" && (p.type === undefined || p.type === "input_text" || p.type === "output_text"))
    return { type: "text", text: p.text };
  const response = record(p.functionResponse);
  if (response) return { type: "tool_result", content: JSON.stringify(response.response ?? response) };
  return part;
}

function contentOf(message: Message): unknown {
  const content = "content" in message ? message.content : message.parts;
  return Array.isArray(content) ? content.map(block) : content;
}

/** A content's text: a string, or its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => record(part))
    .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

/**
 * The user's typed text in a user message (D12): its text blocks that are not wrappers, or nothing for a tool result
 * or D24's non-human submit. Claude Code sends a prompt's reminders as text blocks of the same message.
 */
function typedText(content: unknown): string | undefined {
  const blocks = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
  if (blocks.some((b) => record(b)?.type === "tool_result")) return undefined;
  const typed = blocks
    .map((b) => (typeof b === "string" ? b : textOf([b])))
    .filter((text) => text && userTyped({ type: "user", message: { content: text } }) !== undefined);
  const text = typed.join("\n");
  return text.trim() && !nonHumanKind(text) ? text : undefined;
}

function roleOf(message: Message): string {
  return String(message.role ?? "").toLowerCase();
}

/** Whether a text starts a tail the wrap writes. */
const startsTail = (text: string, marks: readonly string[]) => marks.some((mark) => text.startsWith(mark));

/** A message without the wrap's tail: what the client sent. */
function untailed(message: Message, marks: readonly string[]): { message: Message; tailed: boolean } {
  const key = "content" in message ? "content" : "parts";
  const content = message[key];
  if (typeof content === "string") {
    const cut = Math.min(...marks.map((mark) => content.indexOf(`\n\n${mark}`)).filter((at) => at >= 0));
    return Number.isFinite(cut)
      ? { message: { ...message, [key]: content.slice(0, cut) }, tailed: true }
      : { message, tailed: false };
  }
  if (!Array.isArray(content)) return { message, tailed: false };
  const kept = content.filter((part) => {
    const text = record(part)?.text;
    return !(typeof text === "string" && startsTail(text, marks));
  });
  return kept.length === content.length
    ? { message, tailed: false }
    : { message: { ...message, [key]: kept }, tailed: true };
}

function keyed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keyed);
  const o = record(value);
  if (!o) return value;
  const out: Message = {};
  for (const [k, v] of Object.entries(o)) if (!KEYLESS_FIELDS.has(k)) out[k] = keyed(v);
  return out;
}

/** Each message read (see the header), keyed by the hash chain. */
function readMessages(messages: readonly unknown[], marks: readonly string[]): Read[] {
  let chain = "";
  return messages.map((raw) => {
    const message = record(raw) ?? {};
    const { message: sent, tailed } = untailed(message, marks);
    const canonical = JSON.stringify(keyed(sent)) ?? "";
    chain = createHash("sha256").update(chain).update("\n").update(canonical).digest("hex").slice(0, 32);
    const read: Read = { key: chain, bytes: Buffer.byteLength(canonical), tailed };
    const role = roleOf(message);
    const content = contentOf(sent);
    if (role === "tool" || role === "function") read.tool = textOf(content);
    else if (role === "assistant" || role === "model") read.agent = textOf(content);
    else if (role === "user" || role === "human") {
      const tool = toolResults(content);
      if (tool !== undefined) read.tool = tool;
      else read.typed = typedText(content);
    }
    return read;
  });
}

function toolResults(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const results = content.map(record).filter((b) => b?.type === "tool_result");
  return results.length ? results.map((b) => textOf(b!.content)).join("\n") : undefined;
}

/** A read message as `observe` takes it, by source (D12); a typed text loses its forgets (A6 §3). */
function authored(read: Read, recentTools: readonly string[]): Authored[] {
  if (read.agent?.trim()) return [{ role: "assistant", content: read.agent.trim(), src: "agent" }];
  if (read.typed === undefined) return [];
  return authoredTexts({ type: "user", message: { content: read.typed } }, recentTools).flatMap(({ src, text }) => {
    const content = src === "user" ? withoutForgets(text) : text;
    return content ? [{ role: src === "agent" ? "assistant" : "user", content, src }] : [];
  });
}

/** A prompt as `recall` encodes it after retrieving (the hook's `promptMessages`). */
function promptMessages(prompt: string, recentTools: readonly string[]): Authored[] {
  const { own, pasted } = splitPastes(prompt, recentTools);
  const said = withoutForgets(own);
  return [
    ...(said ? [{ role: "user", content: said, src: "user" as const }] : []),
    ...pasted.map((content) => ({ role: "user", content, src: "paste" as const })),
  ];
}

function toolsBefore(reads: readonly Read[], at: number): string[] {
  const out: string[] = [];
  for (let i = at - 1; i >= 0 && out.length < RECENT_TOOL_RESULTS; i--)
    if (reads[i]!.tool) out.unshift(reads[i]!.tool!);
  return out;
}

/**
 * Encodes the messages no request carried before, from `from` to `to` (exclusive), in order; returns how many. A
 * message is new to the conversation when it follows one this process encoded or a new one, or is a new turn's
 * human message ending the request; the rest is history read again (`reread`).
 */
function encodeNew(
  mem: WrapMemory,
  reads: readonly Read[],
  from: number,
  to: number,
  fresh: readonly boolean[],
): number {
  let count = 0;
  const groups: { reread: boolean; messages: Authored[] }[] = [];
  for (let i = from; i < to; i++) {
    const read = reads[i]!;
    if (mem.turns.wasEncoded(read.key)) continue;
    const messages = authored(read, toolsBefore(reads, i));
    const reread = !fresh[i];
    const group = groups.at(-1);
    if (group && group.reread === reread) group.messages.push(...messages);
    else groups.push({ reread, messages });
    mem.turns.markEncoded(read.key);
    count++;
  }
  for (const { reread, messages } of groups)
    if (messages.length)
      mem.observe(messages, { keepLiveIdentity: true, deferSleep: true, ...(reread ? { reread } : {}) });
  return count;
}

/** Which messages are new to the conversation (see `encodeNew`). */
function freshness(mem: WrapMemory, reads: readonly Read[], newTurn: number | undefined): boolean[] {
  const fresh: boolean[] = [];
  reads.forEach((_, i) => {
    const before = i > 0 ? reads[i - 1]! : undefined;
    fresh.push(i === newTurn || (before !== undefined && (mem.turns.wasEncoded(before.key) || fresh[i - 1]!)));
  });
  return fresh;
}

/** D26's residual and A7 §3's cue parts, read from the messages before the turn's human message. */
function conversationBefore(reads: readonly Read[], at: number, prompt: string) {
  const residual = [prompt];
  let previousTyped = "";
  let prev = "";
  let typed = 0;
  for (let i = at - 1; i >= 0 && typed < TYPED_PROMPTS; i--) {
    const read = reads[i]!;
    const agent = read.agent?.trim();
    if (agent) {
      residual.push(agent);
      prev ||= agent;
    } else if (read.typed !== undefined) {
      residual.push(read.typed);
      previousTyped ||= read.typed;
      typed++;
    }
  }
  return { residual, previousTyped, prev };
}

/** A4 §4's refractory rule over the packets the request still carries: a note one of them gave is not given again. */
function refractoryOf(reads: readonly Read[], tails: Map<number, TurnTail>, at: number) {
  const given: { key: LedgerKey; after: number }[] = [];
  for (const [h, tail] of tails) {
    if (h >= at) continue;
    let after = 0;
    for (let i = h + 1; i <= at; i++) after += reads[i]!.bytes;
    for (const key of tail.given) given.push({ key, after });
  }
  return (notes: MemoryRecord[]) =>
    notes.filter((note) => {
      const key = ledgerKey(note);
      const distance = key.rule ? REFRACTORY_BYTES.rule : REFRACTORY_BYTES.other;
      return !given.some((g) => g.key.cid === key.cid && g.key.ver === key.ver && g.after < distance);
    });
}

/** A new turn's tail (A4 §5.1 as the hook runs it; see the header). */
function answerTurn(
  mem: WrapMemory,
  reads: readonly Read[],
  at: number,
  tails: Map<number, TurnTail>,
  opts: InjectOptions,
  newPrompt: boolean,
): TurnTail {
  const prompt = reads[at]!.typed!;
  const tools = toolsBefore(reads, at);
  const { residual, previousTyped, prev } = conversationBefore(reads, at, prompt);
  // A4 §3.1: what the user just retracted or revoked is invalid from this turn on (typed text only, once).
  if (newPrompt && mem.writable()) mem.forget(recordInvalidations(mem.dir, mem.storableText(prompt)));
  const encode = newPrompt ? promptMessages(prompt, tools) : [];
  const cue = [{ role: "user", content: prompt, ...(opts.paths?.length ? { open_files: [...opts.paths] } : {}) }];
  let notes: MemoryRecord[] = [];
  if (turnMode(prompt, { previousAssistant: prev }) === "imperative") notes = mem.recall(cue, encode);
  else mem.observeCue(cue, undefined, encode);
  const against = {
    prompt,
    parts: { prompt, turn: previousTyped, prev },
    residual,
    invalid: readInvalidations(mem.dir),
  };
  const selected = notes.length ? selectNotes(notes, against, refractoryOf(reads, tails, at)).notes : [];
  const { packet, delivered } = packetOf(shapePacket(selected), memoryNow());
  let extra: string | undefined;
  try {
    extra = opts.extra?.();
  } catch {}
  return { texts: [packet, extra ?? ""].filter(Boolean), given: delivered.map(ledgerKey) };
}

/** The memory packets a message list carries at its turns' tails: what `inject` attached, or a client echoed. */
export function injectedPackets(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    const message = record(raw);
    const content = message && ("content" in message ? message.content : message.parts);
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map(record) : [];
    for (const item of texts) {
      const text = typeof item === "string" ? item : typeof item?.text === "string" ? item.text : "";
      const at = Math.min(...MEMORY_PACKET_MARKS.map((mark) => text.indexOf(mark)).filter((i) => i >= 0));
      if (Number.isFinite(at)) out.push(text.slice(at));
    }
  }
  return out;
}

/** A message with texts appended at its tail, in its own content shape (or as blocks, `InjectOptions.blocks`). */
function withTail(message: Message, texts: readonly string[], blocks: boolean): Message {
  if (Array.isArray(message.parts))
    return { ...message, parts: [...message.parts, ...texts.map((text) => ({ text }))] };
  const content = message.content;
  const tail = texts.map((text) => ({ type: "text", text }));
  if (Array.isArray(content)) return { ...message, content: [...content, ...tail] };
  if (blocks) return { ...message, content: [{ type: "text", text: String(content ?? "") }, ...tail] };
  return { ...message, content: [String(content ?? ""), ...texts].join("\n\n") };
}

/**
 * The request's messages with every turn's tail in place (see the header); the same list when none applies. A
 * throw reaches the caller, which fails open.
 */
export function placeTurnTails(mem: WrapMemory, messages: readonly unknown[], opts: InjectOptions = {}): unknown[] {
  const now = Date.now();
  const marks = [...MEMORY_PACKET_MARKS, ...(opts.extraMarks ?? [])];
  const reads = readMessages(messages, marks);
  const humans = reads.flatMap((read, i) => (read.typed !== undefined ? [i] : []));
  const last = humans.at(-1) ?? reads.length;
  // A turn's first request ends with its human message; one that follows it is a tool-loop step.
  const opening = last === reads.length - 1;
  const newPrompt = opening && !mem.turns.wasEncoded(reads[last]!.key);
  const fresh = freshness(mem, reads, newPrompt ? last : undefined);
  const tails = new Map<number, TurnTail>();
  for (const h of humans) {
    const tail = h === last && opening ? undefined : mem.turns.tail(reads[h]!.key, now);
    if (tail) tails.set(h, tail);
  }
  let encoded = encodeNew(mem, reads, 0, last, fresh);
  if (last < reads.length && !tails.has(last)) {
    const tail = answerTurn(mem, reads, last, tails, opts, newPrompt);
    if (newPrompt) mem.turns.markEncoded(reads[last]!.key);
    mem.turns.setTail(reads[last]!.key, tail, now);
    tails.set(last, tail);
  }
  encoded += encodeNew(mem, reads, last, reads.length, fresh);
  if (encoded || newPrompt) mem.noteActivity();
  let out: unknown[] | undefined;
  for (const [h, tail] of tails) {
    if (!tail.texts.length || reads[h]!.tailed) continue;
    out ??= messages.slice();
    out[h] = withTail(record(messages[h])!, tail.texts, opts.blocks === true);
  }
  return out ?? (messages as unknown[]);
}

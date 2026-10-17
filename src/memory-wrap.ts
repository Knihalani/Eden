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
 *   refractory rule and `Updated:` items, read from the packets the request still carries (A4 §4's distances, in the
 *   bytes after the message carrying each), A4 §4's budget over them, and the shape and wording (D28, D14).
 * - **Flag (X7).** `deliver.submit` governs the wrap as it governs the hook's Submit: `off` encodes the turn and
 *   answers nothing; `shadow` answers it but attaches no packet, and its refractory rule reads the packets attached and
 *   those it would have attached; `on` attaches. The mode is read from the flag files at each new turn.
 * - **Ledger (A4 §4).** Each conversation is a window, `windows/wrap-<key of its first message>/`: a new turn appends
 *   its `turn` and `deliver` records to the ledger of its mode, and a wide event (`ev: "wrap"`, `memory-events.ts`) is
 *   logged, so shadow measures and `would_preempt` see wrap traffic. The ledger is for those measures: the request
 *   itself is the truth of what the window holds.
 * - **Restarts.** A turn's tail is also kept in its window (`tails.jsonl`, an hour like the memo), so a restarted
 *   wrap puts every earlier turn's packet back where it was: the cached prefix holds.
 */
import { createHash } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomic } from "../packages/cli/src/home";
import type { MemoryRecord, ObserveOptions, RecallCue } from "./index";
import { authoredTexts, splitPastes, userTyped, type TextSource } from "./memory-authority";
import { memoryNow } from "./memory-clock";
import { selectNotes, type DeliveryDrops } from "./memory-delivery";
import { appendWideEvent, type DropStage } from "./memory-events";
import { resolveFlags, type FlagMode } from "./memory-flags";
import { packetOf, shapePacket } from "./memory-hook-packet";
import {
  deliveredKeys,
  foldLedger,
  humanTurns,
  inWindow,
  novelNotes,
  packetTokens,
  recordPacket,
  withinBudget,
  wouldPreempt,
  type LedgerKey,
  type LiveDelivery,
} from "./memory-ledger";
import { sentencesOf } from "./memory-residual";
import { MEMORY_PACKET_MARKS } from "./memory-sota";
import { gateParts, pathCue, situationCue } from "./memory-cue";
import { isAnswered, nonHumanKind, promptHash, turnMode } from "./memory-turn";
import { answerUserGlobal, type AnswerPlace } from "./memory-user-global";
import { readInvalidations, recordInvalidations, withoutForgets, type Invalidation } from "./memory-validity";
import { appendRecords, appendTurn, ledgerFor, SHADOW_LEDGER, windowDir, windowRecords } from "./memory-window";

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
  /** The packet's tokens: A4 §4's budget counts them while the request carries the turn. */
  tokens: number;
  /** The mode `deliver.submit` answered the turn in (X7): a `shadow` turn's packet is not in `texts`. */
  mode: FlagMode;
}

/** The wrap's memory of one process: the tail of each turn, and the messages it has encoded. Both are bounded. */
export class WrapTurns {
  private tails = new Map<string, { tail: TurnTail; used: number }>();
  private encoded = new Map<string, true>();
  /** When each tail's line in its window was last written: a used tail's line is renewed (`keepTail`). */
  private stamps = new Map<string, number>();

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

  stampedAt(key: string): number | undefined {
    return this.stamps.get(key);
  }

  stamp(key: string, t: number): void {
    this.stamps.delete(key);
    this.stamps.set(key, t);
    evict(this.stamps, MAX_TURNS);
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
  /** The memory root its conversations' windows live under, and the repo key that prefixes their cids. */
  readonly windowsRoot: string;
  readonly repoKey?: string;
  /** The session's `ep`, where a D11 proposal is shown and answered. */
  readonly episode?: string;
  readonly turns: WrapTurns;
  recall(
    messages: unknown[],
    encode?: unknown[],
    visible?: (row: MemoryRecord) => boolean,
    cue?: RecallCue,
  ): MemoryRecord[];
  observeCue(messages: unknown[], cue?: string, encode?: unknown[]): void;
  observe(messages: unknown[], opts?: ObserveOptions): MemoryRecord[];
  forget(records: readonly Invalidation[]): void;
  storableText(text: string): string;
  noteActivity(): void;
  /** Whether memory may be written (`EDEN_MEMORY` on, not read-only). */
  writable(): boolean;
  /** P4.3's gate's mode (`gate.tau`): a typed request is an episode only with it on. */
  gateMode(): FlagMode;
}

export interface InjectOptions {
  /** Paths the request names outside its messages (open files, a header): place cues for a new turn. */
  paths?: readonly string[];
  /** More text for a new turn's tail, after its packet (the Anthropic wrap's Know card). */
  extra?: () => string | undefined;
  /** The marks `extra`'s texts begin with, so a client that echoes a tail back is recognised. */
  extraMarks?: readonly string[];
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
 * Encodes the messages no request carried before, from `from` to `to` (exclusive), in order; returns how many.
 * Nothing is encoded, or marked as encoded, while memory is read-only.
 */
function encodeNew(
  mem: WrapMemory,
  reads: readonly Read[],
  from: number,
  to: number,
  fresh: readonly boolean[],
): number {
  if (!mem.writable()) return 0;
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

/**
 * Which messages are new to the conversation: those after the last one this process encoded, and a turn's human
 * message ending the request. The rest is history read again (`reread`), as in a conversation first seen after a
 * restart. When a client edits earlier history, every message after the edit has a new key and is encoded again as
 * new; a statement the store already holds is then kept as it is (tests: "history the client edited").
 */
function freshness(mem: WrapMemory, reads: readonly Read[], newTurn: number | undefined): boolean[] {
  const lastEncoded = reads.findLastIndex((read) => mem.turns.wasEncoded(read.key));
  return reads.map((_, i) => i === newTurn || (lastEncoded >= 0 && i > lastEncoded));
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

/**
 * What the window still holds of the packets the request carries (A4 §4): each one's deliveries still within their
 * distance, in the bytes after the message carrying it, and the tokens of them all (the budget). A live point reads
 * the packets attached; a shadow point also those it would have attached.
 */
function heldBefore(reads: readonly Read[], tails: Map<number, TurnTail>, at: number, mode: FlagMode) {
  const live: LiveDelivery[] = [];
  let tokens = 0;
  for (const [h, tail] of tails) {
    if (h >= at || (tail.mode !== "on" && mode !== "shadow")) continue;
    let after = 0;
    for (let i = h + 1; i <= at; i++) after += reads[i]!.bytes;
    tokens += tail.tokens;
    for (const { cid, ver } of tail.given) if (inWindow(cid, 0, after)) live.push({ cid, ver });
  }
  return { live, tokens };
}

/** Where a D11 proposal is shown and answered: the repo and the session's `ep`. */
function answerPlace(mem: WrapMemory): AnswerPlace | undefined {
  return mem.repoKey && mem.episode ? { repo: mem.repoKey, ep: mem.episode } : undefined;
}

/** The packets the wrap gave the turn before message `at` (its tail's Eden packet), which `q_prev` drops (A7 §3). */
function packetsBefore(tails: Map<number, TurnTail>, at: number): string[] {
  const before = [...tails.keys()].filter((h) => h < at);
  if (!before.length) return [];
  const texts = tails.get(Math.max(...before))!.texts;
  return texts.filter((text) => MEMORY_PACKET_MARKS.some((mark) => text.startsWith(mark)));
}

/** A new turn's answer: its tail, and what its wide event logs. */
interface Answer {
  tail: TurnTail;
  prompt: string;
  turnMode: string;
  ids: string[];
  drops: Partial<Record<DropStage, number>>;
  tokensEpoch: number;
  /** The user's own words, which `would_preempt` compares with recent shadow deliveries. */
  said: string[];
  /** What D11 made of them (`answerUserGlobal`): rules kept for all projects, and ended there. */
  kept: string[];
  dropped: string[];
}

/** A new turn's tail (A4 §5.1 as the hook runs it; see the header). */
function answerTurn(
  mem: WrapMemory,
  reads: readonly Read[],
  at: number,
  tails: Map<number, TurnTail>,
  opts: InjectOptions,
  newPrompt: boolean,
  mode: FlagMode,
): Answer {
  const prompt = reads[at]!.typed!;
  const tools = toolsBefore(reads, at);
  const { residual, previousTyped, prev } = conversationBefore(reads, at, prompt);
  // A4 §3.1: what the user just retracted or revoked is invalid from this turn on (typed text only, once).
  if (newPrompt && mem.writable()) mem.forget(recordInvalidations(mem.dir, mem.storableText(prompt)));
  // D12's split, which the triggers read even when a restarted wrap does not encode the turn again.
  const split = promptMessages(prompt, tools);
  const encode = newPrompt ? split : [];
  const typed = split
    .filter((message) => message.src === "user")
    .map((message) => message.content)
    .join("\n");
  // D11, as at the hook's Submit: the user's own words keep or end rules for all projects (P2.4's follow-up). Only a
  // repo's store reads them back (`_user/` under the memory root).
  const global =
    newPrompt && mem.writable() && mem.repoKey && typed
      ? answerUserGlobal(mem.windowsRoot, mem.storableText(typed), memoryNow(), answerPlace(mem))
      : { kept: [], dropped: [], acknowledged: [] };
  const cue = [{ role: "user", content: prompt, ...(opts.paths?.length ? { open_files: [...opts.paths] } : {}) }];
  const mood = turnMode(prompt, { previousAssistant: prev });
  // A7 §3: the request's paths have no repo top to be read against, so `q_path` holds their basenames.
  const situation = situationCue(
    { turn: previousTyped, path: pathCue(opts.paths ?? []), prev, delivered: packetsBefore(tails, at) },
    mood,
  );
  let notes: MemoryRecord[] = [];
  // X7: an `off` point answers nothing, but the turn is still encoded.
  if (isAnswered(mood) && mode !== "off") notes = mem.recall(cue, encode, undefined, { situation, typed });
  else mem.observeCue(cue, undefined, encode);
  const invalid = readInvalidations(mem.dir);
  const parts = { ...gateParts(prompt, previousTyped, situation), requests: mem.gateMode() === "on" };
  const against = { prompt, parts, residual, invalid };
  const { live, tokens } = heldBefore(reads, tails, at, mode);
  const novelty = (fresh: MemoryRecord[]) => novelNotes(fresh, live, { repo: mem.repoKey, invalid });
  const selected: { notes: MemoryRecord[]; drops?: DeliveryDrops } = notes.length
    ? selectNotes(notes, against, novelty)
    : { notes: [] };
  const allowed = withinBudget(selected.notes, tokens);
  // D11: a kept proposal's acknowledgement leads; it states nothing the store retrieves.
  const { packet, delivered } = packetOf(shapePacket([...global.acknowledged, ...allowed]), memoryNow());
  let extra: string | undefined;
  try {
    extra = opts.extra?.();
  } catch {}
  const shown = mode === "on" ? packet : "";
  const tail: TurnTail = {
    texts: [shown, extra ?? ""].filter(Boolean),
    given: delivered.flatMap((note) => deliveredKeys(note, mem.repoKey)),
    tokens: packet ? packetTokens(packet) : 0,
    mode,
  };
  const budget = selected.notes.length - allowed.length;
  return {
    tail,
    prompt,
    turnMode: mood,
    ids: delivered.map((note) => String(note.id ?? "")),
    drops: { ...selected.drops, budget, shape: allowed.length - delivered.length },
    tokensEpoch: tokens,
    said: encode.filter((message) => message.src === "user").map((message) => message.content),
    kept: global.kept,
    dropped: global.dropped,
  };
}

/** A conversation's window (see the header): keyed by its first message, which every request repeats. */
function conversationWindow(mem: WrapMemory, reads: readonly Read[]): string | undefined {
  return reads.length ? windowDir(mem.windowsRoot, `wrap-${reads[0]!.key.slice(0, 16)}`) : undefined;
}

/**
 * A new turn in its window's ledger and in a wide event (see the header), as the hook's Submit records it: the turn,
 * `would_preempt` in shadow, then the packet's deliveries. Nothing is written while memory is read-only.
 */
function recordAnswer(
  mem: WrapMemory,
  win: string | undefined,
  reads: readonly Read[],
  at: number,
  answer: Answer,
  ms: number,
): void {
  if (!mem.writable()) return;
  const { tail } = answer;
  const att = reads[at]!.key;
  const off = reads.slice(0, at + 1).reduce((sum, read) => sum + read.bytes, 0);
  const file = ledgerFor(tail.mode);
  let hturn: number | undefined;
  let preempted: string[] = [];
  if (win && file) {
    appendTurn(win, { promptId: att, prompt: answer.prompt, off }, file);
    hturn = humanTurns(win);
    if (file === SHADOW_LEDGER)
      preempted = wouldPreempt(win, [...answer.said, ...answer.said.flatMap(sentencesOf)], hturn, mem.repoKey);
    if (tail.given.length) recordPacket(win, { keys: tail.given, tokens: tail.tokens }, { off, att, ht: hturn }, file);
    if ((statSync(join(win, file), { throwIfNoEntry: false })?.size ?? 0) > WRAP_FOLD_BYTES) foldLedger(win, file);
  }
  appendWideEvent(mem.windowsRoot, {
    t: memoryNow(),
    ev: "wrap",
    point: "deliver.submit",
    mode: tail.mode,
    ...(mem.repoKey ? { repo: mem.repoKey } : {}),
    ...(win ? { win: basename(win) } : {}),
    ...(hturn !== undefined ? { hturn } : {}),
    prompt_id: att,
    prompt_hash: promptHash(answer.prompt),
    submit: "human",
    turn_mode: answer.turnMode,
    cids: tail.given.map((key) => key.cid),
    ids: answer.ids,
    drops: answer.drops,
    ...(answer.kept.length ? { kept: answer.kept } : {}),
    ...(answer.dropped.length ? { dropped: answer.dropped } : {}),
    ...(preempted.length ? { would_preempt: preempted } : {}),
    off,
    tokens_epoch: answer.tokensEpoch,
    ms: Math.round(ms * 100) / 100,
    aborted: false,
  });
}

const TAILS = "tails.jsonl";
/** How often a process looks for other conversations' tails past their hour. */
const SWEEP_MS = 10 * 60_000;
/** How stale a used tail's line may get before it is written again, so the file forgets it an hour unused. */
const RENEW_MS = 10 * 60_000;
let lastSweep = 0;
/** No Stop reaches a wrap window, so its ledger is folded once its log has outgrown a few turns (D25). */
const WRAP_FOLD_BYTES = 32 * 1024;

function isTail(value: unknown): value is TurnTail {
  const tail = record(value);
  return (
    !!tail &&
    Array.isArray(tail.texts) &&
    tail.texts.every((text) => typeof text === "string") &&
    Array.isArray(tail.given) &&
    typeof tail.tokens === "number" &&
    (tail.mode === "on" || tail.mode === "shadow" || tail.mode === "off")
  );
}

/** The tails a window keeps that were used within the hour, each with when its line was last written. */
function storedTails(win: string | undefined, now: number): Map<string, { tail: TurnTail; t: number }> {
  const out = new Map<string, { tail: TurnTail; t: number }>();
  if (!win) return out;
  for (const entry of windowRecords(win, TAILS)) {
    const { key, t, tail } = entry;
    if (typeof key === "string" && typeof t === "number" && now - t <= TURN_TTL_MS && isTail(tail))
      out.set(key, { tail, t });
  }
  return out;
}

/**
 * Keeps a turn's tail in its window (X11: packet text, kept until it has gone an hour unused, as the memo keeps it).
 * A file holding a line past its hour is rewritten with only each live tail's newest line; other conversations'
 * files untouched for an hour are removed.
 */
function storeTail(mem: WrapMemory, win: string | undefined, key: string, tail: TurnTail, now: number): void {
  if (!win) return;
  const entry = { k: "tail", key, t: now, tail };
  const expired = windowRecords(win, TAILS).some(
    (record) => typeof record.t !== "number" || now - record.t > TURN_TTL_MS,
  );
  if (!expired) appendRecords(win, TAILS, [entry]);
  else {
    const kept = [...storedTails(win, now)].flatMap(([k, line]) =>
      k === key ? [] : [{ k: "tail", key: k, t: line.t, tail: line.tail }],
    );
    writeFileAtomic(join(win, TAILS), [...kept, entry].map((line) => `${JSON.stringify(line)}\n`).join(""), 0o600);
  }
  mem.turns.stamp(key, now);
  if (now - lastSweep >= SWEEP_MS) {
    lastSweep = now;
    sweepTails(join(mem.windowsRoot, "windows"), now);
  }
}

/** Writes a used tail's line again once it is 10 minutes old, so the file's hour counts from its last use. */
function keepTail(mem: WrapMemory, win: string | undefined, key: string, tail: TurnTail, now: number): void {
  const stamped = mem.turns.stampedAt(key);
  if (stamped === undefined || now - stamped >= RENEW_MS) storeTail(mem, win, key, tail, now);
}

/** Removes the tails of wrap conversations untouched for longer than their hour. */
function sweepTails(windows: string, now: number): void {
  for (const name of readdirSync(windows).filter((entry) => entry.startsWith("wrap-"))) {
    const file = join(windows, name, TAILS);
    const touched = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (touched !== undefined && now - touched > TURN_TTL_MS) rmSync(file, { force: true });
  }
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

/** A message with texts appended at its tail, in its own content shape. */
function withTail(message: Message, texts: readonly string[]): Message {
  if (Array.isArray(message.parts))
    return { ...message, parts: [...message.parts, ...texts.map((text) => ({ text }))] };
  const content = message.content;
  if (Array.isArray(content))
    return { ...message, content: [...content, ...texts.map((text) => ({ type: "text", text }))] };
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
  // A turn's first request ends with its human message; one that follows it is a tool-loop step. The message is
  // encoded and its forgets recorded at every opening (A4 §5.1 step 1): a new conversation may open with the words
  // an earlier one did, and a retry says nothing a store does not already hold.
  const opening = last === reads.length - 1;
  const fresh = freshness(mem, reads, opening ? last : undefined);
  const win = conversationWindow(mem, reads);
  let stored: ReturnType<typeof storedTails> | undefined;
  const tails = new Map<number, TurnTail>();
  for (const h of humans) {
    if (h === last && opening) continue;
    const key = reads[h]!.key;
    let tail = mem.turns.tail(key, now);
    // A restarted wrap finds the tails it attached in the conversation's window (see the header).
    const line = tail ? undefined : (stored ??= storedTails(win, now)).get(key);
    if (line) {
      tail = line.tail;
      mem.turns.setTail(key, tail, now);
      mem.turns.stamp(key, line.t);
    }
    if (!tail) continue;
    tails.set(h, tail);
    if (mem.writable())
      try {
        keepTail(mem, win, key, tail, now);
      } catch {}
  }
  let encoded = encodeNew(mem, reads, 0, last, fresh);
  if (last < reads.length && !tails.has(last)) {
    const started = performance.now();
    const mode = resolveFlags(process.cwd())["deliver.submit"].mode;
    const answer = answerTurn(mem, reads, last, tails, opts, opening, mode);
    if (opening && mem.writable()) mem.turns.markEncoded(reads[last]!.key);
    mem.turns.setTail(reads[last]!.key, answer.tail, now);
    tails.set(last, answer.tail);
    // Each write fails open on its own: the tail is already in the memo, and the request goes out with it.
    if (mem.writable()) {
      try {
        storeTail(mem, win, reads[last]!.key, answer.tail, now);
      } catch {}
      try {
        recordAnswer(mem, win, reads, last, answer, performance.now() - started);
      } catch {}
    }
  }
  encoded += encodeNew(mem, reads, last, reads.length, fresh);
  if (encoded || opening) mem.noteActivity();
  let out: unknown[] | undefined;
  for (const [h, tail] of tails) {
    if (!tail.texts.length || reads[h]!.tailed) continue;
    out ??= messages.slice();
    out[h] = withTail(record(messages[h])!, tail.texts);
  }
  return out ?? (messages as unknown[]);
}

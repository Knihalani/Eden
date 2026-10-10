import { homedir } from "node:os";
import { basename, join } from "node:path";
import { redact } from "@eden/ir";
import { authoredTexts, splitPastes, type TextSource } from "../../../src/memory-authority";
import { childSessionName, openMemory, type MemoryRecord } from "../../../src/index";
import { GistStore, scrubTombstonedIdentity } from "../../../src/gist-store";
import { memoryConsent } from "../../../src/memory-consent";
import { packetOf, shapePacket } from "../../../src/memory-hook-packet";
import { tripIfOverBudget, takeNotice } from "../../../src/memory-breaker";
import { appendWideEvent, errorTag, retainEvents, type WideEvent } from "../../../src/memory-events";
import { flagModes, pointOf, resolveFlags, type FlagMode, type FlagState } from "../../../src/memory-flags";
import { batchRecord } from "../../../src/memory-batch";
import { encodeDelta } from "../../../src/memory-delta";
import {
  epochTokens,
  foldWindow,
  humanTurns,
  ledgerKey,
  liveDeliveries,
  novelNotes,
  packetTokens,
  recordPacket,
  startEpoch,
  withinBudget,
  wouldPreempt,
} from "../../../src/memory-ledger";
import { isPinnedIntention, selectNotes } from "../../../src/memory-delivery";
import { recentConversation, sentencesOf, type RecentConversation } from "../../../src/memory-residual";
import { tailLines } from "../../../src/memory-transcript";
import { type ProvenanceNote } from "../../../src/memory-provenance";
import { readableStore, repoIdentity, repoStoreDir, swapping, type RepoIdentity } from "../../../src/memory-repo";
import { nonHumanKind, promptHash, turnMode } from "../../../src/memory-turn";
import { readInvalidations, recordInvalidations, validText, withoutForgets } from "../../../src/memory-validity";
import {
  appendTurn,
  compactContext,
  cronHashes,
  existingLedgers,
  ledgerFor,
  readLastAssistant,
  recordBatch,
  recordCrons,
  recordStart,
  startCwd,
  transcriptOffset,
  windowDir,
  writeLastAssistant,
  type LedgerFile,
} from "../../../src/memory-window";
import { lightSleep } from "../../../src/sleep";
import { memoryNow } from "../../../src/memory-clock";
import { parseHookToolTraces, persistToolTraces } from "../../../src/tool-trace";
import { noteRepoActivity, spawnIdleSleeper } from "./memory-sleep";

const MEMORY_EVENTS = new Set([
  "UserPromptSubmit",
  "SessionStart",
  "PreCompact",
  "Stop",
  "SessionEnd",
  "PostToolUse",
  "PostToolBatch",
  "SubagentStop",
]);

/**
 * Which of Stop's two handlers runs (D34, A4 §5.7): the plugin registers a sync `stop-fast` and an async
 * `stop-sleep`. A host that runs one Stop hook passes no stage, and gets both, in order.
 */
export type HookStage = "stop-fast" | "stop-sleep";

function hookMemory(opts: { dir: string; session?: string; child: boolean; cwd?: string }) {
  return openMemory({ ...opts, perRepo: true });
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenContent).filter(Boolean).join("\n");
  const o = asRec(content);
  const field = o.text ?? o.content ?? o.stdout ?? o.stderr ?? o.output ?? o.message ?? o.error ?? o.llmContent;
  // A nested result (the Agent tool's `content` blocks) is read through, never stored as "[object Object]".
  return field == null ? "" : typeof field === "object" ? flattenContent(field) : String(field);
}

/** SessionStart briefs the 3 latest valid gists, looking through at most 12. */
const BRIEFED_GISTS = 3;
const GIST_SCAN = 12;

function additional(event: string, packet: string): Record<string, unknown> | null {
  return packet
    ? { additional_context: packet, hookSpecificOutput: { hookEventName: event, additionalContext: packet } }
    : null;
}

/**
 * SessionStart's packet: the newest pinned rules (not after a compaction, A4 §5.2), then the 3 latest gists, each
 * still valid (A4 §5.1 step 5, before any selection). Until the store is per repo (P0.5), gists are the only memory
 * one session passes to the next, so D23's pins-only briefing waits for P2.5.
 */
function briefing(mem: ReturnType<typeof openMemory>, session = "", pins = true): ProvenanceNote[] {
  const seen = new Set<string>(),
    notes: ProvenanceNote[] = [],
    invalid = readInvalidations(mem.dir),
    add = (note: ProvenanceNote): boolean => {
      let text = validText(String(note.text ?? ""), note.at, invalid);
      try {
        text = scrubTombstonedIdentity(text, mem.dir).trim();
      } catch {}
      if (!text || seen.has(text.toLowerCase())) return false;
      seen.add(text.toLowerCase());
      notes.push({ ...note, text });
      return true;
    };
  if (pins)
    mem
      .memories()
      .filter(isPinnedIntention)
      .sort((a, b) => Number(b.kind === "constraint") - Number(a.kind === "constraint") || b.at - a.at)
      .slice(0, 8)
      .forEach(add);
  try {
    let gists = 0;
    for (const g of new GistStore(mem.dir).latest(session || "", GIST_SCAN, { excludeSrc: "experience" })) {
      if (gists >= BRIEFED_GISTS) break;
      if (add({ text: g.text, kind: "gist", tags: ["gist"], at: g.t })) gists++;
    }
  } catch {}
  return notes;
}

/**
 * Renders a packet and records what it delivered in the ledger (A4 §4): the notes whose bullet made it into the 900
 * bytes, and the packet's tokens. In shadow the ledger is the shadow one, and the caller prints nothing. A ledger that
 * cannot be written leaves the packet as it is. Returns the packet, the cids it delivered and their rows' ids.
 */
function deliver(
  notes: readonly ProvenanceNote[],
  ledger: Ledger | undefined,
  at: { off: number; att: string; repo?: string },
): { packet: string; cids: string[]; ids: string[] } {
  const { packet, delivered } = packetOf(notes, memoryNow());
  const keys = delivered.map((note) => ledgerKey(note, at.repo));
  if (delivered.length && ledger)
    try {
      const moment = { off: at.off, att: at.att, ht: humanTurns(ledger.dir) };
      recordPacket(ledger.dir, { keys, tokens: packetTokens(packet) }, moment, ledger.file);
    } catch {}
  return { packet, cids: keys.map((key) => key.cid), ids: delivered.map((note) => String(note.id ?? "")) };
}

/**
 * What a prompt gives `observe` (D12): the user's own words, without its forgets (A6 §3), and each pasted span as
 * a `paste` episode.
 */
function promptMessages(prompt: string, tools: readonly string[]): TranscriptMessage[] {
  const { own, pasted } = splitPastes(prompt, tools);
  const said = withoutForgets(own);
  return [
    ...(said ? [{ role: "user", content: said, src: "user" as const }] : []),
    ...pasted.map((content) => ({ role: "user", content, src: "paste" as const })),
  ];
}

/** The memory root: `EDEN_MEMORY_DIR`, else `$EDEN_HOME/memory`, else `~/.eden/memory`. */
export function memoryRoot(): string {
  if (process.env.EDEN_MEMORY_DIR) return process.env.EDEN_MEMORY_DIR;
  return process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : join(homedir(), ".eden", "memory");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

const PROMPT_KEYS = [
  "prompt",
  "text",
  "input",
  "message",
  "body",
  "query",
  "user_message",
  "response",
  "last_user_message",
  "user_text",
  "content",
] as const;

/** The prompt an event carries: UserPromptSubmit's `prompt`, or the first prompt-like field of another shape. */
function promptOf(r: Record<string, unknown>): string {
  return PROMPT_KEYS.map((key) => str(r[key])).find(Boolean) ?? "";
}

/** A transcript message as `observe` reads it, with its source (A6 §2.1) when the transcript shows it. */
type TranscriptMessage = { role: string; content: string; src?: TextSource };

/** The tool results the paste rule compares a prompt with (A6 §2.1: the last 10 tool calls). */
const RECENT_TOOL_RESULTS = 10;

/** Claude Code's transcript entries; a line of another shape is read by its role alone (`genericMessage`). */
const CLAUDE_ENTRIES = new Set(["user", "assistant", "attachment"]);

/** How much of a transcript a host without a window mark reads again: the delta encoder's first read. */
const REREAD_BYTES = 256 * 1024;

/**
 * The messages at the end of a transcript (its last 256 KB) by source (D12, `authoredTexts`): what the user typed,
 * the spans they pasted, tool results, and the agent's text. Host text (meta lines, wrappers, non-human submits) is
 * left out. For a host with no window mark (`encodeConversation`).
 */
export function messagesFromTranscript(path: string): TranscriptMessage[] {
  try {
    const out: TranscriptMessage[] = [];
    const tools: string[] = [];
    for (const line of path ? tailLines(path, REREAD_BYTES) : []) {
      try {
        const o = asRec(line);
        if (!CLAUDE_ENTRIES.has(String(o.type))) {
          const generic = genericMessage(o);
          if (generic) out.push(generic);
          continue;
        }
        for (const { src, text } of authoredTexts(o, tools.slice(-RECENT_TOOL_RESULTS))) {
          if (src === "tool") tools.push(text);
          const content = src === "user" ? withoutForgets(text) : text;
          if (content) out.push({ role: src === "agent" ? "assistant" : "user", content, src });
        }
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

/** A line of another host's transcript, by its role: no source is known (`observe` claims none). */
function genericMessage(o: Record<string, unknown>): TranscriptMessage | undefined {
  const msg = asRec(o.message ?? o),
    raw = String(msg.role || o.role || ""),
    role = /^(?:human|user)$/i.test(raw) ? "user" : /^(?:model|ai|assistant)$/i.test(raw) ? "assistant" : "",
    content = flattenContent(msg.content ?? o.content ?? msg.parts);
  return role && content ? { role, content } : undefined;
}

/**
 * The text a SessionStart, Stop or SessionEnd payload carries (`last_assistant_message` and the like): no such event
 * carries what the user typed, so it is the agent's (A6 §2.1).
 */
function agentText(content: string): TranscriptMessage {
  return { role: "assistant", content, src: "agent" };
}

/**
 * The fields a SessionStart, Stop, SubagentStop or SessionEnd payload may carry text in, across hosts: Claude Code
 * sends `last_assistant_message`.
 */
const PAYLOAD_TEXT_KEYS = [
  "prompt",
  "text",
  "input",
  "message",
  "body",
  "query",
  "user_message",
  "prompt_response",
  "response",
  "output",
  "completion",
  "result",
  "answer",
  "reply",
  "last_user_message",
  "user_text",
  "assistant_message",
  "last_assistant_message",
  "final_response",
  "assistant_text",
  "content",
] as const;

function payloadMessages(r: Record<string, unknown>): { role: string; content: string }[] {
  const list = (
    Array.isArray(r.messages)
      ? r.messages
      : Array.isArray(r.conversation)
        ? r.conversation
        : Array.isArray(r.contents)
          ? r.contents
          : []
  ) as unknown[];
  return list.flatMap((m) => {
    const o = asRec(m),
      c = flattenContent(o.content ?? o.parts ?? o),
      raw = String(o.role || ""),
      role =
        raw === "human" || raw === "Human"
          ? "user"
          : raw === "model" || raw === "Model" || raw === "ai" || raw === "AI"
            ? "assistant"
            : raw;
    return (role === "user" || role === "assistant") && c ? [{ role, content: c }] : [];
  });
}

/** What one invocation logs (`memory-events.ts`), filled in as the handler runs. */
type Trace = Omit<WideEvent, "t" | "ms" | "aborted" | "flags">;

/** The window a point records its ledger in, and the ledger file of its mode (X7); none when it is `off`. */
type Ledger = { dir: string; file: LedgerFile };

/**
 * The memory hook for one event. It fails open: whatever throws, it returns null (so nothing is printed). Each
 * invocation appends one wide event, and an exception at an `on` delivery point lets the circuit breaker check that
 * point's budget (`memory-breaker.ts`). With `EDEN_MEMORY=off` it does nothing at all; read-only, it writes nothing.
 */
export function memoryHookResponse(raw: Record<string, unknown>, stage?: HookStage): Record<string, unknown> | null {
  const started = performance.now();
  let writes: boolean, r: Record<string, unknown>, event: string;
  try {
    r = asRec(raw);
    event = String(r.hook_event_name ?? r.hookEventName ?? r.event ?? "");
    const consent = memoryConsent();
    if (consent === "off" || !MEMORY_EVENTS.has(event)) return null;
    // `eden memory migrate` is between its two renames: the root is back in a moment, so nothing is written now.
    if (swapping(memoryRoot())) return null;
    writes = consent === "on";
  } catch {
    return null;
  }
  const trace: Trace = { ev: event };
  let flags: FlagState | undefined;
  let out: Record<string, unknown> | null = null;
  try {
    flags = resolveFlags(str(r.cwd));
    out = respond(r, event, writes, flags, trace, stage);
  } catch (err) {
    trace.err = errorTag(err);
    out = null;
  }
  if (writes) logInvocation(trace, flags, performance.now() - started);
  return out;
}

/** Appends the invocation's wide event; after an exception at a delivery point, the breaker checks its budget. */
function logInvocation(trace: Trace, flags: FlagState | undefined, ms: number): void {
  try {
    const root = memoryRoot(),
      t = memoryNow();
    appendWideEvent(root, {
      t,
      ...trace,
      ...(flags ? { flags: flagModes(flags) } : {}),
      ms: Math.round(ms * 100) / 100,
      aborted: false,
    });
    if (trace.err && trace.point && flags) tripIfOverBudget(root, trace.point, flags, t);
  } catch {}
}

/**
 * The window a hook payload belongs to (D2): its session, or `session--agent` in a subagent (`child`), and the
 * session it runs in (`parent`).
 */
function resolveSession(
  r: Record<string, unknown>,
  event: string,
): { session?: string; parent?: string; child: boolean } {
  try {
    const parent = [
        r.session_id,
        r.sessionID,
        r.sessionId,
        r.parent_session_id,
        process.env.EDEN_MEMORY_PARENT,
        process.env.EDEN_MEMORY_SESSION,
      ]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find(Boolean),
      childId = [r.agent_id, r.agentId, r.subagent_id, r.subagentId, r.child_session_id, process.env.EDEN_MEMORY_CHILD]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find(Boolean);
    const asChild = event === "SubagentStop" || !!(childId && childId !== parent),
      session = asChild ? childSessionName(parent, childId || "sub") : parent;
    return { session: asChild && session ? session : parent, parent, child: !!(asChild && session) };
  } catch {
    return { child: false };
  }
}

/**
 * The repo of an event (D1). Outside git it is the directory the session started in: SessionStart records it in
 * the session's window (`starting`), and later events, a subagent's included, read it back.
 */
function eventRepo(cwd: string, sessionWin: string | undefined, starting: boolean): RepoIdentity | undefined {
  const repo = repoIdentity(cwd, () => (starting || !sessionWin ? undefined : startCwd(sessionWin)));
  if (repo && !repo.top && starting && sessionWin)
    try {
      recordStart(sessionWin, cwd);
    } catch {}
  return repo;
}

/** The breaker's notice as a message to the user (`systemMessage`), beside whatever the point delivers. */
function withNotice(out: Record<string, unknown> | null, notice: string | undefined): Record<string, unknown> | null {
  return notice ? { ...(out ?? {}), systemMessage: notice } : out;
}

/** What every event's handler reads: the payload, the store and the window it belongs to. */
interface HookContext {
  r: Record<string, unknown>;
  event: string;
  writes: boolean;
  flags: FlagState;
  trace: Trace;
  mem: ReturnType<typeof hookMemory>;
  store: string;
  /** The repo key (D1): its first 8 characters prefix the ledger's cids. */
  repo?: string;
  /** The window (D2) and its session, and the session it runs in. */
  win?: string;
  session?: string;
  child: boolean;
  transcriptPath: string;
  /** The delivery point's mode; undefined at an event that delivers nothing. */
  mode?: FlagMode;
  ledgerOf: (mode: FlagMode | undefined) => Ledger | undefined;
}

/** The transcript a payload names. */
function transcriptOf(r: Record<string, unknown>): string {
  return str(r.transcript_path) ?? str(r.transcriptPath) ?? "";
}

/** The `prompt_id` a payload carries, for the rows its text becomes (A4 §3.3: a rewind takes them back). */
function promptIdOf(r: Record<string, unknown>): { promptId?: string } {
  const promptId = str(r.prompt_id);
  return promptId ? { promptId } : {};
}

/** A payload's text fields (`last_assistant_message` and the like), joined: what a non-Submit event says. */
function payloadText(r: Record<string, unknown>): string {
  return PAYLOAD_TEXT_KEYS.map((key) => r[key])
    .filter((value): value is string => typeof value === "string" && !!value)
    .join("\n");
}

/** How many of a host's re-read messages are encoded again, when it has no window mark (before P0.6, every host). */
const REREAD_MESSAGES = 40;

/**
 * A4 §3.3: encodes what the conversation added since the window's mark (`memory-delta.ts`), and takes back what a
 * rewind abandoned. A host that sends the conversation in its payload, or names no session, has no mark: its last 40
 * messages are read again (`reread`), as every host's were before P0.6.
 */
function encodeConversation(ctx: HookContext): void {
  const { transcriptPath } = ctx;
  const sent = payloadMessages(ctx.r);
  if (!sent.length && ctx.win && transcriptPath) {
    const delta = encodeDelta(ctx.win, transcriptPath, ({ messages, abandoned, branchTexts }) => {
      if (messages.length) ctx.mem.observe(messages, { keepLiveIdentity: true, deferSleep: true });
      if (abandoned.length) ctx.mem.abandon(abandoned, branchTexts);
    });
    if (delta?.messages.length) ctx.trace.encoded = delta.messages.length;
    if (delta?.abandoned.length) ctx.trace.abandoned = delta.abandoned.length;
    return;
  }
  const prior = (sent.length ? sent : messagesFromTranscript(transcriptPath)).slice(-REREAD_MESSAGES);
  const keepLiveIdentity = ctx.event === "Stop" || ctx.event === "SessionEnd" || ctx.event === "SessionStart";
  if (prior.length) ctx.mem.observe(prior, { keepLiveIdentity, reread: true, deferSleep: true });
}

/** Encodes what an event's payload says as the agent's newest text (`last_assistant_message`, A4 §3.3). */
function encodePayloadText(ctx: HookContext): void {
  const said = payloadText(ctx.r);
  if (said)
    ctx.mem.observe([{ ...agentText(said), ...promptIdOf(ctx.r) }], { keepLiveIdentity: true, deferSleep: true });
}

/**
 * Sync `stop-fast` (D34, A4 §5.7): what the next Submit must find, written before it can start: the agent's last
 * message (`qprev.json`) and the session's crons (D24). It opens no store.
 */
function stopFast(r: Record<string, unknown>, win: string | undefined): void {
  if (!win) return;
  try {
    recordCrons(win, r.session_crons);
  } catch {}
  const text = str(r.last_assistant_message);
  if (text) writeLastAssistant(win, { t: memoryNow(), text });
}

/**
 * Async `stop-sleep` (D34, A4 §5.7), and SessionEnd: the delta and the agent's last message are encoded, the light
 * sleep runs, `ctx.log` is compacted, the window's ledger folded into its snapshot (D25), day files of `hook.log.d`
 * past their 90 days aggregated (X11), and the idle sleeper is started for the rest. SessionEnd shares a 1.5 s budget
 * (R0), so it does the same light work and leaves the full sleep to the idle sleeper too.
 */
function sleepAfterTurn(ctx: HookContext): void {
  inTurn(
    () => encodeConversation(ctx),
    () => encodePayloadText(ctx),
    () => lightSleep(ctx.mem, ctx.session),
    () => ctx.win && compactContext(ctx.win),
    () => ctx.win && foldWindow(ctx.win),
    () => retainEvents(memoryRoot(), memoryNow()),
    () => spawnIdleSleeper(ctx.store, ctx.session),
  );
}

/** Runs each step of a handler in order; one that throws is skipped, never the steps after it (fail open). */
function inTurn(...steps: (() => unknown)[]): void {
  for (const step of steps)
    try {
      step();
    } catch {}
}

/**
 * A PostToolUse (hosts other than the plugin, which records batches): the result is encoded from the payload.
 * Returns whether the payload carried one.
 */
function toolResult(ctx: HookContext, tool = "tool"): boolean {
  const { r, mem } = ctx;
  const name = [r.tool_name, r.toolName, r.tool].find((x) => typeof x === "string" && String(x).trim()) as
    string | undefined;
  const original = r.tool_response ?? r.tool_output ?? r.result ?? r.output;
  const result = flattenContent(original == null || original === "" ? "" : redact(original));
  if (result)
    mem.observe([{ role: "user", content: `The ${name || tool} tool result is ${result}.`, src: "tool" }], {
      deferSleep: true,
    });
  try {
    persistToolTraces(mem.jsonlDir, parseHookToolTraces(r));
  } catch {}
  return !!result;
}

/**
 * PostToolBatch (A4 §5.5): one `ctx.log` record for the batch (`memory-batch.ts`), its tool traces, and the main
 * window's delta. A subagent's lines are its own transcript's, which SubagentStop encodes.
 */
function toolBatch(ctx: HookContext): void {
  inTurn(
    () => ctx.win && recordBatch(ctx.win, batchRecord(ctx.r)),
    () => persistToolTraces(ctx.mem.jsonlDir, parseHookToolTraces(ctx.r)),
    () => {
      if (!ctx.child) encodeConversation(ctx);
    },
  );
}

/**
 * SubagentStop (A4 §5.7b): the subagent's last message, or the result a host sends as a tool result, encoded once,
 * and the child window's ledger folded (D25).
 * Its own transcript is not encoded yet: what it holds reaches the parent as the Agent call and its result, which
 * the parent's delta encodes, and until P1.3's shadow set a child's rows come back to the parent as bullets it
 * already holds (`redundant_rate` +4.42 pp in P0.6's guard runs).
 */
function subagentStop(ctx: HookContext): void {
  let asTool = false;
  inTurn(
    () => (asTool = toolResult(ctx, "subagent")),
    () => {
      if (!asTool) encodePayloadText(ctx);
    },
    () => ctx.win && foldWindow(ctx.win),
  );
}

function sessionStart(ctx: HookContext): Record<string, unknown> | null {
  const { r, writes, win, mode, flags, mem, trace } = ctx;
  if (writes)
    inTurn(
      () => encodeConversation(ctx),
      () => encodePayloadText(ctx),
    );
  // The breaker's notice is for the user, not a delivery: it goes out unless the point is off (identity).
  let notice: string | undefined;
  if (writes && mode !== "off")
    try {
      notice = takeNotice(memoryNow());
    } catch {}
  // A4 §5.2: a resumed session still holds the packets it had (R0 F5), so resume brings nothing new and keeps
  // the ledger. A compaction re-arms (a new epoch, A4 §4): its pins come back on their next cue, not here.
  // The gists, the legacy carrier between sessions, stay at every other SessionStart until P2.5.
  // `/clear` opens a new session: a new window, with an empty ledger.
  const off = transcriptOffset(ctx.transcriptPath),
    ledger = ctx.ledgerOf(mode),
    compact = r.source === "compact";
  if (r.source === "resume") return withNotice(null, notice);
  // The epoch belongs to the window: each ledger it has, and each a built point writes in its mode, starts one,
  // so a point that turned from on to shadow re-arms what it delivered live (A4 §4).
  if (compact && win && writes) {
    const modes = [mode, flags["deliver.submit"].mode].flatMap((m) => ctx.ledgerOf(m)?.file ?? []);
    for (const file of new Set([...existingLedgers(win), ...modes]))
      try {
        startEpoch(win, "compact", off, file);
      } catch {}
  }
  if (mode === "off") return withNotice(null, notice);
  const briefed = briefing(mem, ctx.session, !compact);
  const { packet, cids, ids } = deliver(briefed, ledger, { off, att: "", repo: ctx.repo });
  Object.assign(trace, { cids, ids, drops: { shape: briefed.length - cids.length } });
  return withNotice(mode === "on" ? additional(ctx.event, packet) : null, notice);
}

/**
 * The agent's last message, A7 §3's `q_prev` source: `qprev.json` from `stop-fast`, unless the transcript's tail
 * holds a newer assistant line (an interrupt, or a lost race: A4 §5.7).
 */
function previousAssistant(win: string | undefined, recent: RecentConversation): string {
  const saved = win ? readLastAssistant(win) : undefined;
  const tail = recent.lastAssistant;
  return saved && (!tail || tail.t <= saved.t) ? saved.text : (tail?.text ?? "");
}

/** UserPromptSubmit (A4 §5.1), and PreCompact, which a host maps here (`hook.ts`): answered as a Submit would be. */
function submit(ctx: HookContext): Record<string, unknown> | null {
  const { r, event, writes, win, mem, trace, flags, mode, transcriptPath } = ctx;
  const prompt = promptOf(r),
    off = transcriptOffset(transcriptPath),
    att = str(r.prompt_id) || `${promptHash(prompt)}@${off}`,
    human = event === "UserPromptSubmit",
    ledger = human ? ctx.ledgerOf(mode) : undefined,
    // PreCompact has no point of its own: `deliver.submit` decides; it writes no ledger.
    answer = human ? mode : flags["deliver.submit"].mode;
  if (ledger)
    try {
      appendTurn(ledger.dir, { promptId: att, prompt, off }, ledger.file);
    } catch {}
  // A4 §5.1 step 1: the delta before the prompt (which `recall` encodes after retrieving), so what the prompt
  // states is newer than every transcript line it supersedes, and a forget below reaches the delta's rows too.
  if (writes) inTurn(() => encodeConversation(ctx));
  const recent = recentConversation(transcriptPath, prompt);
  const prev = previousAssistant(win, recent),
    turn = human ? turnMode(prompt, { previousAssistant: prev }) : "imperative",
    cue = [{ role: "user", content: prompt }];
  if (human) {
    Object.assign(trace, { submit: "human", turn_mode: turn, prompt_id: att, prompt_hash: promptHash(prompt), off });
    if (recent.contextTokens !== undefined) trace.ctx_tokens = recent.contextTokens;
    if (win)
      try {
        trace.hturn = humanTurns(win);
      } catch {}
  }
  let notes: MemoryRecord[] = [];
  // A4 §5.1: every human submit is encoded (step 1); the turn mode decides only whether it is answered (step 2),
  // and the point's flag whether it is answered at all (X7: off answers nothing and writes no ledger).
  // A4 §3.1: what the user just retracted or revoked is invalid from this Submit on (A4 §3.0: typed text only).
  // Read after the store's own secret redaction, so the log can hold no token a stored row would not.
  // A typed forget also sends the rows it names to history (A6 §3).
  if (writes && prompt && human) mem.forget(recordInvalidations(mem.dir, mem.storableText(prompt)));
  const encode = promptMessages(prompt, recent.toolResults).map((message) => ({ ...message, ...promptIdOf(r) }));
  if (mode === "shadow" && ledger && trace.hturn !== undefined)
    try {
      const own = encode.filter((m) => m.src === "user").map((m) => m.content);
      const preempted = wouldPreempt(ledger.dir, [...own, ...own.flatMap(sentencesOf)], trace.hturn, ctx.repo);
      if (preempted.length) trace.would_preempt = preempted;
    } catch {}
  if (prompt && turn === "imperative" && answer !== "off") notes = mem.recall(cue, encode);
  else if (prompt) mem.observeCue(cue, undefined, encode);
  if (!notes.length) return null;
  // A4 §5.1: validity (step 5); the gate on episodes the user did not type (step 6, A7 §4); novelty (step 7):
  // what the last turns already say (D26), then what this window was already given (the ledger, which also marks
  // `Updated:` items); the epoch's budget (A4 §4); shape (step 8).
  const parts = { prompt, turn: recent.previousTyped, prev };
  const against = { prompt, parts, residual: recent.residual, invalid: readInvalidations(mem.dir) };
  const { notes: novel, drops } = selectNotes(notes, against, (fresh) =>
    win
      ? novelNotes(fresh, liveDeliveries(win, off, ledger?.file), { repo: ctx.repo, invalid: against.invalid })
      : fresh,
  );
  const tokens = win ? epochTokens(win, ledger?.file) : 0;
  const allowed = withinBudget(novel, tokens);
  const { packet, cids, ids } = deliver(shapePacket(allowed), ledger, { off, att, repo: ctx.repo });
  Object.assign(trace, { cids, ids, tokens_epoch: tokens });
  trace.drops = { ...drops, budget: novel.length - allowed.length, shape: allowed.length - cids.length };
  return answer === "shadow" ? null : additional(event, packet);
}

/** Events that only write: read-only consent leaves them nothing to do. */
const WRITING_EVENTS = new Set(["PostToolUse", "PostToolBatch", "SubagentStop", "Stop", "SessionEnd"]);

function respond(
  r: Record<string, unknown>,
  event: string,
  writes: boolean,
  flags: FlagState,
  trace: Trace,
  stage: HookStage | undefined,
): Record<string, unknown> | null {
  const cwd = str(r.cwd);
  if (!writes && WRITING_EVENTS.has(event)) return null;
  const root = memoryRoot();
  const resolved = resolveSession(r, event);
  const win = windowDir(root, resolved.session ?? ""),
    sessionWin = windowDir(root, resolved.parent ?? ""),
    prompt = promptOf(r),
    point = pointOf(event),
    mode = point ? flags[point].mode : undefined,
    repo = eventRepo(cwd ?? process.cwd(), sessionWin, event === "SessionStart" && writes && !resolved.child);
  Object.assign(trace, {
    ...(point ? { point, mode } : {}),
    ...(repo ? { repo: repo.key } : {}),
    ...(win ? { win: basename(win) } : {}),
    ...(stage ? { stage } : {}),
  });
  if (event === "Stop" && stage !== "stop-sleep") {
    stopFast(r, win);
    if (stage === "stop-fast") return null;
  }
  // D24, A4 §5.1 step 0: a non-human submit gets nothing, before any store is opened. Its wide event names the rule
  // it matched, so the live shape of each kind can be checked from ids alone (R0 F34).
  const nonHuman = event === "UserPromptSubmit" ? nonHumanKind(prompt, win ? cronHashes(win) : []) : undefined;
  if (nonHuman) {
    const promptId = str(r.prompt_id);
    Object.assign(trace, {
      submit: "non-human",
      nonhuman: nonHuman.kind,
      ...(nonHuman.preamble ? { preamble: true } : {}),
      ...(promptId ? { prompt_id: promptId } : {}),
      prompt_hash: promptHash(prompt),
    });
    if (win)
      try {
        trace.hturn = humanTurns(win);
      } catch {}
    return null;
  }
  const store = repo && repoStoreDir(root, repo.key);
  // EXECUTION §9: a store in a format this code does not know is never read or written.
  if (!store || !readableStore(store)) return null;
  if (writes)
    try {
      noteRepoActivity(store);
    } catch {}
  const mem = hookMemory({ dir: store, session: resolved.session, child: resolved.child, cwd });
  const ctx: HookContext = {
    r,
    event,
    writes,
    flags,
    trace,
    mem,
    store,
    repo: repo?.key,
    win,
    session: resolved.session,
    child: resolved.child,
    transcriptPath: transcriptOf(r),
    mode,
    /** The ledger this point writes: none when it is off or read-only. */
    ledgerOf: (m) => {
      const file = m && writes && win ? ledgerFor(m) : undefined;
      return file && win ? { dir: win, file } : undefined;
    },
  };
  try {
    if (event === "PostToolUse") toolResult(ctx);
    else if (event === "PostToolBatch") toolBatch(ctx);
    else if (event === "SubagentStop") subagentStop(ctx);
    else if (event === "Stop" || event === "SessionEnd") sleepAfterTurn(ctx);
    else if (event === "SessionStart") return sessionStart(ctx);
    else return submit(ctx);
    return null;
  } finally {
    try {
      mem.close();
    } catch {}
  }
}

/** The stage a handler names on its command line (`hooks.json`), if any. */
function stageOf(arg: string | undefined): HookStage | undefined {
  return arg === "stop-fast" || arg === "stop-sleep" ? arg : undefined;
}

export async function runMemoryHookStdin(arg?: string): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(
      (await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (c) => chunks.push(c as Buffer));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        if (process.stdin.isTTY) resolve("{}");
      })) || "{}",
    ) as Record<string, unknown>;
  } catch {}
  // Fail open (EXECUTION §5): nothing to say prints nothing, and so does an error.
  try {
    const out = memoryHookResponse(body, stageOf(arg));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
}

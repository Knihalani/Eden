import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { redact } from "@eden/ir";
import { authoredTexts, splitPastes, type TextSource } from "../../../src/memory-authority";
import { childSessionName, openMemory, type MemoryRecord } from "../../../src/index";
import { GistStore, scrubTombstonedIdentity } from "../../../src/gist-store";
import { memoryConsent } from "../../../src/memory-consent";
import { declarativeBullet, renderPacket, shapePacket } from "../../../src/memory-hook-packet";
import { tripIfOverBudget, takeNotice } from "../../../src/memory-breaker";
import { appendWideEvent, errorTag, type WideEvent } from "../../../src/memory-events";
import { flagModes, pointOf, resolveFlags, type FlagMode, type FlagState } from "../../../src/memory-flags";
import { ledgerKey, notRefractory, recordDeliveries, startEpoch, wouldPreempt } from "../../../src/memory-ledger";
import { admitNotes } from "../../../src/memory-gate";
import { isResidualNote, recentConversation, residualSentences, sentencesOf } from "../../../src/memory-residual";
import { noteKindToken, type ProvenanceNote } from "../../../src/memory-provenance";
import { readableStore, repoIdentity, repoStoreDir, swapping, type RepoIdentity } from "../../../src/memory-repo";
import { nonHumanKind, promptHash, turnMode } from "../../../src/memory-turn";
import {
  asksHistory,
  isForget,
  readInvalidations,
  recordInvalidations,
  validText,
  withoutForgets,
  type Invalidation,
} from "../../../src/memory-validity";
import {
  appendTurn,
  cronHashes,
  existingLedgers,
  humanTurns,
  ledgerFor,
  recordCrons,
  recordStart,
  startCwd,
  transcriptOffset,
  windowDir,
  type LedgerFile,
} from "../../../src/memory-window";
import { consolidate } from "../../../src/sleep";
import { memoryNow } from "../../../src/memory-clock";
import { parseHookToolTraces, persistToolTraces } from "../../../src/tool-trace";

const MEMORY_EVENTS = new Set([
  "UserPromptSubmit",
  "SessionStart",
  "PreCompact",
  "Stop",
  "SessionEnd",
  "PostToolUse",
  "SubagentStop",
]);

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

const INTENTION_TAG = /^(?:intention|intent|rule|constraint|never|always|must|prefer)$/i;

function isPinnedIntention(r: MemoryRecord): boolean {
  return r.kind === "constraint" || (r.tags ?? []).some((t) => t.toLowerCase() === "pin" || INTENTION_TAG.test(t));
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
 * bytes. In shadow the ledger is the shadow one, and the caller prints nothing. A ledger that cannot be written leaves
 * the packet as it is. Returns the packet and the cids it delivered.
 */
function deliver(
  notes: readonly ProvenanceNote[],
  ledger: Ledger | undefined,
  at: { off: number; att: string },
): { packet: string; cids: string[] } {
  const now = memoryNow();
  const packet = renderPacket(notes, now);
  const delivered = packet ? notes.filter((note) => packet.includes(`\n- ${declarativeBullet(note, now)}`)) : [];
  if (delivered.length && ledger)
    try {
      recordDeliveries(ledger.dir, delivered, { ...at, ht: humanTurns(ledger.dir) }, ledger.file);
    } catch {}
  return { packet, cids: delivered.map((note) => ledgerKey(note).cid) };
}

/**
 * A4 §5.1 step 5: each note without the sentences an invalidation has made invalid; a note left empty is dropped.
 * A rule sentence yields only to a revocation (`validText`). When the cue asks about history, episodes keep what they
 * say (D31 `stale_for`), except what the user asked to forget (A6 §3); facts and rules do not.
 */
function stillValid(notes: MemoryRecord[], invalid: readonly Invalidation[], prompt: string): MemoryRecord[] {
  if (!invalid.length) return notes;
  const history = asksHistory(prompt);
  return notes.flatMap((note) => {
    const kind = noteKindToken(note);
    const episode = kind !== "rule" && kind !== "fact" && !isPinnedIntention(note);
    const text = validText(note.text, note.at, history && episode ? invalid.filter(isForget) : invalid);
    return text ? [{ ...note, text }] : [];
  });
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

/**
 * A transcript's messages by source (D12, `authoredTexts`): what the user typed, the spans they pasted, tool
 * results, and the agent's text. Host text (meta lines, wrappers, non-human submits) is left out.
 */
export function messagesFromTranscript(path: string): TranscriptMessage[] {
  try {
    const out: TranscriptMessage[] = [];
    const tools: string[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      try {
        const o = asRec(JSON.parse(line));
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
export function memoryHookResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
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
    out = respond(r, event, writes, flags, trace);
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

function respond(
  r: Record<string, unknown>,
  event: string,
  writes: boolean,
  flags: FlagState,
  trace: Trace,
): Record<string, unknown> | null {
  const cwd = str(r.cwd);
  if (!writes && (event === "PostToolUse" || event === "SubagentStop" || event === "Stop" || event === "SessionEnd"))
    return null;
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
  });
  /** The ledger this point writes: none when it is off or read-only. */
  const ledgerOf = (m: FlagMode | undefined): Ledger | undefined => {
    const file = m && writes && win ? ledgerFor(m) : undefined;
    return file && win ? { dir: win, file } : undefined;
  };
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
  const mem = hookMemory({ dir: store, session: resolved.session, child: resolved.child, cwd });
  try {
    const transPath =
        typeof r.transcript_path === "string"
          ? r.transcript_path
          : typeof r.transcriptPath === "string"
            ? r.transcriptPath
            : "",
      fromFile = messagesFromTranscript(transPath),
      fromPayload = payloadMessages(r),
      prior = (fromPayload.length ? fromPayload : fromFile).slice(-40);
    if (event === "PostToolUse" || event === "SubagentStop") {
      try {
        const name = [r.tool_name, r.toolName, r.tool].find((x) => typeof x === "string" && String(x).trim()) as
            string | undefined,
          original = r.tool_response ?? r.tool_output ?? r.result ?? r.output,
          result = flattenContent(original == null || original === "" ? "" : redact(original)),
          text = result ? `The ${name || "subagent"} tool result is ${result}.` : "";
        if (text) mem.observe([{ role: "user", content: text, src: "tool" }]);
        else if (event === "SubagentStop" && prior.length) mem.observe(prior, { reread: true });
        try {
          persistToolTraces(mem.jsonlDir, parseHookToolTraces(r));
        } catch {}
      } catch {}
      return null;
    }
    const stop = event === "Stop" || event === "SessionEnd",
      extra = [
        r.prompt,
        r.text,
        r.input,
        r.message,
        r.body,
        r.query,
        r.user_message,
        r.prompt_response,
        r.response,
        r.output,
        r.completion,
        r.result,
        r.answer,
        r.reply,
        r.last_user_message,
        r.user_text,
        r.assistant_message,
        r.last_assistant_message,
        r.final_response,
        r.assistant_text,
        r.content,
      ]
        .filter((x) => typeof x === "string" && x)
        .join("\n");
    if (event === "SessionStart") {
      if (writes && (prior.length || extra))
        try {
          mem.observe(extra ? [...prior, agentText(extra)] : prior, {
            keepLiveIdentity: true,
            reread: true,
          });
        } catch {}
      // The breaker's notice is for the user, not a delivery: it goes out unless the point is off (identity).
      let notice: string | undefined;
      if (writes && mode !== "off")
        try {
          notice = takeNotice(memoryNow());
        } catch {}
      // A4 §5.2: a resumed session still holds the packets it had (R0 F5), so resume brings nothing new and keeps
      // the ledger. A compaction re-arms (a new epoch, A4 §4): its pins come back on their next cue, not here.
      // The gists, the legacy carrier between sessions, stay at every other SessionStart until P0.5 and P2.5.
      // `/clear` opens a new session: a new window, with an empty ledger.
      const off = transcriptOffset(transPath),
        ledger = ledgerOf(mode),
        compact = r.source === "compact";
      if (r.source === "resume") return withNotice(null, notice);
      // The epoch belongs to the window: each ledger it has, and each a built point writes in its mode, starts one,
      // so a point that turned from on to shadow re-arms what it delivered live (A4 §4).
      if (compact && win && writes) {
        const modes = [mode, flags["deliver.submit"].mode].flatMap((m) => ledgerOf(m)?.file ?? []);
        for (const file of new Set([...existingLedgers(win), ...modes]))
          try {
            startEpoch(win, "compact", off, file);
          } catch {}
      }
      if (mode === "off") return withNotice(null, notice);
      const briefed = briefing(mem, resolved.session, !compact);
      const { packet, cids } = deliver(briefed, ledger, { off, att: "" });
      Object.assign(trace, { cids, drops: { shape: briefed.length - cids.length } });
      return withNotice(mode === "on" ? additional(event, packet) : null, notice);
    }
    if (stop) {
      if (writes) {
        if (event === "Stop" && win)
          try {
            recordCrons(win, r.session_crons);
          } catch {}
        // Claude Code cancels SessionEnd hooks after 1.5 s (R0), and the Stop that ended the last turn has just
        // slept over everything up to it, so SessionEnd only encodes; the next sleep takes what it adds.
        const ending = event === "SessionEnd";
        try {
          if (prior.length || extra)
            mem.observe(extra ? [...prior, agentText(extra)] : prior, {
              keepLiveIdentity: true,
              reread: true,
              deferSleep: ending,
            });
        } catch {}
        if (!ending)
          try {
            consolidate(mem, { session: resolved.session, mode: "full" });
          } catch {}
      }
      return null;
    }
    const off = transcriptOffset(transPath),
      att = str(r.prompt_id) || `${promptHash(prompt)}@${off}`,
      submit = event === "UserPromptSubmit",
      ledger = submit ? ledgerOf(mode) : undefined,
      // PreCompact has no point of its own: a host that maps its compaction event here (hook.ts) is answered as a
      // Submit would be, so `deliver.submit` decides; it writes no ledger.
      answer = submit ? mode : flags["deliver.submit"].mode;
    if (ledger)
      try {
        appendTurn(ledger.dir, { promptId: att, prompt, off }, ledger.file);
      } catch {}
    const previousAssistant = prior.findLast((m) => m.role === "assistant")?.content ?? "",
      turn = submit ? turnMode(prompt, { previousAssistant }) : "imperative",
      cue = [{ role: "user", content: prompt }];
    if (submit) {
      Object.assign(trace, { submit: "human", turn_mode: turn, prompt_id: att, prompt_hash: promptHash(prompt) });
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
    if (writes && prompt && submit) mem.forget(recordInvalidations(mem.dir, mem.storableText(prompt)));
    // The conversation so far is encoded before the prompt (which `recall` encodes after retrieving), so what the
    // prompt states is newer than every transcript line it supersedes.
    if (writes && prior.length) mem.observe(prior, { reread: true });
    const tools = fromFile.filter((m) => m.src === "tool").map((m) => m.content),
      encode = promptMessages(prompt, tools.slice(-RECENT_TOOL_RESULTS));
    if (mode === "shadow" && ledger && trace.hturn !== undefined)
      try {
        const own = encode.filter((m) => m.src === "user").map((m) => m.content);
        const preempted = wouldPreempt(ledger.dir, [...own, ...own.flatMap(sentencesOf)], trace.hturn);
        if (preempted.length) trace.would_preempt = preempted;
      } catch {}
    if (prompt && turn === "imperative" && answer !== "off") notes = mem.recall(cue, encode);
    else if (prompt) mem.observeCue(cue, undefined, encode);
    if (!notes.length) return null;
    // A4 §5.1: validity (step 5); the gate on episodes the user did not type (step 6, A7 §4); novelty (step 7):
    // what the last turns already say (D26), then what this window was already given (the ledger); shape (step 8).
    const recent = recentConversation(transPath, prompt);
    const parts = { prompt, turn: recent.previousTyped, prev: previousAssistant };
    const residual = residualSentences(recent.residual);
    const valid = stillValid(notes, readInvalidations(mem.dir), prompt);
    const admitted = admitNotes(valid, parts);
    let novel = admitted.filter((note) => !isResidualNote(note, residual));
    const fresh = novel.length;
    if (win) novel = notRefractory(win, novel, { size: off, transcriptPath: transPath }, ledger?.file);
    const { packet, cids } = deliver(shapePacket(novel), ledger, { off, att });
    trace.cids = cids;
    trace.drops = {
      validity: notes.length - valid.length,
      gate: valid.length - admitted.length,
      residual: admitted.length - fresh,
      refractory: fresh - novel.length,
      shape: novel.length - cids.length,
    };
    return answer === "shadow" ? null : additional(event, packet);
  } finally {
    try {
      mem.close();
    } catch {}
  }
}

export async function runMemoryHookStdin(): Promise<void> {
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
    const out = memoryHookResponse(body);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
}

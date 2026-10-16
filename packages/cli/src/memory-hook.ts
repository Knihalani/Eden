import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { redact } from "@eden/ir";
import { authoredTexts, splitPastes, type TextSource } from "../../../src/memory-authority";
import { isLiveRow, openMemory, storeRows, type MemoryRecord } from "../../../src/index";
import { lastSessionDeliveries, lastSessionWindow, noteLastSession, updatedItems } from "../../../src/memory-updates";
import { GistStore, scrubTombstonedIdentity } from "../../../src/gist-store";
import { memoryConsent } from "../../../src/memory-consent";
import { packetOf, shapePacket } from "../../../src/memory-hook-packet";
import { takeNotice } from "../../../src/memory-breaker";
import { errorTag, retainEvents } from "../../../src/memory-events";
import { pointOf, resolveFlags, type FlagMode, type FlagState } from "../../../src/memory-flags";
import { batchRecord, writtenPaths, type BatchRecord, type Call } from "../../../src/memory-batch";
import { encodeDelta } from "../../../src/memory-delta";
import { inheritFork, markFork, parentLines } from "../../../src/memory-fork";
import {
  deliveredKeys,
  epochTokens,
  firstTouches,
  foldWindow,
  holdSummarized,
  humanTurns,
  inheritLedger,
  ledgerKey,
  liveDeliveries,
  novelNotes,
  packetTokens,
  recordPacket,
  startEpoch,
  withinBudget,
  wouldPreempt,
} from "../../../src/memory-ledger";
import { isPinnedIntention, selectNotes, unsaidNotes } from "../../../src/memory-delivery";
import { recentConversation, sentencesOf, type RecentConversation } from "../../../src/memory-residual";
import { tailLines } from "../../../src/memory-transcript";
import { type ProvenanceNote } from "../../../src/memory-provenance";
import { readableStore, realpathOrSelf, repoStoreDir, swapping } from "../../../src/memory-repo";
import {
  buildCatalog,
  listedFile,
  readCatalog,
  recordedCheckout,
  rebuildsCatalog,
  repoPathOf,
  type ScopeCatalog,
} from "../../../src/memory-scopes";
import {
  recordPrompt,
  recordSubagentPaths,
  scopeFacts,
  scopeMapper,
  taskPaths,
  taskPlace,
  twoScopeNotes,
  typedValueRow,
  underTop,
  visibleFrom,
  placeOf,
  windowPaths,
  windowPlace,
  cascaded,
  type EncodePlace,
  type Place,
  type PlacePaths,
  type RepoScopes,
} from "../../../src/memory-place";
import {
  recordInstructions,
  shadowSentences,
  startShadowEpoch,
  type ShadowKind,
  type ShadowPlace,
} from "../../../src/memory-shadow";
import { childTranscript } from "../../../src/memory-session";
import {
  agentClasses,
  claimSpawn,
  parentPaths,
  storedScope,
  storeScope,
  type ChildScope,
} from "../../../src/memory-spawn";
import {
  declineCounts,
  isRevocation,
  markRevocations,
  recordDeclines,
  revocationNotes,
  shownRevocations,
} from "../../../src/memory-revoke";
import { firedClasses } from "../../../src/memory-triggers";
import { pinnedRules, pinnedText, policyRecurrences } from "../../../src/memory-pins";
import { ruleIdentity, withoutRules } from "../../../src/memory-policy";
import type { IndexedRow } from "../../../src/memory-rule-index";
import {
  answerUserGlobal,
  dropUserRules,
  markProposalShown,
  noteNextSession,
  proposalNote,
  proposalToShow,
  readUserRules,
  withUserGlobal,
  type AnswerPlace,
  type Proposal,
} from "../../../src/memory-user-global";
import { intentsReleasedBy } from "../../../src/memory-guard";
import { askedRules, labelFromTranscript, labelGuardCalls, type Labelled } from "../../../src/memory-guard-log";
import { isAnswered, nonHumanKind, promptHash, turnMode, type TurnMode } from "../../../src/memory-turn";
import { gateParts, pathCue, situationCue, type SituationCue } from "../../../src/memory-cue";
import {
  readInvalidations,
  recordInvalidations,
  recordRuleEnds,
  validText,
  withoutExpiredIntents,
  withoutForgets,
  type Invalidation,
} from "../../../src/memory-validity";
import {
  appendTurn,
  compactContext,
  cronHashes,
  existingLedgers,
  ledgerFor,
  LIVE_LEDGER,
  readLastAssistant,
  recordBatch,
  recordCrons,
  SHADOW_LEDGER,
  transcriptOffset,
  windowDir,
  writeLastAssistant,
  type LedgerFile,
} from "../../../src/memory-window";
import { lightSleep } from "../../../src/sleep";
import { memoryNow } from "../../../src/memory-clock";
import { parseHookToolTraces, persistToolTraces } from "../../../src/tool-trace";
import { noteRepoActivity, spawnHeavySleeper, spawnIdleSleeper } from "./memory-sleep";
import {
  applyMined,
  readCitations,
  repoRelative,
  scopesCiting,
  watchPaths,
  type Citation,
} from "../../../src/memory-citations";
import { readFolders } from "../../../src/memory-repo-facts";
import {
  asRec,
  eventRepo,
  logInvocation,
  memoryRoot,
  readHookPayload,
  resolveSession,
  str,
  transcriptOf,
  type Trace,
} from "./memory-hook-io";

export { memoryRoot };

const MEMORY_EVENTS = new Set([
  "UserPromptSubmit",
  "SessionStart",
  "SubagentStart",
  "PreCompact",
  "PostCompact",
  "Stop",
  "SessionEnd",
  "PostToolUse",
  "PostToolBatch",
  "SubagentStop",
  "InstructionsLoaded",
  "FileChanged",
  "CwdChanged",
]);

/**
 * Which of Stop's two handlers runs (D34, A4 §5.7): the plugin registers a sync `stop-fast` and an async
 * `stop-sleep`. A host that runs one Stop hook passes no stage, and gets both, in order.
 */
export type HookStage = "stop-fast" | "stop-sleep";

function hookMemory(opts: { dir: string; session?: string; child: boolean; cwd?: string; place: EncodePlace }) {
  return openMemory({ ...opts, perRepo: true });
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenContent).filter(Boolean).join("\n");
  const o = asRec(content);
  const field = o.text ?? o.content ?? o.stdout ?? o.stderr ?? o.output ?? o.message ?? o.error ?? o.llmContent;
  // A nested result (the Agent tool's `content` blocks) is read through, never stored as "[object Object]".
  return field == null ? "" : typeof field === "object" ? flattenContent(field) : String(field);
}

/** D23: SessionStart briefs at most 3 pins; A4 §5.3: a subagent's packet holds at most 3 bullets. */
const BRIEFED_PINS = 3;
const SUBAGENT_BULLETS = 3;
/** After a compaction, SessionStart briefs the 3 latest valid gists, looking through at most 12 (`compactGists`). */
const BRIEFED_GISTS = 3;
const GIST_SCAN = 12;

function additional(event: string, packet: string): Record<string, unknown> | null {
  return packet
    ? { additional_context: packet, hookSpecificOutput: { hookEventName: event, additionalContext: packet } }
    : null;
}

/**
 * SessionStart's candidates (A4 §5.2, D23), in order, each read through validity (A4 §5.1 step 5); the caller briefs
 * the first 3 that the window's instruction files do not state:
 * - the rules the user declined 3 times within 14 days, proposed for revocation (A6 §2.5, `memory-revoke.ts`);
 * - a proposal for all projects that this repo holds as a pin, in place of its pin's bullet, and the rules the user
 *   keeps for all projects (D11, `memory-user-global.ts`);
 * - the repo's newest pins (D9, `memory-pins.ts`): a rule row's pinned clauses only, so a policy said once is not
 *   briefed and an intent never is; a rule on no action class is briefed as a pinned row was before. A row the rules
 *   kept for all projects leave with no rule of its own briefs what else it says as a fact, not as a rule (P2.4's
 *   follow-up: a keyed row is no candidate of the lexical path, so this is where its fact still reaches Claude).
 * Pins are those visible from the likely scope (`likely`, A4 §5.2: the last session's read set, so a pin at a folder
 * is briefed only from there and below; the repo's first session leaves none out). Gists, P0.2's carrier between
 * sessions, are no longer briefed: since P0.5 a later session retrieves the same row at its Submit. `Updated:` items
 * (values changed since the repo's last session) are P3.4's: since P3.3 a delivered slot's cid names its `(scope,
 * slot)`, whose live keyed row holds the current value, and P3.4's mining is what changes a value between sessions.
 */
function briefing(
  mem: ReturnType<typeof openMemory>,
  root: string,
  likely?: Place,
): { notes: ProvenanceNote[]; proposal?: Proposal } {
  const seen = new Set<string>(),
    notes: ProvenanceNote[] = [],
    invalid = readInvalidations(mem.dir),
    add = (note: ProvenanceNote): void => {
      let text = validText(withoutExpiredIntents(String(note.text ?? ""), note.at), note.at, invalid, note.scope);
      try {
        text = scrubTombstonedIdentity(text, mem.dir).trim();
      } catch {}
      if (!text || seen.has(text.toLowerCase())) return;
      seen.add(text.toLowerCase());
      notes.push({ ...note, text });
    };
  const live = mem.memories().filter(isLiveRow);
  const own = live
    .filter((row) => isPinnedIntention(row) && (!likely || visibleFrom(likely)(row)))
    .flatMap(pinnedPart)
    .sort((a, b) => Number(b.kind === "constraint") - Number(a.kind === "constraint") || b.at - a.at);
  const proposal = proposalToShow(root, new Set(own.flatMap((row) => (row.rules ?? []).map(ruleIdentity))));
  const userRules = readUserRules(root);
  const global = [...(proposal ? [proposalNote(proposal)] : []), ...userRules];
  const ruleRows = withUserGlobal<IndexedRow>(
    live.filter((row) => row.rules?.length),
    userRules,
    invalid,
  ).map((row) => ({ ...row, text: validText(withoutExpiredIntents(row.text, row.at), row.at, invalid) }));
  const revocations = revocationNotes(ruleRows, declineCounts(mem.dir, memoryNow()));
  const revoked = new Set(revocations.map((note) => note.revokes));
  const ruled = new Set(own.flatMap((row) => (row.rules?.length ? [row.id] : [])));
  const pins = withUserGlobal<ProvenanceNote>(own, global, invalid).flatMap((row) => {
    if (row.rules?.length) return row.rules.every((rule) => revoked.has(ruleIdentity(rule))) ? [] : [row];
    return ruled.has(String(row.id)) ? [{ ...row, kind: "fact" }] : [row];
  });
  [...revocations, ...pins].forEach(add);
  return { notes, proposal };
}

/**
 * SessionStart(compact)'s packet: the 3 latest valid gists, without their rule clauses (pins come back on their next
 * cue). A4 §5.2 re-arms the compaction's dropped rows for their next cue; until that cue's words reach a row's
 * (P4.2: "how should we cache sessions?" misses "We use Redis for caching", A5 `negation`), the gists, P0.2's carrier,
 * stay here. A startup or a clear briefs pins only (`briefing`). A gist is the session's, read at the root and at
 * the window's read set (`readAt`): a line naming no folder yields to a value ended there, not to one ended only in
 * another folder; a line opening with its folder is that folder's (`validText`).
 */
function compactGists(
  mem: ReturnType<typeof openMemory>,
  session = "",
  readAt: readonly string[] = [],
): ProvenanceNote[] {
  const invalid = readInvalidations(mem.dir);
  const notes: ProvenanceNote[] = [];
  try {
    for (const g of new GistStore(mem.dir).latest(session, GIST_SCAN, { excludeSrc: "experience" })) {
      if (notes.length >= BRIEFED_GISTS) break;
      let text = validText(
        withoutRules(g.text, () => true),
        g.t,
        invalid,
        "",
        readAt,
      );
      try {
        text = scrubTombstonedIdentity(text, mem.dir).trim();
      } catch {}
      if (text && !notes.some((note) => note.text?.toLowerCase() === text.toLowerCase()))
        notes.push({ text, kind: "gist", tags: ["gist"], at: g.t });
    }
  } catch {}
  return notes;
}

/** What a pinned row may brief: a rule row's pinned rules and their clauses only (see `briefing`). */
function pinnedPart(row: MemoryRecord): MemoryRecord[] {
  if (!row.rules?.length) return [row];
  const text = pinnedText(row);
  const pinned = pinnedRules(row);
  return text ? [{ ...row, text, rules: row.rules.filter((rule) => pinned.has(ruleIdentity(rule))) }] : [];
}

/**
 * Renders a packet and records what it delivered in the ledger (A4 §4): the rows whose bullet made it into the 900
 * bytes (a two-scope bullet's rows, `parts`, each), and the packet's tokens. In shadow the ledger is the shadow one,
 * and the caller prints nothing. A ledger that cannot be written leaves the packet as it is. Returns the packet, the
 * cids it delivered, their rows' ids, and how many of the notes it holds.
 */
function deliver(
  notes: readonly ProvenanceNote[],
  ledger: Ledger | undefined,
  at: { off: number; att: string; repo?: string },
): { packet: string; cids: string[]; ids: string[]; notes: number } {
  const { packet, delivered } = packetOf(notes, memoryNow());
  const rows = delivered.flatMap((note) => note.parts ?? [note]);
  if (rows.length && ledger)
    try {
      const moment = { off: at.off, att: at.att, ht: humanTurns(ledger.dir) };
      const keys = rows.flatMap((note) => deliveredKeys(note, at.repo));
      recordPacket(ledger.dir, { keys, tokens: packetTokens(packet) }, moment, ledger.file);
    } catch {}
  const cids = rows.map((note) => ledgerKey(note, at.repo).cid);
  return { packet, cids, ids: rows.map((note) => String(note.id ?? "")), notes: delivered.length };
}

/**
 * A scope's live rows that may give a two-scope bullet its other value (`twoScopeNotes`), as delivery reads them (A4
 * §5.1 step 5: what invalidations and 7 days left of each), newest first; never a row of the prompt being answered.
 */
function scopeRows(mem: ReturnType<typeof openMemory>, invalid: readonly Invalidation[], promptId?: string) {
  return (scope: string): ProvenanceNote[] =>
    mem
      .memories()
      .filter((row) => row.scope === scope && typedValueRow(row) && isLiveRow(row))
      .filter((row) => !promptId || row.promptId !== promptId)
      .map((row) => ({ ...row, text: validText(withoutExpiredIntents(row.text, row.at), row.at, invalid, scope) }))
      .filter((row) => row.text)
      .sort((a, b) => b.at - a.at);
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

/** The window a point records its ledger in, and the ledger file of its mode (X7); none when it is `off`. */
type Ledger = { dir: string; file: LedgerFile };

/**
 * The memory hook for one event. It fails open: whatever throws, it returns null (so nothing is printed). Each
 * invocation appends one wide event, and an exception at an `on` delivery point lets the circuit breaker check that
 * point's budget (`memory-breaker.ts`). With `EDEN_MEMORY=off` it does nothing at all; read-only, it writes nothing.
 */
/** P4.2 (red first): A4 §5.1 step 0's budget; nothing aborts yet. */
export const SUBMIT_BUDGET_MS = 150;

export function budgetOf(_origin: number, _env = process.env.EDEN_SUBMIT_BUDGET_MS): () => boolean {
  return () => false;
}

export function memoryHookResponse(
  raw: Record<string, unknown>,
  stage?: HookStage,
  _origin?: number,
): Record<string, unknown> | null {
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
  /** The memory root (`<root>/repos/…`, `<root>/_user/`, `<root>/windows/…`). */
  root: string;
  store: string;
  /** The repo key (D1): its first 8 characters prefix the ledger's cids. */
  repo?: string;
  /** The window (D2) and its session, and the session it runs in. */
  win?: string;
  session?: string;
  child: boolean;
  transcriptPath: string;
  /** Where the session runs, for its shadow set's files on disk (D27). */
  place: ShadowPlace;
  /** The repo's top, or the session's folder outside git: what a task's paths are relative to (A4 §5.3). */
  top: string;
  /** The session's own window: a subagent's parent (D2). */
  sessionWin?: string;
  /** The delivery point's mode; undefined at an event that delivers nothing. */
  mode?: FlagMode;
  ledgerOf: (mode: FlagMode | undefined) => Ledger | undefined;
  /**
   * The repo as the window's paths are read against it (`memory-place.ts`), its catalog read once: none without a
   * catalog, where a place is unknown.
   */
  repoScopes: () => RepoScopes | undefined;
  /** The window's place (A4 §2), none where it is unknown: read when first asked, and again after `movePlace`. */
  workPlace: () => Place | undefined;
  /** The window's recent paths by source (`memory-place.ts`), read once per invocation. */
  recentPaths: () => PlacePaths | undefined;
  /** The window moved: a Submit's prompt names `prompt`'s places, or the catalog was built. */
  movePlace: (prompt?: readonly string[]) => void;
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
    const win = ctx.win;
    let encoded = 0;
    const delta = encodeDelta(win, transcriptPath, ({ messages, abandoned, branchTexts }) => {
      // A fork's first delta holds its parent's conversation, which the parent's delta encoded (`parentLines`).
      // When the parent cannot be looked for, everything is encoded, as before P1.3 (fail open).
      let copied = new Set<string>();
      try {
        copied = parentLines(
          memoryRoot(),
          win,
          transcriptPath,
          messages.flatMap((m) => m.uuid ?? []),
        );
      } catch {}
      const own = copied.size ? messages.filter((message) => !message.uuid || !copied.has(message.uuid)) : messages;
      encoded = own.length;
      if (own.length) ctx.mem.observe(own, { keepLiveIdentity: true, deferSleep: true });
      if (abandoned.length) ctx.mem.abandon(abandoned, branchTexts);
    });
    if (encoded) ctx.trace.encoded = encoded;
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
 * past their 90 days aggregated (X11), and the idle sleeper is started for the rest. Last, a Stop builds the repo's
 * scope catalog when it has none (D3). SessionEnd shares a 1.5 s budget (R0), so it does the same light work, builds
 * no catalog, and leaves the full sleep to the idle sleeper too.
 */
function sleepAfterTurn(ctx: HookContext): void {
  inTurn(
    () => encodeConversation(ctx),
    () => inheritParent(ctx),
    () => encodePayloadText(ctx),
    () => lightSleep(ctx.mem, ctx.session),
    () => ctx.win && compactContext(ctx.win),
    () => ctx.win && foldWindow(ctx.win),
    () => labelAsksFromTranscript(ctx),
    () => retainEvents(memoryRoot(), memoryNow()),
    () => spawnIdleSleeper(ctx.store, ctx.session),
    () => ctx.event === "Stop" && buildMissingCatalog(ctx, STOP_LIST_TIMEOUT_MS),
  );
}

/** How long a Stop's first build may list the repo's files: the async hook blocks no one, but should end (A4 §6). */
const STOP_LIST_TIMEOUT_MS = 10_000;

/**
 * A repo's first scope catalog (D3), built when the store has none: at a session's start, so its first prompt is
 * placed (A4 §2), listing for at most 1 s as a batch may; and at a turn's end, for up to 10 s, if that ran out.
 */
function buildMissingCatalog(ctx: HookContext, timeoutMs: number): void {
  if (!ctx.writes || readCatalog(ctx.store)) return;
  noteCatalog(ctx, buildCatalog(ctx.store, ctx.top, timeoutMs));
  ctx.movePlace();
}

/** A6 §2.5: the asks no PostToolBatch labelled, labelled from the transcript at sleep. */
function labelAsksFromTranscript(ctx: HookContext): void {
  if (ctx.win) answered(ctx, labelFromTranscript(ctx.win, ctx.transcriptPath));
}

/**
 * A forked session's copy of its parent's ledger (D25, `memory-fork.ts`), once the delta encoder has read the fork's
 * transcript: Claude Code writes it only after the fork's first turn.
 */
function inheritParent(ctx: HookContext): void {
  if (!ctx.win || ctx.child) return;
  const inherited = inheritFork(memoryRoot(), ctx.win, ctx.transcriptPath);
  if (inherited) Object.assign(ctx.trace, { forked_from: inherited.from, copied: inherited.copied });
}

/** A value made when first asked, and made again when asked after `reset`. */
function lazily<T>(make: () => T): { get: () => T; reset: () => void } {
  let made: { value: T } | undefined;
  return {
    get: () => (made ??= { value: make() }).value,
    reset: () => {
      made = undefined;
    },
  };
}

/** Runs each step of a handler in order; one that throws is skipped, never the steps after it (fail open). */
function inTurn(...steps: (() => unknown)[]): void {
  for (const step of steps)
    try {
      step();
    } catch {}
}

/**
 * A PostToolUse (hosts other than the plugin, which records batches): the result is encoded from the payload, and a
 * write it made can rebuild the scope catalog as a batch's can. Returns whether the payload carried a result.
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
  try {
    if (ctx.writes) rebuildAfterWrites(ctx, [r]);
  } catch {}
  return !!result;
}

/**
 * PostToolBatch (A4 §5.5): one `ctx.log` record for the batch (`memory-batch.ts`), its tool traces, and the main
 * window's delta. A subagent's lines are its own transcript's, which SubagentStop encodes; its batch's paths also go
 * to its session's window, where they are subagent paths (D2, `memory-place.ts`). Then the batch's delivery point:
 * the first touch of a scope in this epoch (`firstTouch`).
 */
function toolBatch(ctx: HookContext): Record<string, unknown> | null {
  let batch: BatchRecord | undefined;
  inTurn(
    () => {
      batch = batchRecord(ctx.r, { top: ctx.top, cwd: ctx.place.cwd ?? ctx.top });
      if (ctx.win) recordBatch(ctx.win, batch);
    },
    () => ctx.child && ctx.sessionWin && batch && recordSubagentPaths(ctx.sessionWin, [...batch.paths, ...batch.bash]),
    () => persistToolTraces(ctx.mem.jsonlDir, parseHookToolTraces(ctx.r)),
    () => {
      if (!ctx.child) encodeConversation(ctx);
    },
    () => labelAsks(ctx),
    () => ctx.writes && rebuildAfterWrites(ctx, batchCalls(ctx.r)),
  );
  return batch ? firstTouch(ctx, batch) : null;
}

/** A4 §5.5: a first touch delivers at most 2 items, and reads at most 2 new scopes, as a read set holds (D4). */
const TOUCH_BULLETS = 2;
const TOUCH_SCOPES = 2;

/**
 * A4 §5.5, D23: the first touch of a scope in this epoch delivers at most 2 STRONG items, the slot facts of that
 * scope itself (`scopeFacts`), once per batch, for at most 2 new scopes (the rest stay new for the next batch);
 * gotchas and procedures anchored to the touched paths are P4.5's and P4.6's. A scope is a catalog scope below the
 * root: the root is where every session already is, and its facts reach the cue that needs them. What a batch touched
 * is the window ledger's, by epoch (`firstTouches`), so a compaction or a clear makes every scope new again. The facts
 * pass validity, D5 (`cascaded`), the residual, the shadow set, the ledger and the epoch's budget, as a Submit's do.
 * X7: `off` records and delivers nothing; `shadow` writes the shadow ledger and prints nothing.
 */
function firstTouch(ctx: HookContext, batch: BatchRecord): Record<string, unknown> | null {
  const { r, win, mode, mem, trace } = ctx;
  const ledger = ctx.ledgerOf(mode);
  const at = ctx.repoScopes();
  if (!win || !ledger || !at) return null;
  const scopeOf = scopeMapper(at);
  const scopes = [...batch.paths, ...batch.bash].flatMap((path) => scopeOf(path) || []);
  if (!scopes.length) return null;
  const touched = firstTouches(win, scopes, ledger.file, TOUCH_SCOPES);
  if (!touched.length) return null;
  trace.touch = touched.length;
  // D25: a subagent's window is measured, and its conversation read, on its own transcript.
  const transcript = ctx.child ? childTranscript(r) : ctx.transcriptPath;
  const off = transcriptOffset(transcript);
  const invalid = readInvalidations(mem.dir);
  const live = mem.memories().filter(isLiveRow);
  const place = { readSet: touched, named: [] };
  const found = place.readSet.flatMap((scope) => scopeFacts(live, scope));
  const candidates = cascaded(found, live, place.readSet);
  const residual = recentConversation(transcript, "").residual;
  // D27: a subagent's instruction files are its parent's, by its type, as at its start.
  const shadow = ctx.child
    ? shadowSentences(ctx.sessionWin, ctx.place, { kind: childShadowKind(str(r.agent_type) ?? ""), onDisk: true })
    : shadowSentences(win, ctx.place);
  const against = {
    prompt: "",
    parts: { prompt: "" },
    residual,
    shadow,
    invalid,
    readSet: place.readSet,
    catalog: at.scopes,
  };
  const { notes: novel, drops } = selectNotes(candidates, against, (fresh) =>
    novelNotes(fresh, liveDeliveries(win, off, ledger.file), { repo: ctx.repo, invalid }),
  );
  drops.validity += found.length - candidates.length;
  const allowed = withinBudget(novel, epochTokens(win, ledger.file));
  const shown = twoScopeNotes(allowed, place.readSet, scopeRows(mem, invalid));
  const shaped = shapePacket(shown).slice(0, TOUCH_BULLETS);
  const att = str(r.prompt_id) ?? "";
  const { packet, cids, ids, notes: given } = deliver(shaped, ledger, { off, att, repo: ctx.repo });
  Object.assign(trace, { cids, ids });
  trace.drops = { ...drops, budget: novel.length - allowed.length, shape: shown.length - given };
  return mode === "on" ? additional(ctx.event, packet) : null;
}

/** A batch blocks the agent: a rebuild it starts lists the repo's files for at most this long (fail open). */
const BATCH_LIST_TIMEOUT_MS = 1_000;

/**
 * A4 §2: the batch's writes to this repo's main checkout rebuild its scope catalog when they can change it: a
 * manifest, workspace or build-system file, the `.eden/scopes` override, or a file git lists in a directory that
 * held only its manifest (`memory-scopes.ts`). Another repo's files, a linked worktree's (the catalog lists the main
 * checkout's), every other write, and a repo with no catalog yet (its session's start or turn's end builds it) list
 * nothing.
 */
function rebuildAfterWrites(ctx: HookContext, calls: readonly Call[]): void {
  const catalog = readCatalog(ctx.store);
  if (!catalog) return;
  const cwd = str(ctx.r.cwd) ?? ctx.top;
  const written = writtenPaths(calls).flatMap((path) => {
    const at = repoPathOf(resolve(cwd, path));
    return at && at.repo === ctx.repo && at.top === catalog.checkout ? [at.rel] : [];
  });
  if (rebuildsCatalog(catalog, written, (rel) => listedFile(catalog.checkout, rel)))
    noteCatalog(ctx, buildCatalog(ctx.store, ctx.top, BATCH_LIST_TIMEOUT_MS));
}

/** The wide event names the catalog an event rebuilt, by its scope count. */
function noteCatalog(ctx: HookContext, catalog: ScopeCatalog | undefined): void {
  if (catalog) ctx.trace.catalog = catalog.scopes.length;
}

/** A PostToolBatch payload's calls. */
function batchCalls(r: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(r.tool_calls) ? r.tool_calls.map(asRec) : [];
}

/** A4 §5.5, A6 §2.5: the guard's asks this batch answered, labelled approved, declined or denied. */
function labelAsks(ctx: HookContext): void {
  if (ctx.win) answered(ctx, labelGuardCalls(ctx.win, batchCalls(ctx.r)));
}

/**
 * Logs the labels of answered asks, and ends each intent an approved ask showed whose call then ran (D9: an intent
 * ends when its action completes). Only an ask the user approved carries an intent out: a call nobody was asked about
 * (`bypassPermissions`, `guard.ask` off) leaves the intent standing until it is released or 7 days pass. A declined
 * ask goes to the store's decline log (A6 §2.5, `memory-revoke.ts`).
 */
function answered(ctx: HookContext, labels: readonly Labelled[]): void {
  if (!labels.length) return;
  ctx.trace.guard_labels = labels.map(({ id, label }) => ({ id, label }));
  recordDeclines(ctx.mem.dir, labels, memoryNow());
  recordRuleEnds(
    ctx.mem.dir,
    labels.flatMap((item) => (item.ran ? item.rules : [])),
    "intent",
  );
}

/**
 * A typed sentence that is nothing but dropping the rule just shown (A6 §2.5's "that rule is gone"): "ok, that rule is
 * gone.", "drop that rule". A sentence about another rule ("delete that rule from the eslint config") is not one.
 */
const DROPS_RULE =
  /^(?:(?:ok(?:ay)?|yes|yeah|yep|fine|right|sure|alright|no)\b[\s,.!]*)*(?:please\s+)?(?:(?:that|this|the) rule (?:is gone|no longer applies|doesn['’]?t apply any ?more|is (?:dead|over|obsolete)|can go)|(?:drop|remove|forget|delete|scrap) (?:that|this|the) rule)(?:\s+(?:now|please|then))?[\s.!]*$/i;

/**
 * What the user's own words end (P2.1's follow-ups): a release with no class word ends the live intents it names
 * ("Open it now."), and "that rule is gone" the rules the guard asked the user about in the turn before this one, or,
 * with no such ask, the rules this session's SessionStart proposed revoking (A6 §2.5), in its next 2 human turns and
 * unless the guard has asked anything since.
 */
function endRules(ctx: HookContext, said: string): void {
  if (!said) return;
  recordRuleEnds(ctx.mem.dir, intentsReleasedBy(ctx.mem.dir, said), "intent");
  const drops = sentencesOf(said).some((sentence) => DROPS_RULE.test(sentence.trim()));
  if (!ctx.win || !drops) return;
  const ht = humanTurns(ctx.win);
  const lastAsked = askedRules(ctx.win, ht - 1);
  const asked = lastAsked.length ? lastAsked : shownRevocations(ctx.win, ht);
  recordRuleEnds(ctx.mem.dir, asked, "rule");
  const dropped = dropUserRules(ctx.root, asked, memoryNow(), "dropped");
  if (dropped.length) ctx.trace.dropped = dropped;
}

/** Where a D11 proposal is shown and answered: the repo and the session's `ep`. */
function answerPlace(ctx: HookContext): AnswerPlace | undefined {
  const ep = ctx.mem.episode;
  return ctx.repo && ep ? { repo: ctx.repo, ep } : undefined;
}

/**
 * D11 at a human Submit, on the user's own words as the store keeps them: the rules kept for all projects that the
 * prompt overturns with D11's phrase end (A4 §3.1, L8), its policies stated with D11's phrases are kept for all
 * projects, and "yes, everywhere" keeps the proposals it answers (`memory-user-global.ts`). Returns what the Submit
 * acknowledges: a proposal kept in the session after the one that showed it, whose context never held it.
 */
function userGlobalRules(ctx: HookContext, said: string): ProvenanceNote[] {
  if (!said) return [];
  const answer = answerUserGlobal(ctx.root, ctx.mem.storableText(said), memoryNow(), answerPlace(ctx));
  if (answer.dropped.length) ctx.trace.dropped = [...(ctx.trace.dropped ?? []), ...answer.dropped];
  if (answer.kept.length) ctx.trace.kept = answer.kept;
  return answer.acknowledged;
}

/**
 * SubagentStop (A4 §5.7b): the subagent's last message, or the result a host sends as a tool result, encoded once,
 * and the child window's ledger folded (D25).
 * Its own transcript is not encoded (decided in P2.5, with the child's delivery point): what the parent learns from it
 * is the Agent call's result, which the parent's delta encodes, and rows made from the child's own reads and reasoning
 * would come back to the parent as bullets its Agent result already holds (`redundant_rate` +4.42 pp in P0.6's guard
 * runs).
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

/** A4 §5.3, D27: what of its parent's instruction files a child's context holds, by its type (R0 F35). */
function childShadowKind(type: string): ShadowKind {
  if (type === "fork") return "window";
  return type === "Explore" || type === "Plan" ? "none" : "instructions";
}

/**
 * The child's scope (A4 §5.3, `memory-spawn.ts`): the one it stored at its first start (a resumed subagent), else its
 * launch's record, its task's paths and the read set they make, else the parent's recent paths and read set (D4); a
 * task that names no place of the repo takes the parent's too. At its first start it is stored, and a fork copies its
 * parent's ledger (D25), at its own transcript's start.
 */
function childScope(ctx: HookContext, type: string): ChildScope & { source: "task" | "parent" | "stored" } {
  const { r, win, sessionWin: parent, writes } = ctx;
  const stored = win ? storedScope(win) : undefined;
  if (stored) return { ...stored, source: "stored" };
  const agent = str(r.agent_id) ?? "";
  const spawn = parent ? claimSpawn(parent, { type, now: memoryNow(), agent, mark: writes }) : undefined;
  const at = ctx.repoScopes();
  const fromParent = () => ({
    paths: parent ? parentPaths(parent, ctx.top) : [],
    ...(at ? { scopes: windowPlace(parent, at).readSet } : {}),
  });
  const own = spawn?.paths.length ? spawn.paths : undefined;
  const scope: ChildScope = spawn
    ? {
        ...(own ? { paths: own, ...(at ? { scopes: taskPlace(own, at).readSet } : {}) } : fromParent()),
        classes: spawn.classes,
        from: "task",
      }
    : { ...fromParent(), classes: [], from: "parent" };
  if (writes && win)
    inTurn(
      () => storeScope(win, scope),
      () => {
        if (type !== "fork" || !parent) return;
        // X7: in shadow the copy goes to the shadow ledger, which the shadow point reads beside the live one.
        const into = ctx.mode === "shadow" ? SHADOW_LEDGER : undefined;
        const copied = inheritLedger(parent, win, new Set(), { off: 0, into });
        Object.assign(ctx.trace, { forked_from: basename(parent), copied });
      },
    );
  return { ...scope, source: scope.from };
}

/**
 * A child's place (A4 §2, §5.3): its stored read set, or, in a scope stored without one, the one its paths make; the
 * scopes its task names, when it has one. None where a place is unknown.
 */
function childPlace(ctx: HookContext, scope: ChildScope): Place | undefined {
  const at = ctx.repoScopes();
  if (!at) return undefined;
  const named = taskPlace(scope.from === "task" ? scope.paths : [], at).named;
  return { readSet: scope.scopes ?? taskPlace(scope.paths, at).readSet, named };
}

/**
 * SubagentStart (A4 §5.3, D23): at most 3 bullets for the subagent's scope, in its own window's ledger (D2): the
 * policies and intents of the classes its task and its type fit (a reviewer gets the merge policies), then the rows
 * the lexical path finds for its scope's paths. Through validity, the gate (A7 §4: the cue is the scope's paths, so an
 * untyped row is admitted only on an identifier it shares with them), the child's shadow set by its type (D27), and
 * its ledger, whose distance is measured on its own transcript (D25). A fork's ledger starts as its parent's copy and
 * its residual is the parent's conversation, so it gets nothing its context already holds. Claude Code dedupes a
 * re-run's context (R0 F12); Eden's ledger keeps a resumed subagent from being given the same bullets again.
 */
function subagentStart(ctx: HookContext): Record<string, unknown> | null {
  const { r, win, mode, mem, trace } = ctx;
  if (!win || mode === "off") return null;
  const type = str(r.agent_type) ?? "";
  const scope = childScope(ctx, type);
  const off = transcriptOffset(childTranscript(r)),
    ledger = ctx.ledgerOf(mode),
    classes = [...new Set([...scope.classes, ...agentClasses(type)])],
    cue = scope.paths.join(" "),
    invalid = readInvalidations(mem.dir),
    place = childPlace(ctx, scope);
  const shadow = shadowSentences(ctx.sessionWin, ctx.place, { kind: childShadowKind(type), onDisk: true });
  // D26: a fork's context is its parent's whole conversation; a typed subagent's, its task, which no payload carries.
  const residual = type === "fork" ? recentConversation(ctx.transcriptPath, "", Infinity).residual : [];
  const catalog = ctx.repoScopes()?.scopes;
  const against = { prompt: cue, parts: { prompt: cue }, residual, shadow, invalid, readSet: place?.readSet, catalog };
  const found = mem.taskNotes(scope.paths, classes, place && visibleFrom(place));
  const candidates = place ? cascaded(found, mem.memories().filter(isLiveRow), place.readSet) : found;
  const { notes: novel, drops } = selectNotes(candidates, against, (fresh) =>
    novelNotes(fresh, liveDeliveries(win, off, ledger?.file), { repo: ctx.repo, invalid }),
  );
  drops.validity += found.length - candidates.length;
  const allowed = withinBudget(novel, epochTokens(win, ledger?.file));
  const shown = twoScopeNotes(allowed, place?.readSet ?? [], scopeRows(mem, invalid));
  const shaped = shapePacket(shown).slice(0, SUBAGENT_BULLETS);
  const { packet, cids, ids, notes: given } = deliver(shaped, ledger, { off, att: "", repo: ctx.repo });
  Object.assign(trace, { scope: scope.source, paths: scope.paths.length, cids, ids });
  if (place) trace.read = place.readSet.length;
  if (classes.length) trace.classes = classes;
  trace.drops = { ...drops, budget: novel.length - allowed.length, shape: shown.length - given };
  return mode === "on" ? additional(ctx.event, packet) : null;
}

function sessionStart(ctx: HookContext): Record<string, unknown> | null {
  const { r, writes, win, mode, flags, mem, trace } = ctx;
  if (writes)
    inTurn(
      () => buildMissingCatalog(ctx, BATCH_LIST_TIMEOUT_MS),
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
  // the ledger. A fork holds its parent's context the same way: it brings nothing, and copies the parent's ledger
  // once its transcript names the parent (`inheritParent`). `clear` and a compaction start an epoch (A4 §4), which
  // re-arms everything; PostCompact then holds what the summary still names, and a compaction's pins come back on
  // their next cue, not here.
  const off = transcriptOffset(ctx.transcriptPath),
    ledger = ctx.ledgerOf(mode),
    source = r.source,
    compact = source === "compact";
  // D34: the heavy tier, detached, so the session's first response does not wait for it (R0 F28). A compaction is
  // the same process, whose files the watch list below already covers.
  if (writes && !ctx.child && !compact)
    try {
      spawnHeavySleeper(ctx.store);
    } catch {}
  if (source === "resume") return withNotice(withWatch(ctx, null), notice);
  if (source === "fork") {
    if (win && writes)
      try {
        markFork(win, memoryNow(), r.seconds_since_last_response);
      } catch {}
    return withNotice(withWatch(ctx, null), notice);
  }
  // The epoch belongs to the window: each ledger it has, and each a built point writes in its mode, starts one,
  // so a point that turned from on to shadow re-arms what it delivered live (A4 §4).
  if ((compact || source === "clear") && win && writes) {
    const modes = [mode, flags["deliver.submit"].mode].flatMap((m) => ctx.ledgerOf(m)?.file ?? []);
    for (const file of new Set([...existingLedgers(win), ...modes]))
      try {
        startEpoch(win, String(source), off, file);
      } catch {}
    try {
      startShadowEpoch(win);
    } catch {}
  }
  // D11: a proposal may be answered in the session that showed it or its repo's next one.
  const place = answerPlace(ctx);
  if (writes && place)
    try {
      noteNextSession(ctx.root, memoryNow(), place);
    } catch {}
  if (mode === "off") return withNotice(null, notice);
  // A4 §5.1 step 7 holds here too: what the window's instruction files state is never briefed (D27), the CLAUDE.md
  // files read from disk, as InstructionsLoaded may not have reported them yet. Then D23's cap.
  const readAt = compact ? (ctx.workPlace()?.readSet ?? []) : [];
  const { notes, proposal } = compact
    ? { notes: compactGists(mem, ctx.session, readAt) }
    : briefing(mem, ctx.root, likelyPlace(ctx));
  const unsaid = notes.length ? unsaidNotes(notes, shadowSentences(win, ctx.place, { onDisk: true })) : notes;
  // A4 §5.2: then the values that changed since the repo's last session (`memory-updates.ts`).
  const updates =
    compact || !ctx.repo
      ? []
      : updatedItems(mem.memories(), lastSessionDeliveries(ctx.store, ctx.root, ctx.repo), {
          repo: ctx.repo,
          invalid: readInvalidations(mem.dir),
        });
  if (!compact && writes && !ctx.child && ctx.session)
    try {
      noteLastSession(ctx.store, ctx.session);
    } catch {}
  const briefed = [...unsaid.slice(0, BRIEFED_PINS), ...updates];
  const { packet, cids, ids } = deliver(briefed, ledger, { off, att: "", repo: ctx.repo });
  Object.assign(trace, {
    cids,
    ids,
    drops: { shadow: notes.length - unsaid.length, shape: unsaid.length + updates.length - cids.length },
  });
  // A6 §2.5: the revocations the session was shown, which its "that rule is gone" may answer.
  const revoked = briefed.filter((note) => isRevocation(note) && ids.includes(String(note.id ?? "")));
  if (revoked.length && mode === "on" && writes && win)
    try {
      const rules = revoked.flatMap((note) => (isRevocation(note) ? [note.revokes] : []));
      markRevocations(win, rules, memoryNow(), humanTurns(win));
      trace.revoke = rules;
    } catch {}
  // D11: a proposal is shown once, so only a packet the user's session received counts.
  const shown = proposal && mode === "on" && ids.includes(proposalNote(proposal).id ?? "") ? proposal : undefined;
  if (shown && writes && place)
    try {
      markProposalShown(ctx.root, shown, memoryNow(), place);
      trace.proposed = shown.r;
    } catch {}
  return withNotice(mode === "on" ? withWatch(ctx, additional(ctx.event, packet)) : null, notice);
}

/**
 * A4 §5.2's likely scope: the read set of the repo's last session, from its window's last 3 turns (`ctx.log`); none
 * before the repo's first session, where a place is unknown, or once that window is gone.
 */
function likelyPlace(ctx: HookContext): Place | undefined {
  const at = ctx.repoScopes();
  const last = lastSessionWindow(ctx.store, ctx.root);
  return at && last && existsSync(last) ? { readSet: windowPlace(last, at).readSet, named: [] } : undefined;
}

/**
 * D31: the cited files Claude Code watches for this session, beside what the event says. SessionStart names them (a
 * new process watches nothing), and CwdChanged and FileChanged name them again, each return replacing the list (R0
 * F29). They ride on SessionStart's point: only an `on` point names files (X7: `off` is identity, `shadow` prints
 * nothing), so a session whose SessionStart is not `on` is re-checked at sleep only.
 */
function withWatch(
  ctx: HookContext,
  out: Record<string, unknown> | null,
  citations: readonly Citation[] = readCitations(ctx.store),
): Record<string, unknown> | null {
  if (ctx.flags["deliver.session_start"].mode !== "on") return out;
  const paths = watchPaths(citations, citedCheckout(ctx));
  if (!paths.length && ctx.event === "SessionStart") return out;
  ctx.trace.watch = paths.length;
  const specific = { ...asRec(out?.hookSpecificOutput), hookEventName: ctx.event, watchPaths: paths };
  return { ...(out ?? {}), hookSpecificOutput: specific };
}

/**
 * The checkout whose files the repo's citations read: the one its catalog was built from, which the heavy sleep also
 * reads (every worktree of a repo shares its store, D1, so one checkout states its facts); the session's own when the
 * store has no catalog yet.
 */
function citedCheckout(ctx: HookContext): string {
  return recordedCheckout(ctx.store) ?? ctx.top;
}

/**
 * D31's re-check: a cited file changed on disk (Claude Code's FileChanged, whatever wrote it), so the folders citing
 * it read their files again (`applyMined`): a changed value is cited anew, a vanished one fails its citation.
 * Read-only, it only names the files again.
 */
function fileChanged(ctx: HookContext): Record<string, unknown> | null {
  let citations = readCitations(ctx.store);
  const checkout = citedCheckout(ctx);
  const file = str(ctx.r.file_path);
  const rel = file ? repoRelative(realpathOrSelf(checkout), realpathOrSelf(file)) : undefined;
  const scopes = rel === undefined ? [] : scopesCiting(citations, rel);
  if (ctx.writes && scopes.length) {
    citations = applyMined(ctx.mem, readFolders(checkout, scopes), scopes);
    ctx.trace.recheck = scopes.length;
  }
  return withWatch(ctx, null, citations);
}

/**
 * PostCompact (A4 §4, R0 F14): SessionStart(compact), which Claude Code runs just before it (R0 F32), started a new
 * epoch in every ledger the window has; what `compact_summary` still names stays habituated in each. It reads no
 * store.
 */
function postCompact(r: Record<string, unknown>, win: string, trace: Trace): void {
  const summary = str(r.compact_summary);
  if (!summary) return;
  const off = transcriptOffset(transcriptOf(r));
  const held: string[] = [];
  let rearmed = 0;
  for (const file of existingLedgers(win)) {
    const kept = holdSummarized(win, summary, off, file);
    held.push(...kept.held);
    rearmed += kept.rearmed;
  }
  Object.assign(trace, { held, rearmed });
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

/**
 * A7 §3's situation cue of a human turn: the previous typed prompt, the paths the window's recent tool calls touched
 * (`ctx.log`, newest first), and the agent's last message without the packets Eden gave the turn it answers.
 */
function situationOf(ctx: HookContext, recent: RecentConversation, prev: string, mode: TurnMode): SituationCue {
  const paths = ctx.recentPaths();
  const path = paths ? pathCue([...paths.turns, ...paths.bash], ctx.top) : "";
  return situationCue({ turn: recent.previousTyped, path, prev, delivered: recent.delivered }, mode);
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
  // A4 §2: the prompt's places weigh 3 in the window's place, which its own rows are stored at (D4).
  if (human)
    inTurn(() => {
      const places = taskPaths(prompt, ctx.top, ctx.place.cwd);
      ctx.movePlace(places);
      if (writes && win) recordPrompt(win, places, str(r.prompt_id));
    });
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
  const own = encode
    .filter((m) => m.src === "user")
    .map((m) => m.content)
    .join("\n");
  let acknowledged: ProvenanceNote[] = [];
  if (writes && human)
    inTurn(
      () => endRules(ctx, own),
      () => (acknowledged = userGlobalRules(ctx, own)),
    );
  if (human) {
    const classes = firedClasses(own);
    if (classes.length) trace.classes = classes;
    try {
      const ruled = mem.memories().filter((row) => row.rules?.length && isLiveRow(row));
      const recur = policyRecurrences(ruled, own, mem.episode);
      if (recur.length) trace.policy_recur = recur;
    } catch {}
  }
  if (mode === "shadow" && ledger && trace.hturn !== undefined)
    try {
      const own = encode.filter((m) => m.src === "user").map((m) => m.content);
      const preempted = wouldPreempt(ledger.dir, [...own, ...own.flatMap(sentencesOf)], trace.hturn, ctx.repo);
      if (preempted.length) trace.would_preempt = preempted;
    } catch {}
  const place = ctx.workPlace();
  if (human && place) trace.read = place.readSet.length;
  // A7 §3: a human turn the mode answers is cued by its situation; PreCompact by its text alone.
  let situation: SituationCue | undefined;
  // A cue that cannot be read falls back to the prompt alone, as before P4.1.
  if (human && isAnswered(turn))
    try {
      situation = situationOf(ctx, recent, prev, turn);
    } catch {}
  if (prompt && isAnswered(turn) && answer !== "off")
    notes = mem.recall(cue, encode, place && visibleFrom(place), { situation });
  else if (prompt) mem.observeCue(cue, undefined, encode);
  // X7: an `off` point answers nothing, a kept proposal's acknowledgement included.
  if (answer === "off" || (!notes.length && !acknowledged.length)) return null;
  // A4 §5.1: validity (step 5); the gate on episodes the user did not type (step 6, A7 §4); novelty (step 7):
  // what the last turns already say (D26), then what this window was already given (the ledger, which also marks
  // `Updated:` items); the epoch's budget (A4 §4); shape (step 8).
  const parts = situation
    ? gateParts(prompt, recent.previousTyped, situation)
    : { prompt, turn: recent.previousTyped, prev };
  const shadow = shadowSentences(win, ctx.place);
  const invalid = readInvalidations(mem.dir);
  const catalog = ctx.repoScopes()?.scopes;
  const against = { prompt, parts, residual: recent.residual, shadow, invalid, readSet: place?.readSet, catalog };
  // D5 (`cascaded`): read after the prompt is stored, which may override a value.
  const placed = place ? cascaded(notes, mem.memories().filter(isLiveRow), place.readSet) : notes;
  const { notes: novel, drops } = selectNotes(placed, against, (fresh) =>
    win
      ? novelNotes(fresh, liveDeliveries(win, off, ledger?.file), { repo: ctx.repo, invalid: against.invalid })
      : fresh,
  );
  const tokens = win ? epochTokens(win, ledger?.file) : 0;
  const allowed = withinBudget(novel, tokens);
  // D11: a kept proposal's acknowledgement leads; it states nothing the store retrieves. A4 §2: a two-scope read set's
  // values of one slot share a bullet.
  const others = scopeRows(mem, against.invalid, str(r.prompt_id));
  const shown = twoScopeNotes([...acknowledged, ...allowed], place?.readSet ?? [], others);
  const { packet, cids, ids, notes: given } = deliver(shapePacket(shown), ledger, { off, att, repo: ctx.repo });
  Object.assign(trace, { cids, ids, tokens_epoch: tokens });
  drops.validity += notes.length - placed.length;
  trace.drops = { ...drops, budget: novel.length - allowed.length, shape: shown.length - given };
  return answer === "shadow" ? null : additional(event, packet);
}

/**
 * D24: a non-human Submit gets nothing but `Updated:` items, read against its own window's ledger
 * (`memory-updates.ts`); a window given no slot opens no store.
 */
function nonHumanUpdates(
  r: Record<string, unknown>,
  win: string,
  store: string,
  repo: string,
  writes: boolean,
  trace: Trace,
): Record<string, unknown> | null {
  const off = transcriptOffset(transcriptOf(r));
  const held = liveDeliveries(win, off);
  if (!held.some((delivery) => delivery.cid.includes("/s:")) || !readableStore(store)) return null;
  const items = updatedItems(storeRows(join(store, "memories.jsonl")), held, {
    repo,
    invalid: readInvalidations(store),
  });
  if (!items.length) return null;
  const ledger: Ledger | undefined = writes ? { dir: win, file: LIVE_LEDGER } : undefined;
  const { packet, cids, ids } = deliver(items, ledger, { off, att: str(r.prompt_id) ?? "", repo });
  Object.assign(trace, { cids, ids });
  return additional("UserPromptSubmit", packet);
}

/** Events that only write: read-only consent leaves them nothing to do. */
const WRITING_EVENTS = new Set([
  "PostToolUse",
  "PostToolBatch",
  "SubagentStop",
  "Stop",
  "SessionEnd",
  "PostCompact",
  "InstructionsLoaded",
]);

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
  const win = windowDir(root, resolved.session ?? "");
  // D27: InstructionsLoaded only records the file in its window's shadow set; it opens no store.
  if (event === "InstructionsLoaded") {
    if (win) {
      trace.win = basename(win);
      recordInstructions(win, r);
    }
    return null;
  }
  const sessionWin = windowDir(root, resolved.parent ?? ""),
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
  if (event === "PostCompact") {
    if (win) postCompact(r, win, trace);
    return null;
  }
  // R0 F32: `/compact` runs an internal agent (`agent_type: ""`) with no transcript of its own. Its last message is
  // the summary, which the main transcript's compact summary line already carries to the delta encoder; it is given
  // nothing either.
  if ((event === "SubagentStop" || event === "SubagentStart") && r.agent_type === "") return null;
  // D24, A4 §5.1 step 0: a non-human submit gets nothing but `Updated:` items (`nonHumanUpdates`, which opens the
  // store only when its window was given a slot). Its wide event names the rule it matched, so the live shape of each
  // kind can be checked from ids alone (R0 F34).
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
    return mode === "on" && win && repo
      ? nonHumanUpdates(r, win, repoStoreDir(root, repo.key), repo.key, writes, trace)
      : null;
  }
  const store = repo && repoStoreDir(root, repo.key);
  // EXECUTION §9: a store in a format this code does not know is never read or written.
  if (!store || !readableStore(store)) return null;
  if (writes)
    try {
      noteRepoActivity(store);
    } catch {}
  const top = repo?.top ?? cwd ?? process.cwd();
  const scopesAt = lazily((): RepoScopes | undefined => {
    const catalog = readCatalog(store);
    // The session's folder within the top, which a relative path a row names may be read from (`namedScopes`).
    const within = cwd ? underTop(realpathOrSelf(cwd), top) : undefined;
    const from = within && !within.startsWith("..") ? within : "";
    return catalog && repo ? { repo: repo.key, top, scopes: catalog.scopes, cwd: from } : undefined;
  });
  // A subagent's prompt is its task, whose places its first SubagentStart stored (A4 §5.3).
  let named = (): readonly string[] | undefined => (resolved.child && win ? storedScope(win)?.paths : undefined);
  // The window's recent paths (`ctx.log`), read once for the place and the situation cue (A7 §3's `q_path`).
  const paths = lazily((): PlacePaths | undefined => (win ? windowPaths(win, named()) : undefined));
  const placed = lazily((): Place | undefined => {
    const at = scopesAt.get();
    if (!at) return undefined;
    const recent = paths.get();
    return recent ? placeOf(recent, at) : taskPlace(named() ?? [], at);
  });
  const place = { repo: scopesAt.get, working: () => placed.get()?.readSet[0] ?? "" };
  const mem = hookMemory({ dir: store, session: resolved.session, child: resolved.child, cwd, place });
  const ctx: HookContext = {
    r,
    event,
    writes,
    flags,
    trace,
    mem,
    root,
    store,
    repo: repo?.key,
    win,
    session: resolved.session,
    child: resolved.child,
    transcriptPath: transcriptOf(r),
    place: { cwd: cwd ?? process.cwd(), transcriptPath: transcriptOf(r) },
    top,
    sessionWin,
    mode,
    /** The ledger this point writes: none when it is off or read-only. */
    ledgerOf: (m) => {
      const file = m && writes && win ? ledgerFor(m) : undefined;
      return file && win ? { dir: win, file } : undefined;
    },
    repoScopes: scopesAt.get,
    workPlace: placed.get,
    recentPaths: paths.get,
    movePlace: (moved) => {
      if (moved) named = () => moved;
      scopesAt.reset();
      paths.reset();
      placed.reset();
    },
  };
  try {
    if (event === "PostToolUse") toolResult(ctx);
    else if (event === "PostToolBatch") return toolBatch(ctx);
    else if (event === "SubagentStop") subagentStop(ctx);
    else if (event === "Stop" || event === "SessionEnd") sleepAfterTurn(ctx);
    else if (event === "SessionStart") return sessionStart(ctx);
    else if (event === "SubagentStart") return subagentStart(ctx);
    else if (event === "FileChanged") return fileChanged(ctx);
    else if (event === "CwdChanged") return withWatch(ctx, null);
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
  const body = await readHookPayload();
  // Fail open (EXECUTION §5): nothing to say prints nothing, and so does an error.
  try {
    const out = memoryHookResponse(body, stageOf(arg));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
}

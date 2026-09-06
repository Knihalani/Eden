import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { edenHome, ensureHome, appendJsonl, eventsPath, readConfig, readJson, withFileLock, withFileLockAsync, outboxPath, wrapPlaneUrl, writeFileAtomic } from "./home";
import { redact, isStretchEnd, inDistribution, protocolHeaders } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import { eligibleForTransparent, executeTransparent, inSessionBucket, postToolUseReplacement, type LiveTool } from "./transparent";
import { applyHookOutput } from "./transcript-diff";
import { appendLedgerRow, armRemainder, armRemainderFromBatch, claimRemainder, parseToolCalls, remainderDenyReason } from "./remainder";
import { mapHostToolName } from "./shapes";
import { memoryHookResponse } from "./memory-hook";

export type HookIn = {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: unknown;
  tool_calls?: unknown;
  cwd?: string;
  prompt?: string;
  transcript_path?: string;
  source?: string;
};

export type HookHost = "claude" | "gemini" | "opencode" | "codex" | "unknown";

const EVENT_ALIASES: Record<string, string> = {
  AfterToolUse: "PostToolUse",
  AfterTool: "PostToolUse",
  post_tool: "PostToolUse",
  "tool.execute.after": "PostToolUse",
  AfterToolBatch: "PostToolBatch",
  post_tool_batch: "PostToolBatch",
  BeforeToolUse: "PreToolUse",
  BeforeTool: "PreToolUse",
  pre_tool: "PreToolUse",
  "tool.execute.before": "PreToolUse",
  SessionEnd: "Stop",
  session_stop: "Stop",
  session_end: "Stop",
  sessionEnd: "Stop",
  AfterAgent: "Stop", afterAgent: "Stop", SubagentStop: "Stop", subagent_stop: "Stop", afterAgentResponse: "Stop", AfterAgentResponse: "Stop",
  stop: "Stop",
  session_start: "SessionStart",
  sessionStart: "SessionStart",
  user_prompt_submit: "UserPromptSubmit",
  beforeSubmitPrompt: "UserPromptSubmit",
  beforeSubmit: "UserPromptSubmit",
  composerSubmit: "UserPromptSubmit",
  "prompt.submit": "UserPromptSubmit",
  "chat.message": "UserPromptSubmit",
  BeforeAgent: "UserPromptSubmit",
  pre_compact: "PreCompact",
  preCompact: "PreCompact",
  PreCompress: "PreCompact",
};

function asRecord(v: unknown): Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function detectHookHost(r: Record<string, unknown>, eventRaw: string): HookHost {
  if (
    eventRaw === "AfterTool" ||
    eventRaw === "BeforeTool" ||
    eventRaw === "AfterToolUse" ||
    eventRaw === "BeforeToolUse"
  ) {
    return "gemini";
  }
  if (
    eventRaw === "post_tool" ||
    eventRaw === "pre_tool" ||
    eventRaw === "tool.execute.after" ||
    eventRaw === "tool.execute.before" ||
    typeof r.sessionID === "string"
  ) {
    return "opencode";
  }
  const tr = asRecord(r.tool_response);
  if (typeof tr.llmContent === "string") return "gemini";
  if (
    eventRaw === "PostToolUse" ||
    eventRaw === "PreToolUse" ||
    eventRaw === "Stop" ||
    eventRaw === "SessionStart" ||
    eventRaw === "UserPromptSubmit" ||
    eventRaw === "PreCompact" ||
    eventRaw === "PostToolBatch"
  ) {
    return "claude";
  }
  return "unknown";
}

/** Map host-native hook payloads onto Claude-shaped {@link HookIn}. */
export function normalizeHookIn(raw: unknown): { hook: HookIn; host: HookHost } {
  const r = asRecord(raw);
  const eventRaw = String(r.hook_event_name ?? r.hookEventName ?? r.event ?? "");
  const hook_event_name = EVENT_ALIASES[eventRaw] ?? (eventRaw || undefined);
  let host = detectHookHost(r, eventRaw);
  const toolRaw = r.tool_name ?? r.tool ?? r.toolName;
  const tool_name = typeof toolRaw === "string" && toolRaw ? mapHostToolName(toolRaw) : undefined;
  const sessionRaw = r.session_id ?? r.sessionID ?? r.sessionId;
  const session_id = typeof sessionRaw === "string" && sessionRaw ? sessionRaw : undefined;
  const tool_input = asRecord(r.tool_input ?? r.args ?? r.parameters);
  let tool_response: unknown = r.tool_response ?? r.tool_output ?? r.result;
  if (tool_response === undefined && typeof r.output === "string") tool_response = r.output;
  const tr = asRecord(tool_response);
  if (typeof tr.llmContent === "string") {
    if (host === "unknown") host = "gemini";
    tool_response = tr.llmContent;
  }
  const cwdRaw = r.cwd;
  const cwd = typeof cwdRaw === "string" && cwdRaw ? cwdRaw : undefined;
  const promptRaw = r.prompt;
  const prompt = typeof promptRaw === "string" ? promptRaw : undefined;
  const transcriptRaw = r.transcript_path ?? r.transcriptPath;
  const transcript_path = typeof transcriptRaw === "string" && transcriptRaw ? transcriptRaw : undefined;
  return {
    host,
    hook: {
      ...r,
      hook_event_name,
      session_id,
      tool_name,
      tool_input,
      tool_response,
      cwd,
      prompt,
      transcript_path,
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (process.stdin.isTTY) resolve("{}");
  });
}

export async function runHook(): Promise<void> {
  const raw = await readStdin();
  let body: HookIn = {};
  try {
    body = JSON.parse(raw || "{}") as HookIn;
  } catch {
    body = {}
  }
  const HOOK_TIMEOUT_MS = 2_500;
  let out: Record<string, unknown> = { ok: true };
  try {
    out = await Promise.race([
      respondToHook(body),
      new Promise<Record<string, unknown>>((resolve) =>
        setTimeout(() => resolve({ ok: true, eden_timeout: true }), HOOK_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    process.stderr.write(`eden hook: ${(err as Error)?.message ?? String(err)}\n`);
    out = {};
  }
  process.stdout.write(JSON.stringify(out));
}

/** Sync lock for one-shot `eden hook`; hookd passes async so sleepSync cannot stall other sessions. */
export type HookLocker = <T>(lockPath: string, fn: () => T) => T | Promise<T>;

function readConfigSafely(): { steer_hooks?: boolean } | null {
  try {
    return readConfig();
  } catch {
    return null;
  }
}

function readJsonl(path: string): Array<Record<string, unknown>> {  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);
}

/** Tools-only hook stretch. Real `usage` is attached at ingest from the chat proxy. */
export function hookTraceBody(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const first = events[0]!;
  const t0 = Number(first.ts ?? Date.now());
  const t1 = Number(events.at(-1)?.ts ?? t0);
  return {
    events,
    input: first.args ?? {},
    output: lastOkResult(events),
    llmCalls: 0,
    duration_ms: Math.max(0, t1 - t0),
    cost_cents: 0,
    complete: true,
  };
}

function lastOkResult(events: Array<Record<string, unknown>>): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.ok !== false && ev.result !== undefined) return ev.result;
  }
  return undefined;
}

function flushSession(session: string, events: Array<Record<string, unknown>>): void {
  const cfg = readConfig();
  if (!cfg || events.length < 2) return;
  const path = eventsPath(session);
  const flushedIds = events.map((e) => String(e.id ?? ""));
  void fetch(`${wrapPlaneUrl(cfg.base_url)}/v1/traces`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.api_key}`, "content-type": "application/json", ...protocolHeaders() },
    body: JSON.stringify({ id: crypto.randomUUID(), ...hookTraceBody(events) }),
  })
    .then((r) => {
      if (r.ok) withFileLock(`${path}.lock`, () => applyFlushTruncate(path, flushedIds));
    })
    .catch(() => undefined);
}

/** Drop consumed log lines by exact text so a concurrent append cannot vanish. */
export function dropConsumedLines(path: string, consumed: string[]): void {
  if (!consumed.length || !existsSync(path)) return;
  const drop = new Set(consumed);
  const current = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const rest = current.filter((l) => !drop.has(l));
  if (rest.length === current.length) return;
  writeFileAtomic(path, rest.length ? rest.join("\n") + "\n" : "");
  setCursorLines(path, rest.length);
}

export function applyFlushTruncate(path: string, flushedIds: string[]): void {
  const drop = new Set(flushedIds.filter(Boolean));
  if (!drop.size) return;
  const current = readJsonl(path);
  const rest = current.filter((e) => !drop.has(String(e.id ?? "")));
  if (rest.length === current.length) return;
  writeFileAtomic(path, rest.length ? rest.map((e) => JSON.stringify(e)).join("\n") + "\n" : "");
  setCursorLines(path, rest.length);
}

/** Sidecar `<session>.jsonl.cursor.json` so PostToolUse does not re-parse the whole log. */
function cursorPathFor(path: string): string {
  return `${path}.cursor.json`;
}

function readCursorLines(path: string): number | null {
  try {
    const c = JSON.parse(readFileSync(cursorPathFor(path), "utf8")) as { lines?: unknown };
    if (typeof c?.lines === "number" && Number.isInteger(c.lines) && c.lines >= 0) return c.lines;
  } catch {
    /* absent, corrupt, or half-written: fall through to a rebuild */
  }
  return null;
}

function setCursorLines(path: string, lines: number): void {
  writeFileAtomic(cursorPathFor(path), JSON.stringify({ lines }));
}

function countSessionLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

/** Count one append under `${path}.lock`. Rebuild a missing cursor from the log, never restart at zero. */
export function recordAppendedEvent(path: string, append: () => void): number {
  const prev = readCursorLines(path);
  const lines = (prev ?? countSessionLines(path)) + 1;
  append();
  setCursorLines(path, lines);
  return lines;
}

export async function respondToHook(
  raw: HookIn,
  locker: HookLocker = withFileLock,
): Promise<Record<string, unknown>> {
  const { hook: body, host } = normalizeHookIn(raw);
  ensureHome();
  const session = body.session_id || "local";
  const name = body.tool_name;
  const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;
  if (
    body.hook_event_name === "UserPromptSubmit" ||
    body.hook_event_name === "SessionStart" ||
    body.hook_event_name === "PreCompact"
  ) {
    try {
      const mem = memoryHookResponse(body as Record<string, unknown>);
      if (mem) return { ok: true, ...mem };
    } catch {
      /* fall open */
    }
    return { ok: true };
  }
  if (body.hook_event_name === "PostToolUse" && name) {
    const event = redact({
      id: crypto.randomUUID(),
      name,
      args: body.tool_input ?? {},
      result: body.tool_response ?? body.tool_output,
      ok: (body as { is_error?: boolean }).is_error !== true,
      ts: Date.now(),
    }) as Record<string, unknown>;
    const path = eventsPath(session);
    let lineCount = 0;
    await locker(`${path}.lock`, () => {
      lineCount = recordAppendedEvent(path, () => appendJsonl(path, event));
    });
    if (lineCount >= 2 && isStretchEnd(name)) {
      const events = readJsonl(path);
      if (events.length >= 2) flushSession(session, events);
    }
    try {
      const liveRaw = readJson<unknown>(join(edenHome(), "live-tools.json"), []);
      const live = (Array.isArray(liveRaw) ? liveRaw : []) as LiveTool[];
      const entry = live.find(
        (t) =>
          (t.sequence ?? [])[0] === name &&
          inSessionBucket(t, body.session_id) &&
          eligibleForTransparent(t, body.tool_input ?? {}),
      );
      if (entry) {
        const receiptText = await executeTransparent(entry, body.tool_input ?? {});
        if (receiptText !== null) {
          const replacement = postToolUseReplacement(
            name,
            body.tool_response ?? body.tool_output ?? "",
            receiptText,
            entry.name,
          );
          try {
            await armRemainder(session, entry, body.tool_input ?? {}, locker, cwd);
            appendLedgerRow({ session, class: "transparent", program: entry.name, programId: entry.id });
            const original = body.tool_response ?? body.tool_output ?? "";
            const applied = applyHookOutput(name, original, replacement);
            if (applied.droppedRewrite) {
              appendLedgerRow({ session, class: "host-drop", program: entry.name, programId: entry.id, tool: name });
            }
          } catch {
            /* serve stands even if remainder/ledger fail */
          }
          return replacement;
        }
      }
    } catch {
      /* fall open */
    }
  }
  if (body.hook_event_name === "PostToolBatch") {
    try {
      const parsed = parseToolCalls(body.tool_calls);
      if (!parsed) return {};
      const calls = parsed.map((c) => ({
        tool_name: mapHostToolName(c.tool_name),
        tool_input: c.tool_input,
      }));
      const liveRaw = readJson<unknown>(join(edenHome(), "live-tools.json"), []);
      const live = (Array.isArray(liveRaw) ? liveRaw : []) as Array<{
        name?: string;
        id?: string;
        sequence?: string[];
        envelope?: { inputs?: Record<string, unknown[]> } | null;
      }>;
      const events = readJsonl(eventsPath(session));
      const servedHeads = new Set(events.map((e) => mapHostToolName(String(e.name ?? ""))));
      const covered = await armRemainderFromBatch(session, calls, live, locker, { servedHeads, cwd });
      if (!covered.length) return {};
      const programs = [...new Set(covered)].join(", ");
      const restNames = [...new Set(calls.map((c) => c.tool_name))].join(", ");
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolBatch",
          additionalContext: remainderDenyReason(programs, restNames),
        },
      };
    } catch {
      return {};
    }
  }
  if (body.hook_event_name === "Stop" || body.hook_event_name === "SessionEnd") {
    try {
      memoryHookResponse(body as Record<string, unknown>);
    } catch {
      /* observe is best-effort */
    }
    await locker(`${outboxPath()}.lock`, () =>
      appendJsonl(outboxPath(), { run_id: session, kind: "stretch_end", ts: Date.now() }),
    );
    const path = eventsPath(session);
    const events = readJsonl(path);
    if (events.length >= 2) flushSession(session, events);
  }
  const liveRaw = readJson<unknown>(join(edenHome(), "live-tools.json"), []);
  const live = (
    Array.isArray(liveRaw) ? liveRaw : []
  ) as Array<{ name: string; sequence?: string[]; envelope?: { inputs?: Record<string, unknown[]> } }>;
  const cfg = readConfigSafely();
  if (body.hook_event_name === "PreToolUse" && name) {
    try {
      const claimed = await claimRemainder(session, name, body.tool_input ?? {}, locker, undefined, cwd);
      if (claimed) {
        try {
          appendLedgerRow({
            session,
            class: "steered-skip",
            program: claimed.program,
            programId: claimed.programId,
            tool: name,
          });
        } catch {
          /* deny still stands */
        }
        const reason = remainderDenyReason(claimed.program, name);
        const deny: Record<string, unknown> = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
        if (host === "gemini") {
          deny.decision = "deny";
          deny.reason = reason;
        }
        return deny;
      }
    } catch {
      /* fall open */
    }
    if (live.some((t) => t.name === name)) return { ok: true };
    const steerHooks =
      process.env.EDEN_STEER_HOOKS === "1" || cfg?.steer_hooks === true;
    if (!steerHooks) return { ok: true };
    const hits = live
      .filter((t) => (t.sequence ?? [])[0] === name && inSessionBucket(t, body.session_id))
      .sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0));
    const hit = hits[0];
    if (hit && typeof hit.name === "string" && hit.name.length > 0) {
      if (hit.envelope?.inputs) {
        const probe = {
          contract: { envelope: hit.envelope, allowExact: false, witnesses: 1, minLlmReduction: 2 },
        } as StretchProgram;
        if (!inDistribution(probe, body.tool_input ?? {})) return { ok: true };
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Use the Eden compiled tool ${hit.name} via MCP instead of ${name}.`,
        },
      };
    }
  }
  return { ok: true };
}

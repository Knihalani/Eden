import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "@eden/ir";
import { childSessionName, openMemory, type MemoryRecord } from "../../../src/index";
import { GistStore, scrubTombstonedIdentity } from "../../../src/gist-store";
import { memoryConsent } from "../../../src/memory-consent";
import { renderPacket, shapePacket } from "../../../src/memory-hook-packet";
import type { ProvenanceNote } from "../../../src/memory-provenance";
import { isNonHumanSubmit, turnMode } from "../../../src/memory-turn";
import { appendTurn, cronHashes, recordCrons, transcriptOffset, windowDir } from "../../../src/memory-window";
import { consolidate } from "../../../src/sleep";
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

function hookMemory(opts: { dir?: string; session?: string; child: boolean; cwd?: string }) {
  return openMemory(opts);
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenContent).filter(Boolean).join("\n");
  const o = asRec(content);
  return String(o.text ?? o.content ?? o.stdout ?? o.stderr ?? o.output ?? o.message ?? o.error ?? o.llmContent ?? "");
}

const INTENTION_TAG = /^(?:intention|intent|rule|constraint|never|always|must|prefer)$/i;

function isPinnedIntention(r: MemoryRecord): boolean {
  return r.kind === "constraint" || (r.tags ?? []).some((t) => t.toLowerCase() === "pin" || INTENTION_TAG.test(t));
}

function additional(event: string, packet: string): Record<string, unknown> | null {
  return packet
    ? { additional_context: packet, hookSpecificOutput: { hookEventName: event, additionalContext: packet } }
    : null;
}

/** SessionStart's packet: the newest pinned rules, then this session's latest gists (P2.5 rebuilds it, D23). */
function briefing(mem: ReturnType<typeof openMemory>, session = ""): string {
  const seen = new Set<string>(),
    notes: ProvenanceNote[] = [],
    add = (note: ProvenanceNote) => {
      let text = String(note.text ?? "").trim();
      try {
        text = scrubTombstonedIdentity(text, mem.dir).trim();
      } catch {}
      if (!text || seen.has(text.toLowerCase())) return;
      seen.add(text.toLowerCase());
      notes.push({ ...note, text });
    };
  mem
    .memories()
    .filter(isPinnedIntention)
    .sort((a, b) => Number(b.kind === "constraint") - Number(a.kind === "constraint") || b.at - a.at)
    .slice(0, 8)
    .forEach(add);
  try {
    for (const g of new GistStore(mem.dir).latest(session || "", 3, { excludeSrc: "experience" }))
      add({ text: g.text, kind: "gist", tags: ["gist"], at: g.t });
  } catch {}
  return renderPacket(notes);
}

/** The memory root: `EDEN_MEMORY_DIR`, else `$EDEN_HOME/memory`, else `~/.eden/memory`. */
function memoryRoot(): string {
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

export function messagesFromTranscript(path: string): { role: string; content: string }[] {
  try {
    const out: { role: string; content: string }[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      try {
        const o = asRec(JSON.parse(line)),
          msg = asRec(o.message ?? o),
          rawRole = String(msg.role || o.type || o.role || ""),
          role =
            rawRole === "human" || rawRole === "Human" || rawRole === "user"
              ? "user"
              : rawRole === "model" ||
                  rawRole === "Model" ||
                  rawRole === "ai" ||
                  rawRole === "AI" ||
                  rawRole === "assistant"
                ? "assistant"
                : "",
          content = flattenContent(msg.content ?? o.content ?? msg.parts);
        if ((role === "user" || role === "assistant") && content) out.push({ role, content });
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
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

export function memoryHookResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const consent = memoryConsent();
    if (consent === "off") return null;
    const r = asRec(raw),
      event = String(r.hook_event_name ?? r.hookEventName ?? r.event ?? "");
    if (!MEMORY_EVENTS.has(event)) return null;
    const writes = consent === "on",
      cwd = typeof r.cwd === "string" && r.cwd ? r.cwd : undefined;
    if (!writes && (event === "PostToolUse" || event === "SubagentStop" || event === "Stop" || event === "SessionEnd"))
      return null;
    let resolved: { session?: string; child: boolean } = { child: false };
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
        childId = [
          r.agent_id,
          r.agentId,
          r.subagent_id,
          r.subagentId,
          r.child_session_id,
          process.env.EDEN_MEMORY_CHILD,
        ]
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .find(Boolean);
      const asChild = event === "SubagentStop" || !!(childId && childId !== parent),
        session = asChild ? childSessionName(parent, childId || "sub") : parent;
      resolved = { session: asChild && session ? session : parent, child: !!(asChild && session) };
    } catch {
      resolved = { child: false };
    }
    const root = memoryRoot(),
      win = resolved.child ? undefined : windowDir(root, resolved.session ?? ""),
      prompt = promptOf(r);
    // D24, A4 §5.1 step 0: a non-human submit gets nothing, before any store is opened.
    if (event === "UserPromptSubmit" && isNonHumanSubmit(prompt, win ? cronHashes(win) : [])) return null;
    const mem = hookMemory({ dir: root, session: resolved.session, child: resolved.child, cwd });
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
          if (text) mem.observe([{ role: "user", content: text }]);
          else if (event === "SubagentStop" && prior.length) mem.observe(prior);
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
            mem.observe(extra ? [...prior, { role: "user", content: extra }] : prior, { keepLiveIdentity: true });
          } catch {}
        return additional(event, briefing(mem, resolved.session));
      }
      if (stop) {
        if (writes) {
          if (event === "Stop" && win)
            try {
              recordCrons(win, r.session_crons);
            } catch {}
          try {
            if (prior.length || extra)
              mem.observe(extra ? [...prior, { role: "user", content: extra }] : prior, { keepLiveIdentity: true });
          } catch {}
          try {
            consolidate(mem, { session: resolved.session, mode: "full" });
          } catch {}
        }
        return null;
      }
      if (event === "UserPromptSubmit" && writes && win)
        try {
          appendTurn(win, { promptId: str(r.prompt_id), prompt, off: transcriptOffset(transPath) });
        } catch {}
      const previousAssistant = prior.findLast((m) => m.role === "assistant")?.content ?? "",
        mode = event === "UserPromptSubmit" ? turnMode(prompt, { previousAssistant }) : "imperative",
        cue = [{ role: "user", content: prompt }];
      let notes: MemoryRecord[] = [];
      // A4 §5.1: every human submit is encoded (step 1); the turn mode decides only whether it is answered (step 2).
      if (prompt && mode === "imperative") notes = mem.recall(cue);
      else if (prompt) mem.observeCue(cue);
      if (writes && prior.length) mem.observe(prior);
      return additional(event, renderPacket(shapePacket(notes)));
    } finally {
      try {
        mem.close();
      } catch {}
    }
  } catch {
    return null;
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
  try {
    process.stdout.write(JSON.stringify(memoryHookResponse(body) ?? {}));
  } catch {
    process.stdout.write("{}");
  }
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@eden/ir";
import { childSessionName, MEMORY_MARK, openMemory, type MemoryRecord } from "../../../src/index";
import { GistStore, scrubTombstonedIdentity } from "../../../src/gist-store";
import { memoryConsent } from "../../../src/memory-consent";
import { applyProvenanceLabel } from "../../../src/memory-provenance";
import { opaqueId } from "../../../src/memory-scrub";
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

function additional(event: string, text: string): Record<string, unknown> | null {
  const notes = String(text ?? "").trim();
  return notes && notes.includes(MEMORY_MARK)
    ? { additional_context: notes, hookSpecificOutput: { hookEventName: event, additionalContext: notes } }
    : null;
}

function briefing(mem: ReturnType<typeof openMemory>, session = ""): string {
  const seen = new Set<string>(),
    lines: string[] = [],
    pins = mem
      .memories()
      .filter(isPinnedIntention)
      .sort((a, b) => Number(b.kind === "constraint") - Number(a.kind === "constraint") || b.at - a.at)
      .slice(0, 8);
  for (const r of pins) {
    let text = r.text.trim();
    try {
      text = scrubTombstonedIdentity(text, mem.dir).trim();
    } catch {}
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    let line = text;
    try {
      line = applyProvenanceLabel({ ...r, text }, text);
    } catch {
      line = `[rule] ${text}`;
    }
    lines.push(`\n- ${line.replace(/^\s*-\s*/, "")}`);
  }
  try {
    for (const g of new GistStore(mem.dir).latest(session || "", 3, { excludeSrc: "experience" })) {
      let text = g.text.trim();
      try {
        text = scrubTombstonedIdentity(text, mem.dir).trim();
      } catch {}
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      let line = text;
      try {
        line = applyProvenanceLabel(
          { id: `gist:${opaqueId(text)}`, text, kind: "gist", tags: ["gist"], at: g.t },
          text,
        );
      } catch {
        line = `[gist] ${text}`;
      }
      lines.push(`\n- ${line.replace(/^\s*-\s*/, "")}`);
    }
  } catch {}
  if (!lines.length) return "";
  return MEMORY_MARK + lines.join("");
}

export function notesFromInject(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => asRec(m))
    .filter((o) => o.role === "system" && typeof o.content === "string" && String(o.content).includes(MEMORY_MARK))
    .map((o) => String(o.content))
    .join("\n\n");
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
    const mem = hookMemory({
      dir: process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined),
      session: resolved.session,
      child: resolved.child,
      cwd,
    });
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
      const prompt =
          ([
            r.prompt,
            r.text,
            r.input,
            r.message,
            r.body,
            r.query,
            r.user_message,
            r.response,
            r.last_user_message,
            r.user_text,
            r.content,
          ].find((x) => typeof x === "string" && x) as string) || "",
        notes = prompt ? notesFromInject(mem.inject([{ role: "user", content: prompt }])) : "";
      if (writes && prior.length) mem.observe(prior);
      return additional(event, notes);
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

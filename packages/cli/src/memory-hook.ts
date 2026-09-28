import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@eden/ir";
import { childSessionName, MEMORY_MARK, openMemory, type MemoryRecord } from "../../../src/index";
import { GistStore, scrubTombstonedIdentity } from "../../../src/gist-store";
import { dropHarmed } from "../../../src/memory-harmed";
import { memoryConsent } from "../../../src/memory-consent";
import { applyProvenanceLabel } from "../../../src/memory-provenance";
import { opaqueId } from "../../../src/memory-scrub";
import { consolidate } from "../../../src/sleep";
import { parseHookToolTraces, persistToolTraces } from "../../../src/tool-trace";

const live = new Map<string, ReturnType<typeof openMemory>>();
const MEMORY_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd", "PostToolUse", "SubagentStop"]);

function hookMemory(opts: { dir?: string; agent?: string; project?: string; session?: string; child: boolean; cwd?: string }) {
  const key = `${opts.dir ?? ""}\0${opts.session ?? ""}\0${opts.child ? "1" : "0"}\0${opts.agent ?? ""}`;
  let mem = live.get(key);
  if (!mem) {
    mem = openMemory(opts);
    live.set(key, mem);
  }
  return mem;
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const o = asRec(content);
    if (Array.isArray(o.parts)) return flattenContent(o.parts);
    return String(o.text ?? o.content ?? o.llmContent ?? o.reasoning_content ?? o.thinking ?? o.reasoning ?? "");
  }
  return content.map(flattenContent).filter(Boolean).join("\n");
}

const INTENTION_TAG = /^(?:intention|intent|rule|constraint|never|always|must|prefer)$/i;

function isPinnedIntention(r: MemoryRecord): boolean {
  if (!r.text) return false;
  if (r.kind === "constraint") return true;
  return (r.tags ?? []).some((t) => t.toLowerCase() === "pin" || INTENTION_TAG.test(t));
}

function recordFromJsonlLine(raw: unknown): MemoryRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return null;
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    id: typeof o.id === "string" && o.id ? o.id : `pin:${text.slice(0, 32)}`,
    text,
    kind: typeof o.kind === "string" && o.kind ? o.kind : "fact",
    tags,
    at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
  };
}

function recordsInMemoryFile(path: string): MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  try {
    if (!existsSync(path)) return [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const rec = recordFromJsonlLine(JSON.parse(line));
        if (rec) byId.set(rec.id, rec);
      } catch {}
    }
  } catch {}
  return [...byId.values()];
}

function pinsFromRoot(root: string): MemoryRecord[] {
  const files: string[] = [];
  try {
    const p = join(root, "memories.jsonl");
    if (existsSync(p)) files.push(p);
  } catch {}
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "." || ent.name === ".." || ent.name.includes("..")) continue;
      const p = join(root, ent.name, "memories.jsonl");
      try { if (existsSync(p)) files.push(p); } catch {}
    }
  } catch {}
  const byId = new Map<string, MemoryRecord>();
  for (const p of files) {
    for (const rec of recordsInMemoryFile(p)) {
      if (!isPinnedIntention(rec)) continue;
      const prev = byId.get(rec.id);
      if (!prev || rec.at >= prev.at) byId.set(rec.id, rec);
    }
  }
  return [...byId.values()];
}

function pinPacketRecord(r: MemoryRecord): MemoryRecord {
  if (r.kind === "fact" || r.kind === "preference") return { ...r, kind: "constraint" };
  return r;
}

function additional(event: string, text: string): Record<string, unknown> | null {
  const notes = String(text ?? "").trim();
  if (!notes || !notes.includes(MEMORY_MARK)) return null;
  return { additional_context: notes, hookSpecificOutput: { hookEventName: event, additionalContext: notes } };
}

/** SessionStart: pins + gists only. Not procedures, ICL, or narrative dump. */
function briefing(mem: ReturnType<typeof openMemory>, session = ""): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let pinRows = [...mem.memories().filter(isPinnedIntention), ...pinsFromRoot(mem.dir)];
  try { pinRows = dropHarmed(mem.dir, pinRows); } catch {}
  const pins = pinRows.sort((a, b) =>
    Number(b.kind === "constraint") - Number(a.kind === "constraint") || b.at - a.at
  ).slice(0, 8);
  for (const raw of pins) {
    const r = pinPacketRecord(raw);
    let text = r.text.trim();
    try {
      const cleaned = scrubTombstonedIdentity(text, mem.dir);
      if (typeof cleaned === "string") text = cleaned.trim();
    } catch {}
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    let line = text;
    try { line = applyProvenanceLabel({ ...r, text }, text); } catch { line = `[rule] ${text}`; }
    lines.push(`\n- ${line.replace(/^\s*-\s*/, "")}`);
  }
  try {
    for (const g of new GistStore(mem.dir).latest(session || "", 3, { excludeSrc: "experience" })) {
      let text = g.text.trim();
      try {
        const cleaned = scrubTombstonedIdentity(text, mem.dir);
        if (typeof cleaned === "string") text = cleaned.trim();
      } catch {}
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let line = text;
      try {
        line = applyProvenanceLabel({
          id: `gist:${opaqueId(text)}`,
          text,
          kind: "gist",
          tags: ["gist"],
          at: g.t,
        }, text);
      } catch { line = `[gist] ${text}`; }
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
    if (!path || !existsSync(path)) return [];
    const out: { role: string; content: string }[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const o = asRec(JSON.parse(line));
        const msg = asRec(o.message ?? o);
        const rawRole = String(msg.role || o.type || o.role || "");
        const role = rawRole === "human" || rawRole === "Human" || rawRole === "user" ? "user"
          : rawRole === "model" || rawRole === "Model" || rawRole === "ai" || rawRole === "AI" || rawRole === "assistant" ? "assistant"
          : "";
        const content = flattenContent(msg.content ?? o.content ?? msg.parts);
        if ((role === "user" || role === "assistant") && content) out.push({ role, content });
      } catch {}
    }
    return out.slice(-40);
  } catch {
    return [];
  }
}

function payloadMessages(r: Record<string, unknown>): { role: string; content: string }[] {
  const list = (Array.isArray(r.messages) ? r.messages : Array.isArray(r.conversation) ? r.conversation : Array.isArray(r.contents) ? r.contents : []) as unknown[];
  return list.flatMap((m) => {
    const o = asRec(m);
    const c = flattenContent(o.content ?? o.parts ?? o);
    const raw = String(o.role || "");
    const role = raw === "human" || raw === "Human" ? "user" : raw === "model" || raw === "Model" || raw === "ai" || raw === "AI" ? "assistant" : raw;
    return (role === "user" || role === "assistant") && c ? [{ role, content: c }] : [];
  });
}

export function memoryHookResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const consent = memoryConsent();
    if (consent === "off") return null;
    const r = asRec(raw);
    const event = String(r.hook_event_name ?? r.hookEventName ?? r.event ?? "");
    if (!MEMORY_EVENTS.has(event)) return null;
    const writes = consent === "on";
    if (!writes && (event === "PostToolUse" || event === "SubagentStop" || event === "Stop" || event === "SessionEnd")) return null;
    const cwd = typeof r.cwd === "string" && r.cwd ? r.cwd : undefined;
    const agent = [process.env.EDEN_MEMORY_AGENT, r.agent].find((x) => typeof x === "string" && x);
    let resolved: { session?: string; child: boolean } = { child: false };
    try {
      const parent = [r.session_id, r.sessionID, r.sessionId, r.parent_session_id, process.env.EDEN_MEMORY_PARENT, process.env.EDEN_MEMORY_SESSION].map((v) => typeof v === "string" ? v.trim() : "").find(Boolean);
      const childId = [r.agent_id, r.agentId, r.subagent_id, r.subagentId, r.child_session_id, process.env.EDEN_MEMORY_CHILD].map((v) => typeof v === "string" ? v.trim() : "").find(Boolean);
      const distinct = !!(childId && childId !== parent);
      const asChild = event === "SubagentStop" || distinct;
      if (!asChild) resolved = { session: parent, child: false };
      else {
        const session = childSessionName(parent, childId || "sub");
        resolved = session ? { session, child: true } : { session: parent, child: false };
      }
    } catch {
      resolved = { child: false };
    }
    const mem = hookMemory({
      dir: process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined),
      agent: typeof agent === "string" ? agent : undefined,
      project: cwd || process.env.EDEN_MEMORY_PROJECT || undefined,
      session: resolved.session,
      child: resolved.child,
      cwd,
    });
    try {
    const transPath = typeof r.transcript_path === "string" ? r.transcript_path : typeof r.transcriptPath === "string" ? r.transcriptPath : "";
    const fromFile = messagesFromTranscript(transPath);
    const fromPayload = payloadMessages(r);
    const prior = (fromPayload.length ? fromPayload : fromFile).slice(-40);
    if (event === "PostToolUse" || event === "SubagentStop") {
      try {
        const name = [r.tool_name, r.toolName, r.tool].find((x) => typeof x === "string" && String(x).trim()) as string | undefined;
        const original = r.tool_response ?? r.tool_output ?? r.result ?? r.output;
        const redacted = original == null || original === "" ? "" : redact(original);
        let result = "";
        if (typeof redacted === "string") result = redacted;
        else if (redacted && typeof redacted === "object") {
          const o = asRec(redacted);
          result = [o.stdout, o.stderr, o.text, o.content, o.llmContent, o.output, o.message, o.error].filter((x) => typeof x === "string" && x).join("\n") || flattenContent(redacted);
          if (!result) try { result = JSON.stringify(redacted); } catch { result = ""; }
        }
        result = (typeof redact(result) === "string" ? String(redact(result)) : result).trim().replace(/\s+/g, " ");
        if (result.length > 360) result = result.slice(0, 360);
        const who = (name || "subagent").replace(/\s+/g, " ").replace(/([.!?])\s+/g, "; ").trim() || "subagent";
        let text = "";
        if (!result) {
          try {
            const blob = typeof original === "string" ? original : original != null ? JSON.stringify(original) : "";
            if (/RootWebArea|\[landmark\]|accessibility_tree/i.test(blob)) text = `The ${who} tool was called.`;
          } catch {}
        } else {
          const sentence = `The ${who} tool result is ${result}.`;
          const safe = redact(sentence);
          text = typeof safe === "string" ? safe : sentence;
        }
        if (text) mem.observe([{ role: "user", content: text }]);
        else if (event === "SubagentStop" && prior.length) mem.observe(prior);
        try { persistToolTraces(mem.jsonlDir, parseHookToolTraces(r)); } catch {}
      } catch {}
      return null;
    }
    const stop = event === "Stop" || event === "SessionEnd";
    if (event === "SessionStart") {
      const extra = [r.prompt, r.text, r.input, r.message, r.body, r.query, r.user_message, r.content].filter((x) => typeof x === "string" && x).join("\n");
      if (writes && (prior.length || extra)) {
        try { mem.observe(extra ? [...prior, { role: "user", content: extra }] : prior, { keepLiveIdentity: true }); } catch {}
      }
      return additional(event, briefing(mem, resolved.session));
    }
    if (stop) {
      const extra = [r.prompt, r.text, r.input, r.message, r.body, r.query, r.user_message, r.prompt_response, r.response, r.output, r.completion, r.result, r.answer, r.reply, r.last_user_message, r.user_text, r.assistant_message, r.last_assistant_message, r.final_response, r.assistant_text, r.content].filter((x) => typeof x === "string" && x).join("\n");
      if (writes) {
        try {
          if (prior.length || extra) mem.observe(extra ? [...prior, { role: "user", content: extra }] : prior, { keepLiveIdentity: true });
        } catch {}
        try { consolidate(mem, { session: resolved.session, mode: "full" }); } catch {}
      }
      return null;
    }
    const prompt = [r.prompt, r.text, r.input, r.message, r.body, r.query, r.user_message, r.response, r.last_user_message, r.user_text, r.content].find((x) => typeof x === "string" && x) as string || "";
    const notes = prompt
      ? mem.inject([{ role: "user", content: prompt }]).map((m) => asRec(m)).filter((o) => o.role === "system" && typeof o.content === "string" && o.content.includes(MEMORY_MARK)).map((o) => String(o.content)).join("\n\n")
      : "";
    if (writes && prior.length) mem.observe(prior);
    return notes ? { additional_context: notes, hookSpecificOutput: { hookEventName: event, additionalContext: notes } } : null;
    } finally {
      try { mem.close(); } catch {}
    }
  } catch {
    return null;
  }
}

export async function runMemoryHookStdin(): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse((await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (c) => chunks.push(c as Buffer));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      if (process.stdin.isTTY) resolve("{}");
    })) || "{}") as Record<string, unknown>;
  } catch {}
  try { process.stdout.write(JSON.stringify(memoryHookResponse(body) ?? {})); } catch { process.stdout.write("{}"); }
}

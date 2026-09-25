import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "@eden/ir";
import { omitExperienceTree, putExperienceFromTool } from "../../../src/experience-store";
import { GistStore, scrubTombstonedIdentity } from "../../../src/gist-store";
import { parseHookToolTraces, parseToolArgs, persistToolTraces } from "../../../src/tool-trace";
import { childSessionName, consolidate, dropHarmed, formatPacketText, loadHarmedIds, MEMORY_MARK, memoryWalPath, openMemory, placePathsFrom, type AgentMemory, type MemoryRecord } from "../../../src/index";
import { maybeIncrementalSleep } from "../../../src/sleep";
import { memoryConsent } from "../../../src/memory-consent";
import { logMemoryNotes } from "../../../src/memory-log";
import { opaqueId } from "../../../src/memory-scrub";

const MEMORY_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd", "PostToolUse", "SubagentStop"]);

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

export function messagesFromTranscript(path: unknown, cap = 40): Array<{ role: string; content: string }> {
  if (typeof path !== "string" || !path || !existsSync(path)) return [];
  try {
    const out: Array<{ role: string; content: string }> = [];
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-Math.max(cap * 2, cap))) try {
      const rec = asRec(JSON.parse(line));
      const msg = Object.keys(asRec(rec.message)).length ? asRec(rec.message) : rec;
      const rawRole = String(msg.role || rec.type || "");
      const role = rawRole === "human" || rawRole === "Human" ? "user" : rawRole === "model" || rawRole === "Model" || rawRole === "ai" || rawRole === "AI" ? "assistant" : rawRole;
      const content = [flattenContent(msg.content ?? msg.parts), String(msg.llmContent ?? msg.reasoning_content ?? msg.thinking ?? msg.reasoning ?? "")].filter(Boolean).join("\n");
      if ((role === "user" || role === "assistant") && content) out.push({ role, content });
    } catch {}
    return out.slice(-cap);
  } catch {
    return [];
  }
}

export function notesFromInject(injected: unknown[]): string {
  return injected.map((m) => asRec(m)).filter((o) => o.role === "system" && typeof o.content === "string" && (o.content.includes(MEMORY_MARK) || o.content.includes("Eden Know:"))).map((o) => String(o.content)).join("\n\n");
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
    sal: typeof o.sal === "number" && Number.isFinite(o.sal) ? o.sal : undefined,
  };
}

function recordsInMemoryFile(path: string): MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  const order: string[] = [];
  const ingest = (file: string) => {
    try {
      if (!existsSync(file)) return;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const rec = recordFromJsonlLine(JSON.parse(line));
          if (!rec) continue;
          if (!byId.has(rec.id)) order.push(rec.id);
          byId.set(rec.id, rec);
        } catch {}
      }
    } catch {}
  };
  ingest(path);
  try { ingest(memoryWalPath(path)); } catch {}
  return order.map((id) => byId.get(id)!);
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

function briefing(mem: AgentMemory, session = ""): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  const logged: { id: string; at: number }[] = [];
  let pinRows = [...mem.memories().filter(isPinnedIntention), ...pinsFromRoot(mem.dir)];
  try { pinRows = dropHarmed(mem.dir, pinRows); } catch {}
  const pins = pinRows.sort((a, b) =>
    Number(b.kind === "constraint") - Number(a.kind === "constraint") || (b.sal ?? 0) - (a.sal ?? 0) || b.at - a.at
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
    try { line = formatPacketText({ ...r, text }); } catch { line = `[rule] ${text}`; }
    lines.push(`\n- ${line.replace(/^\s*-\s*/, "")}`);
    logged.push({ id: r.id, at: r.at });
  }
  try {
    let gistHarmed = new Set<string>();
    try { gistHarmed = loadHarmedIds(mem.dir); } catch { gistHarmed = new Set(); }
    const harmedText: string[] = [];
    try {
      for (const r of mem.memories()) {
        if (!r?.id || !gistHarmed.has(r.id)) continue;
        const t = String(r.text ?? "").replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!?]+$/g, "");
        if (t.length >= 8) harmedText.push(t);
      }
    } catch {}
    const withoutHarmed = (text: string): string => {
      try {
        if (gistHarmed.has(`gist:${opaqueId(text)}`)) return "";
        const parts = text.split(/(?<=[.!?])\s+/);
        const kept = parts.filter((p) => {
          const norm = p.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!?]+$/g, "");
          if (!norm) return false;
          return !harmedText.some((t) => norm.includes(t) || t.includes(norm));
        });
        return kept.join(" ").trim();
      } catch {
        return text;
      }
    };
    for (const g of new GistStore(mem.dir).latest(session || "", 3, { excludeSrc: "experience" })) {
      try {
        const src = typeof g.src === "string" ? g.src : "";
        if (src && gistHarmed.has(src)) continue;
      } catch {}
      let text = g.text.trim();
      try { text = withoutHarmed(text); } catch {}
      if (!text) continue;
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
        line = formatPacketText({
          id: `gist:${opaqueId(text)}`,
          text,
          kind: "gist",
          tags: ["gist"],
          at: g.t,
        });
      } catch { line = `[gist] ${text}`; }
      lines.push(`\n- ${line.replace(/^\s*-\s*/, "")}`);
      logged.push({ id: `gist:${opaqueId(text)}`, at: g.t });
    }
  } catch {}
  if (!lines.length) return "";
  try { logMemoryNotes(logged); } catch {}
  return MEMORY_MARK + lines.join("");
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s) return s;
  }
  return undefined;
}

function resolveHookSession(raw: Record<string, unknown>): { session?: string; child: boolean } {
  try {
    const parent = firstString(raw.session_id, raw.sessionID, raw.sessionId, raw.parent_session_id, process.env.EDEN_MEMORY_PARENT, process.env.EDEN_MEMORY_SESSION);
    const childId = firstString(raw.agent_id, raw.agentId, raw.subagent_id, raw.subagentId, raw.child_session_id, process.env.EDEN_MEMORY_CHILD);
    const event = String(raw.hook_event_name ?? raw.hookEventName ?? raw.event ?? "");
    const distinct = !!(childId && childId !== parent);
    const asChild = event === "SubagentStop" || distinct;
    if (!asChild) return { session: parent, child: false };
    const session = childSessionName(parent, childId || "sub");
    if (!session) return { session: parent, child: false };
    return { session, child: true };
  } catch {
    return { child: false };
  }
}

function hookMemory(raw: Record<string, unknown> = {}): AgentMemory {
  const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : undefined;
  const agent = [process.env.EDEN_MEMORY_AGENT, raw.agent].find((x) => typeof x === "string" && x);
  const resolved = resolveHookSession(raw);
  return openMemory({
    dir: process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined),
    agent: typeof agent === "string" ? agent : undefined,
    project: cwd || process.env.EDEN_MEMORY_PROJECT || undefined,
    session: resolved.session,
    child: resolved.child,
    cwd,
  });
}

function additional(event: string, text: string): Record<string, unknown> | null {
  return text ? { additional_context: text, hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replace(/([.!?])\s+/g, "; ").trim();
}

function toolObserveText(r: Record<string, unknown>): string {
  const name = [r.tool_name, r.toolName, r.tool].find((x) => typeof x === "string" && String(x).trim()) as string | undefined;
  const original = r.tool_response ?? r.tool_output ?? r.result ?? r.output;
  let raw: unknown = original;
  try {
    raw = omitExperienceTree(original);
  } catch {}
  const redacted = raw == null || raw === "" ? "" : redact(raw);
  let result = "";
  if (typeof redacted === "string") result = redacted;
  else if (redacted && typeof redacted === "object") {
    const o = asRec(redacted);
    result = [o.stdout, o.stderr, o.text, o.content, o.llmContent, o.output, o.message, o.error].filter((x) => typeof x === "string" && x).join("\n") || flattenContent(redacted);
    if (!result) try { result = JSON.stringify(redacted); } catch { result = ""; }
  }
  result = collapse(typeof redact(result) === "string" ? String(redact(result)) : result);
  if (result.length > 360) result = result.slice(0, 360);
  const who = collapse(name || "subagent") || "subagent";
  if (!result) {
    try {
      const blob = typeof original === "string" ? original : original != null ? JSON.stringify(original) : "";
      if (/RootWebArea|\[landmark\]|accessibility_tree/i.test(blob)) return `The ${who} tool was called.`;
    } catch {}
    return "";
  }
  const sentence = `The ${who} tool result is ${result}.`;
  const safe = redact(sentence);
  return typeof safe === "string" ? safe : sentence;
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
    const mem = hookMemory(r);
    try {
    const sessionRaw0 = r.session_id ?? r.sessionID ?? r.sessionId;
    const session0 = typeof sessionRaw0 === "string" && sessionRaw0 ? sessionRaw0 : undefined;
    const sleepSession = mem.child && mem.session ? mem.session : session0;
    if (writes && event !== "Stop" && event !== "SessionEnd" && event !== "SessionStart") {
      try { maybeIncrementalSleep(mem, { session: sleepSession }); } catch {}
    }
    const prior = [...messagesFromTranscript(r.transcript_path ?? r.transcriptPath ?? r.transcript), ...((Array.isArray(r.messages) ? r.messages : Array.isArray(r.conversation) ? r.conversation : Array.isArray(r.contents) ? r.contents : []) as unknown[]).flatMap((m) => { const o = asRec(m); const c = flattenContent(o.content ?? o.parts ?? o); const raw = String(o.role || ""); const role = raw === "human" || raw === "Human" ? "user" : raw === "model" || raw === "Model" || raw === "ai" || raw === "AI" ? "assistant" : raw; return (role === "user" || role === "assistant") && c ? [{ role, content: c }] : []; })].slice(-40);
    if (event === "PostToolUse" || event === "SubagentStop") {
      try {
        const text = toolObserveText(r);
        if (text) mem.observe([{ role: "user", content: text }]);
        else if (event === "SubagentStop" && prior.length) mem.observe(prior);
      } catch {}
      try {
        persistToolTraces(mem.jsonlDir, parseHookToolTraces(r));
      } catch {}
      try {
        const sessionRaw = r.session_id ?? r.sessionID ?? r.sessionId;
        const session = typeof sessionRaw === "string" && sessionRaw ? sessionRaw : undefined;
        const cwd = typeof r.cwd === "string" && r.cwd.trim() ? r.cwd.trim() : undefined;
        const name = [r.tool_name, r.toolName, r.tool].find((x) => typeof x === "string" && String(x).trim()) as string | undefined;
        const args = parseToolArgs(r.tool_input ?? r.tool_args ?? r.args ?? r.parameters ?? r.input);
        const result = r.tool_response ?? r.tool_output ?? r.result ?? r.output;
        if (name || result != null) {
          putExperienceFromTool(mem.dir, { session, cwd, name, args, result });
        }
      } catch {}
      try {
        maybeIncrementalSleep(mem, { session: sleepSession });
      } catch {}
      return null;
    }
    const stop = event === "Stop" || event === "SessionEnd";
    if (stop || event === "SessionStart") {
      const extra = [r.prompt, r.text, r.input, r.message, r.body, r.query, r.user_message, r.prompt_response, r.response, r.output, r.completion, r.result, r.answer, r.reply, r.last_user_message, r.user_text, r.assistant_message, r.last_assistant_message, r.final_response, r.assistant_text, r.content].filter((x) => typeof x === "string" && x).join("\n");
      const sessionRaw = r.session_id ?? r.sessionID ?? r.sessionId;
      const session = (mem.child && mem.session) || (typeof sessionRaw === "string" ? sessionRaw : "");
      if (writes) {
        if (stop && !prior.length && !extra) {
          try { consolidate(mem, { session: session || undefined, mode: "full" }); } catch {}
          return null;
        }
        mem.observe(extra ? [...prior, { role: "user", content: extra }] : prior, { keepLiveIdentity: true });
        try { consolidate(mem, { session: session || undefined, mode: "full" }); } catch {}
      }
      if (stop) return null;
      return additional(event, briefing(mem, session));
    }
    const prompt = [r.prompt, r.text, r.input, r.message, r.body, r.query, r.user_message, r.response, r.last_user_message, r.user_text, r.content].find((x) => typeof x === "string" && x) as string || "";
    let files: string[] = [];
    try {
      const got = placePathsFrom(r);
      if (Array.isArray(got)) files = got.filter((p) => typeof p === "string" && p);
    } catch {}
    const notes = prompt
      ? notesFromInject(mem.inject([{ role: "user", content: prompt, ...(files.length ? { files } : {}) }]))
      : "";
    if (writes && prior.length) mem.observe(prior);
    if (writes) {
      try { maybeIncrementalSleep(mem, { session: sleepSession }); } catch {}
    }
    return additional(event, notes);
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_MARK, openMemory, type AgentMemory } from "../../../src/index";

const MEMORY_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd"]);
const EVENT_ALIASES: Record<string, string> = { user_prompt_submit: "UserPromptSubmit", session_start: "SessionStart", sessionStart: "SessionStart", session_end: "SessionEnd", sessionEnd: "SessionEnd", pre_compact: "PreCompact", preCompact: "PreCompact", PreCompress: "PreCompact", session_stop: "Stop", stop: "Stop", AfterAgent: "Stop", beforeSubmitPrompt: "UserPromptSubmit", BeforeAgent: "UserPromptSubmit" };

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "string" ? b : String(asRec(b).text ?? asRec(b).content ?? asRec(b).alt ?? asRec(b).name ?? ""))).filter(Boolean).join("\n");
}

export function messagesFromTranscript(path: unknown, cap = 40): Array<{ role: string; content: string }> {
  if (typeof path !== "string" || !path || !existsSync(path)) return [];
  try {
    const out: Array<{ role: string; content: string }> = [];
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-Math.max(cap * 2, cap))) try {
      const rec = asRec(JSON.parse(line));
      const msg = Object.keys(asRec(rec.message)).length ? asRec(rec.message) : rec;
      const role = String(msg.role || rec.type || "");
      const content = flattenContent(msg.content);
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

function briefing(mem: AgentMemory): string {
  const recs = mem.memories();
  const pick = [...recs.filter((r) => r.kind === "constraint").slice(-6), ...recs.filter((r) => r.kind !== "constraint").slice(-6)];
  return pick.length ? MEMORY_MARK + pick.map((m) => `\n- ${m.text}`).join("") : "";
}

function hookMemory(raw: Record<string, unknown> = {}): AgentMemory {
  const cwd = asRec(raw).cwd;
  return openMemory({ dir: process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined), agent: process.env.EDEN_MEMORY_AGENT || undefined, project: typeof cwd === "string" && cwd ? cwd : process.env.EDEN_MEMORY_PROJECT || undefined });
}

function additional(event: string, text: string): Record<string, unknown> | null {
  return text ? { additional_context: text, hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

export function memoryHookResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const r = asRec(raw);
    const event = EVENT_ALIASES[String(r.hook_event_name ?? r.hookEventName ?? r.event ?? "")] ?? String(r.hook_event_name ?? r.hookEventName ?? r.event ?? "");
    if (!MEMORY_EVENTS.has(event)) return null;
    const mem = hookMemory(r);
    const prior = messagesFromTranscript(r.transcript_path);
    const stop = event === "Stop" || event === "SessionEnd";
    if (stop || event === "SessionStart") {
      const extra = String(r.prompt ?? r.text ?? r.prompt_response ?? "");
      mem.observe(prior.length ? prior : extra ? [{ role: "user", content: extra }] : []);
      return stop ? null : additional(event, briefing(mem));
    }
    const prompt = String(r.prompt ?? r.text ?? "");
    const list = prompt ? [...prior, { role: "user", content: prompt }] : prior.length ? prior : [{ role: "user", content: "continue" }];
    return additional(event, notesFromInject(mem.inject(list)));
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

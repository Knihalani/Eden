import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_MARK, openMemory, type AgentMemory } from "../../../src/index";

const MEMORY_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd"]);

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const o = asRec(content);
    if (Array.isArray(o.parts)) return flattenContent(o.parts);
    if (Array.isArray(o.candidates)) return flattenContent(o.candidates.map((x) => asRec(x).content ?? x));
    const sys = o.systemInstruction ?? o.system_instruction;
    const body = String(o.text ?? o.content ?? o.llmContent ?? o.reasoning_content ?? o.thinking ?? o.reasoning ?? o.alt ?? o.name ?? o.caption ?? o.title ?? o.filename ?? o.value ?? "");
    return sys && sys !== content ? [flattenContent(sys), body].filter(Boolean).join("\n") : body;
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

function briefing(mem: AgentMemory, q = ""): string {
  const pick = mem.notesFor(q);
  return pick.length ? MEMORY_MARK + pick.map((m) => `\n- ${m.text}`).join("") : "";
}

function hookMemory(raw: Record<string, unknown> = {}): AgentMemory {
  const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : undefined;
  const agent = [process.env.EDEN_MEMORY_AGENT, raw.agent].find((x) => typeof x === "string" && x);
  return openMemory({ dir: process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined), agent: typeof agent === "string" ? agent : undefined, project: cwd || process.env.EDEN_MEMORY_PROJECT || undefined });
}

function additional(event: string, text: string): Record<string, unknown> | null {
  return text ? { additional_context: text, hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

export function memoryHookResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const r = asRec(raw);
    const event = String(r.hook_event_name ?? r.hookEventName ?? r.event ?? "");
    if (!MEMORY_EVENTS.has(event)) return null;
    const mem = hookMemory(r);
    const prior = [...messagesFromTranscript(r.transcript_path ?? r.transcriptPath ?? r.transcript), ...((Array.isArray(r.messages) ? r.messages : Array.isArray(r.conversation) ? r.conversation : Array.isArray(r.contents) ? r.contents : []) as unknown[]).flatMap((m) => { const o = asRec(m); const c = flattenContent(o.content ?? o.parts ?? o); const raw = String(o.role || ""); const role = raw === "human" || raw === "Human" ? "user" : raw === "model" || raw === "Model" || raw === "ai" || raw === "AI" ? "assistant" : raw; return (role === "user" || role === "assistant") && c ? [{ role, content: c }] : []; })].slice(-40);
    const stop = event === "Stop" || event === "SessionEnd";
    if (stop || event === "SessionStart") {
      const extra = [r.prompt, r.text, r.input, r.message, r.body, r.query, r.user_message, r.prompt_response, r.response, r.output, r.completion, r.result, r.answer, r.reply, r.last_user_message, r.user_text, r.assistant_message, r.last_assistant_message, r.final_response, r.assistant_text, r.content, r.systemInstruction, r.system_instruction, r.system, r.system_prompt, r.systemPrompt].filter((x) => typeof x === "string" && x).join("\n");
      if (stop && !prior.length && !extra) return null;
      mem.observe(extra ? [...prior, { role: "user", content: extra }] : prior);
      return stop ? null : additional(event, briefing(mem, extra));
    }
    const prompt = [r.prompt, r.text, r.input, r.message, r.body, r.query, r.user_message, r.response, r.last_user_message, r.user_text, r.content, r.system_instruction, r.system, r.system_prompt, r.systemPrompt].find((x) => typeof x === "string" && x) as string || "";
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

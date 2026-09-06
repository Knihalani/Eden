import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_MARK, openMemory, type AgentMemory } from "../../../src/index";

const MEMORY_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd"]);
const EVENT_ALIASES: Record<string, string> = {
  user_prompt_submit: "UserPromptSubmit",
  session_start: "SessionStart",
  pre_compact: "PreCompact",
  session_stop: "Stop",
};

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : String(asRec(b).text ?? asRec(b).content ?? asRec(b).alt ?? asRec(b).name ?? "")))
    .filter(Boolean)
    .join("\n");
}

export function messagesFromTranscript(path: unknown, cap = 40): Array<{ role: string; content: string }> {
  if (typeof path !== "string" || !path || !existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const out: Array<{ role: string; content: string }> = [];
    for (const line of lines.slice(-Math.max(cap * 2, cap))) {
      let j: unknown;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = asRec(j);
      const msg = Object.keys(asRec(rec.message)).length ? asRec(rec.message) : rec;
      const role = String(msg.role || rec.type || "");
      if (role !== "user" && role !== "assistant") continue;
      const content = flattenContent(msg.content);
      if (content) out.push({ role, content });
    }
    return out.slice(-cap);
  } catch {
    return [];
  }
}

export function notesFromInject(injected: unknown[]): string {
  const parts: string[] = [];
  for (const m of injected) {
    const o = asRec(m);
    if (o.role !== "system") continue;
    const c = typeof o.content === "string" ? o.content : "";
    if (c.includes(MEMORY_MARK) || c.includes("Eden Know:")) parts.push(c);
  }
  return parts.join("\n\n");
}

function briefing(mem: AgentMemory): string {
  const recs = mem.memories();
  const constraints = recs.filter((r) => r.kind === "constraint").slice(-6);
  const seen = new Set(constraints.map((r) => r.id));
  const pick = [...constraints, ...recs.filter((r) => !seen.has(r.id)).slice(-6)];
  return pick.length ? MEMORY_MARK + pick.map((m) => `\n- ${m.text}`).join("") : "";
}

function hookMemory(raw: Record<string, unknown> = {}): AgentMemory {
  const cwd = asRec(raw).cwd;
  const home = process.env.EDEN_HOME;
  return openMemory({
    dir: process.env.EDEN_MEMORY_DIR || (home ? join(home, "memory") : undefined),
    agent: process.env.EDEN_MEMORY_AGENT || undefined,
    project: typeof cwd === "string" && cwd ? cwd : process.env.EDEN_MEMORY_PROJECT || undefined,
  });
}

function additional(event: string, text: string): Record<string, unknown> | null {
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

export function memoryHookResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const event = EVENT_ALIASES[String(asRec(raw).hook_event_name ?? "")] ?? String(asRec(raw).hook_event_name ?? "");
    if (!MEMORY_EVENTS.has(event)) return null;
    const mem = hookMemory(asRec(raw));
    const prior = messagesFromTranscript(asRec(raw).transcript_path);
    if (event === "Stop" || event === "SessionEnd") {
      if (prior.length) mem.observe(prior);
      mem.close();
      return null;
    }
    if (event === "SessionStart") {
      if (prior.length) mem.observe(prior);
      const text = briefing(mem);
      mem.close();
      return additional(event, text);
    }
    const prompt = String(asRec(raw).prompt ?? "");
    const list = prompt ? [...prior, { role: "user", content: prompt }] : prior.length ? prior : [{ role: "user", content: "continue" }];
    const notes = notesFromInject(mem.inject(list));
    mem.close();
    return additional(event, notes);
  } catch {
    return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (process.stdin.isTTY) resolve("{}");
  });
}

export async function runMemoryHookStdin(): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse((await readStdin()) || "{}") as Record<string, unknown>;
  } catch {}
  try {
    process.stdout.write(JSON.stringify(memoryHookResponse(body) ?? {}));
  } catch {
    process.stdout.write("{}");
  }
}

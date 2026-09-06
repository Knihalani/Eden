import { existsSync, readFileSync } from "node:fs";
import { MEMORY_MARK, openMemory, type AgentMemory } from "../../../src/index";

const MEMORY_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd"]);

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === "string") {
      parts.push(b);
      continue;
    }
    const o = asRec(b);
    const t = o.text ?? o.content ?? o.alt ?? o.name;
    if (typeof t === "string" && t) parts.push(t);
  }
  return parts.join("\n");
}

/** Last turns of a Claude Code JSONL transcript. Fail-open: missing/corrupt → []. */
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
  if (!recs.length) return "";
  const constraints = recs.filter((r) => r.kind === "constraint").slice(-6);
  const seen = new Set(constraints.map((r) => r.id));
  const others: typeof recs = [];
  for (let i = recs.length - 1; i >= 0 && others.length < 6; i--) {
    const r = recs[i]!;
    if (!seen.has(r.id)) others.push(r);
  }
  const pick = [...constraints, ...others.reverse()];
  if (!pick.length) return "";
  return MEMORY_MARK + pick.map((m) => `\n- ${m.text}`).join("");
}

function hookMemory(): AgentMemory {
  return openMemory({
    dir: process.env.EDEN_MEMORY_DIR || undefined,
    agent: process.env.EDEN_MEMORY_AGENT || undefined,
  });
}

function additional(event: string, text: string): Record<string, unknown> | null {
  if (!text) return null;
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text,
    },
  };
}

/**
 * Passive memory for coding-agent hooks. Never throws to the caller.
 * UserPromptSubmit / PreCompact inject; SessionStart briefs; Stop observes.
 */
export function memoryHookResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const event = String(asRec(raw).hook_event_name ?? "");
    if (!MEMORY_EVENTS.has(event)) return null;
    const mem = hookMemory();
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

/** Stdin JSON → stdout JSON. Always prints a body; never a non-zero exit. */
export async function runMemoryHookStdin(): Promise<void> {
  const raw = await readStdin();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    body = {};
  }
  let out: Record<string, unknown> = {};
  try {
    out = memoryHookResponse(body) ?? {};
  } catch {
    out = {};
  }
  process.stdout.write(JSON.stringify(out));
}

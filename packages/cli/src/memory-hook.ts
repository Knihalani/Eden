import { join } from "node:path";
import { redact } from "@eden/ir";
import { childSessionName, MEMORY_MARK, openMemory } from "../../../src/index";
import { memoryConsent } from "../../../src/memory-consent";

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
    const prior = ((Array.isArray(r.messages) ? r.messages : Array.isArray(r.conversation) ? r.conversation : Array.isArray(r.contents) ? r.contents : []) as unknown[]).flatMap((m) => { const o = asRec(m); const c = flattenContent(o.content ?? o.parts ?? o); const raw = String(o.role || ""); const role = raw === "human" || raw === "Human" ? "user" : raw === "model" || raw === "Model" || raw === "ai" || raw === "AI" ? "assistant" : raw; return (role === "user" || role === "assistant") && c ? [{ role, content: c }] : []; }).slice(-40);
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
        result = (typeof redact(result) === "string" ? String(redact(result)) : result).replace(/\s+/g, " ").replace(/([.!?])\s+/g, "; ").trim();
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
      } catch {}
      return null;
    }
    const stop = event === "Stop" || event === "SessionEnd";
    if (stop || event === "SessionStart") {
      const extra = [r.prompt, r.text, r.input, r.message, r.body, r.query, r.user_message, r.prompt_response, r.response, r.output, r.completion, r.result, r.answer, r.reply, r.last_user_message, r.user_text, r.assistant_message, r.last_assistant_message, r.final_response, r.assistant_text, r.content].filter((x) => typeof x === "string" && x).join("\n");
      if (writes) {
        if (stop && !prior.length && !extra) return null;
        mem.observe(extra ? [...prior, { role: "user", content: extra }] : prior);
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

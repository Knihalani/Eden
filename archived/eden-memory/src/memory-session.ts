/**
 * Session and window names (D2): a name is safe as one path segment, and a subagent's window is `session--agent`; a
 * subagent's own transcript. Apart from `index.ts`, so a hook that names a window (the PreToolUse guard) need not load
 * the store.
 */
import { join } from "node:path";
export function memorySessionName(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s &&
    !s.includes("\0") &&
    !s.includes("/") &&
    !s.includes("\\") &&
    !s.split("--").join("").includes("..") &&
    /^[A-Za-z0-9._-]+$/.test(s) &&
    s !== "." &&
    s !== ".."
    ? s
    : undefined;
}

export function childSessionName(parent?: string, child?: string): string | undefined {
  const p = memorySessionName(parent),
    c = memorySessionName(child);
  return p && c ? memorySessionName(`${p}--${c}`) : (c ?? p);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * A subagent's own transcript (D25: its window's distance is measured on it): the payload's `agent_transcript_path`
 * (SubagentStop), else `<session>/subagents/agent-<agent_id>.jsonl` beside the session's transcript; "" when neither
 * can be named.
 */
export function childTranscript(r: Record<string, unknown>): string {
  const own = str(r.agent_transcript_path);
  if (own) return own;
  const main = str(r.transcript_path);
  const agent = memorySessionName(r.agent_id);
  if (!main?.endsWith(".jsonl") || !agent) return "";
  const name = agent.startsWith("agent-") ? agent : `agent-${agent}`;
  return join(main.slice(0, -".jsonl".length), "subagents", `${name}.jsonl`);
}

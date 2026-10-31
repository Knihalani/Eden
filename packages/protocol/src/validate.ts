/**
 * Runtime checks for what arrives over the wire. Hand-written rather than schema-library based: the shapes are
 * small, and the server must reject a malformed event with a clear message rather than a stack trace.
 */
import type { AgentEvent, AskRequest } from "./types";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown, max = 1_000_000): v is string => typeof v === "string" && v.length <= max;
/** The id shape for tenants, users, sessions and injections: no `/` or `#`, which scope keys use as separators. */
export const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:@-]{1,128}$/.test(v);

/**
 * Whether `v` serializes to JSON of at most `max` characters. The engine stringifies a tool call's input, so input it
 * cannot stringify (nested past the stack limit) or that is huge is the caller's error, not a 503 later.
 */
function jsonUnder(v: unknown, max: number): boolean {
  try {
    return (JSON.stringify(v ?? null)?.length ?? 0) <= max;
  } catch {
    return false;
  }
}

function scopeError(r: Record<string, unknown>): string | null {
  if (!isId(r.tenantId)) return "tenantId must be 1-128 characters of [A-Za-z0-9._:@-]";
  if (!isId(r.userId)) return "userId must be 1-128 characters of [A-Za-z0-9._:@-]";
  if (!isId(r.sessionId)) return "sessionId must be 1-128 characters of [A-Za-z0-9._:@-]";
  return null;
}

export function checkEvent(v: unknown): Checked<AgentEvent> {
  if (!isRecord(v)) return { ok: false, error: "event must be an object" };
  const scope = scopeError(v);
  if (scope) return { ok: false, error: scope };
  const at = typeof v.at === "number" && Number.isFinite(v.at) ? v.at : Date.now();
  const base = { tenantId: v.tenantId as string, userId: v.userId as string, sessionId: v.sessionId as string, at };
  switch (v.kind) {
    case "session_start":
      return { ok: true, value: { ...base, kind: "session_start", agent: isText(v.agent, 200) ? v.agent : undefined } };
    case "session_end":
      return { ok: true, value: { ...base, kind: "session_end" } };
    case "user_message":
    case "agent_message":
      if (!isText(v.text)) return { ok: false, error: `${v.kind}.text must be a string` };
      // A draft the user is still typing (`anticipate`): only `true` marks one, anything else is a sent message.
      if (v.kind === "user_message" && v.draft === true) {
        return { ok: true, value: { ...base, kind: "user_message", text: v.text, draft: true } };
      }
      return { ok: true, value: { ...base, kind: v.kind, text: v.text } };
    case "tool_call":
      if (!isText(v.tool, 200)) return { ok: false, error: "tool_call.tool must be a string" };
      if (!jsonUnder(v.input, 1_000_000)) {
        return { ok: false, error: "tool_call.input must be JSON of at most 1,000,000 characters" };
      }
      return { ok: true, value: { ...base, kind: "tool_call", tool: v.tool, input: v.input } };
    case "tool_result":
      if (!isText(v.tool, 200) || !isText(v.output)) return { ok: false, error: "tool_result needs tool and output" };
      return {
        ok: true,
        value: { ...base, kind: "tool_result", tool: v.tool, output: v.output, isError: !!v.isError },
      };
    case "external":
      if (!isText(v.source, 200) || !isText(v.text)) return { ok: false, error: "external needs source and text" };
      return { ok: true, value: { ...base, kind: "external", source: v.source, text: v.text } };
    default:
      return { ok: false, error: `unknown event kind: ${String(v.kind)}` };
  }
}

export function checkAsk(v: unknown): Checked<AskRequest> {
  if (!isRecord(v)) return { ok: false, error: "ask must be an object" };
  const scope = scopeError(v);
  if (scope) return { ok: false, error: scope };
  if (!isText(v.question, 10_000) || !v.question.trim()) return { ok: false, error: "question must be non-empty" };
  const maxItems = typeof v.maxItems === "number" ? Math.max(1, Math.min(20, Math.floor(v.maxItems))) : undefined;
  return {
    ok: true,
    value: {
      tenantId: v.tenantId as string,
      userId: v.userId as string,
      sessionId: v.sessionId as string,
      question: v.question,
      maxItems,
    },
  };
}

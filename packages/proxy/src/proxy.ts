/**
 * Eden in front of the agent's model, as an OpenAI-compatible proxy (D280).
 * The agent changes only its base URL; on each `POST …/chat/completions` the proxy
 *
 * 1. reports the conversation's new messages to Eden as events (a user message, the assistant's text and tool calls,
 *    tool results), each message once per conversation,
 * 2. puts the context Eden returns in a system message just before the latest user message (`withContext`'s place),
 *    keeping the turn's earlier packets so every model call of a tool-using turn sees them, and
 * 3. forwards the request to the upstream model and streams its answer back unchanged.
 *
 * Fails open (D14): with Eden down, slow or refusing, the request goes upstream as it came. Identity: the
 * `x-eden-user-id` header, else the body's OpenAI `user` field; the conversation is `x-eden-session-id`, else a hash
 * of the conversation's first messages (stable as it grows). Ids pass through `edenId`. No user id: no Eden.
 * The upstream key (`Authorization`) is forwarded and never logged; only the message text goes to Eden, as with the
 * SDK. Eden's `ask_context` is not added: give the agent the MCP tool for that (docs/INTEGRATION.md).
 */
import { createHash } from "node:crypto";
import { EdenClient, edenId, withContext } from "@eden/client";
import type { Injection } from "@eden/protocol";

export interface ProxyOptions {
  /** The model's OpenAI-compatible base URL, with its version path (`https://api.openai.com/v1`). */
  upstream: string;
  /** Eden's HTTP API. */
  edenUrl: string;
  edenApiKey?: string;
  /** How long a user message's observe may wait for Eden's lookup (ms); the client's default, 3,000. */
  waitMs?: number;
  /** Conversations remembered (which messages were reported, the turn's packets); least recent dropped. */
  maxSessions?: number;
  /**
   * Shadow mode: report events and let Eden decide, but forward every request unchanged. A trial with no risk to the
   * agent's answers: what Eden would have added is in its traces (`/v1/explain`, `bun run trace-report`) and in
   * `onShadow`'s counts.
   */
  shadow?: boolean;
  /** In shadow mode, per request Eden would have changed: the user, session and the packets' item ids (no text). */
  onShadow?: (record: { userId: string; sessionId: string; packets: number; itemIds: string[] }) => void;
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
}

interface Message {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

interface Conversation {
  /** Messages already reported to Eden (a prefix of the history). */
  reported: number;
  /** The packets Eden gave since the latest user message, re-inserted on every call of the turn. */
  packets: Injection[];
}

const HOP_BY_HOP = ["host", "connection", "content-length", "accept-encoding", "transfer-encoding"];
const DROP_FROM_UPSTREAM = ["content-encoding", "content-length", "transfer-encoding", "connection"];

/** The text of an OpenAI message's content (a string, or text parts); images and other parts are left out. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? (p as { text?: unknown }).text : "",
    )
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
}

type EventInput = Parameters<EdenClient["observe"]>[0];

/** Eden events for one message; `tools` maps a tool call id to its tool's name, for the results that follow. */
export function eventsOf(m: Message, tools: Map<string, string>): EventInput[] {
  const text = textOf(m.content);
  if (m.role === "user") return text ? [{ kind: "user_message", text }] : [];
  if (m.role === "assistant") {
    const out: EventInput[] = text ? [{ kind: "agent_message", text }] : [];
    for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
      if (typeof fn?.name !== "string") continue;
      const id = (call as { id?: unknown }).id;
      if (typeof id === "string") tools.set(id, fn.name);
      let input: unknown = fn.arguments;
      try {
        if (typeof input === "string") input = JSON.parse(input);
      } catch {
        // Arguments that are not JSON go as their text.
      }
      out.push({ kind: "tool_call", tool: fn.name, input: input ?? {} });
    }
    return out;
  }
  if (m.role === "tool" || m.role === "function") {
    const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
    const tool = tools.get(id) ?? (typeof m.name === "string" ? m.name : "tool");
    return text ? [{ kind: "tool_result", tool, output: text }] : [];
  }
  return [];
}

export function createProxy(options: ProxyOptions): (req: Request) => Promise<Response> {
  const upstream = options.upstream.replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const maxSessions = options.maxSessions ?? 10_000;
  const conversations = new Map<string, Conversation>();
  const report = (e: unknown) => {
    try {
      options.onError?.(e);
    } catch {
      // A broken logger never breaks the agent's call.
    }
  };

  const forward = (req: Request, path: string, body: string | ArrayBuffer | null): Promise<Response> => {
    const headers = new Headers(req.headers);
    for (const h of HOP_BY_HOP) headers.delete(h);
    for (const h of [...headers.keys()]) if (h.startsWith("x-eden-")) headers.delete(h);
    return doFetch(`${upstream}${path}`, { method: req.method, headers, body }).then((res) => {
      const out = new Headers(res.headers);
      for (const h of DROP_FROM_UPSTREAM) out.delete(h);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    });
  };

  /** The request's messages with Eden's context in place, or null when Eden has nothing or cannot be used. */
  const withEden = async (req: Request, body: Record<string, unknown>): Promise<Message[] | null> => {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const rawUser = req.headers.get("x-eden-user-id") ?? (typeof body.user === "string" ? body.user : "");
    if (!rawUser) return null;
    const userId = edenId(rawUser);
    // The conversation: the caller's id, else its opening (system prompt and first user message), stable as it grows.
    const rawSession = req.headers.get("x-eden-session-id");
    const opening = messages.slice(0, 2).map((m: Message) => `${String(m.role)}:${textOf(m.content)}`);
    const sessionId = rawSession
      ? edenId(rawSession)
      : `c:${createHash("sha256").update(JSON.stringify(opening)).digest("hex").slice(0, 32)}`;
    const key = `${userId}#${sessionId}`;
    const conv = conversations.get(key) ?? { reported: 0, packets: [] };
    conversations.delete(key);
    conversations.set(key, conv);
    if (conversations.size > maxSessions) conversations.delete(conversations.keys().next().value!);
    // A history that shrank (edited, truncated) reports nothing old again: only what lies past it is new.
    if (conv.reported > messages.length) conv.reported = messages.length;
    const eden = new EdenClient({
      baseUrl: options.edenUrl,
      ...(options.edenApiKey ? { apiKey: options.edenApiKey } : {}),
      userId,
      sessionId,
      onError: report,
      ...(options.waitMs !== undefined ? { defaultWaitMs: options.waitMs } : {}),
    });
    const tools = new Map<string, string>();
    for (const m of messages.slice(0, conv.reported) as Message[]) eventsOf(m, tools);
    const fresh = messages.slice(conv.reported) as Message[];
    conv.reported = messages.length;
    const got: Injection[] = [];
    const lastUser = fresh.map((m) => m.role).lastIndexOf("user");
    if (lastUser >= 0) conv.packets = [];
    for (const [i, m] of fresh.entries()) {
      for (const ev of eventsOf(m, tools)) {
        // Only the latest user message waits for its lookup; older new messages are reported without a wait.
        const waiting = ev.kind === "user_message" && i === lastUser;
        const { injection } = await eden.observe(ev, waiting ? {} : { waitMs: 0 });
        if (injection) got.push(injection);
      }
    }
    got.push(...(await eden.pending()));
    const seen = new Set(conv.packets.map((p) => p.id));
    for (const p of got) if (!seen.has(p.id)) conv.packets.push(p);
    if (conv.packets.length === 0) return null;
    if (options.shadow) {
      const itemIds = conv.packets.flatMap((p) => p.citations.map((c) => c.itemId));
      try {
        options.onShadow?.({ userId, sessionId, packets: conv.packets.length, itemIds });
      } catch {
        // A broken sink never breaks the agent's call.
      }
      return null;
    }
    return withContext(messages as { role: string; content: unknown }[], conv.packets);
  };

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "") + url.search;
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      try {
        return await forward(req, path, req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer());
      } catch (e) {
        report(e);
        return Response.json({ error: { message: "eden proxy: upstream unreachable" } }, { status: 502 });
      }
    }
    const raw = await req.text();
    let sent = raw;
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // Not JSON: the upstream answers it as it would (never logged here: the error could quote the body).
    }
    try {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const messages = await withEden(req, body as Record<string, unknown>);
        if (messages) sent = JSON.stringify({ ...(body as object), messages });
      }
    } catch (e) {
      // Anything Eden-side that threw: the request goes upstream as it came (D14).
      report(e);
    }
    try {
      return await forward(req, path, sent);
    } catch (e) {
      report(e);
      return Response.json({ error: { message: "eden proxy: upstream unreachable" } }, { status: 502 });
    }
  };
}

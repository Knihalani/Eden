/**
 * The partner as an MCP server, so any MCP-capable agent can ask it questions with one tool, `ask_context`.
 * Proactive delivery cannot ride on MCP (a server cannot speak unasked into the agent's context); that needs the
 * events API or the SDK's message hook.
 *
 * A hand-written JSON-RPC handler (D1704), not the official SDK's `McpServer`: `initialize` (the client's version
 * when supported, else the newest), `ping`, `tools/list`, `tools/call`; notifications are read and dropped; any other
 * method is "Method not found". It answers as the SDK's `McpServer` did: a bad argument, an unknown tool or a failed
 * ask is a tool result with `isError: true`, not a JSON-RPC error, so the agent reads why.
 */
import { renderAnswer, safeLine, type ContextPartner } from "@eden/engine";
import { ASK_CONTEXT_DESCRIPTION, type Scope } from "@eden/protocol";
import {
  asMessage,
  ErrorCode,
  isRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type Transport,
} from "@eden/sources";

/** An MCP session's id lasts until this long with no ask (the engine's `sessionIdleMs` default) or a UTC day ends. */
export const MCP_SESSION_IDLE_MS = 2 * 3_600_000;

/** Longest question `ask_context` takes, in UTF-16 code units (as the zod schema it replaced counted). */
export const MAX_QUESTION_CHARS = 2_000;

/** `ask_context` as `tools/list` gives it: a literal JSON Schema, checked by hand in `questionOf`. */
const ASK_CONTEXT_TOOL = {
  name: "ask_context",
  description: ASK_CONTEXT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: { question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_CHARS } },
    required: ["question"],
  },
  annotations: { readOnlyHint: true },
};

export interface McpServerOptions {
  /** The clock for session rotation (tests). */
  now?: () => number;
  idleMs?: number;
}

/** Eden's MCP server: one per connection, as the SDK's was. */
export interface EdenMcpServer {
  /** Serves `transport` until it closes. One transport per server. */
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  /** The answer to one message (null for a notification): the transport-free core, for tests and HTTP wiring. */
  handle(message: unknown): Promise<JsonRpcMessage | null>;
  /** Called when the transport closes. */
  onclose?: () => void;
}

/** The question, or why the arguments are not valid. Extra arguments are ignored, as zod's object did. */
function questionOf(args: unknown): string | { invalid: string } {
  const q = args && typeof args === "object" ? (args as Record<string, unknown>).question : undefined;
  if (typeof q !== "string") return { invalid: "question must be a string" };
  if (q.length < 1 || q.length > MAX_QUESTION_CHARS) {
    return { invalid: `question must be 1 to ${MAX_QUESTION_CHARS} characters, not ${q.length}` };
  }
  return q;
}

const toolError = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

export function createMcpServer(
  partner: ContextPartner,
  who: Scope & { sessionId: string },
  opts: McpServerOptions = {},
): EdenMcpServer {
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? MCP_SESSION_IDLE_MS;
  // D281: MCP sends no session end, and a stdio server lives as long as its client (days). With one id for its whole
  // life the reader's per-session cap (20 calls, $0.02) was spent once and the reader stayed off until a restart. The
  // id moves on after an idle gap or at UTC midnight, and the old session is ended so its state goes at once: when its
  // last ask in flight returns, since MCP clients may call tools in parallel and an ending session answers "closed".
  let session = { id: who.sessionId, n: 0, day: Math.floor(now() / 86_400_000), last: now() };
  const inFlight = new Map<string, number>();
  const ending = new Set<string>();
  const end = (sessionId: string) => {
    ending.delete(sessionId);
    void partner
      .observe({ tenantId: who.tenantId, userId: who.userId, sessionId, at: now(), kind: "session_end" })
      .catch(() => undefined);
  };
  const begin = (): string => {
    const t = now();
    const day = Math.floor(t / 86_400_000);
    if (day !== session.day || t - session.last >= idleMs) {
      const old = session.id;
      const n = session.n + 1;
      session = { id: `${who.sessionId}.${n}`, n, day, last: t };
      if (inFlight.has(old)) ending.add(old);
      else end(old);
    }
    session.last = t;
    inFlight.set(session.id, (inFlight.get(session.id) ?? 0) + 1);
    return session.id;
  };
  const finish = (sessionId: string) => {
    const left = (inFlight.get(sessionId) ?? 1) - 1;
    if (left > 0) return void inFlight.set(sessionId, left);
    inFlight.delete(sessionId);
    if (ending.has(sessionId)) end(sessionId);
  };
  const askContext = async (question: string): Promise<CallToolResult> => {
    const sessionId = begin();
    let res;
    try {
      res = await partner.ask({ ...who, sessionId, question });
    } finally {
      finish(sessionId);
    }
    // Titles and URLs are source text (an email subject is attacker-controlled): they go in a data envelope too, one
    // line each (`safeLine`, D221), so a line break in a title cannot forge another `[n]` source line.
    const cites = res.citations.map(
      (c, i) => `[${i}] ${safeLine(c.sourceId)}: ${safeLine(c.title)}${c.url ? ` (${safeLine(c.url)})` : ""}`,
    );
    const text = cites.length ? `${res.answer}\n\nSources:\n${renderAnswer(cites.join("\n"))}` : res.answer;
    return { content: [{ type: "text", text }] };
  };

  const callTool = async (params: Record<string, unknown>): Promise<CallToolResult> => {
    // As the SDK's McpServer: the message names the code, so an agent reading it sees what kind of failure it was.
    if (params.name !== ASK_CONTEXT_TOOL.name) {
      return toolError(`MCP error ${ErrorCode.InvalidParams}: Tool ${String(params.name)} not found`);
    }
    const question = questionOf(params.arguments);
    if (typeof question !== "string") {
      return toolError(
        `MCP error ${ErrorCode.InvalidParams}: Input validation error: Invalid arguments for tool ask_context: ` +
          question.invalid,
      );
    }
    try {
      return await askContext(question);
    } catch (e) {
      // The message only, as the SDK gave it: the partner's own errors name no user content.
      return toolError(e instanceof Error ? e.message : String(e));
    }
  };

  const answer = async (req: JsonRpcRequest): Promise<JsonRpcMessage> => {
    const ok = (result: Record<string, unknown>): JsonRpcMessage => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string): JsonRpcMessage => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code, message },
    });
    switch (req.method) {
      case "initialize": {
        const asked = req.params?.protocolVersion;
        const version =
          typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
        return ok({
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "eden-context", version: "0.0.0" },
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: [ASK_CONTEXT_TOOL] });
      case "tools/call":
        if (!req.params) return fail(ErrorCode.InvalidParams, "Invalid params: tools/call needs a tool name");
        return ok(await callTool(req.params));
      default:
        return fail(ErrorCode.MethodNotFound, "Method not found");
    }
  };

  const handle = async (raw: unknown): Promise<JsonRpcMessage | null> => {
    const m = asMessage(raw);
    if (!m) {
      // An id we can read back is echoed; otherwise null, as JSON-RPC asks.
      const id = (raw as { id?: unknown } | null)?.id;
      const echo = typeof id === "string" || typeof id === "number" ? id : null;
      return {
        jsonrpc: "2.0",
        id: echo as never,
        error: { code: ErrorCode.InvalidRequest, message: "Invalid Request" },
      };
    }
    // Notifications (initialized, cancelled) and responses to requests this server never sends need no answer.
    if (!isRequest(m)) return null;
    try {
      return await answer(m);
    } catch {
      // `callTool` turns a failed ask into a tool result; anything else that throws is ours: an error, not silence,
      // so the client does not wait out its timeout (the SDK answers InternalError too).
      return { jsonrpc: "2.0", id: m.id, error: { code: ErrorCode.InternalError, message: "Internal error" } };
    }
  };

  let transport: Transport | null = null;
  const server: EdenMcpServer = {
    handle,
    async connect(t) {
      if (transport) throw new Error("already connected: one transport per server");
      transport = t;
      t.onmessage = (m) => {
        void handle(m).then(
          (reply) => reply && t.send(reply).catch(() => {}),
          () => {},
        );
      };
      t.onclose = () => {
        if (transport === t) transport = null;
        server.onclose?.();
      };
      await t.start();
    },
    async close() {
      await transport?.close();
    },
  };
  return server;
}

/**
 * A minimal MCP client (D1704): `initialize` with version negotiation, `tools/list`, `tools/call`, `ping` answered
 * (at most 16 at once), every other server request dropped unanswered, server notifications handed to
 * `onnotification` when one is set (D1860). Any other method goes through `request` (`extras.ts` has resources and
 * prompts on it, outside this file so a program that does not use them does not load them). It matches the
 * official SDK's `Client` where Eden depends on it: a JSON-RPC error rejects with `McpError` (`MCP error <code>:
 * <message>`), a request times out after 60 s by default, an aborted signal sends `notifications/cancelled` and
 * rejects, a closed connection rejects every request in flight and calls `onclose`. A caller that wants to answer the
 * server's sampling, roots or elicitation requests sets a handler for each (`setRequestHandler`) and declares the
 * capability (`capabilities`, D1875); Eden sets none, so every such request is dropped as before.
 */
import { deadlines, type Deadline } from "./deadlines";
import {
  ErrorCode,
  isNotification,
  isResponse,
  LATEST_PROTOCOL_VERSION,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Tool,
  type Transport,
} from "./types";

/** Answers to the server's `ping` sent at once, at most; more are dropped until one is done. */
const MAX_PINGS_IN_FLIGHT = 16;

/** The SDK's default request timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface RequestOptions {
  signal?: AbortSignal;
  /** Default `DEFAULT_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

type Pending = (response: { result: Record<string, unknown> } | Error) => void;

/**
 * Answers one kind of server request (D1875). `params` is the server's data, unchecked; the handler returns the
 * result object, or throws: an `McpError` is sent back with its code and message, anything else as "Internal error"
 * (its text stays here). `signal` aborts when the server cancels the request or the connection closes.
 */
export type RequestHandler = (
  params: Record<string, unknown>,
  extra: { signal: AbortSignal; id: string | number },
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface ClientOptions {
  /** Sent in `initialize`: what this client offers (`{ sampling: {} }`, `{ roots: { listChanged: true } }`, …). */
  capabilities?: Record<string, unknown>;
}

/** What the server said of itself in `initialize`: untrusted, as everything a server sends. */
export interface ServerInitialize {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string; [key: string]: unknown };
  instructions?: string;
}

export class McpClient {
  /** Called once when the connection closes, whichever side closed it. */
  onclose?: () => void;
  /**
   * The server's notifications (progress, logging, list changes), shape-checked as JSON-RPC and nothing more: their
   * params are the server's data. Unset, they are dropped.
   */
  onnotification?: (notification: JsonRpcNotification) => void | Promise<void>;
  /** The server's `initialize` answer, once connected. */
  server: ServerInitialize | null = null;
  private transport: Transport | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  /** Answers to server requests (`ping` and handled ones) being worked on or sent now. */
  private pings = 0;
  /** Handlers for server requests by method; none unless the caller sets them. */
  private readonly handlers = new Map<string, RequestHandler>();
  /** Server requests a handler is working on, by id, so a cancellation or a close can stop them. */
  private readonly answering = new Map<string | number, AbortController>();

  constructor(
    private readonly info: { name: string; version: string },
    private readonly options: ClientOptions = {},
  ) {}

  /**
   * Answers the server's requests of `method` with `handler` (D1875), under the same bound as `ping`: at most 16
   * answers at once, more dropped unanswered until one is sent, and the transport's server-request budget. `ping`
   * cannot be replaced. Each answer is a POST carrying the transport's credentials, so set only what the host means
   * to do: a request is the server's data, never an instruction to the host.
   */
  setRequestHandler(method: string, handler: RequestHandler): void {
    if (method === "ping") throw new Error("ping is answered by the client");
    this.handlers.set(method, handler);
  }

  removeRequestHandler(method: string): void {
    this.handlers.delete(method);
  }

  /** Starts the transport and runs the `initialize` handshake; closes and rethrows on any failure. */
  async connect(transport: Transport, options?: RequestOptions): Promise<void> {
    this.transport = transport;
    // Earlier handlers are kept and called first, as the SDK does: a wrapper (the lab's `tap`) may have set them.
    const prev = { close: transport.onclose, error: transport.onerror, message: transport.onmessage };
    transport.onclose = () => {
      prev.close?.();
      this.closed(transport);
    };
    transport.onerror = (e) => prev.error?.(e);
    transport.onmessage = (m) => {
      prev.message?.(m);
      this.receive(m);
    };
    try {
      await transport.start();
      const result = await this.request(
        "initialize",
        {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: this.options.capabilities ?? {},
          clientInfo: this.info,
        },
        options,
      );
      const version = result.protocolVersion;
      if (typeof version !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
        throw new Error(`Server's protocol version is not supported: ${String(version)}`);
      }
      const info = isObject(result.serverInfo) ? result.serverInfo : {};
      this.server = {
        protocolVersion: version,
        capabilities: isObject(result.capabilities) ? result.capabilities : {},
        serverInfo: { ...info, name: String(info.name ?? ""), version: String(info.version ?? "") },
        ...(typeof result.instructions === "string" ? { instructions: result.instructions } : {}),
      };
      transport.setProtocolVersion?.(version);
      await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch (e) {
      void this.close().catch(() => {});
      throw e;
    }
  }

  /** One page of the server's tools. */
  async listTools(
    params?: { cursor?: string },
    options?: RequestOptions,
  ): Promise<{ tools: Tool[]; nextCursor?: string }> {
    const result = await this.request("tools/list", params?.cursor ? { cursor: params.cursor } : undefined, options);
    const tools = result.tools;
    const valid = (t: unknown): t is Tool =>
      !!t && typeof t === "object" && typeof (t as Tool).name === "string" && isObject((t as Tool).inputSchema);
    if (!Array.isArray(tools) || !tools.every(valid)) throw new Error("Server sent an invalid tools/list result");
    const next = result.nextCursor;
    return { tools, ...(typeof next === "string" ? { nextCursor: next } : {}) };
  }

  /** Calls a tool. A tool's own failure is a result with `isError: true`, not a rejection. */
  async callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: RequestOptions,
  ): Promise<CallToolResult> {
    const result = await this.request("tools/call", params, options);
    const content = result.content ?? [];
    if (!Array.isArray(content) || !content.every(isObject))
      throw new Error("Server sent an invalid tools/call result");
    if (result.structuredContent !== undefined && !isObject(result.structuredContent)) {
      throw new Error("Server sent an invalid tools/call result");
    }
    return { ...result, content } as CallToolResult;
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }

  /** Sends a notification (no answer comes back). */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.transport) throw new Error("Not connected");
    await this.transport.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  /**
   * Any request, with the timeout, cancellation and errors of the methods above; the result is the server's object,
   * unchecked: the caller checks the fields it reads.
   */
  request(
    method: string,
    params?: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const transport = this.transport;
      if (!transport) return reject(new Error("Not connected"));
      const { signal } = options;
      if (signal?.aborted) return reject(signal.reason);
      const id = this.nextId++;
      let deadline: Deadline | undefined;
      const done = () => {
        this.pending.delete(id);
        if (deadline) deadlines.cancel(deadline);
        signal?.removeEventListener("abort", onAbort);
      };
      // Given up on our side: the server is told, so it can stop work no one will read.
      const cancel = (reason: unknown) => {
        done();
        transport
          .send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: String(reason) },
          })
          .catch(() => {});
        reject(reason instanceof McpError ? reason : new McpError(ErrorCode.RequestTimeout, String(reason)));
      };
      const onAbort = () => cancel(signal!.reason);
      this.pending.set(id, (response) => {
        done();
        if (response instanceof Error) reject(response);
        else resolve(response.result);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      deadline = deadlines.add(timeoutMs, () =>
        cancel(new McpError(ErrorCode.RequestTimeout, "Request timed out", { timeout: timeoutMs })),
      );
      const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
      transport.send(message).catch((e: unknown) => {
        // Only while still waiting: an aborted request's stream ends in an AbortError that no one should see.
        if (this.pending.has(id)) {
          done();
          reject(e);
        }
      });
    });
  }

  private receive(m: JsonRpcMessage): void {
    if (isResponse(m)) {
      // Our ids are numbers; a server that echoes one as a numeric string still answers it (`answers`).
      const id = typeof m.id === "number" ? m.id : typeof m.id === "string" && /^\d{1,15}$/.test(m.id) ? +m.id : -1;
      const handler = this.pending.get(id);
      if (!handler) return; // a late answer to a request already given up
      if ("error" in m) handler(new McpError(m.error.code, m.error.message, m.error.data));
      else handler({ result: m.result });
      return;
    }
    if (isNotification(m)) {
      if (m.method === "notifications/cancelled" && this.answering.size > 0) {
        const target = m.params?.requestId;
        if (typeof target === "string" || typeof target === "number") this.answering.get(target)?.abort();
      }
      // A handler that throws, or returns a promise that rejects, must not fail the reply the notification rode on
      // nor end the process with an unhandled rejection.
      try {
        const done = this.onnotification?.(m);
        if (done && typeof (done as Promise<void>).then === "function")
          (done as Promise<void>).then(undefined, () => {});
      } catch {}
      return;
    }
    // Of the server's requests only `ping` is answered, and at most `MAX_PINGS_IN_FLIGHT` at once: each answer is a
    // POST carrying the user's credentials, so a server that floods requests must not turn them into a flood of POSTs
    // (200,000 asked made 200,000 POSTs). Every other request (sampling, roots, elicitation) is dropped unanswered,
    // never acted on.
    const ask = m as JsonRpcRequest;
    if (this.pings >= MAX_PINGS_IN_FLIGHT || !this.transport) return;
    if (ask.method === "ping") {
      this.pings++;
      this.transport
        .send({ jsonrpc: "2.0", id: ask.id, result: {} })
        .catch(() => {})
        .finally(() => this.pings--);
      return;
    }
    const handler = this.handlers.get(ask.method);
    // One answer per id at once: a server that repeats an id it has not had answered gets nothing for the repeat.
    if (!handler || this.answering.has(ask.id)) return;
    this.pings++;
    void this.answer(this.transport, ask, handler).finally(() => this.pings--);
  }

  /** Runs a handler and sends its answer, unless the request was cancelled or the connection changed meanwhile. */
  private async answer(transport: Transport, ask: JsonRpcRequest, handler: RequestHandler): Promise<void> {
    const abort = new AbortController();
    this.answering.set(ask.id, abort);
    let reply: JsonRpcMessage;
    try {
      const result = await handler(ask.params ?? {}, { signal: abort.signal, id: ask.id });
      reply = { jsonrpc: "2.0", id: ask.id, result: isObject(result) ? result : {} };
    } catch (e) {
      const error =
        e instanceof McpError
          ? {
              code: e.code,
              message: e.message.replace(/^MCP error -?\d+: /, ""),
              ...(e.data !== undefined ? { data: e.data } : {}),
            }
          : { code: ErrorCode.InternalError, message: "Internal error" };
      reply = { jsonrpc: "2.0", id: ask.id, error };
    } finally {
      if (this.answering.get(ask.id) === abort) this.answering.delete(ask.id);
    }
    if (abort.signal.aborted || this.transport !== transport) return;
    await transport.send(reply).catch(() => {});
  }

  private closed(transport: Transport): void {
    if (this.transport !== transport) return;
    this.transport = null;
    for (const a of this.answering.values()) a.abort();
    this.answering.clear();
    const handlers = [...this.pending.values()];
    this.pending.clear();
    this.onclose?.();
    const error = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    for (const h of handlers) h(error);
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

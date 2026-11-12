/**
 * A minimal MCP client (D1704): `initialize` with version negotiation, `tools/list`, `tools/call`, `ping` answered,
 * every other server request refused with "Method not found", server notifications ignored. It matches the
 * official SDK's `Client` where Eden depends on it: a JSON-RPC error rejects with `McpError` (`MCP error <code>:
 * <message>`), a request times out after 60 s by default, an aborted signal sends `notifications/cancelled` and
 * rejects, a closed connection rejects every request in flight and calls `onclose`.
 */
import {
  ErrorCode,
  isRequest,
  isResponse,
  LATEST_PROTOCOL_VERSION,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type Tool,
  type Transport,
} from "./types";

/** The SDK's default request timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface RequestOptions {
  signal?: AbortSignal;
  /** Default `DEFAULT_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

type Pending = (response: { result: Record<string, unknown> } | Error) => void;

export class McpClient {
  /** Called once when the connection closes, whichever side closed it. */
  onclose?: () => void;
  private transport: Transport | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly info: { name: string; version: string }) {}

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
        { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: this.info },
        options,
      );
      const version = result.protocolVersion;
      if (typeof version !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
        throw new Error(`Server's protocol version is not supported: ${String(version)}`);
      }
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

  private request(
    method: string,
    params: Record<string, unknown> | undefined,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const transport = this.transport;
      if (!transport) return reject(new Error("Not connected"));
      const { signal } = options;
      if (signal?.aborted) return reject(signal.reason);
      const id = this.nextId++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        this.pending.delete(id);
        clearTimeout(timer);
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
      timer = setTimeout(
        () => cancel(new McpError(ErrorCode.RequestTimeout, "Request timed out", { timeout: timeoutMs })),
        timeoutMs,
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
      const handler = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
      if (!handler) return; // a late answer to a request already given up
      if ("error" in m) handler(new McpError(m.error.code, m.error.message, m.error.data));
      else handler({ result: m.result });
      return;
    }
    if (!isRequest(m)) return; // notifications (progress, logging, list changes) are not used
    const reply: JsonRpcMessage =
      m.method === "ping"
        ? { jsonrpc: "2.0", id: m.id, result: {} }
        : { jsonrpc: "2.0", id: m.id, error: { code: ErrorCode.MethodNotFound, message: "Method not found" } };
    this.transport?.send(reply).catch(() => {});
  }

  private closed(transport: Transport): void {
    if (this.transport !== transport) return;
    this.transport = null;
    const handlers = [...this.pending.values()];
    this.pending.clear();
    this.onclose?.();
    const error = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    for (const h of handlers) h(error);
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

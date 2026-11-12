/**
 * The subset of MCP (JSON-RPC 2.0 framing, `initialize`, `ping`, `tools/list`, `tools/call`) that Eden speaks, as
 * plain types (D1704). Eden's client, its streamable HTTP transport and its `ask_context` server are written against
 * these, not against the official SDK, whose ~90 transitive packages Eden's code never reached.
 *
 * `Transport` is shaped so that the SDK's transports fit it as they are (its in-memory pair, its stdio client, its
 * streamable HTTP server transport): the tests and the lab use them as reference implementations.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: { [key: string]: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: { [key: string]: unknown };
}

export interface JsonRpcResultResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: { [key: string]: unknown };
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResultResponse | JsonRpcErrorResponse;

/** A message channel to one MCP peer. The SDK's `Transport` is assignable to it. */
export interface Transport {
  /** Opens the channel; called once, after the handlers are set. */
  start(): Promise<void>;
  /** Sends one message; rejects when it could not be delivered (an HTTP error, a closed pipe). */
  send(message: JsonRpcMessage): Promise<void>;
  /** Closes the channel; `onclose` follows. */
  close(): Promise<void>;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  /** Told the negotiated protocol version after `initialize` (HTTP sends it as a header on every later request). */
  setProtocolVersion?: (version: string) => void;
}

/** Versions sent first and accepted, newest first: the SDK's list. Eden's subset reads the same in every one. */
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

/** JSON-RPC and MCP error codes Eden produces or reads. */
export const ErrorCode = {
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** A JSON-RPC error, as the SDK's `McpError`: the message reads `MCP error <code>: <message>`. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`MCP error ${code}: ${message}`);
    this.name = "McpError";
  }
}

/** A tool as `tools/list` describes it: only the fields Eden reads are typed. */
export interface Tool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: { [key: string]: unknown }; required?: string[]; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

/** A `tools/call` result. `content` is `[]` when the server sent none, as in the SDK. */
export interface CallToolResult {
  content: { type: string; text?: string; [key: string]: unknown }[];
  structuredContent?: { [key: string]: unknown };
  isError?: boolean;
  [key: string]: unknown;
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isId = (x: unknown): x is JsonRpcId => typeof x === "string" || (typeof x === "number" && Number.isInteger(x));

/**
 * The value as a JSON-RPC 2.0 message, or null when it is not one: a request, a notification, a result or an error.
 * Parsed JSON from a peer goes through this before anything reads it.
 */
export function asMessage(x: unknown): JsonRpcMessage | null {
  if (!isRecord(x) || x.jsonrpc !== "2.0") return null;
  if (x.params !== undefined && !isRecord(x.params)) return null;
  if (typeof x.method === "string") {
    if (x.id === undefined) return x as unknown as JsonRpcNotification;
    return isId(x.id) ? (x as unknown as JsonRpcRequest) : null;
  }
  if ("result" in x) return isId(x.id) && isRecord(x.result) ? (x as unknown as JsonRpcResultResponse) : null;
  if (isRecord(x.error) && typeof x.error.code === "number" && typeof x.error.message === "string") {
    return x.id === undefined || x.id === null || isId(x.id) ? (x as unknown as JsonRpcErrorResponse) : null;
  }
  return null;
}

/**
 * Whether a response's id answers request `sent`: equal, or the same number echoed as a string ("1" for 1), which the
 * SDK's client accepts too (it matches on `Number(id)`) and some servers send.
 */
export function answers(id: JsonRpcId | undefined, sent: JsonRpcId): boolean {
  return id === sent || (typeof sent === "number" && typeof id === "string" && id === String(sent));
}

export const isRequest = (m: JsonRpcMessage): m is JsonRpcRequest => "method" in m && "id" in m;
export const isNotification = (m: JsonRpcMessage): m is JsonRpcNotification => "method" in m && !("id" in m);
export const isResponse = (m: JsonRpcMessage): m is JsonRpcResultResponse | JsonRpcErrorResponse => !("method" in m);

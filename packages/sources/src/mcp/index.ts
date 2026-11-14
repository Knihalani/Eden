/**
 * The client's core: what a program that calls tools over streamable HTTP loads (Eden's path). The opt-in pieces are
 * separate entry points, never imported from here, so they are loaded (and bundled) only when used: `./stdio`
 * (`StdioClientTransport`), `./extras` (resources and prompts) and `./oauth` (the authorization flow, D1874).
 */
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  McpClient,
  type ClientOptions,
  type RequestHandler,
  type RequestOptions,
  type ServerInitialize,
} from "./client";
export { parseJsonBytes, parseJsonText } from "./json";
export { bodyShapeUnder, textShapeUnder } from "./shape";
export { SseParser, type SseStep } from "./sse";
export {
  DEFAULT_LIMITS,
  DEFAULT_RESUME,
  MAX_EVENT_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_TOOLS_LIST_BYTES,
  StreamableHttpError,
  StreamableHttpTransport,
  type AuthHook,
  type ReplyLimits,
  type ResumeOptions,
  type StreamableHttpOptions,
} from "./http";
export {
  answers,
  asMessage,
  ErrorCode,
  isNotification,
  isRequest,
  isResponse,
  LATEST_PROTOCOL_VERSION,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResultResponse,
  type Tool,
  type Transport,
} from "./types";

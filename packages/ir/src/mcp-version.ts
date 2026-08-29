/**
 * MCP initialize version negotiation (spec 2025-03-26 lifecycle).
 *
 * Client proposes `params.protocolVersion`. If we speak it, echo it; otherwise
 * state the server's latest. Missing / non-string / garbage / hostile values
 * never throw and never become an HTTP 500 — they degrade to the latest.
 */

export const MCP_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
/** Latest version this server speaks. 2024-11-05 remains compatible for tools/list + tools/call. */
export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = "2025-03-26";

export type McpNegotiateResult = {
  protocolVersion: McpProtocolVersion;
  echoed: boolean;
};

function isSupportedMcpVersion(v: unknown): v is McpProtocolVersion {
  return v === "2024-11-05" || v === "2025-03-26";
}

/**
 * Read `params.protocolVersion` without throwing on hostile objects.
 * Non-objects and throwing getters yield `undefined` (legacy / garbage).
 */
export function readMcpProtocolVersion(params: unknown): unknown {
  try {
    if (params !== null && typeof params === "object") {
      return (params as { protocolVersion?: unknown }).protocolVersion;
    }
  } catch {
    /* Proxy / throwing getter */
  }
  return undefined;
}

/**
 * Negotiate the MCP protocol version the initialize result should name.
 *
 * Supported → echo. Anything else → server latest. Never throws.
 */
export function negotiateMcpProtocolVersion(requested: unknown): McpNegotiateResult {
  try {
    if (isSupportedMcpVersion(requested)) {
      return { protocolVersion: requested, echoed: true };
    }
  } catch {
    /* hostile equality / boxed primitive */
  }
  return { protocolVersion: MCP_LATEST_PROTOCOL_VERSION, echoed: false };
}

/**
 * Structured JSON-RPC error payload for an unsupported proposal.
 * Callers may return this *instead of* a result — never as an HTTP 500, never thrown.
 * Huge / hostile `requested` values are truncated so the response stays bounded.
 */
export function mcpUnsupportedVersionError(requested: unknown): {
  code: number;
  message: string;
  data: { supported: readonly string[]; requested: unknown };
} {
  let shown: unknown = "<unprintable>";
  try {
    if (typeof requested === "string") {
      shown = requested.length > 128 ? `${requested.slice(0, 32)}…(${requested.length} chars)` : requested;
    } else if (requested === null || typeof requested === "number" || typeof requested === "boolean") {
      shown = requested;
    } else if (typeof requested === "object") {
      shown = { type: Array.isArray(requested) ? "array" : "object" };
    } else {
      shown = typeof requested;
    }
  } catch {
    shown = "<unprintable>";
  }
  return {
    code: -32602,
    message: "Unsupported protocol version",
    data: { supported: MCP_PROTOCOL_VERSIONS, requested: shown },
  };
}

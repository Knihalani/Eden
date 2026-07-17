/**
 * Self-report stumbles from user code (F28) — TS parity with Python.
 */

import { getDefaultClient } from "./client.js";
import { SDK_USER_AGENT } from "./version.js";

const VALID_KINDS = new Set([
  "tool_error",
  "loop",
  "hallucination",
  "task_failure",
  "user_frustration",
  "timeout",
  "self_diagnostic",
  "mcp_auth_failure",
  "statgate_p0",
  "custom",
]);

export interface RecordStumbleOptions {
  kind?: string;
  traceId?: string;
  detail?: Record<string, unknown>;
  severity?: string;
  agentId?: string;
  spanId?: string;
  sessionId?: string;
  userId?: string;
}

export async function recordStumble(
  title: string,
  opts: RecordStumbleOptions = {},
): Promise<Record<string, unknown> | null> {
  const client = getDefaultClient();
  const cfg = client.getConfig();
  if (cfg.disabled) return null;
  if (!cfg.orgId) {
    console.warn("[eden-ai] recordStumble: orgId not configured; dropping");
    return null;
  }
  const kind =
    opts.kind && VALID_KINDS.has(opts.kind) ? opts.kind : "self_diagnostic";
  const traceId = opts.traceId;
  if (!traceId) {
    console.warn(
      "[eden-ai] recordStumble: no traceId; pass traceId or call inside trace()",
    );
    return null;
  }
  const payload: Record<string, unknown> = {
    trace_id: traceId,
    kind,
    title,
    detail: opts.detail ?? {},
  };
  if (opts.severity) payload.severity = opts.severity;
  if (opts.agentId) payload.agent_id = opts.agentId;
  if (opts.spanId) payload.span_id = opts.spanId;
  if (opts.sessionId) payload.session_id = opts.sessionId;
  if (opts.userId) payload.user_id = opts.userId;

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/orgs/${cfg.orgId}/stumbles`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": SDK_USER_AGENT,
  };
  if (cfg.orgId) headers["X-Org-Id"] = cfg.orgId;
  if (cfg.apiKey) headers["X-Org-Api-Key"] = cfg.apiKey;
  if (cfg.projectId) headers["X-Project-Id"] = cfg.projectId;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      try {
        return (await resp.json()) as Record<string, unknown>;
      } catch {
        return { status: "ok" };
      }
    }
    console.warn(`[eden-ai] recordStumble returned ${resp.status}`);
  } catch (err) {
    console.warn(
      `[eden-ai] recordStumble failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

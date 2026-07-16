/**
 * Agent session SDK (F23) — multi-turn session unit.
 */

import { randomUUID } from "node:crypto";
import { getDefaultClient } from "./client.js";
import { trace, type TraceContext } from "./trace.js";

export interface AgentSessionOptions {
  userId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

export class AgentSession {
  readonly sessionId: string;
  readonly orgId: string;
  agentId?: string;
  userId?: string;
  metadata: Record<string, unknown>;
  traceIds: string[] = [];
  private ended = false;

  constructor(opts: AgentSessionOptions & { orgId: string }) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.orgId = opts.orgId;
    this.agentId = opts.agentId;
    this.userId = opts.userId;
    this.metadata = { ...(opts.metadata ?? {}) };
  }

  trace(name: string, fn: (ctx: TraceContext) => Promise<unknown> | unknown): Promise<unknown> {
    return trace(name, async (ctx) => {
      ctx.setTag(`agent_session_id:${this.sessionId}`);
      if (this.agentId) ctx.setTag(`agent_id:${this.agentId}`);
      if (this.userId) ctx.setTag(`user_id:${this.userId}`);
      this.traceIds.push(ctx.traceId);
      return fn(ctx);
    });
  }

  async completeSession(success = true, failureReason?: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await notifySession(this.orgId, "end", {
      sessionId: this.sessionId,
      success,
      failureReason,
      traceIds: this.traceIds,
      metadata: this.metadata,
    });
  }
}

let _current: AgentSession | null = null;

export function currentSession(): AgentSession | null {
  return _current;
}

export async function begin(opts: AgentSessionOptions = {}): Promise<AgentSession> {
  const client = getDefaultClient();
  const cfg = client.getConfig();
  const orgId = cfg.orgId ?? "default";
  const session = new AgentSession({ ...opts, orgId });
  _current = session;
  await notifySession(orgId, "start", {
    sessionId: session.sessionId,
    agentId: session.agentId,
    userId: session.userId,
    metadata: session.metadata,
  });
  return session;
}

export async function completeSession(
  session: AgentSession,
  success = true,
  failureReason?: string,
): Promise<void> {
  await session.completeSession(success, failureReason);
  if (_current === session) _current = null;
}

async function notifySession(
  orgId: string,
  phase: "start" | "end",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const client = getDefaultClient();
    const cfg = client.getConfig();
    const base = (cfg.baseUrl ?? "https://api.edenobservability.com").replace(/\/$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const sid = String(payload.sessionId ?? "");
    const url =
      phase === "start"
        ? `${base}/orgs/${orgId}/agent-sessions/start`
        : `${base}/orgs/${orgId}/agent-sessions/${sid}/end`;
    const body =
      phase === "start"
        ? {
            agent_id: payload.agentId,
            user_id: payload.userId,
            metadata: payload.metadata,
            session_id: sid,
          }
        : {
            success: payload.success ?? true,
            failure_reason: payload.failureReason,
          };
    await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    // fire-and-forget
  }
}

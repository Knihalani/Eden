/**
 * Agent session SDK (F23) — multi-turn session unit.
 * Lifecycle posts to ingest-side `/ingest/agent-sessions` with X-Org-Api-Key.
 */

import { randomUUID } from "node:crypto";
import { getDefaultClient, compressJsonBody } from "./client.js";
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
  costUsd = 0;
  private ended = false;

  constructor(opts: AgentSessionOptions & { orgId: string }) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.orgId = opts.orgId;
    this.agentId = opts.agentId;
    this.userId = opts.userId;
    this.metadata = { ...(opts.metadata ?? {}) };
  }

  async identify(userId: string): Promise<void> {
    this.userId = userId;
    await notifySession(this.orgId, "identify", {
      sessionId: this.sessionId,
      userId,
    });
  }

  addCost(amountUsd: number): void {
    if (amountUsd > 0) this.costUsd += amountUsd;
  }

  trace(name: string, fn: (ctx: TraceContext) => Promise<unknown> | unknown): Promise<unknown> {
    return trace(name, async (ctx) => {
      ctx.setTag(`agent_session_id:${this.sessionId}`);
      if (this.agentId) ctx.setTag(`agent_id:${this.agentId}`);
      if (this.userId) ctx.setTag(`user_id:${this.userId}`);
      this.traceIds.push(ctx.traceId);
      void notifySession(this.orgId, "attach_trace", {
        sessionId: this.sessionId,
        traceId: ctx.traceId,
      });
      return fn(ctx);
    });
  }

  async complete(opts: {
    success?: boolean;
    failureReason?: string;
    flush?: boolean;
    outcome?: "helped" | "not_helped" | "unknown";
    source?: "person" | "product" | "agent";
    reason?: string;
    explicit?: boolean;
    slack?: { channel?: string; ts?: string };
  } = {}): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const success = opts.success ?? true;
    const payload: Record<string, unknown> = {
      sessionId: this.sessionId,
      success,
      failureReason: opts.failureReason,
      traceIds: this.traceIds,
      metadata: this.metadata,
      costUsd: this.costUsd,
    };
    if (opts.outcome && (opts.source === "person" || opts.source === "product")) {
      payload.outcome = opts.outcome;
      payload.source = opts.source;
      if (opts.reason !== undefined) payload.reason = opts.reason;
      if (opts.explicit !== undefined) payload.explicit = opts.explicit;
    }
    if (opts.slack?.channel && opts.slack.ts) {
      payload.slack = { channel: opts.slack.channel, ts: opts.slack.ts };
    }
    await notifySession(this.orgId, "end", payload);
    if (opts.flush ?? true) {
      try {
        await getDefaultClient().flush();
      } catch {
        // best-effort
      }
    }
    if (_current === this) _current = null;
  }

  async completeSession(
    success = true,
    failureReason?: string,
    flush = true,
  ): Promise<void> {
    await this.complete({ success, failureReason, flush });
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

export async function identify(
  userId: string,
  session?: AgentSession,
): Promise<void> {
  const target = session ?? _current;
  if (!target) return;
  await target.identify(userId);
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
  phase: "start" | "end" | "identify" | "attach_trace",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const client = getDefaultClient();
    const cfg = client.getConfig();
    const base = (cfg.baseUrl ?? "https://api.edenobservability.com").replace(/\/$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.orgId) headers["X-Org-Id"] = cfg.orgId;
    if (cfg.apiKey) headers["X-Org-Api-Key"] = cfg.apiKey;
    if (cfg.projectId) headers["X-Project-Id"] = cfg.projectId;
    const sid = String(payload.sessionId ?? "");
    const root = `${base}/orgs/${orgId}/ingest/agent-sessions`;
    let url: string;
    let body: Record<string, unknown>;
    if (phase === "start") {
      url = `${root}/start`;
      body = {
        agent_id: payload.agentId,
        user_id: payload.userId,
        metadata: payload.metadata,
        session_id: sid,
      };
    } else if (phase === "identify") {
      url = `${root}/${sid}/identify`;
      body = { user_id: payload.userId };
    } else if (phase === "attach_trace") {
      url = `${root}/${sid}/traces`;
      body = { trace_id: payload.traceId };
    } else {
      url = `${root}/${sid}/end`;
      body = {
        success: payload.success ?? true,
        failure_reason: payload.failureReason,
        cost_usd: payload.costUsd,
        trace_ids: payload.traceIds,
      };
      if (payload.outcome) {
        body.outcome = payload.outcome;
        body.source = payload.source;
        if (payload.reason !== undefined) body.reason = payload.reason;
        if (payload.explicit !== undefined) body.explicit = payload.explicit;
      }
      if (payload.slack) body.slack = payload.slack;
    }
    // Compress like the main ingest path (``client.ts``'s
    // ``compressJsonBody``, N2 zstd-when-available / gzip fallback) — the
    // request-side counterpart is the ASGI ``GunzipRequestMiddleware``
    // (server ``eden.api.middleware.gzip_request``), scoped to exactly
    // ``/ingest/agent-sessions`` and ``/stream/traces``. Node's global
    // ``fetch`` (undici) already keeps the underlying connection pooled
    // across calls, so no separate agent/pool management is needed here.
    const { body: compressed, encoding } = await compressJsonBody(body);
    headers["Content-Encoding"] = encoding;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: compressed as BodyInit,
    });
    if (!resp.ok) {
      // surface non-2xx without throwing into user code
      void resp.text().catch(() => undefined);
    }
  } catch {
    // fire-and-forget — never break the caller
  }
}

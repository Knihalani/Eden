/**
 * Eden TypeScript SDK — App/site-layer client.
 *
 * Phase A1 of the Eden app/storage plan (2026-06-19). Mirrors the
 * server-side `EdenApp` API from the Python ``eden_sdk.app``. Lets
 * server-side code (Node.js, Next.js route handlers, Edge functions)
 * emit app-layer signals that correlate to agent traces.
 *
 * Companion: ``browser.ts`` for the client-side SDK (vanilla JS,
 * React, Next.js client components).
 *
 * Usage:
 * ```ts
 * import { EdenApp } from "@eden/sdk/app";
 *
 * const eden = new EdenApp({ apiKey: "sk_...", orgId: "org_..." });
 *
 * await eden.track("button_click", { buttonId: "save" });
 * await eden.feedback({ value: "up", traceId: "..." });
 * const token = await eden.issueFeedbackToken({ traceId: "..." });
 * ```
 */

const DEFAULT_ENDPOINT = "https://api.eden.io";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type FeedbackValue =
  | "up"
  | "down"
  | "thumbs_up"
  | "thumbs_down"
  | "positive"
  | "negative"
  | "+1"
  | "-1"
  | 1
  | 0
  | 2
  | 3
  | 4
  | 5;

export interface EdenAppConfig {
  apiKey: string;
  orgId: string;
  endpoint?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface TrackOptions {
  traceId?: string;
  sessionId?: string;
  userId?: string;
  ts?: Date;
}

export interface FeedbackInput {
  value: FeedbackValue;
  traceId: string;
  comment?: string;
  userId?: string;
  sessionId?: string;
}

export interface FeedbackResult {
  feedbackId: string;
  satisfactionCorrected: number;
}

export interface PresignedTokenInput {
  traceId: string;
  feedbackKey?: string;
  expiresInSeconds?: number;
}

export interface PresignedTokenResult {
  tokenId: string;
  url: string;
  expiresAt: string;
}

export interface SessionStartInput {
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionStartResult {
  sessionId: string;
  sessionSecret: string;
  expiresAt: string;
}

export interface SessionSummary {
  sessionId: string;
  userId: string | null;
  nEvents: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
}

export class EdenApp {
  private readonly endpoint: string;
  private readonly orgId: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: EdenAppConfig) {
    if (!config.apiKey) throw new Error("EdenApp: apiKey required");
    if (!config.orgId) throw new Error("EdenApp: orgId required");
    this.apiKey = config.apiKey;
    this.orgId = config.orgId;
    this.endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  // ── track ────────────────────────────────────────────────────────────

  /** Track any event from app code. */
  async track(
    name: string,
    properties: Record<string, unknown> = {},
    opts: TrackOptions = {},
  ): Promise<void> {
    await this._post(`/orgs/${this.orgId}/ingest/app`, {
      events: [
        {
          name,
          properties,
          trace_id: opts.traceId,
          session_id: opts.sessionId,
          user_id: opts.userId,
          ts: (opts.ts ?? new Date()).toISOString(),
        },
      ],
    });
  }

  // ── feedback ─────────────────────────────────────────────────────────

  /** Submit thumbs/rating/comment feedback tied to a trace. */
  async feedback(input: FeedbackInput): Promise<FeedbackResult> {
    const body = {
      trace_id: input.traceId,
      thumbs: String(input.value),
      comment: input.comment,
      user_id: input.userId,
      session_id: input.sessionId,
    };
    const res = await this._post(
      `/orgs/${this.orgId}/intelligence/user/feedback`,
      body,
    );
    return {
      feedbackId: String((res as Record<string, unknown>).feedback_id ?? ""),
      satisfactionCorrected: Number(
        (res as Record<string, unknown>).satisfaction_corrected ?? 0,
      ),
    };
  }

  // ── identify ────────────────────────────────────────────────────────

  /** Identify a user. Anonymous if userId is null. */
  async identify(
    userId: string,
    traits: Record<string, unknown> = {},
  ): Promise<void> {
    if (!userId) throw new Error("EdenApp.identify: userId required");
    await this._post(`/orgs/${this.orgId}/intelligence/user/identify`, {
      user_id: userId,
      traits,
    });
  }

  // ── presigned feedback tokens ────────────────────────────────────────

  /**
   * Issue a presigned feedback URL — LangSmith-style unauthenticated
   * feedback submission. The returned URL can be sent to a client
   * (browser, mobile) which can POST to it directly without an API key.
   *
   * Default 3h TTL, scoped to (traceId, feedbackKey, expiresAt).
   */
  async issueFeedbackToken(
    input: PresignedTokenInput,
  ): Promise<PresignedTokenResult> {
    const body = {
      trace_id: input.traceId,
      feedback_key: input.feedbackKey ?? "user_score",
      expires_in_seconds: input.expiresInSeconds ?? 3 * 60 * 60,
    };
    const res = (await this._post(
      `/orgs/${this.orgId}/intelligence/user/feedback/presigned-token`,
      body,
    )) as Record<string, unknown>;
    return {
      tokenId: String(res.token_id ?? ""),
      url: String(res.url ?? ""),
      expiresAt: String(res.expires_at ?? ""),
    };
  }

  // ── session lifecycle ────────────────────────────────────────────────

  readonly session = {
    /** Start a new session. Returns sessionId + a sessionSecret HMAC. */
    start: async (input: SessionStartInput = {}): Promise<SessionStartResult> => {
      const body = {
        user_id: input.userId,
        metadata: input.metadata ?? {},
      };
      const res = (await this._post(
        `/orgs/${this.orgId}/intelligence/user/sessions/start`,
        body,
      )) as Record<string, unknown>;
      return {
        sessionId: String(res.session_id ?? ""),
        sessionSecret: String(res.session_secret ?? ""),
        expiresAt: String(res.expires_at ?? ""),
      };
    },

    /** End a session (closes the user_sessions row, fires any pending signals). */
    end: async (sessionId: string): Promise<void> => {
      await this._post(
        `/orgs/${this.orgId}/intelligence/user/sessions/${encodeURIComponent(sessionId)}/end`,
        {},
      );
    },

    /** Attach a user_id to an anonymous session. */
    identify: async (sessionId: string, userId: string): Promise<void> => {
      if (!userId) throw new Error("EdenApp.session.identify: userId required");
      await this._post(
        `/orgs/${this.orgId}/intelligence/user/sessions/${encodeURIComponent(sessionId)}/identify`,
        { user_id: userId },
      );
    },

    /** Read a session summary. */
    get: async (sessionId: string): Promise<SessionSummary> => {
      const res = (await this._get(
        `/orgs/${this.orgId}/intelligence/user/sessions/${encodeURIComponent(sessionId)}`,
      )) as Record<string, unknown>;
      return {
        sessionId: String(res.session_id ?? sessionId),
        userId: (res.user_id as string | null) ?? null,
        nEvents: Number(res.n_events ?? 0),
        firstEventAt: (res.first_event_at as string | null) ?? null,
        lastEventAt: (res.last_event_at as string | null) ?? null,
      };
    },
  };

  // ── HTTP helpers ─────────────────────────────────────────────────────

  private async _post(path: string, body: unknown): Promise<unknown> {
    return this._request(path, { method: "POST", body });
  }

  private async _get(path: string): Promise<unknown> {
    return this._request(path, { method: "GET" });
  }

  private async _request(
    path: string,
    opts: { method: "GET" | "POST"; body?: unknown },
  ): Promise<unknown> {
    const url = `${this.endpoint}${path}`;
    let attempt = 0;
    let lastError: Error | undefined;
    while (attempt <= this.maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const fetchOpts: RequestInit = {
          method: opts.method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Org-Api-Key": this.apiKey,
            "X-Org-Id": this.orgId,
          },
          signal: controller.signal,
        };
        if (opts.body !== undefined) {
          fetchOpts.body = JSON.stringify(opts.body);
        }
        const response = await fetch(url, fetchOpts);
        clearTimeout(timeoutId);
        if (RETRYABLE_HTTP_STATUS.has(response.status) && attempt < this.maxRetries) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
          continue;
        }
        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `EdenApp: ${opts.method} ${path} → ${response.status}: ${text}`,
          );
        }
        // 204 No Content
        if (response.status === 204) return null;
        return await response.json();
      } catch (err) {
        lastError = err as Error;
        attempt += 1;
        if (attempt > this.maxRetries) break;
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error(`EdenApp: ${opts.method} ${path} failed`);
  }
}

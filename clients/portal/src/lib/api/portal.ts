/**
 * Thin typed client for ``GET /orgs/{orgId}/portal/*`` read models.
 * Mutations stay on domain routes via ``api`` / ``promptsApi`` helpers.
 */
import { ApiError, fetchApi } from "@/lib/api/core";
import {
  issueFixtureListSchema,
  portalSchema,
  sessionFixtureListSchema,
  traceFixtureListSchema,
} from "@/lib/api/schemas";
import type {
  AgentFixture,
} from "@/lab/fixtures/agents";
import type { TraceFixture } from "@/lab/fixtures/traces";
import type { SessionFixture } from "@/lab/fixtures/sessions";
import type { IssueFixture } from "@/lab/fixtures/issues";
import type { SignalFixture } from "@/lab/fixtures/signals";
import type { AlertEvent, AlertRule } from "@/lab/fixtures/alerts";
import type { CostDriverFixture } from "@/lab/fixtures/cost";
import type {
  ApiKeyFixture,
  AuditEventFixture,
  AuditPackFixture,
  MemberFixture,
  WorkspaceFixture,
} from "@/lab/fixtures/settings";
import type {
  DatasetFixture,
  ExperimentFixture,
  PlaygroundFixture,
} from "@/lab/fixtures/evals";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import type { AbExperimentFixture } from "@/lab/fixtures/compare";
import type {
  GuardrailKind,
  GuardrailPolicyFixture,
} from "@/lab/fixtures/guardrails";
import type { DebuggerSessionFixture } from "@/lab/fixtures/debugger";
import type { AgentThread } from "@/lab/fixtures/agent-chat";

/** Soft-auth Inbox poll: tolerate short JWT races, then escalate. */
const ALERT_AUTH_FAIL_THRESHOLD = 3;
const alertAuthFailStreakByOrg = new Map<string, number>();

/** Test helper — reset consecutive soft-auth failure counters. */
export function __resetAlertAuthFailStreakForTests(): void {
  alertAuthFailStreakByOrg.clear();
}

function portalPath(orgId: string, suffix: string): string {
  return `/orgs/${orgId}/portal/${suffix.replace(/^\//, "")}`;
}

/**
 * Portal read-model card from `GET /orgs/{org}/portal/guardrails/policies`
 * (`GuardrailPolicyCard` in `eden/api/portal_contracts.py`). The route
 * returns a bare array (not the intelligence `GuardrailPolicy.list`
 * ok-envelope). `matchCount24h` is derived from `intervention_log` rows
 * attributed to each policy — the same table `InterventionEngine.evaluate_and_act`
 * writes to (FEAT-38); the removed trajectory bypass never logged here.
 */
type GuardrailPolicyCardRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  agentId?: string | null;
  severity?: string;
  matchCount24h?: number;
  action: string;
};

export const portalApi = {
  agents: (orgId: string) =>
    fetchApi<AgentFixture[]>(portalPath(orgId, "agents")),

  renameAgent: (orgId: string, agentId: string, name: string) =>
    fetchApi<{
      agent_id: string;
      name: string;
      framework?: string | null;
      repo_url?: string | null;
      last_seen_at: string;
      created_at: string;
      updated_at: string;
    }>(`/orgs/${orgId}/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Org-Id": orgId,
      },
      body: JSON.stringify({ name }),
    }),

  /**
   * OPT-14: ``agentId`` scopes the query server-side instead of
   * fetching the org-wide most-recent list and filtering client-side
   * (which silently empties for an agent whose activity is older than
   * the org's most-recent traces).
   *
   * FEAT-147: ``participantAgentId`` includes traces where that agent
   * appeared on any span, even when it is not the preferred display id.
   */
  traces: (
    orgId: string,
    filters?: { agentId?: string; participantAgentId?: string },
  ) => {
    const params = new URLSearchParams();
    if (filters?.agentId) {
      params.set("agent_id", filters.agentId);
    }
    if (filters?.participantAgentId) {
      params.set("participant_agent_id", filters.participantAgentId);
    }
    const qs = params.toString();
    return fetchApi<TraceFixture[]>(
      portalPath(orgId, "traces") + (qs ? `?${qs}` : ""),
      { schema: portalSchema<TraceFixture[]>(traceFixtureListSchema) },
    );
  },

  /**
   * Single-trace detail — same shape as ``traces()`` rows but with
   * ``steps`` populated. The list endpoint always returns
   * ``steps: []`` to avoid an N+1 of per-trace span hydration; call
   * this once a trace is selected to load its real transcript.
   */
  traceDetail: (orgId: string, traceId: string, signal?: AbortSignal) =>
    fetchApi<TraceFixture>(
      portalPath(orgId, `traces/${encodeURIComponent(traceId)}`),
      signal ? { signal } : undefined,
    ),

  sessions: (orgId: string) =>
    fetchApi<SessionFixture[]>(portalPath(orgId, "sessions"), {
      schema: portalSchema<SessionFixture[]>(sessionFixtureListSchema),
    }),

  issues: (
    orgId: string,
    filters?: { limit?: number; offset?: number; sort?: "recency" | "rank" },
  ) => {
    const q = new URLSearchParams();
    if (typeof filters?.limit === "number") q.set("limit", String(filters.limit));
    if (typeof filters?.offset === "number") q.set("offset", String(filters.offset));
    if (filters?.sort) q.set("sort", filters.sort);
    const qs = q.toString();
    return fetchApi<IssueFixture[]>(
      portalPath(orgId, "issues") + (qs ? `?${qs}` : ""),
      { schema: portalSchema<IssueFixture[]>(issueFixtureListSchema) },
    );
  },

  signals: (orgId: string) =>
    fetchApi<SignalFixture[]>(portalPath(orgId, "signals")),

  alertRules: (orgId: string) =>
    fetchApi<AlertRule[]>(portalPath(orgId, "alerts/rules")),

  alertEvents: async (orgId: string) => {
    try {
      const events = await fetchApi<AlertEvent[]>(
        portalPath(orgId, "alerts/events"),
        { softAuth: true },
      );
      alertAuthFailStreakByOrg.set(orgId, 0);
      return events;
    } catch (e) {
      // Background Inbox poll — JWT race / membership blip must not
      // empty the shell or trip session chrome; tolerate a few auth
      // failures, then surface session-expired instead of an empty
      // inbox forever.
      if (
        e instanceof ApiError &&
        (e.status === 401 || e.status === 403)
      ) {
        const streak = (alertAuthFailStreakByOrg.get(orgId) ?? 0) + 1;
        alertAuthFailStreakByOrg.set(orgId, streak);
        if (
          streak >= ALERT_AUTH_FAIL_THRESHOLD &&
          typeof window !== "undefined"
        ) {
          try {
            window.sessionStorage.setItem("eden:auth:error", "session");
            window.dispatchEvent(
              new CustomEvent("eden:auth:session-expired", {
                detail: {
                  message:
                    e.message?.trim() ||
                    "Session expired. Sign in again to continue.",
                },
              }),
            );
          } catch {
            /* ignore storage / event failures */
          }
          throw e;
        }
        return [];
      }
      if (e instanceof ApiError && e.status === 404) {
        return [];
      }
      throw e;
    }
  },

  costDrivers: (orgId: string) =>
    fetchApi<CostDriverFixture[]>(portalPath(orgId, "cost/drivers")),

  workspace: (orgId: string) =>
    fetchApi<WorkspaceFixture>(portalPath(orgId, "workspace")),

  keys: (orgId: string) =>
    fetchApi<ApiKeyFixture[]>(portalPath(orgId, "keys")),

  members: (orgId: string) =>
    fetchApi<MemberFixture[]>(portalPath(orgId, "members")),

  auditEvents: (orgId: string) =>
    fetchApi<AuditEventFixture[]>(portalPath(orgId, "audit/events")),

  auditPacks: (orgId: string) =>
    fetchApi<AuditPackFixture[]>(portalPath(orgId, "audit/packs")),

  /** `POST /orgs/{org}/compliance/verify` — hash-chain tamper check (FEAT-110). */
  verifyAuditChain: (
    orgId: string,
    opts?: { agentId?: string; limit?: number },
  ) => {
    const q = new URLSearchParams();
    if (opts?.agentId) q.set("agent_id", opts.agentId);
    if (opts?.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return fetchApi<{
      status: string;
      feature?: string;
      live?: boolean;
      data: {
        verified?: boolean;
        total_rows?: number;
        ok_rows?: number;
        broken_rows?: number;
      };
    }>(`/orgs/${orgId}/compliance/verify${qs ? `?${qs}` : ""}`, {
      method: "POST",
    });
  },

  evalDatasets: (orgId: string) =>
    fetchApi<DatasetFixture[]>(portalPath(orgId, "evals/datasets")),

  evalPlaygrounds: (orgId: string) =>
    fetchApi<PlaygroundFixture[]>(portalPath(orgId, "evals/playgrounds")),

  evalExperiments: (orgId: string) =>
    fetchApi<ExperimentFixture[]>(portalPath(orgId, "evals/experiments")),

  improvePlans: (
    orgId: string,
    params?: { limit?: number; offset?: number },
  ) => {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set("limit", String(params.limit));
    if (params?.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return fetchApi<ImprovePlanFixture[]>(
      portalPath(orgId, `improve/plans${qs ? `?${qs}` : ""}`),
    );
  },

  compareExperiments: (orgId: string) =>
    fetchApi<AbExperimentFixture[]>(portalPath(orgId, "compare/experiments")),

  seedCompareExperiment: (
    orgId: string,
    body: {
      from: "evals" | "debugger";
      baselineId?: string;
      compareId?: string;
      debuggerSession?: string;
      agentId?: string;
      name?: string;
    },
  ) =>
    fetchApi<AbExperimentFixture>(portalPath(orgId, "compare/experiments/seed"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Org-Id": orgId,
      },
      body: JSON.stringify(body),
    }),

  /**
   * Portal guardrail policy cards (`list_portal_guardrail_policies` in
   * `eden/api/routes/portal.py`). Maps onto `GuardrailPolicyFixture`.
   * `matchCount24h` comes from `intervention_log` (InterventionEngine
   * path only — see FEAT-38 audit). `lastHit`, `ruleSummary`, and
   * issue/trace links are still not computed server-side.
   */
  guardrailPolicies: (orgId: string) =>
    fetchApi<GuardrailPolicyCardRow[]>(
      portalPath(orgId, "guardrails/policies"),
    ).then((rows) =>
      (Array.isArray(rows) ? rows : []).map(
        (row): GuardrailPolicyFixture => ({
          id: row.id,
          name: row.name,
          kind: row.kind as GuardrailKind,
          status: row.status as GuardrailPolicyFixture["status"],
          action: row.action as GuardrailPolicyFixture["action"],
          agentId: row.agentId ?? undefined,
          severity: row.severity as GuardrailPolicyFixture["severity"],
          matchCount24h: row.matchCount24h,
        }),
      ),
    ),

  debuggerSessions: (orgId: string) =>
    fetchApi<DebuggerSessionFixture[]>(portalPath(orgId, "debugger/sessions")),

  assistantThreads: (orgId: string) =>
    fetchApi<AgentThread[]>(portalPath(orgId, "assistant/threads")),

  /**
   * Wave 9 — align and diff any two traces for an org. Raw observability
   * route (NOT under ``/portal``): ``POST /orgs/{org}/observability/traces/diff``.
   * Returns per-step kinds (same/changed/added/removed) + aggregate deltas.
   */
  traceDiff: (orgId: string, traceA: string, traceB: string) =>
    fetchApi<TraceDiffResult>(`/orgs/${orgId}/observability/traces/diff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Org-Id": orgId,
      },
      body: JSON.stringify({ trace_a: traceA, trace_b: traceB }),
    }),

  /**
   * W4-6 trace bookmarks — star a trace for the authenticated user.
   * Idempotent: re-starring is a no-op.
   */
  bookmarkTrace: (orgId: string, traceId: string) =>
    fetchApi<{ bookmarked: boolean; trace_id: string }>(
      `/orgs/${orgId}/observability/traces/${encodeURIComponent(traceId)}/bookmark`,
      { method: "PUT", headers: { "X-Org-Id": orgId } },
    ),

  /**
   * W4-6 trace bookmarks — remove a star from a trace.
   * Idempotent: un-starring a non-bookmarked trace is a no-op.
   */
  unbookmarkTrace: (orgId: string, traceId: string) =>
    fetchApi<{ bookmarked: boolean; trace_id: string }>(
      `/orgs/${orgId}/observability/traces/${encodeURIComponent(traceId)}/bookmark`,
      { method: "DELETE", headers: { "X-Org-Id": orgId } },
    ),
};

/** One aligned row in a trace diff (Wave 9). */
export type TraceDiffStep = {
  index: number;
  kind: "same" | "changed" | "only_a" | "only_b";
  span_id: string;
  name_a: string | null;
  name_b: string | null;
  event_type_a: string | null;
  event_type_b: string | null;
  outcome_a: string | null;
  outcome_b: string | null;
  error_a: string | null;
  error_b: string | null;
  duration_ms_a: number;
  duration_ms_b: number;
  duration_delta_ms: number;
  cost_usd_a: number;
  cost_usd_b: number;
};

/** Response of ``POST /orgs/{org}/observability/traces/diff`` (Wave 9). */
export type TraceDiffResult = {
  trace_a: TraceDiffRollup;
  trace_b: TraceDiffRollup;
  totals: {
    cost_delta_usd: number;
    duration_delta_ms: number;
    span_count_delta: number;
    failures_a: number;
    failures_b: number;
    token_delta: number;
  };
  shared: { agent_id: string | null; matched_spans: number };
  counts: { same: number; changed: number; added: number; removed: number };
  steps: TraceDiffStep[];
  took_ms: number;
};

export type TraceDiffRollup = {
  trace_id: string;
  span_count: number;
  duration_ms: number;
  cost_usd: number;
  failures: number;
  input_tokens: number;
  output_tokens: number;
};

/** Prompt registry (prompts_v2) — not under /portal. */
export type PromptListRow = {
  name: string;
  description?: string | null;
  tags?: string[];
  latest_version?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type PromptPins = {
  pins: Record<string, number>;
};

export type PromptDetail = {
  name: string;
  description?: string | null;
  tags?: string[];
  versions?: Array<{
    version: number;
    template?: string;
    model?: string;
    params?: Record<string, unknown>;
    variables?: string[];
    change_note?: string | null;
    created_at?: string | null;
    status?: string;
  }>;
};

export const promptsV2Api = {
  list: (orgId: string) =>
    fetchApi<{
      status: string;
      data: { prompts: PromptListRow[]; count: number };
    }>(`/orgs/${orgId}/prompts`).then((r) => r.data?.prompts ?? []),

  get: (orgId: string, name: string) =>
    fetchApi<{ status: string; data: PromptDetail | null }>(
      `/orgs/${orgId}/prompts/${encodeURIComponent(name)}`,
    ).then((r) => r.data ?? null),

  create: (
    orgId: string,
    body: {
      name: string;
      description?: string;
      tags?: string[];
      auto_eval_on_save?: boolean;
    },
  ) =>
    fetchApi<{ status: string; data: PromptListRow }>(`/orgs/${orgId}/prompts`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  createVersion: (
    orgId: string,
    name: string,
    body: {
      template: string;
      model: string;
      params?: Record<string, unknown>;
      variables?: string[];
      change_note?: string | null;
    },
  ) =>
    fetchApi<{ status: string; data: unknown }>(
      `/orgs/${orgId}/prompts/${encodeURIComponent(name)}/versions`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  getPins: (orgId: string, name: string) =>
    fetchApi<PromptPins>(
      `/orgs/${orgId}/prompts/${encodeURIComponent(name)}/pins`,
    ),

  putPin: (orgId: string, name: string, env: string, version: number) =>
    fetchApi<{ status: string; data?: unknown }>(
      `/orgs/${orgId}/prompts/${encodeURIComponent(name)}/pins/${encodeURIComponent(env)}`,
      {
        method: "PUT",
        body: JSON.stringify({ version }),
      },
    ),

  rollback: (orgId: string, name: string, env = "prod") =>
    fetchApi<{ status: string; data?: unknown }>(
      `/orgs/${orgId}/prompts/${encodeURIComponent(name)}/rollback`,
      {
        method: "POST",
        body: JSON.stringify({ env }),
      },
    ),
};

/** F39 Artifacts (runtime nudges) — `/orgs/{orgId}/artifacts`. */
export type ArtifactMode = "shadow" | "promoted" | "archived";

export type ArtifactRow = {
  id: string;
  agent_id: string;
  name: string;
  mode: ArtifactMode | string;
  action_type: string;
  trigger?: Record<string, unknown>;
  content: string;
  source_issue_id?: string | null;
  evidence?: Record<string, unknown>;
  cost?: { tokens?: number; usd?: number } & Record<string, unknown>;
};

export type ArtifactContextItem = {
  id: string;
  filename?: string | null;
  content_type?: string;
  content_preview?: string;
  preview_truncated?: boolean;
  size_bytes?: number;
  created_at?: string | null;
  created_by?: string;
  agent_id?: string;
};

export type ArtifactDemotionRow = {
  artifact_id: string;
  agent_id: string;
  name: string;
  mode: string;
  reason: string;
  demoted_at?: string | null;
  source: string;
  content_preview?: string;
};

export const artifactsApi = {
  list: (orgId: string, filters?: { agentId?: string; mode?: ArtifactMode }) => {
    const q = new URLSearchParams();
    if (filters?.agentId) q.set("agent_id", filters.agentId);
    if (filters?.mode) q.set("mode", filters.mode);
    const qs = q.toString();
    return fetchApi<{ status: string; data: { artifacts: ArtifactRow[] } }>(
      `/orgs/${orgId}/artifacts${qs ? `?${qs}` : ""}`,
    ).then((r) => r.data?.artifacts ?? []);
  },

  create: (
    orgId: string,
    body: {
      agent_id: string;
      name: string;
      trigger?: Record<string, unknown>;
      action_type?: string;
      content: string;
      mode?: string;
      source_issue_id?: string | null;
    },
  ) =>
    fetchApi<{ status: string; data: { nudge_id: string; mode: string } }>(
      `/orgs/${orgId}/artifacts`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  promote: (orgId: string, artifactId: string) =>
    fetchApi<{ status: string; data?: unknown }>(
      `/orgs/${orgId}/artifacts/${encodeURIComponent(artifactId)}/promote`,
      { method: "POST" },
    ),

  archive: (orgId: string, artifactId: string) =>
    fetchApi<{ status: string; data?: unknown }>(
      `/orgs/${orgId}/artifacts/${encodeURIComponent(artifactId)}/archive`,
      { method: "POST" },
    ),

  listContext: (orgId: string, agentId: string) =>
    fetchApi<{ status: string; data: { items: ArtifactContextItem[] } }>(
      `/orgs/${orgId}/agents/${encodeURIComponent(agentId)}/artifacts/context`,
    ).then((r) => r.data?.items ?? []),

  uploadContext: (orgId: string, agentId: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file, file.name);
    return fetchApi<{ status: string; data: ArtifactContextItem }>(
      `/orgs/${orgId}/agents/${encodeURIComponent(agentId)}/artifacts/context`,
      { method: "POST", body: formData },
    );
  },

  listDemotions: (orgId: string, filters?: { agentId?: string }) => {
    const q = new URLSearchParams();
    if (filters?.agentId) q.set("agent_id", filters.agentId);
    const qs = q.toString();
    return fetchApi<{
      status: string;
      data: { items?: ArtifactDemotionRow[]; demotions?: ArtifactDemotionRow[] };
    }>(`/orgs/${orgId}/artifacts/demotions${qs ? `?${qs}` : ""}`).then(
      (r) => r.data?.items ?? r.data?.demotions ?? [],
    );
  },
};

/** Ledger (`src/eden/kb/ledger/`) — `/orgs/{orgId}/ledger`. */
export type LedgerSummaryRow = {
  agent_id: string;
  version: number;
  inject_enabled: boolean;
  updated_at?: string | null;
};

export type LedgerEntryRow = {
  id: string;
  chapter: string;
  text: string;
  citations?: string[];
  weight?: number;
  version?: number;
  created_at?: string | null;
};

export type LedgerConfig = {
  enabled: boolean;
  max_tokens: number;
  retrieval_enabled?: boolean;
};

export type LedgerDetail = {
  ledger_id: string;
  version: number;
  inject_enabled: boolean;
  config: LedgerConfig;
  entries: LedgerEntryRow[];
};

export const ledgerApi = {
  list: (orgId: string) =>
    fetchApi<{ status: string; data: { ledgers: LedgerSummaryRow[] } }>(
      `/orgs/${orgId}/ledger`,
    ).then((r) => r.data?.ledgers ?? []),

  get: (orgId: string, agentId: string) =>
    fetchApi<{
      status: string;
      data: { ledger: LedgerDetail | null; config: LedgerConfig };
    }>(`/orgs/${orgId}/agents/${encodeURIComponent(agentId)}/ledger`).then(
      (r) => r.data,
    ),

  regenerate: (orgId: string, agentId: string) =>
    fetchApi<{ status: string; data?: unknown }>(
      `/orgs/${orgId}/agents/${encodeURIComponent(agentId)}/ledger/regenerate`,
      { method: "POST" },
    ),

  setConfig: (
    orgId: string,
    agentId: string,
    body: { enabled: boolean; max_tokens: number },
  ) =>
    fetchApi<{ status: string; data?: unknown }>(
      `/orgs/${orgId}/agents/${encodeURIComponent(agentId)}/ledger/config`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
};

/**
 * Fixture export helpers — used by trace-detail and issue-detail
 * "Export fixture" buttons (OOM plan §9.2 / W2-9).
 */
export const fixtureExportApi = {
  /**
   * Export a trace as a JSON file.
   * ``POST /orgs/{orgId}/observability/traces/{traceId}/export``
   * with ``{ "format_type": "json" }``.
   * Returns the trace tree serialised as a JSON string in ``data``.
   */
  exportTrace: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; format: string; data: string }>(
      `/orgs/${orgId}/observability/traces/${encodeURIComponent(traceId)}/export`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Org-Id": orgId,
        },
        body: JSON.stringify({ format_type: "json" }),
      },
    ),

  /**
   * Export the failure fixture for an agent issue.
   * ``POST /orgs/{orgId}/agent-issues/{issueId}/export-fixture``.
   * The fixture bundle (``eden-failure-fixture-v1``) is nested at
   * ``response.data.fixture`` in the standard ok-envelope.
   */
  exportIssue: (orgId: string, issueId: string) =>
    fetchApi<{
      status: string;
      feature: string;
      data: { status: string; fixture?: Record<string, unknown> };
    }>(`/orgs/${orgId}/agent-issues/${encodeURIComponent(issueId)}/export-fixture`, {
      method: "POST",
      headers: { "X-Org-Id": orgId },
    }),
};

/** Assistant live chat (SSE). */
export const assistantApi = {
  listConversations: (orgId: string) =>
    fetchApi<{
      conversations?: Array<{
        id: string;
        title?: string;
        updated_at?: string;
        created_at?: string;
      }>;
    }>(`/orgs/${orgId}/ai/conversations`).then(
      (r) => r.conversations ?? (Array.isArray(r) ? r : []),
    ),

  getConversation: (orgId: string, id: string) =>
    fetchApi<{
      id: string;
      messages?: Array<{
        id?: string;
        role: string;
        content: string;
        created_at?: string;
      }>;
    }>(`/orgs/${orgId}/ai/conversations/${encodeURIComponent(id)}`),

  archiveConversation: (orgId: string, id: string) =>
    fetchApi<{ message?: string }>(
      `/orgs/${orgId}/ai/conversations/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
};

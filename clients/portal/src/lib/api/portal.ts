/**
 * Thin typed client for ``GET /orgs/{orgId}/portal/*`` read models.
 * Mutations stay on domain routes via ``api`` / ``promptsApi`` helpers.
 */
import { ApiError, fetchApi } from "@/lib/api/core";
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
import type { GuardrailPolicyFixture } from "@/lab/fixtures/guardrails";
import type { DebuggerSessionFixture } from "@/lab/fixtures/debugger";
import type { AgentThread } from "@/lab/fixtures/agent-chat";

function portalPath(orgId: string, suffix: string): string {
  return `/orgs/${orgId}/portal/${suffix.replace(/^\//, "")}`;
}

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

  traces: (orgId: string) =>
    fetchApi<TraceFixture[]>(portalPath(orgId, "traces")),

  /**
   * Single-trace detail — same shape as ``traces()`` rows but with
   * ``steps`` populated. The list endpoint always returns
   * ``steps: []`` to avoid an N+1 of per-trace span hydration; call
   * this once a trace is selected to load its real transcript.
   */
  traceDetail: (orgId: string, traceId: string) =>
    fetchApi<TraceFixture>(
      portalPath(orgId, `traces/${encodeURIComponent(traceId)}`),
    ),

  sessions: (orgId: string) =>
    fetchApi<SessionFixture[]>(portalPath(orgId, "sessions")),

  issues: (orgId: string) =>
    fetchApi<IssueFixture[]>(portalPath(orgId, "issues")),

  signals: (orgId: string) =>
    fetchApi<SignalFixture[]>(portalPath(orgId, "signals")),

  alertRules: (orgId: string) =>
    fetchApi<AlertRule[]>(portalPath(orgId, "alerts/rules")),

  alertEvents: async (orgId: string) => {
    try {
      return await fetchApi<AlertEvent[]>(portalPath(orgId, "alerts/events"), {
        softAuth: true,
      });
    } catch (e) {
      // Background Inbox poll — JWT race / membership blip must not
      // empty the shell or trip session chrome; treat as no events.
      if (
        e instanceof ApiError &&
        (e.status === 401 || e.status === 403 || e.status === 404)
      ) {
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

  evalDatasets: (orgId: string) =>
    fetchApi<DatasetFixture[]>(portalPath(orgId, "evals/datasets")),

  evalPlaygrounds: (orgId: string) =>
    fetchApi<PlaygroundFixture[]>(portalPath(orgId, "evals/playgrounds")),

  evalExperiments: (orgId: string) =>
    fetchApi<ExperimentFixture[]>(portalPath(orgId, "evals/experiments")),

  improvePlans: (orgId: string) =>
    fetchApi<ImprovePlanFixture[]>(portalPath(orgId, "improve/plans")),

  compareExperiments: (orgId: string) =>
    fetchApi<AbExperimentFixture[]>(portalPath(orgId, "compare/experiments")),

  guardrailPolicies: (orgId: string) =>
    fetchApi<GuardrailPolicyFixture[]>(portalPath(orgId, "guardrails/policies")),

  debuggerSessions: (orgId: string) =>
    fetchApi<DebuggerSessionFixture[]>(portalPath(orgId, "debugger/sessions")),

  assistantThreads: (orgId: string) =>
    fetchApi<AgentThread[]>(portalPath(orgId, "assistant/threads")),
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

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface FetchOptions extends RequestInit {
  credentials?: "include" | "omit";
}

async function fetchApi<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { credentials = "include", headers, body, ...rest } = options;

  // Build headers - don't set Content-Type for FormData (browser will set it with boundary)
  const requestHeaders: HeadersInit = {
    ...(typeof headers === 'object' && headers !== null ? headers : {}),
  };
  if (!(body instanceof FormData)) {
    (requestHeaders as Record<string, string>)["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    credentials,
    headers: requestHeaders,
    body,
    ...rest,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(error.detail || `HTTP ${response.status}`);
  }

  // SSE streams don't return JSON
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return (await response.text()) as unknown as T;
  }

  return response.json();
}

export const api = {
  // Auth
  signup: (data: { email: string; password: string; name: string }) =>
    fetchApi<{ user_id: string; email: string; message: string }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  login: (data: { email: string; password: string }) =>
    fetchApi<{ user_id: string; email: string; name: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  logout: () =>
    fetchApi<{ message: string }>("/auth/logout", { method: "POST" }),

  getMe: () =>
    fetchApi<{
      user_id: string;
      email: string;
      name: string;
      organizations: Array<{
        id: string;
        name: string;
        slug: string;
        role: string;
      }>;
      current_org_id: string | null;
    }>("/auth/me"),

  // Organizations
  listOrgs: (includeArchived?: boolean) =>
    fetchApi<Array<{
      id: string;
      name: string;
      slug: string;
      role: string;
      is_owner: boolean;
      member_count: number;
      archived_at: string | null;
    }>>(`/orgs${includeArchived ? "?include_archived=true" : ""}`),

  createOrg: (name: string, makeDefault?: boolean) =>
    fetchApi<{ org_id: string; name: string; slug: string; role: string }>("/orgs", {
      method: "POST",
      body: JSON.stringify({ name, make_default: makeDefault ?? true }),
    }),

  getOrg: (orgId: string) =>
    fetchApi<{
      id: string;
      name: string;
      slug: string;
      role: string;
      is_owner: boolean;
      member_count: number;
      settings: Record<string, unknown>;
      archived_at: string | null;
    }>(`/orgs/${orgId}`),

  archiveOrg: (orgId: string) =>
    fetchApi<{ message: string; org_id: string }>(`/orgs/${orgId}/archive`, {
      method: "POST",
    }),

  deleteOrg: (orgId: string) =>
    fetchApi<{ message: string; org_id: string }>(`/orgs/${orgId}`, {
      method: "DELETE",
    }),

  inviteOrgMember: (orgId: string, email: string, role?: string) =>
    fetchApi<{ message: string; invitation_id: string; expires_at: string }>(
      `/orgs/${orgId}/invites`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: role || "member" }),
      }
    ),

  listInvitations: (orgId: string) =>
    fetchApi<Array<{
      id: string;
      email: string;
      role: string;
      inviter_name: string;
      expires_at: string;
      created_at: string;
    }>>(`/orgs/${orgId}/invites`),

  acceptInvite: (orgId: string, invitationId: string) =>
    fetchApi<{ message: string; org_id: string; role: string }>(
      `/orgs/${orgId}/invites/${invitationId}/accept`,
      { method: "POST" }
    ),

  declineInvite: (orgId: string, invitationId: string) =>
    fetchApi<{ message: string }>(
      `/orgs/${orgId}/invites/${invitationId}/decline`,
      { method: "POST" }
    ),

  verifyInviteToken: (token: string) =>
    fetchApi<{
      valid: boolean;
      org_name: string;
      role: string;
      inviter_name: string;
      expires_at: string;
      email: string;
    }>(`/auth/verify-invite-token?token=${encodeURIComponent(token)}`),

  signupFromInvite: (data: { token: string; password: string; name: string }) =>
    fetchApi<{
      user_id: string;
      email: string;
      org_id: string;
      role: string;
      message: string;
    }>("/auth/signup-from-invite", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  listOrgMembers: (orgId: string) =>
    fetchApi<Array<{
      user_id: string;
      email: string;
      name: string;
      role: string;
      joined_at: string;
    }>>(`/orgs/${orgId}/members`),

  removeOrgMember: (orgId: string, userId: string) =>
    fetchApi<{ message: string }>(`/orgs/${orgId}/members/${userId}`, {
      method: "DELETE",
    }),

  // 2FA
  setup2FA: () =>
    fetchApi<{
      secret: string;
      qr_code_base64: string;
      otpauth_url: string;
    }>("/auth/2fa/setup", { method: "POST" }),

  verify2FA: (code: string) =>
    fetchApi<{ enabled: boolean; message: string }>("/auth/2fa/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  disable2FA: (code: string) =>
    fetchApi<{ enabled: boolean; message: string }>("/auth/2fa/disable", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  get2FAStatus: () =>
    fetchApi<{ two_factor_enabled: boolean }>("/auth/2fa/status"),

  enforceOrg2FA: (orgId: string, enforce: boolean) =>
    fetchApi<{ two_factor_enforced: boolean; message: string }>(
      `/orgs/${orgId}/2fa/enforce`,
      {
        method: "POST",
        body: JSON.stringify({ enforce }),
      }
    ),

  getOrg2FAEnforcementStatus: (orgId: string) =>
    fetchApi<{ two_factor_enforced: boolean }>(`/orgs/${orgId}/2fa/enforcement-status`),

  getOrgMembers2FAStatus: (orgId: string) =>
    fetchApi<Array<{
      user_id: string;
      email: string;
      name: string;
      two_factor_enabled: boolean;
      joined_at: string | null;
      last_active_at: string | null;
    }>>(`/orgs/${orgId}/members-2fa-status`),

  transferOwnership: (orgId: string, targetUserId: string) =>
    fetchApi<{ message: string }>(`/orgs/${orgId}/transfer-ownership`, {
      method: "POST",
      body: JSON.stringify({ target_user_id: targetUserId }),
    }),

  // Domain Restrictions
  getAllowedDomains: (orgId: string) =>
    fetchApi<Array<{
      id: string;
      domain: string;
      added_by: string;
      created_at: string;
    }>>(`/orgs/${orgId}/allowed-domains`),

  addAllowedDomain: (orgId: string, domain: string) =>
    fetchApi<{
      id: string;
      domain: string;
      added_by: string;
      created_at: string;
    }>(`/orgs/${orgId}/allowed-domains`, {
      method: "POST",
      body: JSON.stringify({ domain }),
    }),

  removeAllowedDomain: (orgId: string, domainId: string) =>
    fetchApi<{ message: string }>(`/orgs/${orgId}/allowed-domains/${domainId}`, {
      method: "DELETE",
    }),

  // Billing
  getPlans: (orgId: string) =>
    fetchApi<{
      plan_name: string;
      seats_limit: number;
      seats_used: number;
      references_limit: number;
      references_used: number;
      jobs_limit: number;
      jobs_used: number;
      active: boolean;
      stripe_subscription_id?: string;
      subscription_status?: string;
      current_period_end?: string;
    }>(`/orgs/${orgId}/billing/plans`),

  subscribe: (orgId: string, data: { plan_name: string; success_url: string; cancel_url: string }) =>
    fetchApi<{ checkout_url: string; session_id: string }>(`/orgs/${orgId}/billing/subscribe`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getInvoices: (orgId: string) =>
    fetchApi<Array<{
      id: string;
      amount_paid: number;
      currency: string;
      status: string;
      created: number;
      invoice_url?: string;
    }>>(`/orgs/${orgId}/billing/invoices`),

  cancelSubscription: (orgId: string) =>
    fetchApi<{ message: string; cancel_at: number }>(`/orgs/${orgId}/billing/cancel`, {
      method: "POST",
    }),

  // Domain Restrictions
  getDomainRestriction: (orgId: string) =>
    fetchApi<{
      domain_restriction_enforced: boolean;
    }>(`/orgs/${orgId}/domain-restriction`),

  updateDomainRestriction: (orgId: string, enforced: boolean) =>
    fetchApi<{
      domain_restriction_enforced: boolean;
    }>(`/orgs/${orgId}/domain-restriction`, {
      method: "PATCH",
      body: JSON.stringify({ domain_restriction_enforced: enforced }),
    }),

  // Code References
  listReferences: (orgId: string, params?: { purpose?: string; language?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.purpose) searchParams.set("purpose", params.purpose);
    if (params?.language) searchParams.set("language", params.language);
    const qs = searchParams.toString();
    return fetchApi<Array<{
      id: string;
      name: string;
      description: string | null;
      purpose: string;
      filename: string;
      language: string;
      uploaded_by: string;
      created_at: string;
    }>>(`/orgs/${orgId}/references${qs ? `?${qs}` : ""}`);
  },

  getReference: (orgId: string, refId: string) =>
    fetchApi<{
      id: string;
      name: string;
      description: string | null;
      purpose: string;
      filename: string;
      language: string;
      content: string;
      uploaded_by: string;
      created_at: string;
    }>(`/orgs/${orgId}/references/${refId}`),

  uploadReference: (orgId: string, formData: FormData) =>
    fetchApi<{ id: string; name: string; purpose: string; filename: string; language: string; message: string }>(
      `/orgs/${orgId}/references`,
      { method: "POST", body: formData }
    ),

  deleteReference: (orgId: string, refId: string) =>
    fetchApi<{ message: string }>(`/orgs/${orgId}/references/${refId}`, {
      method: "DELETE",
    }),

  searchReferences: (orgId: string, query: string) =>
    fetchApi<Array<{
      id: string;
      name: string;
      description: string | null;
      purpose: string;
      filename: string;
      language: string;
      similarity: number;
    }>>(`/orgs/${orgId}/references/search/by-text?q=${encodeURIComponent(query)}`),

  listReferencePurposes: (orgId: string) =>
    fetchApi<string[]>(`/orgs/${orgId}/references/purposes`),

  // Jobs
  listJobs: (params?: { status?: string; outcome_tier?: string; q?: string; sort?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    if (params?.outcome_tier) searchParams.set("outcome_tier", params.outcome_tier);
    if (params?.q) searchParams.set("q", params.q);
    if (params?.sort) searchParams.set("sort", params.sort);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    const qs = searchParams.toString();
    return fetchApi<{
      jobs: Array<{
        job_id: string;
        status: string;
        current_stage: string;
        outcome_tier: string | null;
        created_at: string;
        updated_at: string;
      }>;
      total: number;
      limit: number;
      offset: number;
    }>(`/jobs${qs ? `?${qs}` : ""}`);
  },

  getJob: (jobId: string) =>
    fetchApi<{
      job_id: string;
      status: string;
      current_stage: string;
      outcome_tier: string | null;
      created_at: string;
      updated_at: string;
      stage_history: Array<{ from?: string; to: string; at: string }>;
    }>(`/jobs/${jobId}`),

  getJobResult: (jobId: string) =>
    fetchApi<{
      job_id: string;
      status: string;
      outcome_tier: string | null;
      environment_code: string | null;
      test_results: Record<string, unknown> | null;
      quality_report: Record<string, unknown> | null;
      archivist_summary: Record<string, unknown> | null;
    }>(`/jobs/${jobId}/result`),

  submitJob: (data: {
    description: string;
    tags: string[];
    framework: string;
    framework_version: string;
    difficulty_parameters: Record<string, unknown>;
    output_mode: string;
  }) =>
    fetchApi<{ job_id: string; status: string; message: string }>("/jobs", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  cancelJob: (jobId: string) =>
    fetchApi<{ job_id: string; status: string; message: string }>(
      `/jobs/${jobId}/cancel`,
      { method: "POST" }
    ),

  // API Keys
  createApiKey: (orgId: string, name: string, scopes: string[]) =>
    fetchApi<{
      id: string;
      name: string;
      key_prefix: string;
      scopes: string[];
      raw_key: string;
      created_at: string | null;
    }>(`/orgs/${orgId}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    }),

  listApiKeys: (orgId: string) =>
    fetchApi<Array<{
      id: string;
      name: string;
      key_prefix: string;
      scopes: string[];
      created_by: string;
      last_used_at: string | null;
      created_at: string;
    }>>(`/orgs/${orgId}/api-keys`),

  revokeApiKey: (orgId: string, keyId: string) =>
    fetchApi<{ message: string }>(`/orgs/${orgId}/api-keys/${keyId}`, {
      method: "DELETE",
    }),

  // Audit Log
  getAuditLog: (orgId: string, params?: {
    action?: string;
    user_id?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.action) searchParams.set("action", params.action);
    if (params?.user_id) searchParams.set("user_id", params.user_id);
    if (params?.from) searchParams.set("from_date", params.from);
    if (params?.to) searchParams.set("to_date", params.to);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    const qs = searchParams.toString();
    return fetchApi<{
      entries: Array<{
        id: string;
        org_id: string;
        user_id: string;
        action: string;
        target_type: string | null;
        target_id: string | null;
        metadata: Record<string, unknown>;
        ip_address: string | null;
        user_agent: string | null;
        created_at: string;
      }>;
      total: number;
      limit: number;
      offset: number;
    }>(`/orgs/${orgId}/audit-log${qs ? `?${qs}` : ""}`);
  },

  // Analytics
  getOrgAnalytics: (orgId: string, days?: number) =>
    fetchApi<{
      job_counts_by_day: Array<{ date: string; count: number }>;
      reference_uploads_by_day: Array<{ date: string; count: number }>;
      active_members_count: number;
      total_references: number;
      storage_bytes_used: number;
      member_activity: Array<{
        user_id: string;
        email: string;
        name: string;
        role: string;
        joined_at: string | null;
        last_active_at: string | null;
      }>;
    }>(`/orgs/${orgId}/analytics${days ? `?days=${days}` : ""}`),

  // Optimization — server may not have these endpoints yet; callers should
  // fall back to synthetic data on 404. Wrapped in try/catch at the call site.
  getOptimizationCosts: (orgId: string, days?: number) =>
    fetchApi<{
      by_day: Array<{ date: string; cost_usd: number }>;
      by_model: Array<{ model: string; cost_usd: number; tokens: number; requests: number }>;
    }>(
      `/orgs/${orgId}/optimization/costs${days ? `?days=${days}` : ""}`
    ),

  getOptimizationCache: (orgId: string, days?: number) =>
    fetchApi<{
      by_day: Array<{
        date: string;
        cache_hits: number;
        cache_misses: number;
        tokens_saved: number;
        cost_saved_usd: number;
      }>;
    }>(
      `/orgs/${orgId}/optimization/cache${days ? `?days=${days}` : ""}`
    ),

  getOptimizationSavings: (orgId: string, days?: number) =>
    fetchApi<{
      by_day: Array<{ date: string; baseline_cost_usd: number; actual_cost_usd: number }>;
      total_savings_usd: number;
    }>(
      `/orgs/${orgId}/optimization/savings${days ? `?days=${days}` : ""}`
    ),

  getOptimizationBudget: (orgId: string) =>
    fetchApi<{
      budget_usd: number;
      spent_usd: number;
      burn_pct: number;
      days_into_period: number;
      days_remaining: number;
      projected_eom_cost_usd: number;
      on_track: boolean;
    }>(`/orgs/${orgId}/optimization/budget`),

  getOptimizationCostPerTrace: (orgId: string, days?: number) =>
    fetchApi<{
      points: Array<{
        trace_id: string;
        cost_usd: number;
        tokens: number;
        latency_ms: number;
        model: string;
      }>;
    }>(
      `/orgs/${orgId}/optimization/cost-per-trace${days ? `?days=${days}` : ""}`
    ),

  // Per-model token usage (analytics tab)
  getTokenUsage: (orgId: string, days?: number) =>
    fetchApi<{
      by_day: Array<{
        date: string;
        input_tokens: number;
        output_tokens: number;
      }>;
    }>(`/orgs/${orgId}/analytics/token-usage${days ? `?days=${days}` : ""}`),

  // Latency percentiles over time
  getLatencyPercentiles: (orgId: string, days?: number) =>
    fetchApi<{
      by_day: Array<{ date: string; p50_ms: number; p95_ms: number; p99_ms: number }>;
    }>(
      `/orgs/${orgId}/analytics/latency${days ? `?days=${days}` : ""}`
    ),

  // Throughput by hour-of-day
  getThroughputByHour: (orgId: string, days?: number) =>
    fetchApi<{
      by_hour: Array<{ hour: number; weekday: number; requests: number }>;
    }>(
      `/orgs/${orgId}/analytics/throughput${days ? `?days=${days}` : ""}`
    ),

  // Top agents by cost
  getTopAgentsByCost: (orgId: string, days?: number) =>
    fetchApi<{
      agents: Array<{
        agent: string;
        cost_usd: number;
        requests: number;
        avg_latency_ms: number;
      }>;
    }>(`/orgs/${orgId}/analytics/top-agents${days ? `?days=${days}` : ""}`),

  // SCIM
  getScimConfig: (orgId: string) =>
    fetchApi<{
      scim_enabled: boolean;
      last_sync_at: string | null;
      provisioned_user_count: number;
      has_token: boolean;
    }>(`/orgs/${orgId}/scim/config`),

  configureScim: (orgId: string, enabled: boolean) =>
    fetchApi<{
      scim_enabled: boolean;
      bearer_token?: string;
      message: string;
    }>(`/orgs/${orgId}/scim/config`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),

  rotateScimToken: (orgId: string) =>
    fetchApi<{
      bearer_token: string;
      message: string;
    }>(`/orgs/${orgId}/scim/rotate-token`, {
      method: "POST",
    }),

  // Data Export
  exportOrgData: (orgId: string) => {
    const url = `${API_BASE}/orgs/${orgId}/export`;
    // Return a promise that triggers download
    return fetch(url, {
      credentials: "include",
    }).then(async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: "Export failed" }));
        throw new Error(error.detail || `HTTP ${response.status}`);
      }
      // Get blob and trigger download
      const blob = await response.blob();
      const contentDisposition = response.headers.get("content-disposition");
      const filenameMatch = contentDisposition?.match(/filename="?(.+)"?/);
      const filename = filenameMatch ? filenameMatch[1] : `export_${orgId}.zip`;

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      return { success: true, filename };
    });
  },

  // SSO Providers
  listSSOProviders: (orgId: string) =>
    fetchApi<Array<{
      id: string;
      org_id: string;
      provider_type: string;
      name: string;
      enabled: boolean;
      default_for_domain: string | null;
      enforce_sso: boolean;
      scim_enabled: boolean;
      created_at: string;
    }>>(`/sso/providers?org_id=${orgId}`),

  createSSOProvider: (orgId: string, data: {
    provider_type: string;
    name: string;
    entity_id?: string;
    sso_url?: string;
    client_id?: string;
    client_secret?: string;
  }) =>
    fetchApi<{ id: string; message: string }>(`/sso/providers?org_id=${orgId}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateSSOProvider: (orgId: string, providerId: string, data: Record<string, unknown>) =>
    fetchApi<{ message: string }>(`/sso/providers/${providerId}?org_id=${orgId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  enableSSOProvider: (orgId: string, providerId: string) =>
    fetchApi<{ message: string }>(`/sso/providers/${providerId}/enable?org_id=${orgId}`, {
      method: "POST",
    }),

  disableSSOProvider: (orgId: string, providerId: string) =>
    fetchApi<{ message: string }>(`/sso/providers/${providerId}/disable?org_id=${orgId}`, {
      method: "POST",
    }),

  enforceSSO: (orgId: string, providerId: string, enforce: boolean) =>
    fetchApi<{ message: string }>(`/sso/providers/${providerId}/enforce?org_id=${orgId}&enforce=${enforce}`, {
      method: "POST",
    }),

  generateSCIMToken: (orgId: string, providerId: string) =>
    fetchApi<{ token: string; message: string }>(`/sso/providers/${providerId}/scim/token?org_id=${orgId}`, {
      method: "POST",
    }),

  revokeSCIMToken: (orgId: string, providerId: string) =>
    fetchApi<{ message: string }>(`/sso/providers/${providerId}/scim/token?org_id=${orgId}`, {
      method: "DELETE",
    }),

  // Exports (Phase 8) — destinations & schedules
  // See eden/api/routes/export_destinations.py.
  // ``config`` is the safe (no-secret) shape returned to the
  // portal; ``credentials`` is never echoed back. The portal
  // sends a separate ``credentials`` object on create that the
  // backend Fernet-encrypts at rest.
  listExportDestinations: (orgId: string) =>
    fetchApi<Array<{
      destination_id: string;
      org_id: string;
      name: string;
      type: string;
      config: Record<string, unknown>;
      created_at: string;
      created_by: string | null;
    }>>(`/orgs/${orgId}/export/destinations`),

  createExportDestination: (orgId: string, data: {
    name: string;
    type: string;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }) =>
    fetchApi<{
      destination_id: string;
      org_id: string;
      name: string;
      type: string;
      config: Record<string, unknown>;
      created_at: string;
      created_by: string | null;
    }>(`/orgs/${orgId}/export/destinations`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteExportDestination: (orgId: string, destinationId: string) =>
    fetchApi<{ message: string; destination_id: string }>(
      `/orgs/${orgId}/export/destinations/${destinationId}`,
      { method: "DELETE" }
    ),

  listExportSchedules: (orgId: string) =>
    fetchApi<Array<{
      schedule_id: string;
      org_id: string;
      destination_id: string | null;
      data_type: string;
      format: string;
      cron_expression: string | null;
      last_run_at: string | null;
      created_at: string;
      created_by: string | null;
    }>>(`/orgs/${orgId}/export/schedules`),

  createExportSchedule: (orgId: string, data: {
    destination_id?: string | null;
    data_type: string;
    format: string;
    cron_expression?: string | null;
  }) =>
    fetchApi<{
      schedule_id: string;
      org_id: string;
      destination_id: string | null;
      data_type: string;
      format: string;
      cron_expression: string | null;
      last_run_at: string | null;
      created_at: string;
      created_by: string | null;
    }>(`/orgs/${orgId}/export/schedules`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteExportSchedule: (orgId: string, scheduleId: string) =>
    fetchApi<{ message: string; schedule_id: string }>(
      `/orgs/${orgId}/export/schedules/${scheduleId}`,
      { method: "DELETE" }
    ),

  runExportNow: (orgId: string, scheduleId: string) =>
    fetchApi<{
      schedule_id: string;
      status: string;
      bytes_written: number;
      destination: string;
      started_at: string;
      finished_at: string;
    }>(`/orgs/${orgId}/export/run-now/${scheduleId}`, {
      method: "POST",
    }),
};

export function getJobStreamUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}/stream`;
}
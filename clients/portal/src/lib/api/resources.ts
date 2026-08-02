import { fetchApi, API_BASE } from "./core";

/** Matches BE ``InsightResponse`` from ``POST /orgs/{org}/insights/detectors/run``. */
export type InsightResponse = {
  insight_id: string;
  detector: string;
  severity: string;
  confidence: number;
  summary: string;
  affected_trace_ids: string[];
  pattern: Record<string, unknown>;
  recommended_action: string;
  auto_created_dataset: string | null;
  metadata: Record<string, unknown>;
};

/** Matches BE ``RunDetectorsRequest``. */
export type RunDetectorsRequest = {
  detector_names?: string[] | null;
  realm?: string | null;
};

/** Matches BE ``OverviewResponse`` from ``GET /orgs/{org}/insights/overview``. */
export type InsightsOverviewResponse = {
  summary: {
    total_traces: number;
    total_insights: number;
    total_disparity_reports: number;
    total_datasets: number;
    high_disparity_count: number;
    avg_disparity_score: number;
    source?: "postgres" | "in_memory" | string;
    honesty_banner?: string;
  };
  traces: {
    by_realm: Record<string, number>;
    by_outcome: Record<string, number>;
  };
  insights: {
    by_detector: Record<string, number>;
    by_severity: Record<string, number>;
    recent: InsightResponse[];
  };
  disparity: {
    reports: Array<{
      report_id: string;
      tenant_id: string;
      env_trace_id: string;
      prod_trace_id: string;
      generated_at: string;
      overall_score: number;
      dimensions: Array<{
        name: string;
        env_value: number;
        prod_value: number;
        gap: number;
        severity: string;
        explanation: string;
      }>;
      recommendations: string[];
      metadata: Record<string, unknown>;
    }>;
    high_disparity_count: number;
    avg_score: number;
  };
  datasets: {
    count: number;
    items: Array<{
      dataset_id: string;
      name: string;
      dataset_type: string;
      version: string;
      tenant_id: string;
      project_id: string;
      created_at: string;
      updated_at: string;
      entry_count: number;
      tags: string[];
      metadata: Record<string, unknown>;
    }>;
  };
};

export const api = {
  // Generic HTTP verbs — escape hatch for new routes whose typed
  // helpers haven't been added yet. Prefer the typed per-resource
  // methods (api.listRoles, api.listGatewayModels, …) where they
  // exist; the generic methods are intentionally loosely typed.
  get: <T = unknown>(endpoint: string) => fetchApi<T>(endpoint, { method: "GET" }),
  post: <T = unknown>(endpoint: string, body?: unknown) =>
    fetchApi<T>(endpoint, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T = unknown>(endpoint: string, body?: unknown) =>
    fetchApi<T>(endpoint, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T = unknown>(endpoint: string, body?: unknown) =>
    fetchApi<T>(endpoint, {
      method: "PUT",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  delete: <T = unknown>(endpoint: string) =>
    fetchApi<T>(endpoint, { method: "DELETE" }),

  // Auth. ``/auth/signup`` and ``/auth/login`` both return the full
  // ``UserResponse`` (user_id + email + name + organizations +
  // current_org_id) so the frontend can populate the user context
  // in a single roundtrip — no follow-up ``/auth/me`` needed.
  signup: (data: { email: string; password: string; name: string }) =>
    fetchApi<{
      user_id: string;
      email: string;
      name: string;
      two_factor_enabled: boolean;
      organizations: Array<{ id: string; name: string; slug: string; role: string }>;
      current_org_id: string | null;
    }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  login: (data: { email: string; password: string }) =>
    fetchApi<{
      user_id: string;
      email: string;
      name: string;
      two_factor_enabled: boolean;
      organizations: Array<{ id: string; name: string; slug: string; role: string }>;
      current_org_id: string | null;
    }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  logout: () =>
    fetchApi<{ message: string }>("/auth/logout", { method: "POST" }),

  // Password reset flow — the BE route
  // (``POST /auth/forgot-password`` and
  // ``POST /auth/reset-password``) is currently shipped in tests
  // but the live route handler is tracked as Phase 7.5 work.
  // The FE keeps the call sites typed so consumers don't
  // throw a 404 at the wrong layer.
  forgotPassword: (data: { email: string }) =>
    fetchApi<{ message: string }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  resetPassword: (data: { token: string; password: string }) =>
    fetchApi<{ message: string }>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),

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
        clerk_org_id?: string | null;
        is_personal?: boolean;
      }>;
      current_org_id: string | null;
    }>("/auth/me"),

  // Notifications (user-scoped, polled by NotificationsProvider)
  listNotifications: (params?: { limit?: number }) =>
    fetchApi<{
      notifications: Array<{
        id: string;
        user_id: string;
        org_id: string | null;
        type: string;
        title: string;
        message: string;
        metadata: Record<string, unknown>;
        is_read: boolean;
        created_at: string;
      }>;
      unread_count: number;
    }>("/notifications" + (params?.limit ? `?limit=${params.limit}` : "")),
  markNotificationRead: (notificationId: string) =>
    fetchApi<{ id: string; is_read: boolean }>(
      `/notifications/${notificationId}/read`,
      { method: "PATCH" },
    ),
  markAllNotificationsRead: () =>
    fetchApi<{ updated: number }>("/notifications/read-all", {
      method: "PATCH",
    }),
  deleteNotification: (notificationId: string) =>
    fetchApi<{ id: string }>(`/notifications/${notificationId}`, {
      method: "DELETE",
    }),

  // Sidebar preferences (per-user, per-org) — June 2026 Phase 1.
  // The shape mirrors the SidebarPrefs in use-sidebar-prefs.ts.
  getSidebarPrefs: (orgId: string) =>
    fetchApi<{
      pinned: string[];
      hidden: string[];
      group_order: string[];
      density: "comfortable" | "compact";
    } | null>(`/orgs/${orgId}/sidebar-prefs`),
  setSidebarPrefs: (
    orgId: string,
    prefs: {
      pinned: string[];
      hidden: string[];
      group_order: string[];
      density: "comfortable" | "compact";
    }
  ) =>
    fetchApi<{ ok: true }>(`/orgs/${orgId}/sidebar-prefs`, {
      method: "PUT",
      body: JSON.stringify(prefs),
    }),

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
      is_personal?: boolean;
    }>>(`/orgs${includeArchived ? "?include_archived=true" : ""}`),

  createOrg: (name: string, makeDefault?: boolean) =>
    fetchApi<{
      org_id: string;
      name: string;
      slug: string;
      role: string;
      /**
       * Clerk organisation id (``org_2x...``) for the newly created
       * org. Null when Clerk sync was degraded at create time; the
       * portal falls back to Eden-only state and surfaces a soft
       * warning via ``org_degraded``.
       */
      clerk_org_id: string | null;
      /** True when the local row was written but Clerk was unreachable. */
      org_degraded: boolean;
    }>("/orgs", {
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

  updateOrgSettings: (orgId: string, settings: Record<string, unknown>) =>
    fetchApi<{ settings: Record<string, unknown> }>(
      `/orgs/${orgId}/settings`,
      {
        method: "PATCH",
        body: JSON.stringify(settings),
      },
    ),

  archiveOrg: (orgId: string) =>
    fetchApi<{ message: string; org_id: string }>(`/orgs/${orgId}/archive`, {
      method: "POST",
    }),

  deleteOrg: (orgId: string) =>
    fetchApi<{ message: string; org_id: string }>(`/orgs/${orgId}`, {
      method: "DELETE",
    }),

  inviteOrgMember: (orgId: string, email: string, role?: string) =>
    fetchApi<{
      message: string;
      invitation_id: string;
      expires_at: string;
      email_status?: string;
      invite_url?: string;
    }>(
      `/orgs/${orgId}/invites`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: role || "member" }),
      }
    ),

  updateOrgMemberRole: (orgId: string, userId: string, role: string) =>
    fetchApi<{ message: string; user_id: string; role: string }>(
      `/orgs/${orgId}/members/${userId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
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
    fetchApi<{
      message: string;
      org_id: string;
      role: string;
      /** Clerk org id; null if the org predates Clerk sync. */
      clerk_org_id: string | null;
    }>(
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

  acceptInviteByToken: (token: string) =>
    fetchApi<{
      org_id: string;
      role: string;
      org_name?: string;
      message: string;
      clerk_org_id?: string | null;
    }>(`/auth/invitations/accept?token=${encodeURIComponent(token)}`, {
      method: "POST",
    }),

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

  // Profile mutations (Phase A.4)
  updateProfile: (data: { name?: string; avatar_url?: string }) =>
    fetchApi<{ user_id: string; email: string; name: string; avatar_url?: string }>(
      "/auth/users/me",
      { method: "PATCH", body: JSON.stringify(data) },
    ),

  changePassword: (oldPassword: string, newPassword: string) =>
    fetchApi<void>("/auth/users/me/password", {
      method: "POST",
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }),

  uploadAvatar: async (file: File): Promise<{ avatar_url: string }> => {
    // PT-9: route through fetchApi so the 401-retry + in-flight
    // dedup machinery applies (the bare-fetch path was missing both,
    // so a stale session JWT left the upload silently 401'ing).
    const formData = new FormData();
    formData.append("file", file);
    return fetchApi<{ avatar_url: string }>(
      "/auth/users/me/avatar",
      {
        method: "POST",
        body: formData,
      }
    );
  },

  deleteAccount: (confirm: string) =>
    fetchApi<void>("/auth/users/me", {
      method: "DELETE",
      body: JSON.stringify({ confirm }),
    }),

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
      display_name?: string;
      /** Primary free-tier meter — 100 credits ≈ $1 Eden COGS. */
      credits_used?: number;
      credits_soft_limit?: number;
      credits_hard_limit?: number;
      credits_status?: string;
      cost_used_usd?: number;
      cost_soft_limit_usd?: number;
      cost_hard_limit_usd?: number;
      cost_status?: string;
      seats_limit: number;
      seats_used: number;
      references_limit: number;
      references_used: number;
      tokens_used?: number;
      storage_mb_used?: number;
      sandbox_seconds_used?: number;
      jobs_limit?: number;
      jobs_used?: number;
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

  // Stripe customer portal — opens the hosted UI where the user
  // can manage cards / bank accounts / billing details. Returns a
  // short-lived URL the portal opens in a new tab.
  createPortalSession: (orgId: string, data: { return_url: string }) =>
    fetchApi<{ portal_url: string }>(`/orgs/${orgId}/billing/portal`, {
      method: "POST",
      body: JSON.stringify(data),
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

  // API Keys
  createApiKey: (
    orgId: string,
    name: string,
    scopes?: string[],
  ) => {
    const SDK_DEFAULT_SCOPES = [
      "references:read",
      "references:write",
      "jobs:read",
      "jobs:write",
      "ingest:write",
      "gateway:write",
    ];
    const trimmed = (name ?? "").trim() || "SDK";
    const resolvedScopes =
      Array.isArray(scopes) && scopes.length > 0
        ? scopes
        : SDK_DEFAULT_SCOPES;
    return fetchApi<{
      id: string;
      name: string;
      key_prefix: string;
      scopes: string[];
      raw_key: string;
      created_at: string | null;
    }>(`/orgs/${orgId}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name: trimmed, scopes: resolvedScopes }),
    });
  },

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

  // AI Insights
  // (added in B4 — see ai-insights/ChatSidebar)
  listAiInsightsSessions: (orgId: string) =>
    fetchApi<{
      sessions: Array<{
        session_id: string;
        title: string;
        created_at: string | null;
        updated_at: string | null;
        archived: boolean;
      }>;
    }>(`/orgs/${orgId}/ai-insights/sessions`),

  getAiInsightsSessionMessages: (orgId: string, sessionId: string) =>
    fetchApi<{
      session_id: string;
      title: string;
      messages: Array<{
        message_id: string;
        role: string;
        content: unknown;
        created_at: string | null;
      }>;
    }>(`/orgs/${orgId}/ai-insights/sessions/${sessionId}/messages`),

  archiveAiInsightsSession: (orgId: string, sessionId: string) =>
    fetchApi<{ session_id: string; archived: boolean }>(
      `/orgs/${orgId}/ai-insights/sessions/${sessionId}/archive`,
      { method: "POST" },
    ),

  // Data Export — route through fetchApi with ``stream: true`` so the
  // binary zip body isn't JSON-parsed (PT-9). Pre-fix the bare-fetch
  // path returned the response as-is but skipped the 401-retry /
  // in-flight dedup machinery the rest of the api surface uses.
  exportOrgData: async (orgId: string): Promise<Blob> => {
    const blob = await fetchApi<Blob>(`/orgs/${orgId}/export`, {
      stream: true,
    });
    // ``stream: true`` returns a Blob (zip bytes). Trigger download.
    const zip =
      blob.type && blob.type !== "application/octet-stream"
        ? blob
        : new Blob([blob], { type: "application/zip" });
    const url = URL.createObjectURL(zip);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eden-export-${orgId}-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    return zip;
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

  // Compliance: PII Policy — shapes mirror
  // ``eden.api.routes.pii_policy.PIIPolicyIn`` / ``PIIPolicyOut``.
  getPiiPolicy: (orgId: string) =>
    fetchApi<{
      policy_id: string;
      tenant_id: string;
      mode: "off" | "redact" | "fail_closed" | string;
      enabled_categories: string[];
      disabled_categories: string[];
      fail_closed_on_credentials: boolean;
      redact_keys_extra: string[];
      effective_from: string;
      effective_until: string | null;
      created_by: string | null;
      notes: string | null;
    }>(`/orgs/${orgId}/pii-policy`),

  updatePiiPolicy: (
    orgId: string,
    data: {
      mode?: "off" | "redact" | "fail_closed" | string;
      enabled_categories?: string[];
      disabled_categories?: string[];
      fail_closed_on_credentials?: boolean;
      redact_keys_extra?: string[];
      notes?: string | null;
    }
  ) =>
    fetchApi<{
      policy_id: string;
      tenant_id: string;
      mode: "off" | "redact" | "fail_closed" | string;
      enabled_categories: string[];
      disabled_categories: string[];
      fail_closed_on_credentials: boolean;
      redact_keys_extra: string[];
      effective_from: string;
      effective_until: string | null;
      created_by: string | null;
      notes: string | null;
    }>(`/orgs/${orgId}/pii-policy`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Compliance: Retention Policy — shapes mirror
  // ``eden.api.routes.retention_policy.RetentionPolicyIn`` /
  // ``RetentionPolicyOut``. GET returns the list of active
  // per-table overrides; PUT replaces one table's override.
  getRetentionPolicy: (orgId: string) =>
    fetchApi<Array<{
      policy_id: string;
      tenant_id: string;
      table_name: string;
      hot_days: number;
      warm_days: number;
      cold_days: number;
      delete_days: number;
      pii_scrub_after_days: number | null;
      effective_from: string;
      effective_until: string | null;
      notes: string | null;
    }>>(`/orgs/${orgId}/retention-policy`),

  updateRetentionPolicy: (
    orgId: string,
    data: {
      table_name: string;
      hot_days: number;
      warm_days: number;
      cold_days: number;
      delete_days: number;
      pii_scrub_after_days?: number | null;
      notes?: string | null;
    }
  ) =>
    fetchApi<{
      policy_id: string;
      tenant_id: string;
      table_name: string;
      hot_days: number;
      warm_days: number;
      cold_days: number;
      delete_days: number;
      pii_scrub_after_days: number | null;
      effective_from: string;
      effective_until: string | null;
      notes: string | null;
    }>(`/orgs/${orgId}/retention-policy`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // ── Observability: judges (Phase 7.2b) ────────────────────────
  // These power the live "Scores" tab in /observability.

  /**
   * Run the registered judges on a specific trace. There is no async
   * judge tailer — the backend always runs inline and returns the
   * resulting scores in the response (even if `sync` is omitted or
   * false, the backend coerces to sync rather than 501ing).
   */
  runJudges: (
    orgId: string,
    body: { trace_id: string; judge_names?: string[] | null; sync?: boolean },
  ): Promise<{
    judge_runs: Array<{
      judge_run_id?: string | null;
      judge_name: string;
      judge_version: string;
      trace_id: string;
      span_id?: string | null;
      score: number;
      rationale?: string | null;
      model: string;
      scored_at: string;
      latency_ms: number;
      metadata: Record<string, unknown>;
    }>;
    count: number;
    queued: boolean;
    job_id?: string | null;
  }> =>
    fetchApi(`/orgs/${orgId}/observability/judges/run`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /**
   * List judge scores for a tenant, optionally filtered by trace or
   * judge name. Returns a page of rows plus a ``next_cursor`` token
   * for pagination.
   */
  listJudgeScores: (
    orgId: string,
    params: {
      trace_id?: string;
      judge_name?: string;
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<{
    scores: Array<{
      judge_run_id: string;
      trace_id: string;
      span_id?: string | null;
      judge_name: string;
      judge_version: string;
      score: number;
      rationale?: string | null;
      model: string;
      scored_at: string;
      latency_ms?: number | null;
    }>;
    next_cursor: string | null;
  }> => {
    const q = new URLSearchParams();
    if (params.trace_id) q.set("trace_id", params.trace_id);
    if (params.judge_name) q.set("judge_name", params.judge_name);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return fetchApi(
      `/orgs/${orgId}/observability/judges${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * Fetch a single judge run by id. Used for the per-score detail
   * drawer in the portal.
   */
  getJudgeScore: (
    orgId: string,
    judgeRunId: string,
  ): Promise<{
    judge_run_id: string;
    trace_id: string;
    span_id?: string | null;
    judge_name: string;
    judge_version: string;
    score: number;
    rationale?: string | null;
    model: string;
    scored_at: string;
    latency_ms?: number | null;
  }> => fetchApi(`/orgs/${orgId}/observability/judges/${judgeRunId}`),

  // ── Observability: PII policy (Phase 7.3a) ───────────────────

  // ── Observability: trace tree (Inspector page) ──────────────
  // Hierarchical tree of spans rooted at the trace's entry span,
  // used by the Inspector page to render the call-graph view.
  // The BE returns ``root_spans`` as a list of nested dicts; we
  // keep the type loose (list of unknown dicts) because the
  // exact span shape varies by ``realm``.
  getTraceTree: (
    orgId: string,
    traceId: string,
  ): Promise<{
    trace_id: string;
    tenant_id: string;
    realm: string;
    root_spans: Array<Record<string, unknown>>;
    total_duration_ms: number;
    span_count: number;
    outcome: string | null;
  }> => fetchApi(`/orgs/${orgId}/observability/traces/${traceId}/tree`),

  // ── Observability: trace replay (Replay page) ──────────────
  // Paginated read of telemetry_events for a single trace via the
  // Cat 1 intelligence replay service. The BE returns an envelope
  // ``{status, data: {events, next_cursor, ...}}``; we unwrap
  // ``data.events`` so the Replay page can consume events directly.
  // ``page_size`` is clamped to 1000 by the BE.
  getTraceReplay: (
    orgId: string,
    traceId: string,
    cursor: number = 0,
    pageSize: number = 1000,
  ): Promise<{
    events: Array<{
      event_id: string;
      event_type: string;
      timestamp: string;
      sequence: number;
      tenant_id: string;
      user_id: string;
      entity_id: string;
      priority: string;
      payload: Record<string, unknown>;
      version: string;
    }>;
    next_cursor: number;
    total: number;
  }> =>
    fetchApi<{
      status?: string;
      data?: {
        events?: Array<{
          event_id: string;
          event_type: string;
          timestamp: string;
          sequence: number;
          tenant_id: string;
          user_id: string;
          entity_id: string;
          priority: string;
          payload: Record<string, unknown>;
          version: string;
        }>;
        next_cursor?: number;
        total?: number;
        event_count?: number;
      };
      events?: Array<{
        event_id: string;
        event_type: string;
        timestamp: string;
        sequence: number;
        tenant_id: string;
        user_id: string;
        entity_id: string;
        priority: string;
        payload: Record<string, unknown>;
        version: string;
      }>;
      next_cursor?: number;
      total?: number;
    }>(
      `/orgs/${orgId}/intelligence/replay/${traceId}/replay`,
      { method: "POST", body: JSON.stringify({ cursor, page_size: pageSize }) },
    ).then((res) => {
      const inner = res.data ?? res;
      const events = inner.events ?? [];
      const eventCount =
        res.data && typeof res.data.event_count === "number"
          ? res.data.event_count
          : undefined;
      return {
        events,
        next_cursor: inner.next_cursor ?? -1,
        total: inner.total ?? eventCount ?? events.length,
      };
    }),

  // ── Observability: trace summary (Replay page header) ─────
  // Synthesized from the timeline endpoint — the BE doesn't have a
  // dedicated summary route. Returns event_count + types from the
  // timeline steps so the page header has something meaningful
  // without a second paginated read.
  getTraceSummary: async (
    orgId: string,
    traceId: string,
  ): Promise<{
    event_count: number;
    started_at: string;
    ended_at: string;
    duration_ms: number;
    types: Record<string, number>;
  }> => {
    const tl = await fetchApi<{
      trace_id: string;
      steps: Array<{
        start_ms: number;
        end_ms: number;
        event_type: string;
      }>;
    }>(`/orgs/${orgId}/observability/traces/${traceId}/timeline`);
    const types: Record<string, number> = {};
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const step of tl.steps ?? []) {
      types[step.event_type] = (types[step.event_type] ?? 0) + 1;
      if (step.start_ms < start) start = step.start_ms;
      if (step.end_ms > end) end = step.end_ms;
    }
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = 0;
    return {
      event_count: tl.steps?.length ?? 0,
      started_at: new Date(start).toISOString(),
      ended_at: new Date(end).toISOString(),
      duration_ms: Math.max(0, end - start),
      types,
    };
  },

  // ── Observability: retention policy (Phase 7.3b) ─────────────
  // Alias of ``getRetentionPolicy`` — GET /retention-policy already
  // returns the active per-table override list (no query flag).

  listRetentionOverrides: (
    orgId: string,
  ): Promise<Array<{
    policy_id: string;
    tenant_id: string;
    table_name: string;
    hot_days: number;
    warm_days: number;
    cold_days: number;
    delete_days: number;
    pii_scrub_after_days: number | null;
    effective_from: string;
    effective_until: string | null;
    notes: string | null;
  }>> => fetchApi(`/orgs/${orgId}/retention-policy`),

  // ── AI Gateway model registry (Phase 7 A2) ───────────────────
  // CRUD over the per-org ``org_gateway_models`` table. The
  // gateway A1 layer calls ``/resolve`` to look up the upstream
  // provider / model id / decrypted key; this is the admin surface
  // for adding and updating those rows. See
  // ``src/eden/api/routes/gateway_models.py`` for the BE handler.
  // Field names mirror the BE Pydantic models
  // ``GatewayModelOut`` / ``GatewayModelCreate`` /
  // ``GatewayModelUpdate``.
  listGatewayModels: (
    orgId: string,
  ): Promise<Array<{
    model_id: string;
    org_id: string;
    name: string;
    provider: string;
    upstream_model: string;
    upstream_key_prefix: string;
    endpoint: string | null;
    enabled: boolean;
    routing_priority: number;
    metadata: Record<string, unknown>;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }>> => fetchApi(`/orgs/${orgId}/gateway/models`),

  getGatewayModel: (
    orgId: string,
    modelId: string,
  ): Promise<{
    model_id: string;
    org_id: string;
    name: string;
    provider: string;
    upstream_model: string;
    upstream_key_prefix: string;
    endpoint: string | null;
    enabled: boolean;
    routing_priority: number;
    metadata: Record<string, unknown>;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }> => fetchApi(`/orgs/${orgId}/gateway/models/${modelId}`),

  createGatewayModel: (
    orgId: string,
    body: {
      name: string;
      provider: string;
      upstream_model: string;
      upstream_api_key?: string;
      endpoint?: string | null;
      enabled?: boolean;
      routing_priority?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{
    model_id: string;
    org_id: string;
    name: string;
    provider: string;
    upstream_model: string;
    upstream_key_prefix: string;
    endpoint: string | null;
    enabled: boolean;
    routing_priority: number;
    metadata: Record<string, unknown>;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }> => fetchApi(`/orgs/${orgId}/gateway/models`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  updateGatewayModel: (
    orgId: string,
    modelId: string,
    body: Partial<{
      upstream_model: string;
      upstream_api_key: string;
      endpoint: string | null;
      enabled: boolean;
      routing_priority: number;
      metadata: Record<string, unknown>;
    }>,
  ): Promise<{
    model_id: string;
    org_id: string;
    name: string;
    provider: string;
    upstream_model: string;
    upstream_key_prefix: string;
    endpoint: string | null;
    enabled: boolean;
    routing_priority: number;
    metadata: Record<string, unknown>;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }> => fetchApi(`/orgs/${orgId}/gateway/models/${modelId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }),

  deleteGatewayModel: (
    orgId: string,
    modelId: string,
  ): Promise<{ deleted: boolean; model_id: string }> =>
    fetchApi(`/orgs/${orgId}/gateway/models/${modelId}`, {
      method: "DELETE",
    }),

  // ── RBAC: roles (Phase 7.3d) ────────────────────────────────
  // Roles + permissions for the org. The FE ``/settings/roles``
  // page lists roles, reads the per-role permission set, and
  // creates / updates / deletes custom roles. The ``post`` and
  // ``delete`` shims below are kept loose-typed because the
  // request body shape varies per-route.
  listRoles: (
    orgId: string,
  ): Promise<Array<{
    role_id: string;
    name: string;
    description: string;
    is_system: boolean;
    permissions: string[];
    created_at: string;
  }>> => fetchApi(`/orgs/${orgId}/roles`),

  getRole: (
    orgId: string,
    roleId: string,
  ): Promise<{
    role_id: string;
    name: string;
    description: string;
    is_system: boolean;
    permissions: string[];
    created_at: string;
  }> => fetchApi(`/orgs/${orgId}/roles/${roleId}`),

  createRole: (
    orgId: string,
    body: { name: string; description?: string; permissions: string[] },
  ): Promise<{
    role_id: string;
    name: string;
    description: string;
    is_system: boolean;
    permissions: string[];
    created_at: string;
  }> => fetchApi(`/orgs/${orgId}/roles`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  updateRole: (
    orgId: string,
    roleId: string,
    body: Partial<{ name: string; description: string; permissions: string[] }>,
  ): Promise<{
    role_id: string;
    name: string;
    description: string;
    is_system: boolean;
    permissions: string[];
    created_at: string;
  }> => fetchApi(`/orgs/${orgId}/roles/${roleId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }),

  deleteRole: (
    orgId: string,
    roleId: string,
  ): Promise<{ deleted: boolean; role_id: string }> =>
    fetchApi(`/orgs/${orgId}/roles/${roleId}`, { method: "DELETE" }),

  assignRole: (
    orgId: string,
    body: { user_id: string; role_id: string },
  ): Promise<{ user_id: string; role_id: string }> =>
    fetchApi(`/orgs/${orgId}/roles/assign`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  unassignRole: (
    orgId: string,
    body: { user_id: string; role_id: string },
  ): Promise<{ user_id: string; role_id: string }> =>
    fetchApi(`/orgs/${orgId}/roles/unassign`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ── RBAC: permissions catalogue ─────────────────────────────
  listPermissions: (
    orgId: string,
  ): Promise<Array<{
    permission: string;
    category: string;
    description: string;
  }>> => fetchApi(`/orgs/${orgId}/permissions`),

  // ── Billing: payment method (Phase 7.0) ──────────────────────
  getPaymentMethod: (
    orgId: string,
  ): Promise<{
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
  } | null> => fetchApi(`/orgs/${orgId}/billing/payment-method`),

  // ── Observability: list / timeline / heatmap / compare / export ──
  // The list endpoint backs the Trace Table on /observability; the
  // timeline is the per-step view; heatmap is the day×model latency
  // grid; compare is env↔prod diffing; export ships a downloadable
  // blob (json / jsonl / csv).

  listObservabilityTraces: (
    orgId: string,
    params?: {
      realm?: string;
      outcome?: string;
      agent_id?: string;
      /** Exact-match a single trace by id — powers deep links (e.g.
       *  /observability?trace_id=...) without scanning the unfiltered
       *  page for a match. Independent of `days`/`realm`/`agent_id`
       *  on the backend — an older trace still resolves. */
      trace_id?: string;
      days?: number;
      limit?: number;
      /** Offset into the filtered result set (pairs with ``limit`` for
       *  Load-more pagination; BE caps ``limit`` at 500). */
      offset?: number;
    },
  ): Promise<{ traces: ObservabilityTrace[]; total: number }> => {
    const q = new URLSearchParams();
    if (params?.realm) q.set("realm", params.realm);
    if (params?.outcome) q.set("outcome", params.outcome);
    if (params?.agent_id) q.set("agent_id", params.agent_id);
    if (params?.trace_id) q.set("trace_id", params.trace_id);
    if (params?.days !== undefined) q.set("days", String(params.days));
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset != null && params.offset > 0) {
      q.set("offset", String(params.offset));
    }
    const qs = q.toString();
    return fetchApi(`/orgs/${orgId}/observability/traces${qs ? `?${qs}` : ""}`);
  },

  getObservabilitySummary: (
    orgId: string,
    params?: {
      window_hours?: number;
      agent_id?: string;
      /** Also return `previous` — the same aggregates over the
       *  immediately preceding, non-overlapping window of the same
       *  length. Use this for delta badges instead of subtracting
       *  two overlapping windows client-side (wrong for non-additive
       *  metrics like p95/error_rate). */
      compare_previous?: boolean;
    },
  ): Promise<{
    window_hours: number;
    agent_id: string | null;
    total_traces: number;
    error_rate: number;
    p50_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
    total_cost_usd: number;
    eval_coverage_pct?: number;
    top_failure_modes: Array<{
      name: string;
      count: number;
      sample_trace_ids?: string[];
    }>;
    top_tools: Array<{ tool_name: string; name: string; count: number }>;
    hot_paths: Array<{ name: string; count: number; avg_duration_ms: number }>;
    model_breakdown: Array<{ model: string; calls: number; cost_usd: number }>;
    /** Present only when `compare_previous` was requested. */
    previous?: {
      total_traces: number;
      error_rate: number;
      p95_ms: number | null;
      total_cost_usd: number;
    };
  }> => {
    const q = new URLSearchParams();
    if (params?.window_hours !== undefined) {
      q.set("window_hours", String(params.window_hours));
    }
    if (params?.agent_id) q.set("agent_id", params.agent_id);
    if (params?.compare_previous) q.set("compare_previous", "true");
    const qs = q.toString();
    return fetchApi(
      `/orgs/${orgId}/observability/summary${qs ? `?${qs}` : ""}`,
    );
  },

  // N10 — full-text span search (backend: GET .../observability/spans/search).
  searchSpans: (
    orgId: string,
    params?: {
      q?: string;
      agent?: string;
      tool?: string;
      outcome?: string;
      event_type?: string;
      from_ts?: number;
      to_ts?: number;
      per_page?: number;
      page?: number;
    },
  ): Promise<{
    hits: Array<{
      trace_id: string;
      span_id?: string;
      name?: string;
      snippet?: string;
      preview?: string;
      score?: number;
      [key: string]: unknown;
    }>;
    total: number;
    facet_counts?: Record<string, Array<Record<string, unknown>>>;
    took_ms?: number;
    query?: string;
    fallback?: boolean;
  }> => {
    const q = new URLSearchParams();
    if (params?.q) q.set("q", params.q);
    if (params?.agent) q.set("agent", params.agent);
    if (params?.tool) q.set("tool", params.tool);
    if (params?.outcome) q.set("outcome", params.outcome);
    if (params?.event_type) q.set("event_type", params.event_type);
    if (params?.from_ts !== undefined) q.set("from_ts", String(params.from_ts));
    if (params?.to_ts !== undefined) q.set("to_ts", String(params.to_ts));
    if (params?.per_page !== undefined) q.set("per_page", String(params.per_page));
    if (params?.page !== undefined) q.set("page", String(params.page));
    const qs = q.toString();
    return fetchApi(`/orgs/${orgId}/observability/spans/search${qs ? `?${qs}` : ""}`);
  },

  saveSearchAsSignal: (
    orgId: string,
    body: {
      search_query: string;
      trace_ids: string[];
      mode?: "investigator" | "classifier";
    },
  ) =>
    fetchApi<{
      status: string;
      data: {
        signal_id: string;
        saved_search_id: string;
        mode: string;
        trace_count: number;
      };
    }>(`/orgs/${orgId}/search/to-signal`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  previewSearchAsSignal: (
    orgId: string,
    body: {
      search_query: string;
      trace_ids: string[];
      mode?: "investigator" | "classifier";
      backfill_days?: number;
    },
  ) =>
    fetchApi<{
      status: string;
      data: {
        proposed: { name: string; description: string; mode: string };
        trace_count: number;
        estimated_backfill_cost_usd: number;
        backfill_trace_estimate: number;
      };
    }>(`/orgs/${orgId}/search/to-signal/preview`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listTopics: (orgId: string, facet?: string) =>
    fetchApi<{
      status: string;
      topics: Array<{
        id: string;
        facet: string;
        name: string;
        sample_count: number;
        share_pct: number | null;
        representative_trace_ids: string[];
      }>;
      count: number;
    }>(`/orgs/${orgId}/topics${facet ? `?facet=${facet}` : ""}`),

  generateTopics: (orgId: string, facet: string = "task") =>
    fetchApi<{ status: string; data: Record<string, unknown> }>(
      `/orgs/${orgId}/topics/generate`,
      { method: "POST", body: JSON.stringify({ facet }) },
    ),

  actOnTopic: (
    orgId: string,
    topicId: string,
    body: { action: "dataset" | "alert"; name?: string },
  ) =>
    fetchApi<{ status: string; data: Record<string, unknown> }>(
      `/orgs/${orgId}/topics/${topicId}/act`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  agenticMetricsSummary: (orgId: string, windowHours = 24, agentId?: string) => {
    const q = new URLSearchParams({ window_hours: String(windowHours) });
    if (agentId) q.set("agent_id", agentId);
    return fetchApi<{
      status: string;
      data: {
        metrics?: Record<
          string,
          { score: number | null; sample_count: number; source_judge?: string }
        >;
        by_agent?: Array<Record<string, unknown>>;
        trace_count?: number;
      };
    }>(`/orgs/${orgId}/agentic-metrics/summary?${q}`);
  },

  createMcpKey: (orgId: string, name = "MCP", scopes?: string[]) =>
    fetchApi<{ raw_key?: string; id?: string }>(`/orgs/${orgId}/mcp/keys`, {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    }),

  labelToolCall: (
    orgId: string,
    spanId: string,
    body: {
      trace_id: string;
      tool_name: string;
      label: "good" | "bad";
      reason?: string;
      agent_id?: string;
      args_summary?: string;
    },
  ) =>
    fetchApi(`/orgs/${orgId}/tool-calls/${spanId}/label`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  annotateTrace: (
    orgId: string,
    traceId: string,
    payload: { score: number; category: string; comment?: string; time_spent_ms?: number },
  ) =>
    fetchApi<{
      item_id: string;
      annotation_id: string;
      label: unknown;
      confidence: number;
      created_at: string;
    }>(`/orgs/${orgId}/labeling/traces/${traceId}/annotate`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  createTraceShare: (
    orgId: string,
    traceId: string,
    body?: { expiry_days?: number; label?: string; base_url?: string },
  ) =>
    fetchApi<{
      id: string;
      url?: string;
      token?: string;
      expires_at: string | null;
    }>(`/orgs/${orgId}/traces/${traceId}/share`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  listTraceShares: (orgId: string, traceId: string) =>
    fetchApi<{
      shares: Array<{
        id: string;
        trace_id: string;
        label: string | null;
        expires_at: string | null;
        revoked_at: string | null;
        created_at: string;
        active: boolean;
      }>;
    }>(`/orgs/${orgId}/traces/${traceId}/shares`),

  revokeTraceShare: (orgId: string, shareId: string) =>
    fetchApi<{ revoked: boolean }>(`/orgs/${orgId}/shares/${shareId}`, {
      method: "DELETE",
    }),

  getTraceTimeline: (
    orgId: string,
    traceId: string,
  ): Promise<{
    trace_id: string;
    steps: Array<{
      name: string;
      start_ms: number;
      end_ms: number;
      duration_ms: number;
      event_type: string;
      outcome: string | null;
      span_id?: string;
    }>;
    total_duration_ms: number;
    markers: Array<{ at_ms: number; label: string; severity: string }>;
  }> => fetchApi(`/orgs/${orgId}/observability/traces/${traceId}/timeline`),

  getObservabilityHeatmap: (
    orgId: string,
    metric: string,
    params?: { days?: number },
  ): Promise<{
    metric_name: string;
    buckets: Array<{ x: string; y: string; value: number; count: number }>;
    x_labels: string[];
    y_labels: string[];
    min_value: number;
    max_value: number;
  }> => {
    const q = new URLSearchParams();
    if (params?.days) q.set("days", String(params.days));
    const qs = q.toString();
    return fetchApi(
      `/orgs/${orgId}/observability/heatmaps/${encodeURIComponent(metric)}${qs ? `?${qs}` : ""}`,
    );
  },

  compareObservabilityTraces: (
    orgId: string,
    envTraceId: string,
    prodTraceId: string,
  ): Promise<{
    env_trace_id: string;
    prod_trace_id: string;
    overall_score: number;
    dimensions: Array<{
      name: string;
      env_value: unknown;
      prod_value: unknown;
      gap: number;
      severity: string;
      explanation: string;
    }>;
    recommendations: string[];
    metadata: Record<string, unknown>;
  }> =>
    fetchApi(`/orgs/${orgId}/observability/traces/compare`, {
      method: "POST",
      body: JSON.stringify({
        env_trace_id: envTraceId,
        prod_trace_id: prodTraceId,
      }),
    }),

  exportTrace: (
    orgId: string,
    traceId: string,
    format: "json" | "jsonl" | "csv" = "jsonl",
  ): Promise<{ data: string; format: string; trace_id: string }> =>
    fetchApi(
      `/orgs/${orgId}/observability/traces/${traceId}/export`,
      {
        method: "POST",
        body: JSON.stringify({ format_type: format }),
      },
    ),

  // ── Alerts: feed + ack + rules ─────────────────────────────────
  // The org-scoped listAlerts(orgId, params) is used by /alerts and
  // by Dashboard; the parameterless overload returns the global feed
  // for the current user (across all orgs). Both shapes return the
  // same {alerts, total, unread_count} envelope so the consumer
  // can use either.

  listAlerts: (async (orgId: string, params?: { severity?: string; acknowledged?: boolean; limit?: number; offset?: number }): Promise<{
    alerts: Array<{
      alert_id: string;
      severity: string;
      title: string;
      description: string;
      source: string;
      entity_id: string;
      triggered_at: string;
      acknowledged: boolean;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
      channels: string[];
      metadata: Record<string, unknown>;
    }>;
    total: number;
    unread_count: number;
  }> => {
    const q = new URLSearchParams();
    if (params?.severity) q.set("severity", params.severity);
    if (params?.acknowledged !== undefined) q.set("acknowledged", String(params.acknowledged));
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    const qs = q.toString();
    const data = await fetchApi<{
      alerts: Array<{
        alert_id: string;
        severity: string;
        title: string;
        message: string;
        entity_id: string;
        acknowledged: boolean;
        acknowledged_at: string | null;
        created_at: string;
        channels: string[];
        metadata: Record<string, unknown>;
      }>;
      total: number;
      unread_count: number;
    }>(`/orgs/${orgId}/alerts${qs ? `?${qs}` : ""}`);

    return {
      alerts: data.alerts.map((a) => ({
        alert_id: a.alert_id,
        severity: a.severity,
        title: a.title,
        description: a.message,
        source: a.entity_id || "alert",
        entity_id: a.entity_id ?? "",
        triggered_at: a.created_at,
        acknowledged: a.acknowledged,
        acknowledged_at: a.acknowledged_at,
        acknowledged_by: null,
        channels: a.channels ?? [],
        metadata: a.metadata ?? {},
      })),
      total: data.total,
      unread_count: data.unread_count,
    };
  }),

  acknowledgeAlert: (orgId: string, alertId: string) =>
    fetchApi<{ alert_id: string; acknowledged: boolean }>(
      `/orgs/${orgId}/alerts/${alertId}/acknowledge`,
      { method: "POST" },
    ),

  acknowledgeAlertsBatch: (orgId: string, alertIds: string[]) =>
    fetchApi<{ acknowledged_count: number; alert_ids: string[] }>(
      `/orgs/${orgId}/alerts/acknowledge-batch`,
      {
        method: "POST",
        body: JSON.stringify({ alert_ids: alertIds }),
      },
    ),

  getAlertRules: (orgId: string) =>
    fetchApi<{
      rules: Array<{
        rule_id: string;
        name: string;
        description: string;
        event_types: string[];
        severity_threshold: string;
        channels: string[];
        enabled: boolean;
      }>;
    }>(`/orgs/${orgId}/alerts/rules`),

  compileNlAlert: (
    orgId: string,
    data: { nl_text: string; context?: Record<string, unknown>; eql_override?: string },
  ) =>
    fetchApi<{
      eql: string;
      warnings: string[];
      rule: Record<string, unknown>;
      suggested_name: string;
    }>(`/orgs/${orgId}/alerts/compile`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  listNlAlertRules: (orgId: string) =>
    fetchApi<{
      rules: Array<{
        id: string;
        name: string;
        nl_text: string;
        compiled_eql: string;
        triage_enabled: boolean;
        channels: Record<string, unknown>;
        enabled: boolean;
        last_fired_at: string | null;
        created_at: string;
      }>;
      total: number;
    }>(`/orgs/${orgId}/nl-alert-rules`),

  listAlertEvents: (
    orgId: string,
    params?: { verdict?: string; limit?: number; offset?: number },
  ) => {
    const q = new URLSearchParams();
    if (params?.verdict) q.set("verdict", params.verdict);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    const qs = q.toString();
    return fetchApi<{
      events: Array<{
        id: string;
        title: string;
        severity: string;
        triage_verdict: string | null;
        triage_reason: string | null;
        triage_confidence: number | null;
        incident_id: string | null;
        acknowledged: boolean;
        created_at: string;
        payload: Record<string, unknown>;
      }>;
      total: number;
    }>(`/orgs/${orgId}/alert-events${qs ? `?${qs}` : ""}`);
  },

  overrideAlertVerdict: (orgId: string, alertId: string, verdict: string) =>
    fetchApi<{ status: string; human_verdict: string }>(
      `/orgs/${orgId}/alerts/${alertId}/override`,
      { method: "POST", body: JSON.stringify({ verdict }) },
    ),

  // ── Insights overview (detector rollup; matches BE OverviewResponse) ──
  getInsightsOverview: (orgId: string) =>
    fetchApi<InsightsOverviewResponse>(`/orgs/${orgId}/insights/overview`),

  runDetectors: (orgId: string, body?: RunDetectorsRequest) =>
    fetchApi<InsightResponse[]>(`/orgs/${orgId}/insights/detectors/run`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  // ── Optimization overview (cost dashboard tile) ────────────────
  getOptimizationOverview: (orgId: string, days: number) =>
    fetchApi<{
      costs: {
        total_cost_cents: number;
        prompt_cost_cents: number;
        completion_cost_cents: number;
        cache_savings_cents: number;
        token_total: number;
      };
      efficiency: {
        cache_hit_rate: number;
        avg_cost_per_request_cents: number;
        p50_latency_ms: number;
        p95_latency_ms: number;
      };
      forecast: {
        next_7d_cost_cents: number;
        next_30d_cost_cents: number;
      };
    }>(`/orgs/${orgId}/optimization/overview?days=${days}`),

  // ── Cost comparison (this month vs last month) ───────────────────
  // Cat 23 audit (2026-06-21): the dashboard "last-month trend"
  // tile used to render "—" forever because no endpoint existed.
  // Returns { previous_month_cents, current_month_cents, delta_cents,
  // delta_pct } — both cents fields can be null when Redis has no
  // recorded spend for that month yet.
  getCostComparison: (orgId: string) =>
    fetchApi<{
      org_id: string;
      current_month: string;
      previous_month: string;
      current_month_cents: number | null;
      previous_month_cents: number | null;
      delta_cents: number | null;
      delta_pct: number | null;
    }>(`/orgs/${orgId}/cost/comparison`),

  // ── Budget admin (D.10 cost guardrails) ────────────────────────
  // Distinct from `getOptimizationBudget` above — this is the
  // per-org enforcement config + rollup shown on /optimization/budget,
  // not the 30d optimization-total burn-rate summary.
  getBudget: (orgId: string) =>
    fetchApi<{
      data: {
        budget: {
          window: string;
          cost_soft_limit_usd: number;
          cost_hard_limit_usd: number;
          enforcement_enabled: boolean;
          action_on_exceed: string;
          threshold_alert_pct: number;
          source: string;
        };
        consumption: { window: string; cost_usd: number; requests_count: number; window_start?: string };
        rollup: {
          cost_used_usd: number;
          cost_soft_limit_usd: number;
          cost_hard_limit_usd: number;
          pct_of_hard: number;
          threshold_alert_pct: number;
          alert_breached: boolean;
          exceeded: boolean;
        };
      };
    }>(`/orgs/${orgId}/budget`),

  upsertBudget: (
    orgId: string,
    body: {
      cost_soft_limit_usd: number;
      cost_hard_limit_usd: number;
      enforcement_enabled: boolean;
      window: string;
      action_on_exceed: string;
      threshold_alert_pct: number;
    },
  ) =>
    fetchApi<{ data: unknown }>(`/orgs/${orgId}/budget`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getBudgetActions: (orgId: string, limit = 20) =>
    fetchApi<{
      data: {
        actions: Array<{
          id: string;
          action_type: string;
          severity: string;
          cost_at_action: number;
          threshold_pct: number;
          action_taken: string;
          created_at: string;
        }>;
        count: number;
      };
    }>(`/orgs/${orgId}/budget/actions?limit=${limit}`),

  // ── Customer FinOps (SOTA W8 / F60) ────────────────────────────
  finopsExplorer: (orgId: string, windowHours = 24) =>
    fetchApi<{
      data: {
        total_cost_usd: number;
        previous_cost_usd: number;
        delta_usd: number;
        delta_pct: number | null;
        by_feature: Array<{ key?: string; cost_usd: number; events: number; tokens: number }>;
        by_model: Array<{ key?: string; cost_usd: number; events: number; tokens: number }>;
        by_agent: Array<{ key?: string; cost_usd: number; events: number; tokens: number }>;
        by_session: Array<{ key?: string; cost_usd: number; events: number; tokens: number }>;
        by_day: Array<{ day?: string; cost_usd: number; events: number; tokens: number }>;
        untagged_events: number;
        cache_savings_usd: number;
        window_hours: number;
      };
    }>(`/orgs/${orgId}/finops/explorer?window_hours=${windowHours}`),

  gatewayOverview: (orgId: string, windowHours = 24) =>
    fetchApi<{
      status: string;
      data: {
        total_cost_usd: number;
        previous_cost_usd: number;
        delta_usd: number;
        delta_pct: number | null;
        by_feature: Array<{ key?: string; cost_usd: number; events: number; tokens: number }>;
        by_model: Array<{ key?: string; cost_usd: number; events: number; tokens: number }>;
        by_agent: Array<{ key?: string; cost_usd: number; events: number; tokens: number }>;
        by_day: Array<{
          day?: string;
          cost_usd: number;
          events: number;
          tokens: number;
          input_tokens?: number;
          output_tokens?: number;
        }>;
        untagged_events: number;
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        events: number;
        cache_savings_usd: number;
        window_hours: number;
        models: Array<{
          model_id: string;
          name: string;
          provider: string;
          upstream_model: string;
          enabled: boolean;
          routing_priority: number;
        }>;
        cache: {
          hits?: number;
          misses?: number;
          hit_rate?: number;
          l1_hits?: number;
          l1_misses?: number;
          l2_hits?: number;
          l2_misses?: number;
          l1_hit_rate?: number;
          l2_hit_rate?: number;
        } | null;
        providers: Array<{
          provider: string;
          healthy: boolean;
          avg_latency_ms?: number;
          error_rate?: number;
        }>;
      };
    }>(`/orgs/${orgId}/gateway/overview?window_hours=${windowHours}`),

  finopsKillSwitches: (orgId: string) =>
    fetchApi<{
      data: {
        matrix: Array<{ feature_key: string; enabled: boolean; source: string }>;
        keys: string[];
      };
    }>(`/orgs/${orgId}/finops/kill-switches`),

  setFinopsKillSwitch: (orgId: string, body: { feature_key: string; enabled: boolean }) =>
    fetchApi<{
      status: string;
      error?: string;
      detail?: string;
      data?: { feature_key: string; enabled: boolean };
    }>(`/orgs/${orgId}/finops/kill-switches`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ── N22 autonomy policy (W24) ─────────────────────────────────
  getAutonomyPolicy: (orgId: string, agentId?: string) => {
    const q = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
    return fetchApi<{
      data: AutonomyPolicy;
    }>(`/orgs/${orgId}/settings/autonomy${q}`);
  },

  patchAutonomyPolicy: (
    orgId: string,
    body: Partial<AutonomyPolicyPatch>,
    agentId?: string,
  ) => {
    const q = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
    return fetchApi<{ data: AutonomyPolicy }>(`/orgs/${orgId}/settings/autonomy${q}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  getAutonomyAudit: (orgId: string, limit = 50) =>
    fetchApi<{
      data: {
        entries: AutonomyAuditEntry[];
        count: number;
      };
    }>(`/orgs/${orgId}/settings/autonomy/audit?limit=${limit}`),

  // ── Webhook dead-letter queue (D.13) ───────────────────────────
  listWebhookDlq: (orgId: string, limit = 50) =>
    fetchApi<{
      data: {
        entries: Array<{
          id: string;
          webhook_id: string;
          event_type: string;
          last_response_status: number | null;
          last_error: string | null;
          attempt_count: number;
          max_attempts: number;
          replay_count: number;
          last_replayed_at: string | null;
          created_at: string;
          signature_v1: string | null;
        }>;
        count: number;
      };
    }>(`/orgs/${orgId}/webhooks/dlq?limit=${limit}`),

  replayWebhookDlq: (orgId: string, dlqId: string) =>
    fetchApi<{ data: unknown }>(`/orgs/${orgId}/webhooks/dlq/${dlqId}/replay`, {
      method: "POST",
    }),

  // ── LLM Ops: model artifacts (Phase 7.1c) ──────────────────────
  listModelArtifacts: (
    orgId: string,
    params?: { model_family?: string; limit?: number },
  ) => {
    const q = new URLSearchParams();
    if (params?.model_family) q.set("model_family", params.model_family);
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return fetchApi<{
      artifacts: Array<{
        artifact_id: string;
        model_family: string;
        model_version: string;
        provider: string;
        artifact_type: string;
        created_at: string;
      }>;
    }>(`/orgs/${orgId}/llmops/artifacts${qs ? `?${qs}` : ""}`);
  },

  getModelArtifact: (orgId: string, artifactId: string) =>
    fetchApi<{
      artifact: {
        artifact_id: string;
        model_family: string;
        model_version: string;
        provider: string;
        artifact_type: string;
        created_at: string;
        is_deployed?: boolean;
        config: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
      evaluations?: Array<{
        evaluation_id: string;
        benchmark_suite_id: string;
        pass_rate: number;
        avg_latency_ms: number;
        cost_per_1k_tokens: number;
      }>;
    }>(`/orgs/${orgId}/llmops/artifacts/${artifactId}`),

  // ── LLM Ops: prompts registry + canary render ─────────────────
  listPrompts: (orgId: string) =>
    fetchApi<{
      prompts: Array<{
        prompt_id: string;
        prompt_name: string;
        version: string;
        agent_scope: string;
        template_text: string;
        is_default: boolean;
        variables: string[];
        created_at: string;
      }>;
    }>(`/orgs/${orgId}/llmops/prompts`),

  renderPrompt: (orgId: string, promptId: string, variables: Record<string, unknown>) =>
    fetchApi<{
      rendered: string;
      prompt_id: string;
      version: string;
      used_variables: string[];
    }>(`/orgs/${orgId}/llmops/prompts/${promptId}/render`, {
      method: "POST",
      body: JSON.stringify({ variables }),
    }),

  // ── LLM Ops: experiments (Cat 12) ─────────────────────────────
  listExperiments: (orgId: string) =>
    fetchApi<{
      experiments: Array<{
        experiment_id: string;
        experiment_name: string;
        experiment_type: string;
        status: string;
        pipeline_version: string;
        git_commit: string;
        created_at: string;
        winning_variant_id: string | null;
      }>;
    }>(`/orgs/${orgId}/llmops/experiments`),

  getExperiment: (orgId: string, experimentId: string) =>
    fetchApi<{
      experiment: {
        experiment_id: string;
        experiment_name: string;
        experiment_type: string;
        status: string;
        pipeline_version: string;
        git_commit: string;
        created_at: string;
      };
      runs: Array<{
        run_id: string;
        created_at: string;
        metrics: Record<string, unknown>;
        artifacts: Record<string, unknown>;
      }>;
      comparison: Record<string, unknown> | null;
    }>(`/orgs/${orgId}/llmops/experiments/${experimentId}`),

  // ── LLM Ops: A/B tests (Cat 12 traffic splitter) ──────────────
  listABTests: (orgId: string) =>
    fetchApi<{
      tests: Array<{
        test_id: string;
        prompt_name: string;
        variant_a_id: string;
        variant_b_id: string;
        traffic_split: number;
        success_metric: string;
        winner_prompt_id: string | null;
        start_date: string | null;
        status: string;
      }>;
    }>(`/orgs/${orgId}/llmops/ab-tests`),

  // ── LLM Ops: AI Gateway health + metrics ──────────────────────
  gatewayHealth: (orgId: string) =>
    fetchApi<{
      overall: string;
      providers: Array<{
        provider: string;
        healthy: boolean;
        avg_latency_ms: number;
        p95_latency_ms: number;
        error_rate: number;
      }>;
      last_check: string;
    }>(`/orgs/${orgId}/llmops/gateway/health`),

  gatewayMetrics: (orgId: string, limit: number) =>
    fetchApi<{
      metrics: Array<{
        provider: string;
        model: string;
        latency_ms: number;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        cached: boolean;
        ts: string;
      }>;
    }>(`/orgs/${orgId}/llmops/gateway/metrics?limit=${limit}`),

  // ── LLM Ops: monitoring (Cat 13/22 surfaces) ──────────────────
  getOverallHealth: (orgId: string) =>
    fetchApi<{
      overall_score: number;
      active_alert_count: number;
      model_count: number;
      trend: "improving" | "degrading" | "stable";
      last_check: string;
    }>(`/orgs/${orgId}/llmops/monitoring/health`),

  listMonitoringAlerts: (
    orgId: string,
    params?: { severity?: string; model_family?: string; limit?: number },
  ) => {
    const q = new URLSearchParams();
    if (params?.severity) q.set("severity", params.severity);
    if (params?.model_family) q.set("model_family", params.model_family);
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return fetchApi<{
      alerts: Array<{
        alert_id: string;
        alert_type: string;
        severity: string;
        model_family: string;
        triggered_at: string;
        acknowledged: boolean;
        message: string;
      }>;
    }>(`/orgs/${orgId}/llmops/monitoring/alerts${qs ? `?${qs}` : ""}`);
  },

  acknowledgeMonitoringAlert: (orgId: string, alertId: string) =>
    fetchApi<{ alert_id: string; acknowledged: boolean }>(
      `/orgs/${orgId}/llmops/monitoring/alerts/${alertId}/acknowledge`,
      { method: "POST" },
    ),

  // ── LLM Ops: semantic cache ───────────────────────────────────
  cacheStats: (orgId: string) =>
    fetchApi<{
      total_queries: number;
      hits: number;
      misses: number;
      hit_rate: number;
      avg_lookup_ms: number;
      size_bytes: number;
    }>(`/orgs/${orgId}/llmops/cache/stats`),

  cacheGet: (orgId: string, query: string, modelVersion: string) =>
    fetchApi<{
      hit: boolean;
      response: string | null;
      similarity: number | null;
      cached_at: string | null;
    }>(
      `/orgs/${orgId}/llmops/cache/get?query=${encodeURIComponent(query)}&model_version=${encodeURIComponent(modelVersion)}`,
      { method: "POST" },
    ),

  cacheInvalidate: (orgId: string, pattern: string) =>
    fetchApi<{ invalidated: number }>(`/orgs/${orgId}/llmops/cache/invalidate`, {
      method: "POST",
      body: JSON.stringify({ pattern }),
    }),

  // Sandbox client removed 2026-07-04 — sandbox subsystem retired on
  // the backend. Sandbox navigation entries were removed from
  // sidebar-config.ts, breadcrumbs.ts, and command-palette.tsx.
};

// Phase 2: the environment-generation pipeline (Planner→Critic→…→Archivist)
// was retired. The Eden Agent CLI's `/eden-sim` is the replacement for
// sim/test generation. All env-gen surfaces (interview/spec/submit/listJobs
// and the v1 environments endpoint) were removed in June 2026 cleanup; the
// replay page reads from the observability trace stream.

// F41-4: ``aiInsightsChat`` (streaming AI Insights chat turn,
// bypassing fetchApi() via a hand-rolled fetch()) was dead code — zero
// callers anywhere in src/app, src/components, or src/hooks. Deleted
// rather than fixed; see the agent page's own chat stream (now routed
// through fetchApi's ``raw`` mode) for the live equivalent.

// ── Shared observability types ────────────────────────────────────
// These types back the Trace list/tree/timeline/heatmap views in
// /observability. The BE Pydantic models in
// ``src/eden/observability/trace_models.py`` are the source of truth;
// the FE shapes mirror what the BE actually returns (loose for
// nested span objects, strict for scalar fields the UI binds to).

export type ObservabilityStreamingMetrics = {
  ttft_ms?: number | null;
  itl_ms_avg?: number | null;
  tpot_ms?: number | null;
  stream_completed?: boolean | null;
  total_chunks?: number | null;
};

export type ObservabilityTrace = {
  trace_id: string;
  tenant_id: string;
  realm: string;
  outcome: string | null;
  span_count: number;
  duration_ms: number | null;
  agent_id?: string | null;
  started_at?: string | null;
  model?: string | null;
  provider?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_cents?: number | null;
  error?: string | null;
  streaming_metrics?: ObservabilityStreamingMetrics | null;
  /** Free-form tags the BE attaches (e.g. ``mcp:server``, ``facet:retrieval``). */
  tags?: string[] | null;
  /** N12 — explicit session id when present on span attributes. */
  session_id?: string | null;
  agent_session_id?: string | null;
};

// ── Agents registry ─────────────────────────────────────────────

export type AgentSummary = {
  agent_id: string;
  name: string;
  framework: string | null;
  repo_url: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export const agentsApi = {
  list: (orgId: string, params?: { framework?: string; name?: string; limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params?.framework) search.set("framework", params.framework);
    if (params?.name) search.set("name", params.name);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.offset != null) search.set("offset", String(params.offset));
    const qs = search.toString();
    return fetchApi<{ agents: AgentSummary[]; total: number }>(
      `/orgs/${orgId}/agents${qs ? `?${qs}` : ""}`
    );
  },
  get: (orgId: string, agentId: string) =>
    fetchApi<AgentSummary>(
      `/orgs/${orgId}/agents/${encodeURIComponent(agentId)}`
    ),
  register: (
    orgId: string,
    body: { name: string; framework?: string; repo_url?: string; agent_id?: string }
  ) =>
    fetchApi<{ agent: AgentSummary; created: boolean }>(
      `/orgs/${orgId}/agents/register`,
      { method: "POST", body: JSON.stringify(body) }
    ),
};

/** N22 autonomy policy envelope (Settings → Autonomous). */
export type AutonomyPolicy = {
  org_id: string;
  agent_id?: string | null;
  maintenance_mode: "autonomous" | "assisted" | "observe";
  auto_runtime_heal: boolean;
  auto_code_patch_pr: boolean;
  auto_code_patch_merge: boolean;
  auto_prompt_canary: boolean;
  auto_nudge_promote: boolean;
  auto_guardrail_promote: boolean;
  daily_maintenance_budget_usd: number;
  max_auto_rollbacks_per_day: number;
  compliance_profile: "standard" | "hipaa" | "soc2_strict";
  effective_mode?: string;
  budget?: {
    spent_usd: number;
    limit_usd: number;
    within_budget: boolean;
  };
};

export type AutonomyPolicyPatch = {
  maintenance_mode?: AutonomyPolicy["maintenance_mode"];
  auto_runtime_heal?: boolean;
  auto_code_patch_pr?: boolean;
  auto_code_patch_merge?: boolean;
  auto_prompt_canary?: boolean;
  auto_nudge_promote?: boolean;
  auto_guardrail_promote?: boolean;
  daily_maintenance_budget_usd?: number;
  max_auto_rollbacks_per_day?: number;
  compliance_profile?: AutonomyPolicy["compliance_profile"];
};

export type AutonomyAuditEntry = {
  id: string;
  org_id: string;
  agent_id?: string | null;
  action: string;
  tier_applied: string;
  decision: string;
  reason?: string | null;
  created_at?: string;
};

export type ImproveQueueItem = {
  ref: string;
  item_type: string;
  title: string;
  column: string;
  severity: string;
  agent_id?: string | null;
  status: string;
  href?: string | null;
  payload?: Record<string, unknown>;
  autonomy_tier_required?: string | null;
  blocked_reason?: string | null;
  source?: string;
};

export type ImproveQueueData = {
  items: ImproveQueueItem[];
  refreshed_at: string;
  counts_by_column: Record<string, number>;
  counts_by_type: Record<string, number>;
  count: number;
};
// ── N23 Improvement Plans + Runs ────────────────────────────────────

export type ImprovementPlanKind =
  | "code_patch"
  | "prompt_update"
  | "nudge_promote"
  | "guardrail_tune"
  | "config_change";

export type ImprovementPlanStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "pr_opened"
  | "merged"
  | "rejected"
  | "snoozed"
  | "superseded";

export type ImprovementPlan = {
  id: string;
  org_id: string;
  run_id?: string | null;
  agent_id?: string | null;
  plan_kind: ImprovementPlanKind;
  status: ImprovementPlanStatus;
  title: string;
  summary?: string | null;
  source_ref?: string | null;
  source_fingerprint?: string | null;
  diff_unified?: string | null;
  diff_edited?: boolean;
  files_changed?: Array<{ path: string; size?: number }>;
  evidence?: Record<string, unknown>;
  triage_snapshot?: Record<string, unknown> | null;
  estimated_blast_radius?: string | null;
  llm_cost_usd?: number;
  pr_url?: string | null;
  pr_number?: number | null;
  github_branch?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  rejection_reason?: string | null;
  snoozed_until?: string | null;
  created_at: string;
  updated_at: string;
};

type ImproveFeatureEnvelope<T> = {
  status: string;
  feature: string;
  live?: boolean;
  data: T;
};

export const improvePlansApi = {
  listPlans: (orgId: string, query?: string) =>
    fetchApi<ImproveFeatureEnvelope<{ plans: ImprovementPlan[]; count: number }>>(
      `/orgs/${orgId}/improve/plans${query ? `?${query}` : ""}`,
    ),
  getPlan: (orgId: string, planId: string) =>
    fetchApi<ImproveFeatureEnvelope<{ plan: ImprovementPlan }>>(
      `/orgs/${orgId}/improve/plans/${planId}`,
    ),
  patchPlan: (
    orgId: string,
    planId: string,
    body: { diff_unified?: string; title?: string; summary?: string },
  ) =>
    fetchApi<ImproveFeatureEnvelope<{ plan: ImprovementPlan }>>(
      `/orgs/${orgId}/improve/plans/${planId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  approvePlan: (orgId: string, planId: string) =>
    fetchApi<
      ImproveFeatureEnvelope<{
        plan_id: string;
        status: string;
        message?: string;
        pr_url?: string;
        pr_number?: number;
        branch?: string;
        verify_job_id?: string;
      }>
    >(`/orgs/${orgId}/improve/plans/${planId}/approve`, { method: "POST" }),
  rejectPlan: (orgId: string, planId: string, reason?: string) =>
    fetchApi<ImproveFeatureEnvelope<{ plan: ImprovementPlan }>>(
      `/orgs/${orgId}/improve/plans/${planId}/reject`,
      { method: "POST", body: JSON.stringify({ reason: reason ?? "" }) },
    ),
  snoozePlan: (orgId: string, planId: string, snoozedUntil: string) =>
    fetchApi<ImproveFeatureEnvelope<{ plan: ImprovementPlan }>>(
      `/orgs/${orgId}/improve/plans/${planId}/snooze`,
      { method: "POST", body: JSON.stringify({ snoozed_until: snoozedUntil }) },
    ),
};
(api as unknown as Record<string, unknown>).improvePlansApi = improvePlansApi;

// ── Intelligence: Time-Travel (Cat 20) ──────────────────────────────
// Backend: src/eden/api/routes/intelligence_time_travel.py
// Fork/replay return Cat 20 envelopes; record returns a flat snapshot payload.
export type TimeTravelEnvelope<T> = {
  status: string;
  feature: string;
  live: boolean;
  message?: string;
  data: T | null;
};

export type TimeTravelForkData = {
  fork_id: string;
  parent_trace_id: string;
  parent_fork_id: string | null;
  fork_at_step: number;
  name: string;
  n_parent_steps: number;
  has_cacheable_steps: boolean;
  edits_applied: string[];
};

export type TimeTravelReplayData = {
  replay_id: string;
  fork_id: string;
  served_from_cache: number[];
  re_executed: number[];
  cache_miss_warnings: number[];
  tokens_saved: number;
  cost_saved_usd: number;
  duration_ms: number;
  n_steps: number;
  n_served_from_cache: number;
  n_re_executed: number;
  new_outcome: string;
};

export type TimeTravelRecordResult = {
  snapshot_id: string;
  trace_id: string;
  label: string | null;
  created_at: string;
  status: string;
  live: boolean;
};

export const timeTravelApi = {
  record: (
    orgId: string,
    data: {
      trace_id: string;
      label?: string;
      parent_fork_id?: string | null;
      edits?: Record<string, unknown>;
    },
  ) =>
    fetchApi<TimeTravelRecordResult>(
      `/orgs/${orgId}/intelligence/time-travel/record`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  fork: (
    orgId: string,
    data: {
      parent_trace_id: string;
      fork_at_step: number;
      name: string;
      parent_fork_id?: string | null;
      edits?: Record<string, unknown>;
    },
  ) =>
    fetchApi<TimeTravelEnvelope<TimeTravelForkData>>(
      `/orgs/${orgId}/intelligence/time-travel/fork`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  replay: (
    orgId: string,
    data: { fork_id: string; edits?: Record<string, unknown> },
  ) =>
    fetchApi<TimeTravelEnvelope<TimeTravelReplayData>>(
      `/orgs/${orgId}/intelligence/time-travel/replay`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  listForks: (orgId: string, parentTraceId: string) =>
    fetchApi<
      TimeTravelEnvelope<{
        forks: Array<Record<string, unknown>>;
        n_forks: number;
      }>
    >(
      `/orgs/${orgId}/intelligence/time-travel/forks?parent_trace_id=${encodeURIComponent(parentTraceId)}`,
    ),
  diff: (orgId: string, forkId: string, replayId: string) =>
    fetchApi<TimeTravelEnvelope<Record<string, unknown>>>(
      `/orgs/${orgId}/intelligence/time-travel/diff/${encodeURIComponent(forkId)}/${encodeURIComponent(replayId)}`,
    ),
};
(api as unknown as Record<string, unknown>).timeTravelApi = timeTravelApi;

// ─── Onboarding wizard (June 2026) ────────────────────────────────

export interface GitHubInstallation {
  installation_id: number;
  account_login: string;
  account_type: string;
  installed_at: string;
  suspended: boolean;
}

export interface GitHubRepo {
  full_name: string;
  name: string;
  owner: string;
  default_branch: string;
  private: boolean;
  description: string;
  html_url: string;
  installation_id: number;
}

export const githubApi = {
  configured: () =>
    fetchApi<{
      configured: boolean;
      app_slug: string | null;
      contents_permission?: string | null;
      can_open_prs?: boolean;
    }>(`/integrations/github/configured`),
  authorize: (orgId: string) =>
    fetchApi<{ install_url: string; state: string }>(
      `/integrations/github/authorize`,
      { method: "GET", headers: { "X-Org-Id": orgId } },
    ),
  claimInstallation: (orgId: string, installationId: number) =>
    fetchApi<GitHubInstallation>(
      // Query fallback: empty/malformed JSON bodies used to 422 at FastAPI
      // validation before the handler ran. Body remains the primary shape.
      `/orgs/${orgId}/github/installations/claim?installation_id=${encodeURIComponent(String(installationId))}`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId },
        body: JSON.stringify({ installation_id: installationId }),
        noDedup: true,
      },
    ),
  listInstallations: (orgId: string) =>
    fetchApi<GitHubInstallation[]>(
      `/orgs/${orgId}/github/installations`,
      { headers: { "X-Org-Id": orgId } },
    ),
  /** Active repo Eden opens Improve fix-PRs against for this agent (or null). */
  getConnection: (orgId: string, agentId?: string | null) => {
    const q = new URLSearchParams();
    if (agentId) q.set("agent_id", agentId);
    const suffix = q.toString() ? `?${q}` : "";
    return fetchApi<{
      id: string;
      org_id: string;
      provider: string;
      installation_id: string;
      repo_full_name: string;
      default_branch: string;
      status: string;
      agent_id?: string | null;
    } | null>(`/orgs/${orgId}/github/connection${suffix}`, {
      headers: { "X-Org-Id": orgId },
    });
  },
  listRepos: (orgId: string) =>
    fetchApi<GitHubRepo[]>(
      `/orgs/${orgId}/github/repos`,
      { headers: { "X-Org-Id": orgId } },
    ),
  connectRepo: (
    orgId: string,
    body: {
      installation_id: number;
      repo_full_name: string;
      default_branch?: string;
      agent_id?: string | null;
    },
  ) =>
    fetchApi<{
      id: string;
      org_id: string;
      provider: string;
      installation_id: string;
      repo_full_name: string;
      default_branch: string;
      status: string;
      agent_id?: string | null;
    }>(`/orgs/${orgId}/github/repos/connect`, {
      method: "POST",
      headers: { "X-Org-Id": orgId },
      body: JSON.stringify(body),
    }),
};
(api as unknown as Record<string, unknown>).githubApi = githubApi;
// ── Soft Autonomy Phase 5/6: Slack App ──────────────────────────────
// Bot install (OAuth) + per-agent channel routing for issue / PR /
// needs-approval alerts. Approve is always a portal deep link, never
// an in-Slack action.
export interface SlackInstall {
  team_id: string;
  team_name: string;
  bot_user_id: string;
  installed_at: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
}

export interface SlackRoute {
  agent_id: string | null;
  channel_id: string;
  channel_name: string;
}

export const slackApi = {
  configured: () =>
    fetchApi<{ configured: boolean; dev_bot_token: boolean }>(
      `/integrations/slack/configured`,
    ),
  authorize: (orgId: string) =>
    fetchApi<{ authorize_url: string; state: string }>(
      `/integrations/slack/authorize`,
      { method: "GET", headers: { "X-Org-Id": orgId } },
    ),
  install: (orgId: string) =>
    fetchApi<SlackInstall | null>(`/orgs/${orgId}/slack/install`, {
      headers: { "X-Org-Id": orgId },
    }),
  disconnect: (orgId: string) =>
    fetchApi<{ status: string }>(`/orgs/${orgId}/slack/install`, {
      method: "DELETE",
      headers: { "X-Org-Id": orgId },
    }),
  channels: (orgId: string) =>
    fetchApi<SlackChannel[]>(`/orgs/${orgId}/slack/channels`, {
      headers: { "X-Org-Id": orgId },
    }),
  routes: (orgId: string) =>
    fetchApi<SlackRoute[]>(`/orgs/${orgId}/slack/routes`, {
      headers: { "X-Org-Id": orgId },
    }),
  setRoute: (
    orgId: string,
    body: { agent_id: string | null; channel_id: string; channel_name?: string },
  ) =>
    fetchApi<SlackRoute>(`/orgs/${orgId}/slack/routes`, {
      method: "PUT",
      headers: { "X-Org-Id": orgId },
      body: JSON.stringify(body),
    }),
  clearRoute: (orgId: string, agentId: string | null) =>
    fetchApi<{ status: string }>(`/orgs/${orgId}/slack/routes`, {
      method: "DELETE",
      headers: { "X-Org-Id": orgId },
      body: JSON.stringify({ agent_id: agentId }),
    }),
  sendTest: (orgId: string, agentId: string | null) =>
    fetchApi<{ status: string; ts?: string }>(`/orgs/${orgId}/slack/test`, {
      method: "POST",
      headers: { "X-Org-Id": orgId },
      body: JSON.stringify({ agent_id: agentId }),
    }),
};
(api as unknown as Record<string, unknown>).slackApi = slackApi;

// ── Labeling (Phase D) ────────────────────────────────────────────────

export interface LabelingItem {
  id: string;
  prompt: string;
  context?: string;
  tags: string[];
  source: string;
  created_at: string;
  annotations_count: number;
}

export interface LabelingAnnotation {
  id: string;
  item_id: string;
  label: string;
  confidence: number;
  notes?: string;
  annotator_id: string;
  created_at: string;
}

const labelingApi = {
  listItems: (orgId: string) =>
    fetchApi<{ items: LabelingItem[]; total: number }>(
      `/orgs/${orgId}/labeling/items`,
      { headers: { "X-Org-Id": orgId } },
    ),
  annotate: (orgId: string, body: { item_id: string; label: string; notes?: string }) =>
    fetchApi<LabelingAnnotation>(`/orgs/${orgId}/labeling/annotate`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  skip: (orgId: string, body: { item_id: string; reason?: string }) =>
    fetchApi<{ skipped: boolean }>(`/orgs/${orgId}/labeling/skip`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  seedItem: (orgId: string, body: { prompt: string; tags?: string[] }) =>
    fetchApi<LabelingItem>(`/orgs/${orgId}/labeling/items`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
};

// ── Signals (Phase Q / F48) ──────────────────────────────────────────

export interface CompiledRule {
  metric: string;
  op: string;
  threshold: number;
  window_hours: number;
  scope: Record<string, string>;
  keywords: string[];
}

export interface Signal {
  id: string;
  org_id?: string;
  description: string;
  rule: CompiledRule;
  enabled: boolean;
  cluster_id?: string | null;
  created_by?: string | null;
  match_count?: number;
  created_at: string;
  updated_at?: string;
}

const signalsApi = {
  list: (orgId: string) =>
    fetchApi<{ signals: Signal[] }>(`/orgs/${orgId}/signals`, {
      headers: { "X-Org-Id": orgId },
    }),
  create: (orgId: string, body: { description: string; enabled?: boolean }) =>
    fetchApi<Signal>(`/orgs/${orgId}/signals`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  seedDefaults: (orgId: string, profile: "minimal" | "standard" | "advanced" = "standard") =>
    fetchApi<{ count: number; skipped: number; profile: string; signal_ids: string[] }>(
      `/orgs/${orgId}/signals/seed-defaults`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      },
    ),
  match: (orgId: string, signalId: string, value: number) =>
    fetchApi<{ matched: boolean; rule: CompiledRule }>(
      `/orgs/${orgId}/signals/${signalId}/match`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    ),
};

// ── Debugger (Phase P / F48) ─────────────────────────────────────────

export interface Checkpoint {
  id: string;
  trace_id: string;
  step_number: number;
  input_messages: Record<string, unknown>[];
  tool_calls: Record<string, unknown>[];
  tool_results: Record<string, unknown>[];
  response: Record<string, unknown>;
  prompt_override?: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  source: "live" | "replay" | string;
}

export interface RerunResult {
  source_trace_id: string;
  from_step: number;
  to_step: number;
  prompt_override?: string | null;
  checkpoints: Checkpoint[];
  diff: Array<{
    step_number: number;
    original_response: unknown;
    replayed_response: unknown;
    input_messages_changed: boolean;
  }>;
}

const debuggerApi = {
  listCheckpoints: (orgId: string, traceId: string) =>
    fetchApi<{ checkpoints: Checkpoint[] }>(
      `/orgs/${orgId}/debugger/checkpoints/${encodeURIComponent(traceId)}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  rerun: (
    orgId: string,
    body: {
      trace_id: string;
      from_step?: number;
      prompt_override?: string;
      live_prefix?: boolean;
      session_id?: string;
    },
  ) =>
    fetchApi<RerunResult & { mode?: string; live_tail_steps?: number; session_id?: string }>(
      `/orgs/${orgId}/debugger/rerun`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
};

export type DebugSessionRecord = {
  id: string;
  title: string;
  source_trace_id?: string | null;
  notes?: string;
  run_count?: number;
  runs?: Array<Record<string, unknown>>;
  created_at?: string;
  updated_at?: string;
};

const debugSessionsApi = {
  list: (orgId: string, limit = 50) =>
    fetchApi<{ sessions: DebugSessionRecord[]; count: number }>(
      `/orgs/${orgId}/debugger/sessions?limit=${limit}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  get: (orgId: string, sessionId: string) =>
    fetchApi<{ session: DebugSessionRecord }>(
      `/orgs/${orgId}/debugger/sessions/${sessionId}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  create: (
    orgId: string,
    body: { title?: string; source_trace_id?: string; notes?: string } = {},
  ) =>
    fetchApi<{ session: DebugSessionRecord }>(`/orgs/${orgId}/debugger/sessions`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  compare: (orgId: string, sessionId: string, runA: string, runB: string) =>
    fetchApi<Record<string, unknown>>(
      `/orgs/${orgId}/debugger/sessions/${sessionId}/compare?run_a=${encodeURIComponent(runA)}&run_b=${encodeURIComponent(runB)}`,
      { headers: { "X-Org-Id": orgId } },
    ),
};

const browserSessionsApi = {
  replayForTrace: async (orgId: string, traceId: string) => {
    const res = await fetchApi<{ data?: Record<string, unknown> } & Record<string, unknown>>(
      `/orgs/${orgId}/traces/${encodeURIComponent(traceId)}/browser-replay`,
      { headers: { "X-Org-Id": orgId } },
    );
    return (res.data ?? res) as Record<string, unknown>;
  },
};
// ── QA Generator (Phase J — synthetic) ──────────────────────────────

export interface QARun {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  topic: string;
  count: number;
  created_at: string;
  completed_at?: string;
  sample?: { q: string; a: string }[];
}

/** One synthetic Q/A triple from POST /synthetic/generate. */
export interface QATriple {
  id: string;
  question: string;
  answer: string;
  context: string;
  source_chunk_id: string;
  qa_type: string;
  locale: string;
  tags: string[];
  difficulty: number;
  source_chunks: string[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface GenerateQAResponse {
  run_id: string;
  qa_type: string;
  locale: string;
  triple_count: number;
  triples: QATriple[];
}

export type GenerateQARequest = {
  text: string;
  source_format?: "text" | "markdown" | "csv";
  locale?: string;
  qa_type?: string;
  qa_per_chunk?: number;
  chunk_size?: number;
  chunk_overlap?: number;
  tags?: string[];
};

const qaApi = {
  // Run history is deferred (Phase J.5) — endpoint returns empty list + detail.
  listRuns: (orgId: string) =>
    fetchApi<{ runs: QARun[]; total: number; detail?: string }>(
      `/orgs/${orgId}/synthetic/runs`,
      { headers: { "X-Org-Id": orgId } },
    ),
  // Live generation: POST /synthetic/generate returns triples inline.
  generate: (orgId: string, body: GenerateQARequest) =>
    fetchApi<GenerateQAResponse>(`/orgs/${orgId}/synthetic/generate`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: body.text,
        source_format: body.source_format ?? "text",
        locale: body.locale ?? "en",
        qa_type: body.qa_type ?? "extractive",
        qa_per_chunk: body.qa_per_chunk ?? 3,
        chunk_size: body.chunk_size ?? 800,
        chunk_overlap: body.chunk_overlap ?? 100,
        tags: body.tags ?? [],
      }),
    }),
};

// ── Redteam (Phase L) ────────────────────────────────────────────────

export interface RedteamFinding {
  id: string;
  probe_name: string;
  attack_prompt: string;
  agent_response: string;
  severity: "low" | "medium" | "high" | "critical";
  category: string;
  failed?: boolean;
  detection_reason?: string;
  target_label?: string;
  created_at: string;
}

export interface RedteamProbe {
  name: string;
  category: string;
  severity: string;
  description: string;
  prompt_count: number;
}

export interface RedteamScanRun {
  runs: Array<{
    probe_name: string;
    target_label: string;
    findings: RedteamFinding[];
    prompts_executed: number;
    /** Count of probe findings (agent complied with attack) — not HTTP/scan errors. */
    failure_count: number;
  }>;
}

const redteamApi = {
  listFindings: (orgId: string) =>
    fetchApi<{ findings: RedteamFinding[]; total: number }>(
      `/orgs/${orgId}/redteam/findings`,
      { headers: { "X-Org-Id": orgId } },
    ),
  listProbes: (orgId: string) =>
    fetchApi<{ probes: RedteamProbe[] }>(
      `/orgs/${orgId}/redteam/probes`,
      { headers: { "X-Org-Id": orgId } },
    ),
  runScan: (
    orgId: string,
    body: {
      target_endpoint?: string;
      target_label?: string;
      probe_names?: string[];
    },
  ) =>
    fetchApi<RedteamScanRun>(`/orgs/${orgId}/redteam/scan`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
};

// ── Datasets (Phase S — spreadsheet) ─────────────────────────────────

export interface DatasetColumn {
  id: string;
  name: string;
  /** Hub/spreadsheet columns use ``type``; older clients used ``kind``. */
  kind?: "text" | "number" | "json" | "ai_fill";
  type?: string;
  description?: string;
}

export interface DatasetRow {
  id: string;
  /** Top-level spreadsheet fields (not always mirrored into ``values``). */
  input?: string;
  expected_output?: string;
  values: Record<string, unknown>;
  created_at: string;
}

export interface Dataset {
  id: string;
  name: string;
  description?: string;
  row_count: number;
  column_count: number;
  created_at: string;
}

const datasetsApi = {
  list: (orgId: string) =>
    fetchApi<{ datasets: Dataset[]; total: number }>(
      `/orgs/${orgId}/datasets`,
      { headers: { "X-Org-Id": orgId } },
    ),
  create: (orgId: string, body: { name: string; description?: string }) =>
    fetchApi<Dataset>(`/orgs/${orgId}/datasets`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  promoteFromTrace: (
    orgId: string,
    body: { trace_id: string; dataset_id?: string; dataset_name?: string },
  ) =>
    fetchApi<{ status: string; data: { dataset_id: string; row_id: string } }>(
      `/orgs/${orgId}/datasets/promote-from-trace`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        noDedup: true,
      },
    ),
  get: (orgId: string, datasetId: string) =>
    fetchApi<Dataset & { columns: DatasetColumn[]; rows: DatasetRow[] }>(
      `/orgs/${orgId}/datasets/${datasetId}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  listRows: (orgId: string, datasetId: string) =>
    fetchApi<{ rows: DatasetRow[]; total: number }>(
      `/orgs/${orgId}/datasets/${datasetId}/rows`,
      { headers: { "X-Org-Id": orgId } },
    ),
  addRow: (orgId: string, datasetId: string, values: Record<string, unknown>) => {
    const input = String(
      values.input ?? values.prompt ?? Object.values(values)[0] ?? "",
    );
    return fetchApi<DatasetRow>(`/orgs/${orgId}/datasets/${datasetId}/rows`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify({ input, values }),
    });
  },
  generateColumn: (orgId: string, datasetId: string, body: { name: string; kind: "ai_fill"; description: string }) =>
    fetchApi<DatasetColumn>(`/orgs/${orgId}/datasets/${datasetId}/columns/generate`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /**
   * Returns a URL the browser can hit directly to download the dataset
   * as JSONL. The same-origin catch-all proxy preserves the session
   * cookie under SameSite=Lax, so an `<a download>` here just works.
   * P2: was a dead `<button>` — the new anchor wires it up + adds
   * aria-label on the caller side.
   */
  exportUrl: (orgId: string, datasetId: string, filename?: string) => {
    const base = API_BASE || "/api/proxy";
    const qs = filename ? `?filename=${encodeURIComponent(filename)}` : "";
    return `${base}/orgs/${orgId}/datasets/${datasetId}/export${qs}`;
  },
  updateRow: (
    orgId: string,
    datasetId: string,
    rowId: string,
    body: { values?: Record<string, unknown>; input?: string; expected_output?: string },
  ) =>
    fetchApi<DatasetRow>(`/orgs/${orgId}/datasets/${datasetId}/rows/${rowId}`, {
      method: "PATCH",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  createSnapshot: (orgId: string, datasetId: string) =>
    fetchApi<{ status: string; snapshot: Record<string, unknown> }>(
      `/orgs/${orgId}/datasets/${datasetId}/snapshots`,
      { method: "POST", headers: { "X-Org-Id": orgId }, noDedup: true },
    ),
  importRows: (
    orgId: string,
    datasetId: string,
    body: { rows: Record<string, unknown>[]; column_map?: Record<string, string> },
  ) =>
    fetchApi<{ status: string; inserted: number }>(
      `/orgs/${orgId}/datasets/${datasetId}/import`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        noDedup: true,
      },
    ),
};

export interface PlaygroundRunResult {
  template_name: string;
  response: string;
  model: string;
  latency_ms: number;
  cost_usd?: number | null;
}

export interface PersistedPlayground {
  id: string;
  name: string;
  config: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

const playgroundApi = {
  /** Legacy template runner (org prompt store). */
  run: (
    orgId: string,
    name: string,
    body: { params?: Record<string, unknown>; model?: string },
  ) =>
    fetchApi<PlaygroundRunResult>(`/orgs/${orgId}/prompts/${encodeURIComponent(name)}/playground`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  compare: (
    orgId: string,
    name: string,
    body: { params?: Record<string, unknown>; model_b: string },
  ) =>
    fetchApi<{ a: PlaygroundRunResult; b: PlaygroundRunResult }>(
      `/orgs/${orgId}/prompts/${encodeURIComponent(name)}/compare`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        noDedup: true,
      },
    ),
  list: (orgId: string) =>
    fetchApi<{ playgrounds: PersistedPlayground[]; total: number }>(
      `/orgs/${orgId}/playgrounds`,
      { headers: { "X-Org-Id": orgId } },
    ),
  create: (orgId: string, body: { name: string; config?: Record<string, unknown> }) =>
    fetchApi<{ playground: PersistedPlayground }>(`/orgs/${orgId}/playgrounds`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  get: (orgId: string, playgroundId: string) =>
    fetchApi<{ playground: PersistedPlayground }>(
      `/orgs/${orgId}/playgrounds/${playgroundId}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  patch: (
    orgId: string,
    playgroundId: string,
    body: { name?: string; config?: Record<string, unknown> },
  ) =>
    fetchApi<{ playground: PersistedPlayground }>(
      `/orgs/${orgId}/playgrounds/${playgroundId}`,
      {
        method: "PATCH",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        noDedup: true,
      },
    ),
  fromSpan: (
    orgId: string,
    body: {
      trace_id: string;
      span_id?: string;
      messages?: Array<Record<string, unknown>>;
      model?: string;
      tools?: Array<Record<string, unknown>>;
    },
  ) =>
    fetchApi<{ playground: PersistedPlayground }>(`/orgs/${orgId}/playgrounds/from-span`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  runPersisted: (
    orgId: string,
    playgroundId: string,
    body?: { params?: Record<string, unknown>; dataset_rows?: Array<Record<string, unknown>> },
  ) =>
    fetchApi<{ status: string; run: Record<string, unknown> }>(
      `/orgs/${orgId}/playgrounds/${playgroundId}/run`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        noDedup: true,
      },
    ),
  promoteExperiment: (
    orgId: string,
    playgroundId: string,
    body?: { name?: string; dataset_id?: string },
  ) =>
    fetchApi<{ status: string; experiment: Record<string, unknown> }>(
      `/orgs/${orgId}/playgrounds/${playgroundId}/promote-experiment`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        noDedup: true,
      },
    ),
};

const offlineExperimentsApi = {
  list: (orgId: string) =>
    fetchApi<{ experiments: Array<Record<string, unknown>>; total: number }>(
      `/orgs/${orgId}/experiments/offline`,
      { headers: { "X-Org-Id": orgId } },
    ),
  create: (
    orgId: string,
    body: { name: string; dataset_id: string; config?: Record<string, unknown> },
  ) =>
    fetchApi<{ experiment: Record<string, unknown> }>(`/orgs/${orgId}/experiments/offline`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  run: (orgId: string, experimentId: string) =>
    fetchApi<{
      result: {
        experiment_id?: string;
        status?: string;
        rows?: number;
        grades?: Record<string, number>;
        synthetic?: boolean;
        method?: string;
      };
    }>(`/orgs/${orgId}/experiments/offline/${experimentId}/run`, {
      method: "POST",
      headers: { "X-Org-Id": orgId },
      noDedup: true,
    }),
  compare: (orgId: string, experimentId: string, baselineId?: string) => {
    const qs = baselineId ? `?baseline_id=${encodeURIComponent(baselineId)}` : "";
    return fetchApi<{
      compare: {
        summary?: Record<string, number>;
        datapoints?: Array<Record<string, unknown>>;
        baseline_experiment_id?: string | null;
        synthetic?: boolean;
        method?: string;
      };
    }>(`/orgs/${orgId}/experiments/offline/${experimentId}/compare${qs}`, {
      headers: { "X-Org-Id": orgId },
    });
  },
};

const labelingQueuesApi = {
  list: (orgId: string) =>
    fetchApi<{ queues: Array<Record<string, unknown>>; total: number }>(
      `/orgs/${orgId}/labeling/queues`,
      { headers: { "X-Org-Id": orgId } },
    ),
  create: (
    orgId: string,
    body: { name: string; description?: string; label_schema?: Record<string, unknown> },
  ) =>
    fetchApi<{ queue: Record<string, unknown> }>(`/orgs/${orgId}/labeling/queues`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  get: (orgId: string, queueId: string) =>
    fetchApi<{ queue: Record<string, unknown> }>(
      `/orgs/${orgId}/labeling/queues/${queueId}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  board: (orgId: string, queueId: string) =>
    fetchApi<{ board: Record<string, Array<Record<string, unknown>>> }>(
      `/orgs/${orgId}/labeling/queues/${queueId}/board`,
      { headers: { "X-Org-Id": orgId } },
    ),
  move: (orgId: string, queueId: string, body: { item_id: string; status: string }) =>
    fetchApi<{ moved: boolean }>(`/orgs/${orgId}/labeling/queues/${queueId}/move`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      noDedup: true,
    }),
  pushToDataset: (orgId: string, queueId: string, body: { dataset_id: string }) =>
    fetchApi<Record<string, unknown>>(
      `/orgs/${orgId}/labeling/queues/${queueId}/push-to-dataset`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        noDedup: true,
      },
    ),
  iaa: (orgId: string, queueId: string) =>
    fetchApi<{ iaa: { kappa: number; n: number; agreement_rate: number } }>(
      `/orgs/${orgId}/labeling/queues/${queueId}/iaa`,
      { headers: { "X-Org-Id": orgId } },
    ),
};

const changeImpactApi = {
  preview: (
    orgId: string,
    body: {
      change_id: string;
      changed_files: string[];
      agent_id?: string;
      trace_ids?: string[];
      prompt_override?: string;
    },
  ) =>
    fetchApi<{ data?: { report?: Record<string, unknown> } }>(
      `/orgs/${orgId}/change-impact/preview`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        noDedup: true,
      },
    ),
  get: (orgId: string, changeId: string) =>
    fetchApi<{ data?: { report?: Record<string, unknown> } }>(
      `/orgs/${orgId}/change-impact/${encodeURIComponent(changeId)}`,
      { headers: { "X-Org-Id": orgId } },
    ),
};

const wave6Api = {
  listScoringRules: (orgId: string) =>
    fetchApi<{ data: { rules: Record<string, unknown>[] } }>(
      `/orgs/${orgId}/online-scoring/rules`,
      { headers: { "X-Org-Id": orgId } },
    ),
  createScoringRule: (
    orgId: string,
    body: {
      name: string;
      scope?: string;
      filter_query?: string;
      scorer_type?: string;
      sample_rate?: number;
    },
  ) =>
    fetchApi(`/orgs/${orgId}/online-scoring/rules`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Org-Id": orgId },
    }),
  getHomeDashboard: (orgId: string) =>
    fetchApi<{ data: { dashboard: Record<string, unknown> } }>(
      `/orgs/${orgId}/dashboards/home`,
      { headers: { "X-Org-Id": orgId } },
    ),
  costKpi: (orgId: string, params?: { window_hours?: number; agent_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.window_hours) q.set("window_hours", String(params.window_hours));
    if (params?.agent_id) q.set("agent_id", params.agent_id);
    const qs = q.toString();
    return fetchApi<{ data: { tiles: Record<string, unknown>[] } }>(
      `/orgs/${orgId}/cost-analytics/kpi${qs ? `?${qs}` : ""}`,
      { headers: { "X-Org-Id": orgId } },
    );
  },
  getPromptWorkspace: (orgId: string, name: string) =>
    fetchApi(`/orgs/${orgId}/prompts/${encodeURIComponent(name)}/workspace`, {
      headers: { "X-Org-Id": orgId },
    }),
  listPromptEnvironments: (orgId: string, name: string) =>
    fetchApi<{ data?: { environments?: Array<Record<string, unknown>> } }>(
      `/orgs/${orgId}/prompts/${encodeURIComponent(name)}/environments`,
      { headers: { "X-Org-Id": orgId } },
    ),
  deployPrompt: (orgId: string, name: string, body: { env: string; version: number }) =>
    fetchApi(`/orgs/${orgId}/prompts/${encodeURIComponent(name)}/deploy`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Org-Id": orgId },
    }),
  resolvePrompt: (orgId: string, name: string, env = "production") =>
    fetchApi(
      `/orgs/${orgId}/prompts/${encodeURIComponent(name)}/resolve?env=${encodeURIComponent(env)}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  exportSqlToDataset: (
    orgId: string,
    body: { sql: string; dataset_name: string; trace_id_column?: string },
  ) =>
    fetchApi(`/orgs/${orgId}/sql/export/dataset`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Org-Id": orgId },
    }),
  lateMetadata: (orgId: string, traceId: string, properties: Record<string, string>) =>
    fetchApi(`/orgs/${orgId}/traces/${encodeURIComponent(traceId)}/metadata`, {
      method: "POST",
      body: JSON.stringify({ properties }),
      headers: { "X-Org-Id": orgId },
    }),
  patchScoringRule: (
    orgId: string,
    ruleId: string,
    body: Record<string, unknown>,
  ) =>
    fetchApi(`/orgs/${orgId}/online-scoring/rules/${encodeURIComponent(ruleId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "X-Org-Id": orgId },
    }),
  rewindScoringRule: (orgId: string, ruleId: string, body?: Record<string, unknown>) =>
    fetchApi(
      `/orgs/${orgId}/online-scoring/rules/${encodeURIComponent(ruleId)}/rewind`,
      {
        method: "POST",
        body: JSON.stringify(body || {}),
        headers: { "X-Org-Id": orgId },
      },
    ),
  applyScoring: (orgId: string, traceId: string, params?: { agent_id?: string; span_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.agent_id) q.set("agent_id", params.agent_id);
    if (params?.span_id) q.set("span_id", params.span_id);
    const qs = q.toString();
    return fetchApi(
      `/orgs/${orgId}/online-scoring/apply/${encodeURIComponent(traceId)}${qs ? `?${qs}` : ""}`,
      { method: "POST", headers: { "X-Org-Id": orgId }, noDedup: true },
    );
  },
  listSpanScores: (orgId: string, spanId: string) =>
    fetchApi(`/orgs/${orgId}/spans/${encodeURIComponent(spanId)}/scores`, {
      headers: { "X-Org-Id": orgId },
    }),
  listTraceSpanScores: (orgId: string, traceId: string) =>
    fetchApi(`/orgs/${orgId}/traces/${encodeURIComponent(traceId)}/span-scores`, {
      headers: { "X-Org-Id": orgId },
    }),
  listAutomations: (orgId: string) =>
    fetchApi(`/orgs/${orgId}/automations`, {
      headers: { "X-Org-Id": orgId },
    }),
  createAutomation: (orgId: string, body: Record<string, unknown>) =>
    fetchApi(`/orgs/${orgId}/automations`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Org-Id": orgId },
    }),
  exportSqlToQueue: (
    orgId: string,
    body: { sql: string; queue_id: string; trace_id_column?: string },
  ) =>
    fetchApi(`/orgs/${orgId}/sql/export/queue`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Org-Id": orgId },
    }),
  promoteToShadowGuardrail: (orgId: string, body: Record<string, unknown>) =>
    fetchApi(`/orgs/${orgId}/eval/promote-to-shadow-guardrail`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Org-Id": orgId },
    }),
};

(api as unknown as Record<string, unknown>).labelingApi = labelingApi;
(api as unknown as Record<string, unknown>).signalsApi = signalsApi;
(api as unknown as Record<string, unknown>).debuggerApi = debuggerApi;
(api as unknown as Record<string, unknown>).debugSessionsApi = debugSessionsApi;
(api as unknown as Record<string, unknown>).browserSessionsApi = browserSessionsApi;
(api as unknown as Record<string, unknown>).qaApi = qaApi;
(api as unknown as Record<string, unknown>).redteamApi = redteamApi;
(api as unknown as Record<string, unknown>).datasetsApi = datasetsApi;

export {
  labelingApi,
  signalsApi,
  debuggerApi,
  debugSessionsApi,
  browserSessionsApi,
  qaApi,
  redteamApi,
  datasetsApi,
  playgroundApi,
  offlineExperimentsApi,
  labelingQueuesApi,
  changeImpactApi,
  wave6Api,
};

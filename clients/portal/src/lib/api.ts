// API routing. The portal's frontend calls go through the catch-all
// proxy at `/api/proxy/[...path]` (defined in
// `src/app/api/proxy/[...path]/route.ts`), which forwards to FastAPI.
// This keeps the request same-origin so the session cookie is sent
// automatically under SameSite=Lax (Vercel → Northflank is
// cross-origin and would otherwise block the cookie).
//
// Order of precedence:
//   1. NEXT_PUBLIC_API_URL — set at build time. In production this
//      is `/api/proxy`; in dev it can be `http://localhost:8000`
//      to bypass the proxy for live FastAPI debugging.
//   2. `/api/proxy` — the safe default. Works in dev (Next.js dev
//      server proxies to localhost:8000 via the route handler) and
//      in production (Vercel → Northflank via the env-configured
//      upstream).
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "/api/proxy";

// Default timeout. SSE streams pass `stream: true` in options to
// opt out — otherwise the timeout would close a long-lived
// Server-Sent-Events connection.
const DEFAULT_TIMEOUT_MS = 30_000;

// In-flight GET request de-duplication. Multiple React components
// mounting simultaneously used to fire N identical requests; the
// pending-promise map collapses them into one.
const inflight = new Map<string, Promise<unknown>>();

function dedupKey(method: string, endpoint: string, body: unknown): string {
  // Body is JSON-stringified by the time we get here. Hashing the
  // string is overkill for our scale; a plain string key is fine.
  return `${method} ${endpoint} ${body ? JSON.stringify(body) : ""}`;
}

interface FetchOptions extends RequestInit {
  credentials?: "include" | "omit";
  /** Disable the 30s default timeout. Used for SSE streams. */
  stream?: boolean;
  /** Skip the in-flight de-duplication. Used for non-idempotent POSTs. */
  noDedup?: boolean;
}

async function fetchApi<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { credentials = "include", headers, body, stream, noDedup, ...rest } = options;
  const method = (rest.method as string | undefined) ?? "GET";

  // In-flight dedup. Only safe for idempotent methods (GET / HEAD /
  // OPTIONS). POSTs and friends always go through.
  if (!noDedup && (method === "GET" || method === "HEAD" || method === "OPTIONS")) {
    const key = dedupKey(method, endpoint, body);
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
  }

  // One-shot 401 retry. Clerk rotates the session JWT on a
  // background timer; a stale token from a long-lived tab can land
  // a 401 even though the user is still signed in. On a 401 we ask
  // Clerk to force-refresh, retry exactly once, and otherwise
  // surface the original error.
  //
  // Implementation note: ``useAuth()`` is a React hook and CANNOT
  // be called from a non-component context (it throws "Invalid hook
  // call" when the React dispatcher isn't bound). We use the Clerk
  // browser SDK directly via the global ``window.Clerk`` instance
  // that ``<ClerkProvider>`` injects on mount — that's the
  // documented imperative escape hatch for cases like ours where
  // the call site lives inside an async helper outside the React
  // render tree.
  const refreshClerkToken = async (): Promise<boolean> => {
    try {
      const clerk = (
        window as unknown as {
          Clerk?: {
            session?: {
              touch?: () => Promise<unknown>;
              getToken?: (opts?: { skipCache?: boolean }) => Promise<string | null>;
            };
          };
        }
      ).Clerk;
      if (!clerk?.session) return false;
      // ``touch`` forces the session JWT to rotate; ``getToken``
      // reads the fresh value out of the SDK cache. Both are
      // idempotent — calling on an already-fresh session is a
      // no-op (returns immediately).
      await clerk.session.touch?.();
      const fresh = await clerk.session.getToken?.({ skipCache: true });
      return Boolean(fresh);
    } catch {
      return false;
    }
  };

  const promise = (async (): Promise<T> => {
    const doFetch = async (): Promise<Response> => {
      const requestHeaders: HeadersInit = {
        ...(typeof headers === "object" && headers !== null ? headers : {}),
      };
      if (!(body instanceof FormData) && !stream) {
        (requestHeaders as Record<string, string>)["Content-Type"] = "application/json";
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!stream) {
        timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      }
      try {
        return await fetch(`${API_BASE}${endpoint}`, {
          credentials,
          headers: requestHeaders,
          body,
          signal: controller.signal,
          ...rest,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let response = await doFetch();

    // 401 retry loop — at most one retry after a forced token refresh.
    if (response.status === 401 && !stream) {
      const refreshed = await refreshClerkToken();
      if (refreshed) response = await doFetch();
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: "Request failed" }));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }

    // SSE streams don't return JSON.
    if (stream || response.headers.get("content-type")?.includes("text/event-stream")) {
      return (await response.text()) as unknown as T;
    }

    return response.json();
  })();

  if (!noDedup && (method === "GET" || method === "HEAD" || method === "OPTIONS")) {
    const key = dedupKey(method, endpoint, body);
    inflight.set(key, promise);
    promise.finally(() => {
      // Only delete if we're still the latest in-flight request.
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  }

  return promise;
}

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
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/proxy/auth/users/me/avatar", {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Upload failed: ${res.status}`);
    }
    return res.json();
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

  // Compliance: PII Policy
  getPiiPolicy: (orgId: string) =>
    fetchApi<{
      org_id: string;
      categories: Record<string, boolean>;
      fail_closed_on_credentials: boolean;
      extra_redact_keys: string[];
      created_at: string | null;
      updated_at: string | null;
    }>(`/orgs/${orgId}/pii-policy`),

  updatePiiPolicy: (
    orgId: string,
    data: {
      categories?: Record<string, boolean>;
      fail_closed_on_credentials?: boolean;
      extra_redact_keys?: string[];
    }
  ) =>
    fetchApi<{
      org_id: string;
      categories: Record<string, boolean>;
      fail_closed_on_credentials: boolean;
      extra_redact_keys: string[];
      created_at: string | null;
      updated_at: string | null;
    }>(`/orgs/${orgId}/pii-policy`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Compliance: Retention Policy
  getRetentionPolicy: (orgId: string) =>
    fetchApi<{
      org_id: string;
      table_overrides: Record<string, {
        hot_days: number;
        warm_days: number;
        cold_days: number;
        delete_days: number;
      }>;
      pii_scrub_after_days: number;
      created_at: string | null;
      updated_at: string | null;
    }>(`/orgs/${orgId}/retention-policy`),

  updateRetentionPolicy: (
    orgId: string,
    data: {
      table_overrides?: Record<string, {
        hot_days: number;
        warm_days: number;
        cold_days: number;
        delete_days: number;
      }>;
      pii_scrub_after_days?: number;
    }
  ) =>
    fetchApi<{
      org_id: string;
      table_overrides: Record<string, {
        hot_days: number;
        warm_days: number;
        cold_days: number;
        delete_days: number;
      }>;
      pii_scrub_after_days: number;
      created_at: string | null;
      updated_at: string | null;
    }>(`/orgs/${orgId}/retention-policy`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Compliance: Region / Data Residency
  getRegion: (orgId: string) =>
    fetchApi<{
      org_id: string;
      region: "us" | "eu" | "ap";
      pinned: boolean;
      created_at: string | null;
      updated_at: string | null;
    }>(`/orgs/${orgId}/region`),

  updateRegion: (
    orgId: string,
    data: { region: "us" | "eu" | "ap"; pinned?: boolean }
  ) =>
    fetchApi<{
      org_id: string;
      region: "us" | "eu" | "ap";
      pinned: boolean;
      created_at: string | null;
      updated_at: string | null;
    }>(`/orgs/${orgId}/region`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // ── Observability: judges (Phase 7.2b) ────────────────────────
  // These power the live "Scores" tab in /observability.

  /**
   * Run the registered judges on a specific trace. The request is
   * fire-and-forget — the async tailer picks up the job and writes
   * scores to ``judge_scores``; the caller refreshes the list to see
   * the new rows.
   */
  runJudges: (
    orgId: string,
    body: { trace_id: string; judge_names?: string[] | null },
  ): Promise<{ enqueued: number }> =>
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
  // Cat 1 intelligence replay service. The BE returns
  // ``{events, next_cursor, total}`` and the Replay page consumes
  // ``events`` directly. ``page_size`` is clamped to 1000 by the BE.
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
    fetchApi(
      `/orgs/${orgId}/intelligence/replay/${traceId}/replay`,
      { method: "POST", body: JSON.stringify({ cursor, page_size: pageSize }) },
    ),

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

  // ── HILT (Human-in-the-loop) state + command ───────────────
  // Wired to the existing backend endpoints in
  // src/eden/api/routes/replay.py (`/jobs/{id}/hilt/state` and
  // `/jobs/{id}/hilt/command`). These calls are real; the portal's
  // /replay page and the HILT panel consume them.
  getHILTState: (jobId: string): Promise<{
    job_id: string;
    state: string;
    paused_at: string | null;
    resumed_at: string | null;
    waiting_for: string | null;
    current_step: number | null;
    total_steps: number | null;
    pending_command_count: number;
    history: Array<Record<string, unknown>>;
    last_updated: string;
  }> => fetchApi(`/jobs/${jobId}/hilt/state`),

  sendHILTCommand: (
    jobId: string,
    command: string,
    payload: Record<string, unknown> = {},
  ): Promise<{
    status: string;
    message: string;
    state: Record<string, unknown> | null;
  }> =>
    fetchApi(`/jobs/${jobId}/hilt/command`, {
      method: "POST",
      body: JSON.stringify({ command, payload }),
    }),

  // DELETE /jobs/{job_id}/trace — see replay.py:119
  deleteTrace: (jobId: string): Promise<{ status: string }> =>
    fetchApi(`/jobs/${jobId}/trace`, { method: "DELETE" }),

  // ── Observability: retention policy (Phase 7.3b) ─────────────
  // The existing `getRetentionPolicy` / `updateRetentionPolicy`
  // cover the singular config. ``listRetentionOverrides`` returns
  // the per-table overrides the route returns for tenants that
  // have set them; useful for the Settings rail's Retention tab.

  listRetentionOverrides: (
    orgId: string,
  ): Promise<Array<{
    policy_id: string;
    table_name: string;
    hot_days: number;
    warm_days: number;
    cold_days: number;
    delete_days: number;
    pii_scrub_after_days: number | null;
  }>> => fetchApi(`/orgs/${orgId}/retention-policy?list=overrides`),

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
    params?: { realm?: string; outcome?: string; agent_id?: string; days?: number; limit?: number },
  ): Promise<{ traces: ObservabilityTrace[]; total: number }> => {
    const q = new URLSearchParams();
    if (params?.realm) q.set("realm", params.realm);
    if (params?.outcome) q.set("outcome", params.outcome);
    if (params?.agent_id) q.set("agent_id", params.agent_id);
    if (params?.days !== undefined) q.set("days", String(params.days));
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return fetchApi(`/orgs/${orgId}/observability/traces${qs ? `?${qs}` : ""}`);
  },

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
    q.set("metric", metric);
    if (params?.days) q.set("days", String(params.days));
    return fetchApi(`/orgs/${orgId}/observability/heatmap?${q.toString()}`);
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
    fetchApi(
      `/orgs/${orgId}/observability/traces/compare?env=${encodeURIComponent(envTraceId)}&prod=${encodeURIComponent(prodTraceId)}`,
    ),

  exportTrace: (
    orgId: string,
    traceId: string,
    format: "json" | "jsonl" | "csv" = "jsonl",
  ): Promise<{ data: string; format: string; trace_id: string }> => {
    const q = new URLSearchParams();
    q.set("format", format);
    return fetchApi(
      `/orgs/${orgId}/observability/traces/${traceId}/export?${q.toString()}`,
    );
  },

  // ── Alerts: feed + ack + rules ─────────────────────────────────
  // The org-scoped listAlerts(orgId, params) is used by /alerts and
  // by Dashboard; the parameterless overload returns the global feed
  // for the current user (across all orgs). Both shapes return the
  // same {alerts, total, unread_count} envelope so the consumer
  // can use either.

  listAlerts: (async (orgId?: string, params?: { severity?: string; acknowledged?: boolean; limit?: number; offset?: number }): Promise<{
    alerts: Array<{
      alert_id: string;
      severity: string;
      title: string;
      description: string;
      source: string;
      triggered_at: string;
      acknowledged: boolean;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
      metadata: Record<string, unknown>;
    }>;
    total: number;
    unread_count: number;
  }> => {
    // The org-scoped endpoint /orgs/{org_id}/alerts doesn't exist on the
    // backend (the mounted alerts router is the global /alerts surface,
    // which evaluates rules against current metrics and returns fired
    // alerts across the user's reachable orgs). The dashboard only needs
    // a count by severity, so we call the global endpoint, wrap the
    // list in the {alerts, total, unread_count} envelope the rest of
    // the app already speaks, and adapt field names. ``orgId`` is
    // accepted for callers that still pass it; the filter is a
    // best-effort client-side match on the alerts.router's `labels`
    // bag, which carries the org id when an alert is org-scoped.
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    const raw = await fetchApi<
      Array<{
        rule_id: string;
        severity: string;
        title: string;
        message: string;
        value: number;
        threshold: number;
        fired_at: string;
        labels: Record<string, string>;
      }>
    >(`/alerts${qs ? `?${qs}` : ""}`);

    // Filter by orgId if given — the global feed includes alerts
    // for every org the user can see, and the dashboard wants its
    // own slice. ``labels["org_id"]`` is set by the alert rules
    // engine when an alert is org-scoped; we fall back to "all"
    // for system-level alerts (e.g. budget breached) which carry
    // no org label.
    const filtered = orgId
      ? raw.filter((a) => a.labels?.org_id === orgId || !a.labels?.org_id)
      : raw;

    return {
      alerts: filtered.map((a) => ({
        alert_id: a.rule_id,
        severity: a.severity,
        title: a.title,
        description: a.message,
        source: "rule_engine",
        triggered_at: a.fired_at,
        acknowledged: false,
        acknowledged_at: null,
        acknowledged_by: null,
        metadata: { value: a.value, threshold: a.threshold, labels: a.labels },
      })),
      total: filtered.length,
      unread_count: filtered.length,
    };
  }) as {
    (orgId: string, params?: { severity?: string; acknowledged?: boolean; limit?: number; offset?: number }): Promise<{
      alerts: Array<{
        alert_id: string;
        severity: string;
        title: string;
        description: string;
        source: string;
        triggered_at: string;
        acknowledged: boolean;
        acknowledged_at: string | null;
        acknowledged_by: string | null;
        metadata: Record<string, unknown>;
      }>;
      total: number;
      unread_count: number;
    }>;
    (): Promise<{
      alerts: Array<{
        alert_id: string;
        severity: string;
        title: string;
        description: string;
        source: string;
        triggered_at: string;
        acknowledged: boolean;
        acknowledged_at: string | null;
        acknowledged_by: string | null;
        metadata: Record<string, unknown>;
      }>;
      total: number;
      unread_count: number;
    }>;
  },

  acknowledgeAlert: (alertId: string) =>
    fetchApi<{ alert_id: string; acknowledged: boolean }>(`/alerts/${alertId}/ack`, {
      method: "POST",
    }),

  acknowledgeAlertsBatch: (alertIds: string[]) =>
    fetchApi<{ acknowledged: number }>(`/alerts/ack-batch`, {
      method: "POST",
      body: JSON.stringify({ alert_ids: alertIds }),
    }),

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

  // ── Insights overview (Cat 9 high-level rollup) ────────────────
  getInsightsOverview: (orgId: string) =>
    fetchApi<{
      satisfaction_corrected: number;
      nps: number;
      friction_signals: number;
      top_friction_areas: Array<{ area: string; severity: string; count: number }>;
      active_users_24h: number;
      active_users_7d: number;
    }>(`/orgs/${orgId}/insights/overview`),

  runDetectors: (orgId: string) =>
    fetchApi<{ detectors_run: number; signals: number }>(
      `/orgs/${orgId}/insights/detectors/run`,
      { method: "POST" },
    ),

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
        config: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
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
    }>(`/orgs/${orgId}/intelligence/experiments`),

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
    }>(`/orgs/${orgId}/intelligence/experiments/${experimentId}`),

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
    }>(`/orgs/${orgId}/intelligence/experiments/ab-tests`),

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
    }>(`/orgs/${orgId}/gateway/health`),

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
    }>(`/orgs/${orgId}/gateway/metrics?limit=${limit}`),

  // ── LLM Ops: monitoring (Cat 13/22 surfaces) ──────────────────
  getOverallHealth: (orgId: string) =>
    fetchApi<{
      overall_score: number;
      active_alert_count: number;
      model_count: number;
      trend: "improving" | "degrading" | "stable";
      last_check: string;
    }>(`/orgs/${orgId}/monitoring/health`),

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
    }>(`/orgs/${orgId}/monitoring/alerts${qs ? `?${qs}` : ""}`);
  },

  acknowledgeMonitoringAlert: (orgId: string, alertId: string) =>
    fetchApi<{ alert_id: string; acknowledged: boolean }>(
      `/orgs/${orgId}/monitoring/alerts/${alertId}/ack`,
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
    }>(`/orgs/${orgId}/cache/stats`),

  cacheGet: (orgId: string, query: string, modelVersion: string) =>
    fetchApi<{
      hit: boolean;
      response: string | null;
      similarity: number | null;
      cached_at: string | null;
    }>(`/orgs/${orgId}/cache/get?query=${encodeURIComponent(query)}&model=${encodeURIComponent(modelVersion)}`),

  cacheInvalidate: (orgId: string, pattern: string) =>
    fetchApi<{ invalidated: number }>(`/orgs/${orgId}/cache/invalidate`, {
      method: "POST",
      body: JSON.stringify({ pattern }),
    }),

  // ── Multi-agent: environments / comms / roles / memory / planning / tests / HITL ──
  // These are the per-org routes for the multi-agent orchestrator
  // surface in /multi-agent. They were added in 2026-06 as part of
  // the multi-agent test-runner expansion; the page uses one helper
  // per route so that consumers stay typed at the call site.

  listMultiAgentEnvs: (orgId: string) =>
    fetchApi<{
      environments: Array<{
        env_id: string;
        name: string;
        pattern: string;
        agent_count: number;
        max_steps: number;
        created_at: string;
      }>;
    }>(`/orgs/${orgId}/multi-agent/environments`),

  createMultiAgentEnv: (
    orgId: string,
    data: {
      name: string;
      communication_pattern: string;
      agent_count: number;
      max_steps: number;
    },
  ) =>
    fetchApi<{
      env_id: string;
      name: string;
      pattern: string;
      agent_count: number;
      max_steps: number;
      created_at: string;
    }>(`/orgs/${orgId}/multi-agent/environments`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteMultiAgentEnv: (orgId: string, envId: string) =>
    fetchApi<{ deleted: boolean }>(`/orgs/${orgId}/multi-agent/environments/${envId}`, {
      method: "DELETE",
    }),

  getMultiAgentMessages: (orgId: string, envId: string, toAgent: string) =>
    fetchApi<{
      messages: Array<{
        message_id: string;
        from_agent: string;
        to_agent: string;
        content: Record<string, unknown>;
        sent_at: string;
        read_at: string | null;
      }>;
    }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/messages?to=${encodeURIComponent(toAgent)}`,
    ),

  getMultiAgentCommStats: (orgId: string, envId: string) =>
    fetchApi<{
      stats: {
        total_messages: number;
        messages_per_minute: number;
        unique_pairs: number;
        broadcast_count: number;
        avg_latency_ms: number;
      };
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/stats`),

  sendMultiAgentMessage: (
    orgId: string,
    envId: string,
    data: { from_agent: string; to_agent: string; content: Record<string, unknown> },
  ) =>
    fetchApi<{ message_id: string; sent_at: string }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/messages`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  broadcastMultiAgentMessage: (
    orgId: string,
    envId: string,
    data: { from_agent: string; content: Record<string, unknown> },
  ) =>
    fetchApi<{ delivered: number; sent_at: string }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/broadcast`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  // Roles + role configs

  listAgentRoles: (orgId: string, envId: string) =>
    fetchApi<{
      roles: Array<{
        role_id: string;
        role_name: string;
        hierarchy: string;
        agent_id: string | null;
        objectives: string[];
        tools: string[];
      }>;
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/roles`),

  listRoleConfigs: (orgId: string, envId: string) =>
    fetchApi<{
      configs: Array<{
        config_id: string;
        role_name: string;
        hierarchy: string;
        objectives: string[];
        tools: string[];
        created_at: string;
      }>;
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/role-configs`),

  createRoleConfig: (
    orgId: string,
    envId: string,
    data: { role_name: string; hierarchy: string; objectives: string[]; tools: string[] },
  ) =>
    fetchApi<{
      config_id: string;
      role_name: string;
      hierarchy: string;
      objectives: string[];
      tools: string[];
      created_at: string;
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/role-configs`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  assignAgentRole: (
    orgId: string,
    envId: string,
    data: { agent_id: string; role_name: string },
  ) =>
    fetchApi<{ role_id: string; agent_id: string; role_name: string; assigned_at: string }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/roles`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  // Memory

  queryMemory: (orgId: string, envId: string, agentId: string) =>
    fetchApi<{
      working_memory_summary: string;
      episodes: Array<{
        episode_id: string;
        content: string;
        recorded_at: string;
        importance: number;
      }>;
      semantic_facts: Array<{ fact: string; confidence: number }>;
    }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/memory/${encodeURIComponent(agentId)}/query`,
    ),

  getMemoryStats: (orgId: string, envId: string) =>
    fetchApi<{
      working_memory_count: number;
      episodic: { total_recorded: number; recent_24h: number };
      semantic: { total_facts: number; avg_confidence: number };
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/memory/stats`),

  addObservation: (
    orgId: string,
    envId: string,
    data: { agent_id: string; content: string },
  ) =>
    fetchApi<{ observation_id: string; recorded_at: string }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/memory/observe`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  consolidateMemory: (orgId: string, envId: string, agentId: string) =>
    fetchApi<{ merged: number; archived: number; demoted: number }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/memory/${encodeURIComponent(agentId)}/consolidate`,
      { method: "POST" },
    ),

  // Planning

  listPlanningFrameworks: (orgId: string) =>
    fetchApi<{
      frameworks: Array<{
        id: string;
        name: string;
        description: string;
        complexity: "low" | "medium" | "high";
        supports: string[];
      }>;
    }>(`/orgs/${orgId}/multi-agent/frameworks`),

  runEpisode: (
    orgId: string,
    envId: string,
    data: { framework: string; agent_ids: string[]; max_steps: number },
  ) =>
    fetchApi<{
      result: {
        episode_id: string;
        steps_taken: number;
        outcome: string;
        agent_contributions: Record<string, number>;
        artifacts: Record<string, unknown>;
      };
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/episodes/run`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Tests + benchmark

  runMultiAgentTests: (orgId: string, envId: string) =>
    fetchApi<{
      total_tests: number;
      passed: number;
      failed: number;
      duration_ms: number;
      all_passed: boolean;
      results: Array<{
        test_name: string;
        passed: boolean;
        duration_ms: number;
        error: string | null;
      }>;
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/tests/run`, {
      method: "POST",
    }),

  runMultiAgentBenchmark: (orgId: string, envId: string) =>
    fetchApi<{
      suite: string;
      scores: Record<string, number>;
      duration_ms: number;
      per_test: Array<{ test_name: string; score: number; duration_ms: number }>;
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/benchmark/run`, {
      method: "POST",
    }),

  getMultiAgentTestResults: (orgId: string, envId: string) =>
    fetchApi<{
      total_tests: number;
      passed: number;
      failed: number;
      duration_ms: number;
      all_passed: boolean;
      results: Array<{
        test_name: string;
        passed: boolean;
        duration_ms: number;
        error: string | null;
      }>;
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/tests/results`),

  // HITL (human-in-the-loop)

  getHitlRules: (orgId: string, envId: string) =>
    fetchApi<{ rules: Record<string, string> }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/hitl/rules`,
    ),

  getPendingApprovals: (orgId: string, envId: string) =>
    fetchApi<{
      pending: Array<{
        approval_id: string;
        action_type: string;
        payload: Record<string, unknown>;
        requested_at: string;
        requested_by: string;
      }>;
    }>(`/orgs/${orgId}/multi-agent/environments/${envId}/hitl/pending`),

  setHitlRule: (
    orgId: string,
    envId: string,
    data: { action_type: string; rule: string },
  ) =>
    fetchApi<{ action_type: string; rule: string; set_at: string }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/hitl/rules`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  resolveApproval: (orgId: string, envId: string, approvalId: string, approve: boolean) =>
    fetchApi<{ approval_id: string; resolved: boolean; decision: "approved" | "rejected" }>(
      `/orgs/${orgId}/multi-agent/environments/${envId}/hitl/resolve`,
      {
        method: "POST",
        body: JSON.stringify({ approval_id: approvalId, approve }),
      },
    ),

  // ── Marketplace (Cat 15) ──────────────────────────────────────

  listMarketplace: (params?: { q?: string; category?: string; quality?: string }) => {
    const q = new URLSearchParams();
    if (params?.q) q.set("q", params.q);
    if (params?.category) q.set("category", params.category);
    if (params?.quality) q.set("quality", params.quality);
    const qs = q.toString();
    return fetchApi<
      Array<{
        id: string;
        name: string;
        description: string;
        category: string;
        quality: "high" | "medium" | "low";
        author: string;
        stars: number;
        forks: number;
        updated_at: string;
      }>
    >(`/marketplace${qs ? `?${qs}` : ""}`);
  },

  listMarketplaceFeatured: () =>
    fetchApi<
      Array<{
        id: string;
        name: string;
        description: string;
        category: string;
        quality: "high" | "medium" | "low";
        author: string;
        stars: number;
        forks: number;
        updated_at: string;
      }>
    >(`/marketplace/featured`),

  // ── Sandbox (developer playground) ────────────────────────────
  // Sessions are 24h, capped at 50 requests; the FE tracks request
  // count from the create-session payload + after every execute.

  listSandboxSessions: () =>
    fetchApi<{
      sessions: Array<{
        session_id: string;
        status: "active" | "expired" | "deleted";
        created_at: string;
        last_used_at: string;
        expires_at: string;
        request_count: number;
        max_requests: number;
        endpoints_available: string[];
      }>;
    }>(`/sandbox/sessions`),

  createSandboxSession: (data: { name?: string }) =>
    fetchApi<{
      session_id: string;
      status: "active";
      created_at: string;
      expires_at: string;
      request_count: number;
      max_requests: number;
    }>(`/sandbox/sessions`, { method: "POST", body: JSON.stringify(data) }),

  deleteSandboxSession: (sessionId: string) =>
    fetchApi<{ deleted: boolean }>(`/sandbox/sessions/${sessionId}`, {
      method: "DELETE",
    }),

  resetSandboxSession: (sessionId: string, hardReset: boolean) =>
    fetchApi<{
      session_id: string;
      request_count: number;
      reset_at: string;
      hard: boolean;
    }>(`/sandbox/sessions/${sessionId}/reset`, {
      method: "POST",
      body: JSON.stringify({ hard: hardReset }),
    }),

  getSandboxDocs: () =>
    fetchApi<{
      title: string;
      version: string;
      endpoints: Array<{
        path: string;
        method: string;
        description: string;
        request_schema: Record<string, unknown>;
        response_schema: Record<string, unknown>;
      }>;
    }>(`/sandbox/docs`),

  getSandboxRequestLog: (sessionId: string) =>
    fetchApi<{
      entries: Array<{
        request_id: string;
        endpoint: string;
        method: string;
        status: number;
        duration_ms: number;
        requested_at: string;
      }>;
    }>(`/sandbox/sessions/${sessionId}/log`),

  executeSandboxRequest: (
    sessionId: string,
    data: { endpoint: string; method: string; body: Record<string, unknown> },
  ) =>
    fetchApi<{
      status: number;
      body: Record<string, unknown>;
      duration_ms: number;
    }>(`/sandbox/sessions/${sessionId}/execute`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
};

// Phase 2: the environment-generation pipeline (Planner→Critic→…→Archivist)
// was retired. The Eden Agent CLI's `/eden-sim` is the replacement for
// sim/test generation. All env-gen surfaces (interview/spec/submit/listJobs
// and the v1 environments endpoint) were removed in June 2026 cleanup; the
// replay page reads from the observability trace stream.

/**
 * Start a streaming AI Insights chat turn. Returns the raw ``fetch``
 * Response so the caller can iterate the SSE body — the result is
 * text/event-stream, not JSON.
 */
export async function aiInsightsChat(
  orgId: string,
  body: { message: string; session_id?: string | null },
): Promise<Response> {
  // Bypass fetchApi() — this endpoint streams SSE, and we need the
  // raw Response so the caller can attach a reader.
  return fetch(`${API_BASE}/orgs/${orgId}/ai-insights/chat`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
}

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
  duration_ms: number;
  agent_id?: string | null;
  started_at?: string | null;
  model?: string | null;
  provider?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_cents?: number | null;
  error?: string | null;
  streaming_metrics?: ObservabilityStreamingMetrics | null;
  /** Free-form tag dict the BE attaches (e.g. ``realm:env``). */
  tags?: Record<string, string> | null;
};

// ── Phase 3: agents + uploads + sim/test runs ────────────────────

export type AgentSummary = {
  agent_id: string;
  name: string;
  framework: string | null;
  repo_url: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export type AgentUpload = {
  upload_id: string;
  upload_version: number;
  code_path: string;
  entry_point: string | null;
  framework: string | null;
  language: string | null;
  file_count: number;
  total_bytes: number;
  eval_yaml: Record<string, unknown> | null;
  uploaded_at: string;
};

export type SimRun = {
  id: string;
  org_id: string;
  agent_id: string;
  upload_id: string;
  kind: "sim" | "test";
  status: "pending" | "running" | "passed" | "failed" | "error";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  results: Record<string, unknown> | null;
  error: string | null;
  runner_kind: string | null;
};

export const agentsApi = {
  list: (orgId: string, params?: { framework?: string; name?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.framework) search.set("framework", params.framework);
    if (params?.name) search.set("name", params.name);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return fetchApi<{ agents: AgentSummary[]; total: number }>(
      `/orgs/${orgId}/agents${qs ? `?${qs}` : ""}`
    );
  },
  register: (
    orgId: string,
    body: { name: string; framework?: string; repo_url?: string; agent_id?: string }
  ) =>
    fetchApi<{ agent: AgentSummary; created: boolean }>(
      `/orgs/${orgId}/agents/register`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  listUploads: (orgId: string, agentId: string, params?: { active_only?: boolean; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.active_only) search.set("active_only", "true");
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return fetchApi<AgentUpload[]>(
      `/orgs/${orgId}/agents/${agentId}/uploads${qs ? `?${qs}` : ""}`
    );
  },
  upload: (orgId: string, agentId: string, file: File, filename: string) => {
    const form = new FormData();
    form.append("file", file, filename);
    return fetchApi<AgentUpload>(
      `/orgs/${orgId}/agents/${agentId}/upload`,
      { method: "POST", body: form }
    );
  },
  triggerSimRun: (
    orgId: string,
    agentId: string,
    body: { upload_id?: string; scenario_ids?: string[]; max_episodes?: number; runner_kind?: "firecracker" | "subprocess" }
  ) =>
    fetchApi<SimRun>(
      `/orgs/${orgId}/agents/${agentId}/sim/runs`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  listSimRuns: (orgId: string, agentId: string, params?: { status?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return fetchApi<{ runs: SimRun[]; total: number }>(
      `/orgs/${orgId}/agents/${agentId}/sim/runs${qs ? `?${qs}` : ""}`
    );
  },
  getSimRun: (orgId: string, agentId: string, runId: string) =>
    fetchApi<SimRun>(`/orgs/${orgId}/agents/${agentId}/sim/runs/${runId}`),
  triggerTestRun: (
    orgId: string,
    agentId: string,
    body: { upload_id?: string; runner_kind?: "firecracker" | "subprocess" }
  ) =>
    fetchApi<SimRun>(
      `/orgs/${orgId}/agents/${agentId}/test/runs`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  listTestRuns: (orgId: string, agentId: string, params?: { status?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return fetchApi<{ runs: SimRun[]; total: number }>(
      `/orgs/${orgId}/agents/${agentId}/test/runs${qs ? `?${qs}` : ""}`
    );
  },
  getTestRun: (orgId: string, agentId: string, runId: string) =>
    fetchApi<SimRun>(`/orgs/${orgId}/agents/${agentId}/test/runs/${runId}`),
};
// ── Agent PR-suggestion API (v1.7) ───────────────────────────────

import type {
  PRSuggestionCreateResponse,
  PRSuggestionDetailResponse,
  PRSuggestionListResponse,
  PRSuggestionOpenPRResponse,
} from "@/lib/types";

export const prSuggestionApi = {
  list: (orgId: string, query: string) =>
    fetchApi<PRSuggestionListResponse>(
      `/orgs/${orgId}/pr-suggestions?${query}`
    ),
  get: (orgId: string, suggestionId: string) =>
    fetchApi<PRSuggestionDetailResponse>(
      `/orgs/${orgId}/pr-suggestions/${suggestionId}`
    ),
  create: (
    orgId: string,
    payload: {
      trigger: string;
      trigger_id: string;
      trigger_payload: Record<string, unknown>;
    }
  ) =>
    fetchApi<PRSuggestionCreateResponse>(
      `/orgs/${orgId}/pr-suggestions`,
      { method: "POST", body: JSON.stringify(payload) }
    ),
  openPR: (
    orgId: string,
    suggestionId: string,
    payload: {
      pr_title?: string;
      pr_body?: string;
      branch?: string;
      base?: string;
      labels?: string[];
      reviewers?: string[];
      draft?: boolean;
    }
  ) =>
    fetchApi<PRSuggestionOpenPRResponse>(
      `/orgs/${orgId}/pr-suggestions/${suggestionId}/open-pr`,
      { method: "POST", body: JSON.stringify(payload) }
    ),
  getFile: (orgId: string, suggestionId: string, filePath: string) =>
    fetchApi<{
      status: string;
      data: { path: string; content: string; size: number };
    }>(
      `/orgs/${orgId}/pr-suggestions/${encodeURIComponent(
        suggestionId
      )}/files/${encodeURIComponent(filePath)}`
    ),
  updateStatus: (
    orgId: string,
    suggestionId: string,
    status: "merged" | "rejected" | "opened"
  ) =>
    fetchApi<PRSuggestionDetailResponse>(
      `/orgs/${orgId}/pr-suggestions/${suggestionId}/status`,
      { method: "POST", body: JSON.stringify({ status }) }
    ),
  regenerate: (orgId: string, suggestionId: string) =>
    fetchApi<PRSuggestionDetailResponse>(
      `/orgs/${orgId}/pr-suggestions/${suggestionId}/regenerate`,
      { method: "POST" }
    ),
  bulkRegenerate: (orgId: string, suggestionIds: string[]) =>
    fetchApi<{
      status: string;
      data: {
        regenerated: string[];
        skipped: string[];
        requested: number;
      };
    }>(`/orgs/${orgId}/pr-suggestions/bulk/regenerate`, {
      method: "POST",
      body: JSON.stringify({ suggestion_ids: suggestionIds }),
    }),
};

// ── Intelligence: RCA & Incidents (Cat 2) ───────────────────────────
export const rcaApi = {
  analyze: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; rca_id: string; root_cause: string; confidence: number; factors: Array<Record<string, unknown>>; }>(`/orgs/${orgId}/intelligence/rca/${traceId}/analyze`, { method: "POST" }),
  explain: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; narrative: string; related_traces: string[]; similar_past: Array<Record<string, unknown>>; }>(`/orgs/${orgId}/intelligence/rca/${traceId}/explain`),
  clusterIncidents: (orgId: string) =>
    fetchApi<{ clusters: Array<Record<string, unknown>>; cluster_count: number; }>(`/orgs/${orgId}/intelligence/rca/incidents/cluster`, { method: "POST" }),
  listIncidents: (orgId: string) =>
    fetchApi<{ incidents: Array<Record<string, unknown>>; }>(`/orgs/${orgId}/intelligence/rca/incidents`),
  summarizeIncident: (orgId: string, clusterId: string) =>
    fetchApi<{ cluster_id: string; summary: string; member_count: number; severity: string; first_seen: string; last_seen: string; }>(`/orgs/${orgId}/intelligence/rca/incidents/${clusterId}/summarize`),
};

// ── Visual Builder: graph save/load (§8.1, Phase 1.7) ────────────
export const builderApi = {
  list: (orgId: string, params?: { limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.offset) search.set("offset", String(params.offset));
    const qs = search.toString();
    return fetchApi<{
      graphs: Array<{
        id: string;
        org_id: string;
        name: string;
        graph: { nodes: unknown[]; edges: unknown[] };
        yaml: string;
        agent_id: string | null;
        created_at: string;
        updated_at: string;
      }>;
      total: number;
    }>(`/orgs/${orgId}/builder/graphs${qs ? `?${qs}` : ""}`);
  },
  get: (orgId: string, name: string) =>
    fetchApi<{
      id: string;
      org_id: string;
      name: string;
      graph: { nodes: unknown[]; edges: unknown[] };
      yaml: string;
      agent_id: string | null;
      created_at: string;
      updated_at: string;
    }>(`/orgs/${orgId}/builder/graphs/${encodeURIComponent(name)}`),
  upsert: (
    orgId: string,
    body: {
      name: string;
      graph: { nodes: unknown[]; edges: unknown[] };
      yaml?: string;
      agent_id?: string | null;
    },
  ) =>
    fetchApi<{
      graph: {
        id: string;
        org_id: string;
        name: string;
        graph: { nodes: unknown[]; edges: unknown[] };
        yaml: string;
        agent_id: string | null;
        created_at: string;
        updated_at: string;
      };
      created: boolean;
    }>(`/orgs/${orgId}/builder/graphs`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  delete: (orgId: string, name: string) =>
    fetchApi<{ deleted: boolean; name: string }>(
      `/orgs/${orgId}/builder/graphs/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
};

// ── Intelligence: Retrieval (Cat 4) ─────────────────────────────────
export const retrievalApi = {
  utilization: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; utilization: number; used_chunks: string[]; unused_chunks: string[]; }>(`/orgs/${orgId}/intelligence/retrieval/${traceId}/utilization`, { method: "POST" }),
  gaps: (orgId: string) =>
    fetchApi<{ gaps: Array<{ query: string; gap_score: number; example_trace_id: string }>; }>(`/orgs/${orgId}/intelligence/retrieval/gaps`, { method: "POST" }),
  attribution: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; chunks: Array<{ chunk_id: string; influence: number; snippet: string }>; }>(`/orgs/${orgId}/intelligence/retrieval/${traceId}/attribution`, { method: "POST" }),
  reorder: (orgId: string) =>
    fetchApi<{ reordering: Array<{ chunk_id: string; new_position: number; reason: string }>; }>(`/orgs/${orgId}/intelligence/retrieval/reorder`, { method: "POST" }),
};

// ── Intelligence: Memory (Cat 5) ────────────────────────────────────
export const memoryApi = {
  attribute: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; memories: Array<{ memory_id: string; influence: number }>; }>(`/orgs/${orgId}/intelligence/memory/${traceId}/attribute`, { method: "POST" }),
  timeline: (orgId: string, memoryId: string) =>
    fetchApi<{ memory_id: string; events: Array<{ ts: string; event: string }>; }>(`/orgs/${orgId}/intelligence/memory/timeline/${memoryId}`),
  impact: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; impact_score: number; components: Record<string, number>; }>(`/orgs/${orgId}/intelligence/memory/${traceId}/impact`, { method: "POST" }),
  reweaverSuggest: (orgId: string) =>
    fetchApi<{ suggestions: Array<{ memory_id: string; action: "merge" | "archive" | "demote"; reason: string }>; }>(`/orgs/${orgId}/intelligence/memory/reaver/suggest`, { method: "POST" }),
};

// ── Intelligence: Tools (Cat 7) ─────────────────────────────────────
export const toolsApi = {
  attribution: (orgId: string, data: { days?: number }) =>
    fetchApi<{ tools: Array<{ tool_name: string; success_rate: number; call_count: number }>; }>(`/orgs/${orgId}/intelligence/tools/attribution`, { method: "POST", body: JSON.stringify(data) }),
  compare: (orgId: string, data: { tool_names: string[] }) =>
    fetchApi<{ comparison: Array<{ tool_name: string; metrics: Record<string, number> }>; }>(`/orgs/${orgId}/intelligence/tools/compare`, { method: "POST", body: JSON.stringify(data) }),
  recommend: (orgId: string, data: { task: string }) =>
    fetchApi<{ recommendations: Array<{ tool_name: string; score: number; rationale: string }>; }>(`/orgs/${orgId}/intelligence/tools/recommend`, { method: "POST", body: JSON.stringify(data) }),
  taxonomy: (orgId: string) =>
    fetchApi<{ categories: Array<{ category: string; tools: string[] }>; }>(`/orgs/${orgId}/intelligence/tools/taxonomy`),
};

// ── Intelligence: User (Cat 9) ──────────────────────────────────────
export const userApi = {
  aggregateSessions: (orgId: string, data: { days?: number }) =>
    fetchApi<{ sessions: Array<{ session_id: string; user_id: string; trace_count: number; first_seen: string; last_seen: string }>; }>(`/orgs/${orgId}/intelligence/user/sessions/aggregate`, { method: "POST", body: JSON.stringify(data) }),
  listGoals: (orgId: string) =>
    fetchApi<{ goals: Array<{ goal_id: string; name: string; description: string; target: number; current: number }>; }>(`/orgs/${orgId}/intelligence/user/goals`),
  createGoal: (orgId: string, data: { name: string; description?: string; target: number }) =>
    fetchApi<{ goal_id: string; name: string; target: number; current: number; }>(`/orgs/${orgId}/intelligence/user/goals`, { method: "POST", body: JSON.stringify(data) }),
  updateGoal: (orgId: string, goalId: string, data: { current?: number; target?: number }) =>
    fetchApi<{ goal_id: string; current: number; target: number; }>(`/orgs/${orgId}/intelligence/user/goals/${goalId}`, { method: "PATCH", body: JSON.stringify(data) }),
  getConversation: (orgId: string, sessionId: string) =>
    fetchApi<{ session_id: string; messages: Array<{ role: string; content: string; ts: string }>; }>(`/orgs/${orgId}/intelligence/user/conversation/${sessionId}`),
  postMessage: (orgId: string, data: { session_id: string; role: string; content: string }) =>
    fetchApi<{ message_id: string; session_id: string; }>(`/orgs/${orgId}/intelligence/user/conversation/message`, { method: "POST", body: JSON.stringify(data) }),
  postFeedback: (orgId: string, data: { trace_id: string; rating: number; comment?: string }) =>
    fetchApi<{ feedback_id: string; trace_id: string; rating: number; }>(`/orgs/${orgId}/intelligence/user/feedback`, { method: "POST", body: JSON.stringify(data) }),
  getFeedback: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; ratings: Array<{ rating: number; comment?: string; ts: string }>; }>(`/orgs/${orgId}/intelligence/user/feedback/${traceId}`),
  getSatisfaction: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; satisfaction: number; confidence: number; correction: number; }>(`/orgs/${orgId}/intelligence/user/satisfaction/${traceId}`),
  getSegments: (orgId: string) =>
    fetchApi<{ segments: Array<{ segment_id: string; name: string; user_count: number; criteria: Record<string, unknown> }>; }>(`/orgs/${orgId}/intelligence/user/segment`),
  getCohortDashboard: (orgId: string) =>
    fetchApi<{ cohorts: Array<{ name: string; user_count: number; satisfaction: number; regen_rate: number }>; }>(`/orgs/${orgId}/intelligence/user/dashboard/cohort`),
  getCorrection: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; raw: number; corrected: number; alpha: number; beta: number; n: number; }>(`/orgs/${orgId}/intelligence/user/correction/${traceId}`),
  postRegenerationSignal: (orgId: string, data: { trace_id: string; count: number }) =>
    fetchApi<{ trace_id: string; regen_count: number; }>(`/orgs/${orgId}/intelligence/user/signals/regeneration`, { method: "POST", body: JSON.stringify(data) }),
  postEditDistanceSignal: (orgId: string, data: { trace_id: string; distance: number }) =>
    fetchApi<{ trace_id: string; edit_distance: number; }>(`/orgs/${orgId}/intelligence/user/signals/edit-distance`, { method: "POST", body: JSON.stringify(data) }),
  postReturnSignal: (orgId: string, data: { trace_id: string; returned: boolean }) =>
    fetchApi<{ trace_id: string; returned: boolean; }>(`/orgs/${orgId}/intelligence/user/signals/return`, { method: "POST", body: JSON.stringify(data) }),
  postAbandonmentSignal: (orgId: string, data: { trace_id: string; abandoned: boolean }) =>
    fetchApi<{ trace_id: string; abandoned: boolean; }>(`/orgs/${orgId}/intelligence/user/signals/abandonment`, { method: "POST", body: JSON.stringify(data) }),
  postCopyPasteSignal: (orgId: string, data: { trace_id: string; copied: boolean }) =>
    fetchApi<{ trace_id: string; copied: boolean; }>(`/orgs/${orgId}/intelligence/user/signals/copy-paste`, { method: "POST", body: JSON.stringify(data) }),
  postRetrySignal: (orgId: string, data: { trace_id: string; retried: boolean }) =>
    fetchApi<{ trace_id: string; retried: boolean; }>(`/orgs/${orgId}/intelligence/user/signals/retry`, { method: "POST", body: JSON.stringify(data) }),
};

// ── Intelligence: Outcomes / ROI (Cat 11) ───────────────────────────
export const outcomesApi = {
  track: (orgId: string, data: { trace_id: string; outcome: string; department?: string; revenue?: number }) =>
    fetchApi<{ trace_id: string; outcome: string; department: string; revenue: number; roi: number; }>(`/orgs/${orgId}/intelligence/outcomes`, { method: "POST", body: JSON.stringify(data) }),
  listDepartments: (orgId: string) =>
    fetchApi<{ departments: Array<{ department: string; total_cost: number; total_revenue: number; roi: number; trace_count: number; anomaly: string | null }>; }>(`/orgs/${orgId}/intelligence/outcomes/departments`),
  getAnalytics: (orgId: string) =>
    fetchApi<{ total_revenue: number; total_cost: number; roi: number; per_department: Array<Record<string, unknown>>; anomalies: Array<Record<string, unknown>>; }>(`/orgs/${orgId}/intelligence/outcomes/analytics`),
};

// ── Intelligence: Predictive / Drift (Cat 13) ───────────────────────
export const predictiveApi = {
  quality: (orgId: string, data: { horizon_days?: number }) =>
    fetchApi<{ predictions: Array<{ date: string; median: number; ci_95_low: number; ci_95_high: number }>; }>(`/orgs/${orgId}/intelligence/predict/quality`, { method: "POST", body: JSON.stringify(data) }),
  cost: (orgId: string, data: { horizon_days?: number }) =>
    fetchApi<{ predictions: Array<{ date: string; median: number; ci_95_low: number; ci_95_high: number }>; }>(`/orgs/${orgId}/intelligence/predict/cost`, { method: "POST", body: JSON.stringify(data) }),
  capacity: (orgId: string, data: { horizon_days?: number }) =>
    fetchApi<{ predictions: Array<{ date: string; gpu_hours: number }>; scenarios: Record<string, { gpu_hours: number; cost: number }>; }>(`/orgs/${orgId}/intelligence/predict/capacity`, { method: "POST", body: JSON.stringify(data) }),
  risk: (orgId: string) =>
    fetchApi<{ risk_score: number; components: Record<string, { score: number; weight: number; alerts: string[] }>; breakdown: Array<{ component: string; score: number; alerts: string[] }>; }>(`/orgs/${orgId}/intelligence/predict/risk`, { method: "POST" }),
  drift: (orgId: string) =>
    fetchApi<{ drift_detected: boolean; drift_score: number; baseline_period: string; current_period: string; severity: string; top_shifts: Array<Record<string, unknown>>; }>(`/orgs/${orgId}/intelligence/predict/drift`, { method: "POST" }),
  embeddingDrift: (orgId: string) =>
    fetchApi<{ drift_detected: boolean; psi: number; histogram_buckets: number; severity: string; }>(`/orgs/${orgId}/intelligence/predict/drift/embedding`, { method: "POST" }),
};

// ── Intelligence: Autonomous (Cat 14) ───────────────────────────────
export const autonomousApi = {
  investigate: (orgId: string, data: { trace_id?: string; question: string }) =>
    fetchApi<{ investigation_id: string; findings: string; recommended_actions: string[]; confidence: number; }>(`/orgs/${orgId}/intelligence/autonomous/investigate`, { method: "POST", body: JSON.stringify(data) }),
  report: (orgId: string, data: { topic: string; period_days?: number }) =>
    fetchApi<{ report_id: string; title: string; markdown: string; period_days: number; generated_at: string; }>(`/orgs/${orgId}/intelligence/autonomous/report`, { method: "POST", body: JSON.stringify(data) }),
  recommendations: (orgId: string) =>
    fetchApi<{ recommendations: Array<{ id: string; title: string; impact: string; effort: string; rationale: string }>; }>(`/orgs/${orgId}/intelligence/autonomous/recommendations`),
  heal: (orgId: string, data: { component: string; description: string }) =>
    fetchApi<{ heal_id: string; status: "pending_approval" | "applied" | "rejected"; before_state: Record<string, unknown>; proposed_change: string; }>(`/orgs/${orgId}/intelligence/autonomous/heal`, { method: "POST", body: JSON.stringify(data) }),
  nlQuery: (orgId: string, data: { question: string }) =>
    fetchApi<{ question: string; sql: string; rows: Array<Record<string, unknown>>; explanation: string; }>(`/orgs/${orgId}/intelligence/autonomous/nl/query`, { method: "POST", body: JSON.stringify(data) }),
  nlDashboard: (orgId: string, data: { description: string }) =>
    fetchApi<{ dashboard_id: string; title: string; widgets: Array<{ type: string; title: string; query: string }>; }>(`/orgs/${orgId}/intelligence/autonomous/nl/dashboard`, { method: "POST", body: JSON.stringify(data) }),
  nlReport: (orgId: string, data: { audience: string; period_days?: number }) =>
    fetchApi<{ report_id: string; title: string; markdown: string; audience: string; generated_at: string; }>(`/orgs/${orgId}/intelligence/autonomous/nl/report`, { method: "POST", body: JSON.stringify(data) }),
};

// ── Intelligence: Guardrails (Cat 15) ───────────────────────────────
export const guardrailsApi = {
  listPolicies: (orgId: string) =>
    fetchApi<{ policies: Array<{ policy_id: string; name: string; kind: string; enabled: boolean; config: Record<string, unknown> }>; }>(`/orgs/${orgId}/intelligence/guardrails/policies`),
  createPolicy: (orgId: string, data: { name: string; kind: string; enabled?: boolean; config: Record<string, unknown> }) =>
    fetchApi<{ policy_id: string; name: string; kind: string; enabled: boolean; }>(`/orgs/${orgId}/intelligence/guardrails/policies`, { method: "POST", body: JSON.stringify(data) }),
  evaluate: (orgId: string, data: { content: string; context?: Record<string, unknown> }) =>
    fetchApi<{ passed: boolean; violations: Array<{ policy_id: string; severity: string; reason: string }>; }>(`/orgs/${orgId}/intelligence/guardrails/evaluate`, { method: "POST", body: JSON.stringify(data) }),
  scanInjection: (orgId: string, data: { content: string }) =>
    fetchApi<{ injection_score: number; is_injection: boolean; matched_patterns: string[]; }>(`/orgs/${orgId}/intelligence/guardrails/injection/scan`, { method: "POST", body: JSON.stringify(data) }),
  redactPii: (orgId: string, data: { content: string; categories?: string[] }) =>
    fetchApi<{ redacted_content: string; redactions: Array<{ category: string; count: number }>; }>(`/orgs/${orgId}/intelligence/guardrails/pii/redact`, { method: "POST", body: JSON.stringify(data) }),
  // Phase A.9: persistent scan history (replaces the portal's
  // hardcoded MOCK_INJECTIONS / MOCK_PII_REDACTIONS arrays).
  scanHistory: (orgId: string, opts?: { limit?: number; action_prefix?: string }) =>
    fetchApi<{ scans: Array<{ id: string; trace_id: string | null; verdict: string; reason: string | null; policy_id: string | null; edited_text: string | null; created_at: string }>; count: number }>(
      `/orgs/${orgId}/intelligence/guardrails/scan-history${
        opts
          ? `?${new URLSearchParams(
              Object.entries(opts).map(([k, v]) => [k, String(v)]) as [string, string][],
            ).toString()}`
          : ""
      }`,
    ),
};

// ── Intelligence: Cost (Cat 8) ──────────────────────────────────────
export const costApi = {
  efficiency: (orgId: string, data: { days?: number }) =>
    fetchApi<{ efficiency_score: number; by_model: Array<{ model: string; cost_per_call: number; success_rate: number }>; period_days: number; }>(`/orgs/${orgId}/intelligence/cost/efficiency`, { method: "POST", body: JSON.stringify(data) }),
  roi: (orgId: string, data: { days?: number }) =>
    fetchApi<{ total_cost: number; total_revenue: number; roi: number; per_agent: Array<{ agent_id: string; cost: number; revenue: number; roi: number }>; }>(`/orgs/${orgId}/intelligence/cost/roi`, { method: "POST", body: JSON.stringify(data) }),
  anomalies: (orgId: string, data: { days?: number }) =>
    fetchApi<{ anomalies: Array<{ date: string; z_score: number; severity: string; agent_id: string; cost: number }>; }>(`/orgs/${orgId}/intelligence/cost/anomalies`, { method: "POST", body: JSON.stringify(data) }),
  forecast: (orgId: string) =>
    fetchApi<{ forecast: Array<{ date: string; projected_cost: number; ci_low: number; ci_high: number }>; model: string; period_days: number; }>(`/orgs/${orgId}/intelligence/cost/forecast`),
};

// ── Intelligence: Experiments (Cat 12) ──────────────────────────────
export const experimentsApi = {
  trafficSplit: (orgId: string, data: { name: string; variants: Array<{ name: string; weight: number }> }) =>
    fetchApi<{ split_id: string; name: string; variants: Array<{ name: string; weight: number }>; }>(`/orgs/${orgId}/intelligence/experiments/traffic-split`, { method: "POST", body: JSON.stringify(data) }),
  listTrafficSplits: (orgId: string) =>
    fetchApi<{ splits: Array<{ split_id: string; name: string; variants: Array<{ name: string; weight: number }>; created_at: string }>; }>(`/orgs/${orgId}/intelligence/experiments/traffic-split`),
  autoEvaluate: (orgId: string, data: { split_id: string }) =>
    fetchApi<{ evaluation_id: string; per_variant: Array<{ variant: string; judge_score: number; n: number }>; recommended_action: string; }>(`/orgs/${orgId}/intelligence/experiments/auto-evaluate`, { method: "POST", body: JSON.stringify(data) }),
  recommend: (orgId: string, data: { split_id: string }) =>
    fetchApi<{ decision: "ship" | "dont_ship" | "need_more_data" | "tie" | "low_confidence"; confidence: number; rationale: string; details: Record<string, unknown>; }>(`/orgs/${orgId}/intelligence/experiments/recommend`, { method: "POST", body: JSON.stringify(data) }),
  winner: (orgId: string, data: { split_id: string }) =>
    fetchApi<{ winner: string; hard_judge_score: number; veto: string[]; }>(`/orgs/${orgId}/intelligence/experiments/winner`, { method: "POST", body: JSON.stringify(data) }),
  simulate: (orgId: string, data: { scenario: string; params: Record<string, unknown> }) =>
    fetchApi<{ simulation_id: string; results: Array<Record<string, unknown>>; summary: string; }>(`/orgs/${orgId}/intelligence/experiments/simulate`, { method: "POST", body: JSON.stringify(data) }),
  simulateReplay: (orgId: string, data: { trace_ids: string[]; candidate_changes: Record<string, unknown> }) =>
    fetchApi<{ replay_id: string; regressions: number; improvements: number; per_trace: Array<Record<string, unknown>>; }>(`/orgs/${orgId}/intelligence/experiments/simulate/replay`, { method: "POST", body: JSON.stringify(data) }),
  whatif: (orgId: string, data: { question: string }) =>
    fetchApi<{ ratios: Record<string, number>; answer: string; }>(`/orgs/${orgId}/intelligence/experiments/simulate/whatif`, { method: "POST", body: JSON.stringify(data) }),
};

// ── Intelligence: Closed Loop (Cat 17) ──────────────────────────────
export const closedLoopApi = {
  listActions: (orgId: string, params?: { status?: "pending" | "approved" | "denied" | "applied" }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    const qs = q.toString();
    return fetchApi<{ actions: Array<{ action_id: string; hook: string; status: string; created_at: string; payload: Record<string, unknown> }>; }>(`/orgs/${orgId}/intelligence/closed-loop/actions${qs ? `?${qs}` : ""}`);
  },
  approveAction: (orgId: string, actionId: string) =>
    fetchApi<{ action_id: string; status: string; }>(`/orgs/${orgId}/intelligence/closed-loop/actions/${actionId}/approve`, { method: "POST" }),
  denyAction: (orgId: string, actionId: string, data: { reason?: string }) =>
    fetchApi<{ action_id: string; status: string; reason: string; }>(`/orgs/${orgId}/intelligence/closed-loop/actions/${actionId}/deny`, { method: "POST", body: JSON.stringify(data) }),
  applyAction: (orgId: string, actionId: string) =>
    fetchApi<{ action_id: string; status: string; applied_at: string; }>(`/orgs/${orgId}/intelligence/closed-loop/actions/${actionId}/apply`, { method: "POST" }),
  dashboard: (orgId: string) =>
    fetchApi<{ pending: number; approved: number; denied: number; applied_today: number; by_hook: Record<string, number>; }>(`/orgs/${orgId}/intelligence/closed-loop/dashboard`),
};

// ── Intelligence: Eval (Cat 3) ──────────────────────────────────────
export const evalApi = {
  tagVersion: (orgId: string, data: { judge_name: string; version: string; notes?: string }) =>
    fetchApi<{ version_id: string; judge_name: string; version: string; tagged_at: string; }>(`/orgs/${orgId}/intelligence/eval/versions/tag`, { method: "POST", body: JSON.stringify(data) }),
  listVersions: (orgId: string) =>
    fetchApi<{ versions: Array<{ version_id: string; judge_name: string; version: string; tagged_at: string; notes: string | null }>; }>(`/orgs/${orgId}/intelligence/eval/versions`),
  failureClusters: (orgId: string, data: { days?: number }) =>
    fetchApi<{ clusters: Array<{ cluster_id: string; size: number; example_trace_ids: string[]; representative_failure: string }>; }>(`/orgs/${orgId}/intelligence/eval/failure-clusters`, { method: "POST", body: JSON.stringify(data) }),
  clhfGenerate: (orgId: string, data: { seed_traces: string[]; n?: number }) =>
    fetchApi<{ generation_id: string; samples: Array<{ prompt: string; chosen: string; rejected: string }>; }>(`/orgs/${orgId}/intelligence/eval/clhf/generate`, { method: "POST", body: JSON.stringify(data) }),
  hilTask: (orgId: string, data: { trace_id: string; question: string }) =>
    fetchApi<{ task_id: string; trace_id: string; question: string; }>(`/orgs/${orgId}/intelligence/eval/hil/tasks`, { method: "POST", body: JSON.stringify(data) }),
  hilAnnotation: (orgId: string, data: { task_id: string; answer: string; confidence: number }) =>
    fetchApi<{ annotation_id: string; task_id: string; }>(`/orgs/${orgId}/intelligence/eval/hil/annotations`, { method: "POST", body: JSON.stringify(data) }),
  pairwiseQueue: (orgId: string, data: { n: number }) =>
    fetchApi<{ queue_id: string; pairs: Array<{ a: string; b: string; trace_id: string }>; }>(`/orgs/${orgId}/intelligence/eval/pairwise/queues`, { method: "POST", body: JSON.stringify(data) }),
  pairwisePreference: (orgId: string, data: { queue_id: string; pair_id: string; preferred: "a" | "b" }) =>
    fetchApi<{ preference_id: string; queue_id: string; }>(`/orgs/${orgId}/intelligence/eval/pairwise/preferences`, { method: "POST", body: JSON.stringify(data) }),
  multimodalEvaluate: (orgId: string, data: { trace_id: string; modality: string }) =>
    fetchApi<{ score: number; rationale: string; modality: string; }>(`/orgs/${orgId}/intelligence/eval/multimodal/evaluate`, { method: "POST", body: JSON.stringify(data) }),
  promoteToGuardrail: (orgId: string, data: { judge_name: string; version: string; threshold: number }) =>
    fetchApi<{ policy_id: string; judge_name: string; threshold: number; }>(`/orgs/${orgId}/intelligence/eval/promote-to-guardrail`, { method: "POST", body: JSON.stringify(data) }),
};

// ── Intelligence: Replay / Decision (Cat 16) ────────────────────────
export const replayApi = {
  createSession: (orgId: string, data: { trace_id: string; name?: string }) =>
    fetchApi<{ session_id: string; trace_id: string; }>(`/orgs/${orgId}/intelligence/replay/sessions`, { method: "POST", body: JSON.stringify(data) }),
  listSessions: (orgId: string) =>
    fetchApi<{ sessions: Array<{ session_id: string; trace_id: string; name: string | null; created_at: string }>; }>(`/orgs/${orgId}/intelligence/replay/sessions`),
  getTree: (orgId: string, sessionId: string) =>
    fetchApi<{ session_id: string; steps: Array<{ step_index: number; name: string; event_type: string }>; }>(`/orgs/${orgId}/intelligence/replay/sessions/${sessionId}/tree`),
  getMessageView: (orgId: string, sessionId: string) =>
    fetchApi<{ session_id: string; messages: Array<{ role: string; content: string; ts: string }>; }>(`/orgs/${orgId}/intelligence/replay/sessions/${sessionId}/messages`),
  decisionPath: (orgId: string, data: { trace_id: string }) =>
    fetchApi<{ trace_id: string; decisions: Array<{ step_index: number; decision: string; alternatives: string[]; chosen_reason: string }>; }>(`/orgs/${orgId}/intelligence/replay/decision/path`, { method: "POST", body: JSON.stringify(data) }),
  reasoningExplain: (orgId: string, data: { trace_id: string; step_index: number }) =>
    fetchApi<{ step_index: number; reasoning: string; supporting_evidence: string[]; }>(`/orgs/${orgId}/intelligence/replay/decision/explain`, { method: "POST", body: JSON.stringify(data) }),
};

// ── Intelligence: Time-Travel (Cat 20) ──────────────────────────────
export const timeTravelApi = {
  record: (orgId: string, data: { trace_id: string }) =>
    fetchApi<{ recording_id: string; trace_id: string; steps: number; }>(`/orgs/${orgId}/intelligence/time-travel/record`, { method: "POST", body: JSON.stringify(data) }),
  fork: (orgId: string, data: { recording_id: string; at_step: number; edited_state: Record<string, unknown> }) =>
    fetchApi<{ fork_id: string; from_step: number; new_state: Record<string, unknown>; }>(`/orgs/${orgId}/intelligence/time-travel/fork`, { method: "POST", body: JSON.stringify(data) }),
  replay: (orgId: string, data: { fork_id: string }) =>
    fetchApi<{ replay_id: string; final_state: Record<string, unknown>; steps_replayed: number; outcome: string; }>(`/orgs/${orgId}/intelligence/time-travel/replay`, { method: "POST", body: JSON.stringify(data) }),
};

// ── Intelligence: APM Depth (Cat 22) ────────────────────────────────
export const apmApi = {
  enrich: (orgId: string, data: { trace_id: string; resource_attrs?: Record<string, string> }) =>
    fetchApi<{ trace_id: string; enriched_attrs: Record<string, string>; }>(`/orgs/${orgId}/intelligence/apm-depth/enrich`, { method: "POST", body: JSON.stringify(data) }),
  stampSteps: (orgId: string, data: { trace_id: string }) =>
    fetchApi<{ trace_id: string; steps_stamped: number; }>(`/orgs/${orgId}/intelligence/apm-depth/steps/stamp`, { method: "POST", body: JSON.stringify(data) }),
  getSteps: (orgId: string, traceId: string) =>
    fetchApi<{ trace_id: string; steps: Array<{ step_index: number; evaluation_score: number | null; cost_cents: number; duration_ms: number }>; }>(`/orgs/${orgId}/intelligence/apm-depth/steps/${traceId}`),
  samplingEvaluate: (orgId: string, data: { trace_id: string; rules?: Record<string, unknown> }) =>
    fetchApi<{ keep: boolean; matched_rule: string; reason: string; }>(`/orgs/${orgId}/intelligence/apm-depth/sampling/evaluate`, { method: "POST", body: JSON.stringify(data) }),
  samplingStats: (orgId: string) =>
    fetchApi<{ total_evaluated: number; kept: number; dropped: number; by_rule: Record<string, number>; }>(`/orgs/${orgId}/intelligence/apm-depth/sampling/stats`),
  agentMetrics: (orgId: string) =>
    fetchApi<{ agents: Array<{ agent_id: string; task_completion_rate: number; tool_failure_rate: number; avg_iterations_to_success: number }>; }>(`/orgs/${orgId}/intelligence/apm-depth/metrics/agents`),
};

// ── Intelligence: Columnar (Cat 18) ─────────────────────────────────
export const columnarApi = {
  ensurePartitions: (orgId: string, data: { period?: string }) =>
    fetchApi<{ period: string; partitions_ensured: number; }>(`/orgs/${orgId}/intelligence/columnar/partitions/ensure`, { method: "POST", body: JSON.stringify(data) }),
  precomputeRollups: (orgId: string) =>
    fetchApi<{ rollups_computed: number; period: string; }>(`/orgs/${orgId}/intelligence/columnar/rollups/precompute`, { method: "POST" }),
  compact: (orgId: string) =>
    fetchApi<{ compacted: number; compacted_size_bytes: number; duration_ms: number; }>(`/orgs/${orgId}/intelligence/columnar/compact`, { method: "POST" }),
  query: (orgId: string, data: { sql: string; params?: Record<string, unknown> }) =>
    fetchApi<{ columns: string[]; rows: Array<Array<unknown>>; row_count: number; data_source: string; }>(`/orgs/${orgId}/intelligence/columnar/query`, { method: "POST", body: JSON.stringify(data) }),
};

// ── Intelligence: DSL / EQL (Cat 19) ────────────────────────────────
export const dslApi = {
  parse: (orgId: string, data: { query: string }) =>
    fetchApi<{ ast: Record<string, unknown>; valid: boolean; errors: string[]; }>(`/orgs/${orgId}/intelligence/dsl/parse`, { method: "POST", body: JSON.stringify(data) }),
  resolve: (orgId: string, data: { query: string }) =>
    fetchApi<{ sql: string; parameters: Record<string, unknown>; }>(`/orgs/${orgId}/intelligence/dsl/resolve`, { method: "POST", body: JSON.stringify(data) }),
  lint: (orgId: string, data: { query: string }) =>
    fetchApi<{ warnings: Array<{ line: number; column: number; severity: string; message: string }>; }>(`/orgs/${orgId}/intelligence/dsl/lint`, { method: "POST", body: JSON.stringify(data) }),
  compileAlert: (orgId: string, data: { query: string; name: string; severity?: string }) =>
    fetchApi<{ alert_id: string; name: string; sql: string; severity: string; }>(`/orgs/${orgId}/intelligence/dsl/alerts/compile`, { method: "POST", body: JSON.stringify(data) }),
  listAlerts: (orgId: string) =>
    fetchApi<{ alerts: Array<{ alert_id: string; name: string; severity: string; created_at: string; last_fired: string | null }>; }>(`/orgs/${orgId}/intelligence/dsl/alerts`),
};

// ── Intelligence: Metric Studio (Cat 21) ────────────────────────────
export const metricStudioApi = {
  listTemplates: (orgId: string) =>
    fetchApi<{ templates: Array<{ template_id: string; name: string; category: string; rubric: string; example_count: number }>; }>(`/orgs/${orgId}/intelligence/metric-studio/templates`),
  fromExamples: (orgId: string, data: { examples: Array<{ input: string; output: string; score: number; rationale: string }>; name: string }) =>
    fetchApi<{ metric_id: string; name: string; rubric: string; confidence: number; }>(`/orgs/${orgId}/intelligence/metric-studio/from-examples`, { method: "POST", body: JSON.stringify(data) }),
  createMetric: (orgId: string, data: { name: string; rubric: string; model?: string }) =>
    fetchApi<{ metric_id: string; name: string; rubric: string; model: string; version: string; }>(`/orgs/${orgId}/intelligence/metric-studio/metrics`, { method: "POST", body: JSON.stringify(data) }),
  listMetrics: (orgId: string) =>
    fetchApi<{ metrics: Array<{ metric_id: string; name: string; version: string; created_at: string; approved: boolean }>; }>(`/orgs/${orgId}/intelligence/metric-studio/metrics`),
  getMetric: (orgId: string, metricId: string) =>
    fetchApi<{ metric_id: string; name: string; rubric: string; model: string; version: string; history: Array<{ version: string; tagged_at: string }>; }>(`/orgs/${orgId}/intelligence/metric-studio/metrics/${metricId}`),
  approveMetric: (orgId: string, metricId: string) =>
    fetchApi<{ metric_id: string; approved: boolean; approved_at: string; }>(`/orgs/${orgId}/intelligence/metric-studio/metrics/${metricId}/approve`, { method: "POST" }),
};

// ── Intelligence: Agents (Cat 6) ────────────────────────────────────
export const intelligenceAgentsApi = {
  performance: (orgId: string) =>
    fetchApi<{ agents: Array<{ agent_id: string; name: string; success_rate: number; avg_latency_ms: number; trace_count: number }>; }>(`/orgs/${orgId}/intelligence/agents/performance`),
  relationships: (orgId: string) =>
    fetchApi<{ edges: Array<{ from_agent: string; to_agent: string; handoff_count: number; handoff_success_rate: number }>; }>(`/orgs/${orgId}/intelligence/agents/relationships`),
  handoffsAnalyze: (orgId: string, data: { from_agent?: string; to_agent?: string; days?: number }) =>
    fetchApi<{ handoffs: Array<{ from_agent: string; to_agent: string; count: number; success_rate: number; latency_ms: number }>; }>(`/orgs/${orgId}/intelligence/agents/handoffs/analyze`, { method: "POST", body: JSON.stringify(data) }),
  benchmarkRun: (orgId: string, data: { agent_id: string; suite: string }) =>
    fetchApi<{ benchmark_id: string; agent_id: string; suite: string; results: Array<{ task: string; passed: boolean; latency_ms: number }>; }>(`/orgs/${orgId}/intelligence/agents/benchmark/run`, { method: "POST", body: JSON.stringify(data) }),
  fleetIdentity: (orgId: string, data: { agent_id: string; display_name: string; tags?: string[] }) =>
    fetchApi<{ identity_id: string; agent_id: string; display_name: string; tags: string[]; }>(`/orgs/${orgId}/intelligence/agents/fleet/identity`, { method: "POST", body: JSON.stringify(data) }),
  fleetPermissions: (orgId: string, data: { agent_id: string; permissions: string[] }) =>
    fetchApi<{ agent_id: string; permissions: string[]; updated_at: string; }>(`/orgs/${orgId}/intelligence/agents/fleet/permissions`, { method: "POST", body: JSON.stringify(data) }),
};

// ── Intelligence: Governance (Cat 10) ───────────────────────────────
export const governanceApi = {
  listApprovals: (orgId: string) =>
    fetchApi<{ approvals: Array<{ request_id: string; requester: string; resource: string; status: string; created_at: string }>; }>(`/orgs/${orgId}/intelligence/governance/approvals`),
  requestApproval: (orgId: string, data: { resource: string; action: string; justification: string }) =>
    fetchApi<{ request_id: string; status: string; }>(`/orgs/${orgId}/intelligence/governance/approvals/request`, { method: "POST", body: JSON.stringify(data) }),
  resolveApproval: (orgId: string, requestId: string, data: { decision: "approve" | "deny"; reason?: string }) =>
    fetchApi<{ request_id: string; status: string; }>(`/orgs/${orgId}/intelligence/governance/approvals/${requestId}/resolve`, { method: "POST", body: JSON.stringify(data) }),
  compliancePacks: (orgId: string) =>
    fetchApi<{ packs: Array<{ evidence_pack_id: string; framework: string; generated_at: string; control_count: number }>; }>(`/orgs/${orgId}/intelligence/governance/compliance/packs`),
  securityScans: (orgId: string) =>
    fetchApi<{ scans: Array<{ scan_id: string; started_at: string; findings_count: number; severity: string }>; }>(`/orgs/${orgId}/intelligence/governance/security/scans`),
  rtbf: (orgId: string, data: { user_id: string; categories?: string[] }) =>
    fetchApi<{ request_id: string; status: string; affected_records: number; }>(`/orgs/${orgId}/intelligence/governance/rtbf`, { method: "POST", body: JSON.stringify(data) }),
  lineage: (orgId: string, data: { resource: string }) =>
    fetchApi<{ resource: string; graph: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }; }>(`/orgs/${orgId}/intelligence/governance/lineage`, { method: "POST", body: JSON.stringify(data) }),
  dashboard: (orgId: string) =>
    fetchApi<{ approvals_pending: number; compliance_packs: number; security_findings: number; rtbf_pending: number; }>(`/orgs/${orgId}/intelligence/governance/dashboard`),
};

// ── Attach all intelligence api namespaces to the `api` object ───────
// This lets consumers write `api.rcaApi.listIncidents(orgId)` etc.
(api as unknown as Record<string, unknown>).rcaApi = rcaApi;
(api as unknown as Record<string, unknown>).retrievalApi = retrievalApi;
(api as unknown as Record<string, unknown>).memoryApi = memoryApi;
(api as unknown as Record<string, unknown>).toolsApi = toolsApi;
(api as unknown as Record<string, unknown>).userApi = userApi;
(api as unknown as Record<string, unknown>).outcomesApi = outcomesApi;
(api as unknown as Record<string, unknown>).predictiveApi = predictiveApi;
(api as unknown as Record<string, unknown>).autonomousApi = autonomousApi;
(api as unknown as Record<string, unknown>).guardrailsApi = guardrailsApi;
(api as unknown as Record<string, unknown>).costApi = costApi;
(api as unknown as Record<string, unknown>).experimentsApi = experimentsApi;
(api as unknown as Record<string, unknown>).closedLoopApi = closedLoopApi;
(api as unknown as Record<string, unknown>).evalApi = evalApi;
(api as unknown as Record<string, unknown>).replayApi = replayApi;
(api as unknown as Record<string, unknown>).timeTravelApi = timeTravelApi;
(api as unknown as Record<string, unknown>).apmApi = apmApi;
(api as unknown as Record<string, unknown>).columnarApi = columnarApi;
(api as unknown as Record<string, unknown>).dslApi = dslApi;
(api as unknown as Record<string, unknown>).metricStudioApi = metricStudioApi;
(api as unknown as Record<string, unknown>).intelligenceAgentsApi = intelligenceAgentsApi;
(api as unknown as Record<string, unknown>).governanceApi = governanceApi;

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

export interface OnboardingPRRun {
  id: string;
  org_id: string;
  agent_id: string | null;
  repo_full_name: string;
  framework: string | null;
  language: string | null;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  status: "pending" | "opened" | "merged" | "closed" | "skipped" | "failed";
  detail: Record<string, unknown>;
  created_at: string;
  opened_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
}

export interface OnboardingState {
  org_id: string;
  step: "welcome" | "autonomous" | "org_setup" | "install_sdk" | "connect_github" | "wait_for_pr" | "done";
  org_setup_choice: "created" | "joined" | null;
  agents_onboarded: Array<{ agent_id?: string; agent_name?: string }>;
  completed_by_users: string[];
  updated_at: string;
}

export interface PendingInvite {
  invitation_id: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  role: string;
  expires_at: string | null;
  created_at: string | null;
  invited_by_name: string;
  invited_by_email: string;
}

export const githubApi = {
  configured: () =>
    fetchApi<{ configured: boolean; app_slug: string | null }>(
      `/integrations/github/configured`,
    ),
  authorize: (orgId: string) =>
    fetchApi<{ install_url: string; state: string }>(
      `/integrations/github/authorize`,
      { method: "GET", headers: { "X-Org-Id": orgId } },
    ),
  listInstallations: (orgId: string) =>
    fetchApi<GitHubInstallation[]>(
      `/orgs/${orgId}/github/installations`,
      { headers: { "X-Org-Id": orgId } },
    ),
  listRepos: (orgId: string) =>
    fetchApi<GitHubRepo[]>(
      `/orgs/${orgId}/github/repos`,
      { headers: { "X-Org-Id": orgId } },
    ),
  integrate: (
    orgId: string,
    body: { installation_id: number; repo_full_name: string; agent_id?: string; agent_name?: string },
  ) =>
    fetchApi<OnboardingPRRun>(`/orgs/${orgId}/github/integrate`, {
      method: "POST",
      headers: { "X-Org-Id": orgId },
      body: JSON.stringify(body),
    }),
};

export const onboardingApi = {
  getState: (orgId: string) =>
    fetchApi<OnboardingState>(`/orgs/${orgId}/onboarding/state`, {
      headers: { "X-Org-Id": orgId },
    }),
  patchState: (
    orgId: string,
    body: {
      step?: OnboardingState["step"];
      org_setup_choice?: "created" | "joined";
      mark_agent_onboarded?: { agent_id?: string; agent_name?: string };
    },
  ) =>
    fetchApi<OnboardingState>(`/orgs/${orgId}/onboarding/state`, {
      method: "POST",
      headers: { "X-Org-Id": orgId },
      body: JSON.stringify(body),
    }),
  listPrRuns: (orgId: string, limit = 50) =>
    fetchApi<OnboardingPRRun[]>(
      `/orgs/${orgId}/onboarding/pr-runs?limit=${limit}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  pendingInvites: () =>
    fetchApi<PendingInvite[]>(`/auth/me/pending-invites`),
};

// ── D.14 Cold-start UX (onboarding state machine v2) ──────────────────
//
// This is the NEW state machine backing the 7-step guided
// checklist (per upgradespec §10.1):
//
//   install → org → connect → wait → done → tour → autonomous
//
// It's a sibling to the Cat 23 ``onboardingApi`` above (which
// backs the github-app PR auto-instrumentation flow). The
// state machine is what the banner + checklist components
// render; the Cat 23 onboarding is the deeper wizard.
//
// Endpoints (per routes/onboarding.py):
//   GET   /v1/internal/onboarding/{org_id}/state
//   POST  /v1/internal/onboarding/{org_id}/advance
//   POST  /v1/internal/onboarding/{org_id}/milestone
//   POST  /v1/internal/onboarding/{org_id}/enable_cat
//
// The state has a ``source`` field; ``"legacy"`` means the org
// was created before the v2 cutover (2026-07-01) and the banner
// should NOT render. ``onboarding_v2_enabled`` is the explicit
// toggle surfaced for the same check.

export type OnboardingV2Step =
  | "install"
  | "org"
  | "connect"
  | "wait"
  | "done"
  | "tour"
  | "autonomous";

export interface OnboardingV2State {
  org_id: string;
  current_step: OnboardingV2Step;
  completed_steps: OnboardingV2Step[];
  cat_enablements: Record<string, { enabled_at: string; config: Record<string, unknown> }>;
  first_trace_at: string | null;
  milestones_reached: string[];
  created_at: string;
  updated_at: string;
  source: "db" | "defaults" | "legacy";
  onboarding_v2_enabled: boolean;
  last_audit: Record<string, unknown> | null;
}

export const onboardingV2Api = {
  getState: (orgId: string) =>
    fetchApi<{ data: OnboardingV2State; steps: OnboardingV2Step[] }>(
      `/v1/internal/onboarding/${orgId}/state`,
      { headers: { "X-Org-Id": orgId } },
    ),
  advance: (
    orgId: string,
    body: { target_step: OnboardingV2Step; force?: boolean },
  ) =>
    fetchApi<{ data: OnboardingV2State }>(
      `/v1/internal/onboarding/${orgId}/advance`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  recordMilestone: (orgId: string, milestone: string) =>
    fetchApi<{ data: OnboardingV2State }>(
      `/v1/internal/onboarding/${orgId}/milestone`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ milestone }),
      },
    ),
  enableCat: (
    orgId: string,
    catId: string,
    config: Record<string, unknown> = {},
  ) =>
    fetchApi<{ data: OnboardingV2State }>(
      `/v1/internal/onboarding/${orgId}/enable_cat`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ cat_id: catId, config }),
      },
    ),
};

(api as unknown as Record<string, unknown>).onboardingV2Api = onboardingV2Api;

(api as unknown as Record<string, unknown>).githubApi = githubApi;
(api as unknown as Record<string, unknown>).onboardingApi = onboardingApi;

// ── MCP traces (D.12.1) ──────────────────────────────────────────────
//
// Typed clients for ``/v1/traces/{id}/mcp`` + the auth-failure
// surface. The trace detail page can use ``getTraceMcp`` to render
// the MCP servers called by an agent; the org-admin auth-failure
// table is wired through ``listAuthFailures`` / ``recordAuthFailure``.

export interface McpTraceRow {
  trace_id: string;
  org_id: string;
  mcp_server_name: string | null;
  mcp_tool_name: string | null;
  mcp_resource_uri: string | null;
  mcp_prompt_name: string | null;
  mcp_sampling: boolean | null;
  mcp_transport: string | null;
  created_at: string;
}

export interface McpAuthFailureRow {
  id: string;
  org_id: string;
  server_name: string;
  transport: string | null;
  failure_kind: string;
  error_message: string | null;
  trace_id: string | null;
  span_id: string | null;
  occurred_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export const mcpApi = {
  getTraceMcp: (traceId: string) =>
    fetchApi<{ data: McpTraceRow[]; count: number }>(
      `/v1/traces/${traceId}/mcp`,
      { headers: { "X-Org-Id": "self" } },
    ),
  listAuthFailures: (
    orgId: string,
    params: { server_name?: string; resolved?: boolean; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.server_name) q.set("server_name", params.server_name);
    if (params.resolved !== undefined) q.set("resolved", String(params.resolved));
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return fetchApi<{ data: McpAuthFailureRow[]; count: number }>(
      `/v1/mcp/${orgId}/auth_failures${qs ? `?${qs}` : ""}`,
      { headers: { "X-Org-Id": orgId } },
    );
  },
  recordAuthFailure: (
    orgId: string,
    body: {
      server_name: string;
      failure_kind: string;
      transport?: string;
      error_message?: string;
      trace_id?: string;
      span_id?: string;
    },
  ) =>
    fetchApi<{ data: { id: string | null } }>(
      `/v1/mcp/${orgId}/auth_failures`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
};

(api as unknown as Record<string, unknown>).mcpApi = mcpApi;

// ── A2A links (D.12.2) ───────────────────────────────────────────────

export interface A2ALinkRow {
  id: string;
  org_id: string;
  parent_trace_id: string;
  child_trace_id: string;
  parent_agent_id: string;
  child_agent_id: string;
  parent_span_id: string;
  invocation_type: string;
  response_status: string | null;
  error_kind: string | null;
  created_at: string;
}

export interface A2AGraph {
  nodes: Record<string, { trace_id: string; is_root: boolean; depth: number }>;
  edges: Array<A2ALinkRow & { depth: number }>;
}

export const a2aApi = {
  getTraceA2a: (traceId: string) =>
    fetchApi<{
      data: { parent: A2ALinkRow[]; children: A2ALinkRow[] };
      count: number;
    }>(`/v1/traces/${traceId}/a2a`, { headers: { "X-Org-Id": "self" } }),
  registerLink: (
    orgId: string,
    body: {
      parent_trace_id: string;
      child_trace_id: string;
      parent_agent_id: string;
      child_agent_id: string;
      parent_span_id: string;
      invocation_type: string;
      response_status?: string;
    },
  ) =>
    fetchApi<{ data: { id: string | null } }>(
      `/v1/a2a/${orgId}/links`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  getInvocationGraph: (orgId: string, traceId: string, maxDepth = 4) =>
    fetchApi<{ data: A2AGraph; node_count: number; edge_count: number }>(
      `/v1/a2a/${orgId}/invocations/${traceId}?max_depth=${maxDepth}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  markLinkFailed: (
    orgId: string,
    linkId: string,
    errorKind: string,
  ) =>
    fetchApi<{ data: { id: string; marked_failed: boolean } }>(
      `/v1/a2a/${orgId}/links/${linkId}/fail`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ error_kind: errorKind }),
      },
    ),
};

(api as unknown as Record<string, unknown>).a2aApi = a2aApi;

// ── AI Agent (Phase C — unified panel) ───────────────────────────────────
//
// ``aiApi`` is the frontend surface for the Cat 14 real backend.
// Streaming chat uses native ``fetch`` + ``ReadableStream`` so the
// portal can render text deltas as they arrive instead of waiting
// for the SSE stream to close.

export interface AiToolCatalogEntry {
  name: string;
  summary: string;
  args: Record<string, { type: string; required?: boolean; default?: unknown; description?: string; enum?: string[] }>;
}

export interface AiCitation {
  kind: "span" | "trace" | "incident" | "agent" | "message" | "tool";
  id: string;
  label: string;
  excerpt?: string;
  trace_id?: string;
}

export interface AiChartSpec {
  type: "line" | "bar" | "pie" | "scatter" | "table" | "heatmap" | "sankey";
  title: string;
  data: Array<Record<string, unknown>>;
  unit?: string;
  x_key?: string;
  y_key?: string;
  y2_key?: string;
  group_key?: string;
  label_key?: string;
  value_key?: string;
  row_key?: string;
  col_key?: string;
  source_key?: string;
  target_key?: string;
  columns?: string[];
}

export interface AiToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  latency_ms?: number;
}

export interface AiChunkHandler {
  onTextDelta?: (text: string) => void;
  onToolCall?: (tc: AiToolCall) => void;
  onChart?: (chart: AiChartSpec) => void;
  onCitation?: (cite: AiCitation) => void;
  onDone?: (summary: { conversation_id: string; turns: number; prompt_tokens: number; completion_tokens: number }) => void;
  onError?: (error: string) => void;
}

export interface AiChatRequest {
  conversation_id?: string | null;
  message: string;
  page_context?: Record<string, unknown>;
}

export interface AiConversationSummary {
  id: string;
  title: string;
  page_context?: Record<string, unknown>;
  turn_count: number;
  total_tokens: number;
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
  last_message_at?: string | null;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls: AiToolCall[];
  chart_specs: AiChartSpec[];
  citations: AiCitation[];
  prompt_tokens: number;
  completion_tokens: number;
  model_used?: string | null;
  created_at: string;
}

export interface AiConversationDetail {
  conversation: AiConversationSummary;
  messages: AiMessage[];
}

export const aiApi = {
  tools: (orgId: string) =>
    fetchApi<AiToolCatalogEntry[]>(`/orgs/${orgId}/ai/tools`, {
      headers: { "X-Org-Id": orgId },
    }),

  listConversations: (orgId: string, limit = 50) =>
    fetchApi<AiConversationSummary[]>(`/orgs/${orgId}/ai/conversations?limit=${limit}`, {
      headers: { "X-Org-Id": orgId },
    }),

  getConversation: (orgId: string, conversationId: string) =>
    fetchApi<AiConversationDetail>(
      `/orgs/${orgId}/ai/conversations/${conversationId}`,
      { headers: { "X-Org-Id": orgId },
    }),

  archiveConversation: (orgId: string, conversationId: string) =>
    fetchApi<{ archived: boolean; conversation_id: string }>(
      `/orgs/${orgId}/ai/conversations/${conversationId}`,
      { method: "DELETE", headers: { "X-Org-Id": orgId } },
    ),

  /**
   * Stream a chat turn via SSE. The handler callbacks fire as events
   * arrive — text deltas, tool calls, charts, citations, then done.
   * Returns an AbortController so the caller can cancel the stream
   * (e.g. on panel close).
   */
  streamChat: async (
    orgId: string,
    body: AiChatRequest,
    handler: AiChunkHandler,
  ): Promise<AbortController> => {
    const controller = new AbortController();
    const url = `${API_BASE}/orgs/${orgId}/ai/chat`;
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Org-Id": orgId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        handler.onError?.(`chat_failed: ${res.status}`);
        return controller;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // SSE: events separated by blank lines, each line prefixed with
      // "data: " (or "event:" etc).
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // Process each complete SSE event (terminated by blank line).
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const eventText = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          // Walk the data lines; an SSE "data:" may span multiple
          // lines, joined by "\n".
          const dataLines = eventText
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice("data: ".length))
            .join("\n");
          if (!dataLines) continue;
          let parsed: { type?: string; text?: string; tool_call?: AiToolCall;
                        chart?: AiChartSpec; citation?: AiCitation;
                        error?: string;
                        conversation_id?: string; turns?: number;
                        prompt_tokens?: number; completion_tokens?: number };
          try {
            parsed = JSON.parse(dataLines);
          } catch {
            continue;
          }
          switch (parsed.type) {
            case "text_delta":
              handler.onTextDelta?.(parsed.text ?? "");
              break;
            case "tool_call":
              if (parsed.tool_call) handler.onToolCall?.(parsed.tool_call);
              break;
            case "chart":
              if (parsed.chart) handler.onChart?.(parsed.chart);
              break;
            case "citation":
              if (parsed.citation) handler.onCitation?.(parsed.citation);
              break;
            case "error":
              handler.onError?.(parsed.error ?? "unknown_error");
              break;
            case "summary":
              handler.onDone?.({
                conversation_id: parsed.conversation_id ?? "",
                turns: parsed.turns ?? 0,
                prompt_tokens: parsed.prompt_tokens ?? 0,
                completion_tokens: parsed.completion_tokens ?? 0,
              });
              break;
            case "done":
              handler.onDone?.({
                conversation_id: "",
                turns: 0,
                prompt_tokens: 0,
                completion_tokens: 0,
              });
              break;
            default:
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        handler.onError?.(`stream_error: ${(err as Error).message}`);
      }
    }
    return controller;
  },
};

(api as unknown as Record<string, unknown>).aiApi = aiApi;

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
    fetchApi<LabelingAnnotation>(`/orgs/${orgId}/labeling/items/annotate`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  seedItem: (orgId: string, body: { prompt: string; tags?: string[] }) =>
    fetchApi<LabelingItem>(`/orgs/${orgId}/labeling/items`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
};

// ── Signals (Phase Q) ────────────────────────────────────────────────

export interface Signal {
  id: string;
  name: string;
  description: string;
  natural_query: string;
  compiled_sql?: string;
  status: "draft" | "compiled" | "active" | "error";
  last_compiled_at?: string;
  created_at: string;
}

const signalsApi = {
  list: (orgId: string) =>
    fetchApi<{ signals: Signal[]; total: number }>(
      `/orgs/${orgId}/signals`,
      { headers: { "X-Org-Id": orgId } },
    ),
  create: (orgId: string, body: { name: string; description: string; natural_query: string }) =>
    fetchApi<Signal>(`/orgs/${orgId}/signals`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  compile: (orgId: string, signalId: string) =>
    fetchApi<Signal>(`/orgs/${orgId}/signals/${signalId}/compile`, {
      method: "POST",
      headers: { "X-Org-Id": orgId },
    }),
};

// ── Debugger (Phase P) ───────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  trace_id: string;
  label: string;
  step_index: number;
  created_at: string;
  payload_keys: string[];
}

const debuggerApi = {
  listCheckpoints: (orgId: string, traceId?: string) =>
    fetchApi<{ checkpoints: Checkpoint[]; total: number }>(
      `/orgs/${orgId}/debugger/checkpoints${traceId ? `?trace_id=${traceId}` : ""}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  rewind: (orgId: string, checkpointId: string) =>
    fetchApi<{ ok: boolean; replayed_to: string }>(
      `/orgs/${orgId}/debugger/rewind/${checkpointId}`,
      { method: "POST", headers: { "X-Org-Id": orgId } },
    ),
  rerun: (orgId: string, body: { trace_id: string; from_step?: number }) =>
    fetchApi<{ trace_id: string; status: string }>(
      `/orgs/${orgId}/debugger/rerun`,
      { method: "POST", headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify(body) },
    ),
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

const qaApi = {
  listRuns: (orgId: string) =>
    fetchApi<{ runs: QARun[]; total: number; detail?: string }>(
      `/orgs/${orgId}/synthetic/runs`,
      { headers: { "X-Org-Id": orgId } },
    ),
  generate: (orgId: string, body: { topic: string; count: number; model?: string }) =>
    fetchApi<QARun>(`/orgs/${orgId}/synthetic/runs`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
};

// ── Redteam (Phase L) ────────────────────────────────────────────────

export interface RedteamFinding {
  id: string;
  probe: string;
  prompt: string;
  response: string;
  severity: "low" | "medium" | "high" | "critical";
  category: string;
  created_at: string;
}

export interface RedteamScan {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  probes: string[];
  created_at: string;
  completed_at?: string;
  findings_count?: number;
}

const redteamApi = {
  listFindings: (orgId: string) =>
    fetchApi<{ findings: RedteamFinding[]; total: number }>(
      `/orgs/${orgId}/redteam/findings`,
      { headers: { "X-Org-Id": orgId } },
    ),
  listProbes: (orgId: string) =>
    fetchApi<{ probes: { id: string; name: string; description: string }[] }>(
      `/orgs/${orgId}/redteam/probes`,
      { headers: { "X-Org-Id": orgId } },
    ),
  runScan: (orgId: string, body: { probe_ids: string[]; target_prompt: string }) =>
    fetchApi<RedteamScan>(`/orgs/${orgId}/redteam/scans`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
};

// ── Datasets (Phase S — spreadsheet) ─────────────────────────────────

export interface DatasetColumn {
  id: string;
  name: string;
  kind: "text" | "number" | "json" | "ai_fill";
  description?: string;
}

export interface DatasetRow {
  id: string;
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
  addRow: (orgId: string, datasetId: string, values: Record<string, unknown>) =>
    fetchApi<DatasetRow>(`/orgs/${orgId}/datasets/${datasetId}/rows`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }),
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
};

(api as unknown as Record<string, unknown>).labelingApi = labelingApi;
(api as unknown as Record<string, unknown>).signalsApi = signalsApi;
(api as unknown as Record<string, unknown>).debuggerApi = debuggerApi;
(api as unknown as Record<string, unknown>).qaApi = qaApi;
(api as unknown as Record<string, unknown>).redteamApi = redteamApi;
(api as unknown as Record<string, unknown>).datasetsApi = datasetsApi;

export { labelingApi, signalsApi, debuggerApi, qaApi, redteamApi, datasetsApi };

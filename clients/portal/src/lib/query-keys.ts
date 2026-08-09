/**
 * queryKeys — canonical React Query key factory for the portal.
 *
 * Convention: `[domain, resource, orgId, ...filters]`. The leading
 * `[domain]` tuple doubles as an invalidation target — e.g.
 * `queryClient.invalidateQueries({ queryKey: queryKeys.alerts.all })`
 * invalidates every alerts-scoped query regardless of orgId/filters,
 * while `queryClient.invalidateQueries({ queryKey: queryKeys.alerts.list(orgId) })`
 * only invalidates that org's list.
 *
 * Keep filter objects small and JSON-serializable — React Query hashes
 * the key via a stable stringify, so key equality is structural, not
 * referential (a fresh `{}` literal every render is safe).
 */
export const queryKeys = {
  agents: {
    all: ["agents"] as const,
    list: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["agents", "list", orgId, filters ?? {}] as const,
    detail: (orgId: string | null | undefined, agentId: string | null | undefined) =>
      ["agents", "detail", orgId, agentId] as const,
    sessions: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["agents", "sessions", orgId, filters ?? {}] as const,
    session: (orgId: string | null | undefined, sessionId: string | null | undefined) =>
      ["agents", "session", orgId, sessionId] as const,
    sessionTraces: (
      orgId: string | null | undefined,
      sessionId: string | null | undefined,
      traceIdsKey?: string | null,
    ) => ["agents", "sessionTraces", orgId, sessionId, traceIdsKey ?? null] as const,
  },
  alerts: {
    all: ["alerts"] as const,
    list: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["alerts", "list", orgId, filters ?? {}] as const,
    rules: (orgId: string | null | undefined) => ["alerts", "rules", orgId] as const,
    nlRules: (orgId: string | null | undefined) => ["alerts", "nl-rules", orgId] as const,
    events: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["alerts", "events", orgId, filters ?? {}] as const,
  },
  gateway: {
    all: ["gateway"] as const,
    models: (orgId: string | null | undefined) =>
      ["gateway", "models", orgId] as const,
    explorer: (orgId: string | null | undefined, hours: number) =>
      ["gateway", "explorer", orgId, hours] as const,
    overview: (orgId: string | null | undefined, hours: number) =>
      ["gateway", "overview", orgId, hours] as const,
    tokens: (orgId: string | null | undefined, days: number) =>
      ["gateway", "tokens", orgId, days] as const,
    cache: (orgId: string | null | undefined) =>
      ["gateway", "cache", orgId] as const,
    health: (orgId: string | null | undefined) =>
      ["gateway", "health", orgId] as const,
    topModels: (orgId: string | null | undefined, days: number) =>
      ["gateway", "topModels", orgId, days] as const,
  },
  github: {
    all: ["github"] as const,
    connection: (
      orgId: string | null | undefined,
      agentId?: string | null,
    ) => ["github", "connection", orgId, agentId ?? null] as const,
    repos: (orgId: string | null | undefined) =>
      ["github", "repos", orgId] as const,
    configured: ["github", "configured"] as const,
  },
  timeTravel: {
    all: ["timeTravel"] as const,
    forks: (
      orgId: string | null | undefined,
      parentTraceId: string | null | undefined,
    ) => ["timeTravel", "forks", orgId, parentTraceId ?? null] as const,
    steps: (
      orgId: string | null | undefined,
      parentTraceId: string | null | undefined,
    ) => ["timeTravel", "steps", orgId, parentTraceId ?? null] as const,
  },
  /** Per-trace RCA causal chain (FEAT-65) — `GET .../intelligence/rca/{traceId}/chain`. */
  rcaChain: {
    all: ["rcaChain"] as const,
    detail: (
      orgId: string | null | undefined,
      traceId: string | null | undefined,
    ) => ["rcaChain", "detail", orgId, traceId ?? null] as const,
  },
  /** Portal read-model projections (`GET /orgs/{id}/portal/*`). */
  portal: {
    all: ["portal"] as const,
    agents: (orgId: string | null | undefined) =>
      ["portal", "agents", orgId] as const,
    traces: (orgId: string | null | undefined, agentId?: string | null) =>
      ["portal", "traces", orgId, agentId ?? null] as const,
    traceDetail: (
      orgId: string | null | undefined,
      traceId: string | null | undefined,
    ) => ["portal", "traceDetail", orgId, traceId] as const,
    sessions: (orgId: string | null | undefined) =>
      ["portal", "sessions", orgId] as const,
    issues: (orgId: string | null | undefined) =>
      ["portal", "issues", orgId] as const,
    signals: (orgId: string | null | undefined) =>
      ["portal", "signals", orgId] as const,
    alertRules: (orgId: string | null | undefined) =>
      ["portal", "alertRules", orgId] as const,
    nlAlertRules: (orgId: string | null | undefined) =>
      ["portal", "nlAlertRules", orgId] as const,
    alertSuppressionRules: (orgId: string | null | undefined) =>
      ["portal", "alertSuppressionRules", orgId] as const,
    alertEvents: (orgId: string | null | undefined) =>
      ["portal", "alertEvents", orgId] as const,
    costDrivers: (orgId: string | null | undefined) =>
      ["portal", "costDrivers", orgId] as const,
    workspace: (orgId: string | null | undefined) =>
      ["portal", "workspace", orgId] as const,
    keys: (orgId: string | null | undefined) =>
      ["portal", "keys", orgId] as const,
    ssoProviders: (orgId: string | null | undefined) =>
      ["portal", "sso-providers", orgId] as const,
    roles: (orgId: string | null | undefined) =>
      ["portal", "roles", orgId] as const,
    roleAssignments: (orgId: string | null | undefined, roleId: string | null | undefined) =>
      ["portal", "role-assignments", orgId, roleId] as const,
    permissionsCatalogue: (orgId: string | null | undefined) =>
      ["portal", "permissions-catalogue", orgId] as const,
    topics: (orgId: string | null | undefined, facet?: string | null) =>
      ["portal", "topics", orgId, facet ?? null] as const,
    piiPolicy: (orgId: string | null | undefined) =>
      ["portal", "pii-policy", orgId] as const,
    members: (orgId: string | null | undefined) =>
      ["portal", "members", orgId] as const,
    auditEvents: (orgId: string | null | undefined) =>
      ["portal", "auditEvents", orgId] as const,
    auditPacks: (orgId: string | null | undefined) =>
      ["portal", "auditPacks", orgId] as const,
    auditChainVerify: (orgId: string | null | undefined) =>
      ["portal", "auditChainVerify", orgId] as const,
    slackInstall: (orgId: string | null | undefined) =>
      ["portal", "slackInstall", orgId] as const,
    slackChannels: (orgId: string | null | undefined) =>
      ["portal", "slackChannels", orgId] as const,
    slackRoutes: (orgId: string | null | undefined) =>
      ["portal", "slackRoutes", orgId] as const,
    autonomyPolicy: (orgId: string | null | undefined) =>
      ["portal", "autonomyPolicy", orgId] as const,
    autonomyAudit: (orgId: string | null | undefined) =>
      ["portal", "autonomyAudit", orgId] as const,
    autonomyBudget: (orgId: string | null | undefined) =>
      ["portal", "autonomyBudget", orgId] as const,
    evalDatasets: (orgId: string | null | undefined) =>
      ["portal", "evalDatasets", orgId] as const,
    evalPlaygrounds: (orgId: string | null | undefined) =>
      ["portal", "evalPlaygrounds", orgId] as const,
    // U03 playgrounds surface — distinct from evalPlaygrounds (that key
    // caches the portal read-model shape used by the Evals hub).
    playgrounds: (orgId: string | null | undefined) =>
      ["portal", "playgrounds", orgId] as const,
    playgroundDetail: (
      orgId: string | null | undefined,
      playgroundId: string | null | undefined,
    ) => ["portal", "playgroundDetail", orgId, playgroundId] as const,
    evalExperiments: (orgId: string | null | undefined) =>
      ["portal", "evalExperiments", orgId] as const,
    improvePlans: (orgId: string | null | undefined) =>
      ["portal", "improvePlans", orgId] as const,
    // M13: live Fix now / Improve later cockpit queue.
    improveQueue: (orgId: string | null | undefined) =>
      ["portal", "improveQueue", orgId] as const,
    compareExperiments: (orgId: string | null | undefined) =>
      ["portal", "compareExperiments", orgId] as const,
    guardrailPolicies: (orgId: string | null | undefined) =>
      ["portal", "guardrailPolicies", orgId] as const,
    redteamProbes: (orgId: string | null | undefined) =>
      ["portal", "redteamProbes", orgId] as const,
    redteamFindings: (orgId: string | null | undefined) =>
      ["portal", "redteamFindings", orgId] as const,
    drift: (orgId: string | null | undefined, agentId: string | null | undefined) =>
      ["portal", "drift", orgId, agentId] as const,
    debuggerSessions: (orgId: string | null | undefined) =>
      ["portal", "debuggerSessions", orgId] as const,
    assistantThreads: (orgId: string | null | undefined) =>
      ["portal", "assistantThreads", orgId] as const,
  },
  promptsV2: {
    all: ["promptsV2"] as const,
    list: (orgId: string | null | undefined) =>
      ["promptsV2", "list", orgId] as const,
    detail: (orgId: string | null | undefined, name: string | null | undefined) =>
      ["promptsV2", "detail", orgId, name] as const,
    pins: (orgId: string | null | undefined, name: string | null | undefined) =>
      ["promptsV2", "pins", orgId, name] as const,
  },
  artifacts: {
    all: ["artifacts"] as const,
    list: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["artifacts", "list", orgId, filters ?? {}] as const,
    context: (orgId: string | null | undefined, agentId: string | null | undefined) =>
      ["artifacts", "context", orgId, agentId] as const,
    demotions: (
      orgId: string | null | undefined,
      filters?: Record<string, unknown>,
    ) => ["artifacts", "demotions", orgId, filters ?? {}] as const,
  },
  ledger: {
    all: ["ledger"] as const,
    list: (orgId: string | null | undefined) => ["ledger", "list", orgId] as const,
    detail: (orgId: string | null | undefined, agentId: string | null | undefined) =>
      ["ledger", "detail", orgId, agentId] as const,
  },
  /** Org-wide fleet health (`GET /orgs/{id}/fleet/*`), gated by `fleet_health_v1`. */
  fleet: {
    all: ["fleet"] as const,
    delegation: (orgId: string | null | undefined) =>
      ["fleet", "delegation", orgId] as const,
  },
  /** Session analytics (`GET /orgs/{id}/analytics/cohorts`, FEAT-139). */
  analytics: {
    all: ["analytics"] as const,
    cohorts: (orgId: string | null | undefined, weeks: number) =>
      ["analytics", "cohorts", orgId, weeks] as const,
  },
  /** Labeling queues (`GET /orgs/{id}/labeling/*`) — FEAT-82/FEAT-83. */
  labeling: {
    all: ["labeling"] as const,
    queues: (orgId: string | null | undefined) =>
      ["labeling", "queues", orgId] as const,
    items: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["labeling", "items", orgId, filters ?? {}] as const,
    agreement: (
      orgId: string | null | undefined,
      itemIds?: readonly string[],
    ) => ["labeling", "agreement", orgId, itemIds ?? []] as const,
    pop: (
      orgId: string | null | undefined,
      userId: string | null | undefined,
      strategy?: string,
    ) => ["labeling", "pop", orgId, userId, strategy ?? "fifo"] as const,
    board: (orgId: string | null | undefined, queueId: string | null | undefined) =>
      ["labeling", "board", orgId, queueId] as const,
  },
} as const;

/**
 * Generic escape hatch for one-off queries that don't warrant a
 * dedicated builder above — still follows the `[domain, orgId,
 * ...filters]` convention so the in-flight/GET cache dedupes
 * correctly across call sites.
 */
export function queryKey(
  domain: string,
  orgId: string | null | undefined,
  ...filters: unknown[]
): readonly unknown[] {
  return [domain, orgId, ...filters] as const;
}

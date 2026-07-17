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
  dashboard: {
    all: ["dashboard"] as const,
    summary: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["dashboard", "summary", orgId, filters ?? {}] as const,
    agentic: (orgId: string | null | undefined) =>
      ["dashboard", "agentic", orgId] as const,
  },
  observability: {
    all: ["observability"] as const,
    summary: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["observability", "summary", orgId, filters ?? {}] as const,
    traces: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["observability", "traces", orgId, filters ?? {}] as const,
    trace: (orgId: string | null | undefined, traceId: string | null | undefined) =>
      ["observability", "trace", orgId, traceId] as const,
    tree: (orgId: string | null | undefined, traceId: string | null | undefined) =>
      ["observability", "tree", orgId, traceId] as const,
    timeline: (orgId: string | null | undefined, traceId: string | null | undefined) =>
      ["observability", "timeline", orgId, traceId] as const,
    heatmap: (orgId: string | null | undefined, metric: string, filters?: Record<string, unknown>) =>
      ["observability", "heatmap", orgId, metric, filters ?? {}] as const,
    spans: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["observability", "spans", orgId, filters ?? {}] as const,
  },
  agents: {
    all: ["agents"] as const,
    list: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["agents", "list", orgId, filters ?? {}] as const,
    sessions: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["agents", "sessions", orgId, filters ?? {}] as const,
    session: (orgId: string | null | undefined, sessionId: string | null | undefined) =>
      ["agents", "session", orgId, sessionId] as const,
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
  cost: {
    all: ["cost"] as const,
    comparison: (orgId: string | null | undefined) => ["cost", "comparison", orgId] as const,
    efficiency: (orgId: string | null | undefined, days?: number) =>
      ["cost", "efficiency", orgId, days ?? null] as const,
    roi: (orgId: string | null | undefined, days?: number) =>
      ["cost", "roi", orgId, days ?? null] as const,
    anomalies: (orgId: string | null | undefined, days?: number) =>
      ["cost", "anomalies", orgId, days ?? null] as const,
    forecast: (orgId: string | null | undefined) => ["cost", "forecast", orgId] as const,
  },
  optimization: {
    all: ["optimization"] as const,
    overview: (orgId: string | null | undefined, days?: number) =>
      ["optimization", "overview", orgId, days ?? null] as const,
  },
  insights: {
    all: ["insights"] as const,
    overview: (orgId: string | null | undefined) => ["insights", "overview", orgId] as const,
    correlation: (orgId: string | null | undefined, days?: number) =>
      ["insights", "correlation", orgId, days ?? null] as const,
  },
  issues: {
    all: ["issues"] as const,
    list: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["issues", "list", orgId, filters ?? {}] as const,
    detail: (orgId: string | null | undefined, issueId: string | null | undefined) =>
      ["issues", "detail", orgId, issueId] as const,
    stumbles: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["issues", "stumbles", orgId, filters ?? {}] as const,
    experiments: (orgId: string | null | undefined, issueId: string | null | undefined) =>
      ["issues", "experiments", orgId, issueId] as const,
  },
  fleet: {
    all: ["fleet"] as const,
    summary: (orgId: string | null | undefined) => ["fleet", "summary", orgId] as const,
    heatmap: (orgId: string | null | undefined) => ["fleet", "heatmap", orgId] as const,
    delegation: (orgId: string | null | undefined) => ["fleet", "delegation", orgId] as const,
    slaBreaches: (orgId: string | null | undefined) => ["fleet", "slaBreaches", orgId] as const,
    agentic: (orgId: string | null | undefined) => ["fleet", "agentic", orgId] as const,
  },
  compliance: {
    all: ["compliance"] as const,
    ledger: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["compliance", "ledger", orgId, filters ?? {}] as const,
    verify: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["compliance", "verify", orgId, filters ?? {}] as const,
  },
  analytics: {
    all: ["analytics"] as const,
    tokenUsage: (orgId: string | null | undefined, days?: number) =>
      ["analytics", "tokenUsage", orgId, days ?? null] as const,
    latency: (orgId: string | null | undefined, days?: number) =>
      ["analytics", "latency", orgId, days ?? null] as const,
    throughput: (orgId: string | null | undefined, days?: number) =>
      ["analytics", "throughput", orgId, days ?? null] as const,
    topAgents: (orgId: string | null | undefined, days?: number) =>
      ["analytics", "topAgents", orgId, days ?? null] as const,
  },
  improve: {
    all: ["improve"] as const,
    queue: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["improve", "queue", orgId, filters ?? {}] as const,
    plans: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["improve", "plans", orgId, filters ?? {}] as const,
    plan: (orgId: string | null | undefined, planId: string | null | undefined) =>
      ["improve", "plan", orgId, planId] as const,
    runs: (orgId: string | null | undefined) => ["improve", "runs", orgId] as const,
    schedule: (orgId: string | null | undefined) => ["improve", "schedule", orgId] as const,
  },
  settings: {
    all: ["settings"] as const,
    members: (orgId: string | null | undefined) => ["settings", "members", orgId] as const,
    apiKeys: (orgId: string | null | undefined) => ["settings", "apiKeys", orgId] as const,
    billing: (orgId: string | null | undefined) => ["settings", "billing", orgId] as const,
  },
  users: {
    all: ["users"] as const,
    sessions: (orgId: string | null | undefined, days?: number) =>
      ["users", "sessions", orgId, days ?? null] as const,
    goals: (orgId: string | null | undefined) => ["users", "goals", orgId] as const,
    cohorts: (orgId: string | null | undefined) => ["users", "cohorts", orgId] as const,
    segments: (orgId: string | null | undefined) => ["users", "segments", orgId] as const,
  },
  tools: {
    all: ["tools"] as const,
    attribution: (orgId: string | null | undefined, days?: number) =>
      ["tools", "attribution", orgId, days ?? null] as const,
    taxonomy: (orgId: string | null | undefined) => ["tools", "taxonomy", orgId] as const,
  },
  prompts: {
    all: ["prompts"] as const,
    list: (orgId: string | null | undefined) => ["prompts", "list", orgId] as const,
    versions: (orgId: string | null | undefined, name: string | null | undefined) =>
      ["prompts", "versions", orgId, name] as const,
  },
  incidents: {
    all: ["incidents"] as const,
    list: (orgId: string | null | undefined) => ["incidents", "list", orgId] as const,
    summary: (orgId: string | null | undefined, clusterId: string | null | undefined) =>
      ["incidents", "summary", orgId, clusterId] as const,
  },
  outcomes: {
    all: ["outcomes"] as const,
    departments: (orgId: string | null | undefined) => ["outcomes", "departments", orgId] as const,
    analytics: (orgId: string | null | undefined) => ["outcomes", "analytics", orgId] as const,
  },
  predict: {
    all: ["predict"] as const,
    quality: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["predict", "quality", orgId, filters ?? {}] as const,
    drift: (orgId: string | null | undefined) => ["predict", "drift", orgId] as const,
  },
  budget: {
    all: ["budget"] as const,
    detail: (orgId: string | null | undefined) => ["budget", "detail", orgId] as const,
    actions: (orgId: string | null | undefined) => ["budget", "actions", orgId] as const,
  },
  finops: {
    all: ["finops"] as const,
    explorer: (orgId: string | null | undefined, hours: number) =>
      ["finops", "explorer", orgId, hours] as const,
  },
  redteam: {
    all: ["redteam"] as const,
    findings: (orgId: string | null | undefined) => ["redteam", "findings", orgId] as const,
  },
  autonomous: {
    all: ["autonomous"] as const,
    recommendations: (orgId: string | null | undefined) => ["autonomous", "recommendations", orgId] as const,
  },
  closedLoop: {
    all: ["closedLoop"] as const,
    board: (orgId: string | null | undefined) => ["closedLoop", "board", orgId] as const,
  },
  prSuggestions: {
    all: ["prSuggestions"] as const,
    list: (orgId: string | null | undefined, filters?: Record<string, unknown>) =>
      ["prSuggestions", "list", orgId, filters ?? {}] as const,
    detail: (orgId: string | null | undefined, suggestionId: string | null | undefined) =>
      ["prSuggestions", "detail", orgId, suggestionId] as const,
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

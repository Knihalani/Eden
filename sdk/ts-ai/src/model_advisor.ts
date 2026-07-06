/**
 * @eden-ai/sdk — model comparison + recommendation client.
 *
 * Mirrors the Python SDK's `ModelAdvisor`. Lets a TypeScript agent
 * query the same `/orgs/{org_id}/models/{compare,recommend,project}`
 * endpoints that power the portal's "switch to save $X" widgets.
 *
 * Usage
 * -----
 * ```ts
 * import { ModelAdvisor } from "@eden-ai/sdk";
 *
 * const advisor = new ModelAdvisor({ apiKey: "...", orgId: "..." });
 * const rec = await advisor.recommend({
 *   candidates: [
 *     { provider: "openai", modelId: "gpt-4o" },
 *     { provider: "anthropic", modelId: "claude-sonnet-4-6" },
 *   ],
 *   current: { provider: "openai", modelId: "gpt-4o" },
 * });
 * console.log(rec.recommendedModelId);
 * ```
 */

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ModelSpec {
  provider: string;
  modelId: string;
  quality: number;
  latencyP95Ms: number;
  reliability: number;
  contextWindow: number;
  costPer1kInput: number;
  costPer1kOutput: number;
  costPer1kCacheRead: number | null;
  costPer1kCacheWrite: number | null;
  source: string;
}

export interface ModelComparison {
  current: ModelSpec;
  candidate: ModelSpec;
  deltaCostPer1kInput: number;
  deltaCostPer1kOutput: number;
  deltaQuality: number;
  deltaLatencyP95Ms: number;
  deltaReliability: number;
  costRatio: number;
}

export interface SwitchProjection {
  currentProvider: string;
  currentModelId: string;
  candidateProvider: string;
  candidateModelId: string;
  currentTotalUsd: number;
  projectedTotalUsd: number;
  savingsUsd: number;
  savingsPct: number;
  perRequestSavingsUsd: number;
  cacheSavingsUsd: number;
  windowDays: number;
  requestsInWindow: number;
}

export interface RunnerUp {
  provider: string;
  modelId: string;
  score: number;
  rationale: string;
}

export interface Recommendation {
  recommendedProvider: string;
  recommendedModelId: string;
  score: number;
  rationale: string;
  monthlySavingsUsd: number | null;
  currentProvider: string | null;
  currentModelId: string | null;
  runnersUp: RunnerUp[];
  emptyHistory: boolean;
}

export interface ModelAdvisorOptions {
  apiKey?: string;
  orgId?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RecommendOptions {
  candidates: ModelRef[];
  current?: ModelRef;
  windowDays?: number;
}

export interface ProjectOptions {
  current: ModelRef;
  candidate: ModelRef;
  scaleFactor?: number;
  windowDays?: number;
}

// ─────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────

export class ModelAdvisorError extends Error {
  readonly statusCode: number;
  readonly reason: string;
  readonly body: unknown;

  constructor(statusCode: number, reason: string, body?: unknown) {
    super(`${statusCode} ${reason}`);
    this.name = "ModelAdvisorError";
    this.statusCode = statusCode;
    this.reason = reason;
    this.body = body;
  }
}

// ─────────────────────────────────────────────────────────────────────
// API response shapes (snake_case) -> domain shapes (camelCase)
// ─────────────────────────────────────────────────────────────────────

interface ApiModelSpec {
  provider: string;
  model_id: string;
  quality: number;
  latency_p95_ms: number;
  reliability: number;
  context_window: number;
  cost_per_1k_input: number;
  cost_per_1k_output: number;
  cost_per_1k_cache_read: number | null;
  cost_per_1k_cache_write: number | null;
  source: string;
}

interface ApiRunnerUp {
  provider: string;
  model_id: string;
  score: number;
  rationale: string;
}

interface ApiRecommendation {
  recommended_provider: string;
  recommended_model_id: string;
  score: number;
  rationale: string;
  monthly_savings_usd: number | null;
  current_provider: string | null;
  current_model_id: string | null;
  runners_up: ApiRunnerUp[];
  empty_history: boolean;
}

interface ApiModelComparison {
  current: ApiModelSpec;
  candidate: ApiModelSpec;
  delta_cost_per_1k_input: number;
  delta_cost_per_1k_output: number;
  delta_quality: number;
  delta_latency_p95_ms: number;
  delta_reliability: number;
  cost_ratio: number;
}

interface ApiSwitchProjection {
  current_provider: string;
  current_model_id: string;
  candidate_provider: string;
  candidate_model_id: string;
  current_total_usd: number;
  projected_total_usd: number;
  savings_usd: number;
  savings_pct: number;
  per_request_savings_usd: number;
  cache_savings_usd: number;
  window_days: number;
  requests_in_window: number;
}

function specFromApi(s: ApiModelSpec): ModelSpec {
  return {
    provider: s.provider,
    modelId: s.model_id,
    quality: Number(s.quality),
    latencyP95Ms: Number(s.latency_p95_ms),
    reliability: Number(s.reliability),
    contextWindow: Number(s.context_window),
    costPer1kInput: Number(s.cost_per_1k_input),
    costPer1kOutput: Number(s.cost_per_1k_output),
    costPer1kCacheRead: s.cost_per_1k_cache_read == null ? null : Number(s.cost_per_1k_cache_read),
    costPer1kCacheWrite: s.cost_per_1k_cache_write == null ? null : Number(s.cost_per_1k_cache_write),
    source: String(s.source),
  };
}

function comparisonFromApi(c: ApiModelComparison): ModelComparison {
  return {
    current: specFromApi(c.current),
    candidate: specFromApi(c.candidate),
    deltaCostPer1kInput: Number(c.delta_cost_per_1k_input),
    deltaCostPer1kOutput: Number(c.delta_cost_per_1k_output),
    deltaQuality: Number(c.delta_quality),
    deltaLatencyP95Ms: Number(c.delta_latency_p95_ms),
    deltaReliability: Number(c.delta_reliability),
    costRatio: Number(c.cost_ratio),
  };
}

function runnerFromApi(r: ApiRunnerUp): RunnerUp {
  return {
    provider: r.provider,
    modelId: r.model_id,
    score: Number(r.score),
    rationale: r.rationale,
  };
}

function recommendationFromApi(r: ApiRecommendation): Recommendation {
  return {
    recommendedProvider: r.recommended_provider,
    recommendedModelId: r.recommended_model_id,
    score: Number(r.score),
    rationale: r.rationale,
    monthlySavingsUsd: r.monthly_savings_usd == null ? null : Number(r.monthly_savings_usd),
    currentProvider: r.current_provider,
    currentModelId: r.current_model_id,
    runnersUp: (r.runners_up || []).map(runnerFromApi),
    emptyHistory: Boolean(r.empty_history),
  };
}

function projectionFromApi(p: ApiSwitchProjection): SwitchProjection {
  return {
    currentProvider: p.current_provider,
    currentModelId: p.current_model_id,
    candidateProvider: p.candidate_provider,
    candidateModelId: p.candidate_model_id,
    currentTotalUsd: Number(p.current_total_usd),
    projectedTotalUsd: Number(p.projected_total_usd),
    savingsUsd: Number(p.savings_usd),
    savingsPct: Number(p.savings_pct),
    perRequestSavingsUsd: Number(p.per_request_savings_usd),
    cacheSavingsUsd: Number(p.cache_savings_usd),
    windowDays: Number(p.window_days),
    requestsInWindow: Number(p.requests_in_window),
  };
}

// ─────────────────────────────────────────────────────────────────────
// ModelAdvisor
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.eden.ai";
const DEFAULT_TIMEOUT_MS = 10_000;

export class ModelAdvisor {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /** Stored for callers that want to inspect the default org id. */
  public readonly orgId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ModelAdvisorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.orgId = opts.orgId ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "eden-sdk/typescript",
    };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err instanceof Error ? err.message : String(err);
      throw new ModelAdvisorError(0, `transport error: ${reason}`, err);
    }
    clearTimeout(timer);

    let parsed: unknown = null;
    const text = await resp.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!resp.ok) {
      let reason = resp.statusText || "unknown error";
      if (parsed && typeof parsed === "object" && "detail" in (parsed as Record<string, unknown>)) {
        const detail = (parsed as Record<string, unknown>).detail;
        if (typeof detail === "string") reason = detail;
      }
      throw new ModelAdvisorError(resp.status, reason, parsed);
    }
    return parsed as T;
  }

  /** Side-by-side compare two models. Honours per-tenant overrides. */
  async compare(orgId: string, current: ModelRef, candidate: ModelRef): Promise<ModelComparison> {
    const body = {
      current: { provider: current.provider, model_id: current.modelId },
      candidate: { provider: candidate.provider, model_id: candidate.modelId },
    };
    const resp = await this.post<ApiModelComparison>(
      `/orgs/${orgId}/models/compare`,
      body,
    );
    return comparisonFromApi(resp);
  }

  /** Recommend the best model — fresh pick or a switch projection. */
  async recommend(orgId: string, opts: RecommendOptions): Promise<Recommendation> {
    if (!opts.candidates || opts.candidates.length === 0) {
      throw new Error("candidates must contain at least one model");
    }
    const body: Record<string, unknown> = {
      mode: opts.current ? "switch" : "pick",
      candidates: opts.candidates.map((c) => ({
        provider: c.provider,
        model_id: c.modelId,
      })),
      window_days: opts.windowDays ?? 30,
    };
    if (opts.current) {
      body.current = {
        provider: opts.current.provider,
        model_id: opts.current.modelId,
      };
    }
    const resp = await this.post<ApiRecommendation>(
      `/orgs/${orgId}/models/recommend`,
      body,
    );
    return recommendationFromApi(resp);
  }

  /** Project what a model switch would cost the org. */
  async project(orgId: string, opts: ProjectOptions): Promise<SwitchProjection> {
    const body = {
      current: { provider: opts.current.provider, model_id: opts.current.modelId },
      candidate: { provider: opts.candidate.provider, model_id: opts.candidate.modelId },
      scale_factor: opts.scaleFactor ?? 1.0,
      window_days: opts.windowDays ?? 30,
    };
    const resp = await this.post<ApiSwitchProjection>(
      `/orgs/${orgId}/models/project`,
      body,
    );
    return projectionFromApi(resp);
  }
}

// ponytail: shared types for the observability surface. Extracted from
// the old 1182-line observability/page.tsx monolith (June 2026) so that
// the new /traces route, /observability/ landing, and per-sub-route
// pages can all consume the same TraceItem / TraceTreeData / etc.
// shapes. Mirrors src/lib/api.ts ObservabilityTrace.

export type StreamingMetrics = {
  ttft_ms?: number;
  itl_ms_avg?: number;
  tpot_ms?: number;
};

export type Outcome =
  | "success"
  | "failure"
  | "partial"
  | "timeout"
  | "crash"
  | "unknown";

export interface TraceItem {
  trace_id: string;
  realm: "environment" | "production" | string;
  outcome: Outcome | null;
  span_count: number;
  duration_ms: number;
  streaming_metrics?: StreamingMetrics | null;
  // Pattern 5.1 (Langfuse): optional token / cost columns. Surfaced
  // by /api/orgs/{orgId}/observability/traces when telemetry-derived
  // usage_events data is present. Older traces predate this field.
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_cents?: number | null;
  model?: string | null;
  started_at?: string | null;
}

export interface TraceTreeData {
  trace_id: string;
  tenant_id: string;
  realm: string;
  root_spans: Array<Record<string, unknown>>;
  total_duration_ms: number;
  span_count: number;
  outcome: string | null;
}

export interface TimelineData {
  trace_id: string;
  steps: Array<{
    name: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    event_type: string;
    outcome: Outcome | null;
  }>;
  total_duration_ms: number;
  markers: Array<{
    at_ms: number;
    label: string;
    severity: string;
  }>;
}

export interface HeatmapData {
  metric_name: string;
  buckets: Array<{ x: string; y: string; value: number; count: number }>;
  x_labels: string[];
  y_labels: string[];
  min_value: number;
  max_value: number;
}

export interface ComparativeData {
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
}

export interface TraceFilter {
  realm: string;
  outcome: string;
  agent_id: string;
}

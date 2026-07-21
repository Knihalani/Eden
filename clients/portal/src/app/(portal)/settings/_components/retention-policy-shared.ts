/**
 * Tables / defaults mirror ``DEFAULT_POLICIES`` in
 * ``eden.data_platform.retention``. API ``table_name`` is the
 * policy ``data_type``. Labels use user-facing names (audit trail vs id).
 */
export const RETENTION_TABLES: Array<{ id: string; label: string; description: string }> = [
  { id: "raw_traces", label: "Raw traces", description: "Pre-aggregation ingestion events" },
  { id: "derived_metrics", label: "Derived metrics", description: "Aggregated metric rows" },
  { id: "user_feedback", label: "User feedback", description: "Thumbs / ratings / comments" },
  { id: "training_datasets", label: "Training datasets", description: "Export datasets for training" },
  {
    id: "audit_logs",
    label: "Audit trail",
    description: "Workspace action history (API id: audit_logs)",
  },
  { id: "error_logs", label: "Error logs", description: "Captured error telemetry" },
  { id: "debug_dumps", label: "Debug dumps", description: "Short-lived debug payloads" },
  { id: "quarantine_events", label: "Quarantine events", description: "Held / quarantined ingest" },
];

export interface TableRetention {
  hot_days: number;
  warm_days: number;
  cold_days: number;
  delete_days: number;
  pii_scrub_after_days: number | null;
}

export const RETENTION_DEFAULTS: Record<string, TableRetention> = {
  raw_traces: {
    hot_days: 7,
    warm_days: 90,
    cold_days: 2555,
    delete_days: 90,
    pii_scrub_after_days: 30,
  },
  derived_metrics: {
    hot_days: 7,
    warm_days: 90,
    cold_days: 2555,
    delete_days: 2555,
    pii_scrub_after_days: null,
  },
  user_feedback: {
    hot_days: 7,
    warm_days: 90,
    cold_days: 2555,
    delete_days: 2555,
    pii_scrub_after_days: null,
  },
  training_datasets: {
    hot_days: 7,
    warm_days: 90,
    cold_days: 2555,
    delete_days: 2555,
    pii_scrub_after_days: null,
  },
  audit_logs: {
    hot_days: 7,
    warm_days: 90,
    cold_days: 2555,
    delete_days: 2555,
    pii_scrub_after_days: null,
  },
  error_logs: {
    hot_days: 7,
    warm_days: 30,
    cold_days: 90,
    delete_days: 90,
    pii_scrub_after_days: null,
  },
  debug_dumps: {
    hot_days: 7,
    warm_days: 0,
    cold_days: 0,
    delete_days: 7,
    pii_scrub_after_days: null,
  },
  quarantine_events: {
    hot_days: 7,
    warm_days: 30,
    cold_days: 90,
    delete_days: 90,
    pii_scrub_after_days: null,
  },
};

/** One active override row — mirrors ``RetentionPolicyOut``. */
export interface RetentionOverride {
  policy_id?: string;
  table_name: string;
  hot_days: number;
  warm_days: number;
  cold_days: number;
  delete_days: number;
  pii_scrub_after_days: number | null;
  effective_from?: string;
  notes?: string | null;
}

export type RetentionDraftMap = Record<string, TableRetention>;

export function retentionRowsToDraft(rows: RetentionOverride[]): RetentionDraftMap {
  const next: RetentionDraftMap = {};
  for (const row of rows) {
    next[row.table_name] = {
      hot_days: row.hot_days,
      warm_days: row.warm_days,
      cold_days: row.cold_days,
      delete_days: row.delete_days,
      pii_scrub_after_days: row.pii_scrub_after_days,
    };
  }
  return next;
}

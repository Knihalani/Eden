"use client";

import { useEffect, useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Loader2, Clock, Database, Trash2, RotateCcw, AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";

/**
 * Tables / defaults mirror ``DEFAULT_POLICIES`` in
 * ``eden.data_platform.retention``. API ``table_name`` is the
 * policy ``data_type``.
 */
const TABLES: Array<{ id: string; label: string; description: string }> = [
  { id: "raw_traces", label: "Raw traces", description: "Pre-aggregation ingestion events" },
  { id: "derived_metrics", label: "Derived metrics", description: "Aggregated metric rows" },
  { id: "user_feedback", label: "User feedback", description: "Thumbs / ratings / comments" },
  { id: "training_datasets", label: "Training datasets", description: "Export datasets for training" },
  { id: "audit_logs", label: "Audit logs", description: "Org action history" },
  { id: "error_logs", label: "Error logs", description: "Captured error telemetry" },
  { id: "debug_dumps", label: "Debug dumps", description: "Short-lived debug payloads" },
  { id: "quarantine_events", label: "Quarantine events", description: "Held / quarantined ingest" },
];

interface TableRetention {
  hot_days: number;
  warm_days: number;
  cold_days: number;
  delete_days: number;
  pii_scrub_after_days: number | null;
}

const DEFAULTS: Record<string, TableRetention> = {
  raw_traces: { hot_days: 7, warm_days: 90, cold_days: 2555, delete_days: 90, pii_scrub_after_days: 30 },
  derived_metrics: { hot_days: 7, warm_days: 90, cold_days: 2555, delete_days: 2555, pii_scrub_after_days: null },
  user_feedback: { hot_days: 7, warm_days: 90, cold_days: 2555, delete_days: 2555, pii_scrub_after_days: null },
  training_datasets: { hot_days: 7, warm_days: 90, cold_days: 2555, delete_days: 2555, pii_scrub_after_days: null },
  audit_logs: { hot_days: 7, warm_days: 90, cold_days: 2555, delete_days: 2555, pii_scrub_after_days: null },
  error_logs: { hot_days: 7, warm_days: 30, cold_days: 90, delete_days: 90, pii_scrub_after_days: null },
  debug_dumps: { hot_days: 7, warm_days: 0, cold_days: 0, delete_days: 7, pii_scrub_after_days: null },
  quarantine_events: { hot_days: 7, warm_days: 30, cold_days: 90, delete_days: 90, pii_scrub_after_days: null },
};

/** One active override row — mirrors ``RetentionPolicyOut``. */
interface RetentionOverride {
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

type DraftMap = Record<string, TableRetention>;

function rowsToDraft(rows: RetentionOverride[]): DraftMap {
  const next: DraftMap = {};
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

export function RetentionPolicyTab() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  // BE gates PUT with ``retention:override`` (owner-only).
  const canEdit = hasPermission("retention:override");

  const orgId = currentOrg?.id ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<DraftMap>({});
  const [draft, setDraft] = useState<DraftMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [latestEffective, setLatestEffective] = useState<string | null>(null);

  const policyQuery = useOrgQuery(
    queryKeys.retentionPolicy.detail(orgId),
    orgId,
    () => api.getRetentionPolicy(orgId!),
  );
  const loading = policyQuery.isLoading;
  useEffect(() => {
    if (policyQuery.data) {
      const mapped = rowsToDraft(policyQuery.data);
      setBaseline(mapped);
      setDraft(mapped);
      const newest = policyQuery.data
        .map((r) => r.effective_from)
        .filter(Boolean)
        .sort()
        .at(-1);
      setLatestEffective(newest ?? null);
    }
  }, [policyQuery.data]);
  useEffect(() => {
    if (policyQuery.error) {
      setError(errorFromCaught(policyQuery.error, "Failed to load retention policy"));
    }
  }, [policyQuery.error]);

  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);

  const handleSave = async () => {
    if (!currentOrg) return;
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      // PUT is per-table (RetentionPolicyIn). Persist every draft
      // override; values reset to defaults still overwrite the row.
      const tableNames = new Set([...Object.keys(draft), ...Object.keys(baseline)]);
      for (const tableName of tableNames) {
        const vals = draft[tableName];
        if (!vals) continue;
        const before = baseline[tableName];
        if (before && JSON.stringify(before) === JSON.stringify(vals)) continue;
        await api.updateRetentionPolicy(currentOrg.id, {
          table_name: tableName,
          hot_days: vals.hot_days,
          warm_days: vals.warm_days,
          cold_days: vals.cold_days,
          delete_days: vals.delete_days,
          pii_scrub_after_days: vals.pii_scrub_after_days,
        });
      }
      await policyQuery.refetch();
      toast.success("Retention policy saved");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save retention policy";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft(baseline);
  };

  const updateTable = (tableId: string, patch: Partial<TableRetention>) => {
    const current = draft[tableId] ?? DEFAULTS[tableId];
    setDraft({
      ...draft,
      [tableId]: { ...current, ...patch },
    });
  };

  const removeOverride = (tableId: string) => {
    // Local-only: BE has no DELETE. Existing rows reset to
    // defaults (saved via PUT); never-persisted drafts drop.
    const next = { ...draft };
    if (baseline[tableId]) {
      next[tableId] = { ...DEFAULTS[tableId] };
    } else {
      delete next[tableId];
    }
    setDraft(next);
  };

  const toggleExpanded = (tableId: string) => {
    const next = new Set(expanded);
    if (next.has(tableId)) {
      next.delete(tableId);
    } else {
      next.add(tableId);
    }
    setExpanded(next);
  };

  if (!currentOrg) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage retention policy.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
        <span className="ml-2 text-[var(--text-secondary)]">Loading retention policy...</span>
      </div>
    );
  }

  if (policyQuery.error && Object.keys(draft).length === 0 && Object.keys(baseline).length === 0) {
    return (
      <ErrorState
        title="Could not load retention policy"
        message={error ?? "Failed to load retention policy"}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void policyQuery.refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        }
      />
    );
  }

  const overrideCount = Object.keys(draft).length;

  return (
    <div className="space-y-space-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border-default)]">
          <Database className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Retention Policy</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Override per-table TTL windows and optional PII scrub interval.
            Days are counted from row creation; &quot;delete&quot; means hard-delete from cold storage.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-[var(--error)]/10 border border-[var(--error)]/30 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-[var(--error)] mt-0.5" />
          <p className="text-sm text-[var(--error)]">{error}</p>
        </div>
      )}

      <Card padding="md">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Per-table overrides</h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {overrideCount} of {TABLES.length} tables overridden from defaults
            </p>
          </div>
          {!canEdit && (
            <span className="text-xs px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded text-[var(--text-muted)]">
              Read-only
            </span>
          )}
        </div>
        <div className="space-y-space-2">
          {TABLES.map((table) => {
            const override = draft[table.id];
            const effective = override ?? DEFAULTS[table.id];
            const isOverridden = !!override;
            const isOpen = expanded.has(table.id);
            return (
              <div
                key={table.id}
                className={cn(
                  "border rounded-lg",
                  isOverridden
                    ? "border-[var(--accent)] bg-[var(--accent)]/5"
                    : "border-[var(--border-default)] bg-[var(--bg-tertiary)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleExpanded(table.id)}
                  className="w-full flex items-center justify-between p-3 text-left"
                  aria-expanded={isOpen}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Database className="w-4 h-4 text-[var(--text-muted)]" />
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {table.label}
                      </span>
                      {isOverridden && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-[var(--accent)]/20 text-[var(--accent)] rounded">
                          override
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{table.description}</p>
                    <div className="flex gap-3 mt-1.5 text-xs font-mono text-[var(--text-muted)]">
                      <span>hot {effective.hot_days}d</span>
                      <span>warm {effective.warm_days}d</span>
                      <span>cold {effective.cold_days}d</span>
                      <span>delete {effective.delete_days}d</span>
                      {effective.pii_scrub_after_days != null && (
                        <span>scrub {effective.pii_scrub_after_days}d</span>
                      )}
                    </div>
                  </div>
                  <span className="text-[var(--text-muted)] text-xs ml-3">
                    {isOpen ? "▾" : "▸"}
                  </span>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 pt-1 border-t border-[var(--border-default)] space-y-3">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {(["hot_days", "warm_days", "cold_days", "delete_days"] as const).map(
                        (field) => (
                          <div key={field}>
                            <label className="block text-xs text-[var(--text-muted)] mb-1 capitalize">
                              {field.replace("_days", "")} (days)
                            </label>
                            <input
                              type="number"
                              min={0}
                              max={3650}
                              value={effective[field]}
                              disabled={!canEdit}
                              onChange={(e) => {
                                const n = Number(e.target.value);
                                if (!Number.isInteger(n) || n < 0) return;
                                updateTable(table.id, { [field]: n });
                              }}
                              className="w-full px-2 py-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] text-sm font-mono"
                            />
                          </div>
                        ),
                      )}
                    </div>
                    <div>
                      <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] mb-1">
                        <Trash2 className="w-3 h-3" />
                        PII scrub after (days)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={3650}
                        value={effective.pii_scrub_after_days ?? ""}
                        placeholder="none"
                        disabled={!canEdit}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === "") {
                            updateTable(table.id, { pii_scrub_after_days: null });
                            return;
                          }
                          const n = Number(raw);
                          if (!Number.isInteger(n) || n < 0) return;
                          updateTable(table.id, { pii_scrub_after_days: n });
                        }}
                        className="w-32 px-2 py-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] text-sm font-mono"
                      />
                    </div>
                    {canEdit && isOverridden && (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => removeOverride(table.id)}
                          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Reset to default
                        </button>
                      </div>
                    )}
                    {canEdit && !isOverridden && (
                      <div className="flex justify-end">
                        <span className="text-xs text-[var(--text-muted)]">
                          Edit a value above to create an override.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {canEdit && (
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty || saving}
            className="px-4 py-2 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            Discard changes
          </button>
          <Button
            type="button"
            variant="default"
            className="min-h-11"
            onClick={handleSave}
            disabled={!dirty}
            loading={saving}
          >
            Save changes
          </Button>
        </div>
      )}

      {latestEffective && (
        <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          Last updated {new Date(latestEffective).toLocaleString()}
        </p>
      )}
    </div>
  );
}

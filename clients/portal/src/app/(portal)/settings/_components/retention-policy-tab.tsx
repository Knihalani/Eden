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
import {
  RETENTION_DEFAULTS,
  RETENTION_TABLES,
  retentionRowsToDraft,
  type RetentionDraftMap,
  type TableRetention,
} from "./retention-policy-shared";

export function RetentionPolicyTab() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const canEdit = hasPermission("retention:override");
  const orgId = currentOrg?.id ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<RetentionDraftMap>({});
  const [draft, setDraft] = useState<RetentionDraftMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [latestEffective, setLatestEffective] = useState<string | null>(null);

  const policyQuery = useOrgQuery(queryKeys.retentionPolicy.detail(orgId), orgId, () =>
    api.getRetentionPolicy(orgId!),
  );
  const loading = policyQuery.isLoading;

  useEffect(() => {
    if (policyQuery.data) {
      const mapped = retentionRowsToDraft(policyQuery.data);
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
    if (!currentOrg || !dirty) return;
    setSaving(true);
    setError(null);
    try {
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

  const handleReset = () => setDraft(baseline);

  const updateTable = (tableId: string, patch: Partial<TableRetention>) => {
    const current = draft[tableId] ?? RETENTION_DEFAULTS[tableId];
    setDraft({ ...draft, [tableId]: { ...current, ...patch } });
  };

  const removeOverride = (tableId: string) => {
    const next = { ...draft };
    if (baseline[tableId]) {
      next[tableId] = { ...RETENTION_DEFAULTS[tableId] };
    } else {
      delete next[tableId];
    }
    setDraft(next);
  };

  const toggleExpanded = (tableId: string) => {
    const next = new Set(expanded);
    if (next.has(tableId)) next.delete(tableId);
    else next.add(tableId);
    setExpanded(next);
  };

  if (!currentOrg) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]" data-ws7-retention>
        Select a workspace to manage retention policy.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-ws7-retention>
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
        <span className="ml-2 text-[var(--text-secondary)]">Loading retention policy...</span>
      </div>
    );
  }

  if (
    policyQuery.error &&
    Object.keys(draft).length === 0 &&
    Object.keys(baseline).length === 0
  ) {
    return (
      <div data-ws7-retention>
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
      </div>
    );
  }

  const overrideCount = Object.keys(draft).length;

  return (
    <div className="space-y-space-6" data-ws7-retention>
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Retention policy</h2>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Override per-table TTL windows and optional PII scrub interval. Days count from row
          creation; delete means hard-delete from cold storage.
        </p>
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
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Per-table overrides
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {overrideCount} of {RETENTION_TABLES.length} tables overridden from defaults
            </p>
          </div>
          {!canEdit && (
            <span className="text-xs text-[var(--text-muted)]">Read-only</span>
          )}
        </div>
        <div className="space-y-space-2">
          {RETENTION_TABLES.map((table) => {
            const override = draft[table.id];
            const effective = override ?? RETENTION_DEFAULTS[table.id];
            const isOverridden = !!override;
            const isOpen = expanded.has(table.id);
            return (
              <div
                key={table.id}
                className={cn(
                  "border rounded-lg border-[var(--border-default)]",
                  isOverridden ? "bg-[var(--bg-secondary)]" : "bg-[var(--bg-tertiary)]",
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
                        <span className="text-xs text-[var(--text-muted)]">· overridden</span>
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeOverride(table.id)}
                        >
                          <RotateCcw className="w-3 h-3" />
                          Reset to default
                        </Button>
                      </div>
                    )}
                    {canEdit && !isOverridden && (
                      <p className="text-xs text-[var(--text-muted)] text-right">
                        Edit a value above to create an override.
                      </p>
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
          <Button
            type="button"
            variant="outline"
            onClick={handleReset}
            disabled={!dirty || saving}
          >
            Discard changes
          </Button>
          <Button
            type="button"
            variant="default"
            className="min-h-11"
            onClick={() => void handleSave()}
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

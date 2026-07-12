"use client";

import { useEffect, useState } from "react";
import { Loader2, Clock, Database, Trash2, RotateCcw, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { errorFromCaught } from "@/lib/safe-error-message";

const TABLES: Array<{ id: string; label: string; description: string }> = [
  { id: "raw_traces", label: "Raw traces", description: "Pre-aggregation ingestion events" },
  { id: "silver_events", label: "Silver events", description: "Cleaned, joined event rows" },
  { id: "judge_scores", label: "Judge scores", description: "LLM-as-judge evaluations" },
  { id: "insights", label: "Insights", description: "Detector output and recommendations" },
  { id: "audit_log", label: "Audit log", description: "Org action history" },
  { id: "usage_events", label: "Usage events", description: "Token + cost telemetry" },
  { id: "graph_entities", label: "Graph entities", description: "KB nodes / edges" },
  { id: "episodic_memory", label: "Episodic memory", description: "Long-term KB context" },
];

const DEFAULTS: Record<string, { hot_days: number; warm_days: number; cold_days: number; delete_days: number }> = {
  raw_traces: { hot_days: 7, warm_days: 30, cold_days: 90, delete_days: 365 },
  silver_events: { hot_days: 30, warm_days: 60, cold_days: 180, delete_days: 730 },
  judge_scores: { hot_days: 30, warm_days: 90, cold_days: 180, delete_days: 730 },
  insights: { hot_days: 30, warm_days: 90, cold_days: 365, delete_days: 1825 },
  audit_log: { hot_days: 90, warm_days: 365, cold_days: 730, delete_days: 2555 },
  usage_events: { hot_days: 30, warm_days: 90, cold_days: 180, delete_days: 730 },
  graph_entities: { hot_days: 30, warm_days: 90, cold_days: 365, delete_days: 1825 },
  episodic_memory: { hot_days: 30, warm_days: 90, cold_days: 365, delete_days: 1825 },
};

interface TableRetention {
  hot_days: number;
  warm_days: number;
  cold_days: number;
  delete_days: number;
}

interface RetentionPolicy {
  org_id: string;
  table_overrides: Record<string, TableRetention>;
  pii_scrub_after_days: number;
  created_at: string | null;
  updated_at: string | null;
}

export function RetentionPolicyTab() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const canEdit = hasPermission("settings:edit");

  const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RetentionPolicy | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [piiScrubInput, setPiiScrubInput] = useState<string>("");

  useEffect(() => {
    if (!currentOrg) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getRetentionPolicy(currentOrg.id)
      .then((data) => {
        if (cancelled) return;
        setPolicy(data);
        setDraft(data);
        setPiiScrubInput(String(data.pii_scrub_after_days));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(errorFromCaught(e, "Failed to load retention policy"));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id]);

  const dirty = JSON.stringify(policy) !== JSON.stringify(draft);

  const handleSave = async () => {
    if (!currentOrg || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateRetentionPolicy(currentOrg.id, {
        table_overrides: draft.table_overrides,
        pii_scrub_after_days: draft.pii_scrub_after_days,
      });
      setPolicy(updated);
      setDraft(updated);
      setPiiScrubInput(String(updated.pii_scrub_after_days));
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
    setDraft(policy);
    if (policy) setPiiScrubInput(String(policy.pii_scrub_after_days));
  };

  const updateTable = (tableId: string, patch: Partial<TableRetention>) => {
    if (!draft) return;
    const current = draft.table_overrides[tableId] ?? DEFAULTS[tableId];
    setDraft({
      ...draft,
      table_overrides: {
        ...draft.table_overrides,
        [tableId]: { ...current, ...patch },
      },
    });
  };

  const removeOverride = (tableId: string) => {
    if (!draft) return;
    const next = { ...draft.table_overrides };
    delete next[tableId];
    setDraft({ ...draft, table_overrides: next });
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

  const setPiiScrub = (raw: string) => {
    setPiiScrubInput(raw);
    if (!draft) return;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) {
      setDraft({ ...draft, pii_scrub_after_days: n });
    }
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

  if (!draft) {
    return (
      <div className="p-4 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg">
        <p className="text-sm text-[var(--text-secondary)]">
          {error ?? "No retention policy available."}
        </p>
      </div>
    );
  }

  const overrideCount = Object.keys(draft.table_overrides).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border-default)]">
          <Database className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Retention Policy</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Override per-table TTL windows and the global PII scrub interval.
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
        <div className="flex items-center gap-2 mb-2">
          <Trash2 className="w-4 h-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">PII scrub after (days)</h3>
        </div>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Number of days after ingestion that stored PII is scrubbed. Set to 0 to keep PII
          indefinitely (not recommended).
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            max={3650}
            value={piiScrubInput}
            onChange={(e) => setPiiScrub(e.target.value)}
            disabled={!canEdit}
            className="w-32 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] text-sm"
          />
          <span className="text-sm text-[var(--text-muted)]">days</span>
          {draft.pii_scrub_after_days === 0 && (
            <span className="text-xs px-2 py-1 bg-[var(--warning)]/10 border border-[var(--warning)]/30 text-[var(--warning)] rounded">
              PII will be retained indefinitely
            </span>
          )}
        </div></Card>

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
        <div className="space-y-2">
          {TABLES.map((table) => {
            const override = draft.table_overrides[table.id];
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
                    : "border-[var(--border-default)] bg-[var(--bg-tertiary)]"
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
                        )
                      )}
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
        </div></Card>

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
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-primary)] rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save changes
          </button>
        </div>
      )}

      {policy?.updated_at && (
        <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          Last updated {new Date(policy.updated_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Wallet } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";

type KillRow = { feature_key: string; enabled: boolean; source?: string };

/**
 * Customer FinOps feature kill-switches — searchable via Settings rail ("FinOps").
 * No Eden COGS / unit-economics admin UI.
 */
export function FinOpsKillsTab() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<KillRow[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.finopsKillSwitches(currentOrg.id);
      setMatrix(res.data?.matrix ?? []);
      setKeys(res.data?.keys ?? []);
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load FinOps kill switches"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const byKey = new Map(matrix.map((m) => [m.feature_key, m]));
    const allKeys = keys.length > 0 ? keys : [...byKey.keys()];
    const q = filter.trim().toLowerCase();
    return allKeys
      .map((k) => byKey.get(k) ?? { feature_key: k, enabled: false, source: "default" })
      .filter((r) => !q || r.feature_key.toLowerCase().includes(q));
  }, [matrix, keys, filter]);

  const toggle = async (feature_key: string, enabled: boolean) => {
    if (!currentOrg) return;
    setBusyKey(feature_key);
    try {
      await api.setFinopsKillSwitch(currentOrg.id, { feature_key, enabled });
      toast.success(`${feature_key} ${enabled ? "enabled" : "disabled"}`);
      await load();
    } catch (e) {
      toast.error(errorFromCaught(e, "Update failed"));
    } finally {
      setBusyKey(null);
    }
  };

  if (!currentOrg) {
    return <EmptyState title="Select an organization" description="FinOps kills are org-scoped." />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Wallet className="h-4 w-4" />
          FinOps kill switches
        </h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Customer feature kills (fail-closed). Searchable as FinOps / kill switches — not Eden COGS.
        </p>
      </div>

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter feature keys…"
        aria-label="Filter FinOps kill switches"
        className="w-full max-w-md rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm"
      />

      {error ? (
        <ErrorState
          message={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {loading ? (
        <Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" />
      ) : rows.length === 0 ? (
        <EmptyState title="No kill switches" description="No customer feature keys configured." />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Card key={row.feature_key} className="flex items-center justify-between p-3">
              <div>
                <p className="text-sm font-medium font-mono">{row.feature_key}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  source: {row.source ?? "—"}
                </p>
              </div>
              <Switch
                checked={row.enabled}
                disabled={busyKey === row.feature_key}
                onCheckedChange={(v) => void toggle(row.feature_key, v)}
                aria-label={`Toggle ${row.feature_key}`}
              />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default FinOpsKillsTab;

"use client";

import { useMemo, useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
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
import { DangerZone } from "@/components/settings/danger-zone";

type KillRow = { feature_key: string; enabled: boolean; source?: string };

/**
 * Customer FinOps feature kill-switches — searchable via Settings rail ("FinOps").
 * No Eden COGS / unit-economics admin UI.
 */
export function FinOpsKillsTab() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const orgId = currentOrg?.id ?? null;
  const [filter, setFilter] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const killsQuery = useOrgQuery(
    queryKeys.finopsKills.matrix(orgId),
    orgId,
    async () => {
      const res = await api.finopsKillSwitches(orgId!);
      return {
        matrix: (res.data?.matrix ?? []) as KillRow[],
        keys: res.data?.keys ?? [],
      };
    },
  );
  const matrix = killsQuery.data?.matrix ?? [];
  const keys = killsQuery.data?.keys ?? [];
  const loading = killsQuery.isLoading;
  const error = killsQuery.error
    ? errorFromCaught(killsQuery.error, "Failed to load FinOps kill switches")
    : null;
  const load = async () => {
    await killsQuery.refetch();
  };

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
      const res = await api.setFinopsKillSwitch(currentOrg.id, {
        feature_key,
        enabled,
      });
      // Backend returns HTTP 200 with envelope status "error" for
      // unknown feature keys — treat that as failure, not success.
      if (res.status === "error") {
        toast.error(res.detail ?? res.error ?? "Update failed");
        return;
      }
      toast.success(`${feature_key} ${enabled ? "enabled" : "disabled"}`);
      await load();
    } catch (e) {
      toast.error(errorFromCaught(e, "Update failed"));
    } finally {
      setBusyKey(null);
    }
  };

  if (!currentOrg) {
    return (
      <EmptyState
        title="Select a workspace"
        description="FinOps kills are workspace-scoped."
      />
    );
  }

  return (
    <div className="space-y-space-4" data-ws8-finops>
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-space-2">
          <Wallet className="h-4 w-4" />
          FinOps kill switches
        </h3>
        <p className="mt-space-1 text-xs text-[var(--text-muted)]">
          Customer feature kills (fail-closed). Searchable as FinOps / kill switches — not Eden COGS.
        </p>
      </div>

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter feature keys…"
        aria-label="Filter FinOps kill switches"
        className="w-full max-w-md rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 text-sm"
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
        <DangerZone
          title="Feature kill switches"
          description="Disabling a feature fails closed for the organization. Re-enable only after validating impact."
        >
          <div className="space-y-space-2">
            {rows.map((row) => (
              <Card key={row.feature_key} className="flex items-center justify-between p-space-3">
                <div>
                  <p className="text-sm font-medium font-mono">{row.feature_key}</p>
                  <p className="text-xs text-[var(--text-muted)]">
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
        </DangerZone>
      )}
    </div>
  );
}

export default FinOpsKillsTab;

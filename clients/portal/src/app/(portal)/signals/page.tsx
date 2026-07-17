"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { Activity, RefreshCw, Play } from "lucide-react";
import { signalsApi, type Signal } from "@/lib/api";

export default function SignalsPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [description, setDescription] = useState("");
  const [matchValue, setMatchValue] = useState("0.05");
  const [lastCreated, setLastCreated] = useState<Signal | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await signalsApi.list(currentOrg.id);
      setSignals(res.signals || []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load signals";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Signals" />;

  const filtered = signals.filter((s) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      s.description.toLowerCase().includes(q) ||
      s.rule.metric.toLowerCase().includes(q) ||
      s.rule.keywords.some((k) => k.toLowerCase().includes(q))
    );
  });

  const createSignal = async () => {
    if (!currentOrg?.id) return;
    const desc = description.trim();
    if (desc.length < 3) {
      toast.error("Description must be at least 3 characters");
      return;
    }
    setCreating(true);
    try {
      const created = await signalsApi.create(currentOrg.id, { description: desc });
      setLastCreated(created);
      setDescription("");
      toast.success(`Compiled rule: ${created.rule.metric} ${created.rule.op} ${created.rule.threshold}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const seedDefaults = async () => {
    if (!currentOrg?.id) return;
    setCreating(true);
    try {
      const res = await signalsApi.seedDefaults(currentOrg.id, "standard");
      toast.success(`Seeded ${res.count} default signals (${res.skipped} skipped)`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Seed failed");
    } finally {
      setCreating(false);
    }
  };

  const testMatch = async (signalId: string) => {
    if (!currentOrg?.id) return;
    const value = Number(matchValue);
    if (Number.isNaN(value)) {
      toast.error("Match value must be a number");
      return;
    }
    setMatchingId(signalId);
    try {
      const res = await signalsApi.match(currentOrg.id, signalId, value);
      toast.success(res.matched ? "Matched" : "No match");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Match failed");
    } finally {
      setMatchingId(null);
    }
  };

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Observability"
        title="Signals"
        subtitle="Plain-English metric rules. Describe a threshold; Eden compiles it immediately."
        icon={Activity}
        actions={
          <>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter signals" />
            <Button
              onClick={load}
              variant="outline"
              size="sm"
              disabled={loading}
              loading={loading}
              aria-label="Refresh signals"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />

      <Card className="mb-4 p-4 space-y-3">
        <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor="signal-desc">
          New signal description
        </label>
        <textarea
          id="signal-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder='e.g. "error rate above 5%"'
          className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elev-1)] px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={createSignal} size="sm" disabled={creating || description.trim().length < 3} loading={creating}>
            Create signal
          </Button>
          <Button onClick={seedDefaults} size="sm" variant="outline" disabled={creating} loading={creating}>
            Seed defaults
          </Button>
          <input
            value={matchValue}
            onChange={(e) => setMatchValue(e.target.value)}
            className="h-8 w-24 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elev-1)] px-2 text-xs font-mono"
            aria-label="Test match value"
            title="Value used by Test match"
          />
          <span className="text-xs text-[var(--text-muted)]">Test-match value</span>
        </div>
        {lastCreated?.rule && (
          <pre className="rounded-md bg-[var(--bg-base)] border border-[var(--border-subtle)] p-3 text-xs font-mono overflow-auto">
            {JSON.stringify(lastCreated.rule, null, 2)}
          </pre>
        )}
      </Card>

      {error ? (
        <ErrorState
          title="Could not load signals"
          message={error}
          action={
            <Button onClick={load} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : (
        <Card className="p-2">
          <DataTable
            loading={loading}
            rows={filtered}
            rowKey={(r) => r.id}
            emptyTitle="No signals yet"
            emptyDescription='Create a signal above — or save a span search as a signal from Traces. Then wire an alert rule.'
            emptyIcon={Activity}
            emptyAction={
              <Link
                href="/alerts?tab=rules"
                className="text-xs text-[var(--accent)] hover:underline"
              >
                Create alert rule
              </Link>
            }
            columns={[
              {
                key: "description",
                header: "Description",
                sortable: true,
              },
              {
                key: "rule",
                header: "Rule",
                cell: (r) => (
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    {r.rule.metric} {r.rule.op} {r.rule.threshold}
                  </span>
                ),
              },
              {
                key: "enabled",
                header: "Enabled",
                cell: (r) => (r.enabled ? "yes" : "no"),
              },
              {
                key: "match_count",
                header: "Matches",
                align: "right",
                cell: (r) => r.match_count ?? 0,
              },
              {
                key: "actions",
                header: "",
                align: "right",
                cell: (r) => {
                  const isMatching = matchingId === r.id;
                  return (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isMatching}
                      loading={isMatching}
                      onClick={() => testMatch(r.id)}
                      aria-label={`Test match for ${r.description}`}
                    >
                      <Play className="h-3 w-3" />
                      Test match
                    </Button>
                  );
                },
              },
            ]}
          />
        </Card>
      )}
    </PageContent>
  );
}

"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { Textarea } from "@/components/ui/textarea";
import { Activity, RefreshCw, Play } from "lucide-react";
import { signalsApi, type CompiledRule, type Signal } from "@/lib/api";

type MatchResult = {
  signalId: string;
  description: string;
  value: number;
  matched: boolean;
  rule: CompiledRule;
};

export default function SignalsPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  // useToast() returns a fresh object each render — keep a stable ref so
  // mutation handlers don't re-create closures that churn RQ deps.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [description, setDescription] = useState("");
  const [matchValue, setMatchValue] = useState("0.05");
  const [lastCreated, setLastCreated] = useState<Signal | null>(null);
  const [lastMatch, setLastMatch] = useState<MatchResult | null>(null);

  const signalsQuery = useOrgQuery(
    queryKeys.signals.list(orgId),
    orgId,
    async () => {
      const res = await signalsApi.list(orgId!);
      return res.signals || [];
    },
  );
  const signals = signalsQuery.data ?? [];
  const loading = signalsQuery.isLoading;
  const refreshing = signalsQuery.isFetching && !loading;
  const error = signalsQuery.error?.message ?? null;
  const load = () => void signalsQuery.refetch();
  const busy = creating || seeding;

  if (!currentOrg) return <NoOrgState feature="Signals" />;

  const filtered = signals.filter((s) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    const keywords = s.rule?.keywords ?? [];
    return (
      s.description.toLowerCase().includes(q) ||
      (s.rule?.metric ?? "").toLowerCase().includes(q) ||
      keywords.some((k) => k.toLowerCase().includes(q))
    );
  });

  const createSignal = async () => {
    if (!orgId) return;
    const desc = description.trim();
    if (desc.length < 3) {
      toastRef.current.error("Description must be at least 3 characters");
      return;
    }
    setCreating(true);
    try {
      const created = await signalsApi.create(orgId, { description: desc });
      setLastCreated(created);
      setLastMatch(null);
      setDescription("");
      toastRef.current.success(
        `Compiled rule: ${created.rule.metric} ${created.rule.op} ${created.rule.threshold}`,
      );
      await signalsQuery.refetch();
    } catch (e) {
      toastRef.current.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const seedDefaults = async () => {
    if (!orgId) return;
    setSeeding(true);
    try {
      const res = await signalsApi.seedDefaults(orgId, "standard");
      toastRef.current.success(`Seeded ${res.count} default signals (${res.skipped} skipped)`);
      await signalsQuery.refetch();
    } catch (e) {
      toastRef.current.error(e instanceof Error ? e.message : "Seed failed");
    } finally {
      setSeeding(false);
    }
  };

  const testMatch = async (signal: Signal) => {
    if (!orgId) return;
    const trimmed = matchValue.trim();
    if (trimmed === "") {
      toastRef.current.error("Enter a numeric test-match value");
      return;
    }
    const value = Number(trimmed);
    if (Number.isNaN(value)) {
      toastRef.current.error("Match value must be a number");
      return;
    }
    setMatchingId(signal.id);
    try {
      const res = await signalsApi.match(orgId, signal.id, value);
      setLastMatch({
        signalId: signal.id,
        description: signal.description,
        value,
        matched: res.matched,
        rule: res.rule,
      });
      const ruleLabel = `${res.rule.metric} ${res.rule.op} ${res.rule.threshold}`;
      if (res.matched) {
        toastRef.current.success(`Matched — ${value} satisfies ${ruleLabel}`);
      } else {
        toastRef.current.error(`No match — ${value} does not satisfy ${ruleLabel}`);
      }
    } catch (e) {
      setLastMatch(null);
      toastRef.current.error(e instanceof Error ? e.message : "Match failed");
    } finally {
      setMatchingId(null);
    }
  };

  return (
    <PageContent size="wide">
      <PageHeader
        title="Signals"
        subtitle="Plain-English metric rules. Describe a threshold; Eden compiles it immediately."
        description="Create a signal, or save a span search as a signal from Traces. Then wire an alert rule."
        actions={
          <>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter signals" />
            <Button
              onClick={load}
              variant="ghost"
              size="sm"
              disabled={loading || refreshing}
              loading={loading || refreshing}
              aria-label="Refresh signals"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />

      <Panel tone="flat" padding="md" className="space-y-3">
        <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor="signal-desc">
          New signal description
        </label>
        <Textarea
          id="signal-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder='e.g. "error rate above 5%"'
          className="border-[var(--border-subtle)] bg-[var(--bg-inset)]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={createSignal}
            size="sm"
            disabled={busy || description.trim().length < 3}
            loading={creating}
          >
            Create signal
          </Button>
          <Button
            onClick={seedDefaults}
            size="sm"
            variant="outline"
            disabled={busy}
            loading={seeding}
          >
            Seed defaults
          </Button>
          <Input
            value={matchValue}
            onChange={(e) => setMatchValue(e.target.value)}
            className="h-8 w-24 border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 text-xs font-mono"
            aria-label="Test match value"
            title="Value used by Test match"
            inputMode="decimal"
          />
          <span className="text-xs text-[var(--text-muted)]">Test-match value</span>
        </div>
        {lastCreated?.rule && (
          <div className="space-y-1" data-testid="signals-last-created">
            <p className="text-xs font-medium text-[var(--text-muted)]">Compiled rule</p>
            <pre className="rounded-md bg-[var(--bg-inset)] ring-1 ring-inset ring-[var(--border-subtle)] p-3 text-xs font-mono overflow-auto text-[var(--text-secondary)]">
              {JSON.stringify(lastCreated.rule, null, 2)}
            </pre>
          </div>
        )}
        {lastMatch && (
          <div
            className="rounded-md bg-[var(--bg-inset)] ring-1 ring-inset ring-[var(--border-subtle)] p-3 space-y-1"
            data-testid="signals-last-match"
            role="status"
          >
            <p className="text-xs font-medium text-[var(--text-primary)]">
              {lastMatch.matched ? "Matched" : "No match"} —{" "}
              <span className="font-mono">{lastMatch.value}</span> vs{" "}
              <span className="font-mono">
                {lastMatch.rule.metric} {lastMatch.rule.op} {lastMatch.rule.threshold}
              </span>
            </p>
            <p className="text-xs text-[var(--text-muted)] truncate">{lastMatch.description}</p>
          </div>
        )}
      </Panel>

      {error ? (
        <ErrorState
          title="Could not load signals"
          message={error}
          action={
            <Button onClick={load} variant="outline" size="sm" disabled={loading || refreshing}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : (
        <DataTable
          loading={loading}
          rows={filtered}
          rowKey={(r) => r.id}
          emptyTitle="No signals yet"
          emptyDescription="Create a signal above — or save a span search as a signal from Traces. Then wire an alert rule."
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
                  {r.rule?.metric ?? "—"} {r.rule?.op ?? ""} {r.rule?.threshold ?? ""}
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
                    disabled={isMatching || busy}
                    loading={isMatching}
                    onClick={() => testMatch(r)}
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
      )}
    </PageContent>
  );
}

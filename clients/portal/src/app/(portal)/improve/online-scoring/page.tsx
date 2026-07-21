"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Plus, Sparkles } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { wave6Api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";

import { OnlineScoringForm } from "./_components/online-scoring-form";
import {
  OnlineScoringRulesTable,
  OnlineScoringTestPanel,
  type ScoringRule,
} from "./_components/online-scoring-rules";

export default function OnlineScoringPage() {
  const { currentOrg, authError } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [scorerType, setScorerType] = useState("slm");
  const [sampleRate, setSampleRate] = useState(0.1);
  const [testTraceId, setTestTraceId] = useState("");
  const [rewindJob, setRewindJob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scoringRulesKey = queryKeys.improve.scoringRules(orgId);

  const rulesQuery = useOrgQuery(
    scoringRulesKey,
    orgId,
    () => wave6Api.listScoringRules(orgId!),
  );

  const rules = (rulesQuery.data?.data?.rules ?? []) as ScoringRule[];

  if (!currentOrg && !authError) return <NoOrgState feature="Online scoring" />;
  if (!currentOrg) return null;

  const refresh = () => qc.invalidateQueries({ queryKey: scoringRulesKey });

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setFilterQuery("");
    setScorerType("slm");
    setSampleRate(0.1);
    setShowForm(false);
  };

  const startEdit = (rule: ScoringRule) => {
    setEditingId(rule.id);
    setName(rule.name);
    setFilterQuery(rule.filter_query || "");
    setScorerType(rule.scorer_type || "slm");
    setSampleRate(Number(rule.sample_rate ?? 0.1));
    setShowForm(true);
  };

  const save = async () => {
    if (!orgId || !name.trim()) return;
    setBusy(true);
    try {
      if (editingId) {
        await wave6Api.patchScoringRule(orgId, editingId, {
          name: name.trim(),
          filter_query: filterQuery,
          scorer_type: scorerType,
          sample_rate: sampleRate,
        });
        toast.success("Rule updated");
      } else {
        await wave6Api.createScoringRule(orgId, {
          name: name.trim(),
          filter_query: filterQuery,
          scorer_type: scorerType,
          sample_rate: sampleRate,
        });
        toast.success("Rule created");
      }
      resetForm();
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (rule: ScoringRule) => {
    if (!orgId) return;
    try {
      await wave6Api.patchScoringRule(orgId, rule.id, { enabled: !rule.enabled });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Toggle failed");
    }
  };

  const rewind = async (ruleId: string) => {
    if (!orgId) return;
    setBusy(true);
    try {
      const res = (await wave6Api.rewindScoringRule(orgId, ruleId)) as {
        data?: { job_id?: string };
      };
      const jobId = res.data?.job_id || "queued";
      setRewindJob(jobId);
      toast.success(`Rewind started · job ${jobId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rewind failed");
    } finally {
      setBusy(false);
    }
  };

  const testApply = async () => {
    if (!orgId || !testTraceId.trim()) {
      toast.error("Enter a trace id to test");
      return;
    }
    setBusy(true);
    try {
      await wave6Api.applyScoring(orgId, testTraceId.trim());
      toast.success("Applied scoring rules to trace");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test apply failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contents" data-wave8-improve-advanced="completed">
      <CoreResourcePage
        header={
          <PageHeader
            eyebrow="Advanced · Improve"
            title="Online scoring rules"
            description="Sampled production scorers (code → SLM → LLM). Open via Advanced nav or ⌘K."
            actions={
              <div className="flex flex-wrap items-center gap-space-2">
                <Button asChild variant="ghost" className="min-h-11">
                  <Link href="/improve">
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Improve
                  </Link>
                </Button>
                <Button
                  className="min-h-11"
                  onClick={() => {
                    resetForm();
                    setShowForm(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> New rule
                </Button>
              </div>
            }
          />
        }
        table={
          <div className="space-y-space-4">
            {rewindJob ? (
              <p className="text-xs text-[var(--accent)]">
                Rewind job in progress: {rewindJob}
              </p>
            ) : null}

            {showForm ? (
              <OnlineScoringForm
                editingId={editingId}
                name={name}
                filterQuery={filterQuery}
                scorerType={scorerType}
                sampleRate={sampleRate}
                busy={busy}
                onName={setName}
                onFilter={setFilterQuery}
                onType={setScorerType}
                onRate={setSampleRate}
                onSave={() => void save()}
                onCancel={resetForm}
              />
            ) : null}

            <OnlineScoringTestPanel
              testTraceId={testTraceId}
              busy={busy}
              onTraceId={setTestTraceId}
              onApply={() => void testApply()}
            />

            {rulesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading rules…
              </div>
            ) : rulesQuery.isError ? (
              <ErrorState
                title="Could not load scoring rules"
                message={
                  rulesQuery.error instanceof Error
                    ? rulesQuery.error.message
                    : "Online scoring rules could not be loaded."
                }
                onRetry={() => void refresh()}
              />
            ) : rules.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No online scoring rules yet"
                description={U20_EMPTY_COPY.onlineScoring}
                action={
                  <Button className="min-h-11" onClick={() => setShowForm(true)}>
                    Create rule
                  </Button>
                }
              />
            ) : (
              <OnlineScoringRulesTable
                rules={rules}
                busy={busy}
                onToggle={(r) => void toggleEnabled(r)}
                onEdit={startEdit}
                onRewind={(id) => void rewind(id)}
              />
            )}

            <p className="text-xs text-[var(--text-muted)]">
              Tip: start a scorer from the{" "}
              <Link
                href="/evals?tab=playgrounds"
                className="text-[var(--accent)] hover:underline"
              >
                playground
              </Link>{" "}
              then enable it here for production sampling.
            </p>
          </div>
        }
      />
    </div>
  );
}

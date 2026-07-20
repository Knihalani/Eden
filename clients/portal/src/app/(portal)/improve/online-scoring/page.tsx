"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { wave6Api } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import { Loader2, Sparkles, Plus, RotateCcw, FlaskConical } from "lucide-react";

type ScoringRule = {
  id: string;
  name: string;
  scope?: string;
  scorer_type?: string;
  sample_rate?: number;
  enabled?: boolean;
  filter_query?: string;
  description?: string;
};

function SlmBadge({ type }: { type?: string }) {
  if ((type || "").toLowerCase() !== "slm") return null;
  return (
    <span className="rounded bg-[var(--warning-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--warning)]">
      SLM
    </span>
  );
}

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

  const rulesQuery = useOrgQuery(
    ["wave6", "scoring-rules", orgId],
    orgId,
    () => wave6Api.listScoringRules(orgId!),
  );

  const rules = (rulesQuery.data?.data?.rules ?? []) as ScoringRule[];

  if (!currentOrg && !authError) return <NoOrgState feature="Online scoring" />;
  if (!currentOrg) return null;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["wave6", "scoring-rules", orgId] });

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
    <>
      <PageHeader
        title="Online scoring rules"
        description="Create, enable, test, and rewind production scorers (code → SLM → LLM)."
        actions={
          <Button size="sm" onClick={() => { resetForm(); setShowForm(true); }}>
            <Plus className="h-3.5 w-3.5" /> New rule
          </Button>
        }
      />
      <PageContent>
        {rewindJob ? (
          <p className="mb-3 text-xs text-[var(--accent)]">
            Rewind job in progress: {rewindJob}
          </p>
        ) : null}

        {showForm ? (
          <Card className="mb-4 space-y-3 p-4">
            <h3 className="text-sm font-medium">{editingId ? "Edit rule" : "Create rule"}</h3>
            <FormField label="Name" htmlFor="os-name" required>
              <Input id="os-name" value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField label="Filter query" htmlFor="os-filter">
              <Input
                id="os-filter"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder='agent="…" outcome=failure'
              />
            </FormField>
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label="Scorer type" htmlFor="os-type">
                <select
                  id="os-type"
                  className="w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-raised)] p-2 text-sm"
                  value={scorerType}
                  onChange={(e) => setScorerType(e.target.value)}
                >
                  <option value="code">code</option>
                  <option value="slm">slm</option>
                  <option value="llm">llm</option>
                </select>
              </FormField>
              <FormField label="Sample rate (0–1)" htmlFor="os-rate">
                <Input
                  id="os-rate"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sampleRate}
                  onChange={(e) => setSampleRate(Number(e.target.value))}
                />
              </FormField>
            </div>
            <div className="flex gap-2">
              <Button onClick={save} disabled={busy || !name.trim()} loading={busy}>
                Save
              </Button>
              <Button variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          </Card>
        ) : null}

        <Card className="mb-4 space-y-2 p-4">
          <h3 className="text-sm font-medium">Test on trace</h3>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="trace id"
              value={testTraceId}
              onChange={(e) => setTestTraceId(e.target.value)}
              className="max-w-md"
            />
            <Button variant="outline" size="sm" onClick={testApply} disabled={busy}>
              <FlaskConical className="h-3.5 w-3.5" /> Apply rules
            </Button>
          </div>
        </Card>

        {rulesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
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
            action={
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          />
        ) : rules.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No online scoring rules yet"
            description="Create a rule to score production traces on a sample. Code evaluators and SLM judges run first; full LLM only on low confidence."
            action={
              <Button size="sm" onClick={() => setShowForm(true)}>
                Create rule
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3">
            {rules.map((rule) => (
              <Card key={String(rule.id)} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{String(rule.name)}</p>
                      <SlmBadge type={rule.scorer_type} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {String(rule.scope || "trace")} · {String(rule.scorer_type)} · sample{" "}
                      {Math.round(Number(rule.sample_rate ?? 1) * 100)}%
                    </p>
                    {rule.filter_query ? (
                      <p className="mt-1 font-mono text-xs text-[var(--text-muted)]">
                        {rule.filter_query}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Switch
                      checked={Boolean(rule.enabled)}
                      onCheckedChange={() => void toggleEnabled(rule)}
                      label={rule.enabled ? "Enabled" : "Disabled"}
                    />
                    <Button size="sm" variant="outline" onClick={() => startEdit(rule)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void rewind(rule.id)}
                      disabled={busy}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Rewind
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        <p className="mt-4 text-xs text-[var(--text-muted)]">
          Tip: start a scorer from the{" "}
          <Link href="/evals?tab=playgrounds" className="text-[var(--accent)] hover:underline">
            playground
          </Link>{" "}
          then enable it here for production sampling.
        </p>
      </PageContent>
    </>
  );
}

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { useOrgQuery } from "@/hooks/use-api-query";
import { metricStudioApi } from "@/lib/api";
import type { MetricStudioMetric, MetricStudioTemplate } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { Sparkles, Loader2, Plus, FileText, Layers, ListChecks, Eye, CheckCircle2, Wand2, Save, Trash2, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  featureGatedErrorCopy,
  featureGatedMessage,
} from "@/lib/feature-flag-error";

type Tab = "templates" | "examples" | "metrics";

interface ExampleRow {
  input: string;
  output: string;
  label: "pass" | "fail";
  rationale: string;
}

export type TemplateSeed = {
  name: string;
  domain: string;
  notes?: string;
};

/** Mirror of studio metrics empty gate — keep in sync with MyMetricsTab. */
export function showStudioMetricsEmpty(opts: {
  loading: boolean;
  hasError: boolean;
  metricCount: number;
}): boolean {
  return !opts.loading && !opts.hasError && opts.metricCount === 0;
}

/** True when From-examples work should block navigation without confirm. */
export function studioExamplesIsDirty(opts: {
  generated: boolean;
  name: string;
  examples: ExampleRow[];
}): boolean {
  if (opts.generated) return true;
  if (opts.name.trim()) return true;
  return opts.examples.some(
    (e) => e.input.trim() || e.output.trim() || e.rationale.trim(),
  );
}

function isProduction(status: string | undefined): boolean {
  return status === "production";
}

export default function StudioPage() {
  const { currentOrg } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("templates");
  const [error, setError] = useState("");
  const [examplesDirty, setExamplesDirty] = useState(false);
  const [templateSeed, setTemplateSeed] = useState<TemplateSeed | null>(null);

  const requestTabChange = useCallback(
    (next: Tab) => {
      if (next === activeTab) return;
      if (activeTab === "examples" && examplesDirty) {
        const leave = window.confirm(
          "You have unsaved rubric work. Leave this tab?",
        );
        if (!leave) return;
      }
      setError("");
      setActiveTab(next);
    },
    [activeTab, examplesDirty],
  );

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Eval"
        title="Custom-Metric Studio"
        subtitle="Live metric studio (not a stub) — design, generate, and version rubrics from templates or examples."
        icon={Sparkles}
      />

      {error ? (
        <ErrorState
          title="Something went wrong"
          message={error}
          action={
            <button
              type="button"
              onClick={() => setError("")}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border-default)] text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              Dismiss
            </button>
          }
        />
      ) : null}

      {!currentOrg ? (
        <NoOrgState
          icon={Sparkles}
          feature="Custom-Metric Studio"
          description="Choose an organization to design and version custom evaluation rubrics."
        />
      ) : (
        <>
          <Tabs
            value={activeTab}
            onValueChange={(v) => requestTabChange(v as Tab)}
          >
            <TabsList aria-label="Custom-Metric Studio sections" className="bg-[var(--bg-tertiary)] rounded-xl h-auto flex-wrap w-fit">
              {(
                [
                  { key: "templates" as Tab, label: "Templates", icon: FileText },
                  { key: "examples" as Tab, label: "From examples", icon: Wand2 },
                  { key: "metrics" as Tab, label: "My metrics", icon: Layers },
                ] as const
              ).map(({ key, label, icon: Icon }) => (
                <TabsTrigger key={key} value={key} className="flex items-center gap-2 data-[state=active]:text-[var(--text-primary)]">
                  <Icon className="w-4 h-4" aria-hidden />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            {activeTab === "templates" && (
              <TemplatesTab
                orgId={currentOrg.id}
                onUseTemplate={(seed) => {
                  setTemplateSeed(seed);
                  setActiveTab("examples");
                  setError("");
                }}
              />
            )}
            {activeTab === "examples" && (
              <FromExamplesTab
                orgId={currentOrg.id}
                onError={setError}
                onDirtyChange={setExamplesDirty}
                templateSeed={templateSeed}
                onTemplateSeedConsumed={() => setTemplateSeed(null)}
              />
            )}
            {activeTab === "metrics" && <MyMetricsTab orgId={currentOrg.id} onError={setError} />}
          </Tabs>
        </>
      )}
    </PageContent>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Templates Tab
// ──────────────────────────────────────────────────────────────────────────

function TemplatesTab({
  orgId,
  onUseTemplate,
}: {
  orgId: string;
  onUseTemplate: (seed: TemplateSeed) => void;
}) {
  const [openTemplate, setOpenTemplate] = useState<MetricStudioTemplate | null>(null);
  const templatesQuery = useOrgQuery(
    queryKeys.studio.templates(orgId),
    orgId,
    async () => {
      const data = await metricStudioApi.listTemplates(orgId);
      return data.templates;
    },
  );
  const templates = templatesQuery.data ?? [];
  const loading = templatesQuery.isLoading;
  if (templatesQuery.error && !loading) {
    const copy = featureGatedErrorCopy(
      templatesQuery.error,
      "Could not load templates",
    );
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={
          <button
            onClick={() => void templatesQuery.refetch()}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            Try again
          </button>
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : templates.length === 0 ? (
        <EmptyState icon={FileText} title="No templates yet" description="Built-in rubric templates will appear here as they are added." size="lg" />
      ) : (
        <Card padding="lg" className="overflow-hidden">
          <DataTable
            columns={[
              {
                key: "name",
                header: "Name",
                sortable: true,
                cell: (tpl) => <span className="font-medium text-[var(--text-primary)]">{tpl.name}</span>,
              },
              {
                key: "domain",
                header: "Domain",
                cell: (tpl) => (
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {tpl.domain}
                  </span>
                ),
              },
              {
                key: "criteria",
                header: "Criteria",
                align: "right",
                cell: (tpl) => <span className="text-[var(--text-secondary)]">{tpl.criteria?.length ?? 0}</span>,
              },
              {
                key: "notes",
                header: "Preview",
                cell: (tpl) => (
                  <span className="text-[var(--text-muted)] max-w-md truncate inline-block">
                    {tpl.criteria?.[0] ?? tpl.notes ?? "—"}
                  </span>
                ),
              },
              {
                key: "id",
                header: "Action",
                align: "right",
                cell: (tpl) => (
                  <button
                    onClick={() => setOpenTemplate(tpl)}
                    aria-label={`Use template ${tpl.name}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Use template
                  </button>
                ),
              },
            ]}
            rows={templates}
            rowKey={(tpl) => tpl.id}
            defaultSort={{ key: "name", direction: "asc" }}
            emptyTitle="No templates yet"
            emptyDescription="Built-in rubric templates will appear here as they are added."
            pageSize={25}
          />
        </Card>
      )}

      <Dialog open={!!openTemplate} onOpenChange={(o) => !o && setOpenTemplate(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
              {openTemplate?.name}
            </DialogTitle>
            <DialogDescription>
              Template rubric (domain: {openTemplate?.domain}
              {openTemplate?.version ? ` · v${openTemplate.version}` : ""})
            </DialogDescription>
          </DialogHeader>
          {openTemplate?.notes && (
            <p className="text-xs text-[var(--text-secondary)]">{openTemplate.notes}</p>
          )}
          <ol className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[50vh] space-y-2 list-decimal list-inside">
            {(openTemplate?.criteria ?? []).map((c, i) => (
              <li key={i} className="whitespace-pre-wrap">
                {c}
              </li>
            ))}
          </ol>
          <DialogFooter>
            <button
              onClick={() => setOpenTemplate(null)}
              aria-label="Close template preview"
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              Close
            </button>
            <button
              onClick={() => {
                if (!openTemplate) return;
                onUseTemplate({
                  name: openTemplate.name,
                  domain: openTemplate.domain || "general",
                  notes: openTemplate.notes,
                });
                setOpenTemplate(null);
              }}
              aria-label={`Start from template ${openTemplate?.name}`}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
              Start from template
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// From Examples Tab
// ──────────────────────────────────────────────────────────────────────────

function blankExamples(): ExampleRow[] {
  return [
    { input: "", output: "", label: "pass", rationale: "" },
    { input: "", output: "", label: "fail", rationale: "" },
  ];
}

function FromExamplesTab({
  orgId,
  onError,
  onDirtyChange,
  templateSeed,
  onTemplateSeedConsumed,
}: {
  orgId: string;
  onError: (s: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  templateSeed: TemplateSeed | null;
  onTemplateSeedConsumed: () => void;
}) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("general");
  const [examples, setExamples] = useState<ExampleRow[]>(blankExamples);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<{
    rubric_id: string;
    rubric_prompt: string;
    rubric_tokens: number;
    domain: string;
  } | null>(null);
  const seedApplied = useRef<string | null>(null);

  const dirty = studioExamplesIsDirty({
    generated: !!generated,
    name,
    examples,
  });

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!templateSeed) return;
    const key = `${templateSeed.name}:${templateSeed.domain}`;
    if (seedApplied.current === key) return;
    seedApplied.current = key;
    setName(templateSeed.name);
    setDomain(templateSeed.domain || "general");
    if (templateSeed.notes) {
      setExamples((prev) =>
        prev.map((row, idx) =>
          idx === 0
            ? { ...row, rationale: templateSeed.notes || row.rationale }
            : row,
        ),
      );
    }
    onTemplateSeedConsumed();
  }, [templateSeed, onTemplateSeedConsumed]);

  function updateExample(i: number, key: keyof ExampleRow, value: string) {
    setExamples((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)),
    );
  }
  function addExample() {
    if (examples.length >= 5) return;
    setExamples((prev) => [...prev, { input: "", output: "", label: "pass", rationale: "" }]);
  }
  function removeExample(i: number) {
    if (examples.length <= 2) return;
    setExamples((prev) => prev.filter((_, idx) => idx !== i));
  }
  function discardGenerated() {
    if (generated) {
      const ok = window.confirm("Discard the generated rubric? This cannot be undone.");
      if (!ok) return;
    }
    setGenerated(null);
  }
  async function handleGenerate() {
    onError("");
    const filled = examples.filter((e) => e.input.trim() && e.output.trim());
    if (filled.length < 2) {
      onError("Provide at least 2 examples with input and output filled in.");
      return;
    }
    if (!name.trim()) {
      onError("Name is required.");
      return;
    }
    setGenerating(true);
    try {
      const data = await metricStudioApi.fromExamples(orgId, {
        name: name.trim(),
        domain: domain.trim() || "general",
        examples: filled.map((e) => ({
          input: e.input.trim(),
          output: e.output.trim(),
          label: e.label,
          rationale: e.rationale.trim() || undefined,
        })),
      });
      setGenerated({
        rubric_id: data.rubric_id,
        rubric_prompt: data.rubric_prompt,
        rubric_tokens: data.rubric_tokens,
        domain: data.domain,
      });
    } catch (err) {
      onError(featureGatedMessage(err, "Generation failed"));
    } finally {
      setGenerating(false);
    }
  }
  async function handleSave() {
    if (!generated) return;
    onError("");
    setSaving(true);
    try {
      await metricStudioApi.createMetric(orgId, {
        name: name.trim(),
        rubric_id: generated.rubric_id,
        domain: generated.domain,
      });
      setGenerated(null);
      setName("");
      setDomain("general");
      setExamples(blankExamples());
      seedApplied.current = null;
    } catch (err) {
      onError(featureGatedMessage(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-4">
      <Card padding="lg" className="space-y-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-[var(--accent)]" />
          Generate a rubric from examples
          {dirty ? (
            <span className="text-xs font-normal text-[var(--warning)]">Unsaved changes</span>
          ) : null}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="metric-name" className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">
              Metric name
            </label>
            <input
              id="metric-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Tone consistency, code clarity, etc."
              aria-label="Metric name"
              disabled={generating || saving}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
            />
          </div>
          <div>
            <label htmlFor="metric-domain" className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">
              Domain
            </label>
            <select
              id="metric-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              aria-label="Metric domain"
              disabled={generating || saving}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] disabled:opacity-50"
            >
              {["general", "safety", "compliance", "marketing", "legal", "factual", "tone"].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-3">
          {examples.map((ex, i) => (
            <div key={i} className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-muted)]">Example {i + 1}</span>
                {examples.length > 2 && (
                  <button
                    onClick={() => removeExample(i)}
                    aria-label={`Remove example ${i + 1}`}
                    disabled={generating || saving}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--error)] transition-colors disabled:opacity-50"
                    title="Remove example"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
              <input
                type="text"
                value={ex.input}
                onChange={(e) => updateExample(i, "input", e.target.value)}
                placeholder="Input"
                aria-label={`Example ${i + 1} input`}
                disabled={generating || saving}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
              />
              <input
                type="text"
                value={ex.output}
                onChange={(e) => updateExample(i, "output", e.target.value)}
                placeholder="Output"
                aria-label={`Example ${i + 1} output`}
                disabled={generating || saving}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={`label-${i}`} className="text-[10px] font-medium text-[var(--text-muted)] mb-1 block">
                    Label
                  </label>
                  <select
                    id={`label-${i}`}
                    value={ex.label}
                    onChange={(e) => updateExample(i, "label", e.target.value as "pass" | "fail")}
                    aria-label={`Example ${i + 1} label`}
                    disabled={generating || saving}
                    className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] disabled:opacity-50"
                  >
                    <option value="pass">pass</option>
                    <option value="fail">fail</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`rationale-${i}`} className="text-[10px] font-medium text-[var(--text-muted)] mb-1 block">
                    Rationale
                  </label>
                  <input
                    id={`rationale-${i}`}
                    type="text"
                    value={ex.rationale}
                    onChange={(e) => updateExample(i, "rationale", e.target.value)}
                    placeholder="Why this label?"
                    aria-label={`Example ${i + 1} rationale`}
                    disabled={generating || saving}
                    className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {examples.length < 5 && (
            <button
              onClick={addExample}
              aria-label="Add another example"
              disabled={generating || saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              Add example
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            aria-label="Generate rubric from examples"
            className="ml-auto inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Wand2 className="w-4 h-4" aria-hidden="true" />}
            Generate rubric
          </button>
        </div>
      </Card>

      {generated && (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[var(--accent)]" />
              Generated rubric
            </h3>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--accent-faint)] text-[var(--accent)]">
              ~{generated.rubric_tokens} tokens
            </span>
          </div>
          <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[40vh] whitespace-pre-wrap">
            {generated.rubric_prompt}
          </pre>
          <div className="flex justify-end gap-2">
            <button
              onClick={discardGenerated}
              disabled={saving}
              aria-label="Discard generated rubric"
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              aria-label="Save generated rubric as a metric"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Save className="w-3.5 h-3.5" aria-hidden="true" />}
              Save as metric
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// My Metrics Tab
// ──────────────────────────────────────────────────────────────────────────

function MyMetricsTab({
  orgId,
  onError,
}: {
  orgId: string;
  onError: (s: string) => void;
}) {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<MetricStudioMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [openDetail, setOpenDetail] = useState<MetricStudioMetric | null>(null);
  const [approving, setApproving] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await metricStudioApi.listMetrics(orgId);
      setMetrics(data.metrics);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [orgId]);
  useEffect(() => {
    load();
  }, [load]);
  async function openMetric(metricId: string) {
    try {
      const detail = await metricStudioApi.getMetric(orgId, metricId);
      if (!detail.found || !detail.metric) {
        onError("Metric not found");
        return;
      }
      setOpenDetail(detail.metric);
    } catch (err) {
      onError(featureGatedMessage(err, "Failed to load metric"));
    }
  }
  async function handleApprove() {
    if (!openDetail) return;
    const approvedBy = user?.email?.trim() || user?.user_id;
    if (!approvedBy) {
      onError("Signed-in user email is required to approve.");
      return;
    }
    setApproving(true);
    onError("");
    try {
      await metricStudioApi.approveMetric(orgId, openDetail.metric_id, {
        approved_by: approvedBy,
      });
      setOpenDetail({
        ...openDetail,
        status: "production",
      });
      setMetrics((prev) =>
        prev.map((m) =>
          m.metric_id === openDetail.metric_id ? { ...m, status: "production" } : m,
        ),
      );
    } catch (err) {
      onError(featureGatedMessage(err, "Approval failed"));
    } finally {
      setApproving(false);
    }
  }
  if (loadError && !loading) {
    const copy = featureGatedErrorCopy(loadError, "Could not load metrics");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            Try again
          </button>
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : showStudioMetricsEmpty({
          loading,
          hasError: !!loadError,
          metricCount: metrics.length,
        }) ? (
        <EmptyState icon={Layers} title="No metrics yet" description="Generate one from the “From examples” tab to see it here." size="lg" />
      ) : (
        <Card padding="lg" className="overflow-hidden">
          <DataTable
            columns={[
              {
                key: "name",
                header: "Name",
                sortable: true,
                cell: (m) => <span className="font-medium text-[var(--text-primary)]">{m.name}</span>,
              },
              {
                key: "version",
                header: "Version",
                cell: (m) => <span className="text-[var(--text-secondary)] font-mono text-xs">{m.version}</span>,
              },
              {
                key: "created_at",
                header: "Created",
                sortable: true,
                cell: (m) => (
                  <span className="text-[var(--text-muted)] text-xs">
                    {m.created_at ? new Date(m.created_at).toLocaleString() : "—"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                cell: (m) =>
                  isProduction(m.status) ? (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--terminal-faint)] text-[var(--terminal)]">
                      <CheckCircle2 className="w-3 h-3" />
                      Production
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--warning-bg)] text-[var(--warning)]">
                      <Clock className="w-3 h-3" />
                      {m.status || "draft"}
                    </span>
                  ),
              },
              {
                key: "metric_id",
                header: "Action",
                align: "right",
                cell: (m) => (
                  <button
                    onClick={() => openMetric(m.metric_id)}
                    aria-label={`View metric ${m.name}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
                  >
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                    View
                  </button>
                ),
              },
            ]}
            rows={metrics}
            rowKey={(m) => m.metric_id}
            defaultSort={{ key: "created_at", direction: "desc" }}
            emptyTitle="No metrics yet"
            emptyDescription="Generate one from the “From examples” tab to see it here."
            emptyIcon={Layers}
            pageSize={25}
          />
        </Card>
      )}

      <Dialog open={!!openDetail} onOpenChange={(o) => !o && setOpenDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
              {openDetail?.name}
            </DialogTitle>
            <DialogDescription>
              Domain: {openDetail?.domain ?? "—"} · Version: {openDetail?.version} · Status:{" "}
              {openDetail?.status}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs text-[var(--text-secondary)]">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">Metric ID</div>
                <div className="font-mono break-all">{openDetail?.metric_id}</div>
              </div>
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">Rubric ID</div>
                <div className="font-mono break-all">{openDetail?.rubric_id}</div>
              </div>
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">Judge ID</div>
                <div className="font-mono break-all">{openDetail?.judge_id || "—"}</div>
              </div>
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">Created</div>
                <div>{openDetail?.created_at ? new Date(openDetail.created_at).toLocaleString() : "—"}</div>
              </div>
            </div>
            {(openDetail?.n_scores_30d != null || openDetail?.median_score != null) && (
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">30-day scores</div>
                <div>
                  n={openDetail?.n_scores_30d ?? 0}
                  {openDetail?.median_score != null ? ` · median ${openDetail.median_score}` : ""}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <button
              onClick={() => setOpenDetail(null)}
              disabled={approving}
              aria-label="Close metric detail"
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors disabled:opacity-50"
            >
              Close
            </button>
            <button
              onClick={handleApprove}
              disabled={approving || isProduction(openDetail?.status)}
              aria-label={`Approve metric ${openDetail?.name}`}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {approving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              {isProduction(openDetail?.status) ? "Approved" : "Approve"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

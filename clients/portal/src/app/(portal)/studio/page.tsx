"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { metricStudioApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { motion, AnimatePresence } from "framer-motion";
import { DataTable } from "@/components/ui/data-table";
import {
  Sparkles,
  Loader2,
  Plus,
  FileText,
  Layers,
  ListChecks,
  Eye,
  CheckCircle2,
  AlertTriangle,
  Wand2,
  Save,
  Trash2,
  Clock,
  History,
} from "lucide-react";

type Tab = "templates" | "examples" | "metrics";

interface Template {
  template_id: string;
  name: string;
  category: string;
  rubric: string;
  example_count: number;
}

interface MetricSummary {
  metric_id: string;
  name: string;
  version: string;
  created_at: string;
  approved: boolean;
}

interface MetricDetail {
  metric_id: string;
  name: string;
  rubric: string;
  model: string;
  version: string;
  history: Array<{ version: string; tagged_at: string }>;
}

interface ExampleRow {
  input: string;
  output: string;
  score: number;
  rationale: string;
}

export default function StudioPage() {
  const { currentOrg } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("templates");
  const [error, setError] = useState("");

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Eval"
        title="Custom-Metric Studio"
        subtitle="Design, generate, and version custom evaluation rubrics from templates or examples."
        icon={Sparkles}
      />

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {!currentOrg ? (
        <NoOrgState
          icon={Sparkles}
          feature="Custom-Metric Studio"
          description="Choose an organization to design and version custom evaluation rubrics."
        />
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Custom-Metric Studio sections"
            className="flex items-center gap-1 p-1 bg-[var(--bg-tertiary)] rounded-xl w-fit flex-wrap"
          >
            {([
              { key: "templates" as Tab, label: "Templates", icon: FileText },
              { key: "examples" as Tab, label: "From examples", icon: Wand2 },
              { key: "metrics" as Tab, label: "My metrics", icon: Layers },
            ]).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                role="tab"
                aria-selected={activeTab === key}
                aria-label={label}
                onClick={() => setActiveTab(key)}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2",
                  activeTab === key
                    ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm"
                    : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                )}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === "templates" && <TemplatesTab orgId={currentOrg.id} onError={setError} />}
              {activeTab === "examples" && <FromExamplesTab orgId={currentOrg.id} onError={setError} />}
              {activeTab === "metrics" && <MyMetricsTab orgId={currentOrg.id} onError={setError} />}
            </motion.div>
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Templates Tab
// ──────────────────────────────────────────────────────────────────────────

function TemplatesTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [openTemplate, setOpenTemplate] = useState<Template | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    onError("");
    try {
      const data = await metricStudioApi.listTemplates(orgId);
      setTemplates(data.templates);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [orgId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No templates yet"
          description="Built-in rubric templates will appear here as they are added."
          size="lg"
        />
      ) : (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <DataTable
            columns={[
              { key: "name", header: "Name", sortable: true, cell: (tpl) => <span className="font-medium text-[var(--text-primary)]">{tpl.name}</span> },
              {
                key: "category",
                header: "Category",
                cell: (tpl) => (
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {tpl.category}
                  </span>
                ),
              },
              { key: "example_count", header: "Examples", sortable: true, align: "right", cell: (tpl) => <span className="text-[var(--text-secondary)]">{tpl.example_count}</span> },
              { key: "rubric", header: "Rubric preview", cell: (tpl) => <span className="text-[var(--text-muted)] max-w-md truncate inline-block">{tpl.rubric}</span> },
              {
                key: "template_id",
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
            rowKey={(tpl) => tpl.template_id}
            defaultSort={{ key: "name", direction: "asc" }}
            emptyTitle="No templates yet"
            emptyDescription="Built-in rubric templates will appear here as they are added."
            pageSize={25}
          />
        </div>
      )}

      <Dialog open={!!openTemplate} onOpenChange={(o) => !o && setOpenTemplate(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
              {openTemplate?.name}
            </DialogTitle>
            <DialogDescription>
              Template rubric (category: {openTemplate?.category})
            </DialogDescription>
          </DialogHeader>
          <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[50vh] whitespace-pre-wrap">
            {openTemplate?.rubric}
          </pre>
          <DialogFooter>
            <button
              onClick={() => setOpenTemplate(null)}
              aria-label="Close template preview"
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              Close
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

function FromExamplesTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [name, setName] = useState("");
  const [examples, setExamples] = useState<ExampleRow[]>([
    { input: "", output: "", score: 0, rationale: "" },
    { input: "", output: "", score: 0, rationale: "" },
  ]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<{ rubric: string; confidence: number } | null>(null);

  function updateExample(i: number, key: keyof ExampleRow, value: string | number) {
    setExamples((prev) => prev.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)));
  }

  function addExample() {
    if (examples.length >= 5) return;
    setExamples((prev) => [...prev, { input: "", output: "", score: 0, rationale: "" }]);
  }

  function removeExample(i: number) {
    if (examples.length <= 2) return;
    setExamples((prev) => prev.filter((_, idx) => idx !== i));
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
      const data = await metricStudioApi.fromExamples(orgId, { examples: filled, name: name.trim() });
      setGenerated({ rubric: data.rubric, confidence: data.confidence });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave() {
    if (!generated) return;
    onError("");
    setSaving(true);
    try {
      await metricStudioApi.createMetric(orgId, { name: name.trim(), rubric: generated.rubric });
      setGenerated(null);
      setName("");
      setExamples([
        { input: "", output: "", score: 0, rationale: "" },
        { input: "", output: "", score: 0, rationale: "" },
      ]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-[var(--accent)]" />
          Generate a rubric from examples
        </h3>
        <div>
          <label
            htmlFor="metric-name"
            className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block"
          >
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
                  <label
                    htmlFor={`score-${i}`}
                    className="text-[10px] font-medium text-[var(--text-muted)] mb-1 block"
                  >
                    Score (0-1)
                  </label>
                  <input
                    id={`score-${i}`}
                    type="number"
                    min={0}
                    max={1}
                    step={0.1}
                    value={ex.score}
                    onChange={(e) => updateExample(i, "score", Number(e.target.value))}
                    aria-label={`Example ${i + 1} score`}
                    disabled={generating || saving}
                    className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] disabled:opacity-50"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`rationale-${i}`}
                    className="text-[10px] font-medium text-[var(--text-muted)] mb-1 block"
                  >
                    Rationale
                  </label>
                  <input
                    id={`rationale-${i}`}
                    type="text"
                    value={ex.rationale}
                    onChange={(e) => updateExample(i, "rationale", e.target.value)}
                    placeholder="Why this score?"
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
      </div>

      {generated && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[var(--accent)]" />
              Generated rubric
            </h3>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--accent-faint)] text-[var(--accent)]">
              Confidence {(generated.confidence * 100).toFixed(0)}%
            </span>
          </div>
          <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[40vh] whitespace-pre-wrap">
            {generated.rubric}
          </pre>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setGenerated(null)}
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
        </motion.div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// My Metrics Tab
// ──────────────────────────────────────────────────────────────────────────

function MyMetricsTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [metrics, setMetrics] = useState<MetricSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openDetail, setOpenDetail] = useState<MetricDetail | null>(null);
  const [approving, setApproving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    onError("");
    try {
      const data = await metricStudioApi.listMetrics(orgId);
      setMetrics(data.metrics);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  }, [orgId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  async function openMetric(metricId: string) {
    try {
      const detail = await metricStudioApi.getMetric(orgId, metricId);
      setOpenDetail(detail);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load metric");
    }
  }

  async function handleApprove() {
    if (!openDetail) return;
    setApproving(true);
    onError("");
    try {
      await metricStudioApi.approveMetric(orgId, openDetail.metric_id);
      setOpenDetail({ ...openDetail });
      // Reflect in the table list
      setMetrics((prev) =>
        prev.map((m) => (m.metric_id === openDetail.metric_id ? { ...m, approved: true } : m))
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="space-y-4">
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : metrics.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No metrics yet"
          description="Generate one from the “From examples” tab to see it here."
          size="lg"
        />
      ) : (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <DataTable
            columns={[
              { key: "name", header: "Name", sortable: true, cell: (m) => <span className="font-medium text-[var(--text-primary)]">{m.name}</span> },
              { key: "version", header: "Version", cell: (m) => <span className="text-[var(--text-secondary)] font-mono text-xs">{m.version}</span> },
              {
                key: "created_at",
                header: "Created",
                sortable: true,
                cell: (m) => <span className="text-[var(--text-muted)] text-xs">{m.created_at ? new Date(m.created_at).toLocaleString() : "—"}</span>,
              },
              {
                key: "approved",
                header: "Status",
                cell: (m) =>
                  m.approved ? (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--terminal-faint)] text-[var(--terminal)]">
                      <CheckCircle2 className="w-3 h-3" />
                      Approved
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--warning-bg)] text-[var(--warning)]">
                      <Clock className="w-3 h-3" />
                      Pending
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
        </div>
      )}

      <Dialog open={!!openDetail} onOpenChange={(o) => !o && setOpenDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
              {openDetail?.name}
            </DialogTitle>
            <DialogDescription>
              Model: {openDetail?.model} · Version: {openDetail?.version}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-1.5 uppercase tracking-wide">Rubric</h4>
              <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[40vh] whitespace-pre-wrap">
                {openDetail?.rubric}
              </pre>
            </div>

            {openDetail?.history && openDetail.history.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-1.5 uppercase tracking-wide flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" aria-hidden="true" />
                  Version history
                </h4>
                <ul className="space-y-1 text-xs text-[var(--text-secondary)]">
                  {openDetail.history.map((h, i) => (
                    <li key={i} className="flex items-center justify-between px-2 py-1 rounded bg-[var(--bg-secondary)]">
                      <span className="font-mono">{h.version}</span>
                      <span className="text-[var(--text-muted)]">{new Date(h.tagged_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
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
              disabled={approving}
              aria-label={`Approve metric ${openDetail?.name}`}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {approving ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
              Approve
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

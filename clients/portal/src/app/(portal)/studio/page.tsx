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
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
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
          <div className="flex items-center gap-1 p-1 bg-[var(--bg-tertiary)] rounded-xl w-fit flex-wrap">
            {([
              { key: "templates" as Tab, label: "Templates", icon: FileText },
              { key: "examples" as Tab, label: "From examples", icon: Wand2 },
              { key: "metrics" as Tab, label: "My metrics", icon: Layers },
            ]).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2",
                  activeTab === key
                    ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm"
                    : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                )}
              >
                <Icon className="w-4 h-4" />
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Category</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Examples</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Rubric preview</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {templates.map((tpl) => (
                  <tr key={tpl.template_id} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-[var(--text-primary)]">{tpl.name}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        {tpl.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{tpl.example_count}</td>
                    <td className="px-4 py-3 text-[var(--text-muted)] max-w-md truncate">{tpl.rubric}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setOpenTemplate(tpl)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
                      >
                        <Wand2 className="w-3.5 h-3.5" />
                        Use template
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog open={!!openTemplate} onOpenChange={(o) => !o && setOpenTemplate(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-[var(--accent)]" />
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
          <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Metric name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Tone consistency, code clarity, etc."
            className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
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
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--error)] transition-colors"
                    title="Remove example"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <input
                type="text"
                value={ex.input}
                onChange={(e) => updateExample(i, "input", e.target.value)}
                placeholder="Input"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
              <input
                type="text"
                value={ex.output}
                onChange={(e) => updateExample(i, "output", e.target.value)}
                placeholder="Output"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-[var(--text-muted)] mb-1 block">Score (0-1)</label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.1}
                    value={ex.score}
                    onChange={(e) => updateExample(i, "score", Number(e.target.value))}
                    className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-[var(--text-muted)] mb-1 block">Rationale</label>
                  <input
                    type="text"
                    value={ex.rationale}
                    onChange={(e) => updateExample(i, "rationale", e.target.value)}
                    placeholder="Why this score?"
                    className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
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
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add example
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="ml-auto inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
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
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Version</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Created</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {metrics.map((m) => (
                  <tr key={m.metric_id} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-[var(--text-primary)]">{m.name}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)] font-mono text-xs">{m.version}</td>
                    <td className="px-4 py-3 text-[var(--text-muted)] text-xs">
                      {m.created_at ? new Date(m.created_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {m.approved ? (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--terminal-faint)] text-[var(--terminal)]">
                          <CheckCircle2 className="w-3 h-3" />
                          Approved
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--warning-bg)] text-[var(--warning)]">
                          <Clock className="w-3 h-3" />
                          Pending
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openMetric(m.metric_id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog open={!!openDetail} onOpenChange={(o) => !o && setOpenDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-[var(--accent)]" />
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
                  <History className="w-3.5 h-3.5" />
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
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleApprove}
              disabled={approving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {approving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              Approve
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

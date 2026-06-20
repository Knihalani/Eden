"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { evalApi } from "@/lib/api";
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
  BarChart3,
  Gauge,
  Loader2,
  Plus,
  AlertTriangle,
  Tag,
  Layers,
  Sparkles,
  UserCheck,
  Users,
  Shield,
  CheckCircle2,
  Eye,
  Send,
  Pencil,
} from "lucide-react";

type Tab = "versions" | "clusters" | "clhf" | "hil" | "pairwise";

interface Version {
  version_id: string;
  judge_name: string;
  version: string;
  tagged_at: string;
  notes: string | null;
}

interface Cluster {
  cluster_id: string;
  size: number;
  example_trace_ids: string[];
  representative_failure: string;
}

interface CLHFSample {
  prompt: string;
  chosen: string;
  rejected: string;
}

interface HILTask {
  task_id: string;
  trace_id: string;
  question: string;
}

interface Pair {
  a: string;
  b: string;
  trace_id: string;
}

export default function EvalPage() {
  const { currentOrg } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("versions");
  const [error, setError] = useState("");

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 page-enter">
      <PageHeader
        title="Evaluation"
        subtitle="Judge scores, comparison, and quality signals"
        icon={BarChart3}
        eyebrow="Observe"
      />

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {!currentOrg ? (
        <NoOrgState
          icon={Gauge}
          feature="Evaluation Quality"
          description="Choose an organization to manage judge versions, failure clusters, and human-in-the-loop data."
        />
      ) : (
        <>
          <div className="flex items-center gap-1 p-1 bg-[var(--bg-tertiary)] rounded-xl w-fit flex-wrap">
            {([
              { key: "versions" as Tab, label: "Versions", icon: Tag },
              { key: "clusters" as Tab, label: "Failure clusters", icon: Layers },
              { key: "clhf" as Tab, label: "CLHF", icon: Sparkles },
              { key: "hil" as Tab, label: "HIL queue", icon: UserCheck },
              { key: "pairwise" as Tab, label: "Pairwise", icon: Users },
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
              {activeTab === "versions" && <VersionsTab orgId={currentOrg.id} onError={setError} />}
              {activeTab === "clusters" && <FailureClustersTab orgId={currentOrg.id} onError={setError} />}
              {activeTab === "clhf" && <CLHFTab orgId={currentOrg.id} onError={setError} />}
              {activeTab === "hil" && <HILTab orgId={currentOrg.id} onError={setError} />}
              {activeTab === "pairwise" && <PairwiseTab orgId={currentOrg.id} onError={setError} />}
            </motion.div>
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Versions Tab
// ──────────────────────────────────────────────────────────────────────────

function VersionsTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagOpen, setTagOpen] = useState(false);
  const [form, setForm] = useState({ judge_name: "", version: "", notes: "" });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    onError("");
    try {
      const data = await evalApi.listVersions(orgId);
      setVersions(data.versions);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load versions");
    } finally {
      setLoading(false);
    }
  }, [orgId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleTag() {
    onError("");
    if (!form.judge_name.trim() || !form.version.trim()) {
      onError("Judge name and version are required.");
      return;
    }
    setSubmitting(true);
    try {
      await evalApi.tagVersion(orgId, {
        judge_name: form.judge_name.trim(),
        version: form.version.trim(),
        notes: form.notes.trim() || undefined,
      });
      setTagOpen(false);
      setForm({ judge_name: "", version: "", notes: "" });
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Tag failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setTagOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Tag new version
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : versions.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No versions tagged"
          description="Tag a judge version to start tracking which judge produced each score."
          size="lg"
        />
      ) : (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Judge</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Version</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Tagged at</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {versions.map((v) => (
                  <tr key={v.version_id} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-[var(--text-primary)]">{v.judge_name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-secondary)]">{v.version}</td>
                    <td className="px-4 py-3 text-[var(--text-muted)] text-xs">
                      {v.tagged_at ? new Date(v.tagged_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)] text-xs max-w-md truncate">
                      {v.notes || <span className="text-[var(--text-muted)]">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog open={tagOpen} onOpenChange={(o) => !o && setTagOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="w-4 h-4 text-[var(--accent)]" />
              Tag a new judge version
            </DialogTitle>
            <DialogDescription>
              Record which judge version produced a set of scores.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Judge name</label>
              <input
                type="text"
                value={form.judge_name}
                onChange={(e) => setForm({ ...form, judge_name: e.target.value })}
                placeholder="e.g. helpfulness-judge"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Version</label>
              <input
                type="text"
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                placeholder="e.g. 1.4.0"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Notes (optional)</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                placeholder="What changed in this version?"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={() => setTagOpen(false)}
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleTag}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Tag className="w-3.5 h-3.5" />}
              Tag version
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Failure Clusters Tab
// ──────────────────────────────────────────────────────────────────────────

function FailureClustersTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [openCluster, setOpenCluster] = useState<Cluster | null>(null);
  const [promoteForm, setPromoteForm] = useState({ judge_name: "", version: "", threshold: 0.5 });
  const [hasLoaded, setHasLoaded] = useState(false);

  async function load(days = 30) {
    setLoading(true);
    onError("");
    try {
      const data = await evalApi.failureClusters(orgId, { days });
      setClusters(data.clusters);
      setHasLoaded(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load clusters");
    } finally {
      setLoading(false);
    }
  }

  async function handlePromote() {
    if (!openCluster) return;
    onError("");
    if (!promoteForm.judge_name.trim() || !promoteForm.version.trim()) {
      onError("Judge name and version are required.");
      return;
    }
    setPromoting(openCluster.cluster_id);
    try {
      await evalApi.promoteToGuardrail(orgId, {
        judge_name: promoteForm.judge_name.trim(),
        version: promoteForm.version.trim(),
        threshold: promoteForm.threshold,
      });
      setOpenCluster(null);
      setPromoteForm({ judge_name: "", version: "", threshold: 0.5 });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Promote failed");
    } finally {
      setPromoting(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">Last 30 days of failure modes grouped by similarity.</p>
        <button
          onClick={() => load(30)}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
          {hasLoaded ? "Refresh" : "Find clusters"}
        </button>
      </div>

      {!hasLoaded && !loading ? (
        <EmptyState
          icon={Layers}
          title="No clusters loaded"
          description="Click “Find clusters” to cluster recent failure modes from judge scores."
          size="lg"
        />
      ) : loading && clusters.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : clusters.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No failures clustered"
          description="No failure modes found in the last 30 days."
          size="md"
        />
      ) : (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Cluster</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Size</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Representative failure</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {clusters.map((c) => (
                  <tr key={c.cluster_id} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">{c.cluster_id}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{c.size}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)] max-w-xl truncate">{c.representative_failure}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setOpenCluster(c)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
                      >
                        <Shield className="w-3.5 h-3.5" />
                        Promote to guardrail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog open={!!openCluster} onOpenChange={(o) => !o && setOpenCluster(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-[var(--accent)]" />
              Promote cluster to guardrail
            </DialogTitle>
            <DialogDescription>
              Cluster {openCluster?.cluster_id} ({openCluster?.size} failures)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Judge name</label>
              <input
                type="text"
                value={promoteForm.judge_name}
                onChange={(e) => setPromoteForm({ ...promoteForm, judge_name: e.target.value })}
                placeholder="e.g. helpfulness-judge"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Version</label>
              <input
                type="text"
                value={promoteForm.version}
                onChange={(e) => setPromoteForm({ ...promoteForm, version: e.target.value })}
                placeholder="e.g. 1.4.0"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Threshold (0-1)</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={promoteForm.threshold}
                onChange={(e) => setPromoteForm({ ...promoteForm, threshold: Number(e.target.value) })}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={() => setOpenCluster(null)}
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePromote}
              disabled={!!promoting}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {promoting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
              Promote
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// CLHF Tab
// ──────────────────────────────────────────────────────────────────────────

function CLHFTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [traceIds, setTraceIds] = useState("");
  const [n, setN] = useState(10);
  const [submitting, setSubmitting] = useState(false);
  const [samples, setSamples] = useState<CLHFSample[]>([]);
  const [generationId, setGenerationId] = useState<string | null>(null);

  async function handleGenerate() {
    onError("");
    const seeds = traceIds.split("\n").map((s) => s.trim()).filter(Boolean);
    if (seeds.length === 0) {
      onError("Provide at least one seed trace id.");
      return;
    }
    setSubmitting(true);
    try {
      const data = await evalApi.clhfGenerate(orgId, { seed_traces: seeds, n });
      setSamples(data.samples);
      setGenerationId(data.generation_id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[var(--accent)]" />
          Generate CLHF data
        </h3>
        <p className="text-xs text-[var(--text-muted)]">Provide seed traces (one id per line) to bootstrap chosen/rejected pairs.</p>
        <div className="grid sm:grid-cols-4 gap-3">
          <div className="sm:col-span-3">
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Seed trace IDs</label>
            <textarea
              value={traceIds}
              onChange={(e) => setTraceIds(e.target.value)}
              rows={3}
              placeholder={"trace_abc123\ntrace_def456"}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">N</label>
            <input
              type="number"
              min={1}
              max={50}
              value={n}
              onChange={(e) => setN(Number(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
            />
          </div>
        </div>
        <button
          onClick={handleGenerate}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Generate
        </button>
      </div>

      {generationId && (
        <p className="text-xs text-[var(--text-muted)]">Generation id: <span className="font-mono">{generationId}</span></p>
      )}

      {samples.length > 0 && (
        <div className="space-y-3">
          {samples.map((s, i) => (
            <div key={i} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 space-y-2">
              <div className="text-xs font-medium text-[var(--text-muted)]">Sample {i + 1}</div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Prompt</div>
                <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-2 mt-1 whitespace-pre-wrap">{s.prompt}</pre>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--terminal)]">Chosen</div>
                  <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-2 mt-1 whitespace-pre-wrap border-l-2 border-[var(--terminal)]">{s.chosen}</pre>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--error)]">Rejected</div>
                  <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-2 mt-1 whitespace-pre-wrap border-l-2 border-[var(--error)]">{s.rejected}</pre>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// HIL Tab
// ──────────────────────────────────────────────────────────────────────────

function HILTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [traceId, setTraceId] = useState("");
  const [question, setQuestion] = useState("");
  const [creating, setCreating] = useState(false);
  const [task, setTask] = useState<HILTask | null>(null);
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState(0.8);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    onError("");
    if (!traceId.trim() || !question.trim()) {
      onError("Trace id and question are required.");
      return;
    }
    setCreating(true);
    try {
      const data = await evalApi.hilTask(orgId, { trace_id: traceId.trim(), question: question.trim() });
      setTask(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Task creation failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleAnnotate() {
    if (!task) return;
    onError("");
    if (!answer.trim()) {
      onError("Answer is required.");
      return;
    }
    setSubmitting(true);
    try {
      await evalApi.hilAnnotation(orgId, {
        task_id: task.task_id,
        answer: answer.trim(),
        confidence,
      });
      setAnnotateOpen(false);
      setAnswer("");
      setTask(null);
      setTraceId("");
      setQuestion("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Annotation failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-[var(--accent)]" />
          Create HIL task
        </h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Trace ID</label>
            <input
              type="text"
              value={traceId}
              onChange={(e) => setTraceId(e.target.value)}
              placeholder="trace_abc123"
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Question</label>
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What should the agent have done?"
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        </div>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Create task
        </button>
      </div>

      {task && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Eye className="w-4 h-4 text-[var(--accent)]" />
              Task created
            </h3>
            <span className="text-xs text-[var(--text-muted)] font-mono">{task.task_id}</span>
          </div>
          <p className="text-xs text-[var(--text-muted)]">Trace: <span className="font-mono text-[var(--text-secondary)]">{task.trace_id}</span></p>
          <p className="text-sm text-[var(--text-primary)]">Q: {task.question}</p>
          <div className="flex justify-end">
            <button
              onClick={() => setAnnotateOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Annotate
            </button>
          </div>
        </motion.div>
      )}

      <Dialog open={annotateOpen} onOpenChange={(o) => !o && setAnnotateOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-4 h-4 text-[var(--accent)]" />
              Annotate task
            </DialogTitle>
            <DialogDescription>
              Record the ground-truth answer and your confidence.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Answer</label>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={4}
                placeholder="Ground truth answer..."
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Confidence (0-1)</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={confidence}
                onChange={(e) => setConfidence(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={() => setAnnotateOpen(false)}
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAnnotate}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              Submit
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Pairwise Tab
// ──────────────────────────────────────────────────────────────────────────

function PairwiseTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [n, setN] = useState(10);
  const [creating, setCreating] = useState(false);
  const [queueId, setQueueId] = useState<string | null>(null);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [decisions, setDecisions] = useState<Record<number, "a" | "b">>({});
  const [submitting, setSubmitting] = useState<number | null>(null);

  async function handleCreate() {
    onError("");
    if (n < 1) {
      onError("N must be at least 1.");
      return;
    }
    setCreating(true);
    try {
      const data = await evalApi.pairwiseQueue(orgId, { n });
      setQueueId(data.queue_id);
      setPairs(data.pairs);
      setDecisions({});
    } catch (err) {
      onError(err instanceof Error ? err.message : "Queue creation failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleDecide(pairIdx: number, preferred: "a" | "b") {
    if (!queueId) return;
    setSubmitting(pairIdx);
    onError("");
    try {
      await evalApi.pairwisePreference(orgId, {
        queue_id: queueId,
        pair_id: `${queueId}_${pairIdx}`,
        preferred,
      });
      setDecisions((prev) => ({ ...prev, [pairIdx]: preferred }));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Preference failed");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Users className="w-4 h-4 text-[var(--accent)]" />
          Create pairwise queue
        </h3>
        <div className="flex items-end gap-3">
          <div className="w-32">
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">N pairs</label>
            <input
              type="number"
              min={1}
              max={50}
              value={n}
              onChange={(e) => setN(Number(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create queue
          </button>
        </div>
      </div>

      {queueId && (
        <p className="text-xs text-[var(--text-muted)]">Queue id: <span className="font-mono">{queueId}</span></p>
      )}

      {pairs.length > 0 && (
        <div className="space-y-3">
          {pairs.map((p, i) => {
            const decision = decisions[i];
            return (
              <div key={i} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--text-muted)] font-mono">Pair {i + 1} · trace {p.trace_id}</span>
                  {decision && (
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--terminal-faint)] text-[var(--terminal)] inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      {decision.toUpperCase()} wins
                    </span>
                  )}
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Option A</div>
                    <pre className="text-xs whitespace-pre-wrap">{p.a}</pre>
                    <button
                      onClick={() => handleDecide(i, "a")}
                      disabled={!!submitting || !!decision}
                      className={cn(
                        "w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                        decision === "a"
                          ? "bg-[var(--terminal)] text-[var(--bg-base)]"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--border-default)]"
                      )}
                    >
                      {submitting === i ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      A wins
                    </button>
                  </div>
                  <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Option B</div>
                    <pre className="text-xs whitespace-pre-wrap">{p.b}</pre>
                    <button
                      onClick={() => handleDecide(i, "b")}
                      disabled={!!submitting || !!decision}
                      className={cn(
                        "w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                        decision === "b"
                          ? "bg-[var(--terminal)] text-[var(--bg-base)]"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--border-default)]"
                      )}
                    >
                      {submitting === i ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      B wins
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

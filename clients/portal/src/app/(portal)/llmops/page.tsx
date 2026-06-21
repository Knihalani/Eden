"use client";

import { useState, useEffect } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/ui/stat-card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/ui/data-table";
import {
  Cpu,
  Box,
  MessageSquare,
  FlaskConical,
  SplitSquareHorizontal,
  ShieldCheck,
  ActivitySquare,
  Database,
  Loader2,
  AlertCircle,
  CheckCircle2,
  TrendingUp,
  Clock,
  AlertTriangle,
  XCircle,
  Search,
  RefreshCw,
  Trash2,
  BarChart3,
  Gauge,
  Server,
  Hash,
  Play,
  GitCommit,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

interface TabConfig {
  key: string;
  label: string;
  icon: typeof Cpu;
}

const TABS: TabConfig[] = [
  { key: "models", label: "Models", icon: Box },
  { key: "prompts", label: "Prompts", icon: MessageSquare },
  { key: "experiments", label: "Experiments", icon: FlaskConical },
  { key: "abtests", label: "A/B Tests", icon: SplitSquareHorizontal },
  { key: "gateway", label: "Gateway", icon: ShieldCheck },
  { key: "monitoring", label: "Monitoring", icon: ActivitySquare },
  { key: "cache", label: "Cache", icon: Database },
];

// ──────────────────────────────────────────────────────────────────────────
// Main Page
// ──────────────────────────────────────────────────────────────────────────

export default function LLMOpsPage() {
  const { currentOrg } = useOrg();
  const [activeTab, setActiveTab] = useState("models");
  const [error, setError] = useState("");

  const orgId = currentOrg?.id;

  if (!currentOrg) {
    return <NoOrgState feature="LLMOps" />;
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 page-enter">
      <PageHeader
        title="LLMOps & Experiments"
        subtitle="Model registry, prompt management, experiment tracking, and production monitoring"
        icon={Cpu}
        eyebrow="Operate"
      />

      {/* Tab Navigation */}
      <div className="border-b border-[var(--border-default)] -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8">
        <div className="flex overflow-x-auto scrollbar-hide">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={activeTab === tab.key}
                aria-controls={`llmops-panel-${tab.key}`}
                id={`llmops-tab-${tab.key}`}
                onClick={() => {
                  setActiveTab(tab.key);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const idx = TABS.findIndex((t) => t.key === activeTab);
                    const nextIdx = e.key === "ArrowRight"
                      ? (idx + 1) % TABS.length
                      : (idx - 1 + TABS.length) % TABS.length;
                    setActiveTab(TABS[nextIdx].key);
                  }
                }}
                className={cn(
                  "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:ring-offset-1",
                  activeTab === tab.key
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                )}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {!orgId ? (
        <NoOrgState feature="LLMOps" icon={Cpu} description="Select an organization to view LLMOps data" />
      ) : (
        <div role="tabpanel" id={`llmops-panel-${activeTab}`} aria-labelledby={`llmops-tab-${activeTab}`}>
          {activeTab === "models" && <ModelsTab orgId={orgId} />}
          {activeTab === "prompts" && <PromptsTab orgId={orgId} />}
          {activeTab === "experiments" && <ExperimentsTab orgId={orgId} />}
          {activeTab === "abtests" && <ABTestsTab orgId={orgId} />}
          {activeTab === "gateway" && <GatewayTab orgId={orgId} />}
          {activeTab === "monitoring" && <MonitoringTab orgId={orgId} />}
          {activeTab === "cache" && <CacheTab orgId={orgId} />}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Models Tab
// ──────────────────────────────────────────────────────────────────────────

function ModelsTab({ orgId }: { orgId: string }) {
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedArtifact, setSelectedArtifact] = useState<any>(null);
  const [filterFamily, setFilterFamily] = useState("");

  const loadArtifacts = async () => {
    setLoading(true);
    try {
      const res = await api.listModelArtifacts(orgId, filterFamily ? { model_family: filterFamily } : undefined);
      setArtifacts(res.artifacts);
    } catch (err) {
      console.error("Failed to load artifacts", err);
    } finally {
      setLoading(false);
    }
  };

  const getArtifactDetail = async (artifactId: string) => {
    try {
      const res = await api.getModelArtifact(orgId, artifactId);
      setSelectedArtifact(res);
    } catch (err) {
      console.error("Failed to load artifact detail", err);
    }
  };

  useEffect(() => { loadArtifacts(); }, [orgId, filterFamily]);

  if (loading && artifacts.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder="Filter by model family..."
            value={filterFamily}
            onChange={(e) => setFilterFamily(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 focus:border-[var(--accent)]"
          />
        </div>
        <button
          onClick={loadArtifacts}
          aria-label="Refresh artifacts"
          className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Artifacts List */}
        <div className="lg:col-span-1 space-y-3">
          {artifacts.map((a) => (
            <button
              key={a.artifact_id}
              onClick={() => getArtifactDetail(a.artifact_id)}
              className={cn(
                "w-full text-left p-4 rounded-xl border transition-all",
                selectedArtifact?.artifact?.artifact_id === a.artifact_id
                  ? "border-[var(--accent)] bg-[var(--accent-faint)]/20"
                  : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-[var(--border-strong)]"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                  {a.model_family}
                </span>
                <span className="text-xs text-[var(--text-muted)]">{a.provider}</span>
              </div>
              <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{a.model_version}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 truncate">{a.artifact_type}</p>
            </button>
          ))}
          {artifacts.length === 0 && (
            <div className="text-center py-10 text-[var(--text-muted)] text-sm">No model artifacts found</div>
          )}
        </div>

        {/* Detail Panel */}
        <div className="lg:col-span-2">
          {selectedArtifact ? (
            <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6 space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-[var(--text-primary)]">{selectedArtifact.artifact.model_version}</h3>
                  <p className="text-sm text-[var(--text-muted)] mt-1">{selectedArtifact.artifact.artifact_id}</p>
                </div>
                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-[var(--accent-faint)] text-[var(--accent)]">
                  {selectedArtifact.artifact.artifact_type}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatCard title="Family" value={selectedArtifact.artifact.model_family} icon={Box} accent="neutral" />
                <StatCard title="Provider" value={selectedArtifact.artifact.provider} icon={Server} accent="accent" />
                <StatCard title="Created" value={formatDate(selectedArtifact.artifact.created_at)} icon={Clock} accent="neutral" />
                <StatCard title="Status" value={selectedArtifact.artifact.is_deployed ? "Deployed" : "Staging"} icon={CheckCircle2} accent={selectedArtifact.artifact.is_deployed ? "terminal" : "warning"} />
              </div>

              <div>
                <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Evaluations</h4>
                {selectedArtifact.evaluations.length > 0 ? (
                  <div className="space-y-2">
                    {selectedArtifact.evaluations.map((e: any) => (
                      <div key={e.evaluation_id} className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-tertiary)]">
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center",
                            e.pass_rate >= 0.9 ? "bg-[var(--terminal-dim)] text-[var(--terminal)]" : e.pass_rate >= 0.7 ? "bg-[var(--warning-bg)] text-[var(--warning)]" : "bg-[var(--error-dim)] text-[var(--error)]"
                          )}>
                            <TrendingUp className="w-4 h-4" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-[var(--text-primary)]">{e.benchmark_suite_id}</p>
                            <p className="text-xs text-[var(--text-muted)]">Pass rate: {(e.pass_rate * 100).toFixed(1)}%</p>
                          </div>
                        </div>
                        <div className="text-right text-xs text-[var(--text-muted)]">
                          <p>{e.avg_latency_ms}ms avg</p>
                          <p>${e.cost_per_1k_tokens}/1K tokens</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">No evaluations yet</p>
                )}
              </div>

              {selectedArtifact.artifact.metadata?.description && (
                <div>
                  <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Description</h4>
                  <p className="text-sm text-[var(--text-secondary)]">{selectedArtifact.artifact.metadata.description}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-10 text-center">
              <Box className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
              <p className="text-sm text-[var(--text-muted)]">Select a model artifact to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Prompts Tab
// ──────────────────────────────────────────────────────────────────────────

function PromptsTab({ orgId }: { orgId: string }) {
  const [prompts, setPrompts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPrompt, setSelectedPrompt] = useState<any>(null);
  const [renderVars, setRenderVars] = useState("");
  const [rendered, setRendered] = useState("");

  const loadPrompts = async () => {
    setLoading(true);
    try {
      const res = await api.listPrompts(orgId);
      setPrompts(res.prompts);
    } catch (err) {
      console.error("Failed to load prompts", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRender = async () => {
    if (!selectedPrompt) return;
    try {
      const vars = JSON.parse(renderVars || "{}");
      const res = await api.renderPrompt(orgId, selectedPrompt.prompt_id, vars);
      setRendered(res.rendered);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Render failed";
      setRendered(`Error: ${message}`);
    }
  };

  useEffect(() => { loadPrompts(); }, [orgId]);

  if (loading && prompts.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 space-y-3">
        {prompts.map((p) => (
          <button
            key={p.prompt_id}
            onClick={() => {
              setSelectedPrompt(p);
              setRendered("");
            }}
            className={cn(
              "w-full text-left p-4 rounded-xl border transition-all",
              selectedPrompt?.prompt_id === p.prompt_id
                ? "border-[var(--accent)] bg-[var(--accent-faint)]/20"
                : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-[var(--border-strong)]"
            )}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                {p.agent_scope}
              </span>
              {p.is_default && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--terminal-dim)] text-[var(--terminal)]">
                  Default
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">{p.prompt_name}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">v{p.version}</p>
          </button>
        ))}
      </div>

      <div className="lg:col-span-2">
        {selectedPrompt ? (
          <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6 space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-[var(--text-primary)]">{selectedPrompt.prompt_name}</h3>
                <p className="text-xs text-[var(--text-muted)] mt-1">{selectedPrompt.prompt_id} · v{selectedPrompt.version}</p>
              </div>
            </div>

            <div className="bg-[var(--bg-secondary)] rounded-lg p-4 border border-[var(--border-default)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">Template</h4>
              <pre className="text-sm text-[var(--text-primary)] whitespace-pre-wrap font-mono leading-relaxed">
                {selectedPrompt.template_text}
              </pre>
            </div>

            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">Render Test</h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder='{"name": "Agent", "task": "design"}'
                  value={renderVars}
                  onChange={(e) => setRenderVars(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                />
                <button
                  onClick={handleRender}
                  className="px-4 py-2 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2"
                >
                  <Play className="w-3.5 h-3.5" />
                  Render
                </button>
              </div>
              {rendered && (
                <div className="bg-[var(--bg-secondary)] rounded-lg p-4 border border-[var(--border-default)]">
                  <pre className="text-sm text-[var(--text-primary)] whitespace-pre-wrap font-mono">{rendered}</pre>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-10 text-center">
            <MessageSquare className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-muted)]">Select a prompt template to view and test</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Experiments Tab
// ──────────────────────────────────────────────────────────────────────────

function ExperimentsTab({ orgId }: { orgId: string }) {
  const [experiments, setExperiments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedExp, setSelectedExp] = useState<any>(null);

  const loadExperiments = async () => {
    setLoading(true);
    try {
      const res = await api.listExperiments(orgId);
      setExperiments(res.experiments);
    } catch (err) {
      console.error("Failed to load experiments", err);
    } finally {
      setLoading(false);
    }
  };

  const getExperimentDetail = async (expId: string) => {
    try {
      const res = await api.getExperiment(orgId, expId);
      setSelectedExp(res);
    } catch (err) {
      console.error("Failed to load experiment detail", err);
    }
  };

  useEffect(() => { loadExperiments(); }, [orgId]);

  if (loading && experiments.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 space-y-3">
        {experiments.map((e) => (
          <button
            key={e.experiment_id}
            onClick={() => getExperimentDetail(e.experiment_id)}
            className={cn(
              "w-full text-left p-4 rounded-xl border transition-all",
              selectedExp?.experiment?.experiment_id === e.experiment_id
                ? "border-[var(--accent)] bg-[var(--accent-faint)]/20"
                : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-[var(--border-strong)]"
            )}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                {e.experiment_type}
              </span>
              <StatusBadge status={e.status} />
            </div>
            <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{e.experiment_name}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">Pipeline {e.pipeline_version}</p>
          </button>
        ))}
        {experiments.length === 0 && (
          <div className="text-center py-10 text-[var(--text-muted)] text-sm">No experiments found</div>
        )}
      </div>

      <div className="lg:col-span-2">
        {selectedExp ? (
          <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6 space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-[var(--text-primary)]">{selectedExp.experiment.experiment_name}</h3>
                <p className="text-xs text-[var(--text-muted)] mt-1">{selectedExp.experiment.experiment_id}</p>
              </div>
              <StatusBadge status={selectedExp.experiment.status} />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatCard title="Type" value={selectedExp.experiment.experiment_type} icon={FlaskConical} accent="accent" />
              <StatCard title="Pipeline" value={selectedExp.experiment.pipeline_version} icon={GitCommit} accent="neutral" />
              <StatCard title="Runs" value={String(selectedExp.runs.length)} icon={Hash} accent="terminal" />
              <StatCard title="Git Commit" value={selectedExp.experiment.git_commit.slice(0, 7)} icon={GitCommit} accent="neutral" />
            </div>

            {selectedExp.comparison && (
              <div className="bg-[var(--bg-tertiary)] rounded-lg p-4">
                <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Comparison to Baseline</h4>
                <pre className="text-xs text-[var(--text-secondary)] overflow-auto">
                  {JSON.stringify(selectedExp.comparison, null, 2)}
                </pre>
              </div>
            )}

            <div>
              <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Runs ({selectedExp.runs.length})</h4>
              {selectedExp.runs.length > 0 ? (
                <div className="space-y-2">
                  {selectedExp.runs.map((run: any) => (
                    <div key={run.run_id} className="p-3 rounded-lg bg-[var(--bg-tertiary)] text-sm">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-[var(--text-primary)]">{run.run_id}</span>
                        <span className="text-xs text-[var(--text-muted)]">{formatDate(run.created_at)}</span>
                      </div>
                      {run.metrics && Object.entries(run.metrics).map(([k, v]: [string, any]) => (
                        <div key={k} className="flex justify-between text-xs text-[var(--text-secondary)]">
                          <span className="capitalize">{k.replace(/_/g, " ")}</span>
                          <span className="font-mono">{typeof v === "number" ? v.toFixed(2) : v}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">No runs yet</p>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-10 text-center">
            <FlaskConical className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-muted)]">Select an experiment to view details</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// A/B Tests Tab
// ──────────────────────────────────────────────────────────────────────────

function ABTestsTab({ orgId }: { orgId: string }) {
  const [tests, setTests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTests = async () => {
    setLoading(true);
    try {
      const res = await api.listABTests(orgId);
      setTests(res.tests);
    } catch (err) {
      console.error("Failed to load A/B tests", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTests(); }, [orgId]);

  if (loading && tests.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {tests.map((test: any) => (
        <div key={test.test_id} className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">{test.prompt_name}</h3>
              <p className="text-xs text-[var(--text-muted)] mt-1">{test.test_id}</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-center">
                <p className="text-xs text-[var(--text-muted)]">Traffic Split</p>
                <p className="text-lg font-semibold text-[var(--text-primary)]">{(test.traffic_split * 100).toFixed(0)}%</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-[var(--text-muted)]">Metric</p>
                <p className="text-sm font-medium text-[var(--text-primary)]">{test.success_metric}</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
              <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-1">Variant A</p>
              <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{test.variant_a_id}</p>
            </div>
            <div className="p-4 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
              <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-1">Variant B</p>
              <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{test.variant_b_id}</p>
            </div>
          </div>

          {test.winner_prompt_id && (
            <div className="mt-4 flex items-center gap-2 text-sm text-[var(--terminal)] bg-[var(--terminal-faint)] px-3 py-2 rounded-lg">
              <CheckCircle2 className="w-4 h-4" />
              Winner: <span className="font-medium">{test.winner_prompt_id}</span>
            </div>
          )}

          {test.start_date && (
            <p className="text-xs text-[var(--text-muted)] mt-4">Started {formatDate(test.start_date)}</p>
          )}
        </div>
      ))}
      {tests.length === 0 && (
        <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-10 text-center">
          <SplitSquareHorizontal className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
          <p className="text-sm text-[var(--text-muted)]">No A/B tests found</p>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Gateway Tab
// ──────────────────────────────────────────────────────────────────────────

function GatewayTab({ orgId }: { orgId: string }) {
  const [health, setHealth] = useState<any>(null);
  const [metrics, setMetrics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const [h, m] = await Promise.all([
        api.gatewayHealth(orgId),
        api.gatewayMetrics(orgId, 20),
      ]);
      setHealth(h);
      setMetrics(m.metrics || []);
    } catch (err) {
      console.error("Failed to load gateway data", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [orgId]);

  if (loading && !health) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Provider Health */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {health?.providers?.map((provider: any, i: number) => (
          <div key={i} className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className={cn(
                "w-3 h-3 rounded-full",
                provider.healthy ? "bg-[var(--terminal)]" : "bg-[var(--error)]"
              )} />
              <h3 className="text-sm font-semibold text-[var(--text-primary)] capitalize">{provider.provider}</h3>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-[var(--text-muted)]">Avg Latency</span>
                <span className="text-[var(--text-primary)] font-mono">{provider.avg_latency_ms}ms</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[var(--text-muted)]">Status</span>
                <span className={cn(
                  "font-medium",
                  provider.healthy ? "text-[var(--terminal)]" : "text-[var(--error)]"
                )}>
                  {provider.healthy ? "Healthy" : "Unhealthy"}
                </span>
              </div>
            </div>
          </div>
        ))}
        {(!health?.providers || health.providers.length === 0) && (
          <div className="col-span-full bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-10 text-center">
            <ShieldCheck className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-muted)]">No provider health data available</p>
          </div>
        )}
      </div>

      {/* Metrics */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Recent Metrics ({metrics.length})</h3>
        <DataTable
          columns={[
            { key: "provider", header: "Provider", cell: (m: any) => <span className="text-[var(--text-primary)] capitalize">{m.provider || "-"}</span> },
            { key: "model", header: "Model", cell: (m: any) => <span className="text-[var(--text-secondary)]">{m.model || "-"}</span> },
            { key: "latency_ms", header: "Latency", sortable: true, align: "right", cell: (m: any) => <span className="font-mono">{m.latency_ms}ms</span> },
            {
              key: "tokens",
              header: "Tokens",
              sortable: true,
              align: "right",
              cell: (m: any) => <span className="font-mono">{((m.input_tokens || 0) + (m.output_tokens || 0))}</span>,
            },
            {
              key: "cost_usd",
              header: "Cost",
              sortable: true,
              align: "right",
              cell: (m: any) => <span className="font-mono">${(m.cost_usd || 0).toFixed(4)}</span>,
            },
            {
              key: "cached",
              header: "Cached",
              align: "center",
              cell: (m: any) =>
                m.cached ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--terminal-dim)] text-[var(--terminal)]">Hit</span>
                ) : (
                  <span className="text-xs text-[var(--text-muted)]">-</span>
                ),
            },
          ]}
          rows={metrics}
          rowKey={(_m, i) => String(i)}
          defaultSort={{ key: "latency_ms", direction: "desc" }}
          emptyTitle="No metrics recorded yet"
          emptyDescription="Send traffic through the gateway to populate."
          pageSize={25}
        />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Monitoring Tab
// ──────────────────────────────────────────────────────────────────────────

function MonitoringTab({ orgId }: { orgId: string }) {
  const [health, setHealth] = useState<any>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const [h, a] = await Promise.all([
        api.getOverallHealth(orgId),
        api.listMonitoringAlerts(orgId, { limit: 20 }),
      ]);
      setHealth(h);
      setAlerts(a.alerts || []);
    } catch (err) {
      console.error("Failed to load monitoring data", err);
    } finally {
      setLoading(false);
    }
  };

  const handleAck = async (alertId: string) => {
    try {
      await api.acknowledgeMonitoringAlert(orgId, alertId);
      setAlerts((prev) => prev.map((a) => a.alert_id === alertId ? { ...a, acknowledged: true } : a));
    } catch (err) {
      console.error("Failed to acknowledge alert", err);
    }
  };

  useEffect(() => { loadData(); }, [orgId]);

  if (loading && !health) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Overall Health */}
      {health && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <HealthScoreCard
            label="Overall Score"
            value={health.overall_score ?? 0}
            icon={Gauge}
          />
          <HealthScoreCard
            label="Active Alerts"
            value={health.active_alert_count ?? 0}
            icon={AlertTriangle}
            invert
          />
          <HealthScoreCard
            label="Models Monitored"
            value={health.model_count ?? 0}
            icon={Server}
          />
        </div>
      )}

      {/* Alerts */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Production Alerts ({alerts.length})</h3>
        {alerts.length > 0 ? (
          <div className="space-y-2">
            {alerts.map((alert: any) => (
              <div
                key={alert.alert_id}
                className={cn(
                  "flex items-center justify-between p-3 rounded-lg border",
                  alert.acknowledged
                    ? "bg-[var(--bg-tertiary)] border-[var(--border-subtle)] opacity-60"
                    : "bg-[var(--bg-secondary)] border-[var(--border-default)]"
                )}
              >
                <div className="flex items-center gap-3">
                  <AlertSeverityIcon severity={alert.severity} />
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{alert.alert_type}</p>
                    <p className="text-xs text-[var(--text-muted)]">{alert.model_family} · {formatDate(alert.triggered_at)}</p>
                  </div>
                </div>
                {!alert.acknowledged && (
                  <button
                    onClick={() => handleAck(alert.alert_id)}
                    className="px-3 py-1.5 text-xs font-medium bg-[var(--bg-tertiary)] hover:bg-[var(--accent-faint)] text-[var(--text-secondary)] hover:text-[var(--accent)] rounded-lg transition-colors"
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">No alerts</p>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Cache Tab
// ──────────────────────────────────────────────────────────────────────────

function CacheTab({ orgId }: { orgId: string }) {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [modelVersion, setModelVersion] = useState("gpt-4o");
  const [cacheResult, setCacheResult] = useState<any>(null);

  const loadStats = async () => {
    setLoading(true);
    try {
      const res = await api.cacheStats(orgId);
      setStats(res);
    } catch (err) {
      console.error("Failed to load cache stats", err);
    } finally {
      setLoading(false);
    }
  };

  const handleCacheGet = async () => {
    try {
      const res = await api.cacheGet(orgId, query, modelVersion);
      setCacheResult(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Cache lookup failed";
      setCacheResult({ hit: false, error: message });
    }
  };

  useEffect(() => { loadStats(); }, [orgId]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard title="Total Queries" value={stats?.total_queries ?? 0} icon={Hash} />
        <StatCard title="Hits" value={stats?.hits ?? 0} icon={CheckCircle2} />
        <StatCard title="Misses" value={stats?.misses ?? 0} icon={XCircle} />
        <StatCard title="Hit Rate" value={`${((stats?.hit_rate ?? 0) * 100).toFixed(1)}%`} icon={BarChart3} />
      </div>

      {/* Cache Lookup */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Cache Lookup Test</h3>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Enter query..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 px-3 py-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
          />
          <input
            type="text"
            placeholder="Model version"
            value={modelVersion}
            onChange={(e) => setModelVersion(e.target.value)}
            className="w-40 px-3 py-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
          />
          <button
            onClick={handleCacheGet}
            className="px-4 py-2 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
          >
            Lookup
          </button>
        </div>
        {cacheResult && (
          <div className={cn(
            "p-4 rounded-lg border text-sm",
            cacheResult.hit
              ? "bg-[var(--terminal-faint)] border-[var(--terminal-dim)] text-[var(--terminal)]"
              : "bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)]"
          )}>
            {cacheResult.hit ? (
              <div>
                <p className="font-medium mb-1">Cache Hit</p>
                <p className="font-mono text-xs">{cacheResult.response}</p>
              </div>
            ) : (
              <p>Cache miss</p>
            )}
          </div>
        )}
      </div>

      {/* Invalidate */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Cache Management</h3>
        <div className="flex gap-3">
          <button
            onClick={loadStats}
            className="px-4 py-2 text-sm font-medium bg-[var(--bg-tertiary)] hover:bg-[var(--border-default)] text-[var(--text-secondary)] rounded-lg transition-colors flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh Stats
          </button>
          <button
            onClick={async () => {
              try {
                await api.cacheInvalidate(orgId, "*");
                loadStats();
              } catch (err) {
                console.error("Failed to invalidate cache", err);
              }
            }}
            className="px-4 py-2 text-sm font-medium bg-[var(--error-bg)] hover:bg-[var(--error-dim)] text-[var(--error)] rounded-lg transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Clear All Cache
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Shared Components
// ──────────────────────────────────────────────────────────────────────────

function HealthScoreCard({ label, value, icon: Icon, invert }: { label: string; value: number; icon: typeof Gauge; invert?: boolean }) {
  const isGood = invert ? value === 0 : value >= 0.8;
  return (
    <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <Icon className={cn("w-5 h-5", isGood ? "text-[var(--terminal)]" : "text-[var(--warning)]")} />
        <span className="text-xs text-[var(--text-muted)] uppercase tracking-wider">{label}</span>
      </div>
      <p className={cn("text-2xl font-bold", isGood ? "text-[var(--terminal)]" : "text-[var(--warning)]")}>
        {typeof value === "number" && value < 1 && value > 0 ? `${(value * 100).toFixed(0)}%` : value}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    running: "bg-[var(--accent-faint)] text-[var(--accent)]",
    completed: "bg-[var(--terminal-dim)] text-[var(--terminal)]",
    failed: "bg-[var(--error-dim)] text-[var(--error)]",
    paused: "bg-[var(--warning-bg)] text-[var(--warning)]",
    pending: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
    draft: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
    active: "bg-[var(--terminal-dim)] text-[var(--terminal)]",
    inactive: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  };
  return (
    <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", colorMap[status] || "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]")}>
      {status}
    </span>
  );
}

function AlertSeverityIcon({ severity }: { severity: string }) {
  if (severity === "critical") return <XCircle className="w-5 h-5 text-[var(--error)]" />;
  if (severity === "warning") return <AlertTriangle className="w-5 h-5 text-[var(--warning)]" />;
  return <AlertCircle className="w-5 h-5 text-[var(--accent)]" />;
}

function formatDate(dateString: string | undefined) {
  if (!dateString) return "-";
  try {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateString;
  }
}

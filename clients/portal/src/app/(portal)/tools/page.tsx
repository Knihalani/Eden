"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Wrench, GitCompare, Sparkles, ChevronDown, ChevronRight, Loader2, AlertTriangle, Activity, Search, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { errorFromCaught } from "@/lib/safe-error-message";
type Tab = "attribution" | "compare" | "recommender" | "taxonomy";
interface ToolAttribution {
  tool_name: string;
  success_rate: number;
  call_count: number;
}
interface ToolComparison {
  tool_name: string;
  metrics: Record<string, number>;
}
interface ToolRecommendation {
  tool_name: string;
  score: number;
  rationale: string;
}
interface ToolCategory {
  category: string;
  tools: string[];
}
export default function ToolsPage() {
  const {
    currentOrg
  } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("attribution");
  const [error, setError] = useState("");

  // Attribution
  const [tools, setTools] = useState<ToolAttribution[]>([]);
  const [attributionLoading, setAttributionLoading] = useState(false);
  const [attributionDays, setAttributionDays] = useState(30);

  // Compare
  const [allToolNames, setAllToolNames] = useState<string[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [comparison, setComparison] = useState<ToolComparison[] | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);

  // Recommender
  const [task, setTask] = useState("");
  const [recommendations, setRecommendations] = useState<ToolRecommendation[] | null>(null);
  const [recommendLoading, setRecommendLoading] = useState(false);

  // Taxonomy
  const [taxonomy, setTaxonomy] = useState<ToolCategory[] | null>(null);
  const [taxonomyLoading, setTaxonomyLoading] = useState(false);
  const [taxonomyOpen, setTaxonomyOpen] = useState(true);
  const loadAttribution = useCallback(async () => {
    if (!currentOrg) return;
    setAttributionLoading(true);
    setError("");
    try {
      const data = await api.post<{
        tools: ToolAttribution[];
      }>(`/orgs/${currentOrg.id}/intelligence/tools/attribution`, {
        days: attributionDays
      });
      setTools(data.tools || []);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load attribution"));
    } finally {
      setAttributionLoading(false);
    }
  }, [currentOrg, attributionDays]);
  const loadTaxonomy = useCallback(async () => {
    if (!currentOrg) return;
    setTaxonomyLoading(true);
    try {
      const data = await api.get<{
        categories: ToolCategory[];
      }>(`/orgs/${currentOrg.id}/intelligence/tools/taxonomy`);
      setTaxonomy(data.categories || []);
      // Populate available tools for the compare dropdown
      const all = (data.categories || []).flatMap(c => c.tools);
      setAllToolNames(all);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load taxonomy"));
    } finally {
      setTaxonomyLoading(false);
    }
  }, [currentOrg]);
  useEffect(() => {
    if (currentOrg) {
      loadAttribution();
      loadTaxonomy();
    }
  }, [currentOrg, loadAttribution, loadTaxonomy]);
  async function handleCompare() {
    if (!currentOrg || selectedTools.length < 2) return;
    setCompareLoading(true);
    setError("");
    try {
      const data = await api.post<{
        comparison: ToolComparison[];
      }>(`/orgs/${currentOrg.id}/intelligence/tools/compare`, {
        tool_names: selectedTools
      });
      setComparison(data.comparison || []);
    } catch (err) {
      setError(errorFromCaught(err, "Comparison failed"));
    } finally {
      setCompareLoading(false);
    }
  }
  async function handleRecommend() {
    if (!currentOrg || !task.trim()) return;
    setRecommendLoading(true);
    setError("");
    try {
      const data = await api.post<{
        recommendations: ToolRecommendation[];
      }>(`/orgs/${currentOrg.id}/intelligence/tools/recommend`, {
        task: task.trim()
      });
      setRecommendations(data.recommendations || []);
    } catch (err) {
      setError(errorFromCaught(err, "Recommendation failed"));
    } finally {
      setRecommendLoading(false);
    }
  }
  if (!currentOrg) {
    return <NoOrgState icon={Wrench} feature="Tool Intelligence" description="Tool attribution, comparison, and recommendations light up once your organization is processing tool calls." />;
  }
  return <PageContent size="wide">
      <PageHeader eyebrow="Observe" title="Tool Intelligence" subtitle="Attribution, head-to-head comparison, and task-based recommendations for every tool in the fleet" icon={Wrench} />

      {error && <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
        <TabsList aria-label="Tool intelligence sections" className="bg-[var(--bg-tertiary)] rounded-xl h-auto flex-wrap w-fit">
          {([{
          key: "attribution" as Tab,
          label: "Attribution",
          icon: Activity
        }, {
          key: "compare" as Tab,
          label: "Compare",
          icon: GitCompare
        }, {
          key: "recommender" as Tab,
          label: "Recommender",
          icon: Sparkles
        }, {
          key: "taxonomy" as Tab,
          label: "Taxonomy",
          icon: ChevronRight
        }] as const).map(({ key, label, icon: Icon }) => (
            <TabsTrigger key={key} value={key} className="flex items-center gap-2 data-[state=active]:text-[var(--text-primary)]">
              <Icon className="w-4 h-4" aria-hidden />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

      {/* Content */}
      <AnimatePresence mode="wait">
        <motion.div key={activeTab} initial={{
        opacity: 0,
        y: 8
      }} animate={{
        opacity: 1,
        y: 0
      }} exit={{
        opacity: 0,
        y: -6
      }} transition={{
        duration: 0.2
      }}>
          {activeTab === "attribution" && <AttributionTab tools={tools} loading={attributionLoading} days={attributionDays} onDaysChange={setAttributionDays} onRefresh={loadAttribution} />}
          {activeTab === "compare" && <CompareTab allToolNames={allToolNames} selectedTools={selectedTools} onSelectedToolsChange={setSelectedTools} dropdownOpen={toolDropdownOpen} onDropdownOpenChange={setToolDropdownOpen} onCompare={handleCompare} comparison={comparison} loading={compareLoading} />}
          {activeTab === "recommender" && <RecommenderTab task={task} onTaskChange={setTask} onRecommend={handleRecommend} recommendations={recommendations} loading={recommendLoading} />}
          {activeTab === "taxonomy" && <TaxonomyTab taxonomy={taxonomy} loading={taxonomyLoading} expanded={taxonomyOpen} onToggleExpanded={() => setTaxonomyOpen(!taxonomyOpen)} />}
        </motion.div>
      </AnimatePresence>
      </Tabs>
    </PageContent>;
}

// ──────────────────────────────────────────────────────────────────────────
// Attribution Tab
// ──────────────────────────────────────────────────────────────────────────

function AttributionTab({
  tools,
  loading,
  days,
  onDaysChange,
  onRefresh
}: {
  tools: ToolAttribution[];
  loading: boolean;
  days: number;
  onDaysChange: (d: number) => void;
  onRefresh: () => void;
}) {
  const columns: DataTableColumn<ToolAttribution>[] = [{
    key: "tool_name",
    header: "Tool",
    sortable: true,
    cell: r => <span className="font-mono text-xs">{r.tool_name}</span>
  }, {
    key: "call_count",
    header: "Call Count",
    sortable: true,
    align: "right",
    cell: r => <span className="tabular-nums">{r.call_count.toLocaleString()}</span>
  }, {
    key: "success_rate",
    header: "Success Rate",
    sortable: true,
    align: "right",
    cell: r => <SuccessRateBadge rate={r.success_rate} />
  }];
  return <div className="space-y-4">
      {/* Controls */}
      <Card padding="sm" className="flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="attribution-days">Time window</label>
        <select id="attribution-days" value={days} onChange={e => onDaysChange(Number(e.target.value))} className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button onClick={onRefresh} disabled={loading} aria-label="Refresh tool attribution" className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors ml-auto">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </Card>

      <DataTable columns={columns} rows={tools} rowKey={r => r.tool_name} loading={loading && tools.length === 0} defaultSort={{
      key: "call_count",
      direction: "desc"
    }} emptyTitle="No tool calls yet" emptyDescription="Tool attribution populates once your agents start invoking tools — check back after the first traces run." emptyIcon={Wrench} pageSize={25} />
    </div>;
}
function SuccessRateBadge({
  rate
}: {
  rate: number;
}) {
  const pct = (rate * 100).toFixed(1);
  const classes = rate >= 0.9 ? "text-[var(--terminal)]" : rate >= 0.7 ? "text-[var(--warning)]" : "text-[var(--error)]";
  return <span className={cn("text-sm font-semibold tabular-nums", classes)}>
      {pct}%
    </span>;
}

// ──────────────────────────────────────────────────────────────────────────
// Compare Tab
// ──────────────────────────────────────────────────────────────────────────

function CompareTab({
  allToolNames,
  selectedTools,
  onSelectedToolsChange,
  dropdownOpen,
  onDropdownOpenChange,
  onCompare,
  comparison,
  loading
}: {
  allToolNames: string[];
  selectedTools: string[];
  onSelectedToolsChange: (tools: string[]) => void;
  dropdownOpen: boolean;
  onDropdownOpenChange: (open: boolean) => void;
  onCompare: () => void;
  comparison: ToolComparison[] | null;
  loading: boolean;
}) {
  function toggleTool(name: string) {
    if (selectedTools.includes(name)) {
      onSelectedToolsChange(selectedTools.filter(t => t !== name));
    } else {
      onSelectedToolsChange([...selectedTools, name]);
    }
  }

  // Collect all metric keys across the comparison
  const metricKeys = comparison ? Array.from(new Set(comparison.flatMap(c => Object.keys(c.metrics)))) : [];
  return <div className="space-y-6">
      {/* Tool picker */}
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-[var(--accent)]" />
          Compare Tools
        </h3>

        <div className="relative">
          <button onClick={() => onDropdownOpenChange(!dropdownOpen)} aria-haspopup="listbox" aria-expanded={dropdownOpen} className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-left text-[var(--text-primary)] flex items-center justify-between">
            <span>
              {selectedTools.length === 0 ? "Select tools to compare..." : selectedTools.length === 1 ? selectedTools[0] : `${selectedTools.length} tools selected`}
            </span>
            <ChevronDown className={cn("w-4 h-4 transition-transform", dropdownOpen && "rotate-180")} />
          </button>
          <AnimatePresence>
            {dropdownOpen && <motion.div initial={{
            opacity: 0,
            y: -4
          }} animate={{
            opacity: 1,
            y: 0
          }} exit={{
            opacity: 0,
            y: -4
          }} className="absolute z-20 mt-1 w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-lg max-h-64 overflow-y-auto">
                {allToolNames.length === 0 ? <div className="p-3 text-xs text-[var(--text-muted)]">
                    No tools found. Load the taxonomy tab first.
                  </div> : allToolNames.map(name => <label key={name} className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-tertiary)] cursor-pointer text-sm">
                      <input type="checkbox" checked={selectedTools.includes(name)} onChange={() => toggleTool(name)} className="accent-[var(--accent)]" />
                      <span className="font-mono text-xs text-[var(--text-primary)]">{name}</span>
                    </label>)}
              </motion.div>}
          </AnimatePresence>
        </div>

        {selectedTools.length > 0 && <div className="flex flex-wrap gap-2 mt-3">
            {selectedTools.map(t => <span key={t} className="inline-flex items-center gap-1 px-2 py-1 bg-[var(--accent-faint)] text-[var(--accent)] rounded-md text-xs font-mono">
                {t}
                <button onClick={() => toggleTool(t)} aria-label={`Remove ${t}`} className="hover:text-[var(--text-primary)] transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </span>)}
          </div>}

        <button onClick={onCompare} disabled={loading || selectedTools.length < 2} className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitCompare className="w-4 h-4" />}
          Compare
        </button>
      </Card>

      {/* Results */}
      {comparison && comparison.length > 0 && (() => {
      // Build a transposed row per metric key: { metric, [tool_name]: number }
      const rows = metricKeys.map(key => {
        const row: Record<string, string | number> = {
          metric: key
        };
        for (const c of comparison) {
          const v = c.metrics[key];
          row[c.tool_name] = typeof v === "number" ? Number(v.toFixed(3)) : v ?? 0;
        }
        return row;
      });
      const columns: DataTableColumn<Record<string, string | number>>[] = [{
        key: "metric",
        header: "Metric",
        cell: r => <span className="font-mono text-xs text-[var(--text-secondary)]">{String(r.metric)}</span>
      }, ...comparison.map<DataTableColumn<Record<string, string | number>>>(c => ({
        key: c.tool_name,
        header: c.tool_name,
        align: "right",
        headerClassName: "font-mono text-[var(--accent)]",
        cell: r => {
          const v = r[c.tool_name];
          return <span className="tabular-nums">{typeof v === "number" ? v.toFixed(3) : String(v ?? "—")}</span>;
        }
      }))];
      return <motion.div initial={{
        opacity: 0,
        y: 8
      }} animate={{
        opacity: 1,
        y: 0
      }} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
            <div className="p-4 border-b border-[var(--border-default)]">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Side-by-Side Metrics</h3>
            </div>
            <DataTable columns={columns} rows={rows} rowKey={r => String(r.metric)} pageSize={100} />
          </motion.div>;
    })()}

      {comparison && comparison.length === 0 && <EmptyState icon={GitCompare} title="No comparison data" description="The selected tools did not return any metrics. Try different tools." size="md" />}
    </div>;
}

// ──────────────────────────────────────────────────────────────────────────
// Recommender Tab
// ──────────────────────────────────────────────────────────────────────────

function RecommenderTab({
  task,
  onTaskChange,
  onRecommend,
  recommendations,
  loading
}: {
  task: string;
  onTaskChange: (t: string) => void;
  onRecommend: () => void;
  recommendations: ToolRecommendation[] | null;
  loading: boolean;
}) {
  return <div className="space-y-6">
      {/* Input */}
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[var(--accent)]" />
          Get a Tool Recommendation
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <input type="text" value={task} onChange={e => onTaskChange(e.target.value)} onKeyDown={e => {
          if (e.key === "Enter") onRecommend();
        }} placeholder="Describe the task — e.g. 'fetch recent news articles'" aria-label="Task description" className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]" />
          <button onClick={onRecommend} disabled={loading || !task.trim()} className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Get Recommendation
          </button>
        </div>
      </Card>

      {/* Results */}
      {loading ? <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div> : recommendations && recommendations.length > 0 ? <motion.div initial={{
      opacity: 0,
      y: 8
    }} animate={{
      opacity: 1,
      y: 0
    }} className="space-y-3">
          <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Top picks</p>
          {recommendations.slice(0, 3).map((rec, idx) => <Card padding="md" key={rec.tool_name}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={cn("w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold", idx === 0 ? "bg-[var(--accent)] text-[var(--bg-base)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]")}>
                    {idx + 1}
                  </span>
                  <span className="font-mono text-sm text-[var(--text-primary)]">{rec.tool_name}</span>
                </div>
                <div className="text-right">
                  <p className="text-xs text-[var(--text-muted)]">Score</p>
                  <p className="text-sm font-semibold text-[var(--accent)] tabular-nums">
                    {rec.score.toFixed(3)}
                  </p>
                </div>
              </div>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{rec.rationale}</p>
            </Card>)}
        </motion.div> : recommendations && recommendations.length === 0 ? <EmptyState icon={Search} title="No recommendations" description="The recommender did not return any tool picks for that task. Try rephrasing it." size="md" /> : null}
    </div>;
}

// ──────────────────────────────────────────────────────────────────────────
// Taxonomy Tab
// ──────────────────────────────────────────────────────────────────────────

function TaxonomyTab({
  taxonomy,
  loading,
  expanded,
  onToggleExpanded
}: {
  taxonomy: ToolCategory[] | null;
  loading: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  return <Card padding="lg">
      <button onClick={onToggleExpanded} aria-expanded={expanded} aria-controls="taxonomy-panel" className="w-full px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChevronRight className={cn("w-4 h-4 text-[var(--text-muted)] transition-transform", expanded && "rotate-90")} />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Tool Taxonomy</h3>
          {taxonomy && <span className="text-xs text-[var(--text-muted)]">
              {taxonomy.length} categories
            </span>}
        </div>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" aria-hidden />}
      </button>

      <AnimatePresence>
        {expanded && <motion.div id="taxonomy-panel" initial={{
        opacity: 0,
        height: 0
      }} animate={{
        opacity: 1,
        height: "auto"
      }} exit={{
        opacity: 0,
        height: 0
      }} transition={{
        duration: 0.2
      }} className="overflow-hidden border-t border-[var(--border-default)]">
            <div className="p-5 space-y-3">
              {!taxonomy && !loading ? <p className="text-sm text-[var(--text-muted)]">Taxonomy not loaded yet.</p> : taxonomy && taxonomy.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No categories found.</p> : taxonomy?.map(cat => <div key={cat.category} className="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-[var(--text-primary)] capitalize">
                        {cat.category}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] tabular-nums">
                        {cat.tools.length} tools
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {cat.tools.map(tool => <span key={tool} className="px-2 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded text-xs font-mono">
                          {tool}
                        </span>)}
                    </div>
                  </div>)}
            </div>
          </motion.div>}
      </AnimatePresence>
    </Card>;
}
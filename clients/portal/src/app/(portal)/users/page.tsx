"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Users, Target, Smile, Users2, Layers, Plus, Loader2, AlertTriangle, Activity, TrendingUp, Search, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { DataTable } from "@/components/ui/data-table";
import { Card } from "@/components/ui/card";
import { errorFromCaught } from "@/lib/safe-error-message";
type Tab = "sessions" | "goals" | "satisfaction" | "cohorts" | "segments";
interface SessionRow {
  session_id: string;
  user_id: string;
  trace_count: number;
  first_seen: string;
  last_seen: string;
}
interface Goal {
  goal_id: string;
  name: string;
  description: string;
  target: number;
  current: number;
}
interface SatisfactionData {
  trace_id: string;
  satisfaction: number;
  confidence: number;
  correction: number;
}
interface CorrectionData {
  trace_id: string;
  raw: number;
  corrected: number;
  alpha: number;
  beta: number;
  n: number;
}
interface Cohort {
  name: string;
  user_count: number;
  satisfaction: number;
  regen_rate: number;
}
interface Segment {
  segment_id: string;
  name: string;
  user_count: number;
  criteria: Record<string, unknown>;
}
export default function UsersPage() {
  const {
    currentOrg
  } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("sessions");
  const [error, setError] = useState("");

  // Sessions
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsDays, setSessionsDays] = useState(30);

  // Goals
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(false);
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [newGoalName, setNewGoalName] = useState("");
  const [newGoalTarget, setNewGoalTarget] = useState<number>(100);
  const [newGoalDescription, setNewGoalDescription] = useState("");
  const [creatingGoal, setCreatingGoal] = useState(false);

  // Satisfaction
  const [satisfactionTraceId, setSatisfactionTraceId] = useState("");
  const [satisfaction, setSatisfaction] = useState<SatisfactionData | null>(null);
  const [correction, setCorrection] = useState<CorrectionData | null>(null);
  const [satisfactionLoading, setSatisfactionLoading] = useState(false);
  const [recentSatisfaction, setRecentSatisfaction] = useState<Array<{
    trace_id: string;
    satisfaction: number;
  }>>([]);

  // Cohorts
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [cohortsLoading, setCohortsLoading] = useState(false);

  // Segments
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const loadSessions = useCallback(async () => {
    if (!currentOrg) return;
    setSessionsLoading(true);
    setError("");
    try {
      const data = await api.post<{
        sessions: SessionRow[];
      }>(`/orgs/${currentOrg.id}/intelligence/user/sessions/aggregate`, {
        days: sessionsDays
      });
      setSessions(data.sessions || []);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load sessions"));
    } finally {
      setSessionsLoading(false);
    }
  }, [currentOrg, sessionsDays]);
  const loadGoals = useCallback(async () => {
    if (!currentOrg) return;
    setGoalsLoading(true);
    try {
      const data = await api.get<{
        goals: Goal[];
      }>(`/orgs/${currentOrg.id}/intelligence/user/goals`);
      setGoals(data.goals || []);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load goals"));
    } finally {
      setGoalsLoading(false);
    }
  }, [currentOrg]);
  const loadCohorts = useCallback(async () => {
    if (!currentOrg) return;
    setCohortsLoading(true);
    try {
      const data = await api.get<{
        cohorts: Cohort[];
      }>(`/orgs/${currentOrg.id}/intelligence/user/dashboard/cohort`);
      setCohorts(data.cohorts || []);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load cohorts"));
    } finally {
      setCohortsLoading(false);
    }
  }, [currentOrg]);
  const loadSegments = useCallback(async () => {
    if (!currentOrg) return;
    setSegmentsLoading(true);
    try {
      const data = await api.get<{
        segments: Segment[];
      }>(`/orgs/${currentOrg.id}/intelligence/user/segment`);
      setSegments(data.segments || []);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load segments"));
    } finally {
      setSegmentsLoading(false);
    }
  }, [currentOrg]);
  useEffect(() => {
    if (currentOrg) {
      loadSessions();
      loadGoals();
      loadCohorts();
      loadSegments();
    }
  }, [currentOrg, loadSessions, loadGoals, loadCohorts, loadSegments]);
  async function handleCreateGoal() {
    if (!currentOrg || !newGoalName.trim()) return;
    setCreatingGoal(true);
    setError("");
    try {
      await api.post(`/orgs/${currentOrg.id}/intelligence/user/goals`, {
        name: newGoalName.trim(),
        description: newGoalDescription.trim() || undefined,
        target: newGoalTarget
      });
      setNewGoalName("");
      setNewGoalTarget(100);
      setNewGoalDescription("");
      setShowAddGoal(false);
      await loadGoals();
    } catch (err) {
      setError(errorFromCaught(err, "Failed to create goal"));
    } finally {
      setCreatingGoal(false);
    }
  }
  async function handleSatisfactionAnalyze() {
    if (!currentOrg || !satisfactionTraceId.trim()) return;
    setSatisfactionLoading(true);
    setError("");
    setSatisfaction(null);
    setCorrection(null);
    try {
      const [sat, cor] = await Promise.allSettled([api.get<SatisfactionData>(`/orgs/${currentOrg.id}/intelligence/user/satisfaction/${satisfactionTraceId.trim()}`), api.get<CorrectionData>(`/orgs/${currentOrg.id}/intelligence/user/correction/${satisfactionTraceId.trim()}`)]);
      if (sat.status === "fulfilled") {
        setSatisfaction(sat.value);
        setRecentSatisfaction(prev => [{
          trace_id: sat.value.trace_id,
          satisfaction: sat.value.satisfaction
        }, ...prev].slice(0, 10));
      } else {
        setError("Satisfaction data not available for this trace");
      }
      if (cor.status === "fulfilled") {
        setCorrection(cor.value);
      }
    } catch (err) {
      setError(errorFromCaught(err, "Analysis failed"));
    } finally {
      setSatisfactionLoading(false);
    }
  }
  if (!currentOrg) {
    return <NoOrgState icon={Users} feature="User Intelligence" description="Session aggregation, goal tracking, and behavioral cohorts light up once your organization has user activity to analyse." />;
  }
  return <PageContent size="wide">
      <PageHeader eyebrow="Intelligence" title="User Intelligence" subtitle="The 97% problem: behaviour-driven satisfaction, behavioural cohorts, and goal tracking" icon={Users} />

      {error && <div role="alert" className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <Button variant="ghost" size="sm" onClick={() => {
        setError("");
        loadSessions();
        loadGoals();
        loadCohorts();
        loadSegments();
      }} aria-label="Retry loading all tabs">
            <RefreshCw className="w-3.5 h-3.5" aria-hidden />
            Retry
          </Button>
        </div>}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
        <TabsList aria-label="User intelligence sections" className="bg-[var(--bg-tertiary)] rounded-xl h-auto flex-wrap w-fit">
          {([{
          key: "sessions" as Tab,
          label: "Sessions",
          icon: Activity
        }, {
          key: "goals" as Tab,
          label: "Goals",
          icon: Target
        }, {
          key: "satisfaction" as Tab,
          label: "Satisfaction",
          icon: Smile
        }, {
          key: "cohorts" as Tab,
          label: "Cohorts",
          icon: Users2
        }, {
          key: "segments" as Tab,
          label: "Segments",
          icon: Layers
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
          {activeTab === "sessions" && <SessionsTab sessions={sessions} loading={sessionsLoading} days={sessionsDays} onDaysChange={setSessionsDays} onRefresh={loadSessions} />}
          {activeTab === "goals" && <GoalsTab goals={goals} loading={goalsLoading} showAdd={showAddGoal} onShowAddChange={setShowAddGoal} newName={newGoalName} onNewNameChange={setNewGoalName} newTarget={newGoalTarget} onNewTargetChange={setNewGoalTarget} newDescription={newGoalDescription} onNewDescriptionChange={setNewGoalDescription} onCreate={handleCreateGoal} creating={creatingGoal} />}
          {activeTab === "satisfaction" && <SatisfactionTab traceId={satisfactionTraceId} onTraceIdChange={setSatisfactionTraceId} onAnalyze={handleSatisfactionAnalyze} satisfaction={satisfaction} correction={correction} loading={satisfactionLoading} recent={recentSatisfaction} />}
          {activeTab === "cohorts" && <CohortsTab cohorts={cohorts} loading={cohortsLoading} onRefresh={loadCohorts} />}
          {activeTab === "segments" && <SegmentsTab segments={segments} loading={segmentsLoading} onRefresh={loadSegments} />}
        </motion.div>
      </AnimatePresence>
      </Tabs>
    </PageContent>;
}

// ──────────────────────────────────────────────────────────────────────────
// Sessions Tab
// ──────────────────────────────────────────────────────────────────────────

function SessionsTab({
  sessions,
  loading,
  days,
  onDaysChange,
  onRefresh
}: {
  sessions: SessionRow[];
  loading: boolean;
  days: number;
  onDaysChange: (d: number) => void;
  onRefresh: () => void;
}) {
  return <div className="space-y-4">
      <Card padding="sm" className="flex flex-wrap items-center gap-3">
        <label htmlFor="sessions-days" className="sr-only">
          Time range
        </label>
        <select id="sessions-days" value={days} onChange={e => onDaysChange(Number(e.target.value))} aria-label="Sessions time range" className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh sessions" className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors ml-auto">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Activity className="w-3.5 h-3.5" aria-hidden />}
          Refresh
        </button>
      </Card>

      {loading && sessions.length === 0 ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : sessions.length === 0 ? <EmptyState icon={Activity} title="No sessions yet" description="Aggregated user sessions appear here once your agents start serving real users." size="lg" /> : <Card padding="lg" className="overflow-hidden">
          <DataTable columns={[{
        key: "user_id",
        header: "User",
        cell: s => <span className="font-mono text-xs text-[var(--text-primary)]">{s.user_id.slice(0, 12)}...</span>
      }, {
        key: "session_id",
        header: "Session",
        cell: s => <span className="font-mono text-xs text-[var(--text-muted)]">{s.session_id.slice(0, 12)}...</span>
      }, {
        key: "trace_count",
        header: "Traces",
        sortable: true,
        align: "right",
        cell: s => <span className="text-[var(--text-secondary)] tabular-nums">{s.trace_count}</span>
      }, {
        key: "first_seen",
        header: "First Seen",
        sortable: true,
        cell: s => <span className="text-[var(--text-secondary)] text-xs">{new Date(s.first_seen).toLocaleString()}</span>
      }, {
        key: "last_seen",
        header: "Last Seen",
        sortable: true,
        cell: s => <span className="text-[var(--text-secondary)] text-xs">{new Date(s.last_seen).toLocaleString()}</span>
      }]} rows={sessions} rowKey={s => s.session_id} defaultSort={{
        key: "last_seen",
        direction: "desc"
      }} emptyTitle="No sessions yet" emptyDescription="Aggregated user sessions appear here once your agents start serving real users." emptyIcon={Users} pageSize={25} />
        </Card>}
    </div>;
}

// ──────────────────────────────────────────────────────────────────────────
// Goals Tab
// ──────────────────────────────────────────────────────────────────────────

function GoalsTab({
  goals,
  loading,
  showAdd,
  onShowAddChange,
  newName,
  onNewNameChange,
  newTarget,
  onNewTargetChange,
  newDescription,
  onNewDescriptionChange,
  onCreate,
  creating
}: {
  goals: Goal[];
  loading: boolean;
  showAdd: boolean;
  onShowAddChange: (v: boolean) => void;
  newName: string;
  onNewNameChange: (v: string) => void;
  newTarget: number;
  onNewTargetChange: (v: number) => void;
  newDescription: string;
  onNewDescriptionChange: (v: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  return <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={() => onShowAddChange(!showAdd)} aria-expanded={showAdd} aria-controls="new-goal-form" className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors">
          <Plus className="w-4 h-4" aria-hidden />
          {showAdd ? "Cancel" : "Add Goal"}
        </button>
      </div>

      <AnimatePresence>
        {showAdd && <motion.div id="new-goal-form" initial={{
        opacity: 0,
        height: 0
      }} animate={{
        opacity: 1,
        height: "auto"
      }} exit={{
        opacity: 0,
        height: 0
      }} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
            <div className="p-5 space-y-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">New Goal</h3>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-goal-name" className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">
                    Name
                  </label>
                  <input id="new-goal-name" type="text" value={newName} onChange={e => onNewNameChange(e.target.value)} placeholder="e.g. Weekly active traces" className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]" />
                </div>
                <div>
                  <label htmlFor="new-goal-target" className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">
                    Target
                  </label>
                  <input id="new-goal-target" type="number" value={newTarget} onChange={e => onNewTargetChange(Number(e.target.value))} min={1} className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]" />
                </div>
              </div>
              <div>
                <label htmlFor="new-goal-description" className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">
                  Description (optional)
                </label>
                <textarea id="new-goal-description" value={newDescription} onChange={e => onNewDescriptionChange(e.target.value)} rows={2} placeholder="What does success look like?" className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]" />
              </div>
              <button type="button" onClick={onCreate} disabled={creating || !newName.trim()} aria-label="Create goal" className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Target className="w-4 h-4" aria-hidden />}
                Create Goal
              </button>
            </div>
          </motion.div>}
      </AnimatePresence>

      {loading && goals.length === 0 ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : goals.length === 0 ? <EmptyState icon={Target} title="No goals tracked" description="Define the success metrics you want to monitor — current progress will appear here as data flows in." size="lg" /> : <div className="grid sm:grid-cols-2 gap-3">
          {goals.map(goal => {
        const pct = Math.min(100, goal.current / Math.max(goal.target, 1) * 100);
        return <Card padding="md" className="space-y-3" key={goal.goal_id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{goal.name}</h3>
                    {goal.description && <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">
                        {goal.description}
                      </p>}
                  </div>
                  <span className="text-xs text-[var(--text-muted)] tabular-nums whitespace-nowrap">
                    {goal.current.toLocaleString()} / {goal.target.toLocaleString()}
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div className={cn("h-full rounded-full transition-all duration-500", pct >= 100 ? "bg-[var(--terminal)]" : pct >= 50 ? "bg-[var(--accent)]" : "bg-[var(--warning)]")} style={{
                width: `${pct}%`
              }} />
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)] text-right tabular-nums">
                    {pct.toFixed(0)}%
                  </p>
                </div>
              </Card>;
      })}
        </div>}
    </div>;
}

// ──────────────────────────────────────────────────────────────────────────
// Satisfaction Tab
// ──────────────────────────────────────────────────────────────────────────

function SatisfactionTab({
  traceId,
  onTraceIdChange,
  onAnalyze,
  satisfaction,
  correction,
  loading,
  recent
}: {
  traceId: string;
  onTraceIdChange: (v: string) => void;
  onAnalyze: () => void;
  satisfaction: SatisfactionData | null;
  correction: CorrectionData | null;
  loading: boolean;
  recent: Array<{
    trace_id: string;
    satisfaction: number;
  }>;
}) {
  return <div className="space-y-6">
      {/* Input */}
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <Smile className="w-4 h-4 text-[var(--accent)]" aria-hidden />
          Analyze Trace Satisfaction
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <label htmlFor="satisfaction-trace-id" className="sr-only">
            Trace ID
          </label>
          <input id="satisfaction-trace-id" type="text" value={traceId} onChange={e => onTraceIdChange(e.target.value)} onKeyDown={e => {
          if (e.key === "Enter") onAnalyze();
        }} placeholder="Enter a trace_id..." className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] font-mono placeholder:text-[var(--text-muted)]" />
          <button type="button" onClick={onAnalyze} disabled={loading || !traceId.trim()} aria-label="Analyze satisfaction" className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Search className="w-4 h-4" aria-hidden />}
            Analyze
          </button>
        </div>
      </Card>

      {/* Result */}
      {loading ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : satisfaction ? <motion.div initial={{
      opacity: 0,
      y: 8
    }} animate={{
      opacity: 1,
      y: 0
    }} className="space-y-4">
          <Card padding="lg">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Satisfaction Score
                </h3>
                <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">
                  {satisfaction.trace_id}
                </p>
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-[var(--accent)] tabular-nums">
                  {(satisfaction.satisfaction * 100).toFixed(1)}%
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  confidence {(satisfaction.confidence * 100).toFixed(0)}%
                </p>
              </div>
            </div>
            <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div className="h-full bg-[var(--accent)] rounded-full transition-all duration-500" style={{
            width: `${Math.max(0, Math.min(100, satisfaction.satisfaction * 100))}%`
          }} />
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-2">
              Correction magnitude: {satisfaction.correction.toFixed(3)}
            </p>
          </Card>

          {correction && <Card padding="lg">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-[var(--accent)]" aria-hidden />
                Beta-Binomial Correction
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                {([{
            label: "Raw",
            value: correction.raw.toFixed(3)
          }, {
            label: "Corrected",
            value: correction.corrected.toFixed(3),
            highlight: true
          }, {
            label: "α",
            value: correction.alpha.toFixed(2)
          }, {
            label: "β",
            value: correction.beta.toFixed(2)
          }, {
            label: "n",
            value: String(correction.n)
          }] as Array<{
            label: string;
            value: string;
            highlight?: boolean;
          }>).map(({
            label,
            value,
            highlight
          }) => <div key={label}>
                    <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">{label}</p>
                    <p className={cn("text-lg font-semibold tabular-nums", highlight ? "text-[var(--accent)]" : "text-[var(--text-primary)]")}>
                      {value}
                    </p>
                  </div>)}
              </div>
            </Card>}
        </motion.div> : null}

      {/* Recent traces */}
      {recent.length > 0 && <Card padding="lg" className="overflow-hidden">
          <div className="p-4 border-b border-[var(--border-default)]">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Recent traces</h3>
          </div>
          <DataTable columns={[{
        key: "trace_id",
        header: "Trace",
        cell: r => <span className="font-mono text-xs text-[var(--text-primary)]">{r.trace_id.slice(0, 20)}...</span>
      }, {
        key: "satisfaction",
        header: "Satisfaction",
        sortable: true,
        align: "right",
        cell: r => <span className="text-sm font-semibold text-[var(--accent)] tabular-nums">{(r.satisfaction * 100).toFixed(1)}%</span>
      }]} rows={recent} rowKey={r => r.trace_id} defaultSort={{
        key: "satisfaction",
        direction: "desc"
      }} pageSize={25} />
        </Card>}
    </div>;
}

// ──────────────────────────────────────────────────────────────────────────
// Cohorts Tab
// ──────────────────────────────────────────────────────────────────────────

function CohortsTab({
  cohorts,
  loading,
  onRefresh
}: {
  cohorts: Cohort[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh cohorts" className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Activity className="w-3.5 h-3.5" aria-hidden />}
          Refresh
        </button>
      </div>

      {loading && cohorts.length === 0 ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : cohorts.length === 0 ? <EmptyState icon={Users2} title="No cohorts yet" description="Behavioural cohorts surface once the system has enough traces to group users by behaviour patterns." size="lg" /> : <Card padding="lg" className="overflow-hidden">
          <DataTable columns={[{
        key: "name",
        header: "Cohort",
        sortable: true,
        cell: c => <span className="text-[var(--text-primary)] font-medium">{c.name}</span>
      }, {
        key: "user_count",
        header: "Users",
        sortable: true,
        align: "right",
        cell: c => <span className="text-[var(--text-secondary)] tabular-nums">{c.user_count.toLocaleString()}</span>
      }, {
        key: "satisfaction",
        header: "Satisfaction",
        sortable: true,
        align: "right",
        cell: c => <span className={cn("text-sm font-semibold tabular-nums", c.satisfaction >= 0.8 ? "text-[var(--terminal)]" : c.satisfaction >= 0.5 ? "text-[var(--warning)]" : "text-[var(--error)]")}>
                    {(c.satisfaction * 100).toFixed(1)}%
                  </span>
      }, {
        key: "regen_rate",
        header: "Regen Rate",
        sortable: true,
        align: "right",
        cell: c => <span className="text-[var(--text-secondary)] tabular-nums">{(c.regen_rate * 100).toFixed(1)}%</span>
      }]} rows={cohorts} rowKey={(c, i) => `${c.name}-${i}`} defaultSort={{
        key: "user_count",
        direction: "desc"
      }} emptyTitle="No cohorts yet" emptyDescription="Behavioural cohorts surface once the system has enough traces to group users by behaviour patterns." emptyIcon={Users2} pageSize={25} />
        </Card>}
    </div>;
}

// ──────────────────────────────────────────────────────────────────────────
// Segments Tab
// ──────────────────────────────────────────────────────────────────────────

function SegmentsTab({
  segments,
  loading,
  onRefresh
}: {
  segments: Segment[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh segments" className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Activity className="w-3.5 h-3.5" aria-hidden />}
          Refresh
        </button>
      </div>

      {loading && segments.length === 0 ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : segments.length === 0 ? <EmptyState icon={Layers} title="No segments defined" description="User segments are derived from behavioural signals — they will appear here automatically as patterns emerge." size="lg" /> : <Card padding="lg" className="overflow-hidden">
          <DataTable columns={[{
        key: "name",
        header: "Segment",
        sortable: true,
        cell: s => <span className="text-[var(--text-primary)] font-medium">{s.name}</span>
      }, {
        key: "user_count",
        header: "Users",
        sortable: true,
        align: "right",
        cell: s => <span className="text-[var(--text-secondary)] tabular-nums">{s.user_count.toLocaleString()}</span>
      }, {
        key: "criteria",
        header: "Criteria",
        cell: s => <pre className="text-[10px] bg-[var(--bg-secondary)] rounded p-2 max-w-md overflow-x-auto text-[var(--text-muted)]">
                    {JSON.stringify(s.criteria, null, 2)}
                  </pre>
      }]} rows={segments} rowKey={s => s.segment_id} defaultSort={{
        key: "name",
        direction: "asc"
      }} emptyTitle="No segments defined" emptyDescription="User segments are derived from behavioural signals — they will appear here automatically as patterns emerge." emptyIcon={Layers} pageSize={25} />
        </Card>}
    </div>;
}
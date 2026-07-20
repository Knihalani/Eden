"use client";

import { useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Users, Target, Smile, Users2, Layers, Plus, Loader2, AlertTriangle, Activity, TrendingUp, Search, RefreshCw } from "lucide-react";
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
  const embedded = useEmbeddedSurface();
  const orgId = currentOrg?.id;
  const [activeTab, setActiveTab] = useState<Tab>("sessions");

  // Satisfaction — kept as an on-demand imperative lookup (single
  // trace at a time, triggered by user input) rather than a query.
  const [satisfactionTraceId, setSatisfactionTraceId] = useState("");
  const [satisfaction, setSatisfaction] = useState<SatisfactionData | null>(null);
  const [correction, setCorrection] = useState<CorrectionData | null>(null);
  const [satisfactionLoading, setSatisfactionLoading] = useState(false);
  const [satisfactionError, setSatisfactionError] = useState("");
  const [recentSatisfaction, setRecentSatisfaction] = useState<Array<{
    trace_id: string;
    satisfaction: number;
  }>>([]);

  // Goals form
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [newGoalName, setNewGoalName] = useState("");
  const [newGoalTarget, setNewGoalTarget] = useState<number>(100);
  const [newGoalDescription, setNewGoalDescription] = useState("");
  const [goalError, setGoalError] = useState("");

  // The four tabs below load in parallel on mount — 2+ parallel GETs,
  // so they're React Query-backed for shared caching/dedup instead of
  // four hand-rolled useEffect loaders.
  const [sessionsDays, setSessionsDays] = useState(30);
  const sessionsQuery = useOrgQuery(
    queryKeys.users.sessions(orgId, sessionsDays),
    orgId,
    () => api.post<{ sessions: SessionRow[] }>(`/orgs/${orgId}/intelligence/user/sessions/aggregate`, { days: sessionsDays }),
    { enabled: activeTab === "sessions" },
  );
  const goalsQuery = useOrgQuery(
    queryKeys.users.goals(orgId),
    orgId,
    () => api.get<{ goals: Goal[] }>(`/orgs/${orgId}/intelligence/user/goals`),
    { enabled: activeTab === "goals" },
  );
  const cohortsQuery = useOrgQuery(
    queryKeys.users.cohorts(orgId),
    orgId,
    () => api.get<{ cohorts: Cohort[] }>(`/orgs/${orgId}/intelligence/user/dashboard/cohort`),
    { enabled: activeTab === "cohorts" },
  );
  const segmentsQuery = useOrgQuery(
    queryKeys.users.segments(orgId),
    orgId,
    () => api.get<{ segments: Segment[] }>(`/orgs/${orgId}/intelligence/user/segment`),
    { enabled: activeTab === "segments" },
  );

  const createGoalMutation = useOrgMutation(
    (payload: { name: string; description?: string; target: number }) =>
      api.post(`/orgs/${orgId}/intelligence/user/goals`, payload),
    { invalidateKeys: [queryKeys.users.goals(orgId)] },
  );

  // Only the active tab's error — ORing all tabs caused a false banner when
  // a previously visited tab failed and the user switched away.
  const activeTabError =
    activeTab === "sessions"
      ? sessionsQuery.error
      : activeTab === "goals"
        ? goalsQuery.error
        : activeTab === "cohorts"
          ? cohortsQuery.error
          : activeTab === "segments"
            ? segmentsQuery.error
            : null;
  const retryActiveTab = useCallback(() => {
    if (activeTab === "sessions") void sessionsQuery.refetch();
    else if (activeTab === "goals") void goalsQuery.refetch();
    else if (activeTab === "cohorts") void cohortsQuery.refetch();
    else if (activeTab === "segments") void segmentsQuery.refetch();
  }, [
    activeTab,
    sessionsQuery.refetch,
    goalsQuery.refetch,
    cohortsQuery.refetch,
    segmentsQuery.refetch,
  ]);

  async function handleCreateGoal() {
    if (!newGoalName.trim()) return;
    setGoalError("");
    try {
      await createGoalMutation.mutateAsync({
        name: newGoalName.trim(),
        description: newGoalDescription.trim() || undefined,
        target: newGoalTarget,
      });
      setNewGoalName("");
      setNewGoalTarget(100);
      setNewGoalDescription("");
      setShowAddGoal(false);
    } catch (err) {
      setGoalError(errorFromCaught(err, "Failed to create goal"));
    }
  }
  async function handleSatisfactionAnalyze() {
    if (!currentOrg || !satisfactionTraceId.trim()) return;
    setSatisfactionLoading(true);
    setSatisfactionError("");
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
        setSatisfactionError("Satisfaction data not available for this trace");
      }
      if (cor.status === "fulfilled") {
        setCorrection(cor.value);
      }
    } catch (err) {
      setSatisfactionError(errorFromCaught(err, "Analysis failed"));
    } finally {
      setSatisfactionLoading(false);
    }
  }
  if (!currentOrg) {
    return <NoOrgState icon={Users} feature="User Intelligence" description="Session aggregation, goal tracking, and behavioral cohorts light up once your organization has user activity to analyse." />;
  }
  return <PageContent size="wide">
      {!embedded ? (
        <PageHeader eyebrow="Intelligence" title="User Intelligence" subtitle="The 97% problem: behaviour-driven satisfaction, behavioural cohorts, and goal tracking" icon={Users} />
      ) : null}

      {/* Tabs — pills under Analytics embed to avoid a second chrome band (W12). */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
        <TabsList
          variant={embedded ? "pills" : "default"}
          aria-label="User intelligence sections"
          className={
            embedded
              ? "h-auto w-full justify-start gap-1 overflow-x-auto"
              : "bg-[var(--bg-tertiary)] rounded-xl h-auto flex-wrap w-fit"
          }
        >
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
            <TabsTrigger
              key={key}
              value={key}
              variant={embedded ? "pills" : "default"}
              className="flex items-center gap-2 data-[state=active]:text-[var(--text-primary)]"
            >
              <Icon className="w-4 h-4" aria-hidden />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

      {/* Content — ErrorState preferred over false empty on API failure */}
          {activeTab === "sessions" && (
            <SessionsTab
              sessions={sessionsQuery.data?.sessions ?? []}
              loading={sessionsQuery.isLoading}
              error={activeTabError?.message ?? null}
              days={sessionsDays}
              onDaysChange={setSessionsDays}
              onRefresh={retryActiveTab}
            />
          )}
          {activeTab === "goals" && (
            <GoalsTab
              goals={goalsQuery.data?.goals ?? []}
              loading={goalsQuery.isLoading}
              loadError={activeTabError?.message ?? null}
              onRetryLoad={retryActiveTab}
              showAdd={showAddGoal}
              onShowAddChange={setShowAddGoal}
              newName={newGoalName}
              onNewNameChange={setNewGoalName}
              newTarget={newGoalTarget}
              onNewTargetChange={setNewGoalTarget}
              newDescription={newGoalDescription}
              onNewDescriptionChange={setNewGoalDescription}
              onCreate={handleCreateGoal}
              creating={createGoalMutation.isPending}
              error={goalError}
            />
          )}
          {activeTab === "satisfaction" && (
            <SatisfactionTab
              traceId={satisfactionTraceId}
              onTraceIdChange={setSatisfactionTraceId}
              onAnalyze={handleSatisfactionAnalyze}
              satisfaction={satisfaction}
              correction={correction}
              loading={satisfactionLoading}
              error={satisfactionError}
              recent={recentSatisfaction}
            />
          )}
          {activeTab === "cohorts" && (
            <CohortsTab
              cohorts={cohortsQuery.data?.cohorts ?? []}
              loading={cohortsQuery.isLoading}
              error={activeTabError?.message ?? null}
              onRefresh={retryActiveTab}
            />
          )}
          {activeTab === "segments" && (
            <SegmentsTab
              segments={segmentsQuery.data?.segments ?? []}
              loading={segmentsQuery.isLoading}
              error={activeTabError?.message ?? null}
              onRefresh={retryActiveTab}
            />
          )}
        
      </Tabs>
    </PageContent>;
}

// ──────────────────────────────────────────────────────────────────────────
// Sessions Tab
// ──────────────────────────────────────────────────────────────────────────

function SessionsTab({
  sessions,
  loading,
  error,
  days,
  onDaysChange,
  onRefresh
}: {
  sessions: SessionRow[];
  loading: boolean;
  error: string | null;
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

      {error ? (
        <ErrorState
          size="lg"
          title="Could not load sessions"
          message={error}
          action={
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
              <RefreshCw className="w-3.5 h-3.5" aria-hidden />
              Try again
            </Button>
          }
        />
      ) : loading && sessions.length === 0 ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : sessions.length === 0 ? <EmptyState icon={Activity} title="No sessions yet" description="No aggregated sessions yet. They appear once agents serve traffic with user identifiers." size="lg" /> : <Card padding="lg" className="overflow-hidden">
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
  loadError,
  onRetryLoad,
  showAdd,
  onShowAddChange,
  newName,
  onNewNameChange,
  newTarget,
  onNewTargetChange,
  newDescription,
  onNewDescriptionChange,
  onCreate,
  creating,
  error
}: {
  goals: Goal[];
  loading: boolean;
  loadError: string | null;
  onRetryLoad: () => void;
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
  error?: string;
}) {
  return <div className="space-y-4">
      {error && <div role="alert" className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
        </div>}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="default"
          className="min-h-11"
          onClick={() => onShowAddChange(!showAdd)}
          aria-expanded={showAdd}
          aria-controls="new-goal-form"
        >
          <Plus className="w-4 h-4" aria-hidden />
          {showAdd ? "Cancel" : "Add Goal"}
        </Button>
      </div>

      <>
        {showAdd && <div id="new-goal-form" className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
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
              <Button
                type="button"
                variant="default"
                className="min-h-11"
                onClick={onCreate}
                disabled={!newName.trim()}
                loading={creating}
                aria-label="Create goal"
              >
                <Target className="w-4 h-4" aria-hidden />
                Create Goal
              </Button>
            </div>
          </div>}
      </>

      {loadError ? (
        <ErrorState
          size="lg"
          title="Could not load goals"
          message={loadError}
          action={
            <Button variant="outline" size="sm" onClick={onRetryLoad} disabled={loading}>
              <RefreshCw className="w-3.5 h-3.5" aria-hidden />
              Try again
            </Button>
          }
        />
      ) : loading && goals.length === 0 ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : goals.length === 0 ? <EmptyState icon={Target} title="No goals tracked" description="No goals defined yet. Add success metrics to monitor; progress appears as data flows in." size="lg" /> : <div className="grid sm:grid-cols-2 gap-3">
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
                  <p className="text-2xs text-[var(--text-muted)] text-right tabular-nums">
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
  error,
  recent
}: {
  traceId: string;
  onTraceIdChange: (v: string) => void;
  onAnalyze: () => void;
  satisfaction: SatisfactionData | null;
  correction: CorrectionData | null;
  loading: boolean;
  error?: string;
  recent: Array<{
    trace_id: string;
    satisfaction: number;
  }>;
}) {
  return <div className="space-y-space-6">
      {/* Input */}
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-space-4 flex items-center gap-space-2">
          <Smile className="w-4 h-4 text-[var(--accent)]" aria-hidden />
          Analyze Trace Satisfaction
        </h3>
        <div className="flex flex-col sm:flex-row gap-space-3">
          <label htmlFor="satisfaction-trace-id" className="sr-only">
            Trace ID
          </label>
          <input id="satisfaction-trace-id" type="text" value={traceId} onChange={e => onTraceIdChange(e.target.value)} onKeyDown={e => {
          if (e.key === "Enter") onAnalyze();
        }} placeholder="Enter a trace_id..." className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] font-mono placeholder:text-[var(--text-muted)]" />
          <Button
            type="button"
            variant="default"
            className="min-h-11"
            onClick={onAnalyze}
            disabled={!traceId.trim()}
            loading={loading}
            aria-label="Analyze satisfaction"
          >
            <Search className="w-4 h-4" aria-hidden />
            Analyze
          </Button>
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-[var(--error)] flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
            {error}
          </p>}
      </Card>

      {/* Result */}
      {loading ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : satisfaction ? <div className="space-y-4">
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
                    <p className="text-2xs font-mono text-[var(--text-muted)] uppercase tracking-wide">{label}</p>
                    <p className={cn("text-lg font-semibold tabular-nums", highlight ? "text-[var(--accent)]" : "text-[var(--text-primary)]")}>
                      {value}
                    </p>
                  </div>)}
              </div>
            </Card>}
        </div> : null}

      {/* Recent traces */}
      {recent.length > 0 && <Card padding="none" className="overflow-hidden">
          <div className="px-space-4 py-space-3 border-b border-[var(--border-default)]">
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
  error,
  onRefresh
}: {
  cohorts: Cohort[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh cohorts" className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Activity className="w-3.5 h-3.5" aria-hidden />}
          Refresh
        </button>
      </div>

      {error ? (
        <ErrorState
          size="lg"
          title="Could not load cohorts"
          message={error}
          action={
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
              <RefreshCw className="w-3.5 h-3.5" aria-hidden />
              Try again
            </Button>
          }
        />
      ) : loading && cohorts.length === 0 ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : cohorts.length === 0 ? <EmptyState icon={Users2} title="No cohorts yet" description="No behavioural cohorts yet. They surface once enough traces exist to group users by behaviour." size="lg" /> : <Card padding="lg" className="overflow-hidden">
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
  error,
  onRefresh
}: {
  segments: Segment[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh segments" className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Activity className="w-3.5 h-3.5" aria-hidden />}
          Refresh
        </button>
      </div>

      {error ? (
        <ErrorState
          size="lg"
          title="Could not load segments"
          message={error}
          action={
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
              <RefreshCw className="w-3.5 h-3.5" aria-hidden />
              Try again
            </Button>
          }
        />
      ) : loading && segments.length === 0 ? <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" aria-hidden />
        </div> : segments.length === 0 ? <EmptyState icon={Layers} title="No segments defined" description="No segments yet. They are derived from behavioural signals as patterns emerge." size="lg" /> : <Card padding="lg" className="overflow-hidden">
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
        cell: s => <pre className="text-2xs font-mono bg-[var(--bg-secondary)] rounded p-2 max-w-md overflow-x-auto text-[var(--text-muted)]">
                    {JSON.stringify(s.criteria, null, 2)}
                  </pre>
      }]} rows={segments} rowKey={s => s.segment_id} defaultSort={{
        key: "name",
        direction: "asc"
      }} emptyTitle="No segments defined" emptyDescription="User segments are derived from behavioural signals — they will appear here automatically as patterns emerge." emptyIcon={Layers} pageSize={25} />
        </Card>}
    </div>;
}
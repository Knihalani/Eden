"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Activity, Layers, Loader2, Smile, Target, Users, Users2 } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";

type Mode = "sessions" | "goals" | "satisfaction" | "cohorts" | "segments";

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
}

/** Thin Users panel for Analytics — sessions table + detail drawer. */
export function UsersPanel() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const [mode, setMode] = useState<Mode>("sessions");
  const [days, setDays] = useState(30);
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [satTrace, setSatTrace] = useState("");
  const [satLoading, setSatLoading] = useState(false);
  const [satError, setSatError] = useState("");
  const [satValue, setSatValue] = useState<number | null>(null);

  const sessionsQuery = useOrgQuery(
    queryKeys.users.sessions(orgId, days),
    orgId,
    () =>
      api.post<{ sessions: SessionRow[] }>(
        `/orgs/${orgId}/intelligence/user/sessions/aggregate`,
        { days },
      ),
    { enabled: mode === "sessions" },
  );
  const goalsQuery = useOrgQuery(
    queryKeys.users.goals(orgId),
    orgId,
    () => api.get<{ goals: Goal[] }>(`/orgs/${orgId}/intelligence/user/goals`),
    { enabled: mode === "goals" },
  );
  const cohortsQuery = useOrgQuery(
    queryKeys.users.cohorts(orgId),
    orgId,
    () =>
      api.get<{ cohorts: Cohort[] }>(
        `/orgs/${orgId}/intelligence/user/dashboard/cohort`,
      ),
    { enabled: mode === "cohorts" },
  );
  const segmentsQuery = useOrgQuery(
    queryKeys.users.segments(orgId),
    orgId,
    () =>
      api.get<{ segments: Segment[] }>(
        `/orgs/${orgId}/intelligence/user/segment`,
      ),
    { enabled: mode === "segments" },
  );

  const createGoal = useOrgMutation(
    (payload: { name: string; target: number }) =>
      api.post(`/orgs/${orgId}/intelligence/user/goals`, payload),
    { invalidateKeys: [queryKeys.users.goals(orgId)] },
  );

  const analyzeSatisfaction = useCallback(async () => {
    if (!orgId || !satTrace.trim()) return;
    setSatLoading(true);
    setSatError("");
    setSatValue(null);
    try {
      const data = await api.get<{ satisfaction: number }>(
        `/orgs/${orgId}/intelligence/user/satisfaction/${satTrace.trim()}`,
      );
      setSatValue(data.satisfaction);
    } catch (err) {
      setSatError(errorFromCaught(err, "Satisfaction unavailable"));
    } finally {
      setSatLoading(false);
    }
  }, [orgId, satTrace]);

  return (
    <div data-testid="analytics-users-panel" data-wave6-analytics="users-thin">
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList
          variant="underline"
          aria-label="User intelligence modes"
          className="h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent"
        >
          {(
            [
              { key: "sessions" as const, label: "Sessions", icon: Activity },
              { key: "goals" as const, label: "Goals", icon: Target },
              { key: "satisfaction" as const, label: "Satisfaction", icon: Smile },
              { key: "cohorts" as const, label: "Cohorts", icon: Users2 },
              { key: "segments" as const, label: "Segments", icon: Layers },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <TabsTrigger
              key={key}
              value={key}
              variant="underline"
              className="flex items-center gap-1.5"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-3">
        {mode === "sessions" ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <label htmlFor="users-days" className="sr-only">
                Time range
              </label>
              <select
                id="users-days"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                aria-label="Sessions time range"
                className="min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
              >
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void sessionsQuery.refetch()}
                disabled={sessionsQuery.isLoading}
                loading={sessionsQuery.isFetching}
                aria-label="Refresh sessions"
                className="ml-auto"
              >
                Refresh
              </Button>
            </div>
            <QueryState
              loading={sessionsQuery.isLoading}
              error={sessionsQuery.error}
              data={sessionsQuery.data}
              onRetry={() => void sessionsQuery.refetch()}
              isEmpty={(d) => (d?.sessions.length ?? 0) === 0}
              emptySlot={
                <EmptyState
                  icon={Users}
                  title="No sessions yet"
                  description="Aggregated sessions appear once agents serve traffic with user identifiers."
                  size="md"
                />
              }
              errorTitle="Could not load sessions"
            >
              {(data) => (
                <DataTable
                  columns={[
                    {
                      key: "user_id",
                      header: "User",
                      cell: (s) => (
                        <span className="font-mono text-xs">
                          {s.user_id.slice(0, 12)}…
                        </span>
                      ),
                    },
                    {
                      key: "session_id",
                      header: "Session",
                      cell: (s) => (
                        <span className="font-mono text-xs text-[var(--text-muted)]">
                          {s.session_id.slice(0, 12)}…
                        </span>
                      ),
                    },
                    {
                      key: "trace_count",
                      header: "Traces",
                      sortable: true,
                      align: "right",
                      cell: (s) => (
                        <span className="tabular-nums">{s.trace_count}</span>
                      ),
                    },
                    {
                      key: "last_seen",
                      header: "Last seen",
                      sortable: true,
                      cell: (s) => (
                        <span className="text-xs text-[var(--text-secondary)]">
                          {new Date(s.last_seen).toLocaleString()}
                        </span>
                      ),
                    },
                  ]}
                  rows={data.sessions}
                  rowKey={(s) => s.session_id}
                  defaultSort={{ key: "last_seen", direction: "desc" }}
                  pageSize={25}
                  onRowClick={(s) => setSelected(s)}
                />
              )}
            </QueryState>
          </>
        ) : null}

        {mode === "goals" ? (
          <QueryState
            loading={goalsQuery.isLoading}
            error={goalsQuery.error}
            data={goalsQuery.data}
            onRetry={() => void goalsQuery.refetch()}
            isEmpty={(d) => (d?.goals.length ?? 0) === 0}
            emptySlot={
              <EmptyState
                icon={Target}
                title="No goals tracked"
                description="Add a success metric to monitor progress as traffic flows in."
                size="md"
                action={
                  <Button
                    size="sm"
                    onClick={() =>
                      void createGoal.mutateAsync({
                        name: "Weekly active traces",
                        target: 100,
                      })
                    }
                    loading={createGoal.isPending}
                  >
                    Add default goal
                  </Button>
                }
              />
            }
            errorTitle="Could not load goals"
          >
            {(data) => (
              <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-default)]">
                {data.goals.map((g) => {
                  const pct = Math.min(
                    100,
                    (g.current / Math.max(g.target, 1)) * 100,
                  );
                  return (
                    <li
                      key={g.goal_id}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                          {g.name}
                        </p>
                        <p className="text-xs text-[var(--text-muted)] tabular-nums">
                          {g.current.toLocaleString()} / {g.target.toLocaleString()}
                        </p>
                      </div>
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            pct >= 100
                              ? "bg-[var(--terminal)]"
                              : "bg-[var(--accent)]",
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueryState>
        ) : null}

        {mode === "satisfaction" ? (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={satTrace}
                onChange={(e) => setSatTrace(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void analyzeSatisfaction();
                }}
                placeholder="trace_id…"
                aria-label="Trace ID"
                className="min-h-11 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)]"
              />
              <Button
                onClick={() => void analyzeSatisfaction()}
                disabled={!satTrace.trim()}
                loading={satLoading}
              >
                Analyze
              </Button>
            </div>
            {satError ? (
              <p role="alert" className="text-sm text-[var(--error)]">
                {satError}
              </p>
            ) : null}
            {satValue != null ? (
              <p className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">
                {(satValue * 100).toFixed(1)}%
                <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
                  satisfaction
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        {mode === "cohorts" ? (
          <QueryState
            loading={cohortsQuery.isLoading}
            error={cohortsQuery.error}
            data={cohortsQuery.data}
            onRetry={() => void cohortsQuery.refetch()}
            isEmpty={(d) => (d?.cohorts.length ?? 0) === 0}
            emptySlot={
              <EmptyState
                icon={Users2}
                title="No cohorts yet"
                description="Behavioral cohorts appear after enough labeled traffic."
                size="md"
              />
            }
            errorTitle="Could not load cohorts"
          >
            {(data) => (
              <DataTable
                columns={[
                  {
                    key: "name",
                    header: "Cohort",
                    cell: (c) => (
                      <span className="text-sm">{c.name}</span>
                    ),
                  },
                  {
                    key: "user_count",
                    header: "Users",
                    align: "right",
                    cell: (c) => (
                      <span className="tabular-nums">{c.user_count}</span>
                    ),
                  },
                  {
                    key: "satisfaction",
                    header: "Sat.",
                    align: "right",
                    cell: (c) => (
                      <span className="tabular-nums">
                        {(c.satisfaction * 100).toFixed(0)}%
                      </span>
                    ),
                  },
                ]}
                rows={data.cohorts}
                rowKey={(c) => c.name}
                pageSize={25}
              />
            )}
          </QueryState>
        ) : null}

        {mode === "segments" ? (
          <QueryState
            loading={segmentsQuery.isLoading}
            error={segmentsQuery.error}
            data={segmentsQuery.data}
            onRetry={() => void segmentsQuery.refetch()}
            isEmpty={(d) => (d?.segments.length ?? 0) === 0}
            emptySlot={
              <EmptyState
                icon={Layers}
                title="No segments yet"
                description="Segments group users by shared criteria."
                size="md"
              />
            }
            errorTitle="Could not load segments"
          >
            {(data) => (
              <DataTable
                columns={[
                  {
                    key: "name",
                    header: "Segment",
                    cell: (s) => <span className="text-sm">{s.name}</span>,
                  },
                  {
                    key: "user_count",
                    header: "Users",
                    align: "right",
                    cell: (s) => (
                      <span className="tabular-nums">{s.user_count}</span>
                    ),
                  },
                ]}
                rows={data.segments}
                rowKey={(s) => s.segment_id}
                pageSize={25}
              />
            )}
          </QueryState>
        ) : null}
      </div>

      <Sheet open={selected != null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent side="right" className="w-full max-w-md">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>Session</SheetTitle>
                <SheetDescription className="font-mono text-xs">
                  {selected.session_id}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-3 overflow-y-auto px-4 py-3 text-sm">
                <dl className="grid grid-cols-[6rem_1fr] gap-y-2">
                  <dt className="text-[var(--text-muted)]">User</dt>
                  <dd className="truncate font-mono text-xs">{selected.user_id}</dd>
                  <dt className="text-[var(--text-muted)]">Traces</dt>
                  <dd className="tabular-nums">{selected.trace_count}</dd>
                  <dt className="text-[var(--text-muted)]">First</dt>
                  <dd className="text-xs">
                    {new Date(selected.first_seen).toLocaleString()}
                  </dd>
                  <dt className="text-[var(--text-muted)]">Last</dt>
                  <dd className="text-xs">
                    {new Date(selected.last_seen).toLocaleString()}
                  </dd>
                </dl>
                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link
                    href={`/sessions/${encodeURIComponent(selected.session_id)}`}
                  >
                    Open session
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

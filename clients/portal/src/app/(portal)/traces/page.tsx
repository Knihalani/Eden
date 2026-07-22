"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Activity } from "lucide-react";
import { useObserveUrlState } from "@/app/(portal)/_hooks/use-observe-url-state";
import { useTracesHubData } from "@/app/(portal)/_hooks/use-traces-hub-data";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ObserveMode, ObserveView } from "@/lib/observe-url";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { TracesToolbar } from "./_components/traces-toolbar";
import { TracesMasterTable } from "./_components/traces-master-table";
import { SpansMasterTable } from "./_components/spans-master-table";
import { SessionsMasterTable } from "./_components/sessions-master-table";
import { TraceDetailPanel } from "./_components/detail-panel";

function TracesPageInner() {
  const t = useTranslations("traces");
  const ts = useTranslations("sessions");
  const { state, setState, escClear } = useObserveUrlState();
  const hub = useTracesHubData(state);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const view = state.view;
  const mode: ObserveMode = state.mode ?? "transcript";
  const detailOpen = Boolean(
    state.traceId || (view === "sessions" && state.sessionId),
  );

  const listLength =
    view === "sessions"
      ? hub.sessions.length
      : view === "spans"
        ? hub.spans.length
        : hub.traces.length;

  useListKeyboardNav(
    listLength,
    focusedIndex,
    (idx) => {
      setFocusedIndex(idx);
      if (view === "sessions") {
        const row = hub.sessions[idx];
        if (row) {
          setState({
            sessionId: row.sessionId,
            traceId: undefined,
            spanId: undefined,
            mode: undefined,
          });
        }
      } else if (view === "spans") {
        const row = hub.spans[idx];
        if (row) {
          setState({
            traceId: row.traceId,
            spanId: row.spanId,
            mode: state.mode ?? "transcript",
          });
        }
      } else {
        const row = hub.traces[idx];
        if (row) {
          setState({
            traceId: row.traceId,
            spanId: undefined,
            mode: state.mode ?? "transcript",
          });
        }
      }
    },
    listLength > 0 && !detailOpen,
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isFormField) return;
      if (e.key === "/" && !detailOpen) {
        e.preventDefault();
        document
          .querySelector<HTMLInputElement>('[data-testid="traces-search"]')
          ?.focus();
      }
      if (e.key === "i" && state.traceId) {
        e.preventDefault();
        const params = new URLSearchParams();
        params.set("traceId", state.traceId);
        if (state.spanId) params.set("spanId", state.spanId);
        if (state.sessionId) params.set("sessionId", state.sessionId);
        if (state.agentId) params.set("agentId", state.agentId);
        window.location.href = `/issues?${params.toString()}`;
      }
      if (e.key === "d" && state.traceId) {
        e.preventDefault();
        window.location.href = `/debugger?traceId=${encodeURIComponent(state.traceId)}`;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detailOpen, state.traceId, state.spanId, state.sessionId, state.agentId]);

  const breadcrumbTitle = useMemo(() => {
    if (view === "sessions") {
      if (state.sessionId) {
        return `${ts("title")} / ${state.sessionId.slice(0, 8)}`;
      }
      return ts("title");
    }
    if (state.traceId) {
      return `${t("title")} / ${state.traceId.slice(0, 8)}`;
    }
    return t("title");
  }, [view, state.sessionId, state.traceId, t, ts]);

  function clearFilters() {
    setState({
      q: undefined,
      outcome: undefined,
      agentId: undefined,
      realm: undefined,
      facet: undefined,
      filter: undefined,
      pastHours: undefined,
      from: undefined,
      to: undefined,
    });
  }

  const listLoading =
    view === "sessions"
      ? hub.sessionsLoading
      : view === "spans"
        ? hub.spansLoading
        : hub.tracesLoading;
  const listError =
    view === "sessions"
      ? hub.sessionsError
      : view === "spans"
        ? hub.spansError
        : hub.tracesError;

  const listData =
    view === "sessions"
      ? hub.sessions
      : view === "spans"
        ? hub.spans
        : hub.traces;

  const masterTable = (
    <QueryState
      loading={listLoading}
      error={listError}
      data={listData}
      onRetry={hub.refetchAll}
      isEmpty={(rows) => rows.length === 0}
      filtersActive={hub.filtersActive}
      emptyKind={hub.filtersActive ? "filter-empty" : "zero-data"}
      loadingSlot={
        <div className="space-y-2" data-testid="traces-list-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      }
      emptySlot={
        <EmptyState
          icon={Activity}
          variant="panel"
          title={view === "sessions" ? ts("empty.title") : t("empty.title")}
          description={
            view === "sessions" ? ts("empty.body") : t("empty.body")
          }
          action={
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href="/agents/connect">{t("empty.connect")}</Link>
              </Button>
              <Button asChild size="sm" variant="secondary">
                <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noreferrer">
                  {t("empty.docs")}
                </a>
              </Button>
            </div>
          }
        />
      }
      filterEmptySlot={
        <EmptyState
          variant="panel"
          title={t("filterEmpty.title")}
          description={t("filterEmpty.body")}
          action={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={clearFilters}
            >
              {t("filterEmpty.clear")}
            </Button>
          }
        />
      }
    >
      {() => {
        if (view === "sessions") {
          return (
            <SessionsMasterTable
              rows={hub.sessions}
              selectedSessionId={state.sessionId}
              focusedIndex={focusedIndex}
              onFocusIndex={setFocusedIndex}
              onSelect={(sessionId) =>
                setState({
                  view: "sessions",
                  sessionId,
                  traceId: undefined,
                  spanId: undefined,
                  mode: undefined,
                })
              }
            />
          );
        }
        if (view === "spans") {
          return (
            <SpansMasterTable
              rows={hub.spans}
              selectedTraceId={state.traceId}
              selectedSpanId={state.spanId}
              focusedIndex={focusedIndex}
              onFocusIndex={setFocusedIndex}
              onSelect={(traceId, spanId) =>
                setState({
                  traceId,
                  spanId,
                  mode: state.mode ?? "transcript",
                })
              }
            />
          );
        }
        return (
          <TracesMasterTable
            rows={hub.traces}
            selectedTraceId={state.traceId}
            focusedIndex={focusedIndex}
            onFocusIndex={setFocusedIndex}
            onSelect={(traceId) =>
              setState({
                traceId,
                spanId: undefined,
                mode: state.mode ?? "transcript",
              })
            }
          />
        );
      }}
    </QueryState>
  );

  return (
    <div data-testid="traces-page">
      <ResourcePageShell
        header={
          <PageHeader
            title={breadcrumbTitle}
            subtitle={view === "sessions" ? ts("subtitle") : t("subtitle")}
          />
        }
        toolbar={
          <TracesToolbar
            view={view}
            q={state.q ?? ""}
            outcome={state.outcome}
            pastHours={state.pastHours ?? "24"}
            live={state.live === "1"}
            liveConnected={hub.liveConnected}
            liveFailed={hub.liveFailed}
            onViewChange={(next: ObserveView) =>
              setState({
                view: next,
                traceId: undefined,
                spanId: undefined,
                sessionId: next === "sessions" ? state.sessionId : undefined,
                mode: undefined,
              })
            }
            onSearchChange={(q) => setState({ q: q || undefined })}
            onOutcomeChange={(outcome) => setState({ outcome })}
            onPastHoursChange={(hours) =>
              setState({ pastHours: hours === "24" ? undefined : hours })
            }
            onLiveChange={(live) => setState({ live: live ? "1" : "0" })}
          />
        }
        table={masterTable}
        detail={
          detailOpen ? (
            <TraceDetailPanel
              open={detailOpen}
              onClose={escClear}
              sessionId={state.sessionId}
              traceId={state.traceId}
              spanId={state.spanId}
              mode={mode}
              pastHours={hub.pastHours}
              agentId={state.agentId}
              onModeChange={(next) => setState({ mode: next })}
              onSpanSelect={(spanId) => setState({ spanId })}
              onSelectTurn={(traceId) =>
                setState({
                  traceId,
                  mode: "transcript",
                  sessionId: state.sessionId,
                })
              }
              onOpenTranscript={(traceId) =>
                setState({
                  traceId,
                  mode: "transcript",
                  sessionId: state.sessionId,
                })
              }
            />
          ) : undefined
        }
      />
    </div>
  );
}

export default function TracesPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4 p-4" data-testid="traces-page-fallback">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <TracesPageInner />
    </Suspense>
  );
}

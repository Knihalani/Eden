"use client";

import Link from "next/link";
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, Plus, ChevronLeft, SearchX, X } from "lucide-react";
import {
  agentForSignal,
  issuesForSignal,
  tracesForSignal,
  type SignalFixture,
  type SignalKind,
  type SignalSeverity,
} from "@/lab/fixtures/signals";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  AgentLink,
  AgentScopeFilter,
  EmptyState,
  FilterChips,
  SearchInput,
  severityLabel,
} from "@/lab/lab-ui";
import { formatAbsoluteTime, formatSmartTime } from "@/lib/format";
import { compileNaturalLanguageFallback } from "@/lab/signal-compile";
import { cn } from "@/lib/utils";
import { measureVirtualRow, VIRTUAL_SCROLL_ATTR } from "@/lab/virtual-list";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { signalsApi } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import {
  InlineLoading,
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import { useLabToast } from "@/lab/lab-toast";
import { AutomationsView, SignalsModeToggle } from "./automations-panel";
import { NlAlertRulesView } from "./nl-alert-rules-panel";

type KindFilter = "all" | SignalKind;
type StateFilter = "all" | "on" | "off";

/** Row estimate for detector list density; corrected by `measureElement`. */
const SIGNAL_ROW_ESTIMATE = 88;

function severityTone(severity: SignalSeverity): "fail" | "neutral" {
  if (severity === "critical" || severity === "error" || severity === "warn") {
    return "fail";
  }
  return "neutral";
}

const SignalRow = memo(function SignalRow({
  signal,
  active,
  onSelect,
}: {
  signal: SignalFixture;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const agent = agentForSignal(signal);
  const handleClick = useCallback(() => onSelect(signal.id), [onSelect, signal.id]);
  return (
    <button
      type="button"
      onClick={handleClick}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex w-full items-start gap-3 border-b border-[var(--line)] px-4 py-3 text-left transition-colors sm:px-5",
        active
          ? "bg-[var(--accent-muted)] shadow-[inset_2px_0_0_var(--accent)]"
          : "hover:bg-[var(--accent-muted)]",
        !signal.enabled && "opacity-55",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={severityTone(signal.severity)}>{severityLabel(signal.severity)}</StatusChip>
          <StatusChip tone={signal.enabled ? "live" : "neutral"}>
            {signal.enabled ? "on" : "off"}
          </StatusChip>
          <span className="type-meta capitalize">{signal.kind}</span>
        </div>
        <p className="type-ui truncate text-[var(--text)]">{signal.name}</p>
        <p className="type-meta truncate">
          {agent?.name ?? "All agents"}
          {" · "}
          {signal.hits24h} hits / 24h
        </p>
      </div>
    </button>
  );
});

function SignalDetail({
  signal,
  onClose,
  onToggleEnabled,
  toggleBusy,
}: {
  signal: SignalFixture;
  onClose: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  toggleBusy?: boolean;
}) {
  const agent = agentForSignal(signal);
  const issues = issuesForSignal(signal);
  const traces = tracesForSignal(signal);
  const watching =
    compileNaturalLanguageFallback(signal.description).watching ||
    signal.description;

  return (
    <aside
      className="flex h-full min-h-0 w-full min-w-0 flex-col border-[var(--line)] bg-[var(--bg)] lg:w-[min(28rem,42vw)] lg:border-l"
      aria-label="Detector detail"
    >
      <header className="shrink-0 border-b border-[var(--line)] px-6 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-icon lg:hidden"
                onClick={onClose}
                aria-label="Back to detectors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <StatusChip tone={severityTone(signal.severity)}>{severityLabel(signal.severity)}</StatusChip>
              <StatusChip tone={signal.enabled ? "live" : "neutral"}>
                {signal.enabled ? "on" : "off"}
              </StatusChip>
            </div>
            <h2 className="type-title text-[var(--text)] !text-[1.2rem] !leading-snug">
              {signal.name}
            </h2>
            <p className="type-meta">
              {agent ? (
                <AgentLink agentId={agent.id} name={agent.name} />
              ) : (
                "All agents"
              )}
              <span className="text-[var(--text-faint)]"> · </span>
              <span className="capitalize">{signal.kind}</span>
            </p>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon hidden shrink-0 lg:inline-flex"
            onClick={onClose}
            aria-label="Close detector detail"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4">
          <button
            type="button"
            className={cn(
              "ds-btn ds-btn-sm",
              signal.enabled ? "ds-btn-ghost" : "ds-btn-primary",
            )}
            disabled={toggleBusy}
            onClick={() => onToggleEnabled(!signal.enabled)}
          >
            {signal.enabled ? "Off" : "On"}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-6">
        <section className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--accent-muted)] px-4 py-4">
          <h3 className="type-label">Watching</h3>
          <p className="type-ui text-[var(--text)]">{watching}</p>
        </section>
        {(issues[0] || traces[0]) ? (
          <section className="space-y-3">
            <h3 className="type-label">Related</h3>
            <div className="flex flex-wrap gap-2">
              {issues[0] ? (
                <Link
                  href={`/issues?id=${issues[0].id}&agent=${issues[0].agentId}`}
                  className="ds-btn ds-btn-primary ds-btn-sm"
                >
                  Issue
                </Link>
              ) : null}
              {traces[0] ? (
                <Link
                  href={`/traces?id=${traces[0].id}&tab=signals${signal.agentId ? `&agent=${signal.agentId}` : ""}`}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Run
                </Link>
              ) : null}
            </div>
          </section>
        ) : null}
        <dl className="grid grid-cols-2 gap-4 border-t border-[var(--line)] pt-4">
          <div>
            <p className="type-label">Hits</p>
            <p className="type-mono mt-1 !text-[var(--text)]">{signal.hits24h}</p>
          </div>
          <div>
            <p className="type-label">Last hit</p>
            <p
              className="type-mono mt-1 !text-[var(--text)]"
              title={formatAbsoluteTime(signal.lastHit)}
            >
              {formatSmartTime(signal.lastHit)}
            </p>
          </div>
        </dl>
      </div>
    </aside>
  );
}

function LabSignalsInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id");
  const modeParam = searchParams.get("mode");
  const mode =
    modeParam === "automations" || modeParam === "nl-alerts" ? modeParam : "detectors";
  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const signalsQuery = useOrgQuery(
    queryKeys.portal.signals(orgId),
    orgId,
    () => portalApi.signals(orgId!),
    SHELL_QUERY,
  );
  const catalog = signalsQuery.data ?? [];

  const [kind, setKind] = useState<KindFilter>("all");
  const [state, setState] = useState<StateFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(paramId);
  const [toggleBusyId, setToggleBusyId] = useState<string | null>(null);
  const createParam = searchParams.get("create");
  const promptParam = searchParams.get("prompt");
  const listScrollRef = useRef<HTMLDivElement | null>(null);

  const openAlertRuleAuthoring = useCallback(
    (prompt?: string | null) => {
      patchQuery({
        mode: "nl-alerts",
        create: "1",
        prompt: prompt?.trim() ? prompt.trim() : null,
        id: null,
        review: null,
      });
    },
    [patchQuery],
  );

  const invalidateSignals = useCallback(async () => {
    if (!orgId) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.portal.signals(orgId),
    });
  }, [orgId, queryClient]);

  useEffect(() => {
    setSelectedId(paramId);
  }, [paramId]);

  useEffect(() => {
    if (createParam !== "1" && !promptParam) return;
    openAlertRuleAuthoring(promptParam);
    patchQuery({ create: null, prompt: null });
  }, [createParam, promptParam, openAlertRuleAuthoring, patchQuery]);

  const enabledCount = catalog.filter((s) => s.enabled).length;
  const hits24h = catalog.reduce((sum, s) => sum + s.hits24h, 0);

  const agentCounts = useMemo(() => {
    const counts: Record<string, number> = { all: catalog.length };
    for (const s of catalog) {
      if (!s.agentId) continue;
      counts[s.agentId] = (counts[s.agentId] ?? 0) + 1;
    }
    return counts;
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((s) => {
      if (agentId !== "all" && s.agentId !== null && s.agentId !== agentId) {
        return false;
      }
      if (kind !== "all" && s.kind !== kind) return false;
      if (state === "on" && !s.enabled) return false;
      if (state === "off" && s.enabled) return false;
      if (!q) return true;
      const agent = agentForSignal(s);
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (agent?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [catalog, agentId, kind, state, query]);

  const listVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => SIGNAL_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index) => filtered[index]?.id ?? index,
    measureElement: measureVirtualRow,
  });

  const selected = selectedId
    ? (filtered.find((s) => s.id === selectedId) ??
      catalog.find((s) => s.id === selectedId) ??
      null)
    : null;

  const selectSignalStable = useCallback(
    (id: string) => {
      setSelectedId(id);
      patchQuery({ id });
    },
    [patchQuery],
  );

  function clearSelection() {
    setSelectedId(null);
    patchQuery({ id: null });
  }

  const handleToggleEnabled = useCallback(
    async (signal: SignalFixture, enabled: boolean) => {
      if (!orgId) return;
      setToggleBusyId(signal.id);
      try {
        if (signal.templateId) {
          await signalsApi.toggleLibrary(orgId, signal.templateId, enabled);
        } else {
          await signalsApi.toggle(orgId, signal.id, enabled);
        }
        await invalidateSignals();
      } catch (err) {
        pushToast({
          title: enabled ? "Couldn't enable detector" : "Couldn't disable detector",
          body: err instanceof Error ? err.message : "Try again",
          tone: "fail",
        });
      } finally {
        setToggleBusyId(null);
      }
    },
    [orgId, invalidateSignals, pushToast],
  );

  // F61: Automations share this surface via `?mode=automations` (no new
  // nav leaf). Branch after all hooks above have run so hook order is
  // stable; AutomationsView owns its own data + guards.
  if (mode === "automations") {
    return <AutomationsView />;
  }
  if (mode === "nl-alerts") {
    return <NlAlertRulesView />;
  }

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Detectors"
        message="Select a workspace to view detectors."
      />
    );
  }

  if (signalsQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Detectors" />
        <QueryLoadingPanel label="Loading detectors…" />
      </div>
    );
  }

  if (signalsQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Detectors" />
        <QueryErrorPanel
          error={signalsQuery.error}
          onRetry={() => void signalsQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Detectors"
        meta={
          <span className="type-meta">
            {enabledCount} on · {catalog.length} total · {hits24h} hits / 24h
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SignalsModeToggle mode="detectors" />
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              onClick={() => openAlertRuleAuthoring()}
            >
              <Plus className="h-3.5 w-3.5" />
              Create alert rule
            </button>
          </div>
        }
      />

      <p className="type-meta border-b border-[var(--line)] px-5 py-2.5 text-[var(--text-faint)] sm:px-7">
        Detectors surface live firings from your catalog. To author a monitored
        rule with email delivery, use{" "}
        <button
          type="button"
          className="text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={() => openAlertRuleAuthoring()}
        >
          Alert rules
        </button>
        .
      </p>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            selected ? "hidden lg:flex" : "flex",
          )}
        >
          <div className="lab-list-chrome shrink-0 border-b border-[var(--line)] sm:!flex-row sm:flex-wrap sm:items-end">
            <div className="min-w-[11rem] flex-1 sm:max-w-[14rem]">
              <AgentScopeFilter
                value={agentId}
                onChange={setAgentId}
                counts={agentCounts}
              />
            </div>
            <div className="min-w-0 flex-[1.4] space-y-2">
              <p className="type-label">Search</p>
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="Search detectors, agents…"
                ariaLabel="Search detectors"
              />
            </div>
            <div className="space-y-2">
              <p className="type-label">Kind</p>
              <FilterChips
                value={kind}
                onChange={setKind}
                scroll
                options={[
                  { id: "all", label: "All" },
                  { id: "error", label: "Error" },
                  { id: "latency", label: "Latency" },
                  { id: "cost", label: "Cost" },
                  { id: "policy", label: "Policy" },
                  { id: "custom", label: "Custom" },
                ]}
              />
            </div>
            <div className="space-y-2">
              <p className="type-label">State</p>
              <FilterChips
                value={state}
                onChange={setState}
                options={[
                  { id: "all", label: "Any" },
                  { id: "on", label: "On" },
                  { id: "off", label: "Off" },
                ]}
              />
            </div>
          </div>

          <div
            ref={listScrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            {...{ [VIRTUAL_SCROLL_ATTR]: "detectors-list" }}
          >
            {filtered.length === 0 ? (
              <EmptyState
                icon={
                  catalog.length === 0 && !query
                    ? Activity
                    : SearchX
                }
                title={
                  catalog.length === 0
                    ? "No detectors yet"
                    : "No matching detectors"
                }
                body={
                  catalog.length === 0
                    ? U20_EMPTY_COPY.signals
                    : U20_FILTER_EMPTY_COPY.signals
                }
                action={
                  catalog.length === 0 ? (
                    <button
                      type="button"
                      className="ds-btn ds-btn-primary ds-btn-sm"
                      onClick={() => openAlertRuleAuthoring()}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create alert rule
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <ul
                role="list"
                aria-label="Detectors"
                className="relative pb-2"
                style={{ height: `${listVirtualizer.getTotalSize()}px` }}
              >
                {listVirtualizer.getVirtualItems().map((item) => {
                  const signal = filtered[item.index];
                  if (!signal) return null;
                  return (
                    <li
                      key={item.key}
                      ref={listVirtualizer.measureElement}
                      data-index={item.index}
                      className="absolute top-0 left-0 w-full min-w-0"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <SignalRow
                        signal={signal}
                        active={signal.id === selected?.id}
                        onSelect={selectSignalStable}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {selected ? (
          <SignalDetail
            signal={selected}
            onClose={clearSelection}
            toggleBusy={toggleBusyId === selected.id}
            onToggleEnabled={(enabled) => {
              void handleToggleEnabled(selected, enabled);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function LabSignalsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Detectors" meta={<InlineLoading label="Loading detectors" />} />
        </div>
      }
    >
      <LabSignalsInner />
    </Suspense>
  );
}

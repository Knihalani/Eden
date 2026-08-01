"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Bell, X } from "lucide-react";
import {
  agentForAlert,
  issueForAlert,
  traceForAlert,
  type AlertEvent,
  type AlertEventStatus,
  type AlertRule,
  type AlertSeverity,
} from "@/lab/fixtures/alerts";
import { StatusChip } from "@/components/ds/primitives";
import { useAlerts } from "@/lab/alerts-context";
import { AgentLink, EmptyState, FilterChips, SeverityBadge } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";

type InboxFilter = "actionable" | "firing" | "muted" | "resolved" | "all";

const CLOSE_MS = 220;

function severityTone(severity: AlertSeverity): "fail" | "neutral" {
  if (severity === "critical" || severity === "error" || severity === "warn") {
    return "fail";
  }
  return "neutral";
}

function statusTone(status: AlertEventStatus): "fail" | "neutral" | "ok" {
  if (status === "firing") return "fail";
  if (status === "muted") return "neutral";
  return "ok";
}

function EventRow({
  event,
  active,
  unread,
  onSelect,
}: {
  event: AlertEvent;
  active: boolean;
  unread: boolean;
  onSelect: () => void;
}) {
  const agent = agentForAlert(event);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={active ? "true" : "false"}
      data-unread={unread ? "true" : "false"}
      className={cn(
        "relative w-full border-b border-[var(--line)] px-5 py-4 pr-8 text-left transition-colors last:border-b-0",
        active ? "bg-[var(--accent-muted)]" : "hover:bg-[var(--accent-muted)]",
      )}
    >
      {unread ? (
        <span
          className="absolute right-3 top-3 h-2 w-2 rounded-full bg-[var(--accent)]"
          aria-label="Unread"
          title="Unread"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={severityTone(event.severity)}>{event.severity}</StatusChip>
        <StatusChip tone={statusTone(event.status)}>{event.status}</StatusChip>
        <span className="type-meta ml-auto">{event.firedAt}</span>
      </div>
      <p className="type-ui mt-2 text-[var(--text)]">{event.title}</p>
      <p className="type-meta mt-1">{agent?.name ?? "unknown"}</p>
      <p className="type-body line-clamp-2">{event.body}</p>
    </button>
  );
}

function EventDetail({
  event,
  rule,
  onStatus,
  onCloseModal,
}: {
  event: AlertEvent;
  rule?: AlertRule;
  onStatus: (status: AlertEventStatus) => void;
  onCloseModal: () => void;
}) {
  const agent = agentForAlert(event);
  const issue = issueForAlert(event);
  const trace = traceForAlert(event);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[var(--line)] px-6 py-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={severityTone(event.severity)}>{event.severity}</StatusChip>
              <StatusChip tone={statusTone(event.status)}>{event.status}</StatusChip>
            </div>
            <h2 className="type-title text-[var(--text)] !text-[1.25rem]">
              {event.title}
            </h2>
            <p className="type-body text-[var(--text-secondary)]">{event.body}</p>
            <p className="type-meta">
              <AgentLink agentId={agent?.id} name={agent?.name ?? "unknown"} />
              <span className="text-[var(--text-faint)]"> · </span>
              {event.firedAt}
              {rule ? (
                <>
                  <span className="text-[var(--text-faint)]"> · </span>
                  {rule.name}
                </>
              ) : null}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {event.status === "firing" ? (
            <>
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                title="Local draft only — not saved to the server"
                onClick={() => onStatus("resolved")}
              >
                Resolve (draft)
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                disabled
                title="Not available yet"
              >
                Mute
              </button>
            </>
          ) : null}
          {event.status === "muted" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled
              title="Not available yet"
            >
              Unmute
            </button>
          ) : null}
          {event.status === "resolved" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              title="Local draft only — not saved to the server"
              onClick={() => onStatus("firing")}
            >
              Reopen (draft)
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-6">
        <section className="space-y-3">
          <ul className="space-y-2">
            {issue ? (
              <li>
                <Link
                  href={`/issues?id=${issue.id}`}
                  onClick={onCloseModal}
                  className="flex items-start justify-between gap-3 rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <div>
                    <p className="type-label">Issue</p>
                    <p className="type-ui mt-1 text-[var(--text)]">{issue.title}</p>
                    <p className="type-meta mt-1">{issue.summary}</p>
                  </div>
                  <SeverityBadge severity={issue.severity} />
                </Link>
              </li>
            ) : null}
            {trace ? (
              <li>
                <Link
                  href={`/traces?id=${trace.id}&tab=signals`}
                  onClick={onCloseModal}
                  className="flex items-start justify-between gap-3 rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <div>
                    <p className="type-label">Run</p>
                    <p className="type-ui mt-1 text-[var(--text)]">{trace.name}</p>
                    <p className="type-meta mt-1">{trace.id}</p>
                  </div>
                  <SeverityBadge severity={trace.severity} />
                </Link>
              </li>
            ) : null}
            <li>
              <Link
                href={
                  rule?.signalId
                    ? `/signals?id=${rule.signalId}`
                    : "/signals"
                }
                onClick={onCloseModal}
                className="block rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
              >
                <p className="type-label">Detector</p>
                <p className="type-ui mt-1 text-[var(--text)]">
                  {rule?.name ?? "Detectors"}
                </p>
              </Link>
            </li>
            {agent ? (
              <li>
                <Link
                  href={`/agents?id=${agent.id}`}
                  onClick={onCloseModal}
                  className="block rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <p className="type-label">Agent</p>
                  <p className="type-ui mt-1 text-[var(--text)]">{agent.name}</p>
                </Link>
              </li>
            ) : null}
          </ul>
        </section>

        {rule ? (
          <section className="space-y-3">
            <h3 className="type-ui text-[var(--text)]">Rule</h3>
            <div>
              <p className="type-label">Condition</p>
              <p className="type-mono mt-1.5 !text-[0.75rem] !text-[var(--text)]">
                {rule.condition}
              </p>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function AlertsModal() {
  const {
    open,
    closeAlerts,
    unreadCount,
    isUnread,
    markRead,
    markAllRead,
  } = useAlerts();

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const rulesQuery = useOrgQuery(
    queryKeys.portal.alertRules(orgId),
    orgId,
    () => portalApi.alertRules(orgId!),
    { enabled: open },
  );
  const eventsQuery = useOrgQuery(
    queryKeys.portal.alertEvents(orgId),
    orgId,
    () => portalApi.alertEvents(orgId!),
    { enabled: open },
  );
  const liveRules = rulesQuery.data ?? [];
  const liveEvents = eventsQuery.data ?? [];

  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("actionable");
  const [statusOverride, setStatusOverride] = useState<
    Record<string, AlertEventStatus>
  >({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  const events = useMemo(
    () =>
      liveEvents.map((e) => ({
        ...e,
        status: statusOverride[e.id] ?? e.status,
      })),
    [liveEvents, statusOverride],
  );

  const rules = liveRules;

  const counts = useMemo(() => {
    const firing = events.filter((e) => e.status === "firing").length;
    const muted = events.filter((e) => e.status === "muted").length;
    const resolved = events.filter((e) => e.status === "resolved").length;
    return {
      actionable: firing + muted,
      firing,
      muted,
      resolved,
      all: events.length,
    };
  }, [events]);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (inboxFilter === "actionable") {
        return e.status === "firing" || e.status === "muted";
      }
      if (inboxFilter === "firing") return e.status === "firing";
      if (inboxFilter === "muted") return e.status === "muted";
      if (inboxFilter === "resolved") return e.status === "resolved";
      return true;
    });
  }, [events, inboxFilter]);

  const selected = selectedId
    ? (filtered.find((e) => e.id === selectedId) ??
      events.find((e) => e.id === selectedId) ??
      null)
    : null;

  const selectedRule = selected
    ? rules.find((r) => r.id === selected.ruleId)
    : undefined;

  function selectEvent(id: string) {
    setSelectedId(id);
    markRead(id);
  }

  function setEventStatus(id: string, status: AlertEventStatus) {
    setStatusOverride((prev) => ({ ...prev, [id]: status }));
    markRead(id);
  }

  if (!mounted) return null;

  return (
    <div
      className="lab-alerts-modal fixed inset-0 z-[70] flex flex-col bg-[var(--bg)] text-[var(--text)]"
      data-state={visible ? "open" : "closed"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="alerts-modal-title"
      aria-hidden={!visible}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--line)] px-5 py-4 sm:px-7">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-[var(--accent-muted)] text-[var(--accent)]">
            <Bell className="h-4 w-4" strokeWidth={1.7} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 id="alerts-modal-title" className="type-title text-[var(--text)]">
              Inbox
            </h1>
            <p className="type-meta mt-0.5">
              {unreadCount > 0
                ? `${unreadCount} unread · ${counts.firing} firing`
                : `${counts.firing} firing`}
              {" · "}
              Resolve here stays local until inbox sync is available
            </p>
          </div>
        </div>

        {unreadCount > 0 ? (
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={markAllRead}
          >
            Mark all read
          </button>
        ) : null}

        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={closeAlerts}
          aria-label="Close Inbox"
        >
          <X className="h-4 w-4" />
          <span className="hidden sm:inline">Close</span>
          <kbd className="type-mono ml-1 hidden rounded border border-[var(--line)] px-1 !text-[0.625rem] !text-[var(--text-faint)] sm:inline">
            esc
          </kbd>
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-full max-w-md shrink-0 flex-col border-r border-[var(--line)] bg-[var(--bg-inset)] sm:max-w-sm lg:max-w-md">
          <div className="shrink-0 space-y-3 border-b border-[var(--line)] px-4 py-4">
            <FilterChips
              value={inboxFilter}
              onChange={setInboxFilter}
              scroll
              options={[
                { id: "actionable", label: "Open", count: counts.actionable },
                { id: "firing", label: "Firing", count: counts.firing },
                { id: "muted", label: "Muted", count: counts.muted },
                { id: "resolved", label: "Resolved", count: counts.resolved },
                { id: "all", label: "All", count: counts.all },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {eventsQuery.isLoading ? (
              <QueryLoadingPanel label="Loading Inbox…" />
            ) : eventsQuery.isError ? (
              <QueryErrorPanel
                error={eventsQuery.error}
                onRetry={() => void eventsQuery.refetch()}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title={
                  events.length === 0
                    ? "Inbox empty"
                    : inboxFilter === "actionable"
                      ? "Inbox clear"
                      : "No matching events"
                }
                body={
                  events.length === 0
                    ? U20_EMPTY_COPY.alerts
                    : inboxFilter === "actionable"
                      ? U20_EMPTY_COPY.alertsClear
                      : U20_FILTER_EMPTY_COPY.alerts
                }
              />
            ) : (
              filtered.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  unread={isUnread(event.id)}
                  active={event.id === selected?.id}
                  onSelect={() => selectEvent(event.id)}
                />
              ))
            )}
          </div>
        </aside>

        {filtered.length === 0 ? null : (
          <div className="min-h-0 min-w-0 flex-1 bg-[var(--bg)]">
            {selected ? (
              <EventDetail
                event={selected}
                rule={selectedRule}
                onCloseModal={closeAlerts}
                onStatus={(status) => setEventStatus(selected.id, status)}
              />
            ) : (
              <EmptyState
                title="Select an event"
                body="Pick a row to see detector context and take action."
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

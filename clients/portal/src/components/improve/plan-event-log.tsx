"use client";

/**
 * Improve plan detail — append-only event log (FEAT-30 gap 3).
 *
 * Wired to ``GET /orgs/{org}/improve/plans/{id}/events`` (backend
 * ``eden.improvement.plans_repo.list_events`` /
 * ``improvement_plan_events``, migration 151). Local draft plans
 * (deep-link synthesized, no server record) skip the fetch — there is
 * nothing server-side to have emitted events yet.
 */

import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey } from "@/lib/query-keys";
import { improvePlansApi, type ImprovementPlanEvent } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { formatRelativeTime } from "@/lib/format";

const EVENT_LABELS: Record<string, string> = {
  created: "Plan created",
  approved: "Approved",
  rejected: "Rejected",
  snoozed: "Snoozed",
  pr_opened: "PR opened",
  merged: "Merged",
  closed: "Closed",
};

const EVENT_TONE: Record<string, "ok" | "fail" | "neutral"> = {
  created: "neutral",
  approved: "ok",
  rejected: "fail",
  snoozed: "neutral",
  pr_opened: "ok",
  merged: "ok",
  closed: "fail",
};

function eventDetail(e: ImprovementPlanEvent): string | null {
  const parts = [
    e.actor ? `by ${e.actor}` : null,
    e.detail || null,
  ];
  const payload = e.payload ?? {};
  if (typeof payload.pr_number === "number") {
    parts.push(`PR #${payload.pr_number}`);
  }
  if (typeof payload.snoozed_until === "string") {
    parts.push(`until ${payload.snoozed_until}`);
  }
  return parts.filter(Boolean).join(" — ") || null;
}

export function PlanEventLog({
  orgId,
  planId,
  isDraft,
}: {
  orgId: string | null;
  planId: string;
  isDraft: boolean;
}) {
  const eventsQuery = useOrgQuery(
    queryKey("improvePlanEvents", orgId, planId),
    orgId,
    () => improvePlansApi.getEvents(orgId!, planId),
    {
      ...SHELL_QUERY,
      enabled: Boolean(orgId) && !isDraft,
    },
  );
  const events = isDraft ? [] : (eventsQuery.data?.data?.events ?? []);

  return (
    <section
      aria-label="Plan event log"
      className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-5"
    >
      <h3 className="type-ui">Event log</h3>
      <p className="type-meta mt-0.5">
        Append-only trail of lifecycle transitions recorded server-side.
      </p>
      {isDraft ? (
        <p className="type-meta mt-2">
          Unavailable for local draft plans — nothing server-side has
          recorded a transition yet.
        </p>
      ) : eventsQuery.isLoading ? (
        <p className="type-meta mt-2">Loading…</p>
      ) : events.length === 0 ? (
        <p className="type-meta mt-2">
          No events recorded yet — either this plan predates the event log
          or nothing has transitioned it since.
        </p>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {events.map((e) => {
            const label = EVENT_LABELS[e.event_type] ?? e.event_type;
            const tone = EVENT_TONE[e.event_type] ?? "neutral";
            const detail = eventDetail(e);
            return (
              <li
                key={e.id}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <span
                  className={
                    tone === "ok"
                      ? "type-ui text-[var(--success)]"
                      : tone === "fail"
                        ? "type-ui text-[var(--error)]"
                        : "type-ui text-[var(--text)]"
                  }
                >
                  {label}
                </span>
                <span className="type-meta">
                  {formatRelativeTime(e.created_at)}
                </span>
                {detail ? <span className="type-meta">{detail}</span> : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

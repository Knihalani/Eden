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
  // Wave 5 (5.3) — the post-merge watch + N01 replay verify legs of the
  // trustworthy loop trail (emitted by PostMergeMonitor + approve flow).
  verify_queued: "Replay verify queued",
  post_merge_ok: "Post-merge watch: ok",
  post_merge_degrading: "Post-merge watch: degrading",
};

const EVENT_TONE: Record<string, "ok" | "fail" | "neutral"> = {
  created: "neutral",
  approved: "ok",
  rejected: "fail",
  snoozed: "neutral",
  pr_opened: "ok",
  merged: "ok",
  closed: "fail",
  verify_queued: "neutral",
  post_merge_ok: "ok",
  post_merge_degrading: "fail",
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
  if (typeof payload.verification_id === "string") {
    parts.push(`verify ${payload.verification_id.slice(0, 8)}`);
  }
  if (typeof payload.delta_pct === "number") {
    const pre = payload.pre_issue_rate as number | undefined;
    const post = payload.post_issue_rate as number | undefined;
    const rates =
      typeof pre === "number" && typeof post === "number"
        ? ` ${post.toFixed(3)}/h vs ${pre.toFixed(3)}/h baseline`
        : "";
    parts.push(`${payload.delta_pct >= 0 ? "+" : ""}${payload.delta_pct.toFixed(1)}%${rates}`);
  }
  if (typeof payload.follow_up_plan_id === "string") {
    parts.push(`follow-up filed`);
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
        <div
          className="mt-2 space-y-1.5"
          role="status"
          aria-label="Loading event log"
        >
          <div className="eden-skeleton-pulse h-3.5 w-2/5 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse h-3.5 w-1/3 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse h-3.5 w-1/2 rounded bg-[var(--line)]" />
        </div>
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

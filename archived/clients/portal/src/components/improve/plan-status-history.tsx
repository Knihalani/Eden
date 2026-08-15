"use client";

/**
 * Improve plan detail — status history.
 *
 * Renders a summary timeline derived from the plan record's lifecycle
 * fields: created → updated → approved / rejected / snoozed → PR opened.
 * See ``PlanEventLog`` (``plan-event-log.tsx``) for the real append-only
 * event trail (``GET .../plans/{id}/events``, migration 151) — this
 * derived view stays useful as a fallback for plans that predate that
 * table and for local (unsaved) drafts.
 */

import type { ImprovementPlan } from "@/lib/api/resources";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import { formatRelativeTime } from "@/lib/format";

type HistoryEvent = {
  key: string;
  label: string;
  at: string | null;
  detail?: string | null;
  tone?: "ok" | "fail" | "neutral";
};

export function derivePlanHistory(
  plan: ImprovePlanFixture,
  raw: ImprovementPlan | null,
): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const createdAt = raw?.created_at ?? plan.createdAt ?? null;
  const updatedAt = raw?.updated_at ?? plan.updatedAt ?? null;

  if (createdAt) {
    events.push({ key: "created", label: "Plan created", at: createdAt });
  }
  if (raw?.approved_at) {
    events.push({
      key: "approved",
      label: "Approved",
      at: raw.approved_at,
      detail: raw.approved_by ? `by ${raw.approved_by}` : null,
      tone: "ok",
    });
  }
  if (raw?.rejected_at) {
    events.push({
      key: "rejected",
      label: "Rejected",
      at: raw.rejected_at,
      detail:
        [
          raw.rejected_by ? `by ${raw.rejected_by}` : null,
          raw.rejection_reason || null,
        ]
          .filter(Boolean)
          .join(" — ") || null,
      tone: "fail",
    });
  }
  if (raw?.snoozed_until) {
    events.push({
      key: "snoozed",
      label: "Snoozed",
      at: null,
      detail: `until ${raw.snoozed_until}`,
    });
  }
  if (raw?.pr_url) {
    events.push({
      key: "pr",
      label: raw.pr_number ? `PR #${raw.pr_number} opened` : "PR opened",
      at: null,
      detail: raw.pr_url,
      tone: "ok",
    });
  }
  if (raw?.status === "merged") {
    events.push({
      key: "merged",
      label: "PR merged",
      at: raw.updated_at ?? null,
      tone: "ok",
    });
  }
  if (updatedAt && updatedAt !== createdAt) {
    events.push({ key: "updated", label: "Last updated", at: updatedAt });
  }
  events.push({
    key: "status",
    label: `Current status: ${raw?.status ?? plan.status}`,
    at: null,
  });
  return events;
}

export function PlanStatusHistory({
  plan,
  raw,
}: {
  plan: ImprovePlanFixture;
  raw: ImprovementPlan | null;
}) {
  const events = derivePlanHistory(plan, raw);

  return (
    <section
      aria-label="Plan status history"
      className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-5"
    >
      <h3 className="type-ui">Status history</h3>
      <p className="type-meta mt-0.5">
        Derived from plan fields — see the event log below for the
        append-only trail.
      </p>
      <ol className="mt-2 space-y-1.5">
        {events.map((e) => (
          <li key={e.key} className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={
                e.tone === "ok"
                  ? "type-ui text-[var(--success)]"
                  : e.tone === "fail"
                    ? "type-ui text-[var(--error)]"
                    : "type-ui text-[var(--text)]"
              }
            >
              {e.label}
            </span>
            {e.at ? (
              <span className="type-meta">{formatRelativeTime(e.at)}</span>
            ) : null}
            {e.detail ? <span className="type-meta">{e.detail}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

"use client";

/**
 * Wave 4 (4.3) — post-merge watch status for a merged plan.
 *
 * Renders the 1h/24h/7d ``post_merge_windows`` rows: each window shows
 * pending / ok / degrading with the issue-rate delta, and a degrading
 * window links to its advisory follow-up plan. Empty (no windows yet)
 * renders nothing — plans that predate the watch or never merged simply
 * don't show the block.
 */

import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey } from "@/lib/query-keys";
import { improvePlansApi, type PostMergeWindow } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import Link from "next/link";
import { cn } from "@/lib/utils";

function windowLabel(hours: number): string {
  if (hours >= 168) return "7d";
  if (hours >= 24) return "24h";
  return "1h";
}

function WindowRow({ w }: { w: PostMergeWindow }) {
  const delta =
    typeof w.delta_pct === "number"
      ? `${w.delta_pct >= 0 ? "+" : ""}${w.delta_pct.toFixed(1)}%`
      : null;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="type-ui text-[var(--text)]">
        {windowLabel(w.window_hours)} window
      </span>
      {w.status === "pending" ? (
        <span className="type-meta text-[var(--text-faint)]">watching…</span>
      ) : w.status === "degrading" ? (
        <span className="type-ui text-[var(--error)]">degrading</span>
      ) : (
        <span className="type-ui text-[var(--success)]">ok</span>
      )}
      {delta ? <span className="type-meta">{delta}</span> : null}
      {w.status === "pending" ? (
        <span className="type-meta text-[var(--text-faint)]">
          closes{" "}
          {new Date(w.closes_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
          })}
        </span>
      ) : null}
      {w.follow_up_plan_id ? (
        <Link
          href={`/improve?plan=${w.follow_up_plan_id}`}
          className="type-meta underline"
        >
          follow-up filed
        </Link>
      ) : null}
    </li>
  );
}

export function PlanPostMergeWatch({
  orgId,
  planId,
  isDraft,
}: {
  orgId: string | null;
  planId: string;
  isDraft: boolean;
}) {
  const windowsQuery = useOrgQuery(
    queryKey("improvePlanPostMergeWindows", orgId, planId),
    orgId,
    () => improvePlansApi.getPostMergeWindows(orgId!, planId),
    {
      ...SHELL_QUERY,
      enabled: Boolean(orgId) && !isDraft,
    },
  );
  const windows = isDraft
    ? []
    : (windowsQuery.data?.data?.windows ?? []);

  if (isDraft || windows.length === 0) return null;

  return (
    <section
      aria-label="Post-merge watch"
      className={cn(
        "border border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-5",
        windows.some((w) => w.status === "degrading") &&
          "border-[var(--error)]/40",
      )}
    >
      <h3 className="type-ui">Post-merge watch</h3>
      <p className="type-meta mt-0.5">
        Eden compares this agent&apos;s issue rate before vs after the merge;
        a material regression files a follow-up.
      </p>
      <ol className="mt-2 space-y-1">
        {windows.map((w) => (
          <WindowRow key={w.id} w={w} />
        ))}
      </ol>
    </section>
  );
}

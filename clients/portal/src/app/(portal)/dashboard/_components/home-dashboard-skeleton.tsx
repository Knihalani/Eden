import { Skeleton } from "@/components/ui/skeleton";

/**
 * Home loading skeleton — mirrors W7 Status → Diagnosis → Action composition.
 * Shared by `loading.tsx` and org-loading early return on the page.
 */
export function HomeDashboardSkeleton({
  label = "Loading dashboard",
}: {
  label?: string;
}) {
  return (
    <div
      className="w-full mx-auto max-w-7xl p-space-4 sm:p-space-6 lg:p-space-8 flex flex-col gap-space-5 page-enter"
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
      data-testid="home-dashboard-skeleton"
      data-home-shell-state="loading"
      data-home-shell-kpi="restraint"
    >
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>

      <div
        className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-[var(--border-subtle)] max-md:[&>*:nth-child(n+4)]:hidden"
        data-home-shell-kpi="restraint"
        aria-hidden
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-space-1 px-space-4 py-space-3 sm:px-space-5 sm:py-space-4"
          >
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>

      <div
        className="bg-[var(--bg-secondary)]/40 rounded-lg border border-[var(--border-subtle)] p-space-5 flex flex-col gap-space-2 sm:flex-row sm:items-center sm:justify-between"
        aria-hidden
      >
        <div className="flex flex-col gap-space-2 min-w-0 flex-1">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28 shrink-0" />
      </div>

      <div
        className="bg-[var(--bg-secondary)]/40 rounded-lg border border-[var(--border-subtle)] flex flex-col"
        aria-hidden
      >
        <div className="flex items-center justify-between gap-space-3 px-space-5 pt-space-4 pb-space-3 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-space-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-7 w-16" />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-space-3 px-space-5 py-space-2.5 border-b border-[var(--border-subtle)] last:border-b-0"
          >
            <Skeleton className="h-1.5 w-1.5 rounded-full shrink-0" />
            <div className="flex-1 flex flex-col gap-space-1 min-w-0">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-3 w-48 max-w-full" />
            </div>
            <Skeleton className="h-3 w-12 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

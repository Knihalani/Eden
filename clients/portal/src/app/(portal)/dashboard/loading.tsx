import { Skeleton } from "@/components/ui/skeleton";

/**
 * Dashboard route loading — mirrors Home Status→Diagnosis→Action:
 * header, ≤4 KPI cards, diagnosis strip, then recent-traces row.
 */
export default function Loading() {
  return (
    <div
      className="w-full mx-auto max-w-7xl p-space-4 sm:p-space-6 lg:p-space-8 flex flex-col gap-space-5 page-enter"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading dashboard"
    >
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-space-3 sm:gap-space-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-[var(--bg-primary)] rounded-xl p-space-5 border border-[var(--border-default)] flex flex-col gap-space-3"
          >
            <div className="flex items-center gap-space-2">
              <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
              <div className="flex flex-col gap-space-1 min-w-0 flex-1">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>

      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-space-5 flex flex-col gap-space-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-56 max-w-full" />
        <Skeleton className="h-3 w-72 max-w-full" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-space-4 sm:gap-space-6">
        <div className="xl:col-span-2 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-space-5 flex flex-col gap-space-3">
          <div className="flex items-center justify-between gap-space-3">
            <div className="flex flex-col gap-space-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-3 w-14" />
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-space-3 py-space-1">
              <Skeleton className="h-2 w-2 rounded-full shrink-0" />
              <div className="flex-1 flex flex-col gap-space-1 min-w-0">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-48 max-w-full" />
              </div>
              <Skeleton className="h-3 w-12 shrink-0" />
            </div>
          ))}
        </div>
        <div className="xl:col-span-1 hidden xl:block" aria-hidden />
      </div>
    </div>
  );
}

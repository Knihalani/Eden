import { cn } from "@/lib/utils";

/**
 * A shimmering placeholder used while data is loading. The animation
 * is defined globally in `app/globals.css` under "Skeleton shimmer".
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-[var(--bg-tertiary)]",
        "after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-[var(--shimmer)] after:to-transparent after:animate-[skeleton-shimmer_1.6s_infinite]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Page-shaped skeleton for use in `loading.tsx` route segments.
 * Renders a card-shaped shell with a header, optional stat strip, and content lines.
 *
 * Variants:
 *   - "default" — header + content lines (good for most detail/list pages)
 *   - "stats" — header + 4-column stat strip + content table skeleton
 *   - "table" — header + content table skeleton
 *   - "detail" — header + side panel + content
 */
export function LoadingSkeleton({
  variant = "default",
  lines = 4,
  className,
  size = "default",
}: {
  variant?: "default" | "stats" | "table" | "detail";
  lines?: number;
  className?: string;
  size?: "default" | "wide" | "narrow" | "full";
}) {
  const maxWidth =
    size === "wide"
      ? "max-w-7xl"
      : size === "narrow"
        ? "max-w-3xl"
        : size === "full"
          ? "max-w-none"
          : "max-w-6xl";

  return (
    <div
      className={cn(
        "w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6 page-enter",
        maxWidth,
        className,
      )}
      aria-busy="true"
      aria-live="polite"
    >
      {/* Header skeleton */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>

      {variant === "stats" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)] space-y-3"
            >
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-5 rounded" />
                <Skeleton className="h-4 w-12" />
              </div>
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </div>
      )}

      {(variant === "default" || variant === "table" || variant === "detail") && (
        <div className="bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)] space-y-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-8 w-24" />
          </div>
          {Array.from({ length: lines }).map((_, i) => (
            <div key={i} className="space-y-2" style={{ opacity: 1 - i * 0.1 }}>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ))}
        </div>
      )}

      {variant === "detail" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)] space-y-3">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
          </div>
          <div className="bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)] space-y-3">
            <Skeleton className="h-5 w-28" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * SkeletonCard — a card-shaped shell with header + body lines + a
 * CTA. Use in place of a spinning loader for surfaces that show a
 * single hero card (e.g. /agents/[id] detail, /billing plan card).
 */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)] space-y-4", className)}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-12" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-8 w-24 rounded-md" />
    </div>
  );
}

/**
 * SkeletonTableRow — a single placeholder row for a table.
 * Pass `columns` to control the per-cell width ratio. Defaults to a
 * 5-column row with sensible widths.
 */
export function SkeletonTableRow({
  columns = ["w-32", "w-24", "w-20", "w-28", "w-16"],
  className,
}: {
  columns?: string[];
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-4 px-4 py-3 border-t border-[var(--border-subtle)]", className)}>
      {columns.map((w, i) => (
        <Skeleton key={i} className={cn("h-3", w)} />
      ))}
    </div>
  );
}

/**
 * SkeletonListItem — a single placeholder row for a list
 * (avatar + primary line + secondary line).
 */
export function SkeletonListItem({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3 border-t border-[var(--border-subtle)]", className)}>
      <Skeleton className="h-8 w-8 rounded-full shrink-0" />
      <div className="flex-1 space-y-1.5 min-w-0">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-2.5 w-1/2" />
      </div>
    </div>
  );
}

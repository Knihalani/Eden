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
        "after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-white/5 after:to-transparent after:animate-[skeleton-shimmer_1.6s_infinite]",
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
}: {
  variant?: "default" | "stats" | "table" | "detail";
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-6 page-enter", className)} aria-busy="true" aria-live="polite">
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

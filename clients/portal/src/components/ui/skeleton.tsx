import { cn } from "@/lib/utils";

/**
 * A shimmering placeholder used while data is loading. The animation
 * is defined globally in ``app/globals.css`` under "Skeleton shimmer".
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-[var(--surface-2)]",
        // Shimmer pseudo-element
        "after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-white/5 after:to-transparent after:animate-[skeleton-shimmer_1.6s_infinite]",
        className,
      )}
      {...props}
    />
  );
}

import { cn } from "@/lib/utils";

/** Mono kicker used across marketing sections. */
export function MarketingKicker({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-muted)]",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function MarketingRail({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-5 sm:px-8", className)}>
      {children}
    </div>
  );
}

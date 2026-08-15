import { MarketingRail } from "@/components/marketing/marketing-primitives";

/**
 * Group-level skeleton for every `(marketing)` route. Rendered inside
 * `(marketing)/layout.tsx`, so the header and footer stay put and only
 * the page body blocks out — one file rather than 13 copies. A segment
 * with a genuinely different shape can still add its own.
 *
 * Same visual language as the auth shells: blocked-out regions in
 * `--line`, never a spinner.
 */
const BODY_LINES = [
  "w-full",
  "w-11/12",
  "w-10/12",
  "w-full",
  "w-9/12",
] as const;

export default function Loading() {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <MarketingRail className="py-16 sm:py-24">
        <div className="eden-skeleton-pulse h-3 w-24 rounded bg-[var(--line)]" />
        <div className="mt-6 space-y-4">
          <div className="eden-skeleton-pulse h-9 w-4/5 rounded bg-[var(--line)] sm:h-12" />
          <div className="eden-skeleton-pulse h-9 w-3/5 rounded bg-[var(--line)] sm:h-12" />
        </div>
        <div className="mt-8 max-w-2xl space-y-3">
          {BODY_LINES.map((w) => (
            <div
              key={w}
              className={`eden-skeleton-pulse h-3.5 rounded bg-[var(--line)] ${w}`}
            />
          ))}
        </div>
        <div className="mt-10 flex flex-wrap gap-3">
          <div className="eden-skeleton-pulse h-10 w-36 rounded-lg bg-[var(--accent-muted)]" />
          <div className="eden-skeleton-pulse h-10 w-28 rounded-lg bg-[var(--line)]" />
        </div>
        <div className="mt-16 grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="eden-skeleton-pulse h-32 rounded border border-[var(--line)] bg-[var(--bg-inset)]"
            />
          ))}
        </div>
      </MarketingRail>
      <span className="sr-only">Loading page</span>
    </div>
  );
}

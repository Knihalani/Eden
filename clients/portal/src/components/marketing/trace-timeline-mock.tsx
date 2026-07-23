import { cn } from "@/lib/utils";

type TraceMockProps = {
  className?: string;
  /** Compact for auth brand panel */
  compact?: boolean;
};

type Span = {
  label: string;
  depth: number;
  ms: number;
  pct: number;
  tone: "ok" | "warn" | "live" | "fail";
};

/** Realistic waterfall inspired by portal Observe timeline — not abstract art. */
const SPANS: Span[] = [
  { label: "agent.run", depth: 0, ms: 1240, pct: 100, tone: "ok" },
  { label: "llm.complete", depth: 1, ms: 612, pct: 49, tone: "ok" },
  { label: "tool.search", depth: 1, ms: 188, pct: 15, tone: "warn" },
  { label: "llm.complete", depth: 1, ms: 340, pct: 27, tone: "ok" },
  { label: "guardrail.check", depth: 1, ms: 42, pct: 3, tone: "live" },
  { label: "detector.drift", depth: 0, ms: 18, pct: 2, tone: "fail" },
];

function toneBar(tone: Span["tone"]) {
  if (tone === "fail") return "bg-[var(--error)]";
  // Slow / interesting — gold (not green; green is live-only)
  if (tone === "warn") return "bg-[color-mix(in_srgb,var(--accent)_70%,transparent)]";
  if (tone === "live") return "bg-[var(--success)]";
  return "bg-[var(--accent)]";
}

function toneText(tone: Span["tone"]) {
  if (tone === "fail") return "text-[var(--error)]";
  if (tone === "warn") return "text-[var(--accent)]";
  if (tone === "live") return "text-[var(--success)]";
  return "text-[var(--text-muted)]";
}

/**
 * Product metaphor for marketing/auth — flat trace waterfall plane.
 * Server component (no client JS).
 */
export function TraceTimelineMock({ className, compact }: TraceMockProps) {
  const rows = compact ? SPANS.slice(0, 4) : SPANS;

  return (
    <div
      className={cn(
        "relative overflow-hidden border-y border-[var(--line)] bg-[var(--bg)]",
        compact ? "py-5" : "py-10 sm:py-14",
        className,
      )}
      aria-hidden
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-0 eden-product-plane opacity-[0.22]",
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-24",
          "bg-[radial-gradient(ellipse_at_12%_0%,color-mix(in_srgb,var(--accent)_14%,transparent),transparent_60%)]",
        )}
      />
      <div
        className={cn(
          "relative mx-auto w-full",
          compact ? "max-w-md px-5" : "max-w-6xl px-5 sm:px-8",
        )}
      >
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Trace · tr_8f2a91c4
            </span>
            <span className="font-mono text-[0.625rem] text-[var(--text-faint)]">
              1.24s · 2,418 tok
            </span>
          </div>
          <span className="inline-flex items-center gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--success)]">
            <span
              className="size-1.5 rounded-full bg-[var(--success)]"
              aria-hidden
            />
            Live
          </span>
        </div>
        <ul className={cn("flex flex-col", compact ? "gap-2" : "gap-2.5")}>
          {rows.map((span, i) => (
            <li
              key={`${span.label}-${span.depth}-${i}`}
              className="flex items-center gap-2 sm:gap-3"
              style={{ paddingLeft: `${span.depth * (compact ? 12 : 18)}px` }}
            >
              <span
                className={cn(
                  "w-[7.5rem] shrink-0 truncate font-mono text-[0.6875rem] sm:w-40",
                  toneText(span.tone),
                )}
              >
                {span.label}
              </span>
              <div className="relative h-[3px] flex-1 bg-[var(--line)]">
                <div
                  className={cn("absolute inset-y-0 left-0", toneBar(span.tone))}
                  style={{ width: `${span.pct}%` }}
                />
              </div>
              <span className="w-11 shrink-0 text-right font-mono text-[0.625rem] tabular-nums text-[var(--text-faint)]">
                {span.ms}ms
              </span>
            </li>
          ))}
        </ul>
        {!compact ? (
          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--line)] pt-5">
            <p className="type-meta text-[var(--text-faint)]">
              Spans, tokens, detectors — then promote a fix through evals.
            </p>
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-[var(--error)]">
              1 issue · detector.drift
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

import { cn } from "@/lib/utils";

type TraceMockProps = {
  className?: string;
  /** Compact for auth brand panel */
  compact?: boolean;
  /** Full-bleed hero plane — denser chrome, animated spans */
  hero?: boolean;
};

type Span = {
  label: string;
  depth: number;
  ms: number;
  pct: number;
  tone: "ok" | "warn" | "live" | "fail";
  delayMs: number;
};

/** Realistic waterfall inspired by portal Observe timeline — not abstract art. */
const SPANS: Span[] = [
  { label: "agent.run", depth: 0, ms: 1240, pct: 100, tone: "ok", delayMs: 80 },
  { label: "llm.complete", depth: 1, ms: 612, pct: 49, tone: "ok", delayMs: 180 },
  { label: "tool.search", depth: 1, ms: 188, pct: 15, tone: "warn", delayMs: 280 },
  { label: "llm.complete", depth: 1, ms: 340, pct: 27, tone: "ok", delayMs: 360 },
  { label: "guardrail.check", depth: 1, ms: 42, pct: 3, tone: "live", delayMs: 440 },
  { label: "detector.drift", depth: 0, ms: 18, pct: 2, tone: "fail", delayMs: 520 },
];

const META = [
  { k: "model", v: "claude-sonnet" },
  { k: "cost", v: "$0.014" },
  { k: "score", v: "0.91" },
] as const;

function toneBar(tone: Span["tone"]) {
  if (tone === "fail") return "bg-[var(--error)]";
  if (tone === "warn")
    return "bg-[color-mix(in_srgb,var(--accent)_70%,transparent)]";
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
export function TraceTimelineMock({ className, compact, hero }: TraceMockProps) {
  const rows = compact ? SPANS.slice(0, 5) : SPANS;
  const barH = hero ? "h-1.5" : compact ? "h-[3px]" : "h-1";

  return (
    <div
      className={cn(
        "relative overflow-hidden",
        hero
          ? "border-t border-[var(--line)] bg-[var(--bg)] py-8 sm:py-10"
          : cn(
              "border-y border-[var(--line)] bg-[var(--bg)]",
              compact ? "py-6" : "py-10 sm:py-14",
            ),
        className,
      )}
      aria-hidden
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-0 eden-product-plane",
          hero || compact ? "opacity-[0.35]" : "opacity-[0.22]",
          compact && "eden-product-plane--dense",
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-32",
          "bg-[radial-gradient(ellipse_at_8%_0%,color-mix(in_srgb,var(--accent)_18%,transparent),transparent_55%)]",
        )}
      />
      {(hero || compact) && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-1/3 bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--accent)_6%,transparent))]"
          aria-hidden
        />
      )}

      <div
        className={cn(
          "relative mx-auto w-full",
          compact
            ? "max-w-none px-6 xl:px-10"
            : hero
              ? "max-w-6xl px-5 sm:px-8"
              : "max-w-6xl px-5 sm:px-8",
        )}
      >
        <div
          className={cn(
            "mb-5 flex flex-wrap items-center justify-between gap-3",
            hero && "mb-6",
          )}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Trace · tr_8f2a91c4
            </span>
            <span className="font-mono text-[0.625rem] text-[var(--text-muted)]">
              1.24s · 2,418 tok
            </span>
            {(hero || compact) &&
              META.map((m) => (
                <span
                  key={m.k}
                  className="hidden font-mono text-[0.625rem] text-[var(--text-faint)] sm:inline"
                >
                  <span className="text-[var(--text-disabled)]">{m.k}</span>{" "}
                  <span className="text-[var(--text-secondary)]">{m.v}</span>
                </span>
              ))}
          </div>
          <span className="inline-flex items-center gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--success)]">
            <span
              className="eden-live-dot size-1.5 rounded-full bg-[var(--success)]"
              aria-hidden
            />
            Live
          </span>
        </div>

        <div className="relative">
          <div
            className="eden-playhead pointer-events-none absolute inset-y-0 z-[1] w-px bg-[var(--accent)]"
            style={{ boxShadow: "0 0 12px color-mix(in srgb, var(--accent) 55%, transparent)" }}
          />
          <ul className={cn("flex flex-col", hero ? "gap-3" : compact ? "gap-2.5" : "gap-2.5")}>
            {rows.map((span, i) => (
              <li
                key={`${span.label}-${span.depth}-${i}`}
                className="flex items-center gap-2 sm:gap-3"
                style={{ paddingLeft: `${span.depth * (compact ? 14 : 18)}px` }}
              >
                <span
                  className={cn(
                    "w-[7.5rem] shrink-0 truncate font-mono text-[0.6875rem] sm:w-44",
                    toneText(span.tone),
                  )}
                >
                  {span.label}
                </span>
                <div
                  className={cn(
                    "relative flex-1 bg-[color-mix(in_srgb,var(--line)_80%,transparent)]",
                    barH,
                  )}
                >
                  <div
                    className={cn(
                      "eden-span-grow absolute inset-y-0 left-0",
                      toneBar(span.tone),
                    )}
                    style={{
                      width: `${span.pct}%`,
                      animationDelay: `${span.delayMs}ms`,
                    }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right font-mono text-[0.625rem] tabular-nums text-[var(--text-faint)]">
                  {span.ms}ms
                </span>
              </li>
            ))}
          </ul>
        </div>

        {!compact ? (
          <div
            className={cn(
              "mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--line)] pt-5",
              hero && "mt-8",
            )}
          >
            <p className="type-meta text-[var(--text-faint)]">
              Spans, tokens, detectors — then promote a fix through evals.
            </p>
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-[var(--error)]">
              1 issue · detector.drift
            </span>
            {hero ? (
              <span className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-[var(--accent)]">
                Improve · patch ready
              </span>
            ) : null}
          </div>
        ) : (
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1 border-t border-[var(--line)] pt-4">
            <span className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
              Observe
            </span>
            <span className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
              Evaluate
            </span>
            <span className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--accent)]">
              Improve
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

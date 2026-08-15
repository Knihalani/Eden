import { cn } from "@/lib/utils";

type Variant = "hero" | "auth";

type Span = {
  label: string;
  depth: number;
  ms: number;
  pct: number;
  tone: "ok" | "warn" | "live" | "fail";
  delayMs: number;
};

const SPANS: Span[] = [
  { label: "agent.run", depth: 0, ms: 1240, pct: 100, tone: "ok", delayMs: 60 },
  { label: "planner.step", depth: 1, ms: 96, pct: 8, tone: "ok", delayMs: 120 },
  { label: "llm.complete", depth: 1, ms: 612, pct: 49, tone: "ok", delayMs: 180 },
  { label: "tool.search", depth: 1, ms: 188, pct: 15, tone: "warn", delayMs: 260 },
  { label: "llm.complete", depth: 1, ms: 340, pct: 27, tone: "ok", delayMs: 340 },
  { label: "tool.write", depth: 1, ms: 74, pct: 6, tone: "ok", delayMs: 400 },
  { label: "guardrail.check", depth: 1, ms: 42, pct: 3, tone: "live", delayMs: 460 },
  { label: "detector.drift", depth: 0, ms: 18, pct: 2, tone: "fail", delayMs: 520 },
];

const EVENTS = [
  { t: "14:02:11", msg: "ingest · openai · 612ms", tone: "ok" as const },
  { t: "14:02:11", msg: "detector.drift · score 0.31", tone: "fail" as const },
  { t: "14:02:12", msg: "issue opened · ISS-1842", tone: "fail" as const },
  { t: "14:02:14", msg: "eval pin · prompt.v12", tone: "live" as const },
  { t: "14:02:18", msg: "improve · patch draft ready", tone: "ok" as const },
];

function toneBar(tone: Span["tone"]) {
  if (tone === "fail") return "bg-[var(--error)]";
  if (tone === "warn")
    return "bg-[color-mix(in_srgb,var(--accent)_75%,transparent)]";
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
 * Dense Observe-surface mock for marketing hero + auth brand.
 * No scanning playhead — presence comes from chrome density + bar motion.
 */
export function ProductSurfaceMock({
  variant = "hero",
  className,
}: {
  variant?: Variant;
  className?: string;
}) {
  const auth = variant === "auth";
  const spans = SPANS.slice(0, 6);

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden border border-[var(--line)] bg-[var(--bg)]",
        className,
      )}
      aria-hidden
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-0 eden-product-plane",
          auth ? "eden-product-plane--dense opacity-[0.45]" : "opacity-[0.32]",
        )}
      />
      <div className="pointer-events-none absolute inset-0 eden-grain" />

      {/* Title bar */}
      <div className="relative flex items-center justify-between gap-3 border-b border-[var(--line)] px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <span className="font-mono text-[0.75rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
            Observe
          </span>
          <nav className="hidden items-center gap-1 sm:flex">
            {["Traces", "Sessions", "Issues"].map((tab, i) => (
              <span
                key={tab}
                className={cn(
                  "px-2 py-1 font-mono text-[0.75rem] uppercase tracking-[0.12em]",
                  i === 0
                    ? "border border-[var(--line-accent)] bg-[var(--accent-muted)] text-[var(--accent)]"
                    : "text-[var(--text-faint)]",
                )}
              >
                {tab}
              </span>
            ))}
          </nav>
        </div>
        <span className="inline-flex items-center gap-1.5 font-mono text-[0.75rem] uppercase tracking-[0.16em] text-[var(--success)]">
          <span className="eden-live-dot size-1.5 rounded-full bg-[var(--success)]" />
          Live
        </span>
      </div>

      {/* Meta strip */}
      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_4%,transparent)] px-3 py-2 sm:px-4">
        <span className="font-mono text-[0.75rem] text-[var(--text-secondary)]">
          tr_8f2a91c4
        </span>
        <span className="font-mono text-[0.75rem] text-[var(--text-faint)]">
          1.24s
        </span>
        <span className="font-mono text-[0.75rem] text-[var(--text-faint)]">
          2,418 tok
        </span>
        <span className="font-mono text-[0.75rem] text-[var(--text-faint)]">
          $0.014
        </span>
        <span className="ml-auto font-mono text-[0.75rem] text-[var(--error)]">
          ISS-1842 · drift
        </span>
      </div>

      {/* Body: waterfall + side rail */}
      <div
        className={cn(
          "relative grid min-h-0 flex-1",
          auth ? "grid-rows-[1fr_auto]" : "lg:grid-cols-[1fr_11.5rem]",
        )}
      >
        <div className="min-h-0 overflow-hidden px-3 py-3 sm:px-4 sm:py-4">
          <ul className="flex flex-col gap-2.5">
            {spans.map((span, i) => (
              <li
                key={`${span.label}-${i}`}
                className="flex items-center gap-2"
                style={{ paddingLeft: `${span.depth * (auth ? 12 : 16)}px` }}
              >
                <span
                  className={cn(
                    "w-[6.5rem] shrink-0 truncate font-mono text-[0.8125rem] sm:w-36",
                    toneText(span.tone),
                  )}
                >
                  {span.label}
                </span>
                <div className="relative h-2 flex-1 overflow-hidden bg-[color-mix(in_srgb,var(--line)_70%,transparent)] sm:h-2.5">
                  <div
                    className={cn(
                      "eden-span-grow eden-bar-shimmer absolute inset-y-0 left-0",
                      toneBar(span.tone),
                      span.tone === "ok" &&
                        "bg-[linear-gradient(90deg,var(--accent),color-mix(in_srgb,var(--accent)_55%,transparent),var(--accent))]",
                    )}
                    style={{
                      width: `${span.pct}%`,
                      animationDelay: `${span.delayMs}ms`,
                    }}
                  />
                </div>
                <span className="w-11 shrink-0 text-right font-mono text-[0.75rem] tabular-nums text-[var(--text-faint)]">
                  {span.ms}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {!auth ? (
          <aside className="hidden flex-col border-l border-[var(--line)] lg:flex">
            <div className="border-b border-[var(--line)] px-3 py-3">
              <p className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                Issue
              </p>
              <p className="mt-2 font-mono text-[0.75rem] text-[var(--error)]">
                detector.drift
              </p>
              <p className="mt-1 text-[0.6875rem] leading-snug text-[var(--text-muted)]">
                Output diverged from pinned baseline on tool.search.
              </p>
            </div>
            <div className="border-b border-[var(--line)] px-3 py-3">
              <p className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                Eval
              </p>
              <p className="mt-2 text-[1.375rem] font-semibold tabular-nums tracking-[-0.03em] text-[var(--accent)]">
                0.91
              </p>
              <p className="mt-1 font-mono text-[0.75rem] text-[var(--text-faint)]">
                treatment · +0.07
              </p>
            </div>
            <div className="flex flex-1 flex-col justify-end px-3 py-3">
              <p className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--accent)]">
                Improve
              </p>
              <p className="mt-2 text-[0.6875rem] leading-snug text-[var(--text-secondary)]">
                Patch draft ready for review.
              </p>
            </div>
          </aside>
        ) : null}

        {auth ? (
          <div className="border-t border-[var(--line)] px-3 py-2.5 sm:px-4">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--error)]">
                ISS-1842 · drift
              </span>
              <span className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-[var(--accent)]">
                Patch ready
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Event ticker */}
      <div className="relative overflow-hidden border-t border-[var(--line)] py-2">
        <div className="eden-ticker flex w-max gap-8 whitespace-nowrap px-4">
          {[...EVENTS, ...EVENTS].map((ev, i) => (
            <span
              key={`${ev.t}-${i}`}
              className="inline-flex items-center gap-2 font-mono text-[0.75rem]"
            >
              <span className="text-[var(--text-disabled)]">{ev.t}</span>
              <span className={toneText(ev.tone)}>{ev.msg}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

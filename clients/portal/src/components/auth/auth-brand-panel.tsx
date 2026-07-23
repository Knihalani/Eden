import { EdenLogo } from "@/components/ds/eden-logo";
import { TraceTimelineMock } from "@/components/marketing/trace-timeline-mock";

/**
 * Left panel for split auth — brand + instrument atmosphere + live trace.
 * CSS ambient drift only (no framer-motion on auth routes).
 */
export function AuthBrandPanel() {
  return (
    <aside className="relative flex h-full min-h-0 flex-col justify-between overflow-hidden border-b border-[var(--line)] bg-[var(--bg)] lg:min-h-dvh lg:border-b-0 lg:border-r">
      <div
        className="pointer-events-none absolute inset-0 eden-product-plane eden-product-plane--dense opacity-[0.4]"
        aria-hidden
      />
      <div
        className="eden-auth-ambient pointer-events-none absolute -left-1/3 top-[-5%] h-[32rem] w-[32rem] rounded-full opacity-[0.55]"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 68%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-1/4 right-[-20%] h-[20rem] w-[20rem] rounded-full opacity-40"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%)",
        }}
        aria-hidden
      />

      {/* Mobile: compact brand strip */}
      <div className="relative px-5 py-5 sm:px-8 lg:hidden">
        <div className="flex items-center gap-2.5">
          <EdenLogo size={24} priority />
          <span className="text-[0.9375rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
            eden
          </span>
        </div>
        <p className="mt-3 max-w-sm text-[0.875rem] leading-snug text-[var(--text-secondary)]">
          Instrument agents. Catch drift. Ship the fix.
        </p>
      </div>

      {/* Desktop: full brand column */}
      <div className="relative hidden min-h-0 flex-1 flex-col lg:flex">
        <div className="flex flex-1 flex-col justify-between px-10 pt-12 xl:px-14">
          <div>
            <div className="flex items-center gap-2.5">
              <EdenLogo size={28} priority />
              <span className="text-[1.0625rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
                eden
              </span>
            </div>
            <p className="mt-3 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-[var(--text-faint)]">
              Observe · Evaluate · Improve
            </p>
            <p className="mt-10 max-w-[13ch] text-[1.75rem] font-semibold leading-[1.12] tracking-[-0.035em] text-[var(--text)] xl:text-[1.875rem]">
              Instrument agents.
              <br />
              Catch drift.
              <br />
              Ship the fix.
            </p>
            <p className="mt-5 max-w-sm text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
              Production AI observability — same Signal Black chrome after you
              sign in.
            </p>
            <dl className="mt-8 grid max-w-xs grid-cols-3 gap-3 border-t border-[var(--line)] pt-6">
              {[
                { k: "p99", v: "≤5ms" },
                { k: "ingest", v: "OTel" },
                { k: "loop", v: "closed" },
              ].map((row) => (
                <div key={row.k}>
                  <dt className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                    {row.k}
                  </dt>
                  <dd className="mt-1 font-mono text-[0.75rem] text-[var(--text-secondary)]">
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div className="mt-8 shrink-0">
          <TraceTimelineMock compact className="border-x-0 border-b-0" />
        </div>
      </div>
    </aside>
  );
}

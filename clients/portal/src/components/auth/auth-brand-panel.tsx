import { EdenLogo } from "@/components/ds/eden-logo";
import { TraceTimelineMock } from "@/components/marketing/trace-timeline-mock";

/**
 * Left panel for split auth — brand + product voice + compact timeline.
 * CSS ambient drift only (no framer-motion on auth routes).
 */
export function AuthBrandPanel() {
  return (
    <aside className="relative flex h-full min-h-0 flex-col justify-between overflow-hidden border-b border-[var(--line)] bg-[var(--bg)] lg:min-h-dvh lg:border-b-0 lg:border-r">
      <div
        className="eden-auth-ambient pointer-events-none absolute -left-1/4 top-0 h-[26rem] w-[26rem] rounded-full opacity-[0.45]"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 20%, transparent), transparent 68%)",
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
      <div className="relative hidden flex-1 flex-col justify-between px-10 pb-0 pt-12 lg:flex xl:px-14">
        <div>
          <div className="flex items-center gap-2.5">
            <EdenLogo size={28} priority />
            <span className="text-[1.0625rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
              eden
            </span>
          </div>
          <p className="mt-12 max-w-[14ch] text-[1.625rem] font-semibold leading-[1.15] tracking-[-0.03em] text-[var(--text)] xl:text-[1.75rem]">
            Instrument agents.
            <br />
            Catch drift.
            <br />
            Ship the fix.
          </p>
          <p className="mt-5 max-w-sm text-[0.8125rem] leading-relaxed text-[var(--text-faint)]">
            Observability and improvement for production AI — same Signal Black
            chrome after you sign in.
          </p>
        </div>
        <div className="mt-10 -mx-10 xl:-mx-14">
          <TraceTimelineMock compact className="border-x-0 border-b-0" />
        </div>
      </div>
    </aside>
  );
}

import { EdenLogo } from "@/components/ds/eden-logo";
import { ProductSurfaceMock } from "@/components/marketing/product-surface-mock";

/**
 * Left auth panel — brand voice fills the top; dense product chrome fills the rest.
 */
export function AuthBrandPanel() {
  return (
    <aside className="relative flex h-full min-h-0 flex-col overflow-hidden border-b border-[var(--line)] bg-[var(--bg)] lg:min-h-dvh lg:border-b-0 lg:border-r">
      <div
        className="pointer-events-none absolute inset-0 eden-product-plane eden-product-plane--dense opacity-[0.42]"
        aria-hidden
      />
      <div className="pointer-events-none absolute inset-0 eden-grain" aria-hidden />
      <div
        className="eden-auth-ambient pointer-events-none absolute -left-1/3 top-[-8%] h-[34rem] w-[34rem] rounded-full opacity-[0.65]"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 24%, transparent), transparent 68%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-[-5%] right-[-25%] h-[22rem] w-[22rem] rounded-full opacity-50"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%)",
        }}
        aria-hidden
      />

      {/* Mobile strip */}
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

      {/* Desktop column */}
      <div className="relative hidden min-h-0 flex-1 flex-col lg:flex">
        <div className="shrink-0 px-8 pt-11 xl:px-11">
          <div className="flex items-center gap-2.5">
            <EdenLogo size={28} priority />
            <span className="text-[1.0625rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
              eden
            </span>
          </div>
          <p className="mt-3 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-[var(--text-faint)]">
            Observe · Evaluate · Improve
          </p>
          <p className="mt-8 max-w-[12ch] text-[1.875rem] font-semibold leading-[1.1] tracking-[-0.038em] text-[var(--text)] xl:text-[2rem]">
            Instrument agents.
            <br />
            Catch drift.
            <br />
            Ship the fix.
          </p>
          <p className="mt-4 max-w-sm text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
            Same Signal Black chrome after you sign in — traces, evals, and the
            improve loop.
          </p>
        </div>

        <div className="relative mt-8 flex min-h-0 flex-1 flex-col px-6 pb-6 xl:px-8">
          <div
            className="pointer-events-none absolute inset-x-6 top-0 h-24 bg-[radial-gradient(ellipse_at_50%_0%,color-mix(in_srgb,var(--accent)_16%,transparent),transparent_70%)] xl:inset-x-8"
            aria-hidden
          />
          <ProductSurfaceMock
            variant="auth"
            className="relative min-h-0 flex-1"
          />
        </div>
      </div>
    </aside>
  );
}

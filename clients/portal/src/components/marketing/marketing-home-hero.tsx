import { DOCS_URL } from "@/lib/constants";
import { MarketingAuthCtas } from "@/components/marketing/marketing-auth-ctas";
import { MarketingRail } from "@/components/marketing/marketing-primitives";
import { ProductSurfaceMock } from "@/components/marketing/product-surface-mock";

/**
 * First viewport as one composition: brand copy + dense product chrome.
 * Desktop: split. Mobile: stacked. No empty black slab.
 * CTAs detect session client-side — no server ``auth()`` (keeps marketing fast).
 */
export function MarketingHomeHero() {
  return (
    <section className="relative isolate overflow-hidden border-b border-[var(--line)]">
      <div
        className="pointer-events-none absolute inset-0 eden-product-plane opacity-[0.22]"
        aria-hidden
      />
      <div className="pointer-events-none absolute inset-0 eden-grain" aria-hidden />
      <div
        className="eden-auth-ambient pointer-events-none absolute -left-[20%] top-[-15%] h-[36rem] w-[36rem] rounded-full opacity-60"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 18%, transparent), transparent 68%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-[-10%] right-[-8%] h-[28rem] w-[28rem] rounded-full opacity-45"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%)",
        }}
        aria-hidden
      />

      <MarketingRail className="relative grid grid-cols-1 items-stretch gap-10 py-14 sm:py-16 lg:grid-cols-12 lg:gap-12 lg:py-20">
        <div className="eden-hero-rise flex flex-col justify-center lg:col-span-5">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Observe · Evaluate · Improve
          </p>
          <h1 className="mt-5 max-w-[14ch] text-[clamp(2.5rem,5.8vw,3.85rem)] font-semibold leading-[1.02] tracking-[-0.042em] text-[var(--text)]">
            See every agent run.
            <br />
            Fix what fails.
          </h1>
          <p className="mt-5 max-w-md text-[1.0625rem] leading-relaxed text-[var(--text-secondary)]">
            Drop-in observability for AI agents — capture every LLM and tool call,
            detect failures, evaluate changes, and ship reviewable fixes in one
            closed loop. Free during public beta.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <MarketingAuthCtas size="md" />
            <a
              href={DOCS_URL}
              className="type-ui inline-flex min-h-11 items-center px-2 text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--accent)]"
              rel="noopener noreferrer"
            >
              Docs →
            </a>
          </div>

        </div>

        <div className="eden-hero-rise-delay relative lg:col-span-7">
          <div className="absolute -inset-px bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] blur-2xl" aria-hidden />
          <ProductSurfaceMock
            variant="hero"
            className="relative min-h-[22rem] sm:min-h-[26rem] lg:min-h-[32rem]"
          />
        </div>
      </MarketingRail>
    </section>
  );
}

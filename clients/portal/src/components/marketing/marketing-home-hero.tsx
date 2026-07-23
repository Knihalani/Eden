import Link from "next/link";
import { EdenLogo } from "@/components/ds/eden-logo";
import { DOCS_URL } from "@/lib/constants";
import { MarketingRail } from "@/components/marketing/marketing-primitives";
import { TraceTimelineMock } from "@/components/marketing/trace-timeline-mock";

/**
 * First viewport as one composition: brand + headline + CTA sitting on a
 * full-bleed product plane (live trace), not empty black then a strip below.
 */
export function MarketingHomeHero() {
  return (
    <section className="relative isolate overflow-hidden border-b border-[var(--line)]">
      {/* Full-bleed instrument field behind copy + product */}
      <div
        className="pointer-events-none absolute inset-0 eden-product-plane opacity-[0.28]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-1/4 top-[-10%] h-[28rem] w-[28rem] rounded-full opacity-50"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-0 right-[-10%] h-[22rem] w-[22rem] rounded-full opacity-40"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 10%, transparent), transparent 68%)",
        }}
        aria-hidden
      />

      <MarketingRail className="relative flex min-h-[min(52dvh,28rem)] flex-col justify-end pb-10 pt-16 sm:min-h-[min(48dvh,26rem)] sm:pb-12 sm:pt-20">
        <div className="eden-hero-rise max-w-3xl">
          <div className="flex items-center gap-3.5">
            <EdenLogo size={44} priority />
            <span className="font-[family-name:var(--font-geist-sans)] text-[clamp(1.75rem,4vw,2.25rem)] font-semibold tracking-[-0.045em] text-[var(--text)]">
              eden
            </span>
          </div>
          <h1 className="mt-8 max-w-[16ch] text-[clamp(2.375rem,6vw,3.75rem)] font-semibold leading-[1.02] tracking-[-0.04em] text-[var(--text)]">
            See every agent run.
            <br />
            Fix what fails.
          </h1>
          <p className="mt-5 max-w-lg text-[1.0625rem] leading-relaxed text-[var(--text-secondary)]">
            Drop-in observability for AI agents — traces, evals, and reviewable
            improvements in one loop.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/sign-up" className="ds-btn ds-btn-primary px-5">
              Get started
            </Link>
            <Link href="/sign-in" className="ds-btn ds-btn-outline px-5">
              Sign in
            </Link>
            <a
              href={DOCS_URL}
              className="type-ui px-1 text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--accent)]"
              rel="noopener noreferrer"
            >
              Docs →
            </a>
          </div>
        </div>
      </MarketingRail>

      <div className="eden-hero-rise-delay relative">
        <TraceTimelineMock hero />
      </div>
    </section>
  );
}

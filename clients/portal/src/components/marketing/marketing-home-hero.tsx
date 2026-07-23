import Link from "next/link";
import { EdenLogo } from "@/components/ds/eden-logo";
import { DOCS_URL } from "@/lib/constants";
import { MarketingRail } from "@/components/marketing/marketing-primitives";
import { TraceTimelineMock } from "@/components/marketing/trace-timeline-mock";

/**
 * First viewport: brand → one headline → one sentence → CTAs → full-bleed
 * product plane. Server-rendered; CSS entrance only (no framer-motion).
 */
export function MarketingHomeHero() {
  return (
    <section className="relative">
      <MarketingRail className="flex min-h-[min(68dvh,36rem)] flex-col justify-end pb-10 pt-14 sm:min-h-[min(72dvh,40rem)] sm:pb-14 sm:pt-20">
        <div className="eden-hero-rise">
          <div className="flex items-center gap-3.5">
            <EdenLogo size={40} priority />
            <span className="font-[family-name:var(--font-geist-sans)] text-[clamp(1.5rem,3.5vw,2rem)] font-semibold tracking-[-0.04em] text-[var(--text)]">
              eden
            </span>
          </div>
          <h1 className="mt-9 max-w-[18ch] text-[clamp(2.125rem,5.5vw,3.5rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-[var(--text)]">
            See every agent run.
            <br />
            Fix what fails.
          </h1>
          <p className="mt-5 max-w-xl text-[1.0625rem] leading-relaxed text-[var(--text-secondary)]">
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
      <TraceTimelineMock />
    </section>
  );
}

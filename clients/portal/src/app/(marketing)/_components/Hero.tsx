import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  PRODUCT_NAME,
  DOCS_QUICKSTART_URL,
  FREE_TIER_TAGLINE,
} from "@/lib/constants";
import { TracesExplorerMock } from "./TracesExplorerMock";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]";

/**
 * Brand-first hero: one composition — Eden as the display signal,
 * one product line, one support sentence, one CTA group, and a
 * full-bleed Traces plane (not an inset card).
 */
export function Hero({ signedIn }: { signedIn: boolean }) {
  return (
    <section
      className="relative isolate flex min-h-[calc(100svh-4rem)] flex-col overflow-hidden"
      aria-labelledby="hero-heading"
    >
      {/* Full-bleed product plane — edge to edge, no card chrome */}
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
        <TracesExplorerMock variant="bleed" />
        {/* Left → right scrim so copy stays legible without badges */}
        {/* Left-only scrim — keeps Traces plane crisp on the right */}
        <div
          className="absolute inset-y-0 left-0 w-[min(52%,36rem)]"
          style={{
            background:
              "linear-gradient(to right, var(--bg-primary) 0%, color-mix(in srgb, var(--bg-primary) 88%, transparent) 55%, transparent 100%)",
          }}
        />
        <div
          className="absolute inset-x-0 bottom-0 h-28"
          style={{
            background:
              "linear-gradient(to top, var(--bg-primary) 0%, transparent 100%)",
          }}
        />
      </div>

      <div className="relative z-10 flex flex-1 flex-col justify-end px-6 pb-14 pt-10 sm:pb-16 md:justify-center md:pb-20 md:pt-12">
        <div className="mx-auto w-full max-w-7xl">
          <div
            className="max-w-xl motion-safe:animate-[fade-slide-up_420ms_var(--ease-out,cubic-bezier(0.33,1,0.68,1))_both]"
          >
            <p className="marketing-brand mb-4 md:mb-5">{PRODUCT_NAME}</p>

            <h1 id="hero-heading" className="marketing-lede mb-4 md:mb-5">
              See every LLM call. Review every patch.
            </h1>

            <p className="marketing-support mb-7 md:mb-8">
              Gateway or SDK → first traces in minutes → human-reviewed patches
              you ship.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={signedIn ? "/dashboard" : "/sign-up"}
                className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--bg-base)] transition-colors hover:bg-[var(--accent-hover)] ${focusRing}`}
              >
                {signedIn ? "Open dashboard" : "Start free"}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <a
                href={DOCS_QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]/80 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] backdrop-blur-sm transition-colors hover:bg-[var(--bg-tertiary)] ${focusRing}`}
              >
                Quickstart
              </a>
            </div>

            <p className="mt-5 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {signedIn ? "Pick up where you left off." : FREE_TIER_TAGLINE}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

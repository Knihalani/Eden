"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  PRODUCT_NAME,
  DOCS_QUICKSTART_URL,
  FREE_TIER_TAGLINE,
} from "@/lib/constants";
import { TracesExplorerMock } from "./TracesExplorerMock";

export function Hero({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="relative flex min-h-[calc(100svh-4rem)] flex-col justify-center px-6 py-10 md:py-12">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-8 lg:grid-cols-12 lg:gap-12">
        {/* Copy first on mobile so brand + H1 + CTAs land before the mock */}
        <div className="order-1 max-w-xl lg:col-span-5">
          <p
            className="mb-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl"
            style={{ letterSpacing: "-0.035em", lineHeight: 1.05 }}
          >
            {PRODUCT_NAME}
          </p>

          <h1
            className="mb-4 !text-xl font-semibold text-[var(--text-primary)] sm:!text-2xl lg:!text-[1.75rem]"
            style={{
              letterSpacing: "-0.02em",
              lineHeight: 1.25,
            }}
          >
            See every LLM call. Review every fix.
          </h1>

          <p
            className="mb-6 max-w-md text-base text-[var(--text-secondary)]"
            style={{ lineHeight: 1.55 }}
          >
            Gateway or SDK → first traces in minutes → reviewable fixes you
            ship.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={signedIn ? "/dashboard" : "/sign-up"}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--bg-base)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
            >
              {signedIn ? "Open dashboard" : "Start free"}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
            >
              Quickstart
            </a>
          </div>

          <p className="mt-4 text-xs text-[var(--text-muted)]">
            {signedIn ? "Pick up where you left off." : FREE_TIER_TAGLINE}
          </p>
        </div>

        <TracesExplorerMock />
      </div>
    </section>
  );
}

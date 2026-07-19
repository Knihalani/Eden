import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  DOCS_QUICKSTART_URL,
  FREE_TIER_CAP_SHORT,
  FREE_TIER_TAGLINE,
} from "@/lib/constants";

const STEPS = [
  {
    n: 1,
    k: "INSTALL",
    v: "pip install eden-sdk",
    sub: "or npm install @eden-ai/sdk",
  },
  {
    n: 2,
    k: "CAPTURE",
    v: "gateway or wrap",
    sub: "one base_url · or configure → instrument",
  },
  {
    n: 3,
    k: "CONFIRM",
    v: "doctor → Traces",
    sub: "eden-doctor, then open the portal",
  },
  {
    n: 4,
    k: "REVIEW",
    v: "patch suggestions",
    sub: "human-reviewed — you open the PR",
  },
] as const;

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

export function BottomCta({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="px-6 pb-24">
      <div className="max-w-5xl mx-auto">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
            <div className="p-6 sm:p-8 md:p-10 flex flex-col gap-5 sm:gap-6 border-b md:border-b-0 md:border-r border-[var(--border-subtle)]">
              <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Get started
              </p>
              <h2
                className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight"
                style={{ letterSpacing: "-0.03em", lineHeight: 1.08 }}
              >
                {signedIn ? "Welcome back." : "Ship better agents, faster."}
              </h2>
              <p className="text-sm md:text-base text-[var(--text-secondary)] leading-relaxed">
                {signedIn
                  ? "Your workspace is ready — jump back into your traces."
                  : `${FREE_TIER_TAGLINE} First trace in minutes.`}
              </p>
              <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 mt-auto">
                <Link
                  href={signedIn ? "/dashboard" : "/sign-up"}
                  className={`inline-flex min-h-11 items-center justify-center gap-2 px-5 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors w-full sm:w-auto ${focusRing}`}
                >
                  {signedIn ? "Open dashboard" : "Start free"}
                  <ArrowRight className="w-4 h-4" aria-hidden />
                </Link>
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex min-h-11 items-center justify-center gap-2 px-5 text-sm font-medium text-[var(--text-primary)] bg-transparent border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors w-full sm:w-auto ${focusRing}`}
                >
                  Quickstart
                </a>
              </div>
            </div>

            <div className="p-6 sm:p-8 md:p-10 flex flex-col gap-4">
              <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Path to first trace
              </p>
              <ol className="space-y-3.5">
                {STEPS.map((step) => (
                  <li key={step.n} className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-0.5 shrink-0 w-6 h-6 rounded-full border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-[11px] font-mono font-semibold flex items-center justify-center"
                    >
                      0{step.n}
                    </span>
                    <div className="min-w-0 flex-1 leading-snug">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                          {step.k}
                        </span>
                        <span className="font-mono text-sm text-[var(--text-primary)]">
                          {step.v}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {step.sub}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="pt-3 mt-2 border-t border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-muted)] flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>Soft launch</span>
                <span className="text-[var(--text-faint)]">·</span>
                <span>free tier</span>
                <span className="text-[var(--text-faint)]">·</span>
                <span>{FREE_TIER_CAP_SHORT}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

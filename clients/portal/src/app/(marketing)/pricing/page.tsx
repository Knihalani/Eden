import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import {
  FREE_TIER_CAP_SHORT,
  FREE_TIER_TAGLINE,
  SALES_EMAIL,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing · Eden",
  description:
    "Free during public beta. Team for orgs and evals. Enterprise for SSO and audit.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "Pricing · Eden",
    description: FREE_TIER_TAGLINE,
    images: [
      { url: "/og-pricing.png", width: 1200, height: 630, alt: "Eden Pricing" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pricing · Eden",
    description: FREE_TIER_TAGLINE,
    images: ["/og-pricing.png"],
  },
};

const TIERS = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    period: "public beta",
    blurb: `Instrument agents and inspect traces. ${FREE_TIER_CAP_SHORT} LLM spend cap.`,
    features: [
      "Trace ingest & sessions",
      "Issues and detectors",
      "Personal workspace",
      "Community docs",
    ],
    cta: { href: "/sign-up", label: "Start free", primary: true },
    highlight: false,
  },
  {
    id: "team",
    name: "Team",
    price: "Usage",
    period: "billed monthly",
    blurb: "Shared orgs, evals, alerts, and prompt pins when the fleet grows.",
    features: [
      "Everything in Free",
      "Organizations & members",
      "Evals, prompts, live A/B",
      "Alerts and API keys",
    ],
    cta: { href: "/sign-up", label: "Start free → upgrade", primary: true },
    highlight: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Custom",
    period: "annual contracts",
    blurb: "SSO, audit packs, retention controls, and dedicated support.",
    features: [
      "Everything in Team",
      "SSO / SCIM",
      "Audit & retention controls",
      "Priority support",
    ],
    cta: {
      href: `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Eden Enterprise")}`,
      label: "Contact sales",
      primary: false,
    },
    highlight: false,
  },
] as const;

export default function PricingPage() {
  return (
    <main>
      <MarketingShell
        kicker="Pricing"
        title="Start free. Upgrade when the fleet grows."
        lead={`${FREE_TIER_TAGLINE} Move to Team for orgs, evals, and alerts — or talk to us for Enterprise.`}
      >
        <div className="grid gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] lg:grid-cols-3">
          {TIERS.map((tier) => (
            <div
              key={tier.id}
              className={cn(
                "relative flex flex-col bg-[var(--bg)] p-6 sm:p-8",
                tier.highlight && "bg-[color-mix(in_srgb,var(--accent)_4%,var(--bg))]",
              )}
            >
              {tier.highlight ? (
                <span className="absolute right-5 top-5 font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--accent)]">
                  Recommended
                </span>
              ) : null}
              <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
                {tier.name}
              </p>
              <p className="mt-4 text-[2rem] font-semibold tracking-[-0.03em] tabular-nums text-[var(--text)]">
                {tier.price}
              </p>
              <p className="mt-1 type-meta text-[var(--text-faint)]">
                {tier.period}
              </p>
              <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
                {tier.blurb}
              </p>
              <ul className="mt-7 flex flex-1 flex-col gap-2.5">
                {tier.features.map((f) => (
                  <li
                    key={f}
                    className="flex gap-2.5 text-[0.875rem] text-[var(--text-muted)]"
                  >
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              {tier.cta.href.startsWith("mailto:") ? (
                <a
                  href={tier.cta.href}
                  className={cn(
                    "ds-btn mt-8 w-full justify-center",
                    tier.cta.primary ? "ds-btn-primary" : "ds-btn-outline",
                  )}
                >
                  {tier.cta.label}
                </a>
              ) : (
                <Link
                  href={tier.cta.href}
                  className={cn(
                    "ds-btn mt-8 w-full justify-center",
                    tier.cta.primary ? "ds-btn-primary" : "ds-btn-outline",
                  )}
                >
                  {tier.cta.label}
                </Link>
              )}
            </div>
          ))}
        </div>
        <p className="mt-8 type-meta text-[var(--text-faint)]">
          Path: start on Free → upgrade in-product when you need Team. Enterprise
          questions →{" "}
          <a
            href={`mailto:${SALES_EMAIL}`}
            className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
          >
            {SALES_EMAIL}
          </a>
        </p>
      </MarketingShell>
    </main>
  );
}

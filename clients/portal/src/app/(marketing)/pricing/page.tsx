import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { JsonLd } from "@/components/seo/json-ld";
import {
  FREE_TIER_CAP_SHORT,
  FREE_TIER_TAGLINE,
  SALES_EMAIL,
} from "@/lib/constants";
import { marketingMetadata, pricingProductJsonLd } from "@/lib/seo";
import { cn } from "@/lib/utils";


export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/pricing",
  title: "Eden Pricing — Free LLM Observability in Public Beta",
  description:
    "Start free with Eden during public beta — no credit card. Full LLM observability: traces, issues, evals, and orgs. Team and Enterprise coming soon.",
  ogImage: "/og-pricing.png",
});

const TIERS = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    period: "public beta",
    blurb: `The full platform while in public beta. ${FREE_TIER_CAP_SHORT}.`,
    features: [
      "Trace ingest & sessions",
      "Issues, detectors & alerts",
      "Evals, prompts & live A/B",
      "Orgs & members (up to 3 seats)",
      "API keys",
    ],
    comingSoon: false,
    highlight: true,
  },
  {
    id: "team",
    name: "Team",
    price: "Usage",
    period: "billed monthly",
    blurb: "Higher limits and more seats when the fleet grows.",
    features: [
      "Everything in Free",
      "Higher credit caps",
      "Expanded seats",
    ],
    comingSoon: true,
    highlight: false,
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
    comingSoon: true,
    highlight: false,
  },
] as const;

export default function PricingPage() {
  return (
    <main>
      {/* Product schema — Free offer only (Team/Enterprise are roadmap). */}
      <JsonLd data={pricingProductJsonLd()} />
      <MarketingShell
        kicker="Pricing"
        title="Start free. Paid plans coming soon."
        lead={`${FREE_TIER_TAGLINE} Team and Enterprise are listed for roadmap — not available to purchase yet.`}
      >
        <div className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] lg:grid-cols-3">
          {TIERS.map((tier) => (
            <div
              key={tier.id}
              className={cn(
                "relative flex flex-col bg-[var(--bg)] p-6 sm:p-8",
                tier.highlight &&
                  "bg-[color-mix(in_srgb,var(--accent)_4%,var(--bg))]",
                tier.comingSoon && "opacity-90",
              )}
            >
              {tier.comingSoon ? (
                <span className="absolute right-5 top-5 font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                  Coming soon
                </span>
              ) : tier.highlight ? (
                <span className="absolute right-5 top-5 font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--accent)]">
                  Available
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
                    <span
                      className="mt-2 size-1 shrink-0 rounded-full bg-[var(--accent)]"
                      aria-hidden
                    />
                    {f}
                  </li>
                ))}
              </ul>
              {tier.comingSoon ? (
                <button
                  type="button"
                  disabled
                  className="ds-btn ds-btn-outline mt-8 w-full justify-center cursor-not-allowed opacity-55"
                >
                  Coming soon
                </button>
              ) : (
                <MarketingPrimaryCta
                  signedOutHref="/sign-up"
                  signedOutLabel="Start free"
                  className="mt-8 w-full justify-center"
                />
              )}
            </div>
          ))}
        </div>
        <p className="mt-8 type-meta text-[var(--text-faint)]">
          Free is open during public beta. Questions about Team or Enterprise →{" "}
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

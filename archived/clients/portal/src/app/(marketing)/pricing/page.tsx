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

const PRICING_FAQ = [
  {
    q: "Is Eden really free during public beta?",
    a: `Yes — no credit card required. Free includes the full platform with a monthly credit cap (${FREE_TIER_CAP_SHORT}). Soft and hard limits enforce that cap; we do not invent unlimited free usage.`,
  },
  {
    q: "What is included on Free?",
    a: "Trace ingest and sessions, issues and detectors, evals and live A/B, organizations with up to three seats, and API keys. OpenAI-compatible gateway and SDK ingest are part of the same Free surface.",
  },
  {
    q: "Can I buy Team or Enterprise today?",
    a: "Not yet. Team and Enterprise are listed for roadmap visibility — higher limits, more seats, SSO/SCIM, audit and retention controls, and priority support. Email sales if those requirements matter for your timeline.",
  },
  {
    q: "What happens when I hit the credit cap?",
    a: "Free-tier soft and hard credit limits apply per month. Plan for the published cap rather than assuming burst unlimited ingest. Contact us if you are evaluating a larger production footprint.",
  },
  {
    q: "Do you publish competitor pricing?",
    a: "No. We describe Eden's Free-during-beta offer and roadmap tiers only. Fair product comparisons live on Why Eden and the /vs pages without invented competitor price sheets.",
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
        <p className="mt-8 type-meta text-[var(--text-muted)]">
          A credit is a unit of billed gateway and ingest usage — the free monthly
          cap is {FREE_TIER_CAP_SHORT} (100 credits ≈ $1 of Eden cost). We do not
          treat one trace as one credit.
        </p>
        <p className="mt-3 type-meta text-[var(--text-muted)]">
          Free is open during public beta. Questions about Team or Enterprise →{" "}
          <a
            href={`mailto:${SALES_EMAIL}`}
            className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
          >
            {SALES_EMAIL}
          </a>
        </p>

        <section className="mt-16 max-w-3xl space-y-5">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
            Included on Free
          </p>
          <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
            What you get during public beta
          </h2>
          <p className="text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            The Free tier is the full platform while we are in public beta —
            not a feature-locked demo. Trace ingest and sessions, detectors and
            issues, evals and live A/B, orgs with up to three seats, and API
            keys are included. Usage is bounded by the monthly credit cap (
            {FREE_TIER_CAP_SHORT}). Soft and hard limits enforce that cap in
            product; we do not invent unlimited free usage for marketing.
          </p>
          <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
            {[
              "OpenAI-compatible gateway + SDK ingest",
              "Sessions, spans, detectors, issues",
              "Evals, prompts, datasets, live A/B",
              "Org membership (up to 3 seats) + API keys",
              "PII filtering & retention controls in Settings",
              "Human-gated Improve / fix plans",
            ].map((item) => (
              <li
                key={item}
                className="bg-[var(--bg)] px-5 py-4 text-[0.875rem] text-[var(--text-muted)]"
              >
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-16 max-w-3xl">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
            FAQ
          </p>
          <h2 className="mt-3 text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
            Pricing questions
          </h2>
          <div className="mt-8 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {PRICING_FAQ.map((item) => (
              <details key={item.q} className="eden-faq-item">
                <summary className="flex cursor-pointer items-center justify-between gap-4 py-4 text-[0.9375rem] font-medium tracking-[-0.01em] text-[var(--text)] transition-colors duration-150 hover:text-[var(--accent)]">
                  {item.q}
                  <span
                    className="eden-faq-chevron shrink-0 font-mono text-[0.9375rem] text-[var(--text-faint)]"
                    aria-hidden
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-2xl pb-5 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </section>
      </MarketingShell>
    </main>
  );
}

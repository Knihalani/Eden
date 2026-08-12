import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/why-eden",
  title: "Why Eden — Closed-Loop LLM Observability vs Traces",
  description:
    "Traces-only tools show LLM traffic. Eden detects failures, heals when safe, and opens proven fix plans — closed-loop AI observability vs capture-only.",
});

const ROWS = [
  {
    capability: "Capture traces & sessions",
    others: "Core product",
    eden: "Gateway + SDKs — same starting line",
  },
  {
    capability: "Detect production failures",
    others: "Dashboards / alerts you wire yourself",
    eden: "Detectors → Issues without a separate pager stack",
  },
  {
    capability: "Runtime self-heal",
    others: "Not in product",
    eden: "On by default for reversible actions — opt out anytime",
  },
  {
    capability: "Fix PRs with proof",
    others: "Export to your IDE",
    eden: "Fix now queue with evidence tiers before you merge",
  },
  {
    capability: "Decision audit",
    others: "Log archaeology",
    eden: "Settings → Autonomy audit: allow / deny / budget",
  },
  {
    capability: "Dogfood",
    others: "Your app only",
    eden: "Eden runs on Eden — our agents are customers too",
  },
] as const;

export default function WhyEdenPage() {
  return (
    <main>
      <MarketingShell
        kicker="Why Eden"
        title="Traces are table stakes. Closed loop is the product."
        lead="Langfuse, Helicone, and Braintrust help you see LLM traffic. Eden detects failures, heals when it is safe, and opens proven fix plans — heal on by default, opt out in Settings."
      >
        <div className="max-w-3xl space-y-10">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "≤5ms", k: "Gateway overhead" },
              { v: "OTel", k: "Ingest protocol" },
              { v: "Closed", k: "Observe → Improve loop" },
              { v: "Free", k: "During public beta" },
            ].map((row) => (
              <div key={row.k} className="bg-[var(--bg)] px-4 py-5">
                <p className="font-mono text-[1.25rem] font-semibold tabular-nums tracking-[-0.02em] text-[var(--accent)]">
                  {row.v}
                </p>
                <p className="mt-1 font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                  {row.k}
                </p>
              </div>
            ))}
          </div>

          <div className="overflow-hidden border border-[var(--line)]">
            <table className="w-full text-left text-[0.875rem]">
              <thead>
                <tr className="border-b border-[var(--line)] bg-[var(--bg-inset)]">
                  <th className="type-label px-4 py-3 font-normal">Capability</th>
                  <th className="type-label px-4 py-3 font-normal">
                    Traces-only tools
                  </th>
                  <th className="type-label px-4 py-3 font-normal">Eden</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr
                    key={row.capability}
                    className="border-b border-[var(--line)] last:border-b-0"
                  >
                    <td className="px-4 py-3 text-[var(--text)]">
                      {row.capability}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {row.others}
                    </td>
                    <td className="px-4 py-3 text-[var(--text)]">{row.eden}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[0.9375rem] text-[var(--text-secondary)]">
            Code patches and auto-merge stay gated. Runtime heal is reversible
            actions only, budget-capped, with a full audit trail.{" "}
            <a
              href={DOCS_URL}
              className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
              rel="noopener noreferrer"
            >
              Read the docs
            </a>
            .
          </p>

          <div className="flex flex-col items-start gap-5 border border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_5%,var(--bg))] px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div>
              <p className="text-[1.0625rem] font-semibold tracking-[-0.015em] text-[var(--text)]">
                Instrument today. Improve tomorrow.
              </p>
              <p className="mt-1.5 type-meta text-[var(--text-faint)]">
                Free during public beta — no credit card.
              </p>
            </div>
            <MarketingPrimaryCta
              signedOutHref="/sign-up"
              signedOutLabel="Get started"
              className="px-6"
            />
          </div>
        </div>
      </MarketingShell>
    </main>
  );
}

import type { Metadata } from "next";

import { MarketingShell } from "@/components/marketing/marketing-shell";
import { DOCS_URL } from "@/lib/constants";

export const revalidate = 3600;
export const metadata: Metadata = {
  title: "Why Eden · closed-loop vs traces-only",
  description:
    "Why Eden is the closed-loop option: observe, heal by default, prove fixes — not just capture traces.",
  robots: { index: true, follow: true },
};

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
        </div>
      </MarketingShell>
    </main>
  );
}

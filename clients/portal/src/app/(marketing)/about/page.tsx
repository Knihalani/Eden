import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { DOCS_URL, SUPPORT_EMAIL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "About · Eden",
  description:
    "Eden instruments AI agents so teams can catch drift and ship fixes.",
  robots: { index: true, follow: true },
};

export default function AboutPage() {
  return (
    <main>
      <MarketingShell
        kicker="About"
        title="Built for teams who run agents in production."
        lead="Eden captures every LLM and tool call, groups failures into issues, and turns real traces into evals and improvements you can review."
      >
        <div className="max-w-2xl space-y-8">
          <div className="space-y-5 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            <p>
              We care about honest units, durable telemetry, and a closed loop —
              observe, evaluate, improve — without leaving the tools your
              engineers already use.
            </p>
            <p>
              The product voice is precise and calm on purpose. The interface
              should feel like an instrument panel: dense, legible, never loud.
            </p>
          </div>
          <dl className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
            {[
              { t: "Observe", d: "Traces, sessions, detectors, issues" },
              { t: "Evaluate", d: "Prompts, datasets, live A/B" },
              { t: "Improve", d: "Plans cited to real failures" },
            ].map((item) => (
              <div key={item.t} className="bg-[var(--bg)] p-5">
                <dt className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
                  {item.t}
                </dt>
                <dd className="mt-2 text-[0.875rem] text-[var(--text-muted)]">
                  {item.d}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-[0.9375rem] text-[var(--text-secondary)]">
            Reach us at{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
            >
              {SUPPORT_EMAIL}
            </a>
            {" · "}
            <a
              href={DOCS_URL}
              className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
              rel="noopener noreferrer"
            >
              Docs
            </a>
          </p>
        </div>
      </MarketingShell>
    </main>
  );
}

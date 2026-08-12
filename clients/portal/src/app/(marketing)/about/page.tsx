import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_URL, DOCS_QUICKSTART_URL, SUPPORT_EMAIL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/about",
  title: "About Eden — Observability & Improvement for AI Agents",
  description:
    "Eden instruments production AI agents so teams can catch drift, evaluate changes, and ship reviewable fixes. Observe, evaluate, improve in one loop.",
});

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
      {children}
    </p>
  );
}

export default function AboutPage() {
  return (
    <main>
      <MarketingShell
        kicker="About"
        title="Built for teams who run agents in production."
        lead="Eden captures every LLM and tool call, groups failures into issues, and turns real traces into evals and improvements you can review — without leaving the tools your engineers already use."
      >
        <div className="max-w-3xl space-y-14">
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

          <section className="space-y-5">
            <SectionKicker>What Eden is</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Observability that closes the loop
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Eden is observability and improvement for AI agents and LLM
                applications. Teams instrument once — with the Python or
                TypeScript SDK, OpenTelemetry, or an OpenAI-compatible gateway —
                and get sessions, spans, detectors, issues, evals, and a
                human-gated Improve queue in one product surface. The goal is
                not another dashboard you check after an incident. The goal is a
                closed loop: observe production traffic, evaluate changes before
                and after they ship, and improve with plans cited to the
                failures you already captured.
              </p>
              <p>
                Traces-only tools help you see LLM traffic. That is necessary
                and still table stakes. What breaks production teams is the gap
                after capture: who notices drift, how latency and cost thresholds
                become issues, whether a reversible mitigation can fire safely,
                and how a bad span becomes a reviewable fix instead of a Slack
                thread and a late-night grep. Eden starts at the same ingest
                line as capture-first products, then owns that second half
                without forcing a rewrite of how you call models.
              </p>
              <p>
                The product voice is precise and calm on purpose. The interface
                should feel like an instrument panel: dense, legible, never loud.
                Honest units, durable telemetry, and reviewable autonomy matter
                more than marketing fireworks. Free during public beta — no
                credit card — so instrumentation is not a procurement project
                before you can see your first production session.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Who it is for</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Engineering and platform teams past “just log prompts”
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Eden is for teams who already run language-model features in
                production — support agents, coding copilots, retrieval apps,
                workflow automations — and need more than a pretty trace viewer
                when something drifts after a deploy. If your week includes
                unexplained latency spikes, silent quality regressions, or cost
                cliffs after a model swap, you are past the logging-only phase.
              </p>
              <p>
                The common pattern: a team instruments an LLM SDK, ships a
                gateway or proxy for spend visibility, and still spends evenings
                stitching dashboards to alerts to tickets to pull requests.
                Capture is solved. Closing the loop is not. Eden is built for
                that second half without asking you to abandon OpenTelemetry or
                abandon the OpenAI-compatible client you already use.
              </p>
              <p>
                You do not need a research lab or a dedicated evals org to start.
                If you can point traffic at the gateway or install{" "}
                <code className="font-mono text-[0.875rem] text-[var(--text)]">
                  eden-sdk
                </code>
                , you can ingest sessions and spans today. Eden runs on Eden:
                our own agents are customers of the same detectors, issues, and
                Fix now queue you will use. That dogfood constraint keeps the
                product honest about production failure modes.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>How the loop works</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Observe → evaluate → improve
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Observe.
                </strong>{" "}
                Sessions group runs by user, agent, or deploy so production
                context stays attached to the span tree. Detectors watch drift,
                latency, and cost thresholds. Failures open as Issues with
                first/last seen and deduped fingerprints — triage without grepping
                logs or wiring a separate pager stack for every new prompt
                version. Gateway overhead stays ≤5ms p95 on the OpenAI-compatible
                path so instrumentation does not become the outage.
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Evaluate.
                </strong>{" "}
                Version prompts, pin environments, and compare arms on the
                metrics that matter before you ship. Live A/B and datasets sit
                next to the same sessions and issues you already use for
                incident triage, so eval results are not stranded in a separate
                tool with a different identity model. Deterministic judge scores
                and human review stay in the loop when automatic scores are not
                enough.
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Improve.
                </strong>{" "}
                When a detector or manual triage opens an issue, Eden drafts a
                plan cited to the failing spans and eval delta. You approve,
                reject, or snooze it. Runtime self-heal can take reversible,
                budget-capped actions when it is safe — on by default for those
                safe actions, opt out anytime in Settings. Code patches and
                auto-merge stay gated. A human reviews before anything ships.
              </p>
            </div>
            <ol className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  n: "01",
                  t: "Detect",
                  d: "Issue opens from a detector or manual triage.",
                },
                {
                  n: "02",
                  t: "Propose",
                  d: "Plan cites the failing spans and eval delta.",
                },
                {
                  n: "03",
                  t: "Ship",
                  d: "Human review — then re-observe the next run.",
                },
              ].map((step) => (
                <li key={step.n} className="bg-[var(--bg)] p-5 sm:p-6">
                  <span className="font-mono text-[0.625rem] tabular-nums text-[var(--text-faint)]">
                    {step.n}
                  </span>
                  <p className="mt-3 text-[1.0625rem] font-medium tracking-[-0.015em] text-[var(--text)]">
                    {step.t}
                  </p>
                  <p className="mt-2 type-ui text-[var(--text-muted)]">
                    {step.d}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <section className="space-y-5">
            <SectionKicker>Principles</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What we refuse to fake
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                We care about honest units and durable telemetry. Credit caps,
                latency claims, and free-tier limits are stated in product copy
                the same way they are enforced in the platform — not inflated for
                a landing page. Autonomy decisions need an audit trail of allow,
                deny, and budget instead of invisible magic. If a claim is not
                true in the product today, it does not belong on this site.
              </p>
              <p>
                Tenant isolation, org-scoped API access, and PII filtering are
                part of how Eden is built, not an afterthought. You control
                retention and redaction from Settings. Eden does not sell
                personal information. Vulnerability reports go to a private
                disclosure inbox — see{" "}
                <Link href="/security" className={linkClass}>
                  Security
                </Link>{" "}
                and the docs security overview for posture and reporting paths.
                We do not invent certifications on marketing surfaces.
              </p>
              <p>
                Positioning stays fair.{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>{" "}
                and the{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  vs Langfuse
                </Link>
                ,{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  vs Helicone
                </Link>
                , and{" "}
                <Link href="/vs/braintrust" className={linkClass}>
                  vs Braintrust
                </Link>{" "}
                pages describe overlap and differences without competitor pricing
                fiction or fake customer logos. Choose Eden when closed-loop ops
                is the gap. Choose a traces-only or evals-first tool when that is
                the job you need done first.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Getting started</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Instrument today. Improve tomorrow.
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Start free during public beta. Install the SDK or point existing
                OpenAI SDK calls at Eden&apos;s gateway URL so every request and
                response is captured without rewriting your application. The{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  quickstart
                </a>{" "}
                walks through ingest in a few minutes; the full{" "}
                <a
                  href={DOCS_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  docs
                </a>{" "}
                cover SDK reference, API, PII policy, and operations. Pricing
                stays simple while we are in public beta — see{" "}
                <Link href="/pricing" className={linkClass}>
                  Pricing
                </Link>{" "}
                for what is included and what is roadmap-only.
              </p>
              <p>
                Questions about the product, sales, or security?{" "}
                <Link href="/contact" className={linkClass}>
                  Contact
                </Link>{" "}
                lists the right path, or email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className={linkClass}>
                  {SUPPORT_EMAIL}
                </a>
                . Live operational status is on{" "}
                <Link href="/status" className={linkClass}>
                  Status
                </Link>
                . We respond as quickly as we can — real inbox, not a black hole.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <MarketingPrimaryCta />
              <a
                href={DOCS_URL}
                className="type-ui px-1 text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
                rel="noopener noreferrer"
              >
                Docs →
              </a>
            </div>
          </section>
        </div>
      </MarketingShell>
    </main>
  );
}

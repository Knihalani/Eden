import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_QUICKSTART_URL, DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/langfuse-alternatives",
  title: "Langfuse Alternatives — How to Evaluate LLM Observability",
  description:
    "Evaluation criteria and a shortlist of Langfuse alternatives for LLM tracing and ops — including Eden’s closed-loop approach. Complements Eden vs Langfuse.",
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

const CRITERIA = [
  {
    t: "Ingest fit",
    d: "SDK depth, OpenTelemetry, OpenAI-compatible gateway, self-host constraints.",
  },
  {
    t: "Trace & session UX",
    d: "How fast you can reconstruct an agent run with production context attached.",
  },
  {
    t: "Prompt & eval workflows",
    d: "Whether prompt versioning, datasets, and scoring are core or adjacent.",
  },
  {
    t: "Production detection",
    d: "Dashboards you wire yourself vs detectors that open durable Issues.",
  },
  {
    t: "Mitigation & fix path",
    d: "Export-to-IDE vs reversible heal and evidence-linked fix plans.",
  },
  {
    t: "Control & audit",
    d: "Autonomy allow/deny/budget, retention, PII filtering — without marketing theater.",
  },
] as const;

export default function LangfuseAlternativesPage() {
  return (
    <main>
      <MarketingShell
        kicker="Langfuse alternatives"
        title="Evaluate alternatives by the job — not by the logo."
        lead="Langfuse is excellent for open, self-hostable LLM tracing and prompt workflows. If you are shopping Langfuse alternatives, start with criteria: ingest fit, detection, and whether you need a closed loop past capture. This page complements Eden vs Langfuse — it does not replace it."
      >
        <div className="max-w-3xl space-y-14">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "Criteria", k: "First, then shortlist" },
              { v: "Fair", k: "No invented pricing" },
              { v: "Closed", k: "Eden’s differentiator" },
              { v: "vs", k: "Deep dive linked" },
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

          <section className="space-y-5">
            <SectionKicker>Intent</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What “Langfuse alternatives” usually means
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Buyers searching for Langfuse alternatives are rarely saying
                Langfuse is bad. They are saying the job changed. Early on,
                “instrument, store, inspect” is enough. Later, production
                agents add drift after deploys, cost cliffs after model swaps,
                and a need to turn failing spans into mitigations and merges.
                Alternatives searches are a signal that capture alone may not
                be the bottleneck anymore.
              </p>
              <p>
                Sometimes the constraint is different: managed vs self-host,
                evals-first culture, proxy-first spend visibility, or a desire
                for closed-loop detect → heal → fix. Name the constraint before
                you shortlist. A traces-only alternative that looks similar on
                a feature grid will not help if your pager glue is the real
                pain. An evals-first tool will not help if you needed a gateway
                this week.
              </p>
              <p>
                This page is an evaluation guide plus a short shortlist. For
                Langfuse-specific tradeoffs against Eden — strengths,
                coexistence, and a capability table — read{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  Eden vs Langfuse
                </Link>
                . We do not invent competitor pricing, SOC2 badges, or customer
                logos here.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Criteria</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Evaluation criteria that actually matter
            </h2>
            <p className="text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              Score each candidate against the jobs you will do next quarter —
              not against a universal “best LLM observability” myth. Use these
              criteria as a worksheet.
            </p>
            <ol className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
              {CRITERIA.map((item, i) => (
                <li key={item.t} className="bg-[var(--bg)] p-5 sm:p-6">
                  <span className="font-mono text-[0.625rem] tabular-nums text-[var(--text-faint)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <p className="mt-2 text-[1.0625rem] font-medium tracking-[-0.015em] text-[var(--text)]">
                    {item.t}
                  </p>
                  <p className="mt-2 text-[0.9375rem] leading-relaxed text-[var(--text-muted)]">
                    {item.d}
                  </p>
                </li>
              ))}
            </ol>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Weight the criteria honestly. If self-host residency is
                non-negotiable, that may dominate over closed-loop heal. If
                your team already lives in eval notebooks, prioritize datasets
                and scoring UX. If OpenAI clients are everywhere and you need
                visibility this sprint, prioritize gateway ingest with published
                overhead claims — Eden’s gateway overhead stays ≤5ms at p95 on
                the path we publish.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Shortlist</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              A fair shortlist (including Eden)
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Stay with Langfuse
                </strong>{" "}
                when open, self-hostable tracing and prompt workflows are the
                center of gravity and you are not blocked on production
                detection or fix workflow. Langfuse is strong at that job. An
                “alternative” is optional, not mandatory.
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Helicone
                </strong>{" "}
                belongs on the list when proxy-first request logs, spend, and
                cache visibility with minimal application changes matter more
                than open self-host tracing. Compare with{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Eden vs Helicone
                </Link>{" "}
                and the companion{" "}
                <Link href="/helicone-alternatives" className={linkClass}>
                  Helicone alternatives
                </Link>{" "}
                page.
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Braintrust
                </strong>{" "}
                belongs when evals, datasets, and scored experiments are the
                quality process — offline and online scoring as the daily
                habit. See{" "}
                <Link href="/vs/braintrust" className={linkClass}>
                  Eden vs Braintrust
                </Link>
                . Eden also versions prompts, pins environments, and runs live
                A/B, but does not pretend evals UX alone is the whole product.
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">Eden</strong>{" "}
                belongs when you want the same starting line — gateway, SDKs,
                OpenTelemetry — then closed-loop ops: detectors → Issues,
                reversible heal on by default with opt-out, and Fix now plans
                with evidence before merge. Free during public beta — no credit
                card. Read{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>{" "}
                and the deep dive{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  Eden vs Langfuse
                </Link>
                .
              </p>
              <p>
                Other traces-only or platform-native exporters may fit if your
                constraint is “keep everything in our existing APM.” Evaluate
                them on LLM-specific session grouping and agent graph clarity —
                generic RED metrics rarely answer prompt-regression questions.
                For a category map, see{" "}
                <Link href="/llm-observability-tools" className={linkClass}>
                  LLM observability tools
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Migration</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              How to trial an alternative without a big-bang cutover
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Treat alternatives as experiments on a single high-traffic
                path, not as weekend migrations of every historical trace.
                Keep Langfuse (or your current store) as the system of record
                for exploration while you point new production traffic at a
                candidate for detection and fix workflow. Measure pager glue:
                how long from “something drifted” to “Issue opened,” “safe
                mitigation applied,” and “reviewable plan ready.”
              </p>
              <p>
                Document the criteria scores you actually care about — ingest
                fit, detection, mitigation, audit — before demos so vendor
                tours cannot reframe the job mid-call. If self-host residency
                is non-negotiable, say so up front and do not punish closed-loop
                products for a constraint they are not trying to win. If closed
                loop is the goal, do not score products only on span-browser
                polish.
              </p>
              <p>
                When Eden is in the shortlist, use the{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  quickstart
                </a>{" "}
                to reach first trace, confirm gateway or SDK ingest, enable
                detectors, and walk one Issue into Fix now. Compare that path
                to your current Langfuse-centered runbook. The deep dive for
                coexistence and capability rows remains{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  Eden vs Langfuse
                </Link>
                ; this page stays criteria-first so you do not duplicate that
                matrix.
              </p>
              <p>
                Also cross-check neighboring intents:{" "}
                <Link href="/helicone-alternatives" className={linkClass}>
                  Helicone alternatives
                </Link>{" "}
                if proxy capture is part of the story,{" "}
                <Link
                  href="/opentelemetry-llm-tracing"
                  className={linkClass}
                >
                  OpenTelemetry LLM tracing
                </Link>{" "}
                if OTel is mandated, and{" "}
                <Link href="/ai-agent-observability" className={linkClass}>
                  AI agent observability
                </Link>{" "}
                if you need the category definition for stakeholders who still
                think “observability” means only dashboards.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Eden</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              When Eden is the right alternative
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Pick Eden when production failure detection should not require
                reinventing a pager stack for every agent; when reversible
                runtime heal should sit next to human-gated fix plans; and when
                autonomy decisions need an audit trail of allow, deny, and
                budget. Keep Langfuse (or dual-ingest) when self-host residency
                or existing prompt habits still dominate — coexistence is
                covered on the vs page.
              </p>
              <p>
                Ingest stays deliberately compatible: Python and TypeScript
                SDKs, OpenTelemetry, or point OpenAI-compatible clients at the
                gateway for capture without code changes. Details:{" "}
                <Link
                  href="/openai-compatible-gateway"
                  className={linkClass}
                >
                  OpenAI-compatible gateway
                </Link>{" "}
                and{" "}
                <Link
                  href="/opentelemetry-llm-tracing"
                  className={linkClass}
                >
                  OpenTelemetry LLM tracing
                </Link>
                . Category framing:{" "}
                <Link href="/ai-agent-observability" className={linkClass}>
                  AI agent observability
                </Link>
                .
              </p>
              <p>
                Practical experiment: instrument one high-traffic path via{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  quickstart
                </a>
                , turn on detectors, and see whether Issues and Fix now reduce
                glue. Check{" "}
                <Link href="/pricing" className={linkClass}>
                  pricing
                </Link>{" "}
                for Free beta limits. Docs:{" "}
                <a
                  href={DOCS_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  docs.edenobservability.com
                </a>
                .
              </p>
            </div>
            <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  href: "/vs/langfuse",
                  t: "vs Langfuse",
                  d: "Capability table and coexistence.",
                },
                {
                  href: "/why-eden",
                  t: "Why Eden",
                  d: "Closed-loop thesis vs traces-only.",
                },
                {
                  href: "/llm-observability-tools",
                  t: "Tool roundup",
                  d: "Traces, evals, gateways, closed-loop.",
                },
              ].map((item) => (
                <li key={item.href} className="bg-[var(--bg)] p-5">
                  <Link
                    href={item.href}
                    className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--accent)] hover:text-[var(--accent-hover)]"
                  >
                    {item.t}
                  </Link>
                  <p className="mt-2 text-[0.875rem] text-[var(--text-muted)]">
                    {item.d}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <p className="text-[0.9375rem] text-[var(--text-secondary)]">
            Code patches and auto-merge stay gated. Runtime heal is reversible
            actions only, budget-capped, with a full audit trail.{" "}
            <a
              href={DOCS_URL}
              className={linkClass}
              rel="noopener noreferrer"
            >
              Read the docs
            </a>
            .
          </p>

          <div className="flex flex-col items-start gap-5 border border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_5%,var(--bg))] px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div>
              <p className="text-[1.0625rem] font-semibold tracking-[-0.015em] text-[var(--text)]">
                Shortlist closed loop — then prove it on traffic.
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

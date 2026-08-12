import Link from "next/link";
import { MarketingKicker, MarketingRail } from "@/components/marketing/marketing-primitives";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { InstallSnippetCopy } from "@/components/marketing/install-snippet-copy";
import { INSTALL_SNIPPET } from "@/components/marketing/install-snippet";
import { DOCS_URL, DOCS_QUICKSTART_URL } from "@/lib/constants";
import { HOME_FAQ } from "@/lib/seo";

/** Integration surface — chips link to the matching docs reference. */
const STACK = [
  { label: "Python SDK", href: `${DOCS_URL}/reference/sdk-python` },
  { label: "TypeScript SDK", href: `${DOCS_URL}/reference/sdk-typescript` },
  { label: "OpenAI-compatible gateway", href: "/openai-compatible-gateway" },
  { label: "OpenTelemetry ingest", href: "/opentelemetry-llm-tracing" },
  { label: "REST API", href: `${DOCS_URL}/reference/api` },
] as const;

/**
 * Below-fold — denser instrument metaphors, asymmetric layouts.
 */
export function MarketingHomeSections() {
  return (
    <>
      {/* At-a-glance band — the three numbers that answer “why Eden”. */}
      <section className="border-b border-[var(--line)] bg-[var(--bg)]">
        <MarketingRail className="grid grid-cols-2 gap-px bg-[var(--line)] sm:grid-cols-4">
          {[
            { v: "≤5ms", k: "Gateway overhead p95" },
            { v: "OTel + SDKs", k: "Ingest paths" },
            { v: "Closed", k: "Observe → Improve loop" },
            { v: "Free", k: "During public beta" },
          ].map((row) => (
            <div key={row.k} className="bg-[var(--bg)] px-5 py-6 sm:px-6 sm:py-8">
              <p className="font-mono text-[1.375rem] font-semibold tabular-nums tracking-[-0.02em] text-[var(--accent)] sm:text-[1.75rem]">
                {row.v}
              </p>
              <p className="mt-1 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                {row.k}
              </p>
            </div>
          ))}
        </MarketingRail>
      </section>

      {/* Problem → solution — why capture-only is not enough. */}
      <section className="border-b border-[var(--line)] py-16 sm:py-24">
        <MarketingRail className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-5">
            <MarketingKicker>Problem</MarketingKicker>
            <h2 className="mt-3 max-w-md text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.85rem]">
              Traces without a loop still leave you grepping
            </h2>
            <p className="mt-4 max-w-md text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              You instrumented the SDK. You have spans and spend. After a deploy
              drifts, you still stitch dashboards to alerts to tickets to PRs —
              detection, mitigation, and fix review live outside the product.
            </p>
          </div>
          <div className="lg:col-span-7">
            <MarketingKicker>Solution</MarketingKicker>
            <h2 className="mt-3 max-w-xl text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.85rem]">
              Observe, evaluate, improve in one surface
            </h2>
            <p className="mt-4 max-w-xl text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              Eden starts at the same ingest line — gateway, SDKs, or OpenTelemetry —
              then closes the loop. Detectors open Issues. Evals and live A/B score
              changes. The Improve queue proposes evidence-linked plans you review
              before anything ships. Capture stays; the second half is the product.
            </p>
            <p className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-5 sm:gap-y-2">
              <Link
                href="/why-eden"
                className="type-ui text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
              >
                Why Eden vs traces-only →
              </Link>
              <Link
                href="/ai-agent-observability"
                className="type-ui text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
              >
                AI agent observability →
              </Link>
              <Link
                href="/llm-observability-tools"
                className="type-ui text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
              >
                LLM observability tools →
              </Link>
            </p>
          </div>
        </MarketingRail>
      </section>

      <section className="relative overflow-hidden border-b border-[var(--line)] py-16 sm:py-24">
        <div
          className="pointer-events-none absolute inset-0 eden-product-plane opacity-[0.12]"
          aria-hidden
        />
        <MarketingRail className="relative grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-stretch lg:gap-12">
          <div className="lg:col-span-5">
            <MarketingKicker>Observe</MarketingKicker>
            <h2 className="mt-3 max-w-md text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.85rem]">
              Traces that survive production
            </h2>
            <p className="mt-4 max-w-md text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              Sessions group runs by user, agent, or deploy. Spans, detectors, and
              issues stay attached to that context so you triage failures without
              grepping logs or rebuilding alerts for every prompt version.
            </p>
          </div>
          <div className="lg:col-span-7">
            <ul className="overflow-hidden border border-[var(--line)] divide-y divide-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_3%,var(--bg))]">
              {[
                {
                  k: "Sessions",
                  v: "Group runs by user, agent, or deploy",
                  meta: "12 live",
                },
                {
                  k: "Detectors",
                  v: "Drift, latency, and cost thresholds",
                  meta: "3 firing",
                },
                {
                  k: "Issues",
                  v: "Deduped failures with first/last seen",
                  meta: "ISS-1842",
                },
              ].map((row, i) => (
                <li
                  key={row.k}
                  className="eden-fade-up flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-6"
                  style={{ animationDelay: `${i * 80}ms` }}
                >
                  <span className="w-28 shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-[var(--accent)]">
                    {row.k}
                  </span>
                  <span className="flex-1 type-ui text-[var(--text-muted)]">
                    {row.v}
                  </span>
                  <span className="font-mono text-[0.625rem] tabular-nums text-[var(--text-faint)]">
                    {row.meta}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </MarketingRail>
      </section>

      <section className="border-b border-[var(--line)] py-16 sm:py-24">
        <MarketingRail className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="order-2 lg:order-1 lg:col-span-6">
            <div className="relative overflow-hidden border border-[var(--line)] bg-[var(--bg)]">
              <div className="pointer-events-none absolute inset-0 eden-product-plane opacity-[0.2]" />
              <div className="relative border-b border-[var(--line)] px-5 py-3">
                <div className="flex justify-between font-mono text-[0.625rem] uppercase tracking-[0.16em]">
                  <span className="text-[var(--text-faint)]">Eval · prompt.v12</span>
                  <span className="text-[var(--success)]">Pass 0.91</span>
                </div>
              </div>
              <div className="relative grid grid-cols-2 gap-px bg-[var(--line)]">
                <div className="bg-[var(--bg)] p-5 sm:p-6">
                  <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--text-faint)]">
                    Control
                  </p>
                  <p className="mt-2 text-[2rem] font-semibold tabular-nums tracking-[-0.04em] text-[var(--text)]">
                    0.84
                  </p>
                  <div className="mt-4 h-1.5 w-full bg-[var(--line)]">
                    <div className="h-full w-[84%] bg-[var(--text-faint)]" />
                  </div>
                </div>
                <div className="bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg))] p-5 sm:p-6">
                  <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--text-faint)]">
                    Treatment
                  </p>
                  <p className="mt-2 text-[2rem] font-semibold tabular-nums tracking-[-0.04em] text-[var(--accent)]">
                    0.91
                  </p>
                  <div className="mt-4 h-1.5 w-full bg-[var(--line)]">
                    <div className="eden-bar-shimmer h-full w-[91%] bg-[linear-gradient(90deg,var(--accent),color-mix(in_srgb,var(--accent)_50%,transparent),var(--accent))] bg-[length:200%_100%]" />
                  </div>
                </div>
              </div>
              <p className="relative border-t border-[var(--line)] px-5 py-3 font-mono text-[0.625rem] text-[var(--text-faint)]">
                Live A/B · n=2,400 · pinned env: prod · Δ +0.07
              </p>
            </div>
          </div>
          <div className="order-1 flex flex-col justify-center lg:order-2 lg:col-span-6 lg:pl-4">
            <MarketingKicker>Evaluate</MarketingKicker>
            <h2 className="mt-3 max-w-md text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.85rem]">
              Prompts, datasets, live A/B
            </h2>
            <p className="mt-4 max-w-md text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              Version prompts, pin environments, and compare arms on the metrics
              that matter before you ship. Eval results sit next to the same
              sessions and issues you already use for incident triage — not a
              stranded scoring tool with a different identity model.
            </p>
          </div>
        </MarketingRail>
      </section>

      <section className="relative overflow-hidden border-b border-[var(--line)] py-16 sm:py-24">
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(ellipse_at_80%_40%,color-mix(in_srgb,var(--accent)_10%,transparent),transparent_65%)]"
          aria-hidden
        />
        <MarketingRail className="relative">
          <MarketingKicker>How it works</MarketingKicker>
          <h2 className="mt-3 max-w-2xl text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.85rem]">
            Close the loop from real failures
          </h2>
          <p className="mt-4 max-w-2xl text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            Instrument once. Detectors open Issues from production traffic. When
            it is safe, runtime self-heal can take reversible, budget-capped
            actions (opt out in Settings). Fix plans cite failing spans and eval
            deltas — you approve, reject, or snooze. Code patches stay human-gated.
          </p>
          <ol className="mt-10 grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
            {[
              {
                n: "01",
                t: "Detect",
                d: "Issue opens from a detector or manual triage — first/last seen, deduped fingerprint.",
                accent: false,
              },
              {
                n: "02",
                t: "Propose",
                d: "Plan cites the failing spans and eval delta. Heal when reversible and in budget.",
                accent: true,
              },
              {
                n: "03",
                t: "Ship",
                d: "Human review before merge — then re-observe the next deploy with the same instruments.",
                accent: false,
              },
            ].map((step) => (
              <li
                key={step.n}
                className={
                  step.accent
                    ? "bg-[color-mix(in_srgb,var(--accent)_7%,var(--bg))] p-5 sm:p-7"
                    : "bg-[var(--bg)] p-5 sm:p-7"
                }
              >
                <span className="font-mono text-[0.625rem] tabular-nums text-[var(--text-faint)]">
                  {step.n}
                </span>
                <p className="mt-3 text-[1.0625rem] font-medium tracking-[-0.015em] text-[var(--text)]">
                  {step.t}
                </p>
                <p className="mt-2 type-ui text-[var(--text-muted)]">{step.d}</p>
              </li>
            ))}
          </ol>
        </MarketingRail>
      </section>

      <section className="border-b border-[var(--line)] py-16 sm:py-24">
        <MarketingRail className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-5">
            <MarketingKicker>Install</MarketingKicker>
            <h2 className="mt-3 text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.85rem]">
              Instrument in a few lines
            </h2>
            <p className="mt-4 max-w-md text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              Install{" "}
              <code className="font-mono text-[0.875rem] text-[var(--text)]">
                eden-sdk
              </code>{" "}
              or point traffic at the OpenAI-compatible gateway.
            </p>
            <a
              href={DOCS_QUICKSTART_URL}
              className="mt-5 inline-block type-ui text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
              rel="noopener noreferrer"
            >
              Full quickstart →
            </a>
          </div>
          <div className="lg:col-span-7">
            <div className="overflow-hidden border border-[var(--line)] bg-[var(--bg)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--accent)_12%,transparent)]">
              <div className="flex items-center justify-between border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_4%,transparent)] px-4 py-2.5">
                <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
                  Python · pip install eden-sdk
                </span>
                <InstallSnippetCopy snippet={INSTALL_SNIPPET} />
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
                <code>{INSTALL_SNIPPET}</code>
              </pre>
            </div>
          </div>
        </MarketingRail>
      </section>

      {/* Integration surface — works with what you already run. */}
      <section className="border-b border-[var(--line)] py-12 sm:py-16">
        <MarketingRail className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
            Works with your stack
          </p>
          <ul className="flex flex-wrap gap-2">
            {STACK.map((item) => (
              <li key={item.label}>
                {item.href.startsWith("http") ? (
                  <a
                    href={item.href}
                    className="eden-stack-chip"
                    rel="noopener noreferrer"
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link href={item.href} className="eden-stack-chip">
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </MarketingRail>
      </section>

      {/* FAQ — native details/summary, no JS. Copy stays in sync with
          the FAQPage JSON-LD on the homepage via HOME_FAQ. */}
      <section className="relative border-b border-[var(--line)] py-16 sm:py-24">
        <MarketingRail className="max-w-3xl">
          <MarketingKicker>FAQ</MarketingKicker>
          <h2 className="mt-3 max-w-2xl text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.85rem]">
            Frequently asked questions
          </h2>
          <div className="mt-8 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {HOME_FAQ.map((item) => (
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
        </MarketingRail>
      </section>

      <section className="relative py-16 sm:py-28">
        <div
          className="pointer-events-none absolute inset-0 eden-product-plane opacity-[0.1]"
          aria-hidden
        />
        <MarketingRail className="relative">
          <div className="flex flex-col items-start gap-8 overflow-hidden border border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_5%,var(--bg))] px-6 py-10 sm:flex-row sm:items-end sm:justify-between sm:px-10 sm:py-14">
            <div>
              <MarketingKicker>Start</MarketingKicker>
              <h2 className="mt-3 max-w-lg text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.85rem]">
                Instrument today. Improve tomorrow.
              </h2>
              <p className="mt-3 max-w-md text-[0.9375rem] text-[var(--text-muted)]">
                Free during public beta — no credit card.
              </p>
            </div>
            <MarketingPrimaryCta
              className="px-6"
            />
          </div>
        </MarketingRail>
      </section>
    </>
  );
}

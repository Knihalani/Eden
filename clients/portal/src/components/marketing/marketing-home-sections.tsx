import Link from "next/link";
import { MarketingKicker, MarketingRail } from "@/components/marketing/marketing-primitives";
import { InstallSnippetCopy } from "@/components/marketing/install-snippet-copy";
import { INSTALL_SNIPPET } from "@/components/marketing/install-snippet";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

/**
 * Below-fold sections — one job each, asymmetric layouts (not identical cards).
 * Server component; only the copy button is a client island.
 */
export function MarketingHomeSections() {
  return (
    <>
      <section className="border-b border-[var(--line)] py-16 sm:py-24">
        <MarketingRail className="grid gap-10 lg:grid-cols-12 lg:gap-12 lg:items-end">
          <div className="lg:col-span-5">
            <MarketingKicker>Observe</MarketingKicker>
            <h2 className="mt-3 max-w-md text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.75rem]">
              Traces that survive production
            </h2>
            <p className="mt-4 max-w-md text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              Sessions, spans, detectors, and issues — grouped so you can triage
              failures without grepping logs.
            </p>
          </div>
          <div className="lg:col-span-7">
            <ul className="border border-[var(--line)] divide-y divide-[var(--line)]">
              {[
                { k: "Sessions", v: "Group runs by user, agent, or deploy" },
                { k: "Detectors", v: "Drift, latency, and cost thresholds" },
                { k: "Issues", v: "Deduped failures with first/last seen" },
              ].map((row) => (
                <li
                  key={row.k}
                  className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-baseline sm:gap-6"
                >
                  <span className="w-28 shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-[var(--accent)]">
                    {row.k}
                  </span>
                  <span className="type-ui text-[var(--text-muted)]">{row.v}</span>
                </li>
              ))}
            </ul>
          </div>
        </MarketingRail>
      </section>

      <section className="border-b border-[var(--line)] py-16 sm:py-24">
        <MarketingRail className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="order-2 lg:order-1 lg:col-span-6">
            <div className="border border-[var(--line)] p-5 font-mono text-[0.75rem] leading-relaxed text-[var(--text-muted)] sm:p-6">
              <div className="flex justify-between text-[0.625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                <span>Eval · prompt.v12</span>
                <span className="text-[var(--success)]">Pass 0.91</span>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[0.625rem] uppercase tracking-[0.14em] text-[var(--text-faint)]">
                    Control
                  </p>
                  <p className="mt-1 text-[1.25rem] tabular-nums text-[var(--text)]">
                    0.84
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] uppercase tracking-[0.14em] text-[var(--text-faint)]">
                    Treatment
                  </p>
                  <p className="mt-1 text-[1.25rem] tabular-nums text-[var(--accent)]">
                    0.91
                  </p>
                </div>
              </div>
              <p className="mt-5 text-[0.625rem] text-[var(--text-faint)]">
                Live A/B · n=2,400 · pinned env: prod
              </p>
            </div>
          </div>
          <div className="order-1 lg:order-2 lg:col-span-6 lg:pl-4">
            <MarketingKicker>Evaluate</MarketingKicker>
            <h2 className="mt-3 max-w-md text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.75rem]">
              Prompts, datasets, live A/B
            </h2>
            <p className="mt-4 max-w-md text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              Version prompts, pin environments, and compare arms on the metrics
              that matter before you ship.
            </p>
          </div>
        </MarketingRail>
      </section>

      <section className="border-b border-[var(--line)] py-16 sm:py-24">
        <MarketingRail>
          <MarketingKicker>Improve</MarketingKicker>
          <h2 className="mt-3 max-w-2xl text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.75rem]">
            Close the loop from real failures
          </h2>
          <p className="mt-4 max-w-2xl text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            Plans from traces you already have. Approve, reject, or snooze —
            then watch the next deploy with the same instruments.
          </p>
          <ol className="mt-10 grid gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
            {[
              { n: "01", t: "Detect", d: "Issue opens from a detector or manual triage." },
              { n: "02", t: "Propose", d: "Plan cites the failing spans and eval delta." },
              { n: "03", t: "Ship", d: "Human review — then re-observe the next run." },
            ].map((step) => (
              <li key={step.n} className="bg-[var(--bg)] p-5 sm:p-6">
                <span className="font-mono text-[0.625rem] tabular-nums text-[var(--text-faint)]">
                  {step.n}
                </span>
                <p className="mt-2 text-[0.9375rem] font-medium tracking-[-0.01em] text-[var(--text)]">
                  {step.t}
                </p>
                <p className="mt-2 type-ui text-[var(--text-muted)]">{step.d}</p>
              </li>
            ))}
          </ol>
        </MarketingRail>
      </section>

      <section className="border-b border-[var(--line)] py-16 sm:py-24">
        <MarketingRail>
          <MarketingKicker>Install</MarketingKicker>
          <h2 className="mt-3 text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.75rem]">
            Instrument in a few lines
          </h2>
          <p className="mt-4 max-w-xl text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            Install{" "}
            <code className="font-mono text-[0.875rem] text-[var(--text)]">
              eden-sdk
            </code>{" "}
            or point traffic at the OpenAI-compatible gateway.
          </p>
          <div className="mt-8 max-w-2xl overflow-hidden border border-[var(--line)] bg-[var(--bg)]">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-2">
              <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
                Python · pip install eden-sdk
              </span>
              <InstallSnippetCopy snippet={INSTALL_SNIPPET} />
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
              <code>{INSTALL_SNIPPET}</code>
            </pre>
          </div>
          <a
            href={DOCS_QUICKSTART_URL}
            className="mt-4 inline-block type-ui text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
            rel="noopener noreferrer"
          >
            Full quickstart →
          </a>
        </MarketingRail>
      </section>

      <section className="py-16 sm:py-28">
        <MarketingRail className="flex flex-col items-start gap-8 border border-[var(--line)] px-6 py-10 sm:flex-row sm:items-end sm:justify-between sm:px-10 sm:py-12">
          <div>
            <MarketingKicker>Start</MarketingKicker>
            <h2 className="mt-3 max-w-lg text-[1.5rem] font-semibold tracking-[-0.025em] text-[var(--text)] sm:text-[1.75rem]">
              Instrument today. Improve tomorrow.
            </h2>
          </div>
          <Link href="/sign-up" className="ds-btn ds-btn-primary px-5">
            Get started
          </Link>
        </MarketingRail>
      </section>
    </>
  );
}

import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_QUICKSTART_URL, DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/llm-observability-tools",
  title: "LLM Observability Tools — Traces, Evals, Gateways, Closed Loop",
  description:
    "A fair roundup of LLM observability tools by category: traces-only, evals, gateways, and closed-loop ops. Where Eden fits and how to choose.",
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

const CATEGORIES = [
  {
    t: "Traces-only",
    d: "Store and explore spans, sessions, and sometimes scores. Excellent for reconstruction. You still own detection rules, mitigation, and the path to a merged fix.",
    examples: "Langfuse-class open tracing; platform APM with LLM attributes.",
  },
  {
    t: "Evals-first",
    d: "Datasets, scored experiments, and quality workflows as the daily habit. Strong when offline and online scoring drive shipping decisions.",
    examples: "Braintrust-class eval platforms.",
  },
  {
    t: "Gateways / proxies",
    d: "OpenAI-compatible or proxy paths for request logs, spend, cache, and low-friction capture without rewriting callers.",
    examples: "Helicone-class proxy analytics; Eden gateway as ingest.",
  },
  {
    t: "Closed-loop",
    d: "Ingest plus detect → optional heal → reviewable fix plans. Capture remains; the second half is the product.",
    examples: "Eden — observe, evaluate, improve in one surface.",
  },
] as const;

export default function LlmObservabilityToolsPage() {
  return (
    <main>
      <MarketingShell
        kicker="LLM observability tools"
        title="Pick the category that matches the bottleneck."
        lead="“Best LLM observability tools” lists blur jobs that are not the same. Separate traces-only, evals-first, gateway/proxy, and closed-loop products — then shortlist. Eden sits in closed-loop while still speaking gateway, SDKs, and OpenTelemetry."
      >
        <div className="max-w-3xl space-y-14">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "4", k: "Fair categories" },
              { v: "≤5ms", k: "Eden gateway overhead" },
              { v: "OTel", k: "Shared ingest idea" },
              { v: "Free", k: "Eden public beta" },
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
            <SectionKicker>How to read this</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Roundups fail when they ignore the job
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Most “tools for LLM observability” articles flatten every
                product into a feature checklist: traces? prompts? evals?
                alerts? That grid is useful for inventory and useless for
                decisions. A traces-only store and a closed-loop ops product
                can both check “tracing” while solving different weeks of your
                on-call. Start with the bottleneck: seeing traffic, scoring
                quality, capturing spend with low friction, or turning
                production failures into controlled action.
              </p>
              <p>
                This roundup uses four fair categories. Products can span more
                than one — Eden overlaps on gateway ingest and eval surfaces
                while positioning on closed loop. We do not invent competitor
                pricing, SOC2 theater, or fake benchmarks. Where Eden makes a
                latency claim, it is the published one: gateway overhead ≤5ms
                at p95 on the path we publish.
              </p>
              <p>
                For category framing of agent ops, see{" "}
                <Link href="/ai-agent-observability" className={linkClass}>
                  AI agent observability
                </Link>
                . For positioning thesis,{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Categories</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Four categories of LLM observability tools
            </h2>
            <ol className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
              {CATEGORIES.map((item, i) => (
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
                  <p className="mt-3 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-[var(--text-faint)]">
                    Examples
                  </p>
                  <p className="mt-1 text-[0.875rem] text-[var(--text-secondary)]">
                    {item.examples}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <section className="space-y-5">
            <SectionKicker>Traces-only</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              When traces-only tools are enough
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Choose traces-only when your immediate job is instrumentation
                depth and exploration: reconstruct agent runs, browse sessions,
                attach scores, and own alerting elsewhere. Open, self-hostable
                tracing (Langfuse-class) is a strong fit when residency and
                platform ownership dominate. If that describes you, you may not
                need a closed-loop product yet — and that is a valid outcome of
                this roundup. Traces remain table stakes even when you later
                add closed loop; the mistake is assuming a prettier span viewer
                will close production incidents by itself.
              </p>
              <p>
                Shopping alternatives? Use criteria-first pages:{" "}
                <Link href="/langfuse-alternatives" className={linkClass}>
                  Langfuse alternatives
                </Link>{" "}
                and the deep dive{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  Eden vs Langfuse
                </Link>
                . Dual-running a traces store and a closed-loop product during
                migration is common and rational.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Evals & gateways</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Evals-first and gateway/proxy tools
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Evals-first tools win when datasets, experiments, and scored
                comparisons are how your team ships quality. Braintrust-class
                products center that habit. Eden includes prompts, datasets,
                and live A/B alongside Issues — but if evals UX is the entire
                job, compare fairly via{" "}
                <Link href="/vs/braintrust" className={linkClass}>
                  Eden vs Braintrust
                </Link>
                .
              </p>
              <p>
                Gateway and proxy tools win when you need spend and request
                visibility with minimal code change. Helicone-class proxies are
                built for that path. Eden’s{" "}
                <Link
                  href="/openai-compatible-gateway"
                  className={linkClass}
                >
                  OpenAI-compatible gateway
                </Link>{" "}
                is an ingest line into closed loop — not a claim that proxy
                analytics alone is the product. Compare{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Eden vs Helicone
                </Link>{" "}
                and{" "}
                <Link href="/helicone-alternatives" className={linkClass}>
                  Helicone alternatives
                </Link>
                . For platform-native export, see{" "}
                <Link
                  href="/opentelemetry-llm-tracing"
                  className={linkClass}
                >
                  OpenTelemetry LLM tracing
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Closed loop</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Where Eden sits in the roundup
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Eden’s category is closed-loop LLM observability for AI agents
                and apps. Ingest via gateway, SDKs, or OpenTelemetry. Detectors
                open Issues for drift, latency, and cost. Runtime self-heal can
                take reversible, budget-capped actions (on by default; opt out
                in Settings). Fix now drafts evidence-linked plans; humans
                review before merge. Code patches and auto-merge stay gated.
                Autonomy audit records allow, deny, and budget. Eden runs on
                Eden — dogfood is part of the trust story.
              </p>
              <p>
                Position Eden when the bottleneck is turning production
                failures into controlled mitigations and reviewable fixes —
                not when you only need another span viewer. Free during public
                beta — no credit card. Start with the{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  docs quickstart
                </a>
                , skim{" "}
                <Link href="/pricing" className={linkClass}>
                  pricing
                </Link>
                , and read{" "}
                <a
                  href={DOCS_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  the docs
                </a>{" "}
                for install and security model.
              </p>
            </div>
            <div className="overflow-hidden border border-[var(--line)]">
              <table className="w-full text-left text-[0.875rem]">
                <thead>
                  <tr className="border-b border-[var(--line)] bg-[var(--bg-inset)]">
                    <th className="type-label px-4 py-3 font-normal">
                      If your bottleneck is…
                    </th>
                    <th className="type-label px-4 py-3 font-normal">
                      Lean toward…
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      b: "Deep trace exploration / self-host",
                      t: "Traces-only (e.g. Langfuse-class)",
                    },
                    {
                      b: "Datasets & scored experiments",
                      t: "Evals-first (e.g. Braintrust-class)",
                    },
                    {
                      b: "Spend & proxy capture this week",
                      t: "Gateway/proxy (e.g. Helicone-class or Eden gateway)",
                    },
                    {
                      b: "Detect → heal → fix with proof",
                      t: "Closed-loop (Eden)",
                    },
                  ].map((row) => (
                    <tr
                      key={row.b}
                      className="border-b border-[var(--line)] last:border-b-0"
                    >
                      <td className="px-4 py-3 text-[var(--text)]">{row.b}</td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">
                        {row.t}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Buyer checklist</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              A practical checklist before you shortlist
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Write down the failure mode that hurt you last month. Was it
                invisible spend after a model change? A silent quality
                regression with perfect HTTP 200s? An agent tool loop that only
                shows up in production? Match that failure to a category before
                you open another tab of logos. Invisible spend points at
                gateway/proxy visibility. Silent quality regressions point at
                evals plus production detection. Tool loops that need
                mitigation point at closed-loop ops.
              </p>
              <p>
                Inventory ingest constraints next. If every service already
                speaks OpenAI clients, a gateway is the shortest path — see{" "}
                <Link
                  href="/openai-compatible-gateway"
                  className={linkClass}
                >
                  OpenAI-compatible gateway
                </Link>
                . If the platform team owns OpenTelemetry collectors, start
                from{" "}
                <Link
                  href="/opentelemetry-llm-tracing"
                  className={linkClass}
                >
                  OpenTelemetry LLM tracing
                </Link>
                . If agent graphs live in one repo and you can annotate tools
                in code, SDKs may win. Mixing paths is allowed; purity is not
                the goal.
              </p>
              <p>
                Finally, decide whether capture is the finish line. If yes,
                traces-only or proxy analytics may be enough — and this roundup
                should help you stop shopping. If no — if you need Issues,
                reversible heal, and evidence-linked fix plans — put closed-loop
                products at the top of the shortlist and use vs pages for
                honest tradeoffs. Free during public beta means Eden can be
                tried on one path without turning the evaluation into a
                procurement saga.
              </p>
              <p>
                For stakeholder language that separates “we have spans” from
                “we operate agents,” share{" "}
                <Link href="/ai-agent-observability" className={linkClass}>
                  AI agent observability
                </Link>
                . For criteria-first alternative shopping, use{" "}
                <Link href="/langfuse-alternatives" className={linkClass}>
                  Langfuse alternatives
                </Link>{" "}
                and{" "}
                <Link href="/helicone-alternatives" className={linkClass}>
                  Helicone alternatives
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Next</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Continue with fair comparisons
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Roundups should end in experiments, not logos. Instrument one
                path, measure whether detection and fix workflow shrink pager
                glue, and keep tools that still earn their keep for historical
                traces or eval habits. Deep dives:{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  vs Langfuse
                </Link>
                ,{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  vs Helicone
                </Link>
                ,{" "}
                <Link href="/vs/braintrust" className={linkClass}>
                  vs Braintrust
                </Link>
                . Re-read{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>{" "}
                if you need the closed-loop thesis in one place before you
                schedule vendor calls. The goal of this page is category
                clarity — so you stop comparing products that were never aimed
                at the same bottleneck.
              </p>
            </div>
            <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  href: "/why-eden",
                  t: "Why Eden",
                  d: "Closed-loop vs traces-only thesis.",
                },
                {
                  href: "/langfuse-alternatives",
                  t: "Langfuse alternatives",
                  d: "Criteria-first shortlist.",
                },
                {
                  href: "/helicone-alternatives",
                  t: "Helicone alternatives",
                  d: "Proxy-first buyer guide.",
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
                Choose a category. Prove it on one path.
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

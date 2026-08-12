import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_QUICKSTART_URL, DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/opentelemetry-llm-tracing",
  title: "OpenTelemetry LLM Tracing for Production Agents — Eden",
  description:
    "How OpenTelemetry fits LLM and agent tracing: Eden’s OTel ingest, when to use OTel vs gateway vs SDK, and how traces feed closed-loop ops.",
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

export default function OpentelemetryLlmTracingPage() {
  return (
    <main>
      <MarketingShell
        kicker="OpenTelemetry LLM tracing"
        title="OTel is a first-class ingest path — not a side door."
        lead="If your platform already speaks OpenTelemetry, Eden meets you there. LLM and tool spans land beside the rest of your stack language, then feed detectors, Issues, and reviewable fixes — not a dead-end trace store."
      >
        <div className="max-w-3xl space-y-14">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "OTel", k: "Ingest protocol" },
              { v: "SDK", k: "Python · TypeScript" },
              { v: "≤5ms", k: "Gateway alternative path" },
              { v: "Closed", k: "Observe → Improve" },
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
            <SectionKicker>Why OTel</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Why teams want OpenTelemetry for LLM apps
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                OpenTelemetry became the lingua franca of application
                observability: one instrumentation model, many backends,
                portable context across services. LLM applications need the
                same portability. Agents call models from multiple services,
                fan into tools, and share request context with the rest of the
                product. If LLM spans only live in a proprietary viewer while
                everything else is OTel, you rebuild correlation by hand.
              </p>
              <p>
                Teams also want vendor optionality. Exporting OTel means you
                can change where traces land without rewriting every
                instrumented call site. For LLM workloads that means model
                spans, tool spans, and session-like grouping can travel the same
                export path as HTTP and database spans — with attributes that
                encode tokens, models, and prompt versions instead of inventing
                a parallel telemetry dialect.
              </p>
              <p>
                Eden treats OpenTelemetry as a first-class ingest protocol
                alongside the OpenAI-compatible gateway and SDKs. That is an
                existing product claim across home, Why Eden, and comparison
                pages — not a new protocol invention for this article. The job
                of this page is to explain how OTel fits LLM tracing and how
                Eden continues past capture into closed-loop ops.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>LLM spans</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What “LLM tracing” adds on top of generic OTel
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Generic distributed tracing answers “which service was slow?”
                LLM tracing answers “which prompt version, model, tool, and
                session produced this failure — and what should we change?”
                That requires attributes and grouping that generic RED metrics
                do not carry: token counts, model IDs, tool names, eval scores,
                deploy or prompt versions, and session identity for the user or
                agent run.
              </p>
              <p>
                Agent graphs make this sharper. A single turn can nest multiple
                model calls and tool invocations. Without session grouping and
                durable issue identity, OTel backends become another place to
                grep. Eden attaches production context so spans feed detectors
                for drift, latency, and cost — and Issues with first/last seen
                and deduped fingerprints — instead of leaving you to wire pager
                rules for every new prompt version.
              </p>
              <p>
                Tracing is still the starting line. OTel ingest does not, by
                itself, heal reversible failures or open evidence-linked fix
                plans. Those are product surfaces on top of the span stream.
                See{" "}
                <Link href="/ai-agent-observability" className={linkClass}>
                  AI agent observability
                </Link>{" "}
                for why traces alone leave production teams grepping, and{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>{" "}
                for the closed-loop thesis.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Fit</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              How Eden fits OTel next to gateway and SDKs
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Choose OTel when platform standards already require it, when
                you want LLM spans beside service traces in one mental model,
                or when exporters and collectors are already running. Choose
                the{" "}
                <Link
                  href="/openai-compatible-gateway"
                  className={linkClass}
                >
                  OpenAI-compatible gateway
                </Link>{" "}
                when you need capture without rewriting callers — including
                spend, tokens, models, and cache hit rates — with ≤5ms gateway
                overhead p95 on the published path. Choose SDKs when you want
                spans and tool calls annotated directly in Python or TypeScript
                agent code.
              </p>
              <p>
                Mixing paths is normal. A platform team may export OTel from
                core services while product teams point OpenAI clients at the
                gateway for fast coverage. Eden’s claim is stack coverage —
                SDKs, gateway, OTel ingest, and a REST API — not a mandate to
                pick exactly one forever. Free during public beta — no credit
                card — keeps the experiment cheap.
              </p>
            </div>
            <div className="overflow-hidden border border-[var(--line)]">
              <table className="w-full text-left text-[0.875rem]">
                <thead>
                  <tr className="border-b border-[var(--line)] bg-[var(--bg-inset)]">
                    <th className="type-label px-4 py-3 font-normal">Path</th>
                    <th className="type-label px-4 py-3 font-normal">
                      Best when
                    </th>
                    <th className="type-label px-4 py-3 font-normal">
                      Continues into
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      path: "OpenTelemetry",
                      best: "Platform already speaks OTel",
                      next: "Detectors → Issues → heal / Fix now",
                    },
                    {
                      path: "Gateway",
                      best: "OpenAI-compatible clients, low friction",
                      next: "Same closed loop after capture",
                    },
                    {
                      path: "SDKs",
                      best: "Annotate tools & sessions in code",
                      next: "Same closed loop after capture",
                    },
                  ].map((row) => (
                    <tr
                      key={row.path}
                      className="border-b border-[var(--line)] last:border-b-0"
                    >
                      <td className="px-4 py-3 text-[var(--text)]">
                        {row.path}
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">
                        {row.best}
                      </td>
                      <td className="px-4 py-3 text-[var(--text)]">
                        {row.next}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Closed loop</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              From OTel spans to detect, heal, and fix
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Once spans land, Eden’s product thesis takes over. Detectors
                watch drift, latency, and cost. Failures open as Issues so you
                are not reinventing alerting for every agent. Runtime self-heal
                can intervene for reversible, budget-capped actions — on by
                default for those safe actions, opt out in Settings. The Fix
                now queue cites failing spans and eval deltas; humans approve
                before merge. Code patches and auto-merge stay gated. Autonomy
                audit records allow, deny, and budget.
              </p>
              <p>
                That is the difference between “we export OTel to a store” and
                “we operate agents with a closed loop.” Traces-only OTel
                backends remain excellent for exploration and platform
                correlation. Eden overlaps on ingest compatibility and
                continues into action. Compare fairly with{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  Eden vs Langfuse
                </Link>
                ,{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Eden vs Helicone
                </Link>
                , and{" "}
                <Link href="/vs/braintrust" className={linkClass}>
                  Eden vs Braintrust
                </Link>
                . For a roundup across categories, see{" "}
                <Link href="/llm-observability-tools" className={linkClass}>
                  LLM observability tools
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Attributes</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Attributes that make LLM OTel useful
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Useful LLM traces carry more than span names. Model identity,
                token counts, latency, prompt or deploy version, tool names,
                error classes, and session or user keys turn a generic
                waterfall into something an agent team can act on. Without
                those attributes, OpenTelemetry still correlates services — it
                just will not answer “which prompt regresses after Friday’s
                ship?”
              </p>
              <p>
                Session grouping is equally important. Agent runs are not
                always one HTTP request. They are trees of model and tool
                calls that may cross workers. If your export loses the thread
                that ties those spans together, detectors and Issues cannot
                dedupe failures cleanly, and Fix now cannot cite a coherent
                failing path. Plan identity early: how will a user turn, an
                agent name, and a deploy SHA travel with the span context?
              </p>
              <p>
                Eden’s closed loop depends on that context landing with the
                span. Detectors for drift, latency, and cost need stable
                signals. Evidence-linked fix plans need failing spans you can
                point to. OTel is the transport; the product job is still
                observe → detect → heal when safe → fix with proof. For buyers
                comparing categories, see{" "}
                <Link href="/llm-observability-tools" className={linkClass}>
                  LLM observability tools
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Start</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Practical next steps
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                If OTel is already running, plan LLM attributes and session
                identity before you chase another dashboard. Export a single
                high-traffic agent path, confirm spans arrive with the context
                you need, enable detectors, and measure whether Issues reduce
                homemade alert glue. Use the{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  docs quickstart
                </a>{" "}
                and broader{" "}
                <a
                  href={DOCS_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  documentation
                </a>{" "}
                for install details. Check{" "}
                <Link href="/pricing" className={linkClass}>
                  pricing
                </Link>{" "}
                for Free during public beta limits.
              </p>
              <p>
                We do not invent SOC2 badges, customer logos, or unpublished
                OTel benchmark numbers on this page. Honest claims only: OTel
                as a first-class ingest path, gateway and SDKs as siblings,
                ≤5ms gateway overhead p95 when you use the gateway path, and a
                closed loop that keeps heal reversible and fix plans gated.
              </p>
            </div>
            <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  href: DOCS_URL,
                  t: "Docs",
                  d: "Ingest, security model, references.",
                  external: true,
                },
                {
                  href: "/openai-compatible-gateway",
                  t: "Gateway",
                  d: "When base-URL capture is faster.",
                },
                {
                  href: "/why-eden",
                  t: "Why Eden",
                  d: "Closed loop after the span lands.",
                },
              ].map((item) => (
                <li key={item.href} className="bg-[var(--bg)] p-5">
                  {item.external ? (
                    <a
                      href={item.href}
                      className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--accent)] hover:text-[var(--accent-hover)]"
                      rel="noopener noreferrer"
                    >
                      {item.t}
                    </a>
                  ) : (
                    <Link
                      href={item.href}
                      className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--accent)] hover:text-[var(--accent-hover)]"
                    >
                      {item.t}
                    </Link>
                  )}
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
                Export OTel. Keep the loop.
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

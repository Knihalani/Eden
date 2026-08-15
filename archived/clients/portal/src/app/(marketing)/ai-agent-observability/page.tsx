import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_QUICKSTART_URL, DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/ai-agent-observability",
  title: "AI Agent Observability — Beyond Traces to Closed Loop",
  description:
    "What AI agent observability is, why traces alone are not enough, and how Eden closes the loop with detect, heal, and reviewable fix plans.",
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

export default function AiAgentObservabilityPage() {
  return (
    <main>
      <MarketingShell
        kicker="AI agent observability"
        title="Traces show the run. Observability closes the loop."
        lead="AI agent observability is the practice of seeing every LLM and tool call in production context — then detecting failures, mitigating when safe, and shipping reviewable fixes. Eden starts at the same ingest line as traces-only tools and continues into closed-loop ops."
      >
        <div className="max-w-3xl space-y-14">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "≤5ms", k: "Gateway overhead" },
              { v: "OTel", k: "Ingest protocol" },
              { v: "Closed", k: "Observe → Improve" },
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

          <section className="space-y-5">
            <SectionKicker>Definition</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What AI agent observability means
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                AI agent observability is how you understand and operate systems
                that call language models, tools, and retrieval steps on behalf
                of users. Unlike a single chat completion, an agent run is a
                graph: prompts, model choices, tool invocations, retries, and
                downstream effects that may span minutes and many spans. Seeing
                that graph in production — with sessions grouped by user, agent,
                or deploy — is the starting requirement.
              </p>
              <p>
                In practice, teams mean more than “pretty spans.” They need
                production context attached to every LLM and tool call: which
                prompt version ran, which model answered, how much tokens and
                latency cost, whether a tool failed, and whether the session
                recovered. That is the observe surface. Without it, every
                incident becomes log archaeology across vendor dashboards and
                application logs that were never designed to answer agent
                questions.
              </p>
              <p>
                Observability for agents also includes the second half of the
                job: noticing when quality drifts after a deploy, intervening
                when a mitigation is safe and reversible, and turning a failing
                span into a reviewable fix plan instead of a Slack thread and a
                manual PR. Capture alone is not observability for production
                agents — it is instrumentation. The product question is whether
                your stack stops at the dashboard or continues into detect,
                heal, and fix with proof.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Gap</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Why traces are not enough
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Traces are table stakes. They store what happened: the span
                tree, token counts, latencies, and sometimes scores. When an
                agent misbehaves after a model swap or a prompt edit, traces
                help you reconstruct the failure. They do not, by themselves,
                open Issues with durable fingerprints, apply budget-capped
                runtime mitigations, or draft evidence-linked fix plans you
                approve before merge. Those steps still live in pager glue,
                runbooks, and IDE archaeology — outside the product that
                captured the span.
              </p>
              <p>
                Agent traffic multiplies the problem. One user session can fan
                out into dozens of tool calls and nested model requests. A
                traces-only viewer shows the tree; your on-call still owns
                thresholds, alert routing, mitigation playbooks, and the path
                from a bad span to a merged change. That stack works until
                prompt versions, tools, and models multiply and every incident
                becomes a custom investigation. The bottleneck shifts from
                “can we see traffic?” to “can we turn production failures into
                controlled action?”
              </p>
              <p>
                This is why category SERPs fill with comparison and “best
                tools” pages: buyers already know they need tracing. They are
                evaluating whether a product closes the loop or leaves them to
                wire it. Read{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>{" "}
                for the closed-loop thesis, and{" "}
                <Link href="/llm-observability-tools" className={linkClass}>
                  LLM observability tools
                </Link>{" "}
                for a fair shortlist across traces-only, evals, gateways, and
                closed-loop categories.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Closed loop</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Eden&apos;s closed-loop angle
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Eden starts at the same ingest line as traces-first stacks:
                Python or TypeScript SDKs, OpenTelemetry, or the
                OpenAI-compatible gateway. Gateway overhead stays ≤5ms at p95
                on the path we publish. Sessions group runs so production
                context stays attached to the span tree. From there the product
                is the loop — not a thicker dashboard.
              </p>
              <p>
                Detectors watch drift, latency, and cost and open Issues with
                first/last seen and deduped fingerprints so repeats collapse
                instead of flooding. When an action is reversible and within
                budget, runtime self-heal can intervene automatically. Heal is
                on by default for those safe actions; you can opt out anytime
                in Settings. Code patches and auto-merge stay gated. The Fix
                now queue drafts plans cited to failing spans and eval deltas —
                you approve, reject, or snooze with evidence tiers in front of
                merge.
              </p>
              <p>
                Autonomy audit in Settings records allow, deny, and budget so
                platform owners can answer what Eden was permitted to do
                without grepping logs. Eden runs on Eden: our own agents are
                customers of the same detectors, Issues, heal path, and fix
                queue. That does not replace your review habits; it means the
                closed-loop claims are exercised on real agent traffic.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Ingest</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              How teams instrument agent traffic
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Most production agents already speak an OpenAI-compatible
                client or an OpenTelemetry pipeline. Eden meets you there. Use
                the gateway when you want capture without rewriting callers —
                spend, tokens, models, and cache hit rates per workspace. Use
                SDKs when you want spans and tool calls annotated in code. Use
                OTel when your platform already exports traces. Details:{" "}
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
                .
              </p>
              <p>
                Install stays short. Free during public beta — no credit card —
                so production instrumentation is not a procurement project.
                Follow the{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  docs quickstart
                </a>{" "}
                to get from signup to first trace, then point a high-traffic
                agent path at ingest and turn on detectors. The experiment that
                matters is whether Issues and Fix now reduce pager glue — not
                whether another span viewer looks familiar.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Compare</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              How Eden sits next to traces-only tools
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Honest positioning beats category land grabs. Langfuse is
                strong for open, self-hostable tracing and prompt workflows.
                Helicone shines as a proxy-first path to request logs and
                spend. Braintrust fits when evals and scored experiments are
                the center of quality. Eden overlaps on ingest — you still get
                traces, sessions, and production context — but the thesis is
                closed-loop operations. Fair deep dives:{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  Eden vs Langfuse
                </Link>
                ,{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Eden vs Helicone
                </Link>
                ,{" "}
                <Link href="/vs/braintrust" className={linkClass}>
                  Eden vs Braintrust
                </Link>
                . Shortlists for buyers exploring alternatives:{" "}
                <Link href="/langfuse-alternatives" className={linkClass}>
                  Langfuse alternatives
                </Link>{" "}
                and{" "}
                <Link href="/helicone-alternatives" className={linkClass}>
                  Helicone alternatives
                </Link>
                .
              </p>
              <p>
                Many teams run more than one system during migration. Keep a
                traces-only store for historical exploration or residency
                constraints while pointing new agent traffic at Eden for
                detectors, heal, and Fix now. Dual ingest for a season is a
                rational ops choice. Consolidate when one surface covers both
                jobs — or keep both if open self-hosting and closed-loop heal
                remain separate constraints. See{" "}
                <Link href="/pricing" className={linkClass}>
                  pricing
                </Link>{" "}
                for Free during public beta limits.
              </p>
            </div>
            <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  href: "/why-eden",
                  t: "Why Eden",
                  d: "Closed-loop thesis vs traces-only stacks.",
                },
                {
                  href: DOCS_QUICKSTART_URL,
                  t: "Quickstart",
                  d: "Signup to first trace in minutes.",
                  external: true,
                },
                {
                  href: "/llm-observability-tools",
                  t: "Tool roundup",
                  d: "Traces, evals, gateways, closed-loop categories.",
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

          <section className="space-y-5">
            <SectionKicker>Trust</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Control without inventing compliance theater
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Closed loop only works if autonomy is visible and reversible.
                Runtime heal is limited to reversible actions, budget-capped,
                and covered by a full audit trail. We do not invent SOC2
                badges, customer logos, or competitor pricing numbers on this
                page. What we claim is what ships: gateway and SDK ingest,
                OpenTelemetry, ≤5ms gateway overhead p95 on the published path,
                detectors → Issues, heal with opt-out, and gated fix plans.
              </p>
              <p>
                Telemetry stays scoped to your organization; retention and PII
                filtering are controlled from Settings, with export or deletion
                available when you need them. Eden does not sell personal
                information. For install details and security model,{" "}
                <a
                  href={DOCS_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  read the docs
                </a>
                .
              </p>
            </div>
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
                Instrument an agent. Close the loop.
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

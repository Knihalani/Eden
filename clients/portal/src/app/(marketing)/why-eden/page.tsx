import type { ReactNode } from "react";
import Link from "next/link";
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

const LOOP_STEPS = [
  {
    n: "01",
    t: "Ingest",
    d: "Python or TypeScript SDKs, OpenTelemetry, or the OpenAI-compatible gateway capture every LLM and tool call with ≤5ms gateway overhead p95. Sessions group runs by user, agent, or deploy so production context stays attached to the span tree.",
  },
  {
    n: "02",
    t: "Detect",
    d: "Detectors watch drift, latency, and cost thresholds. Failures open as Issues with first/last seen and deduped fingerprints — triage without grepping logs or wiring a separate pager stack for every new prompt version.",
  },
  {
    n: "03",
    t: "Heal",
    d: "When an action is reversible and within budget, runtime self-heal can intervene automatically. Heal is on by default for those safe actions; you can opt out anytime in Settings. Code patches and auto-merge stay gated.",
  },
  {
    n: "04",
    t: "Fix with proof",
    d: "The Fix now queue drafts plans cited to failing spans and eval deltas. You approve, reject, or snooze. Evidence tiers sit in front of merge so humans review before anything ships to production.",
  },
] as const;

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
      {children}
    </p>
  );
}

export default function WhyEdenPage() {
  return (
    <main>
      <MarketingShell
        kicker="Why Eden"
        title="Traces are table stakes. Closed loop is the product."
        lead="Langfuse, Helicone, and Braintrust help you see LLM traffic. Eden detects failures, heals when it is safe, and opens proven fix plans — heal on by default, opt out in Settings."
      >
        <div className="max-w-3xl space-y-14">
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

          <section className="space-y-5">
            <SectionKicker>Who it is for</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Teams shipping LLM apps in production
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Eden is for engineering and platform teams who already run
                language-model features in production — support agents, coding
                copilots, retrieval apps, workflow automations — and need more
                than a pretty trace viewer when something drifts after a deploy.
                If your week includes unexplained latency spikes, silent quality
                regressions, or cost cliffs after a model swap, you are past the
                “just log prompts” phase.
              </p>
              <p>
                The common pattern: a team instruments an LLM SDK, ships a
                gateway or proxy for spend visibility, and still spends evenings
                stitching dashboards to alerts to tickets to pull requests. Capture
                is solved. Closing the loop — observe, detect, heal when safe,
                then fix with proof — is not. Eden is built for that second half
                without forcing you to abandon OpenTelemetry or rewrite how you
                call models.
              </p>
              <p>
                You do not need a research lab or a dedicated evals org to start.
                If you can point traffic at an OpenAI-compatible gateway or install{" "}
                <code className="font-mono text-[0.875rem] text-[var(--text)]">
                  eden-sdk
                </code>
                , you can ingest sessions and spans today. Free during public
                beta — no credit card — so production instrumentation is not a
                procurement project. Eden runs on Eden: our own agents are
                customers of the same detectors, issues, and Fix now queue you
                will use.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Closed loop</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Closed-loop vs traces-only
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Traces-only tools are excellent at showing you what happened.
                They store spans, sessions, and sometimes scores. When traffic
                misbehaves, you still own detection rules, on-call wiring,
                mitigation playbooks, and the path from a bad span to a merged
                fix. That stack works — until the number of prompts, tools, and
                models multiplies and every incident becomes archaeology.
              </p>
              <p>
                Eden starts at the same ingest line: gateway plus SDKs, with
                OpenTelemetry as a first-class protocol. From there the product
                is the loop. Detectors open Issues without a separate pager
                stack for every threshold. Runtime self-heal can take reversible,
                budget-capped actions when it is safe. The Improve / Fix now
                path proposes evidence-linked plans you review before merge.
                Observe → detect → heal → fix with proof is one product surface,
                not four tools you glue together after the outage.
              </p>
              <p>
                Capture remains table stakes. Eden does not ask you to stop
                caring about sessions or token counts. It refuses to stop at
                “here is a dashboard.” If your team’s bottleneck is seeing
                traffic, traces-only may be enough. If the bottleneck is turning
                production failures into controlled mitigations and reviewable
                fixes, closed-loop ops is the gap Eden is built to fill.
              </p>
            </div>
          </section>

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

          <section className="space-y-5">
            <SectionKicker>Positioning</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              When to pick Eden vs Langfuse, Helicone, or Braintrust
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Honest positioning matters more than category land grabs.{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  Langfuse
                </Link>{" "}
                is strong when you want open, self-hostable tracing and prompt
                workflows with a community-driven footprint.{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Helicone
                </Link>{" "}
                shines as a proxy-first path to request logs, spend, and cache
                visibility with minimal application changes.{" "}
                <Link href="/vs/braintrust" className={linkClass}>
                  Braintrust
                </Link>{" "}
                is a natural fit when evals, datasets, and scored experiments are
                the center of your quality process. Eden overlaps on ingest —
                you still get traces, sessions, and production context — but the
                product thesis is closed-loop operations, not “best dashboard”
                or “best evals UI” alone.
              </p>
              <p>
                Choose Eden when you want detectors to open Issues without
                reinventing alerting for every new agent; when reversible runtime
                heal (on by default, opt-out in Settings) should sit next to
                human-gated fix plans; and when autonomy decisions need an audit
                trail of allow, deny, and budget instead of grepping logs after
                the fact. Choose a traces-only or evals-first tool when your
                immediate job is instrumentation depth, proxy analytics, or
                offline scoring — and keep reading the fair comparisons below if
                you expect to use both for a season.
              </p>
              <p>
                Many teams will run more than one system during migration. That
                is fine. Eden does not require you to delete existing trace
                stores on day one. Point new traffic at the gateway or SDKs,
                keep historical tools for what they already do well, and move
                detection and fix workflow onto the closed loop when the pager
                noise outweighs the comfort of familiar charts. Deep dives:{" "}
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
                .
              </p>
            </div>
            <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  href: "/vs/langfuse",
                  t: "vs Langfuse",
                  d: "Open tracing & prompts vs closed-loop heal and fix PRs.",
                },
                {
                  href: "/vs/helicone",
                  t: "vs Helicone",
                  d: "Proxy logs & spend vs detect → heal → fix with proof.",
                },
                {
                  href: "/vs/braintrust",
                  t: "vs Braintrust",
                  d: "Evals-first quality vs production ops that close the loop.",
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
            <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  href: "/ai-agent-observability",
                  t: "AI agent observability",
                  d: "Category page: why traces aren't enough for agents.",
                },
                {
                  href: "/llm-observability-tools",
                  t: "LLM observability tools",
                  d: "Roundup across traces, evals, gateways, closed-loop.",
                },
                {
                  href: "/openai-compatible-gateway",
                  t: "OpenAI-compatible gateway",
                  d: "Gateway vs SDK and ≤5ms overhead claims.",
                },
                {
                  href: "/opentelemetry-llm-tracing",
                  t: "OpenTelemetry LLM tracing",
                  d: "OTel as a first-class ingest path.",
                },
                {
                  href: "/langfuse-alternatives",
                  t: "Langfuse alternatives",
                  d: "Criteria-first shortlist; complements the vs page.",
                },
                {
                  href: "/helicone-alternatives",
                  t: "Helicone alternatives",
                  d: "Proxy-first buyers evaluating closed loop.",
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

          <section className="space-y-5">
            <SectionKicker>How it works</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              How the loop works
            </h2>
            <p className="text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              The path is deliberate: gateway or SDK into detectors and Issues,
              optional self-heal for reversible actions, then Fix now plans with
              evidence before a human merges. Prompts, datasets, and live A/B
              sit alongside so you can score changes on the metrics that matter
              before you ship — then re-observe the next deploy with the same
              instruments.
            </p>
            <ol className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
              {LOOP_STEPS.map((step) => (
                <li key={step.n} className="bg-[var(--bg)] p-5 sm:p-6">
                  <span className="font-mono text-[0.625rem] tabular-nums text-[var(--text-faint)]">
                    {step.n}
                  </span>
                  <p className="mt-2 text-[1.0625rem] font-medium tracking-[-0.015em] text-[var(--text)]">
                    {step.t}
                  </p>
                  <p className="mt-2 text-[0.9375rem] leading-relaxed text-[var(--text-muted)]">
                    {step.d}
                  </p>
                </li>
              ))}
            </ol>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Ingest is intentionally boring in the best way. Use the Python
                or TypeScript SDK when you want spans and tool calls annotated
                in code. Use OpenTelemetry when your platform already speaks
                OTel. Use the OpenAI-compatible gateway when you want capture
                without rewriting callers — including spend, tokens, models, and
                cache hit rates per workspace. Gateway overhead stays ≤5ms at
                p95 on the path we publish; the point is production safety, not
                a new bottleneck.
              </p>
              <p>
                Detection is where traces-only stacks usually hand the baton
                back to you. Eden keeps it in-product: detectors for drift,
                latency, and cost open Issues with durable identity so repeats
                collapse instead of flooding. From an Issue you can move into
                evaluation — versioned prompts, pinned environments, live A/B —
                or into Improve, where plans cite the failing spans and eval
                delta. That citation is the difference between “AI suggested a
                rewrite” and “here is the proof from production.”
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>What you get</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What ships with the closed loop
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                The observe surface is familiar on purpose: sessions and spans
                that survive production, detectors for drift, latency, and cost,
                and Issues with first/last seen so repeats do not multiply into
                noise. Evaluation sits beside that stream — versioned prompts,
                pinned environments, live A/B with control and treatment arms —
                so a change is scored on the metrics that matter before you
                promote it. Improve closes the narrative: plans from traces you
                already have, cited to failing spans and eval deltas, then human
                review before the next deploy is re-observed with the same
                instruments.
              </p>
              <p>
                Install stays short. Use{" "}
                <code className="font-mono text-[0.875rem] text-[var(--text)]">
                  eden-sdk
                </code>{" "}
                in Python or TypeScript, speak OpenTelemetry if that is already
                your platform language, or point OpenAI-compatible clients at
                the gateway when you need capture without rewriting callers.
                Stack coverage is deliberate: SDKs, gateway, OTel ingest, and a
                REST API for the surfaces your automation already expects. Free
                during public beta includes the full platform with a monthly
                credit cap — see{" "}
                <Link href="/pricing" className={linkClass}>
                  pricing
                </Link>{" "}
                for the current limits and roadmap tiers that are not yet for
                purchase.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Trust</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Trust and control
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Closed loop only works if autonomy is visible and reversible.
                Runtime heal is limited to reversible actions, budget-capped,
                and covered by a full audit trail. Heal is on by default for
                those safe actions so production gets protection without a
                weeks-long policy project — and you can opt out anytime in
                Settings when a workspace needs a stricter posture.
              </p>
              <p>
                Code patches and auto-merge stay gated. The Fix now queue is a
                review surface, not a license for unattended rewrites. Autonomy
                audit in Settings records allow, deny, and budget decisions so
                security and platform owners can answer what Eden was permitted
                to do without log archaeology. Telemetry stays scoped to your
                organization; retention and PII filtering are controlled from
                Settings, with export or deletion available when you need them.
                Eden does not sell personal information.
              </p>
              <p>
                Dogfooding is part of the trust story. Eden runs on Eden — our
                agents are customers of the same detectors, Issues, heal path,
                and fix queue. That does not replace your review habits; it
                means the product claims about closed-loop ops are exercised on
                the same class of LLM and tool traffic you will send. For
                install details, retention, and gateway setup,{" "}
                <a
                  href={DOCS_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  read the docs
                </a>
                . For plan limits during public beta, see{" "}
                <Link href="/pricing" className={linkClass}>
                  pricing
                </Link>
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

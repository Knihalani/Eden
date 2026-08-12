import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import {
  DOCS_QUICKSTART_URL,
  DOCS_URL,
  GATEWAY_URL,
} from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/openai-compatible-gateway",
  title: "OpenAI-Compatible Gateway for LLM Observability — Eden",
  description:
    "Eden’s OpenAI-compatible gateway captures LLM traffic with ≤5ms overhead p95. When to use gateway vs SDK, and how it feeds closed-loop detect and fix.",
});

const DOCS_DEPLOY_URL = `${DOCS_URL}/how-to/deploy`;

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
      {children}
    </p>
  );
}

export default function OpenaiCompatibleGatewayPage() {
  return (
    <main>
      <MarketingShell
        kicker="OpenAI-compatible gateway"
        title="Point existing clients at Eden. Capture without a rewrite."
        lead="Eden’s OpenAI-compatible gateway sits on the path you already use for chat and tool calls. Gateway overhead stays ≤5ms at p95 on the path we publish — so observability does not become a new bottleneck."
      >
        <div className="max-w-3xl space-y-14">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "≤5ms", k: "Gateway overhead p95" },
              { v: "OpenAI", k: "Compatible API shape" },
              { v: "Spend", k: "Tokens · models · cache" },
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
            <SectionKicker>Positioning</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What an OpenAI-compatible gateway is for
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                An OpenAI-compatible gateway accepts the same request shapes
                many SDKs already speak — chat completions, embeddings, and
                related calls — and forwards them while recording the
                production context you need for observability. Instead of
                rewriting every caller to emit custom spans, you change the
                base URL (and auth) so traffic flows through a path that can
                capture spend, tokens, models, latency, and cache hit rates per
                workspace.
              </p>
              <p>
                That pattern is popular for a reason. Platform teams want
                visibility without a multi-week instrumentation project across
                every service that calls a model. Product teams want to ship
                agent features without waiting for a perfect OpenTelemetry
                rollout. A compatible gateway is the lowest-friction ingest
                line when your callers already look like OpenAI clients.
              </p>
              <p>
                Eden’s gateway is that path into the closed loop — not a
                standalone proxy analytics product. Capture lands as sessions
                and spans, then detectors, Issues, optional self-heal, and Fix
                now sit on the same surface. Read{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>{" "}
                for how ingest feeds observe → detect → heal → fix with proof.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Overhead</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Low overhead — only the claim we publish
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Gateway overhead stays ≤5ms at p95 on the path we publish.
                That is the latency claim Eden makes across marketing and
                product surfaces. We do not invent additional benchmark
                numbers, competitor proxy latency, or unpublished percentiles
                here. The point of the number is production safety: observing
                traffic should not become the bottleneck that makes teams rip
                out instrumentation after the first load test.
              </p>
              <p>
                Overhead matters because agents amplify call volume. A single
                user turn can fan into many model and tool requests. A few
                milliseconds per hop compounds. Keeping gateway overhead on a
                published ≤5ms p95 path is how Eden argues for always-on
                capture instead of sample-and-hope logging that goes dark when
                you need it most.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Gateway vs SDK</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              When to use the gateway vs the SDK
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Use the gateway when you want capture without rewriting
                callers. Point OpenAI-compatible clients at{" "}
                <code className="font-mono text-[0.875rem] text-[var(--text)] break-all">
                  {GATEWAY_URL}
                </code>{" "}
                (or your documented workspace endpoint), keep your existing
                request construction, and let Eden record the traffic. This is
                the right default for polyglot services, legacy callers, and
                “ship visibility this week” mandates.
              </p>
              <p>
                Use the Python or TypeScript SDK when you want spans and tool
                calls annotated in code — richer application context, explicit
                session grouping, and instrumentation that lives next to agent
                logic. SDKs shine when the agent graph is first-class in your
                repo and you are comfortable owning a small instrumentation
                surface. Many teams use both: gateway for broad capture, SDK
                for deep agent paths.
              </p>
              <p>
                Use OpenTelemetry when your platform already speaks OTel and
                you want LLM traces to land in the same pipeline language as
                the rest of the stack. Eden treats OTel as a first-class
                ingest protocol alongside gateway and SDKs. See{" "}
                <Link
                  href="/opentelemetry-llm-tracing"
                  className={linkClass}
                >
                  OpenTelemetry LLM tracing
                </Link>{" "}
                for how that fits, and{" "}
                <Link
                  href="/ai-agent-observability"
                  className={linkClass}
                >
                  AI agent observability
                </Link>{" "}
                for the broader category framing.
              </p>
            </div>
            <div className="overflow-hidden border border-[var(--line)]">
              <table className="w-full text-left text-[0.875rem]">
                <thead>
                  <tr className="border-b border-[var(--line)] bg-[var(--bg-inset)]">
                    <th className="type-label px-4 py-3 font-normal">Need</th>
                    <th className="type-label px-4 py-3 font-normal">
                      Prefer
                    </th>
                    <th className="type-label px-4 py-3 font-normal">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      need: "Capture without code changes",
                      prefer: "Gateway",
                      why: "Base URL swap; OpenAI-compatible clients",
                    },
                    {
                      need: "Annotate tools & sessions in code",
                      prefer: "SDK",
                      why: "Spans live next to agent logic",
                    },
                    {
                      need: "Platform already exports OTel",
                      prefer: "OTel ingest",
                      why: "Same protocol as the rest of the stack",
                    },
                    {
                      need: "Closed-loop detect → heal → fix",
                      prefer: "Any ingest + Eden loop",
                      why: "Ingest is the starting line, not the product",
                    },
                  ].map((row) => (
                    <tr
                      key={row.need}
                      className="border-b border-[var(--line)] last:border-b-0"
                    >
                      <td className="px-4 py-3 text-[var(--text)]">
                        {row.need}
                      </td>
                      <td className="px-4 py-3 text-[var(--text)]">
                        {row.prefer}
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">
                        {row.why}
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
              Gateway capture is the starting line
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Proxy-first products often stop at request logs, spend charts,
                and cache visibility. Those are useful. Eden keeps them —
                tokens, models, spend, cache hit rates per workspace — and
                continues. Detectors open Issues without a separate pager stack
                for every threshold. Runtime self-heal can take reversible,
                budget-capped actions when safe (on by default; opt out in
                Settings). Fix now proposes evidence-linked plans; humans
                review before merge. Code patches and auto-merge stay gated.
              </p>
              <p>
                If your primary job is proxy analytics, evaluate gateway-first
                competitors on that job — then compare closed-loop depth. Fair
                comparisons:{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Eden vs Helicone
                </Link>{" "}
                and the shortlist on{" "}
                <Link href="/helicone-alternatives" className={linkClass}>
                  Helicone alternatives
                </Link>
                . For a category map of traces-only, evals, gateways, and
                closed-loop tools, see{" "}
                <Link href="/llm-observability-tools" className={linkClass}>
                  LLM observability tools
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Operations</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What you see after traffic hits the gateway
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Once requests flow through the gateway, Eden attaches the
                production context you need to operate — not only raw request
                blobs. Sessions group runs by user, agent, or deploy. Spans
                carry model, token, latency, and spend signals so a cost cliff
                after a model swap is visible without grepping vendor invoices.
                Cache hit rates per workspace help you see whether retries and
                identical prompts are burning budget you thought you had saved.
              </p>
              <p>
                From that stream, detectors for drift, latency, and cost can
                open Issues with first/last seen and deduped fingerprints.
                That is the handoff proxy-only stacks usually leave to you.
                When a mitigation is reversible and within budget, runtime
                self-heal can intervene; heal stays opt-outable in Settings.
                When the right next step is a change, Fix now cites the failing
                spans and eval deltas so review is evidence-first. That is how
                gateway ingest becomes{" "}
                <Link href="/ai-agent-observability" className={linkClass}>
                  AI agent observability
                </Link>{" "}
                instead of another log sink.
              </p>
              <p>
                Teams comparing gateway products should also scan the category
                roundup on{" "}
                <Link href="/llm-observability-tools" className={linkClass}>
                  LLM observability tools
                </Link>{" "}
                and the criteria-first{" "}
                <Link href="/helicone-alternatives" className={linkClass}>
                  Helicone alternatives
                </Link>{" "}
                guide. The question is not “who has a proxy?” — it is whether
                the proxy is the product or the on-ramp.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Install</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Deploy and quickstart
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Free during public beta — no credit card. Start with the{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  docs quickstart
                </a>{" "}
                to reach first trace quickly, then follow{" "}
                <a
                  href={DOCS_DEPLOY_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  deploy
                </a>{" "}
                to point SDKs and clients at the production API and gateway.
                Instrument one high-traffic path, confirm spend and spans land,
                turn on detectors, and decide whether closed loop reduces the
                glue between dashboards and PRs.
              </p>
              <p>
                Plan limits and roadmap tiers that are not yet for purchase
                live on{" "}
                <Link href="/pricing" className={linkClass}>
                  pricing
                </Link>
                . For security model and retention controls,{" "}
                <a
                  href={DOCS_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  read the docs
                </a>
                . We do not invent SOC2 theater or fake latency leaderboards —
                only the ≤5ms gateway overhead p95 claim already published on
                Eden surfaces.
              </p>
            </div>
            <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  href: DOCS_QUICKSTART_URL,
                  t: "Quickstart",
                  d: "Signup to first trace.",
                  external: true,
                },
                {
                  href: DOCS_DEPLOY_URL,
                  t: "Deploy",
                  d: "Point clients at production API.",
                  external: true,
                },
                {
                  href: "/why-eden",
                  t: "Why Eden",
                  d: "How gateway ingest feeds the loop.",
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
                Point traffic at the gateway today.
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

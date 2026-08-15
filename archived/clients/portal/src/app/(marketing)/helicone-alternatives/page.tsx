import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_QUICKSTART_URL, DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/helicone-alternatives",
  title: "Helicone Alternatives — Evaluate Proxy vs Closed-Loop Ops",
  description:
    "How to evaluate Helicone alternatives for LLM proxy logs and observability — criteria, shortlist including Eden, and link to Eden vs Helicone.",
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
    t: "Capture friction",
    d: "Base-URL / proxy swap vs SDK installs vs OpenTelemetry export.",
  },
  {
    t: "Spend & cache visibility",
    d: "Tokens, models, cost, and cache hit rates per workspace or key.",
  },
  {
    t: "Latency overhead",
    d: "Published path claims you can hold the vendor to — not invented leaderboards.",
  },
  {
    t: "Production detection",
    d: "Log search and dashboards vs detectors that open durable Issues.",
  },
  {
    t: "Mitigation & fix",
    d: "Whether the product stops at logs or continues to heal and reviewable fixes.",
  },
  {
    t: "Control",
    d: "Budgets, opt-out, audit trails — especially if any automation sits on the path.",
  },
] as const;

export default function HeliconeAlternativesPage() {
  return (
    <main>
      <MarketingShell
        kicker="Helicone alternatives"
        title="Proxy logs show the bill. Decide if you need the loop."
        lead="Helicone is strong as a proxy-first path to request logs, spend, and cache visibility. Searching Helicone alternatives usually means you want a different ingest tradeoff — or a product that continues past logs into detection and fix. Complements Eden vs Helicone."
      >
        <div className="max-w-3xl space-y-14">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "Proxy", k: "Starting job" },
              { v: "≤5ms", k: "Eden gateway overhead" },
              { v: "Closed", k: "Eden differentiator" },
              { v: "Fair", k: "No invented pricing" },
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
              Why teams look for Helicone alternatives
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Helicone earned attention by making LLM request visibility feel
                like changing a base URL: logs, spend, and cache insights with
                minimal application surgery. That job remains valuable. Teams
                search for alternatives when they need different residency or
                vendor constraints, when OpenTelemetry is already the platform
                language, when open self-host tracing matters more than proxy
                analytics, or when proxy logs are not enough to run production
                agents through failures. The search query is broad; the
                underlying jobs are not. Collapse them into criteria before you
                treat every logo as interchangeable.
              </p>
              <p>
                Name the new job before you shortlist. If you still only need
                spend and request logs, evaluate proxy-class tools on overhead,
                coverage, and cost controls — we will not invent Helicone
                pricing numbers here. If you need detectors, mitigations, and
                reviewable fixes, you are shopping a different category that
                happens to overlap on gateway-shaped ingest.
              </p>
              <p>
                For Helicone-specific tradeoffs against Eden, read{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Eden vs Helicone
                </Link>
                . For a parallel alternatives guide aimed at traces-first
                buyers, see{" "}
                <Link href="/langfuse-alternatives" className={linkClass}>
                  Langfuse alternatives
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Criteria</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Evaluation criteria for proxy-first buyers
            </h2>
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
                Weight latency overhead with published claims only. Eden states
                gateway overhead ≤5ms at p95 on the path we publish — that is
                the number you will see repeated on Why Eden and comparison
                pages, not a new leaderboard invented for SEO. If a vendor will
                not state an overhead claim, treat that as a criterion score,
                not a rumor war. The same honesty rule applies to pricing: we
                do not invent competitor prices; compare Free during public
                beta limits on{" "}
                <Link href="/pricing" className={linkClass}>
                  pricing
                </Link>{" "}
                against whatever the other vendor publishes themselves.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Shortlist</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Shortlist including Eden
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Stay with Helicone
                </strong>{" "}
                when proxy analytics and spend visibility are the whole job and
                the product already fits your keys, caches, and workflows. An
                alternative is optional.
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Langfuse-class tracing
                </strong>{" "}
                belongs when open self-hostable spans and prompt workflows
                matter more than proxy-shaped capture. See{" "}
                <Link href="/vs/langfuse" className={linkClass}>
                  Eden vs Langfuse
                </Link>
                .
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">
                  Braintrust-class evals
                </strong>{" "}
                belong when scored experiments drive quality more than request
                logs. See{" "}
                <Link href="/vs/braintrust" className={linkClass}>
                  Eden vs Braintrust
                </Link>
                .
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">
                  OpenTelemetry-native paths
                </strong>{" "}
                belong when the platform mandate is OTel everywhere. Eden
                accepts OTel as first-class ingest — details on{" "}
                <Link
                  href="/opentelemetry-llm-tracing"
                  className={linkClass}
                >
                  OpenTelemetry LLM tracing
                </Link>
                .
              </p>
              <p>
                <strong className="font-medium text-[var(--text)]">Eden</strong>{" "}
                belongs when you still want OpenAI-compatible gateway capture —
                spend, tokens, models, cache hit rates — with ≤5ms overhead p95
                on the published path, and you also want closed-loop detect,
                heal when safe, and Fix now with proof. Free during public
                beta. Gateway positioning:{" "}
                <Link
                  href="/openai-compatible-gateway"
                  className={linkClass}
                >
                  OpenAI-compatible gateway
                </Link>
                . Thesis:{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>
                . Deep dive:{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Eden vs Helicone
                </Link>
                .
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Migration</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Trialing an alternative beside an existing proxy
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                You do not need to rip out a working Helicone (or similar)
                deployment to learn whether closed loop helps. Pick one
                high-traffic agent or feature path, point its OpenAI-compatible
                client at Eden’s gateway, and keep the rest of traffic on the
                familiar proxy. Compare what you can answer in the first hour
                of an incident: spend charts alone, or Issues with fingerprints
                plus a path to heal and Fix now.
              </p>
              <p>
                Score the trial against the criteria above — capture friction,
                spend visibility, published overhead, detection, mitigation,
                and control — not against a vague “feels modern” impression.
                If proxy analytics still wins every criterion that matters to
                your team, stay. If detection and fix workflow close the gap
                that made you search for alternatives, expand traffic
                deliberately.
              </p>
              <p>
                Document opt-out and audit expectations early. Eden’s heal is
                on by default for reversible, budget-capped actions and can be
                disabled in Settings; code patches and auto-merge stay gated.
                Those controls are part of the product claim set, not fine
                print. Pair this page with{" "}
                <Link href="/vs/helicone" className={linkClass}>
                  Eden vs Helicone
                </Link>{" "}
                for the capability matrix,{" "}
                <Link
                  href="/openai-compatible-gateway"
                  className={linkClass}
                >
                  OpenAI-compatible gateway
                </Link>{" "}
                for ingest mechanics, and{" "}
                <Link href="/llm-observability-tools" className={linkClass}>
                  LLM observability tools
                </Link>{" "}
                for category placement among traces, evals, gateways, and
                closed-loop products.
              </p>
              <p>
                When stakeholders ask what “observability” means for agents
                beyond request logs, send them{" "}
                <Link href="/ai-agent-observability" className={linkClass}>
                  AI agent observability
                </Link>{" "}
                and{" "}
                <Link href="/why-eden" className={linkClass}>
                  Why Eden
                </Link>
                . When the parallel question is traces-first alternatives, use{" "}
                <Link href="/langfuse-alternatives" className={linkClass}>
                  Langfuse alternatives
                </Link>
                . Keep the evaluation notebook short: one path, one week, clear
                criteria — then decide.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Eden</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              How Eden differs without dismissing proxies
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Proxy logs show what was called and what it cost. Eden keeps
                that useful surface and continues: detectors open Issues;
                reversible heal can intervene within budget (on by default, opt
                out in Settings); Fix now cites failing spans and eval deltas
                before a human merges. Code patches and auto-merge stay gated.
                Autonomy audit records allow, deny, and budget. That is closed
                loop — not a claim that dashboards are obsolete. Spend and
                cache visibility remain part of gateway ingest; they are simply
                not the finish line when production agents need action, not
                only charts.
              </p>
              <p>
                Many teams dual-run: keep Helicone (or another proxy) for
                familiar spend views while pointing selected traffic at Eden to
                test Issues and Fix now. Coexistence is covered on the vs page.
                Category map:{" "}
                <Link href="/llm-observability-tools" className={linkClass}>
                  LLM observability tools
                </Link>
                . Agent framing:{" "}
                <Link href="/ai-agent-observability" className={linkClass}>
                  AI agent observability
                </Link>
                .
              </p>
              <p>
                Try the{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  docs quickstart
                </a>
                , review{" "}
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
                </a>
                . No invented SOC2 badges or competitor price tables — only
                honest claims already on Eden surfaces.
              </p>
            </div>
            <ul className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
              {[
                {
                  href: "/vs/helicone",
                  t: "vs Helicone",
                  d: "Proxy logs vs closed-loop ops.",
                },
                {
                  href: "/openai-compatible-gateway",
                  t: "Gateway",
                  d: "When to use gateway vs SDK.",
                },
                {
                  href: "/llm-observability-tools",
                  t: "Tool roundup",
                  d: "Four fair categories.",
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
                Keep proxy capture. Add the loop if you need it.
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

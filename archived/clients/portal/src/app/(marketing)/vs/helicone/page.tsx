import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/vs/helicone",
  title: "Eden vs Helicone — Closed-Loop LLM Ops vs Proxy Logs",
  description:
    "Compare Eden and Helicone: proxy logs and spend visibility vs closed-loop detect, heal, and fix PRs. When to pick each — or run both — in production.",
});

const ROWS = [
  {
    capability: "Low-friction capture",
    helicone: "Proxy-first request logging",
    eden: "OpenAI-compatible gateway + SDKs + OTel",
  },
  {
    capability: "Spend / token visibility",
    helicone: "Core strength of proxy analytics",
    eden: "Spend, tokens, models, cache hits per workspace",
  },
  {
    capability: "Failure detection → issues",
    helicone: "Usually alerts and workflows you attach",
    eden: "Detectors open Issues without a separate pager stack",
  },
  {
    capability: "Runtime self-heal",
    helicone: "Not the product focus",
    eden: "On by default for reversible actions — opt out anytime",
  },
  {
    capability: "Fix PRs with proof",
    helicone: "Investigate logs; fix elsewhere",
    eden: "Fix now queue with evidence tiers before you merge",
  },
  {
    capability: "Decision audit",
    helicone: "Log-centric investigation",
    eden: "Settings → Autonomy audit: allow / deny / budget",
  },
] as const;

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

export default function EdenVsHeliconePage() {
  return (
    <main>
      <MarketingShell
        kicker="Eden vs Helicone"
        title="Proxy logs show the bill. Closed loop fixes the failure."
        lead="Helicone is strong when you want proxy-first LLM request logs, spend, and cache visibility with minimal code change. Eden also offers an OpenAI-compatible gateway — then detects, heals when safe, and opens proven fix plans."
      >
        <div className="max-w-3xl space-y-12">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "≤5ms", k: "Eden gateway overhead" },
              { v: "Proxy", k: "Shared capture idea" },
              { v: "Heal", k: "Eden closed-loop ops" },
              { v: "Fair", k: "Capability comparison" },
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

          <section className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Snapshot
            </p>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What this comparison is (and is not)
            </h2>
            <p>
              Teams comparing Helicone and Eden usually share one constraint:
              they cannot rewrite every caller just to get visibility. Both
              products respect that constraint with gateway- or proxy-style
              capture. This page explains where the products diverge after the
              request is logged — detection, optional self-heal, and fix plans
              with proof — without inventing Helicone pricing, inventing
              benchmarks, or claiming Helicone cannot do analytics well.
            </p>
            <p>
              If your primary job is “see every request and understand spend,”
              Helicone’s proxy-first model is a natural fit. If your primary job
              is “turn production failures into controlled mitigations and
              reviewable fixes,” Eden’s closed loop is the product. For the
              broader thesis, see{" "}
              <Link href="/why-eden" className={linkClass}>
                Why Eden
              </Link>
              .
            </p>
          </section>

          <section className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Helicone strengths
            </p>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Where Helicone is a strong fit
            </h2>
            <p>
              Helicone’s reputation is built on low-friction proxy capture.
              Point traffic through the proxy, keep application code mostly
              intact, and you get request logs plus the operational numbers
              finance and platform teams ask for: spend, tokens, model mix, and
              cache behavior. For orgs whose LLM pain is “we do not know what we
              are paying for,” that is often the correct first product.
            </p>
            <p>
              Proxy analytics also help debugging when the question is
              request-shaped: which model ran, how large was the payload, did
              cache help, where did latency accumulate on the HTTP path. Teams
              with mature external alerting can attach their own monitors to
              those logs and build a workable on-call story. Helicone is not
              “just a billing dashboard”; it is a capable proxy observability
              surface for LLM HTTP traffic.
            </p>
            <p>
              Minimal application change is a real advantage during incidents
              and migrations. When you cannot afford a multi-week SDK rollout,
              proxy capture buys time. Eden shares that philosophy with an
              OpenAI-compatible gateway — including spend, tokens, models, and
              cache hit rates per workspace — while also offering SDKs and
              OpenTelemetry when you want richer spans and tool-call structure.
              The overlap on capture is intentional; the product fork is what
              happens next.
            </p>
          </section>

          <div className="overflow-hidden border border-[var(--line)]">
            <table className="w-full text-left text-[0.875rem]">
              <thead>
                <tr className="border-b border-[var(--line)] bg-[var(--bg-inset)]">
                  <th className="type-label px-4 py-3 font-normal">Capability</th>
                  <th className="type-label px-4 py-3 font-normal">Helicone</th>
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
                      {row.helicone}
                    </td>
                    <td className="px-4 py-3 text-[var(--text)]">{row.eden}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Eden difference
            </p>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Where Eden differs: detect → heal → fix
            </h2>
            <p>
              After the gateway captures a request, Eden keeps ownership of the
              failure lifecycle. Detectors for drift, latency, and cost open
              Issues with durable identity so repeats collapse. You still get
              sessions and spans — grouped by user, agent, or deploy — but the
              unit of work becomes an Issue you can triage, not only a log line
              you can filter.
            </p>
            <p>
              Runtime self-heal sits on top of that Issue stream for reversible,
              budget-capped actions. Heal is on by default for those safe
              actions and opt-out in Settings. That is a deliberate product
              claim: production protection should not wait for a policy
              committee, and autonomy must remain visible. Settings → Autonomy
              audit records allow, deny, and budget. Code patches and
              auto-merge stay gated; humans review Fix now plans cited to
              failing spans and eval deltas before merge.
            </p>
            <p>
              Gateway overhead stays ≤5ms at p95 on the path we publish, so
              closed-loop ambitions do not excuse a heavy proxy. Ingest is
              multi-path: gateway for drop-in capture, Python and TypeScript
              SDKs for annotated agent runs, OpenTelemetry when your platform
              already speaks OTel. Free during public beta — no credit card —
              means you can prove the loop on a real path without a procurement
              cycle. Eden runs on Eden; our agents exercise the same detectors,
              Issues, heal path, and fix queue.
            </p>
            <p>
              Put differently: Helicone optimizes for seeing and attributing LLM
              HTTP traffic. Eden optimizes for closing the observe → improve
              loop once that traffic misbehaves. Both can matter in the same
              company. Neither should be sold as “the other product, but
              worse.”
            </p>
          </section>

          <section className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Coexistence
            </p>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              When you might still use both
            </h2>
            <p>
              Some teams keep Helicone (or another proxy) for finance-facing
              spend reports while routing a subset of production agents through
              Eden for detectors, heal, and Fix now. Others start on Helicone
              for capture, then move the on-call path to Eden when alert glue
              becomes the bottleneck. Dual systems are temporary scaffolding,
              not a moral failure.
            </p>
            <p>
              A practical split: let Helicone remain the quick answer to “what
              did we spend on model X yesterday?” and let Eden own “which Issue
              is firing, what did heal do, and what fix plan has proof?” If one
              gateway eventually covers both jobs for your org, consolidate. If
              not, keep the boundary explicit so engineers know which pane is
              authoritative during an incident. Also see{" "}
              <Link href="/vs/langfuse" className={linkClass}>
                Eden vs Langfuse
              </Link>{" "}
              and{" "}
              <Link href="/vs/braintrust" className={linkClass}>
                Eden vs Braintrust
              </Link>
              .
            </p>
            <p>
              Next steps: read{" "}
              <Link href="/why-eden" className={linkClass}>
                Why Eden
              </Link>
              , install via the{" "}
              <a
                href={DOCS_URL}
                className={linkClass}
                rel="noopener noreferrer"
              >
                docs
              </a>
              , and review{" "}
              <Link href="/pricing" className={linkClass}>
                pricing
              </Link>{" "}
              for Free during public beta. Point one OpenAI-compatible client at
              Eden’s gateway, enable detectors, and measure whether Issues plus
              heal reduce the manual hops between log, ticket, and PR.
            </p>
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
                Capture today. Close the loop tomorrow.
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

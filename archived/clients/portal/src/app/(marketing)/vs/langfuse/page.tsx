import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/vs/langfuse",
  title: "Eden vs Langfuse — Closed-Loop Observability vs Traces",
  description:
    "Compare Eden and Langfuse: open tracing and prompts vs closed-loop detect, heal, and fix PRs. When to use each — or both — for production LLM apps.",
});

const ROWS = [
  {
    capability: "Trace & session capture",
    langfuse: "Core strength — open, self-hostable tracing",
    eden: "Gateway + SDKs + OTel — same starting line",
  },
  {
    capability: "Prompt / eval workflows",
    langfuse: "Strong prompt and scoring workflows",
    eden: "Prompts, datasets, live A/B alongside Issues",
  },
  {
    capability: "Production failure detection",
    langfuse: "Typically dashboards and alerts you wire",
    eden: "Detectors → Issues without a separate pager stack",
  },
  {
    capability: "Runtime self-heal",
    langfuse: "Not the product focus",
    eden: "On by default for reversible actions — opt out anytime",
  },
  {
    capability: "Fix path with proof",
    langfuse: "Export / investigate in your own toolchain",
    eden: "Fix now queue with evidence tiers before you merge",
  },
  {
    capability: "Autonomy audit",
    langfuse: "Depends on how you instrument ops around it",
    eden: "Settings → Autonomy audit: allow / deny / budget",
  },
] as const;

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

export default function EdenVsLangfusePage() {
  return (
    <main>
      <MarketingShell
        kicker="Eden vs Langfuse"
        title="Open tracing is table stakes. Closed loop is the difference."
        lead="Langfuse is excellent when you want open, self-hostable LLM tracing and prompt workflows. Eden starts at the same ingest line, then closes the loop: detect, heal when safe, and open proven fix plans."
      >
        <div className="max-w-3xl space-y-12">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "≤5ms", k: "Eden gateway overhead" },
              { v: "OTel", k: "Shared ingest idea" },
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
              This page is for teams evaluating Langfuse and Eden for production
              LLM apps — agents, retrieval features, and tool-using workflows —
              who already know that “we need traces” is not a complete ops
              strategy. It is not a feature checklist war, a pricing comparison
              (we do not invent competitor pricing), or a claim that Langfuse is
              obsolete. Langfuse is good at what it is built for. Eden is built
              for a different job: closed-loop observability that continues past
              capture into detection, optional self-heal, and reviewable fixes.
            </p>
            <p>
              If you only need to store and explore spans, either starting point
              can work. If you need detectors to open Issues, reversible heal on
              by default with an opt-out, and a Fix now queue with evidence
              before merge, Eden is the product shaped for that loop. Read{" "}
              <Link href="/why-eden" className={linkClass}>
                Why Eden
              </Link>{" "}
              for the broader closed-loop thesis, then use this page for the
              Langfuse-specific tradeoffs.
            </p>
          </section>

          <section className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Langfuse strengths
            </p>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Where Langfuse is a strong fit
            </h2>
            <p>
              Langfuse earned its place by making LLM tracing approachable and
              often self-hostable. Teams that want an open footprint, prompt
              workflows adjacent to traces, and a community-driven path into
              observability frequently start here — especially when platform
              ownership and data residency dominate the decision. For many
              early-stage products, “instrument, store, inspect” is the entire
              requirement, and Langfuse covers that job without forcing a new
              ops model.
            </p>
            <p>
              Prompt management and scoring workflows are another reason teams
              stick with Langfuse. If your culture centers on iterating prompts
              in a dedicated UI, attaching scores, and browsing related traces,
              you already have a coherent daily habit. That habit is valuable.
              Eden also versions prompts, pins environments, and runs live A/B,
              but it does not pretend that prompt UX alone is the product. The
              closed loop is.
            </p>
            <p>
              Self-hosting and open ecosystems matter for regulated or
              infrastructure-heavy orgs. If your hard constraint is “we must run
              the trace store ourselves under our network controls,” evaluate
              Langfuse on those terms. Eden’s public claims emphasize the
              OpenAI-compatible gateway, SDKs, OpenTelemetry ingest, ≤5ms
              gateway overhead, Free during public beta, and closed-loop
              improve path — not a SOC2 checklist or invented customer logos.
              Choose the constraint that actually blocks you.
            </p>
          </section>

          <div className="overflow-hidden border border-[var(--line)]">
            <table className="w-full text-left text-[0.875rem]">
              <thead>
                <tr className="border-b border-[var(--line)] bg-[var(--bg-inset)]">
                  <th className="type-label px-4 py-3 font-normal">Capability</th>
                  <th className="type-label px-4 py-3 font-normal">Langfuse</th>
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
                      {row.langfuse}
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
              Where Eden differs: closed-loop ops
            </h2>
            <p>
              Both products can capture production LLM traffic. Eden’s thesis is
              that capture is the starting line, not the finish. Detectors watch
              drift, latency, and cost and open Issues with first/last seen and
              deduped fingerprints so you are not grepping logs for every
              regression. That is the observe → detect handoff many Langfuse
              deployments still implement with homemade alerts.
            </p>
            <p>
              Runtime self-heal is the next handoff. When an action is
              reversible and within budget, Eden can intervene automatically.
              Heal is on by default for those safe actions; you opt out in
              Settings when a workspace needs a stricter posture. Code patches
              and auto-merge stay gated. Autonomy audit records allow, deny, and
              budget so platform owners can see what was permitted without
              reconstructing intent from raw logs.
            </p>
            <p>
              Fix now closes the loop with proof. Plans cite failing spans and
              eval deltas; humans approve, reject, or snooze before anything
              merges. That is different from “export the trace and open your
              IDE.” It is also different from unattended code rewrite. Eden
              dogfoods the same path — Eden runs on Eden — so detectors, Issues,
              heal, and fix plans are exercised on real agent traffic, not only
              demo apps.
            </p>
            <p>
              Ingest remains deliberately compatible with how teams already
              ship: Python and TypeScript SDKs, OpenTelemetry, or point existing
              OpenAI SDK calls at the gateway for capture without code changes,
              including spend, tokens, models, and cache hit rates per
              workspace. Gateway overhead stays ≤5ms at p95 on the path we
              publish. Free during public beta — no credit card — lowers the
              cost of trying the closed loop beside an existing Langfuse
              deployment.
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
              Migration is rarely a single cutover. Teams often keep Langfuse
              for historical traces, self-hosted residency requirements, or
              prompt habits that already work, while pointing new production
              traffic at Eden’s gateway or SDKs to get detectors, Issues, heal,
              and Fix now. Dual ingest for a season is a rational ops choice,
              not a failure of either product.
            </p>
            <p>
              Use Langfuse as the system of record for deep trace exploration
              if that is where your team’s muscle memory lives. Use Eden as the
              system of action when an Issue needs mitigation and a reviewable
              fix plan. Over time you can consolidate if one surface covers both
              jobs — or keep both if open self-hosting and closed-loop heal
              remain separate constraints. Related comparisons:{" "}
              <Link href="/vs/helicone" className={linkClass}>
                Eden vs Helicone
              </Link>{" "}
              and{" "}
              <Link href="/vs/braintrust" className={linkClass}>
                Eden vs Braintrust
              </Link>
              .
            </p>
            <p>
              Practical next steps: skim{" "}
              <Link href="/why-eden" className={linkClass}>
                Why Eden
              </Link>{" "}
              for the capability table, read the{" "}
              <a
                href={DOCS_URL}
                className={linkClass}
                rel="noopener noreferrer"
              >
                docs
              </a>{" "}
              for gateway and SDK install, and check{" "}
              <Link href="/pricing" className={linkClass}>
                pricing
              </Link>{" "}
              for Free during public beta limits. Instrument a single
              high-traffic path, turn on detectors, and decide whether closed
              loop reduces pager glue — that experiment answers more than any
              marketing matrix.
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
                Try the closed loop on real traffic.
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

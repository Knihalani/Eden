import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MarketingPrimaryCta } from "@/components/marketing/marketing-auth-ctas";
import { DOCS_URL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/vs/braintrust",
  title: "Eden vs Braintrust — Closed-Loop Ops vs Evals Suites",
  description:
    "Compare Eden and Braintrust: evals-first quality workflows vs closed-loop detect, heal, and fix PRs. When each wins — and when using both still makes sense.",
});

const ROWS = [
  {
    capability: "Evals & datasets",
    braintrust: "Core strength — scored experiments",
    eden: "Prompts, datasets, live A/B beside production Issues",
  },
  {
    capability: "Production tracing",
    braintrust: "Available as part of a broader quality stack",
    eden: "Gateway + SDKs + OTel with ≤5ms gateway overhead",
  },
  {
    capability: "Detect → Issues",
    braintrust: "Often eval/score driven; ops wiring varies",
    eden: "Detectors open Issues without a separate pager stack",
  },
  {
    capability: "Runtime self-heal",
    braintrust: "Not the product focus",
    eden: "On by default for reversible actions — opt out anytime",
  },
  {
    capability: "Fix PRs with proof",
    braintrust: "Improve via eval iteration and your ship process",
    eden: "Fix now queue with evidence tiers before you merge",
  },
  {
    capability: "Autonomy audit",
    braintrust: "Depends on surrounding controls",
    eden: "Settings → Autonomy audit: allow / deny / budget",
  },
] as const;

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

export default function EdenVsBraintrustPage() {
  return (
    <main>
      <MarketingShell
        kicker="Eden vs Braintrust"
        title="Evals raise the bar. Closed loop keeps production there."
        lead="Braintrust is a strong fit when evals, datasets, and scored experiments are the center of your quality process. Eden includes prompts, datasets, and live A/B — and closes the loop with detect, heal when safe, and proven fix plans."
      >
        <div className="max-w-3xl space-y-12">
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            {[
              { v: "Evals", k: "Shared quality idea" },
              { v: "Live A/B", k: "Eden treatment arms" },
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
              Eden vs Braintrust is often framed as “evals vs observability.”
              That framing is too crude. Braintrust is genuinely strong when
              scored experiments and dataset workflows are how your team ships
              quality. Eden is not “evals-free”; it versions prompts, pins
              environments, and runs live A/B. The real fork is whether your
              bottleneck is offline and experiment quality — or production
              failure lifecycle once models are live.
            </p>
            <p>
              This page stays factual: no invented Braintrust pricing, no fake
              win-rate benchmarks, no SOC2 theater. It explains capabilities and
              when you might still run both. For the closed-loop product story
              across competitors, start with{" "}
              <Link href="/why-eden" className={linkClass}>
                Why Eden
              </Link>
              .
            </p>
          </section>

          <section className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Braintrust strengths
            </p>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Where Braintrust is a strong fit
            </h2>
            <p>
              Braintrust shines when quality work is organized around evals.
              Teams that live in datasets, scorers, and experiment comparisons
              often want a product that treats those objects as first-class —
              not as an afterthought bolted onto a trace viewer. If your release
              ritual is “run the suite, read the delta, decide,” Braintrust
              matches that culture.
            </p>
            <p>
              Evals-first tooling also helps when offline or staged evaluation
              is the riskiest part of the change. Prompt rewrites, retrieval
              tweaks, and judge models benefit from disciplined scoring before
              traffic shifts. Braintrust’s center of gravity in that world is a
              legitimate reason to choose it, especially for applied AI teams
              whose primary failure mode is “we shipped without measuring.”
            </p>
            <p>
              None of that makes production ops automatic. Even excellent eval
              suites leave a gap when live traffic drifts after deploy, costs
              cliff after a model swap, or a tool call starts failing only for
              one cohort. Filling that gap with homegrown detectors, tickets,
              and PRs is normal — and exactly where Eden’s closed loop is aimed.
            </p>
          </section>

          <div className="overflow-hidden border border-[var(--line)]">
            <table className="w-full text-left text-[0.875rem]">
              <thead>
                <tr className="border-b border-[var(--line)] bg-[var(--bg-inset)]">
                  <th className="type-label px-4 py-3 font-normal">Capability</th>
                  <th className="type-label px-4 py-3 font-normal">Braintrust</th>
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
                      {row.braintrust}
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
              Where Eden differs: production closed-loop ops
            </h2>
            <p>
              Eden treats evaluation as one instrument in a larger loop, not the
              whole product. You still get prompts, datasets, and live A/B with
              control vs treatment arms on the metrics that matter. Those scores
              sit next to production Issues so a regression is not only an
              experiment table — it is something detectors can open and humans
              can fix with proof.
            </p>
            <p>
              Ingest is built for production agents: Python and TypeScript SDKs,
              OpenTelemetry, or an OpenAI-compatible gateway with ≤5ms overhead
              p95, including spend, tokens, models, and cache hit rates per
              workspace. Sessions, spans, detectors, and Issues group failures
              so triage does not start with grep. That observe path is the
              substrate for everything else.
            </p>
            <p>
              Heal and Fix now are where Eden leaves evals-only workflows.
              Runtime self-heal can take reversible, budget-capped actions when
              safe — on by default, opt out in Settings — with autonomy audit
              for allow, deny, and budget. Code patches and auto-merge stay
              gated. Fix now plans cite failing spans and eval deltas; you
              approve, reject, or snooze before merge. Eden runs on Eden, so the
              same loop is dogfooded on our agents.
            </p>
            <p>
              In short: Braintrust is often the right hammer when the nail is
              experiment quality. Eden is the right hammer when the nail is
              closed-loop production ops that still respects human review. Both
              care about scores; Eden refuses to stop at the scoreboard.
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
              Many teams will keep an evals-first workflow in Braintrust while
              routing live agents through Eden for detectors, heal, and Fix now.
              That split mirrors how classical software keeps unit tests and
              production APM without forcing one tool to pretend it is the
              other. During migration, dual systems reduce risk.
            </p>
            <p>
              A clean boundary helps: Braintrust (or your eval suite) owns
              pre-ship scoring rituals; Eden owns production Issues and the path
              from detection to reviewable fix. Live A/B in Eden can still
              validate a change under real traffic after an offline suite
              passes. If eventually one product covers both rituals for your
              org, consolidate. Until then, prefer clarity over forced
              monorepo-of-tools dogma. Related pages:{" "}
              <Link href="/vs/langfuse" className={linkClass}>
                Eden vs Langfuse
              </Link>{" "}
              and{" "}
              <Link href="/vs/helicone" className={linkClass}>
                Eden vs Helicone
              </Link>
              .
            </p>
            <p>
              To try Eden’s side of the stack, read{" "}
              <Link href="/why-eden" className={linkClass}>
                Why Eden
              </Link>
              , follow the{" "}
              <a
                href={DOCS_URL}
                className={linkClass}
                rel="noopener noreferrer"
              >
                docs
              </a>{" "}
              for SDK or gateway install, and check{" "}
              <Link href="/pricing" className={linkClass}>
                pricing
              </Link>{" "}
              — Free during public beta, no credit card. Instrument one
              production path, attach detectors, run a live A/B, and see whether
              Issues plus Fix now shorten the distance from a bad score to a
              reviewed change.
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
                Score changes. Close the loop in production.
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

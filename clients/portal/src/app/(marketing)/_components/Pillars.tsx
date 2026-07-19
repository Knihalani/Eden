import { PILLARS } from "./marketing-data";

function ImprovePillar({ pillar }: { pillar: (typeof PILLARS)[number] }) {
  const Icon = pillar.icon;
  const steps = [
    { token: "01", label: "Detect regression", meta: "judge.score drift · −0.18" },
    { token: "02", label: "Cluster failing traces", meta: "47 traces · last 6h" },
    { token: "03", label: "Draft patch", meta: "prompts/system.md · +12 / −4" },
    { token: "04", label: "Run evals locally", meta: "smoke ✓ · quality ✓ · regression ✓" },
    { token: "05", label: "Queue for review", meta: "inbox · you open the PR" },
  ];
  return (
    <article className="mt-5 border border-[var(--border-default)] rounded-xl overflow-hidden bg-[var(--bg-base)]">
      <div className="grid grid-cols-1 lg:grid-cols-12">
        <div className="lg:col-span-5 p-6 lg:p-8 border-b lg:border-b-0 lg:border-r border-[var(--border-subtle)] flex flex-col">
          <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-5">
            {pillar.badge}
          </span>
          <div className="w-10 h-10 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center mb-5">
            <Icon className="w-5 h-5 text-[var(--accent)]" aria-hidden />
          </div>
          <h3
            className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight"
            style={{ letterSpacing: "-0.02em" }}
          >
            {pillar.title}
          </h3>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-6">
            {pillar.description}
          </p>
          <ul className="flex flex-col gap-2 mt-auto">
            {pillar.bullets.map((b) => (
              <li
                key={b}
                className="flex items-start gap-2 text-[13px] text-[var(--text-secondary)]"
              >
                <span
                  className="w-1 h-1 rounded-full bg-[var(--accent)] mt-2 shrink-0"
                  aria-hidden
                />
                <span className="leading-snug">{b}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:col-span-7 p-6 lg:p-8 font-mono">
          <p className="pb-4 mb-4 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] tracking-wider">
            eden — improve inbox
          </p>
          <ol className="relative space-y-3">
            {steps.map((s, i) => (
              <li key={s.token} className="relative pl-8">
                <span
                  aria-hidden="true"
                  className="absolute left-[7px] top-0 bottom-0 w-px bg-[var(--border-subtle)]"
                  style={{
                    clipPath:
                      i === 0
                        ? "polygon(0 8px, 100% 8px, 100% 100%, 0 100%)"
                        : i === steps.length - 1
                          ? "polygon(0 0, 100% 0, 100% calc(100% - 8px), 0 calc(100% - 8px))"
                          : undefined,
                  }}
                />
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1 w-[15px] h-[15px] rounded-full border border-[var(--accent)] bg-[var(--bg-base)] flex items-center justify-center text-[8px] text-[var(--accent)] font-semibold"
                >
                  {s.token}
                </span>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-[13px] text-[var(--text-primary)]">
                    {s.label}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {s.meta}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-5 pt-4 border-t border-[var(--border-subtle)] text-[12px] text-[var(--text-muted)]">
            <span className="text-[var(--text-primary)] font-semibold">
              1 suggestion queued
            </span>
            <span aria-hidden> · </span>
            evals passed · awaiting human review
          </p>
        </div>
      </div>
    </article>
  );
}

export function Pillars() {
  return (
    <section
      id="pillars"
      className="py-20 md:py-28 px-6 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30"
    >
      <div className="max-w-7xl mx-auto">
        <div className="max-w-2xl mb-14">
          <h2
            className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-4"
            style={{ letterSpacing: "-0.03em", lineHeight: 1.08 }}
          >
            Capture. Analyse. Improve.
          </h2>
          <p className="text-[var(--text-secondary)] leading-relaxed">
            Instrument once, read every call, then close the loop when evals
            regress — with a human still on the open-PR decision.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {PILLARS.slice(0, 2).map((p) => {
            const Icon = p.icon;
            return (
              <article
                key={p.id}
                className="border border-[var(--border-subtle)] rounded-xl p-6 hover:border-[var(--border-default)] transition-colors"
              >
                <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-6 block">
                  {p.badge}
                </span>
                <div className="w-10 h-10 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center mb-5">
                  <Icon className="w-5 h-5 text-[var(--accent)]" aria-hidden />
                </div>
                <h3
                  className="text-lg font-semibold text-[var(--text-primary)] mb-2 tracking-tight"
                  style={{ letterSpacing: "-0.015em" }}
                >
                  {p.title}
                </h3>
                <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-5">
                  {p.description}
                </p>
                <ul className="flex flex-col gap-2 pt-5 border-t border-[var(--border-subtle)]">
                  {p.bullets.map((b) => (
                    <li
                      key={b}
                      className="flex items-start gap-2 text-[13px] text-[var(--text-secondary)]"
                    >
                      <span
                        className="w-1 h-1 rounded-full bg-[var(--accent)] mt-2 shrink-0"
                        aria-hidden
                      />
                      <span className="leading-snug">{b}</span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>

        <ImprovePillar pillar={PILLARS[2]} />
      </div>
    </section>
  );
}

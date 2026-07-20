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
    <article className="mt-space-6 border-t border-[var(--border-default)] pt-space-6">
      <div className="grid grid-cols-1 gap-space-6 lg:grid-cols-12 lg:gap-space-8">
        <div className="lg:col-span-5 flex flex-col">
          <span className="text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-space-4">
            {pillar.badge}
          </span>
          <div className="mb-space-4 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
            <Icon className="h-5 w-5 text-[var(--accent)]" aria-hidden />
          </div>
          <h3 className="marketing-h3 mb-space-3">{pillar.title}</h3>
          <p className="mb-space-5 text-sm leading-relaxed text-[var(--text-secondary)]">
            {pillar.description}
          </p>
          <ul className="mt-auto flex flex-col gap-space-2">
            {pillar.bullets.map((b) => (
              <li
                key={b}
                className="flex items-start gap-space-2 text-[13px] text-[var(--text-secondary)]"
              >
                <span
                  className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]"
                  aria-hidden
                />
                <span className="leading-snug">{b}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="font-mono lg:col-span-7">
          <p className="mb-space-4 border-b border-[var(--border-subtle)] pb-space-3 text-2xs tracking-wider text-[var(--text-muted)]">
            eden — improve inbox
          </p>
          <ol className="relative space-y-space-3">
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
                  className="absolute left-0 top-1 flex h-[15px] w-[15px] items-center justify-center rounded-sm border border-[var(--accent)] bg-[var(--bg-primary)] text-[8px] font-semibold text-[var(--accent)]"
                >
                  {s.token}
                </span>
                <div className="flex flex-wrap items-baseline gap-x-space-3">
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
          <p className="mt-space-5 border-t border-[var(--border-subtle)] pt-space-4 text-xs text-[var(--text-muted)]">
            <span className="font-semibold text-[var(--text-primary)]">
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
      className="border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30 px-space-5 py-20 md:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="mb-space-7 max-w-2xl">
          <h2 className="marketing-h2 mb-space-4">Capture. Analyse. Improve.</h2>
          <p className="max-w-[42ch] leading-relaxed text-[var(--text-secondary)]">
            Instrument once, read every call, then close the loop when evals
            regress — with a human still on the open-PR decision.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-space-7 md:grid-cols-2 md:gap-space-8">
          {PILLARS.slice(0, 2).map((p) => {
            const Icon = p.icon;
            return (
              <article
                key={p.id}
                className="border-t border-[var(--border-subtle)] pt-space-5"
              >
                <span className="mb-space-5 block text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  {p.badge}
                </span>
                <div className="mb-space-4 flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                  <Icon className="h-5 w-5 text-[var(--accent)]" aria-hidden />
                </div>
                <h3 className="marketing-h3 mb-space-2">{p.title}</h3>
                <p className="mb-space-5 text-sm leading-relaxed text-[var(--text-secondary)]">
                  {p.description}
                </p>
                <ul className="flex flex-col gap-space-2 border-t border-[var(--border-subtle)] pt-space-5">
                  {p.bullets.map((b) => (
                    <li
                      key={b}
                      className="flex items-start gap-space-2 text-[13px] text-[var(--text-secondary)]"
                    >
                      <span
                        className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]"
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

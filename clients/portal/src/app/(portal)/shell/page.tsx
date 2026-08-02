import Link from "next/link";
import { PageHeader, StatusChip } from "@/components/ds/primitives";

const SURFACES = [
  { href: "/home", label: "Home" },
  { href: "/agents", label: "Agents" },
  { href: "/traces", label: "Traces" },
  { href: "/traces?view=sessions", label: "Sessions (Traces lens)" },
  { href: "/issues", label: "Issues" },
  { href: "/signals", label: "Detectors" },
  { href: "/evals", label: "Evals" },
  { href: "/improve", label: "Improve" },
  { href: "/prompts", label: "Prompts" },
  { href: "/guardrails", label: "Guardrails" },
  { href: "/cost", label: "Cost" },
  { href: "/agent", label: "Assistant" },
  { href: "/debugger", label: "Debugger" },
  { href: "/compare", label: "Live A/B" },
  { href: "/settings", label: "Settings" },
];

const SHORTCUTS = [
  { keys: "[", action: "Toggle nav" },
  { keys: "Bell (click)", action: "Open Inbox" },
  { keys: "esc", action: "Close alerts" },
  { keys: "j / k", action: "Next / previous" },
  { keys: "t / s / c", action: "Transcript / Signals / Ask" },
  { keys: "Ask → Assistant", action: "Open full assistant with pins" },
];
export default function LabShellPage() {
  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader title="Shell" />

      <div className="mx-auto w-full max-w-3xl px-5 py-8">
        <section>
          <h3 className="type-ui text-[var(--text)]">Status</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusChip tone="ok">ok</StatusChip>
            <StatusChip tone="fail">fail</StatusChip>
            <StatusChip tone="live">live</StatusChip>
            <StatusChip tone="neutral">idle</StatusChip>
          </div>
        </section>

        <section className="mt-10">
          <h3 className="type-ui text-[var(--text)]">Actions</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="ds-btn ds-btn-primary ds-btn-sm">
              Primary
            </button>
            <button type="button" className="ds-btn ds-btn-ghost ds-btn-sm">
              Ghost
            </button>
            <button type="button" className="ds-btn ds-btn-outline ds-btn-sm">
              Outline
            </button>
            <button type="button" className="ds-btn ds-btn-live ds-btn-sm" data-active="true">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
              Live
            </button>
          </div>
        </section>

        <section className="mt-10">
          <h3 className="type-ui text-[var(--text)]">Shortcuts</h3>
          <ul className="mt-4 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {SHORTCUTS.map((row) => (
              <li
                key={row.keys}
                className="flex items-center justify-between gap-4 py-2.5"
              >
                <span className="type-body !text-[var(--text-secondary)]">{row.action}</span>
                <kbd className="type-mono rounded border border-[var(--line)] px-1.5 py-0.5 !text-[0.6875rem]">
                  {row.keys}
                </kbd>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10">
          <h3 className="type-ui text-[var(--text)]">Surfaces</h3>
          <ul className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {SURFACES.map((s) => (
              <li key={s.href}>
                <Link
                  href={s.href}
                  className="flex items-center justify-between gap-4 py-3 transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <span className="type-ui text-[var(--text)]">{s.label}</span>
                  <span className="type-meta">{s.href}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10 border border-[var(--line)] px-4 py-4">
          <p className="type-label">Input</p>
          <input
            className="ds-input mt-2 w-full max-w-sm"
            placeholder="Search or filter…"
            readOnly
            aria-label="Sample input"
          />
        </section>
      </div>
    </div>
  );
}

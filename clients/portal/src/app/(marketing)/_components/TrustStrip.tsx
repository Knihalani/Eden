export function TrustStrip() {
  return (
    <section
      aria-label="Product facts"
      className="border-y border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40"
    >
      <div className="max-w-7xl mx-auto px-6 py-4">
        <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          <li>Gateway · Python · TypeScript</li>
          <li className="text-[var(--text-faint)]" aria-hidden="true">
            /
          </li>
          <li>Human-reviewed patches</li>
          <li className="text-[var(--text-faint)]" aria-hidden="true">
            /
          </li>
          <li>Apache-2.0 SDKs</li>
        </ul>
      </div>
    </section>
  );
}

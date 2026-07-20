export function TrustStrip() {
  return (
    <section
      aria-label="Product facts"
      className="border-y border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50"
    >
      <div className="mx-auto max-w-7xl px-6 py-5">
        <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[12px] text-[var(--text-secondary)] sm:text-[13px]">
          <li className="tracking-tight">Gateway · Python · TypeScript</li>
          <li className="text-[var(--text-faint)]" aria-hidden="true">
            ·
          </li>
          <li className="tracking-tight">Human-reviewed patches</li>
          <li className="text-[var(--text-faint)]" aria-hidden="true">
            ·
          </li>
          <li className="tracking-tight">Apache-2.0 SDKs</li>
        </ul>
      </div>
    </section>
  );
}

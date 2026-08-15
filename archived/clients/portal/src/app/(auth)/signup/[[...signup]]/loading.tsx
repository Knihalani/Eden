export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4" aria-busy="true">
      <div className="w-full max-w-[400px] space-y-4">
        <div className="eden-skeleton-pulse mx-auto h-6 w-40 rounded bg-[var(--line)]" />
        <div className="eden-skeleton-pulse mx-auto h-3.5 w-64 rounded bg-[var(--line)]" />
        <div className="space-y-2.5 pt-2">
          <div className="eden-skeleton-pulse h-11 rounded-[0.5rem] border border-[var(--line)] bg-[var(--bg-inset)]" />
          <div className="eden-skeleton-pulse h-11 rounded-[0.5rem] border border-[var(--line)] bg-[var(--bg-inset)]" />
          <div className="eden-skeleton-pulse h-11 rounded-[0.5rem] bg-[var(--accent-muted)]" />
        </div>
      </div>
      <span className="sr-only">Loading sign-up</span>
    </div>
  );
}

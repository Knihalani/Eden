export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl animate-pulse space-y-4 py-8">
      <div className="h-4 w-32 rounded bg-[var(--bg-tertiary)]" />
      <div className="h-8 w-64 rounded bg-[var(--bg-tertiary)]" />
      <div className="h-24 rounded-lg bg-[var(--bg-secondary)]" />
    </div>
  );
}

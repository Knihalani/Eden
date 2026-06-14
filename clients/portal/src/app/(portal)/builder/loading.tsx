/**
 * Skeleton shown while the builder route segment is hydrating.
 * Mirrors the chrome of the real page so the layout doesn't
 * jump when the client takes over.
 */
export default function BuilderLoading() {
  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="h-12 border-b border-[var(--border-default)] bg-[var(--bg-primary)] px-4 flex items-center gap-3">
        <div className="h-6 w-40 rounded bg-[var(--bg-tertiary)] animate-pulse" />
        <div className="h-6 w-24 rounded bg-[var(--bg-tertiary)] animate-pulse" />
      </div>
      <div className="flex-1 flex">
        <div className="hidden md:block w-60 border-r border-[var(--border-default)] bg-[var(--bg-primary)] p-3 space-y-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="h-14 rounded-md bg-[var(--bg-tertiary)] animate-pulse"
            />
          ))}
        </div>
        <div className="flex-1 bg-zinc-950" />
        <div className="hidden lg:block w-80 border-l border-[var(--border-default)] bg-[var(--bg-primary)] p-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-8 rounded bg-[var(--bg-tertiary)] animate-pulse"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Group-level skeleton for every `(portal)` route.
 *
 * Sits inside `(portal)/layout.tsx`, so the shell (sidebar, banners,
 * boot gate) is already painted and only the page body is replaced —
 * which is why one file covers all 22 segments instead of 22 near
 * identical copies. A segment that genuinely needs a different shape
 * can still drop its own `loading.tsx` next to its `page.tsx`; the
 * nearer file wins.
 *
 * Same visual language as the auth shells in `src/components/auth`:
 * blocked-out regions in `--line`, never a spinner.
 */
const STAT_TILES = [0, 1, 2, 3];
const LIST_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

export default function Loading() {
  return (
    <div className="ds-page" aria-busy="true">
      <header className="ds-page-header">
        <div className="eden-skeleton-pulse h-4 w-32 rounded bg-[var(--line)]" />
        <div className="eden-skeleton-pulse h-3 w-24 rounded bg-[var(--line)]" />
      </header>

      <div className="min-h-0 flex-1 space-y-5 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STAT_TILES.map((i) => (
            <div
              key={i}
              className="eden-skeleton-pulse h-20 rounded border border-[var(--line)] bg-[var(--bg-inset)]"
            />
          ))}
        </div>

        <div className="space-y-2">
          <div className="eden-skeleton-pulse h-3 w-28 rounded bg-[var(--line)]" />
          <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {LIST_ROWS.map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                <div className="eden-skeleton-pulse h-4 w-10 shrink-0 rounded bg-[var(--line)]" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="eden-skeleton-pulse h-3.5 w-1/3 rounded bg-[var(--line)]" />
                  <div className="eden-skeleton-pulse h-3 w-1/2 rounded bg-[var(--line)]" />
                </div>
                <div className="eden-skeleton-pulse hidden h-3 w-14 shrink-0 rounded bg-[var(--line)] sm:block" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <span className="sr-only">Loading page</span>
    </div>
  );
}

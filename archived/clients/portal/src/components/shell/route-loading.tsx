/**
 * Chrome-stable route skeletons (R073).
 * Header + reserved well — never a fake 4-KPI grid on every route.
 */
const ROWS = [0, 1, 2, 3, 4, 5];

function Pulse({ className }: { className: string }) {
  return (
    <div className={`eden-skeleton-pulse rounded bg-[var(--line)] ${className}`} />
  );
}

export function RouteLoading({
  title,
  variant = "well",
}: {
  title: string;
  variant?: "well" | "kpis" | "tabs" | "chat" | "table" | "split";
}) {
  return (
    <div className="ds-page" aria-busy="true">
      <header className="ds-page-header">
        <h1 className="type-display text-[var(--text)]">{title}</h1>
        <Pulse className="h-3 w-24" />
      </header>
      <div className="min-h-0 flex-1 p-4 sm:p-5">
        {variant === "kpis" ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-20 rounded border border-[var(--line)] bg-[var(--bg-inset)]"
              />
            ))}
          </div>
        ) : variant === "tabs" ? (
          <div className="space-y-4">
            <div className="flex gap-1">
              {["Overview", "API keys", "Members", "Audit"].map((label) => (
                <span key={label} className="ds-tab">
                  {label}
                </span>
              ))}
            </div>
            <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
              {ROWS.map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                  <Pulse className="h-3.5 w-1/3" />
                  <Pulse className="h-3 w-1/4" />
                </div>
              ))}
            </div>
          </div>
        ) : variant === "chat" ? (
          <div className="flex h-full min-h-[16rem] flex-col">
            <div className="min-h-0 flex-1 space-y-3">
              <Pulse className="h-10 w-2/3" />
              <Pulse className="h-10 w-1/2" />
            </div>
            <Pulse className="mt-auto h-10 w-full" />
          </div>
        ) : variant === "table" ? (
          <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {ROWS.map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                <Pulse className="h-4 w-10 shrink-0" />
                <Pulse className="h-3.5 w-1/3" />
                <Pulse className="ml-auto hidden h-3 w-14 sm:block" />
              </div>
            ))}
          </div>
        ) : variant === "split" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="h-28 rounded border border-[var(--line)] bg-[var(--bg-inset)]" />
            <div className="h-28 rounded border border-[var(--line)] bg-[var(--bg-inset)]" />
          </div>
        ) : (
          <div className="min-h-[12rem] rounded border border-[var(--line)] bg-[var(--bg-inset)]" />
        )}
      </div>
      <span className="sr-only">Loading {title}</span>
    </div>
  );
}

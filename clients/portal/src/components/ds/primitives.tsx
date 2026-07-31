import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  meta,
  actions,
  className,
}: {
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn("ds-page-header", className)}
      data-chrome-band="identity"
    >
      <h1>{title}</h1>
      {meta}
      {actions ? (
        <div
          className="ml-auto flex items-center gap-2"
          data-chrome-band="toolbar"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function Panel({
  children,
  className,
  muted,
}: {
  children: React.ReactNode;
  className?: string;
  muted?: boolean;
}) {
  return (
    <div className={cn(muted ? "ds-panel-muted" : "ds-panel", className)}>
      {children}
    </div>
  );
}

export function StatusChip({
  tone,
  children,
}: {
  tone: "ok" | "fail" | "neutral" | "live";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "ds-chip",
        tone === "ok" &&
          "border border-[color-mix(in_srgb,var(--success)_35%,var(--line))] bg-[var(--bg-inset)] text-[var(--success)]",
        tone === "fail" &&
          "border border-[color-mix(in_srgb,var(--error)_35%,var(--line))] bg-[var(--bg-inset)] text-[var(--error)]",
        tone === "live" &&
          "border border-[color-mix(in_srgb,var(--status-running)_35%,var(--line))] bg-[var(--bg-inset)] text-[var(--status-running)]",
        tone === "neutral" &&
          "border border-[var(--line)] bg-[var(--bg-inset)] text-[var(--text-muted)]",
      )}
    >
      {children}
    </span>
  );
}

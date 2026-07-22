export function IssueStat({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded border border-[var(--border-subtle)] p-2">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-[var(--text-primary)]">
        {value}
      </p>
    </div>
  );
}

import { cn } from "@/lib/utils";

/** Lightweight metric tile — keep out of the full ``lab-ui`` graph. */
export function MetricCell({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "error" | "ok" | "live" | "default";
}) {
  return (
    <div>
      <p className="type-label">{label}</p>
      <p
        className={cn(
          "type-value mt-1.5 !text-[1rem]",
          tone === "error" && "!text-[var(--error)]",
          tone === "ok" && "!text-[var(--success)]",
          tone === "live" && "!text-[var(--status-running)]",
        )}
      >
        {value}
      </p>
      {hint ? <p className="type-meta mt-1 truncate">{hint}</p> : null}
    </div>
  );
}

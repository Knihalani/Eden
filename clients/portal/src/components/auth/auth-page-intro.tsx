import { cn } from "@/lib/utils";

/**
 * Shared auth page intro — Wave 11.4 consistency for sign-in / sign-up /
 * invite / password surfaces (eyebrow + title + supporting line).
 */
export function AuthPageIntro({
  eyebrow,
  title,
  description,
  className,
}: {
  eyebrow: string;
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div
      className={cn("text-center space-y-space-2", className)}
      data-wave11-auth="intro"
    >
      <p className="text-xs font-mono font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
        {eyebrow}
      </p>
      <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
        {title}
      </h1>
      <p className="text-sm text-[var(--text-muted)]">{description}</p>
    </div>
  );
}

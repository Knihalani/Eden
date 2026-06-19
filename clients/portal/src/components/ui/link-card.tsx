import Link from "next/link";
import { cn } from "@/lib/utils";

interface LinkCardProps {
  href: string;
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Optional badge shown next to the title. */
  badge?: string;
  className?: string;
  /** Internal next/link vs external <a>. Defaults to internal. */
  external?: boolean;
}

/**
 * LinkCard — a clickable card for navigation surfaces (landing
 * pages, empty states, "what's next" sections). The canonical
 * replacement for the
 *   <Link className="rounded-lg border ... p-4 hover:border-[var(--accent)]">
 *     <Icon /> <title /> <description /> <ArrowRight />
 *   </Link>
 * pattern that appears in onboarding/done, settings tabs, and the
 * observability landing.
 *
 * Phase 7 of the June 2026 UI overhaul.
 */
export function LinkCard({
  href,
  title,
  description,
  icon: Icon,
  badge,
  className,
  external = false,
}: LinkCardProps) {
  const inner = (
    <>
      {Icon && <Icon className="h-5 w-5 text-[var(--accent)] shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-[var(--text-primary)] truncate">
            {title}
          </div>
          {badge && (
            <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded bg-[var(--accent-faint)] text-[var(--accent)]">
              {badge}
            </span>
          )}
        </div>
        {description && (
          <div className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">
            {description}
          </div>
        )}
      </div>
    </>
  );
  const className_ = cn(
    "flex items-start gap-3 p-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]",
    className
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className_}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={className_}>
      {inner}
    </Link>
  );
}

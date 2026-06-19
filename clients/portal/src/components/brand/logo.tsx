import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  showWordmark?: boolean;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  /** Set to `null` to render without a wrapping link (e.g. in the auth panel). */
  href?: string | null;
  alt?: string;
  /** Skip lazy-load — set true for above-the-fold placements (sidebar, marketing nav). */
  priority?: boolean;
}

const SIZES: Record<NonNullable<LogoProps["size"]>, { box: string; text: string; gap: string }> = {
  xs: { box: "h-6 w-6",   text: "text-sm",   gap: "gap-1.5" },
  sm: { box: "h-7 w-7",   text: "text-base", gap: "gap-2"   },
  md: { box: "h-8 w-8",   text: "text-lg",   gap: "gap-2.5" },
  lg: { box: "h-10 w-10", text: "text-xl",   gap: "gap-3"   },
  xl: { box: "h-12 w-12", text: "text-2xl",  gap: "gap-3.5" },
};

export function Logo({
  className,
  showWordmark = true,
  size = "md",
  href = "/dashboard",
  alt = "Eden",
  priority = false,
}: LogoProps) {
  const s = SIZES[size];
  const inner = (
    <span className={cn("flex items-center", s.gap, className)}>
      <Image
        src="/logo.svg"
        alt={alt}
        width={48}
        height={48}
        priority={priority}
        className={cn(s.box, "shrink-0")}
      />
      {showWordmark && (
        <span
          className={cn(
            s.text,
            "font-semibold tracking-tight text-[var(--text-primary)] truncate"
          )}
        >
          Eden
        </span>
      )}
    </span>
  );
  return href ? (
    <Link href={href} aria-label="Eden home" className="group">
      {inner}
    </Link>
  ) : (
    inner
  );
}

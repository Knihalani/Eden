import Link from "next/link";
import {
  MARKETING_APP_HREF,
  MARKETING_APP_LABEL,
} from "@/lib/marketing-cta";
import { cn } from "@/lib/utils";

/**
 * Header / hero CTAs — Sign in + Get started, or a single Go to Eden
 * when the session is already authorized.
 */
export function MarketingAuthCtas({
  signedIn,
  size = "md",
  className,
}: {
  signedIn: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const btn = size === "sm" ? "ds-btn-sm" : "";
  if (signedIn) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <Link
          href={MARKETING_APP_HREF}
          className={cn("ds-btn ds-btn-primary", btn, size === "md" && "px-5")}
        >
          {MARKETING_APP_LABEL}
        </Link>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Link
        href="/sign-in"
        className={cn(
          "ds-btn",
          size === "sm" ? "ds-btn-ghost" : "ds-btn-outline",
          btn,
          size === "md" && "px-5",
        )}
      >
        Sign in
      </Link>
      <Link
        href="/sign-up"
        className={cn("ds-btn ds-btn-primary", btn, size === "md" && "px-5")}
      >
        Get started
      </Link>
    </div>
  );
}

/** Single primary CTA used in mid-page / pricing / footer product column. */
export function MarketingPrimaryCta({
  signedIn,
  signedOutHref = "/sign-up",
  signedOutLabel = "Get started",
  className,
}: {
  signedIn: boolean;
  signedOutHref?: string;
  signedOutLabel?: string;
  className?: string;
}) {
  return (
    <Link
      href={signedIn ? MARKETING_APP_HREF : signedOutHref}
      className={cn("ds-btn ds-btn-primary", className)}
    >
      {signedIn ? MARKETING_APP_LABEL : signedOutLabel}
    </Link>
  );
}

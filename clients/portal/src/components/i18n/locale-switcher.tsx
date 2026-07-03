"use client";

import * as React from "react";
import { useTransition } from "react";
import { useLocale } from "next-intl";
import { useRouter, usePathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cn } from "@/lib/utils";

/**
 * Locale switcher. Renders the two supported locales as inline links
 * separated by a vertical bar — matches the spec ("EN | DE") and
 * keeps the footer chrome low-noise.
 *
 * Switching locale writes the `NEXT_LOCALE` cookie via next-intl's
 * middleware (see `src/i18n/routing.ts`) and refreshes the current
 * path so server-rendered strings reflect the new locale.
 *
 * `useTransition` keeps the click snappy: React starts the route
 * refresh in the background and we disable the link until it lands.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  function switchTo(nextLocale: (typeof routing.locales)[number]) {
    if (nextLocale === locale) return;
    startTransition(() => {
      router.replace(pathname, { locale: nextLocale });
    });
  }

  return (
    <div
      className={cn("flex items-center gap-2 text-xs", className)}
      // ponytail: aria-live so screen readers announce the pending
      // state once it lands. Without this, toggling locale silently
      // changes copy which is jarring for AT users.
      aria-live="polite"
    >
      <span className="text-[var(--text-muted)] uppercase tracking-wider">
        {/* Plain string so we don't need to ship a translation for a
         * two-letter chrome label — "Lang" works in both locales. */}
        Lang
      </span>
      {routing.locales.map((l, i) => (
        <React.Fragment key={l}>
          {i > 0 && (
            <span aria-hidden className="text-[var(--text-muted)]">
              |
            </span>
          )}
          <button
            type="button"
            onClick={() => switchTo(l)}
            disabled={isPending}
            aria-current={l === locale ? "true" : undefined}
            className={cn(
              "uppercase tracking-wider transition-colors disabled:opacity-60",
              l === locale
                ? "text-[var(--text-primary)] font-semibold"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            )}
          >
            {l}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
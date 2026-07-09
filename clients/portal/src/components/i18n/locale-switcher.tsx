"use client";

import * as React from "react";
import { useTransition } from "react";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { routing } from "@/i18n/routing";
import { cn } from "@/lib/utils";

/**
 * Locale switcher. Renders the two supported locales as inline links
 * separated by a vertical bar — matches the spec ("EN | DE") and
 * keeps the footer chrome low-noise.
 *
 * Switching locale:
 *   - Writes the `NEXT_LOCALE` cookie via `document.cookie` so the
 *     next render (server or client) sees the new locale.
 *   - Navigates to the locale-prefixed URL (`/de/...`) for German
 *     or the canonical unprefixed URL for English. The proxy
 *     rewrites `/de/...` to the unprefixed path, so the user sees
 *     the same page in their chosen locale at a shareable URL.
 *
 * `useTransition` keeps the click snappy: React starts the route
 * refresh in the background and we disable the link until it lands.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function switchTo(nextLocale: (typeof routing.locales)[number]) {
    if (nextLocale === locale) return;
    startTransition(() => {
      // Set the cookie so subsequent server renders resolve the
      // new locale. One year, lax, root path.
      try {
        document.cookie = `NEXT_LOCALE=${nextLocale}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        // Cookie write can fail in private mode — non-fatal.
      }
      // Build the locale-prefixed URL. Default locale (en) stays
      // unprefixed; everything else gets a `/<locale>` prefix.
      const target =
        nextLocale === routing.defaultLocale
          ? pathname
          : pathname === "/"
            ? `/${nextLocale}`
            : `/${nextLocale}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
      router.replace(target);
    });
  }

  return (
    // Segmented pill: one visible UI control instead of two bare
    // links separated by " | ". The active locale gets the
    // --bg-tertiary surface (same family as cards) so it reads as
    // pressed. aria-live on the wrapper keeps screen readers in sync.
    <div
      className={cn(
        "inline-flex items-center p-0.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] self-start",
        className
      )}
      role="group"
      aria-label="Language"
      aria-live="polite"
    >
      {routing.locales.map((l) => {
        const active = l === locale;
        return (
          <button
            key={l}
            type="button"
            onClick={() => switchTo(l)}
            disabled={isPending || active}
            aria-current={active ? "true" : undefined}
            className={cn(
              "px-2.5 py-1 text-[11px] font-mono uppercase tracking-[0.18em] rounded transition-colors disabled:cursor-default",
              active
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-subtle)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] disabled:opacity-80"
            )}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

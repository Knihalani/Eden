"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Density } from "@/hooks/use-sidebar-prefs";
import { DensityProvider } from "./DensityProvider";

export interface AppShellProps {
  density?: Density;
  hideChrome?: boolean;
  sidebar?: ReactNode;
  header?: ReactNode;
  mobileNav?: ReactNode;
  commandPalette?: ReactNode;
  aiRail?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * U18 AppShell — single structural chrome for the logged-in portal.
 * Auth, org sync, and sidebar state live in `(portal)/layout.tsx`;
 * this component owns the DOM scaffold and density tokens only.
 *
 * Content column uses `--bg-primary` so page body reads as a clear
 * work surface against the secondary shell / sidebar rail.
 *
 * Anti-clutter: fewer simultaneous sticky layers — sticky header lives in
 * portal-chrome; AppShell does not add a second sticky header.
 */
export function AppShell({
  density = "comfortable",
  hideChrome = false,
  sidebar,
  header,
  mobileNav,
  commandPalette,
  aiRail,
  children,
  className,
}: AppShellProps) {
  return (
    <DensityProvider density={density}>
      <div
        className={cn(
          "min-h-dvh flex flex-col lg:flex-row lg:items-start bg-[var(--bg-secondary)]",
          className,
        )}
        data-density={density}
        data-shell={hideChrome ? "minimal" : "full"}
        data-shell-sticky-layers="1"
      >
        <a href="#main-content" className="skip-to-content">
          Skip to main content
        </a>
        {!hideChrome && sidebar}
        <main
          id="main-content"
          className={cn(
            // Work surface: min-w-0 + fill viewport so secondary shell frames sidebar only.
            "flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)] lg:min-h-dvh",
            hideChrome
              ? "pb-0"
              : density === "comfortable"
                ? "pb-24 lg:pb-0"
                : "pb-20 lg:pb-0",
          )}
          data-shell-surface="work"
          tabIndex={-1}
        >
          {!hideChrome && header}
          {/* Subtle breathing so page body is not flush against the sticky header. */}
          <div
            className={cn(
              "flex-1 min-w-0 flex flex-col",
              !hideChrome && "pt-space-2",
            )}
          >
            {children}
          </div>
          {!hideChrome && mobileNav}
          {commandPalette}
        </main>
        {!hideChrome && aiRail}
      </div>
    </DensityProvider>
  );
}

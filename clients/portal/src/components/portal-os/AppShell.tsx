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
      >
        <a href="#main-content" className="skip-to-content">
          Skip to main content
        </a>
        {!hideChrome && sidebar}
        <main
          id="main-content"
          className={cn(
            "flex-1 min-w-0 flex flex-col",
            hideChrome ? "pb-0" : "pb-20 lg:pb-0",
          )}
          tabIndex={-1}
        >
          {!hideChrome && header}
          {children}
          {!hideChrome && mobileNav}
          {commandPalette}
        </main>
        {!hideChrome && aiRail}
      </div>
    </DensityProvider>
  );
}

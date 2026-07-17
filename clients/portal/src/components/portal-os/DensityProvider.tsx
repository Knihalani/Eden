"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Density } from "@/hooks/use-sidebar-prefs";

const DensityContext = createContext<Density>("comfortable");

export function DensityProvider({
  density,
  children,
}: {
  density: Density;
  children: ReactNode;
}) {
  return (
    <DensityContext.Provider value={density}>{children}</DensityContext.Provider>
  );
}

export function useDensity(): Density {
  return useContext(DensityContext);
}

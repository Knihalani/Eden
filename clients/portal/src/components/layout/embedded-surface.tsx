"use client";

import * as React from "react";

/**
 * Marks a subtree as a tab/view child of a shell page.
 * PageHeader hides chrome (keeps actions); PageContent drops outer padding.
 */
const EmbeddedSurfaceContext = React.createContext(false);

export function EmbeddedSurface({ children }: { children: React.ReactNode }) {
  return (
    <EmbeddedSurfaceContext.Provider value={true}>
      {children}
    </EmbeddedSurfaceContext.Provider>
  );
}

export function useEmbeddedSurface(): boolean {
  return React.useContext(EmbeddedSurfaceContext);
}

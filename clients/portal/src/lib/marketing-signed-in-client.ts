"use client";

import { useSyncExternalStore } from "react";

/**
 * Client-side marketing session detection without mounting ClerkProvider.
 *
 * Clerk sets ``__client_uat`` (and hashed variants) to ``0`` when signed out
 * and a unix timestamp when a session exists. Reading cookies in the browser
 * keeps marketing RSC free of ``auth()`` so pages can stay cacheable / fast.
 */
function readClientUatSignedIn(): boolean {
  if (typeof document === "undefined") return false;
  const cookies = document.cookie.split(";");
  for (const raw of cookies) {
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const name = raw.slice(0, eq).trim();
    if (!name.startsWith("__client_uat")) continue;
    const value = raw.slice(eq + 1).trim();
    if (value && value !== "0") return true;
  }
  return false;
}

function subscribe(onStoreChange: () => void): () => void {
  // Cookie changes rarely fire events; re-check on focus / visibility.
  window.addEventListener("focus", onStoreChange);
  document.addEventListener("visibilitychange", onStoreChange);
  return () => {
    window.removeEventListener("focus", onStoreChange);
    document.removeEventListener("visibilitychange", onStoreChange);
  };
}

export function useMarketingSignedIn(): boolean {
  return useSyncExternalStore(subscribe, readClientUatSignedIn, () => false);
}

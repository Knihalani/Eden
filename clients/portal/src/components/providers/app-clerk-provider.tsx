"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";

/**
 * Clerk only on authenticated / auth surfaces — marketing skips this
 * tree so public pages do not hydrate Clerk JS.
 */
const ALLOWED_REDIRECT_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://edenobservability.com",
  process.env.NEXT_PUBLIC_SITE_URL,
].filter((origin): origin is string => Boolean(origin));

if (process.env.NODE_ENV !== "production") {
  const devPort = process.env.PORT || "3000";
  for (const host of ["localhost", "127.0.0.1"]) {
    const origin = `http://${host}:${devPort}`;
    if (!ALLOWED_REDIRECT_ORIGINS.includes(origin)) {
      ALLOWED_REDIRECT_ORIGINS.push(origin);
    }
  }
}

export function AppClerkProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider allowedRedirectOrigins={ALLOWED_REDIRECT_ORIGINS}>
      {children}
    </ClerkProvider>
  );
}

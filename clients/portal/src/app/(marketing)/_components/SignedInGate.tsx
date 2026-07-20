"use client";

import type { ReactNode } from "react";
import { useUser } from "@clerk/nextjs";

/**
 * Tiny client leaf for marketing RSC pages that need signed-in CTAs.
 * Pass pre-built elements (not render props) — functions cannot cross
 * the Server → Client boundary in the App Router.
 *
 * While Clerk is loading, render nothing so signed-out CTAs do not flash.
 */
export function SignedInGate({
  signedIn,
  signedOut,
}: {
  signedIn: ReactNode;
  signedOut: ReactNode;
}) {
  const { isSignedIn, isLoaded } = useUser();
  if (!isLoaded) return null;
  return <>{isSignedIn ? signedIn : signedOut}</>;
}

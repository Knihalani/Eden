"use client";

/**
 * MotionProvider — wraps the app in a framer-motion <MotionConfig>
 * that respects the user's prefers-reduced-motion preference. The
 * CSS-level handling in globals.css (line ~951) already covers most
 * animations, but framer-motion uses its own JS animation engine
 * that bypasses CSS — so we need this provider to disable those.
 *
 * Phase 10 of the June 2026 UI overhaul.
 */

import { MotionConfig } from "framer-motion";

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">{children}</MotionConfig>
  );
}

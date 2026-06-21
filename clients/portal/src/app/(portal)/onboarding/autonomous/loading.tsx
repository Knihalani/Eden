import { LoadingSkeleton } from "@/components/ui/skeleton";

/**
 * Auto-generated loading state for /onboarding/autonomous.
 * Cat 23 audit (2026-06-21): was missing — page jumped straight
 * into the wizard without a placeholder. Renders a content-shaped
 * skeleton matching the autonomous disclosure step.
 */
export default function Loading() {
  return <LoadingSkeleton variant="default" lines={4} />;
}
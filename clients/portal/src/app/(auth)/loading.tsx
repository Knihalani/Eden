import { AuthLoadingShell } from "@/components/auth";

/**
 * Group-level fallback so segments without their own `loading.tsx`
 * (currently `reset-password`) still get the branded auth skeleton
 * instead of a blank frame. Segments that ship their own file keep it —
 * the nearer `loading.tsx` wins.
 */
export default function Loading() {
  return <AuthLoadingShell />;
}

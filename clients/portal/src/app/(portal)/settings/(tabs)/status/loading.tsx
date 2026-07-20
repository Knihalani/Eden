import { LoadingSkeleton } from "@/components/ui/skeleton";

/** W12: status tab soft-nav skeleton (matches status-tab LoadingSkeleton recipe). */
export default function StatusLoading() {
  return <LoadingSkeleton variant="stats" lines={4} />;
}

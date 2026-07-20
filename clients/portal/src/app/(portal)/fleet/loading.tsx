import { LoadingSkeleton } from "@/components/ui/skeleton";

/** W12: do not re-export the page — that forces the full fleet client graph on soft nav. */
export default function FleetLoading() {
  return <LoadingSkeleton variant="stats" lines={4} />;
}

import { Skeleton } from "@/components/ui/skeleton";

export default function InspectorLoading() {
  return (
    // `min-h-screen` here would blow out the (portal) row (the layout
    // wraps this in a `flex-1 min-h-0` main column). Match the actual
    // page wrapper instead. June 2026 layout-pass fix.
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <Skeleton className="h-10 w-full max-w-xs" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-5/6" />
        <Skeleton className="h-8 w-4/6" />
      </div>
    </div>
  );
}

import { Skeleton } from "@/components/ui/skeleton";

export default function ImprovePlanDetailLoading() {
  return (
    <div
      className="mx-auto max-w-7xl space-y-4 p-4"
      data-testid="improve-plan-detail-loading"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

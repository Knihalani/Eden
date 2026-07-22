import { Skeleton } from "@/components/ui/skeleton";

export default function CostLoading() {
  return (
    <div
      className="mx-auto max-w-7xl space-y-4 p-4"
      data-testid="cost-loading-route"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <Skeleton className="h-10 w-full" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

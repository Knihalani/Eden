import { Skeleton } from "@/components/ui/skeleton";

export default function DebuggerDetailLoading() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-8 w-48" />
      <div className="flex gap-4">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="flex gap-4">
        <Skeleton className="h-80 w-[280px] shrink-0" />
        <Skeleton className="h-80 flex-1" />
      </div>
    </div>
  );
}

import { Skeleton } from "@/components/ui/skeleton";

export default function AgentLoading() {
  return (
    <div className="flex h-full gap-0">
      <div className="hidden w-[260px] shrink-0 border-r border-[var(--border-subtle)] p-3 lg:flex lg:flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-3/4" />
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex-1 p-4 space-y-3">
          <Skeleton className="h-12 w-2/3" />
          <Skeleton className="h-8 w-1/2 ml-auto" />
          <Skeleton className="h-12 w-2/3" />
        </div>
        <div className="border-t border-[var(--border-subtle)] p-3">
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    </div>
  );
}

"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

export default function SettingsLoading() {
  return (
    <div className="flex flex-col lg:flex-row min-h-[calc(100dvh-4rem)]">
      <div className="w-full lg:w-[240px] flex-shrink-0 bg-[var(--bg-primary)] border-b lg:border-b-0 lg:border-r border-[var(--border-default)]">
        <div className="p-3 lg:p-4 space-y-3">
          <Skeleton className="h-5 w-20 mx-2" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <div className="flex flex-row lg:flex-col gap-2 overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-28 lg:w-full rounded-lg shrink-0" />
            ))}
          </div>
        </div>
      </div>
      <div className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6 w-full">
        <Card padding="md" className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </Card>
        <Card padding="xl" className="space-y-5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </Card>
      </div>
    </div>
  );
}

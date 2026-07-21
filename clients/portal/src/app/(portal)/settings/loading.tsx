"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { PageContent } from "@/components/layout/page-content";

export default function SettingsLoading() {
  return (
    <PageContent>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-full" />
          ))}
        </div>
        <div className="flex flex-wrap gap-2 border-b border-[var(--border-subtle)] pb-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-lg" />
          ))}
        </div>
        <Card padding="xl" className="space-y-5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-11 w-full rounded-lg" />
          <Skeleton className="h-11 w-2/3 rounded-lg" />
        </Card>
      </div>
    </PageContent>
  );
}

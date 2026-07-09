"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
export default function SettingsLoading() {
  return <div className="p-6 space-y-8 max-w-5xl">
      {/* Page header */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-[var(--border)]">
        {Array.from({
        length: 5
      }).map((_, i) => <Skeleton key={i} className="h-10 w-28 rounded-t-lg" />)}
      </div>

      {/* Tab content */}
      <div className="space-y-6">
        {/* Section */}
        <Card padding="xl" className="space-y-5">
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-72" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          </div>

          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <Skeleton className="h-10 w-24 rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
          </div>
        </Card>

        {/* Another section */}
        <Card padding="xl" className="space-y-5">
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-80" />
          </div>

          {Array.from({
          length: 3
        }).map((_, i) => <div key={i} className="flex items-center justify-between py-3 border-b border-[var(--border-subtle)] last:border-0">
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-9 w-20 rounded-lg" />
            </div>)}
        </Card>
      </div>
    </div>;
}
"use client";

import { Skeleton } from "@/components/ui/skeleton";

export default function JobDetailLoading() {
  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="h-14 bg-[var(--surface)] border-b border-[var(--border)] flex items-center gap-3 px-4">
        <Skeleton className="h-5 w-5 rounded" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>

      {/* Main content */}
      <div className="flex-1 flex">
        {/* Left panel - chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Stage bar */}
          <div className="h-12 bg-[var(--surface)] border-b border-[var(--border)] flex items-center gap-1 px-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="flex items-center">
                <Skeleton className="w-8 h-8 rounded-lg" />
                {i < 8 && <Skeleton className="w-4 h-0.5 mx-0.5" />}
              </div>
            ))}
          </div>

          {/* Stage label */}
          <div className="h-10 bg-[var(--accent-bg)] border-b border-[var(--border)] px-4 flex items-center">
            <Skeleton className="h-4 w-32" />
          </div>

          {/* Messages area */}
          <div className="flex-1 p-6 space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />
                <div className="flex-1 space-y-2 pt-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </div>
            ))}
          </div>

          {/* Input area */}
          <div className="h-16 border-t border-[var(--border)] px-4 flex items-center">
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </div>

        {/* Right panel */}
        <div className="w-[400px] flex-shrink-0 bg-[var(--surface)] border-l border-[var(--border)] hidden lg:flex flex-col">
          {/* Tabs */}
          <div className="h-11 border-b border-[var(--border)] flex">
            <Skeleton className="flex-1 h-full" />
            <Skeleton className="flex-1 h-full" />
          </div>

          {/* File tree area */}
          <div className="h-1/2 border-b border-[var(--border)] p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" style={{ marginLeft: `${(i % 3) * 12}px` }} />
            ))}
          </div>

          {/* Code preview area */}
          <div className="h-1/2 p-3 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="h-10 bg-[var(--surface)] border-t border-[var(--border)] flex items-center px-4">
        <Skeleton className="h-4 w-32" />
        <div className="flex-1" />
        <Skeleton className="h-4 w-24" />
      </div>
    </div>
  );
}

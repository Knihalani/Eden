"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function JobGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="bg-white shadow rounded-xl p-5">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg skeleton" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-gray-200 rounded skeleton w-1/3" />
              <div className="h-3 bg-gray-100 rounded skeleton w-1/2" />
              <div className="h-3 bg-gray-100 rounded skeleton w-1/4" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
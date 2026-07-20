"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { ArrowLeft, RefreshCw } from "lucide-react";

export default function LabelingQueueError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Labeling queue route error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center px-4">
      <ErrorState
        title="Labeling board failed to load"
        message={error.message || "An unexpected error occurred on this page."}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={reset} size="sm">
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/evals?tab=labeling">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to labeling
              </Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}

"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Home, RefreshCw } from "lucide-react";

export default function DatasetsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Datasets route error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center px-4">
      <ErrorState
        title="Datasets failed to load"
        message={error.message || "An unexpected error occurred on this page."}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={reset} size="sm">
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/evals?tab=datasets">
                <Home className="h-3.5 w-3.5" /> Evals · Datasets
              </Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}

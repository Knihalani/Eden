"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/** Soft-deleted top-level Tools — lives under Analytics → Tools. */
export default function ToolsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/analytics?tab=tools");
  }, [router]);

  return (
    <div
      className="flex h-48 items-center justify-center"
      aria-busy="true"
      data-wave6-analytics="tools-redirect"
    >
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/** Soft-deleted Topics leaf — lives under Analytics → Topics. */
export default function TopicsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/analytics?tab=topics");
  }, [router]);

  return (
    <div
      className="flex h-48 items-center justify-center"
      aria-busy="true"
      data-wave6-analytics="topics-redirect"
    >
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

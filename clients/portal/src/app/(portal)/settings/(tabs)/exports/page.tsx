"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function ExportsSettingsRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings?tab=exports");
  }, [router]);

  return (
    <div
      className="flex h-48 items-center justify-center gap-2 text-sm text-[var(--text-muted)]"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      Redirecting…
    </div>
  );
}

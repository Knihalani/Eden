"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/** Wave 3 — standalone Predict route soft-lands on Cost forecast tab. */
export default function PredictPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/optimization?tab=forecast");
  }, [router]);

  return (
    <div className="flex h-48 items-center justify-center" aria-busy="true">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

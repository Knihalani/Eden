"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAlerts } from "@/lab/alerts-context";

/** Legacy route — opens the shell alerts modal, then returns to Home. */
export default function LabAlertsRedirect() {
  const router = useRouter();
  const { openAlerts } = useAlerts();

  useEffect(() => {
    openAlerts();
    router.replace("/home");
  }, [openAlerts, router]);

  return null;
}

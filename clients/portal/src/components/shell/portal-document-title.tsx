"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { portalDocumentTitle } from "@/lib/portal-title";

/** Keeps document.title on Page · Eden during client transitions (R054). */
export function PortalDocumentTitle() {
  const pathname = usePathname();
  useEffect(() => {
    document.title = portalDocumentTitle(pathname);
  }, [pathname]);
  return null;
}

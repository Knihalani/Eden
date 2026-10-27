"use client";

import { usePathname } from "next/navigation";
import { CanvasSkeleton, HomeSkeleton } from "../home/skeletons";

/**
 * Route-shaped loading: canvas drill-ins sketch the graph + panel, everything
 * else sketches the dashboard. Same shapes as the pages they precede, so a
 * slow load never flashes the wrong layout.
 */
export default function Loading() {
  const path = usePathname();
  if (path.startsWith("/request/") || path.startsWith("/live/")) {
    return <CanvasSkeleton />;
  }
  return <HomeSkeleton />;
}

import { HomeDashboardSkeleton } from "./_components/home-dashboard-skeleton";

/**
 * Dashboard route loading — mirrors Home Status→Diagnosis→Action:
 * header, restraint KPI strip (≤4 / ≤3 mobile), diagnosis, recent failures.
 */
export default function Loading() {
  return <HomeDashboardSkeleton />;
}

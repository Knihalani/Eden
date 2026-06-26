import { Skeleton } from "@/components/ui/skeleton";

export default function BillingLoading() {
  return (
    // Same fix as inspector/loading.tsx: ``min-h-screen`` inside the
    // (portal) layout's ``flex-1 min-h-0`` main column pushes the
    // document down by an extra viewport. Match the actual page
    // wrapper. June 2026 layout-pass fix.
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

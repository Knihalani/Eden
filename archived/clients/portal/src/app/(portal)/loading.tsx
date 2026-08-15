import { RouteLoading } from "@/components/shell/route-loading";

/** Group-level fallback — chrome only, no fake 4-KPI grid (R073). */
export default function Loading() {
  return <RouteLoading title="Eden" variant="well" />;
}

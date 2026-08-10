"use client";

import dynamic from "next/dynamic";
import { PageHeader } from "@/components/ds/primitives";
import { LoadingFallback } from "@/components/shell/query-error-panel";

const GatewayClient = dynamic(() => import("./gateway-client"), {
  loading: () => (
    <div className="ds-page">
      <PageHeader title="Gateway" />
      <LoadingFallback label="Loading gateway…" rows={4} />
    </div>
  ),
});

/**
 * Code-split gateway charts (recharts ~370KB) + export helpers off the
 * initial portal shared graph — load only when this route mounts.
 */
export default function GatewayPage() {
  return <GatewayClient />;
}

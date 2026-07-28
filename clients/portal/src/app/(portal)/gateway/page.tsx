"use client";

import dynamic from "next/dynamic";
import { PageHeader } from "@/components/ds/primitives";

const GatewayClient = dynamic(() => import("./gateway-client"), {
  loading: () => (
    <div className="ds-page">
      <PageHeader
        title="Gateway"
        meta={<span className="type-meta">Loading…</span>}
      />
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

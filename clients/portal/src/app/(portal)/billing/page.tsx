"use client";

/**
 * /billing — honest free-tier billing surface while PAID_PLANS_ENABLED
 * is false on the API. Paid upgrade CTAs / Stripe checkout live in
 * BillingOverview only after paid plans ship (BILLING_PLANS empty today).
 */

import { CircleDollarSign } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { BillingOverview } from "@/components/billing/billing-overview";
import { useOrg } from "@/hooks/use-org";

export default function BillingPage() {
  const { currentOrg } = useOrg();

  return (
    <PageContent>
      <PageHeader
        eyebrow="Workspace"
        title="Billing"
        subtitle={
          <>
            Spend and free-tier caps for{" "}
            <span className="text-[var(--text-secondary)] font-medium">
              {currentOrg?.name || "your organization"}
            </span>
            . Paid plans are not available yet.
          </>
        }
        icon={CircleDollarSign}
      />
      <BillingOverview />
    </PageContent>
  );
}

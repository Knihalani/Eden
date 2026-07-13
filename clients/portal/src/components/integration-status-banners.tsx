"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  integrationLabel,
  useIntegrationStatus,
  type IntegrationId,
} from "@/hooks/use-integration-status";
import { IntegrationUnavailableBanner } from "@/components/integration-unavailable-banner";

export interface IntegrationStatusBannersProps {
  integration: IntegrationId;
  orgId?: string | null;
  className?: string;
}

/**
 * Renders a loading skeleton, nothing (when available), or an
 * IntegrationUnavailableBanner for the given integration probe.
 */
export function IntegrationStatusBanners({
  integration,
  orgId,
  className,
}: IntegrationStatusBannersProps) {
  const { status, message, retry } = useIntegrationStatus(integration, orgId);

  if (status === "loading") {
    return <Skeleton className={className ?? "h-16 w-full rounded-lg"} />;
  }

  if (status === "available") {
    return null;
  }

  return (
    <IntegrationUnavailableBanner
      label={integrationLabel(integration)}
      message={message}
      onRetry={retry}
      className={className}
    />
  );
}

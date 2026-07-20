"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, API_BASE, githubApi } from "@/lib/api";
import { isPaidPlansDisabledError } from "@/lib/feature-flag-error";

export type IntegrationId =
  | "stripe"
  | "github"
  | "storage"
  | "gateway"
  | "exports"
  | "security";

export type IntegrationStatus = "loading" | "available" | "unavailable";

export interface IntegrationStatusResult {
  status: IntegrationStatus;
  message: string | null;
  retry: () => void;
}

const LABELS: Record<IntegrationId, string> = {
  stripe: "Stripe billing",
  github: "GitHub App",
  storage: "File storage",
  gateway: "AI Gateway",
  exports: "Data exports",
  security: "SSO & security",
};

const DEFAULT_UNAVAILABLE: Record<IntegrationId, string> = {
  stripe:
    "Stripe is not configured on this Eden instance. Paid billing features are unavailable.",
  github: "GitHub App is not configured on this Eden instance.",
  storage:
    "File storage is not available on this Eden instance. Avatar uploads may fail.",
  gateway: "AI Gateway is not available on this Eden instance.",
  exports: "Data exports are temporarily unavailable.",
  security: "SSO security features are temporarily unavailable.",
};

/**
 * Map probe exceptions onto available vs unavailable.
 *
 * 503 → not configured / soft-dep down (show banner), except Stripe
 * free-only paid-plans-disabled which must stay silent (billing tab).
 * Client auth/validation 4xx → do not claim the integration is missing.
 * 5xx / network → never claim "connected"/available.
 */
export function interpretProbeFailure(
  integration: IntegrationId,
  error: unknown,
): { available: boolean; message?: string } {
  if (error instanceof ApiError) {
    if (integration === "stripe" && isPaidPlansDisabledError(error)) {
      return { available: true };
    }
    if (error.status === 503) {
      return {
        available: false,
        message: error.detail || DEFAULT_UNAVAILABLE[integration],
      };
    }
    // Exports list is admin-gated; 403 means the feature exists but is blocked.
    if (integration === "exports" && error.status === 403) {
      return {
        available: false,
        message: error.detail || DEFAULT_UNAVAILABLE.exports,
      };
    }
    if (
      error.status === 400 ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 404
    ) {
      return { available: true };
    }
    if (error.status >= 500) {
      return {
        available: false,
        message:
          error.detail ||
          `Could not verify ${LABELS[integration]} status. Try again.`,
      };
    }
  }
  return {
    available: false,
    message: `Could not verify ${LABELS[integration]} status. Try again.`,
  };
}

async function probeIntegration(
  integration: IntegrationId,
  orgId?: string | null,
): Promise<{ available: boolean; message?: string }> {
  switch (integration) {
    case "github": {
      const res = await githubApi.configured();
      return {
        available: res.configured,
        message: res.configured ? undefined : DEFAULT_UNAVAILABLE.github,
      };
    }
    case "stripe": {
      if (!orgId) {
        return { available: false, message: "Select an organization to check billing." };
      }
      try {
        await api.subscribe(orgId, {
          plan_name: "__eden_probe__",
          success_url: "https://eden.dev",
          cancel_url: "https://eden.dev",
        });
        return { available: true };
      } catch (e) {
        if (e instanceof ApiError && e.status === 400 && /unknown plan/i.test(e.detail)) {
          return { available: true };
        }
        // Free-only mode: subscribe intentionally 503s. Do not paint
        // "Stripe billing unavailable" — the Free plan card already
        // explains paid plans are not open yet.
        if (isPaidPlansDisabledError(e)) {
          return { available: true };
        }
        return interpretProbeFailure("stripe", e);
      }
    }
    case "storage": {
      try {
        const res = await fetch(`${API_BASE}/auth/users/me/avatar`, {
          method: "POST",
          credentials: "include",
        });
        if (res.status === 503) {
          const body = (await res.json().catch(() => ({}))) as { detail?: string };
          return {
            available: false,
            message: body.detail || DEFAULT_UNAVAILABLE.storage,
          };
        }
        if (res.status >= 500) {
          return {
            available: false,
            message: `Could not verify ${LABELS.storage} status. Try again.`,
          };
        }
        return { available: true };
      } catch (e) {
        return interpretProbeFailure("storage", e);
      }
    }
    case "gateway": {
      if (!orgId) {
        return { available: false, message: "Select an organization." };
      }
      try {
        await api.listGatewayModels(orgId);
        return { available: true };
      } catch (e) {
        return interpretProbeFailure("gateway", e);
      }
    }
    case "exports": {
      if (!orgId) {
        return { available: false, message: "Select an organization." };
      }
      try {
        await api.listExportDestinations(orgId);
        return { available: true };
      } catch (e) {
        return interpretProbeFailure("exports", e);
      }
    }
    case "security": {
      if (!orgId) {
        return { available: false, message: "Select an organization." };
      }
      try {
        await api.listSSOProviders(orgId);
        return { available: true };
      } catch (e) {
        return interpretProbeFailure("security", e);
      }
    }
    default:
      return { available: true };
  }
}

export function integrationLabel(integration: IntegrationId): string {
  return LABELS[integration];
}

export function useIntegrationStatus(
  integration: IntegrationId,
  orgId?: string | null,
): IntegrationStatusResult {
  const [status, setStatus] = useState<IntegrationStatus>("loading");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setMessage(null);
    try {
      const result = await probeIntegration(integration, orgId);
      setStatus(result.available ? "available" : "unavailable");
      setMessage(
        result.message ??
          (result.available ? null : DEFAULT_UNAVAILABLE[integration]),
      );
    } catch {
      // Never treat an unexpected throw as "connected"/available.
      setStatus("unavailable");
      setMessage(`Could not verify ${LABELS[integration]} status. Try again.`);
    }
  }, [integration, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { status, message, retry: load };
}

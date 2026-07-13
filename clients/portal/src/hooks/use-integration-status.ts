"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, API_BASE, githubApi } from "@/lib/api";

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
        if (e instanceof ApiError) {
          if (e.status === 400 && /unknown plan/i.test(e.detail)) {
            return { available: true };
          }
          if (e.status === 503) {
            return {
              available: false,
              message: e.detail || DEFAULT_UNAVAILABLE.stripe,
            };
          }
        }
        return { available: true };
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
        return { available: true };
      } catch {
        return { available: true };
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
        if (e instanceof ApiError && e.status === 503) {
          return {
            available: false,
            message: e.detail || DEFAULT_UNAVAILABLE.gateway,
          };
        }
        return { available: true };
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
        if (e instanceof ApiError && (e.status === 503 || e.status === 403)) {
          return {
            available: false,
            message: e.detail || DEFAULT_UNAVAILABLE.exports,
          };
        }
        return { available: true };
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
        if (e instanceof ApiError && e.status === 503) {
          return {
            available: false,
            message: e.detail || DEFAULT_UNAVAILABLE.security,
          };
        }
        return { available: true };
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
      setStatus("available");
      setMessage(null);
    }
  }, [integration, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { status, message, retry: load };
}

"use client";

import { preserveObserveFilters } from "@/lib/observe-url";
import type { AlertRow } from "./alert-types";

/** C5: Alert → Trace ≤2 clicks; retain alertId + preserve filters. */
export function buildAlertTraceHref(
  alert: AlertRow,
  searchParams: URLSearchParams,
): string | null {
  if (!alert.traceId) return null;
  const params = preserveObserveFilters(searchParams);
  params.set("traceId", alert.traceId);
  params.set("alertId", alert.alertId);
  if (alert.agentId) params.set("agentId", alert.agentId);
  const qs = params.toString();
  return qs ? `/traces?${qs}` : `/traces?traceId=${encodeURIComponent(alert.traceId)}`;
}

/** C5: Alert → Issue ≤2 clicks; retain alertId + preserve filters. */
export function buildAlertIssueHref(
  alert: AlertRow,
  searchParams: URLSearchParams,
): string | null {
  if (!alert.issueId) return null;
  const params = preserveObserveFilters(searchParams);
  params.set("alertId", alert.alertId);
  params.set("issueId", alert.issueId);
  if (alert.agentId) params.set("agentId", alert.agentId);
  const qs = params.toString();
  return `/issues/${encodeURIComponent(alert.issueId)}${qs ? `?${qs}` : ""}`;
}

/** Promote alert without issueId — open Issues with evidence params. */
export function buildCreateIssueHref(
  alert: AlertRow,
  searchParams: URLSearchParams,
): string {
  const params = preserveObserveFilters(searchParams);
  params.set("alertId", alert.alertId);
  if (alert.traceId) params.set("traceId", alert.traceId);
  if (alert.agentId) params.set("agentId", alert.agentId);
  const qs = params.toString();
  return qs ? `/issues?${qs}` : "/issues";
}

export function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const delta = Date.now() - ms;
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export const CHANNELS_SETTINGS_HREF = "/settings?tab=security";

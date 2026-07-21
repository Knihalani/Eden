"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DetailPanelShell } from "@/components/portal-os";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  improveHref,
  incidentHref,
  mergeTracePreserve,
  preserveFromRecord,
  traceHref,
  tracesFilteredHref,
  type TracePreserveParams,
} from "@/lib/portal-cross-links";
import { ChevronDown } from "lucide-react";
import { type AlertItem } from "./alert-config";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-space-4">
      <span className="shrink-0 text-xs uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </span>
      <span className="truncate font-mono text-xs text-[var(--text-secondary)]">
        {value}
      </span>
    </div>
  );
}

function alertTraceId(alert: AlertItem): string | undefined {
  const fromMeta = alert.metadata?.trace_id;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta;
  if (alert.entity_id?.startsWith("trace")) return alert.entity_id;
  return undefined;
}

export interface AlertsDetailPanelProps {
  selectedAlert: AlertItem;
  alertIndex: number;
  alertsLength: number;
  channelConfigured: Record<string, boolean>;
  /** Page URL Observe filters / time window to preserve on Traces links. */
  preserve?: TracePreserveParams;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onAcknowledge: (id: string) => void;
  onConfigureRules: () => void;
}

export function AlertsDetailPanel({
  selectedAlert,
  channelConfigured,
  preserve: pagePreserve,
  onClose,
  onPrev,
  onNext,
  onAcknowledge,
  onConfigureRules,
}: AlertsDetailPanelProps) {
  const preserve = mergeTracePreserve(
    pagePreserve,
    preserveFromRecord(selectedAlert.metadata),
  );
  const traceId = alertTraceId(selectedAlert);
  const tracesLink = traceId
    ? traceHref(traceId, preserve)
    : tracesFilteredHref(preserve ?? {});

  return (
          <DetailPanelShell
            open
            onClose={onClose}
            title={selectedAlert.title}
            onPrev={onPrev}
            onNext={onNext}
            headerActions={
              <div className="flex flex-wrap items-center gap-space-2">
                {!selectedAlert.acknowledged ? (
                  <Button
                    size="sm"
                    className="min-h-11"
                    data-testid="alerts-detail-ack"
                    data-action="resolve"
                    onClick={() => void onAcknowledge(selectedAlert.alert_id)}
                  >
                    Ack / resolve
                  </Button>
                ) : (
                  <span className="text-xs text-[var(--text-muted)]">Acknowledged</span>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="min-h-11" aria-label="More actions">
                      More
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[12rem]">
                    <DropdownMenuLabel>Go to</DropdownMenuLabel>
                    <DropdownMenuItem asChild>
                      <Link href={incidentHref()}>View incidents</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href={tracesLink} data-testid="alerts-detail-traces-link">
                        {traceId ? "Example traces" : "Traces hub"}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link
                        href={improveHref()}
                        data-testid="alerts-detail-improve-link"
                        data-wave9-improve-crossloop="alert-improve"
                      >
                        Open Improve
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={onConfigureRules}
                    >
                      Configure rules
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/settings?tab=security">Channels (Settings)</Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          >
            <div className="flex flex-col gap-space-3 p-space-4">
              <p className="text-sm text-[var(--text-secondary)]">{selectedAlert.message}</p>
              <DetailRow label="Severity" value={selectedAlert.severity} />
              <DetailRow label="Status" value={selectedAlert.acknowledged ? "Acknowledged" : "Unread"} />
              <DetailRow label="Created" value={new Date(selectedAlert.created_at).toLocaleString()} />
              <DetailRow label="Entity" value={selectedAlert.entity_id || "—"} />
              <DetailRow label="Alert ID" value={selectedAlert.alert_id} />
              <details className="mt-space-2">
                <summary className="cursor-pointer text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                  Delivery channels
                </summary>
                <div className="mt-space-2 space-y-space-1">
                  <DetailRow
                    label="Channels"
                    value={
                      selectedAlert.channels.length
                        ? selectedAlert.channels
                            .map((ch) =>
                              channelConfigured[ch] ? ch : `${ch} (not configured)`,
                            )
                            .join(", ")
                        : "—"
                    }
                  />
                  <Button variant="link" size="sm" className="min-h-11 px-0" asChild>
                    <Link href="/settings?tab=security">Open channel settings</Link>
                  </Button>
                </div>
              </details>
            </div>
          </DetailPanelShell>
  );
}

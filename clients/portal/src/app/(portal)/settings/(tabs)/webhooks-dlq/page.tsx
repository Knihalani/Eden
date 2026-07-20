"use client";

import { useState, useCallback } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import {
  RefreshCw,
  Loader2,
  AlertOctagon,
  CheckCircle2,
  ShieldOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryState } from "@/components/ui/query-state";
import { Skeleton } from "@/components/ui/skeleton";

interface DlqEntry {
  id: string;
  webhook_id: string;
  event_type: string;
  last_response_status: number | null;
  last_error: string | null;
  attempt_count: number;
  max_attempts: number;
  replay_count: number;
  last_replayed_at: string | null;
  created_at: string;
  signature_v1: string | null;
}

/**
 * D.13 webhook DLQ + replay UI.
 *
 * ponytail: per upgradespec §D.13, terminal-state webhook
 * deliveries (exceeded the 7-attempt retry budget) land
 * here for replay. The "Replay" button re-fires the
 * delivery via the same path the initial ingest used.
 *
 * Admin-gated: settings:edit (owner/admin) or role owner/admin.
 * Replay is hidden for non-admins (BE replay requires org admin).
 */
export default function WebhooksDlqPage() {
  const { currentOrg } = useOrg();
  const { hasPermission, role } = usePermissions();
  const toast = useToast();
  const orgId = currentOrg?.id ?? null;
  const [replaying, setReplaying] = useState<string | null>(null);

  const isAdmin =
    hasPermission("settings:edit") ||
    role === "owner" ||
    role === "admin" ||
    currentOrg?.role === "owner" ||
    currentOrg?.role === "admin";

  const dlqQuery = useOrgQuery(
    queryKeys.webhookDlq.list(orgId),
    orgId,
    async () => {
      const res = await api.listWebhookDlq(orgId!, 50);
      return (res.data?.entries || []) as DlqEntry[];
    },
    { enabled: isAdmin },
  );
  const loading = dlqQuery.isLoading;
  const error = dlqQuery.error
    ? (
        dlqQuery.error instanceof ApiError
          ? `Failed to load DLQ entries (HTTP ${dlqQuery.error.status}).`
          : dlqQuery.error.message || "Network error loading DLQ entries."
      )
    : null;
  const fetchData = useCallback(async () => {
    await dlqQuery.refetch();
  }, [dlqQuery]);

  const handleReplay = useCallback(
    async (dlqId: string) => {
      if (!currentOrg?.id || !isAdmin) return;
      setReplaying(dlqId);
      try {
        await api.replayWebhookDlq(currentOrg.id, dlqId);
        toast.success("Replay queued", "Delivery re-scheduled.");
        await fetchData();
      } catch (err) {
        const message =
          err instanceof ApiError
            ? `HTTP ${err.status}`
            : err instanceof Error
              ? err.message
              : "Replay request failed.";
        toast.error("Replay failed", message);
      } finally {
        setReplaying(null);
      }
    },
    [currentOrg?.id, isAdmin, toast, fetchData]
  );

  if (!currentOrg) return <NoOrgState feature="Webhook DLQ" />;

  if (!isAdmin) {
    return (
      <PageContent>
        <PageHeader
          eyebrow="Settings"
          title="Webhook Dead-Letter Queue"
          subtitle="Terminal-state deliveries awaiting replay"
        />
        <div className="p-6 bg-[var(--error-dim)] rounded-lg border border-[var(--error)]/20 text-center">
          <ShieldOff className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)]" aria-hidden="true" />
          <p className="text-sm text-[var(--error)]">
            You do not have permission to manage the webhook DLQ. Contact your organization admin.
          </p>
        </div>
      </PageContent>
    );
  }

  return (
    <PageContent>
      <PageHeader
        eyebrow="Settings"
        title="Webhook Dead-Letter Queue"
        subtitle="Terminal-state deliveries awaiting replay"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={fetchData}
            aria-label="Refresh DLQ entries"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <p className="mb-4 text-xs text-[var(--text-muted)]">
        Backoff ladder: 1s, 5s, 25s, 2m, 10m, 1h, then DLQ. Each replay
        re-fires the delivery with a fresh attempt budget.
      </p>

      <QueryState
        loading={loading}
        error={error ? new Error(error) : null}
        data={dlqQuery.data}
        onRetry={() => void fetchData()}
        errorTitle="Could not load DLQ entries"
        isEmpty={(d) => (d?.length ?? 0) === 0}
        loadingSlot={
          <div className="space-y-2 py-4" aria-busy="true">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        }
        emptySlot={
          <EmptyState
            variant="plain"
            icon={CheckCircle2}
            title="DLQ is clear"
            description="Every webhook delivery is succeeding within the retry budget."
          />
        }
      >
        {(rows) => (
            <ul className="divide-y divide-[var(--border-subtle)]" aria-label="Dead-letter entries">
              {rows.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-4 py-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <AlertOctagon
                        className="h-4 w-4 text-[var(--error)] shrink-0"
                        aria-hidden="true"
                      />
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {e.event_type}
                      </span>
                      {e.last_response_status != null && (
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs font-mono",
                            e.last_response_status >= 500
                              ? "bg-[var(--error-dim)] text-[var(--error)]"
                              : "bg-[var(--warning-bg)] text-[var(--warning)]"
                          )}
                        >
                          HTTP {e.last_response_status}
                        </span>
                      )}
                      <span className="text-xs text-[var(--text-secondary)]">
                        {e.attempt_count}/{e.max_attempts} attempts · {e.replay_count} replays
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      {new Date(e.created_at).toLocaleString()} · webhook {e.webhook_id.slice(0, 8)}…
                    </div>
                    {e.last_error && (
                      <div className="mt-1 truncate text-xs text-[var(--error)]" title={e.last_error}>
                        {e.last_error}
                      </div>
                    )}
                  </div>
                  {isAdmin && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handleReplay(e.id)}
                      disabled={replaying === e.id}
                      aria-busy={replaying === e.id}
                      aria-label={`Replay ${e.event_type} delivery`}
                    >
                      {replaying === e.id ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          Replaying…
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-3 w-3" aria-hidden="true" />
                          Replay
                        </>
                      )}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
        )}
      </QueryState>
    </PageContent>
  );
}

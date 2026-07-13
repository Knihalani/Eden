"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";
import {
  Webhook,
  RefreshCw,
  Loader2,
  AlertOctagon,
  CheckCircle2,
} from "lucide-react";

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
 */
export default function WebhooksDlqPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [entries, setEntries] = useState<DlqEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!currentOrg?.id) return;
    setError(null);
    try {
      const res = await api.listWebhookDlq(currentOrg.id, 50);
      setEntries(res.data?.entries || []);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `Failed to load DLQ entries (HTTP ${err.status}).`
          : err instanceof Error
            ? err.message
            : "Network error loading DLQ entries.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    if (!currentOrg?.id) return;
    fetchData();
  }, [currentOrg?.id, fetchData]);

  const handleReplay = useCallback(
    async (dlqId: string) => {
      if (!currentOrg?.id) return;
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
    [currentOrg?.id, toast, fetchData]
  );

  if (!currentOrg) return <NoOrgState feature="Webhook DLQ" />;

  return (
    <PageContent>
      <PageHeader
        icon={Webhook}
        eyebrow="Settings"
        title="Webhook Dead-Letter Queue"
        subtitle="D.13 — Terminal-state deliveries awaiting replay"
      />

      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
        <div className="flex items-center justify-between border-b border-[var(--border-default)] p-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Recent DLQ entries
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Backoff ladder: 1s, 5s, 25s, 2m, 10m, 1h, then DLQ. Each replay
              re-fires the delivery with a fresh attempt budget.
            </p>
          </div>
          <button
            type="button"
            onClick={fetchData}
            aria-label="Refresh DLQ entries"
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </button>
        </div>

        <div className="divide-y divide-[var(--border-default)]">
          {loading ? (
            <div
              className="flex items-center justify-center gap-2 p-8 text-sm text-[var(--text-secondary)]"
              aria-busy="true"
              aria-live="polite"
            >
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              Loading DLQ entries…
            </div>
          ) : error ? (
            <div className="p-6">
              <ErrorState
                title="Could not load DLQ entries"
                message={error}
                action={
                  <button
                    type="button"
                    onClick={fetchData}
                    className="inline-flex items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    Try again
                  </button>
                }
              />
            </div>
          ) : entries.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={CheckCircle2}
                title="DLQ is clear"
                description="Every webhook delivery is succeeding within the retry budget."
              />
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border-default)]" aria-label="Dead-letter entries">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-4 p-4"
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
                  <button
                    type="button"
                    onClick={() => handleReplay(e.id)}
                    disabled={replaying === e.id}
                    aria-busy={replaying === e.id}
                    aria-label={`Replay ${e.event_type} delivery`}
                    className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-foreground)] hover:opacity-90 disabled:opacity-50"
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
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </PageContent>
  );
}
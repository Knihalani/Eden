"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import {
  Webhook,
  RefreshCw,
  Loader2,
  AlertOctagon,
  CheckCircle2,
} from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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
  const [replaying, setReplaying] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!currentOrg?.id) return;
    try {
      const res = await fetch(
        `${API_BASE}/orgs/${currentOrg.id}/webhooks/dlq?limit=50`,
        { credentials: "include" }
      );
      if (res.ok) {
        const d = await res.json();
        setEntries(d.data?.entries || []);
      }
    } catch (err) {
      console.error("DLQ fetch failed", err);
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
      setReplaying(dlqId);
      try {
        const res = await fetch(
          `${API_BASE}/orgs/${currentOrg?.id}/webhooks/dlq/${dlqId}/replay`,
          { method: "POST", credentials: "include" }
        );
        if (res.ok) {
          toast.success("Replay queued", "Delivery re-scheduled.");
          await fetchData();
        } else {
          toast.error("Replay failed", `HTTP ${res.status}`);
        }
      } catch (err) {
        toast.error("Replay failed", String(err));
      } finally {
        setReplaying(null);
      }
    },
    [currentOrg?.id, toast, fetchData]
  );

  if (!currentOrg) return <NoOrgState feature="Webhook DLQ" />;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Webhook}
        title="Webhook Dead-Letter Queue"
        subtitle="D.13 — Terminal-state deliveries awaiting replay"
      />

      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)]">
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
            className="inline-flex items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-2)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-elev-1)]"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>

        <div className="divide-y divide-[var(--border-default)]">
          {loading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--text-secondary)]" />
            </div>
          ) : entries.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--text-secondary)]">
              <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-green-400" />
              No DLQ entries — every webhook delivery is succeeding within the
              retry budget.
            </div>
          ) : (
            entries.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between p-4"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <AlertOctagon className="h-4 w-4 text-red-400" />
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {e.event_type}
                    </span>
                    {e.last_response_status && (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-xs",
                          e.last_response_status >= 500
                            ? "bg-red-500/20 text-red-400"
                            : "bg-yellow-500/20 text-yellow-400"
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
                    <div className="mt-1 truncate text-xs text-red-400">
                      {e.last_error}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleReplay(e.id)}
                  disabled={replaying === e.id}
                  className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {replaying === e.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Replay
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
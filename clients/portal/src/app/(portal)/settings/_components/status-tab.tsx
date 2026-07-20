"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2, Play, RefreshCw } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { adminStatusApi } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";
import { errorFromCaught } from "@/lib/safe-error-message";

type EdenStatus = Awaited<ReturnType<typeof adminStatusApi.edenStatus>>;

export function StatusTab() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<EdenStatus | null>(null);
  const [flags, setFlags] = useState<Record<string, unknown> | null>(null);
  const [synthetics, setSynthetics] = useState<
    Array<{ probe: string; status: string; created_at?: string | null }>
  >([]);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const [s, last, f] = await Promise.all([
        adminStatusApi.edenStatus(currentOrg.id),
        adminStatusApi.syntheticsLast(currentOrg.id),
        adminStatusApi.flags(currentOrg.id).catch(() => null),
      ]);
      setStatus(s);
      setSynthetics(last.runs ?? []);
      setFlags(f?.flags ?? null);
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load status"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runProbes = async () => {
    if (!currentOrg?.id) return;
    setRunning(true);
    try {
      const res = await adminStatusApi.runSynthetics(currentOrg.id);
      if (res.failed > 0) {
        toast.error(
          "Synthetics finished with failures",
          `${res.failed} probe(s) failed — review recent runs below.`,
        );
      } else {
        toast.success("Synthetics complete", "All probes passed.");
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Synthetics failed");
    } finally {
      setRunning(false);
    }
  };

  if (loading && !status && !error) {
    return (
      <div className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading platform status…
      </div>
    );
  }

  if (error && !status) {
    return (
      <ErrorState
        title="Could not load status"
        message={error}
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </Button>
        }
      />
    );
  }

  const components = status?.components ?? {};
  const ingest = (components.ingest ?? {}) as {
    status?: string;
    quality_worker_lag_seconds?: number | null;
    typesense_index_lag_seconds?: number | null;
    shed?: Record<string, unknown>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--text-muted)]">
          Worker health, queue depths, and ingest lag — no infra SSH required.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} loading={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
          <Button size="sm" onClick={runProbes} loading={running}>
            <Play className="h-3.5 w-3.5" /> Run synthetics
          </Button>
        </div>
      </div>

      {error ? (
        <ErrorState
          title="Could not load status"
          message={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : null}

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="text-sm font-medium">Ingest lag</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 text-sm">
          <div>
            <div className="text-xs text-[var(--text-muted)]">Quality worker lag</div>
            <div className="font-mono">
              {ingest.quality_worker_lag_seconds == null
                ? "—"
                : `${Number(ingest.quality_worker_lag_seconds).toFixed(1)}s`}
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-muted)]">Typesense event-age lag</div>
            <div className="font-mono">
              {ingest.typesense_index_lag_seconds == null
                ? "—"
                : `${Number(ingest.typesense_index_lag_seconds).toFixed(1)}s`}
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-muted)]">Shed depth</div>
            <div className="font-mono">
              {ingest.shed && "last_depth" in ingest.shed
                ? String(ingest.shed.last_depth)
                : "—"}
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="text-sm font-medium">Overall: {status?.status ?? "unknown"}</h3>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {Object.entries(components).map(([name, data]) => (
            <div
              key={name}
              className="rounded border border-[var(--border-default)] p-3 text-sm"
            >
              <div className="font-medium capitalize">{name.replace(/_/g, " ")}</div>
              <div className="mt-1 text-xs text-[var(--text-muted)]">
                status: {(data as { status?: string }).status ?? "—"}
              </div>
              <pre className="mt-2 text-[10px] overflow-x-auto text-[var(--text-secondary)]">
                {JSON.stringify(data, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </Card>

      {flags && (
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-2">Feature flags (admin debugger)</h3>
          <pre className="text-[10px] overflow-x-auto text-[var(--text-secondary)]">
            {JSON.stringify(flags, null, 2)}
          </pre>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="text-sm font-medium mb-2">Recent synthetic runs</h3>
        {synthetics.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No runs yet. Click Run synthetics.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {synthetics.map((r, i) => (
              <li key={`${r.probe}-${i}`} className="flex justify-between gap-2">
                <span className="font-mono text-xs">{r.probe}</span>
                <span className="text-[var(--text-muted)]">{r.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-[var(--text-muted)]">
        Request ID continuity: portal 5xx responses include <code>request_id</code> for API → worker
        log correlation. See <code>docs/ops/eden-on-eden-staging.md</code>.
      </p>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { integrationsApi } from "@/lib/api";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { errorFromCaught } from "@/lib/safe-error-message";

type Props = {
  orgId: string | undefined;
  /** Integration ids to surface when unconfigured (e.g. ``exports``, ``github_action``). */
  watch: string[];
  className?: string;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "ok"; messages: string[] }
  | { kind: "error"; message: string };

export function IntegrationStatusBanner({ orgId, watch, className }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!orgId || watch.length === 0) {
      setState({ kind: "ok", messages: [] });
      return;
    }
    let cancelled = false;
    setState({ kind: "idle" });
    integrationsApi
      .status(orgId)
      .then((res) => {
        if (cancelled) return;
        const pending = (res.integrations ?? []).filter(
          (item) => watch.includes(item.id) && !item.configured,
        );
        setState({
          kind: "ok",
          messages: pending.map(
            (item) => item.detail ?? `${item.label} is not configured for this org`,
          ),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // Do not silently clear — a failed status probe must not look "all clear".
        setState({
          kind: "error",
          message: errorFromCaught(err, "Could not verify integration status"),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, watch, tick]);

  if (state.kind === "idle") return null;

  if (state.kind === "error") {
    return (
      <Banner tone="warning" className={className}>
        <div className="flex items-start justify-between gap-3 text-sm">
          <div className="flex items-start gap-2 min-w-0">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            <p>{state.message}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setTick((n) => n + 1)}
            aria-label="Retry integration status check"
            className="shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </Button>
        </div>
      </Banner>
    );
  }

  if (state.messages.length === 0) return null;

  return (
    <Banner tone="warning" className={className}>
      <div className="flex items-start gap-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
        <div className="space-y-1">
          {state.messages.map((msg) => (
            <p key={msg}>{msg}</p>
          ))}
        </div>
      </div>
    </Banner>
  );
}

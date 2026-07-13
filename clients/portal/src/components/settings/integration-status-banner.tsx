"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { integrationsApi } from "@/lib/api";
import { Banner } from "@/components/ui/banner";

type Props = {
  orgId: string | undefined;
  /** Integration ids to surface when unconfigured (e.g. ``exports``, ``github_action``). */
  watch: string[];
  className?: string;
};

export function IntegrationStatusBanner({ orgId, watch, className }: Props) {
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    if (!orgId || watch.length === 0) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    integrationsApi
      .status(orgId)
      .then((res) => {
        if (cancelled) return;
        const pending = (res.integrations ?? []).filter(
          (item) => watch.includes(item.id) && !item.configured,
        );
        setMessages(
          pending.map(
            (item) => item.detail ?? `${item.label} is not configured for this org`,
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, watch]);

  if (messages.length === 0) return null;

  return (
    <Banner tone="warning" className={className}>
      <div className="flex items-start gap-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
        <div className="space-y-1">
          {messages.map((msg) => (
            <p key={msg}>{msg}</p>
          ))}
        </div>
      </div>
    </Banner>
  );
}

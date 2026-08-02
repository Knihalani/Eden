"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { slackApi, agentsApi, type SlackRoute } from "@/lib/api/resources";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SETTINGS_QUERY } from "@/lib/portal-query";
import { useLabToast } from "@/lab/lab-toast";

/**
 * Soft Autonomy Phase 6 — Slack connect + per-agent channel routing.
 *
 * Rendered on the Settings workspace view. States:
 *  1. Instance not configured (no SLACK_* env) → card hidden upstream.
 *  2. Not connected → "Connect Slack" (OAuth redirect).
 *  3. Connected → workspace name, org-default channel picker, per-agent
 *     overrides, disconnect, and a "Send test" button.
 *
 * Approve actions are never in Slack — alerts deep-link to the portal.
 */
export function SlackSettingsCard() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const [busy, setBusy] = useState<string | null>(null);

  const configuredQuery = useOrgQuery(
    ["integrations", "slack", "configured"],
    orgId,
    () => slackApi.configured(),
    SETTINGS_QUERY,
  );
  const installQuery = useOrgQuery(
    queryKeys.portal.slackInstall(orgId),
    orgId,
    () => slackApi.install(orgId!),
    { ...SETTINGS_QUERY, enabled: configuredQuery.data?.configured === true },
  );
  const channelsQuery = useOrgQuery(
    queryKeys.portal.slackChannels(orgId),
    orgId,
    () => slackApi.channels(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: Boolean(installQuery.data),
      // Channel list is live from Slack — don't hammer it.
      staleTime: 60_000,
    },
  );
  const routesQuery = useOrgQuery(
    queryKeys.portal.slackRoutes(orgId),
    orgId,
    () => slackApi.routes(orgId!),
    { ...SETTINGS_QUERY, enabled: Boolean(installQuery.data) },
  );
  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    async () => (await agentsApi.list(orgId!, { limit: 100 })).agents,
    { ...SETTINGS_QUERY, enabled: Boolean(installQuery.data) },
  );

  const invalidate = useCallback(async () => {
    if (!orgId) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.portal.slackInstall(orgId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.portal.slackRoutes(orgId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.portal.slackChannels(orgId),
      }),
    ]);
  }, [orgId, queryClient]);

  const connect = useCallback(async () => {
    if (!orgId) return;
    setBusy("connect");
    try {
      const { authorize_url } = await slackApi.authorize(orgId);
      window.location.href = authorize_url;
    } catch (err) {
      pushToast({
        title: "Slack connect failed",
        body: err instanceof Error ? err.message : "Try again.",
        tone: "fail",
      });
      setBusy(null);
    }
  }, [orgId, pushToast]);

  const disconnect = useCallback(async () => {
    if (!orgId) return;
    setBusy("disconnect");
    try {
      await slackApi.disconnect(orgId);
      await invalidate();
      pushToast({ title: "Slack disconnected", body: "", tone: "ok" });
    } catch (err) {
      pushToast({
        title: "Disconnect failed",
        body: err instanceof Error ? err.message : "Try again.",
        tone: "fail",
      });
    } finally {
      setBusy(null);
    }
  }, [orgId, invalidate, pushToast]);

  const setRoute = useCallback(
    async (agentId: string | null, channelId: string) => {
      if (!orgId) return;
      const ch = (channelsQuery.data ?? []).find((c) => c.id === channelId);
      setBusy(`route:${agentId ?? "default"}`);
      try {
        await slackApi.setRoute(orgId, {
          agent_id: agentId,
          channel_id: channelId,
          channel_name: ch?.name ?? "",
        });
        await invalidate();
        pushToast({
          title: "Channel updated",
          body: ch ? `#${ch.name}` : channelId,
          tone: "ok",
        });
      } catch (err) {
        pushToast({
          title: "Channel update failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
      } finally {
        setBusy(null);
      }
    },
    [orgId, channelsQuery.data, invalidate, pushToast],
  );

  const sendTest = useCallback(
    async (agentId: string | null) => {
      if (!orgId) return;
      setBusy(`test:${agentId ?? "default"}`);
      try {
        await slackApi.sendTest(orgId, agentId);
        pushToast({
          title: "Test sent",
          body: "Check the Slack channel.",
          tone: "ok",
        });
      } catch (err) {
        pushToast({
          title: "Test failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
      } finally {
        setBusy(null);
      }
    },
    [orgId, pushToast],
  );

  const routes = useMemo(() => {
    const map = new Map<string, SlackRoute>();
    for (const r of routesQuery.data ?? []) map.set(r.agent_id ?? "", r);
    return map;
  }, [routesQuery.data]);

  if (!configuredQuery.data?.configured) return null;

  const install = installQuery.data;
  const channels = channelsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const defaultRoute = routes.get("");

  return (
    <section className="border-b border-[var(--line)] px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="type-label">Slack alerts</p>
          <p className="type-meta mt-1">
            Issues, fix PRs, and approval requests — per agent. Approvals
            always happen here in the portal.
          </p>
        </div>
        {install ? (
          <div className="flex items-center gap-2">
            <span className="type-meta">
              Connected to <strong>{install.team_name || install.team_id}</strong>
            </span>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={busy !== null}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={busy !== null}
            onClick={() => void connect()}
          >
            {busy === "connect" ? "Redirecting…" : "Connect Slack"}
          </button>
        )}
      </div>

      {install ? (
        <div className="mt-4 space-y-3">
          <ChannelRow
            label="Default channel"
            hint="Used when an agent has no override."
            value={defaultRoute?.channel_id ?? ""}
            channels={channels}
            disabled={busy !== null || channels.length === 0}
            onChange={(id) => void setRoute(null, id)}
            onTest={() => void sendTest(null)}
            testing={busy === "test:default"}
          />
          {agents.map((a) => {
            const route = routes.get(a.agent_id);
            return (
              <ChannelRow
                key={a.agent_id}
                label={a.name || a.agent_id}
                hint={a.agent_id}
                value={route?.channel_id ?? ""}
                channels={channels}
                disabled={busy !== null || channels.length === 0}
                onChange={(id) => void setRoute(a.agent_id, id)}
                onTest={() => void sendTest(a.agent_id)}
                testing={busy === `test:${a.agent_id}`}
              />
            );
          })}
          {channels.length === 0 ? (
            <p className="type-meta">
              No channels visible — invite the Eden bot to at least one
              channel in Slack, then reload.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ChannelRow({
  label,
  hint,
  value,
  channels,
  disabled,
  onChange,
  onTest,
  testing,
}: {
  label: string;
  hint?: string;
  value: string;
  channels: { id: string; name: string; is_private: boolean }[];
  disabled: boolean;
  onChange: (channelId: string) => void;
  onTest: () => void;
  testing: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-40">
        <p className="type-body">{label}</p>
        {hint ? <p className="type-meta">{hint}</p> : null}
      </div>
      <select
        className="ds-input min-w-48"
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
      >
        <option value="">
          {value ? "Keep current" : "Choose a channel…"}
        </option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.is_private ? "🔒 " : "#"}
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm"
        disabled={disabled || !value}
        onClick={onTest}
      >
        {testing ? "Sending…" : "Send test"}
      </button>
    </div>
  );
}

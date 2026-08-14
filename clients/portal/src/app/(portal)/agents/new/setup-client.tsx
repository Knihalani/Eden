"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { fetchApi } from "@/lib/api/core";
import { agentsApi, slackApi, type SlackChannel, type SlackUser } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";
import { SHELL_QUERY } from "@/lib/portal-query";
import {
  CANNOT_TELL_BANNER,
  INVITE_EDEN_COPY,
  JOB_SENTENCE_LABEL,
  JOB_SENTENCE_MIN,
  LISTENING_BANNER,
} from "../help-copy";
import { SlackNotifyPicker, SlackWatchPicker, pickableChannels } from "../slack-channel-picker";

export function SetupClient() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [name, setName] = useState("");
  const [sentence, setSentence] = useState("");
  const [ySlackId, setYSlackId] = useState("");
  const [watchIds, setWatchIds] = useState<string[]>([]);
  const [notifyId, setNotifyId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installQuery = useOrgQuery(
    queryKeys.portal.slackInstall(orgId),
    orgId,
    () => slackApi.install(orgId!),
    SHELL_QUERY,
  );
  const slackConnected = Boolean(installQuery.data);
  const channelsQuery = useOrgQuery(
    queryKeys.portal.slackChannels(orgId),
    orgId,
    () => slackApi.channels(orgId!),
    { ...SHELL_QUERY, enabled: Boolean(orgId && slackConnected) },
  );
  const usersQuery = useOrgQuery(
    queryKeys.portal.slackUsers(orgId),
    orgId,
    () => slackApi.users(orgId!),
    { ...SHELL_QUERY, enabled: Boolean(orgId && slackConnected) },
  );

  const channels: SlackChannel[] = channelsQuery.data ?? [];
  const users: SlackUser[] = usersQuery.data ?? [];
  const pickable = pickableChannels(channels);

  const banner = useMemo(() => {
    if (!slackConnected || watchIds.length === 0) return CANNOT_TELL_BANNER;
    return LISTENING_BANNER;
  }, [slackConnected, watchIds.length]);

  const canSave =
    name.trim().length > 0 && sentence.trim().length >= JOB_SENTENCE_MIN && !saving;

  async function connectSlack() {
    if (!orgId) return;
    const { authorize_url } = await slackApi.authorize(orgId);
    window.location.href = authorize_url;
  }

  async function onSave() {
    if (!orgId || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const registered = await agentsApi.register(orgId, { name: name.trim() });
      const agentId = registered.agent.agent_id;
      const yUser = users.find((u) => u.id === ySlackId);
      await fetchApi(`/orgs/${orgId}/agent-sessions/help-contract`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Org-Id": orgId },
        body: JSON.stringify({
          agent_id: agentId,
          sentence: sentence.trim(),
          y_slack_user_id: ySlackId.trim() || null,
          y_person: yUser?.name || null,
        }),
      });
      if (slackConnected && (watchIds.length || notifyId)) {
        const byId = new Map(pickable.map((c) => [c.id, c]));
        await slackApi.setup(orgId, {
          agent_id: agentId,
          watch_channels: watchIds
            .map((id) => {
              const ch = byId.get(id);
              return ch ? { channel_id: ch.id, channel_name: ch.name } : null;
            })
            .filter((x): x is { channel_id: string; channel_name: string } => x != null),
          notify_channel_id: notifyId || null,
          notify_channel_name: byId.get(notifyId)?.name ?? "",
        });
      }
      router.push(`/agents?id=${encodeURIComponent(agentId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this agent.");
      setSaving(false);
    }
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="New agent"
        meta={<span className="type-meta">Name the job. Pick where leftover work shows up.</span>}
        actions={
          <Link href="/agents" className="ds-btn ds-btn-ghost ds-btn-sm">
            Back to Agents
          </Link>
        }
      />
      <form
        className="mx-auto w-full max-w-2xl space-y-5 px-5 py-6 sm:px-6"
        data-testid="agent-setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
      >
        {banner ? (
          <p
            data-testid="setup-banner"
            className={
              banner === CANNOT_TELL_BANNER
                ? "rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-sm"
                : "rounded-md border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2 text-sm"
            }
          >
            {banner}
          </p>
        ) : null}

        <label className="block text-sm">
          <span className="type-label">Name</span>
          <input
            className="ds-input mt-1 w-full"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Refund helper"
            aria-label="Agent name"
          />
        </label>

        <label className="block text-sm">
          <span className="type-label">{JOB_SENTENCE_LABEL}</span>
          <input
            className="ds-input mt-1 w-full"
            required
            minLength={JOB_SENTENCE_MIN}
            maxLength={280}
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            placeholder={JOB_SENTENCE_LABEL}
            aria-label="Job sentence"
          />
        </label>

        {!slackConnected ? (
          <div className="space-y-2">
            <p className="type-meta">Slack is not connected. You can skip it and still save.</p>
            <button
              type="button"
              className="ds-btn ds-btn-outline ds-btn-sm"
              onClick={() => void connectSlack()}
            >
              Connect Slack
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="type-label">Y — who this takes work off</span>
              <select
                className="ds-input mt-1 w-full"
                aria-label="Y Slack user"
                value={ySlackId}
                onChange={(e) => setYSlackId(e.target.value)}
              >
                <option value="">Choose a person…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.id}
                  </option>
                ))}
              </select>
            </label>
            <SlackWatchPicker
              channels={channels}
              selectedIds={watchIds}
              onChange={setWatchIds}
            />
            <SlackNotifyPicker
              channels={channels}
              value={notifyId}
              onChange={setNotifyId}
            />
          </div>
        )}

        <p className="type-meta">{INVITE_EDEN_COPY}</p>

        {error ? (
          <p className="text-sm text-[var(--danger)]" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className="ds-btn ds-btn-primary"
          disabled={!canSave}
          data-testid="setup-save"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

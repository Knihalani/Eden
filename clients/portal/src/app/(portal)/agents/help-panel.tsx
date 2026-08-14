"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { fetchApi } from "@/lib/api/core";
import { slackApi } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";
import { SHELL_QUERY } from "@/lib/portal-query";

const LOUD_BAR =
  "If they will not invite Eden to the channels where leftover work shows up, and will not map those channels to a HelpContract, you cannot close the loop. Traces alone are not enough. Thumbs alone are not enough. A Slack install that only pages out is not enough. The team must not have to tag anything. Do not sign the design-partner week.";
const FAIL_LOUD =
  "We can see this agent run. We cannot tell if it helped — Eden is not invited to the channel where leftover work would show up, or that channel is not mapped. Do not sign the design-partner week.";
const NO_HISTORY =
  "We can page this channel. We cannot see whether a person still did the work in it.";
const NO_CONTRACT =
  "We can see it run. We cannot tell if it helped, because nobody wrote what help means.";
const NO_MAP =
  "We can page. We cannot see leftover work — invite Eden and map this channel.";

export type HelpStatus = {
  contract: { sentence?: string; x_keywords?: string[]; y_person?: string | null; y_slack_user_id?: string | null } | null;
  mapped_channels: { channel_id: string; channel_name?: string }[];
  invited: boolean;
  history_consented: boolean;
  leftover: {
    snippet?: string | null;
    join_key?: { slack_channel_id?: string };
    observed_at?: string;
    session_id?: string | null;
    path?: string;
  }[];
  counts: { helped: number; not_helped: number; unknown: number; leftover_7d: number };
  unknown_reason: "invite" | "map" | "no extra work seen" | "no_contract" | null;
  install_bar: { loud: boolean; copy: string };
};

export function HelpChip({
  value,
  unknownReason,
  success,
}: {
  value?: string | null;
  unknownReason?: string | null;
  success?: boolean | null;
}) {
  const v = value || "unknown";
  const label =
    v === "helped"
      ? "Helped"
      : v === "not_helped"
        ? "Didn’t help"
        : unknownReason === "invite" || unknownReason === "not_invited"
          ? "Unknown · invite"
          : unknownReason === "map" || unknownReason === "unmapped"
            ? "Unknown · map"
            : unknownReason === "no extra work seen" || unknownReason === "no_extra_work_seen"
              ? "Unknown · no extra work seen"
              : "Unknown";
  const tone = v === "helped" ? "helped" : v === "not_helped" ? "not-helped" : "unknown";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        data-helped={v}
        data-help-tone={tone}
        className="type-meta rounded-full border border-[var(--line)] px-2 py-0.5"
      >
        {label}
      </span>
      {success != null ? (
        <span className="type-meta rounded-full border border-[var(--line)] px-2 py-0.5">
          agent {success ? "success" : "fail"}
        </span>
      ) : null}
    </span>
  );
}

export function HelpInstallBar({ agentId }: { agentId?: string | null }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const q = useOrgQuery(
    ["help-status", orgId, agentId || "none"] as const,
    orgId,
    () =>
      fetchApi<{ status: string; data: HelpStatus }>(
        `/orgs/${orgId}/agent-sessions/help-status${
          agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ""
        }`,
      ),
    SHELL_QUERY,
  );
  const data = q.data?.data;
  const [sentence, setSentence] = useState("");
  const [keywords, setKeywords] = useState("");
  const [ySlackId, setYSlackId] = useState("");
  useEffect(() => {
    if (!data?.contract) return;
    if (!sentence && data.contract.sentence) setSentence(data.contract.sentence);
    if (!keywords && data.contract.x_keywords?.length) setKeywords(data.contract.x_keywords.join(", "));
    if (!ySlackId && data.contract.y_slack_user_id) setYSlackId(data.contract.y_slack_user_id);
  }, [data?.contract]);
  const copy = useMemo(() => {
    if (!data) return `${LOUD_BAR} ${FAIL_LOUD}`;
    if (!data.invited || !data.mapped_channels?.length) {
      return `${LOUD_BAR} ${data.install_bar?.copy || FAIL_LOUD}`;
    }
    if (data.install_bar?.copy) return data.install_bar.copy;
    if (!data.contract) return NO_CONTRACT;
    if (!data.history_consented) return NO_HISTORY;
    return "";
  }, [data]);
  const leftover = data?.leftover || [];
  const counts = data?.counts || { helped: 0, not_helped: 0, unknown: 0, leftover_7d: 0 };

  const channelsQuery = useOrgQuery(
    queryKeys.portal.slackChannels(orgId),
    orgId,
    () => slackApi.channels(orgId!),
    { ...SHELL_QUERY, enabled: Boolean(orgId && data?.invited) },
  );
  const routesQuery = useOrgQuery(
    queryKeys.portal.slackRoutes(orgId),
    orgId,
    () => slackApi.routes(orgId!),
    { ...SHELL_QUERY, enabled: Boolean(orgId && data?.invited) },
  );
  const channels = channelsQuery.data ?? [];
  const mappedForAgent = (routesQuery.data ?? []).find(
    (r) => r.agent_id === agentId,
  );

  async function saveContract() {
    if (!orgId || !agentId || sentence.trim().length < 8) return;
    await fetchApi(`/orgs/${orgId}/agent-sessions/help-contract`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Org-Id": orgId },
      body: JSON.stringify({
        agent_id: agentId,
        sentence: sentence.trim(),
        x_keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
        y_slack_user_id: ySlackId.trim() || null,
      }),
    });
    void q.refetch();
  }

  async function mapChannel(channelId: string) {
    if (!orgId || !agentId || !channelId) return;
    const ch = channels.find((c) => c.id === channelId);
    await slackApi.setRoute(orgId, {
      agent_id: agentId,
      channel_id: channelId,
      channel_name: ch?.name ?? "",
    });
    await Promise.all([
      q.refetch(),
      queryClient.invalidateQueries({ queryKey: queryKeys.portal.slackRoutes(orgId) }),
    ]);
  }

  return (
    <section className="mb-4 space-y-3 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] p-3">
      <p className="type-label">Did it actually help?</p>
      {copy ? (
        <p className="rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-sm">
          {copy}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 type-meta">
        <span>{counts.leftover_7d} ambient leftover (7d)</span>
        <span>· {counts.helped} helped</span>
        <span>· {counts.not_helped} didn’t</span>
        <span>· {counts.unknown} unknown</span>
      </div>
      {agentId ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[16rem] flex-1 text-sm">
            This is supposed to take X off Y.
            <input
              className="ds-input mt-1 w-full"
              maxLength={280}
              minLength={8}
              placeholder={data?.contract?.sentence || "This is supposed to take X off Y."}
              value={sentence}
              onChange={(e) => setSentence(e.target.value)}
            />
          </label>
          <button type="button" className="ds-btn ds-btn-outline ds-btn-sm" onClick={() => void saveContract()}>
            Save contract
          </button>
          <label className="min-w-[12rem] text-sm">
            X keywords (comma-separated)
            <input
              className="ds-input mt-1 w-full"
              placeholder={(data?.contract?.x_keywords || []).join(", ") || "refund, checkout"}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </label>
          <label className="min-w-[12rem] text-sm">
            Y Slack user id
            <input
              className="ds-input mt-1 w-full"
              placeholder={data?.contract?.y_slack_user_id || "U0123ABC"}
              value={ySlackId}
              onChange={(e) => setYSlackId(e.target.value)}
            />
          </label>
        </div>
      ) : null}
      {agentId ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[16rem] text-sm">
            Map a Slack channel (unmapped is a Stage 1 drop)
            <select
              className="ds-input mt-1 w-full"
              aria-label="Map Slack channel"
              value={mappedForAgent?.channel_id ?? ""}
              onChange={(e) => {
                if (e.target.value) void mapChannel(e.target.value);
              }}
            >
              <option value="">
                {mappedForAgent ? "Keep current" : "Choose a channel…"}
              </option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #
                  {c.name}
                  {c.is_member ? "" : " · invite Eden"}
                </option>
              ))}
            </select>
          </label>
          {mappedForAgent ? (
            <p className="type-meta">Mapped #{mappedForAgent.channel_name || mappedForAgent.channel_id}</p>
          ) : (
            <p className="type-meta">Unmapped — leftover work in this channel is dropped.</p>
          )}
        </div>
      ) : null}
      {leftover.length ? (
        <ul className="space-y-1 text-sm">
          {leftover.map((hit, i) => {
            const ch = hit.join_key?.slack_channel_id || "ops";
            const ts = hit.observed_at || "";
            return (
              <li key={`${ch}-${ts}-${i}`}>
                Y still did X in #{ch} at {ts}
                {hit.snippet ? ` — “${hit.snippet}”` : ""}
                {!hit.session_id ? " · no similar session" : ""}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="type-meta">No extra work seen — unknown, not helped.</p>
      )}
    </section>
  );
}

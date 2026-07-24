"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { useQueryPatch } from "@/lab/agent-scope";
import {
  WORKSPACE,
  activeKeys,
  memberCounts,
  packsForAgent,
  type ApiKeyFixture,
  type AuditPackFixture,
  type KeyScope,
  type MemberFixture,
  type MemberRole,
  type WorkspaceFixture,
} from "@/lab/fixtures/settings";
import {
  parseAuditTab,
  parseSettingsMode,
  resolveSettingsModeParam,
  SettingsModeNav,
  type AuditTab,
  type SettingsMode,
} from "@/lab/settings/settings-chrome";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { api } from "@/lib/api/resources";
import { SETTINGS_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { useLabToast } from "@/lab/lab-toast";

const settingsFallback = (
  <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
    <p className="type-meta">Loading…</p>
  </div>
);

const SettingsWorkspaceView = dynamic(
  () =>
    import("@/lab/settings/settings-workspace-view").then((m) => ({
      default: m.SettingsWorkspaceView,
    })),
  { loading: () => settingsFallback },
);
const SettingsKeysView = dynamic(
  () =>
    import("@/lab/settings/settings-keys-view").then((m) => ({
      default: m.SettingsKeysView,
    })),
  { loading: () => settingsFallback },
);
const SettingsMembersView = dynamic(
  () =>
    import("@/lab/settings/settings-members-view").then((m) => ({
      default: m.SettingsMembersView,
    })),
  { loading: () => settingsFallback },
);
const SettingsAuditView = dynamic(
  () =>
    import("@/lab/settings/settings-audit-view").then((m) => ({
      default: m.SettingsAuditView,
    })),
  { loading: () => settingsFallback },
);

const WORKSPACE_PATCH_KEY_MAP: Record<string, string> = {
  timezone: "timezone",
  density: "density",
  retentionDays: "retention_days",
  piiRedaction: "pii_redaction",
  defaultNotifyChannel: "default_notify_channel",
  defaultNotifyDestination: "default_notify_destination",
};

function LabSettingsInner() {
  const searchParams = useSearchParams();
  const paramTab = searchParams.get("tab");
  const paramMode = resolveSettingsModeParam(
    searchParams.get("mode"),
    paramTab,
  );
  const paramId = searchParams.get("id");
  const paramAgent = searchParams.get("agent");

  const patchQuery = useQueryPatch();
  const { currentOrg, orgSyncing } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();

  const workspaceQuery = useOrgQuery(
    queryKeys.portal.workspace(orgId),
    orgId,
    () => portalApi.workspace(orgId!),
    SETTINGS_QUERY,
  );
  const loadMode = parseSettingsMode(paramMode);
  const keysQuery = useOrgQuery(
    queryKeys.portal.keys(orgId),
    orgId,
    () => portalApi.keys(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: loadMode === "keys",
    },
  );
  const membersQuery = useOrgQuery(
    queryKeys.portal.members(orgId),
    orgId,
    () => portalApi.members(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: loadMode === "members",
    },
  );
  const auditEventsQuery = useOrgQuery(
    queryKeys.portal.auditEvents(orgId),
    orgId,
    () => portalApi.auditEvents(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: loadMode === "audit",
    },
  );
  const auditPacksQuery = useOrgQuery(
    queryKeys.portal.auditPacks(orgId),
    orgId,
    () => portalApi.auditPacks(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: loadMode === "audit",
    },
  );

  const workspaceData = workspaceQuery.data ?? WORKSPACE;
  const keysData = keysQuery.data ?? [];
  const membersData = membersQuery.data ?? [];
  const events = auditEventsQuery.data ?? [];
  const packsData = auditPacksQuery.data ?? [];

  // Wait for soft-switch remaps, but never spin forever when the user
  // has no org (queries stay disabled and would never resolve).
  const isLoading =
    orgSyncing ||
    (Boolean(orgId) &&
      (loadMode === "keys"
        ? workspaceQuery.isLoading || keysQuery.isLoading
        : loadMode === "members"
          ? workspaceQuery.isLoading || membersQuery.isLoading
          : loadMode === "audit"
            ? workspaceQuery.isLoading ||
              auditEventsQuery.isLoading ||
              auditPacksQuery.isLoading
            : workspaceQuery.isLoading));
  const isError =
    loadMode === "keys"
      ? workspaceQuery.isError || keysQuery.isError
      : loadMode === "members"
        ? workspaceQuery.isError || membersQuery.isError
        : loadMode === "audit"
          ? workspaceQuery.isError ||
            auditEventsQuery.isError ||
            auditPacksQuery.isError
          : workspaceQuery.isError;
  const firstError =
    loadMode === "keys"
      ? (workspaceQuery.error ?? keysQuery.error)
      : loadMode === "members"
        ? (workspaceQuery.error ?? membersQuery.error)
        : loadMode === "audit"
          ? (workspaceQuery.error ??
            auditEventsQuery.error ??
            auditPacksQuery.error)
          : workspaceQuery.error;

  const invalidateWorkspace = useCallback((): Promise<void> => {
    if (!orgId) return Promise.resolve();
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.portal.workspace(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.portal.auditEvents(orgId) }),
    ]).then(() => undefined);
  }, [orgId, queryClient]);
  const invalidateKeys = useCallback((): Promise<void> => {
    if (!orgId) return Promise.resolve();
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.portal.keys(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.portal.auditEvents(orgId) }),
    ]).then(() => undefined);
  }, [orgId, queryClient]);
  const invalidateMembers = useCallback((): Promise<void> => {
    if (!orgId) return Promise.resolve();
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.portal.members(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.portal.auditEvents(orgId) }),
    ]).then(() => undefined);
  }, [orgId, queryClient]);

  // Local overlays for actions the backend doesn't yet persist, or that
  // need to render before the next refetch lands (e.g. a freshly minted
  // API key secret, which the server never returns again).
  const [pendingSecrets, setPendingSecrets] = useState<Record<string, string>>({});
  const [memberStatusOverride, setMemberStatusOverride] = useState<
    Record<string, MemberFixture["status"]>
  >({});
  const [packVerifiedOverride, setPackVerifiedOverride] = useState<
    Record<string, boolean>
  >({});
  const [localPacks, setLocalPacks] = useState<AuditPackFixture[]>([]);

  const workspace = workspaceData;
  const keys = useMemo(
    () =>
      keysData.map((k) =>
        pendingSecrets[k.id] ? { ...k, secret: pendingSecrets[k.id] } : k,
      ),
    [keysData, pendingSecrets],
  );
  const members = useMemo(
    () =>
      membersData.map((m) =>
        memberStatusOverride[m.id]
          ? { ...m, status: memberStatusOverride[m.id] }
          : m,
      ),
    [membersData, memberStatusOverride],
  );
  const packs = useMemo(() => {
    const merged = [...localPacks, ...packsData];
    return merged.map((p) =>
      packVerifiedOverride[p.id] !== undefined
        ? { ...p, verified: packVerifiedOverride[p.id] }
        : p,
    );
  }, [localPacks, packsData, packVerifiedOverride]);

  const [mode, setMode] = useState<SettingsMode>(() =>
    parseSettingsMode(paramMode),
  );
  const [auditTab, setAuditTab] = useState<AuditTab>(() =>
    parseAuditTab(paramTab),
  );
  const [agentId, setAgentId] = useState(paramAgent ?? "all");
  const [keyId, setKeyId] = useState<string | null>(
    () => (paramId && mode === "keys" ? paramId : null),
  );
  const [memberId, setMemberId] = useState<string | null>(
    () => (paramId && mode === "members" ? paramId : null),
  );
  const [packId, setPackId] = useState<string | null>(
    () => (paramId && mode === "audit" ? paramId : null),
  );

  // Default the selection once live rows arrive (initial state above
  // can't reach into query data that hasn't resolved yet).
  useEffect(() => {
    if (keyId || keys.length === 0) return;
    setKeyId(keys[0].id);
  }, [keys, keyId]);
  useEffect(() => {
    if (packId || packs.length === 0) return;
    setPackId(packs[0].id);
  }, [packs, packId]);

  useEffect(() => {
    setMode(parseSettingsMode(paramMode));
    setAuditTab(parseAuditTab(paramTab));
    if (paramAgent) setAgentId(paramAgent);
    else if (paramMode !== "audit") setAgentId("all");
    if (paramId) {
      const m = parseSettingsMode(paramMode);
      if (m === "keys") setKeyId(paramId);
      if (m === "members") setMemberId(paramId);
      if (m === "audit") setPackId(paramId);
    }
  }, [paramMode, paramTab, paramId, paramAgent]);

  // Keep Packs selection inside the current agent filter.
  useEffect(() => {
    if (mode !== "audit" || auditTab !== "packs") return;
    const rows = packsForAgent(agentId, packs);
    if (rows.length === 0) return;
    if (rows.some((p) => p.id === packId)) return;
    const next = rows[0]?.id ?? null;
    setPackId(next);
    patchQuery({
      mode: "audit",
      tab: "packs",
      id: next,
      agent: agentId === "all" ? null : agentId,
    });
  }, [agentId, mode, auditTab, packId, packs, patchQuery]);

  const changeMode = useCallback(
    (next: SettingsMode, opts?: { tab?: AuditTab }) => {
      setMode(next);
      const tab = opts?.tab ?? auditTab;
      if (opts?.tab) setAuditTab(opts.tab);

      if (next === "workspace") {
        patchQuery({ mode: null, tab: null, id: null, agent: null });
        return;
      }
      if (next === "keys") {
        const id =
          (keyId && keys.some((k) => k.id === keyId) ? keyId : null) ??
          keys[0]?.id ??
          null;
        setKeyId(id);
        patchQuery({ mode: "keys", tab: null, id, agent: null });
        return;
      }
      if (next === "members") {
        setMemberId(null);
        patchQuery({ mode: "members", tab: null, id: null, agent: null });
        return;
      }
      const scoped = packsForAgent(agentId, packs);
      const id =
        (packId && scoped.some((p) => p.id === packId) ? packId : null) ??
        scoped[0]?.id ??
        packs[0]?.id ??
        null;
      setPackId(id);
      patchQuery({
        mode: "audit",
        tab: tab === "events" ? null : tab,
        id: tab === "packs" ? id : null,
        agent: tab === "packs" && agentId !== "all" ? agentId : null,
      });
    },
    [
      patchQuery,
      auditTab,
      keyId,
      keys,
      memberId,
      members,
      packId,
      packs,
      agentId,
    ],
  );

  const selectKey = useCallback(
    (id: string) => {
      setKeyId(id);
      setMode("keys");
      patchQuery({ mode: "keys", id, tab: null, agent: null });
    },
    [patchQuery],
  );

  const selectMember = useCallback(
    (id: string) => {
      setMemberId(id);
      setMode("members");
      patchQuery({ mode: "members", id, tab: null, agent: null });
    },
    [patchQuery],
  );

  const closeMember = useCallback(() => {
    setMemberId(null);
    patchQuery({ mode: "members", id: null, tab: null, agent: null });
  }, [patchQuery]);

  const selectPack = useCallback(
    (id: string) => {
      setPackId(id);
      setMode("audit");
      setAuditTab("packs");
      patchQuery({
        mode: "audit",
        tab: "packs",
        id,
        agent: agentId !== "all" ? agentId : null,
      });
    },
    [patchQuery, agentId],
  );

  const changeAuditTab = useCallback(
    (tab: AuditTab) => {
      setAuditTab(tab);
      const scoped = packsForAgent(agentId, packs);
      const id =
        (packId && scoped.some((p) => p.id === packId) ? packId : null) ??
        scoped[0]?.id ??
        null;
      if (tab === "packs") setPackId(id);
      patchQuery({
        mode: "audit",
        tab: tab === "events" ? null : tab,
        id: tab === "packs" ? id : null,
        agent: tab === "packs" && agentId !== "all" ? agentId : null,
      });
    },
    [patchQuery, packId, agentId, packs],
  );

  const changePackAgent = useCallback(
    (id: string) => {
      setAgentId(id);
      const scoped = packsForAgent(id, packs);
      const next =
        (packId && scoped.some((p) => p.id === packId) ? packId : null) ??
        scoped[0]?.id ??
        null;
      setPackId(next);
      patchQuery({
        mode: "audit",
        tab: "packs",
        id: next,
        agent: id === "all" ? null : id,
      });
    },
    [patchQuery, packId, packs],
  );

  const renameWorkspace = useCallback(
    (name: string) => {
      if (!orgId) return;
      api
        .updateOrgSettings(orgId, { name })
        .then(() => invalidateWorkspace())
        .catch((err) => {
          pushToast({
            title: "Rename failed",
            body: err instanceof Error ? err.message : "Try again.",
            tone: "fail",
          });
        });
    },
    [orgId, invalidateWorkspace, pushToast],
  );

  const patchWorkspace = useCallback(
    (patch: Partial<WorkspaceFixture>, label: string) => {
      if (!orgId) return;
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        mapped[WORKSPACE_PATCH_KEY_MAP[key] ?? key] = value;
      }
      api
        .updateOrgSettings(orgId, mapped)
        .then(() => invalidateWorkspace())
        .catch((err) => {
          pushToast({
            title: "Update failed",
            body: err instanceof Error ? err.message : label,
            tone: "fail",
          });
        });
    },
    [orgId, invalidateWorkspace, pushToast],
  );

  const createKey = useCallback(
    async (name: string, scopes: KeyScope[]): Promise<ApiKeyFixture> => {
      if (!orgId) throw new Error("No organization selected");
      const res = await api.createApiKey(orgId, name, scopes);
      setPendingSecrets((prev) => ({ ...prev, [res.id]: res.raw_key }));
      await invalidateKeys();
      return {
        id: res.id,
        name: res.name,
        prefix: res.key_prefix,
        secret: res.raw_key,
        scopes: (res.scopes as KeyScope[] | undefined) ?? scopes,
        status: "active",
        createdAt: res.created_at ?? "just now",
        lastUsed: null,
        createdBy: "You",
      };
    },
    [orgId, invalidateKeys],
  );

  const revokeKey = useCallback(
    async (id: string) => {
      if (!orgId) {
        throw new Error("No workspace selected");
      }
      try {
        await api.revokeApiKey(orgId, id);
        setPendingSecrets((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await invalidateKeys();
      } catch (err) {
        pushToast({
          title: "Revoke failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
        throw err;
      }
    },
    [orgId, invalidateKeys, pushToast],
  );

  const dismissSecret = useCallback((id: string) => {
    setPendingSecrets((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const inviteMember = useCallback(
    async (email: string, role: MemberRole): Promise<MemberFixture> => {
      if (!orgId) throw new Error("No organization selected");
      const res = await api.inviteOrgMember(orgId, email, role);
      await invalidateMembers();
      return {
        id: res.invitation_id,
        name: email.split("@")[0] || "invitee",
        email,
        role,
        status: "invited",
        lastActive: "—",
      };
    },
    [orgId, invalidateMembers],
  );

  const changeRole = useCallback(
    (id: string, role: MemberRole) => {
      if (!orgId) return;
      api
        .updateOrgMemberRole(orgId, id, role)
        .then(() => invalidateMembers())
        .catch((err) => {
          pushToast({
            title: "Role change failed",
            body: err instanceof Error ? err.message : "Try again.",
            tone: "fail",
          });
        });
    },
    [orgId, invalidateMembers, pushToast],
  );

  const resendInvite = useCallback(
    (id: string) => {
      if (!orgId) return;
      const member = members.find((m) => m.id === id);
      if (!member) return;
      api
        .inviteOrgMember(orgId, member.email, member.role)
        .then(() => {
          invalidateMembers();
          pushToast({ title: "Invite resent", body: member.email, tone: "ok" });
        })
        .catch((err) => {
          pushToast({
            title: "Resend failed",
            body: err instanceof Error ? err.message : "Try again.",
            tone: "fail",
          });
        });
    },
    [orgId, members, invalidateMembers, pushToast],
  );

  // No backend endpoint for member enable/disable yet — local overlay only.
  const disableMember = useCallback((id: string) => {
    setMemberStatusOverride((prev) => ({ ...prev, [id]: "disabled" }));
  }, []);

  const enableMember = useCallback((id: string) => {
    setMemberStatusOverride((prev) => ({ ...prev, [id]: "active" }));
  }, []);

  // No backend endpoint for audit pack reverify/export yet — local overlay only.
  const reverifyPack = useCallback((id: string) => {
    setPackVerifiedOverride((prev) => ({ ...prev, [id]: true }));
  }, []);

  const exportPack = useCallback(
    (agent: string) => {
      const created: AuditPackFixture = {
        id: `ap_${Date.now().toString(36)}`,
        at: "just now",
        agentId: agent,
        kind: "export",
        actor: "You",
        entryHash: `${Math.random().toString(16).slice(2, 8)}…${Math.random().toString(16).slice(2, 6)}`,
        verified: true,
        rows: 0,
      };
      setLocalPacks((prev) => [created, ...prev]);
      setPackId(created.id);
      setAuditTab("packs");
      setMode("audit");
      patchQuery({
        mode: "audit",
        tab: "packs",
        id: created.id,
        agent: agentId !== "all" ? agentId : null,
      });
    },
    [patchQuery, agentId],
  );

  const counts = memberCounts(members);
  const liveKeys = activeKeys(keys);
  const meta = useMemo(
    () => (
      <span className="type-meta">
        {workspace.planLabel}
        <span className="mx-1.5 text-[var(--text-faint)]">·</span>
        {liveKeys.length} keys
        <span className="mx-1.5 text-[var(--text-faint)]">·</span>
        {counts.active} members
      </span>
    ),
    [workspace.planLabel, liveKeys.length, counts.active],
  );

  if (isLoading) {
    return (
      <div className="ds-page">
        <PageHeader
          title="Settings"
          actions={
            <SettingsModeNav value={mode} onChange={(m) => changeMode(m)} />
          }
        />
        <QueryLoadingPanel label="Loading settings…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="ds-page">
        <PageHeader
          title="Settings"
          actions={
            <SettingsModeNav value={mode} onChange={(m) => changeMode(m)} />
          }
        />
        <QueryErrorPanel
          error={firstError}
          onRetry={() => {
            void workspaceQuery.refetch();
            void keysQuery.refetch();
            void membersQuery.refetch();
            void auditEventsQuery.refetch();
            void auditPacksQuery.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Settings"
        meta={meta}
        actions={
          <SettingsModeNav value={mode} onChange={(m) => changeMode(m)} />
        }
      />

      {mode === "workspace" ? (
        <SettingsWorkspaceView
          workspace={workspace}
          keys={keys}
          members={members}
          packs={packs}
          events={events}
          onGo={changeMode}
          onRename={renameWorkspace}
          onPatch={patchWorkspace}
        />
      ) : null}
      {mode === "keys" ? (
        <SettingsKeysView
          keys={keys}
          selectedId={keyId}
          onSelect={selectKey}
          onCreate={createKey}
          onRevoke={revokeKey}
          onDismissSecret={dismissSecret}
        />
      ) : null}
      {mode === "members" ? (
        <SettingsMembersView
          members={members}
          selectedId={memberId}
          onSelect={selectMember}
          onClose={closeMember}
          onInvite={inviteMember}
          onRole={changeRole}
          onResend={resendInvite}
          onDisable={disableMember}
          onEnable={enableMember}
        />
      ) : null}
      {mode === "audit" ? (
        <SettingsAuditView
          tab={auditTab}
          onTab={changeAuditTab}
          agentId={agentId}
          onAgent={changePackAgent}
          events={events}
          packs={packs}
          selectedPackId={packId}
          onSelectPack={selectPack}
          onReverify={reverifyPack}
          onExportPack={exportPack}
        />
      ) : null}
    </div>
  );
}

function SettingsSuspenseFallback() {
  const searchParams = useSearchParams();
  const mode = parseSettingsMode(
    resolveSettingsModeParam(
      searchParams.get("mode"),
      searchParams.get("tab"),
    ),
  );
  return (
    <div className="ds-page">
      <PageHeader
        title="Settings"
        meta={<span className="type-meta">Loading…</span>}
        actions={
          <SettingsModeNav value={mode} onChange={() => undefined} />
        }
      />
    </div>
  );
}

export default function LabSettingsPage() {
  return (
    <Suspense fallback={<SettingsSuspenseFallback />}>
      <LabSettingsInner />
    </Suspense>
  );
}

"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { useQueryPatch } from "@/lab/agent-scope";
import {
  WORKSPACE,
  activeKeys,
  memberCounts,
  packsForAgent,
  type ApiKeyFixture,
  type KeyScope,
  type MemberRole,
  type WorkspaceFixture,
} from "@/lab/fixtures/settings";
import {
  parseAuditTab,
  parseSettingsMode,
  resolveSettingsModeParam,
  SettingsModeNav,
  SETTINGS_ROUTE_MODES,
  type AuditTab,
  type SettingsMode,
} from "@/lab/settings/settings-chrome";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useInvalidateMe } from "@/hooks/use-me-query";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { api } from "@/lib/api/resources";
import { SETTINGS_QUERY } from "@/lib/portal-query";
import {
  InlineLoading,
  LoadingFallback,
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";

const settingsFallback = <LoadingFallback label="Loading settings…" />;

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

import type { InviteOutcome } from "@/lab/settings/settings-members-view";

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

  const router = useRouter();
  // SSO / RBAC / SCIM / PII policy live on dedicated ``/settings/{mode}``
  // routes, not as an in-page tab here. Redirect old bookmarks / legacy
  // `?tab=scim` / `?tab=pii` links (and any `?mode=roles|sso|pii|scim`)
  // straight to the real screen instead of silently falling back to the
  // workspace overview.
  useEffect(() => {
    if (
      paramMode &&
      (SETTINGS_ROUTE_MODES as readonly string[]).includes(paramMode)
    ) {
      router.replace(`/settings/${paramMode}`);
    }
  }, [paramMode, router]);

  const patchQuery = useQueryPatch();

  // Canonicalize legacy `?tab=` → `?mode=` so the URL matches live IA.
  useEffect(() => {
    if (!paramTab || searchParams.get("mode")) return;
    const mapped = resolveSettingsModeParam(null, paramTab);
    if (!mapped) return;
    patchQuery({ mode: mapped, tab: null });
  }, [paramTab, searchParams, patchQuery]);

  const { currentOrg, organizations, orgSyncing } = useOrg();
  const { hasPermission } = usePermissions();
  const invalidateMe = useInvalidateMe();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const canInvite = hasPermission("members:invite");
  const canEditSettings = hasPermission("settings:edit");
  const isPersonalWorkspace = Boolean(currentOrg?.is_personal);

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
      // Workspace health cards need key counts too — don't wait for
      // the keys tab or Settings shows "0 keys" / "ingest blocked"
      // while a Quickstart key already exists.
      enabled: loadMode === "keys" || loadMode === "workspace",
    },
  );
  const membersQuery = useOrgQuery(
    queryKeys.portal.members(orgId),
    orgId,
    () => portalApi.members(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: loadMode === "members" || loadMode === "workspace",
    },
  );
  const auditEventsQuery = useOrgQuery(
    queryKeys.portal.auditEvents(orgId),
    orgId,
    () => portalApi.auditEvents(orgId!),
    {
      ...SETTINGS_QUERY,
      // Workspace overview renders an Audit health card — without these
      // enabled it painted "Clean / Verified" off empty defaults.
      enabled: loadMode === "audit" || loadMode === "workspace",
    },
  );
  const auditPacksQuery = useOrgQuery(
    queryKeys.portal.auditPacks(orgId),
    orgId,
    () => portalApi.auditPacks(orgId!),
    {
      ...SETTINGS_QUERY,
      enabled: loadMode === "audit" || loadMode === "workspace",
    },
  );

  const workspaceData = workspaceQuery.data ?? WORKSPACE;
  const keysData = keysQuery.data ?? [];
  const membersData = membersQuery.data ?? [];
  const events = auditEventsQuery.data ?? [];
  const packsData = auditPacksQuery.data ?? [];

  // Wait for soft-switch remaps, but never spin forever when the user
  // has no org (queries stay disabled and would never resolve).
  // Overview (workspace) health cards read keys + members — wait for
  // those queries too or HealthCard paints "0 keys / ingest blocked"
  // while the request is still in flight (or swallows keysQuery errors).
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
            : workspaceQuery.isLoading ||
              keysQuery.isLoading ||
              membersQuery.isLoading ||
              auditEventsQuery.isLoading ||
              auditPacksQuery.isLoading));
  const isError =
    loadMode === "keys"
      ? workspaceQuery.isError || keysQuery.isError
      : loadMode === "members"
        ? workspaceQuery.isError || membersQuery.isError
        : loadMode === "audit"
          ? workspaceQuery.isError ||
            auditEventsQuery.isError ||
            auditPacksQuery.isError
          : workspaceQuery.isError ||
            keysQuery.isError ||
            membersQuery.isError ||
            // Workspace overview renders the Audit health card off
            // these queries — swallowing their errors painted
            // "Clean / Verified" on empty defaults.
            auditEventsQuery.isError ||
            auditPacksQuery.isError;
  const firstError =
    loadMode === "keys"
      ? (workspaceQuery.error ?? keysQuery.error)
      : loadMode === "members"
        ? (workspaceQuery.error ?? membersQuery.error)
        : loadMode === "audit"
          ? (workspaceQuery.error ??
            auditEventsQuery.error ??
            auditPacksQuery.error)
          : (workspaceQuery.error ??
            keysQuery.error ??
            membersQuery.error ??
            auditEventsQuery.error ??
            auditPacksQuery.error);

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

  // Local overlay for freshly minted API key secrets (server never returns again).
  const [pendingSecrets, setPendingSecrets] = useState<Record<string, string>>({});

  const workspace = workspaceData;
  const keys = useMemo(
    () =>
      keysData.map((k) =>
        pendingSecrets[k.id] ? { ...k, secret: pendingSecrets[k.id] } : k,
      ),
    [keysData, pendingSecrets],
  );
  const members = membersData;
  const packs = packsData;

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

  // ROI / deep-links: /settings#autonomy-settings|autonomy-audit
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (hash !== "autonomy-settings" && hash !== "autonomy-audit") return;

    setMode("workspace");
    patchQuery({ mode: null, tab: null, id: null, agent: null });

    let cancelled = false;
    const scroll = () => {
      if (cancelled) return;
      document.getElementById(hash)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    };
    // Workspace cards mount asynchronously — retry briefly after mode switch.
    const t0 = window.setTimeout(scroll, 50);
    const t1 = window.setTimeout(scroll, 250);
    const t2 = window.setTimeout(scroll, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [patchQuery]);

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
    async (name: string) => {
      if (!orgId) throw new Error("No organization selected");
      try {
        await api.updateOrgSettings(orgId, { name });
        await invalidateWorkspace();
        // The sidebar switcher reads the org name from /auth/me —
        // without this it kept the old name until the next poll.
        await invalidateMe();
      } catch (err) {
        pushToast({
          title: "Rename failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
        throw err;
      }
    },
    [orgId, invalidateWorkspace, invalidateMe, pushToast],
  );

  const patchWorkspace = useCallback(
    async (patch: Partial<WorkspaceFixture>, label: string) => {
      if (!orgId) throw new Error("No organization selected");
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        mapped[WORKSPACE_PATCH_KEY_MAP[key] ?? key] = value;
      }
      try {
        await api.updateOrgSettings(orgId, mapped);
        await invalidateWorkspace();
      } catch (err) {
        pushToast({
          title: "Update failed",
          body: err instanceof Error ? err.message : label,
          tone: "fail",
        });
        throw err;
      }
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
    async (email: string, role: MemberRole): Promise<InviteOutcome> => {
      if (!orgId) throw new Error("No organization selected");
      const res = await api.inviteOrgMember(orgId, email, role);
      await invalidateMembers();
      return {
        member: {
          id: res.invitation_id,
          name: email.split("@")[0] || "invitee",
          email,
          role,
          status: "invited",
          lastActive: "—",
        },
        // Surfaced so the UI can say "email didn't go out — share this
        // link" instead of lying "Invite sent" (backend always returns
        // invite_url for exactly this case).
        emailStatus: res.email_status ?? null,
        inviteUrl: res.invite_url ?? null,
      };
    },
    [orgId, invalidateMembers],
  );

  const changeRole = useCallback(
    async (id: string, role: MemberRole) => {
      if (!orgId) throw new Error("No organization selected");
      try {
        await api.updateOrgMemberRole(orgId, id, role);
        await invalidateMembers();
      } catch (err) {
        pushToast({
          title: "Role change failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
        throw err;
      }
    },
    [orgId, invalidateMembers, pushToast],
  );

  const resendInvite = useCallback(
    (id: string) => {
      if (!orgId) return;
      const member = members.find((m) => m.id === id);
      if (!member) return;
      // Dedicated resend endpoint — re-POSTing /invites 400'd with
      // "already pending" for exactly the invites this button targets.
      api
        .resendOrgInvite(orgId, member.id)
        .then((res) => {
          invalidateMembers();
          if (res.email_status && res.email_status !== "sent") {
            pushToast({
              title: "Invite renewed — email not sent",
              body: res.invite_url
                ? `Share this link: ${res.invite_url}`
                : member.email,
              tone: "accent",
            });
          } else {
            pushToast({
              title: "Invite resent",
              body: member.email,
              tone: "ok",
            });
          }
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

  const removeMember = useCallback(
    async (id: string) => {
      if (!orgId) throw new Error("No organization selected");
      try {
        await api.removeOrgMember(orgId, id);
        await invalidateMembers();
        if (memberId === id) setMemberId(null);
      } catch (err) {
        pushToast({
          title: "Remove failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
        throw err;
      }
    },
    [orgId, invalidateMembers, pushToast, memberId],
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

  // Render-only guard: distinguishes "no workspace selected" from "this
  // workspace has zero data". Queries above stay disabled while orgId is
  // null (see isLoading's comment), so without this we'd otherwise fall
  // through to the fixture-backed default render below. This does not
  // touch the `!orgId` early-returns inside the mutation callbacks
  // further up (renameWorkspace, createKey, inviteMember, etc.) — those
  // guard against a workspace switch racing the request, not this.
  if (!orgId && !orgSyncing) {
    return (
      <NoWorkspaceGuard
        title="Settings"
        message={
          organizations.length === 0
            ? "No workspace yet — create one from the banner above to get started."
            : "Select a workspace to view settings."
        }
        actions={
          <SettingsModeNav value={mode} onChange={(m) => changeMode(m)} />
        }
      />
    );
  }

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
          canEdit={canEditSettings}
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
          canInvite={canInvite && !isPersonalWorkspace}
          canRemove={hasPermission("members:remove")}
          onSelect={selectMember}
          onClose={closeMember}
          onInvite={inviteMember}
          onRole={changeRole}
          onResend={resendInvite}
          onRemove={removeMember}
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
        meta={<InlineLoading label="Loading settings" />}
        actions={
          // Non-interactive while the real page suspends — tabs that
          // look clickable but swallow clicks read as broken.
          <div aria-hidden="true" className="pointer-events-none opacity-60">
            <SettingsModeNav value={mode} onChange={() => undefined} />
          </div>
        }
      />
      <LoadingFallback label="Loading settings…" rows={4} />
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

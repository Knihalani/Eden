"use client";

/**
 * Settings hub — ≤8 daily tabs + Advanced disclosure (surfaces/settings.md).
 * Gateway + API keys are first-class (readable for all members; mutate gated in-tab).
 */

import { useState, useEffect, useRef, Suspense, useMemo } from "react";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { isPersonalWorkspace, isTeamOnlyTab } from "@/lib/workspace-mode";
import { Skeleton } from "@/components/ui/skeleton";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import SettingsLoading from "./loading";
import { useSearchParams, useRouter } from "next/navigation";
import { SettingsSearch } from "@/components/settings/settings-search";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import {
  TABS,
  GHOST_TABS,
  WAVE9_SETTINGS_COMPLETED,
  WAVE9_DAILY_TAB_CAP,
  WS1_SETTINGS_SHELL_COMPLETED,
  SETTINGS_AUDIT_LOG_REDIRECT_HREF,
  SETTINGS_DAILY_TAB_IDS,
  isRailTab,
  tabMatchesQuery,
  type Tab,
  type TabDef,
} from "./_components/settings-tab-registry";

const FALLBACK_TAB: Tab = "overview";
const tabLoading = () => <Skeleton className="h-64 w-full" />;
const AnalyticsTab = dynamic(() => import("./_components/analytics-tab").then((m) => ({ default: m.AnalyticsTab })), { ssr: false, loading: tabLoading });
const AutonomousTab = dynamic(() => import("./_components/autonomous-tab").then((m) => ({ default: m.default })), { ssr: false, loading: tabLoading });
const BillingTab = dynamic(() => import("./_components/billing-tab").then((m) => ({ default: m.BillingTab })), { ssr: false, loading: tabLoading });
const ExportsTab = dynamic(() => import("./_components/exports-tab").then((m) => ({ default: m.ExportsTab })), { ssr: false, loading: tabLoading });
const GatewayTab = dynamic(() => import("./_components/gateway-tab").then((m) => ({ default: m.GatewayTab })), { ssr: false, loading: tabLoading });
const PiiPolicyTab = dynamic(() => import("./_components/pii-policy-tab").then((m) => ({ default: m.PiiPolicyTab })), { ssr: false, loading: tabLoading });
const RetentionPolicyTab = dynamic(() => import("./_components/retention-policy-tab").then((m) => ({ default: m.RetentionPolicyTab })), { ssr: false, loading: tabLoading });
const WebhooksDlqTab = dynamic(() => import("./_components/webhooks-dlq-tab").then((m) => ({ default: m.WebhooksDlqTab })), { ssr: false, loading: tabLoading });
const ScimTab = dynamic(() => import("./_components/scim-tab").then((m) => ({ default: m.ScimTab })), { ssr: false, loading: tabLoading });
const SecurityTab = dynamic(() => import("./_components/security-tab").then((m) => ({ default: m.SecurityTab })), { ssr: false, loading: tabLoading });
const SidebarSettingsTab = dynamic(() => import("./_components/sidebar-settings-tab").then((m) => ({ default: m.SidebarSettingsTab })), { ssr: false, loading: tabLoading });
const McpTab = dynamic(() => import("./_components/mcp-tab").then((m) => ({ default: m.McpTab })), { ssr: false, loading: tabLoading });
const StatusTab = dynamic(() => import("./_components/status-tab").then((m) => ({ default: m.StatusTab })), { ssr: false, loading: tabLoading });
const FinOpsKillsTab = dynamic(() => import("./_components/finops-kills-tab").then((m) => ({ default: m.FinOpsKillsTab })), { ssr: false, loading: tabLoading });
const AccountPanel = dynamic(() => import("./_components/account-panel").then((m) => ({ default: m.AccountPanel })), { ssr: false, loading: tabLoading });
const OverviewPanel = dynamic(() => import("./_components/overview-panel").then((m) => ({ default: m.OverviewPanel })), { ssr: false, loading: tabLoading });
const OrgTab = dynamic(() => import("./_components/org-tab").then((m) => ({ default: m.OrgTab })), { ssr: false, loading: tabLoading });
const MembersTab = dynamic(() => import("./_components/members-tab").then((m) => ({ default: m.MembersTab })), { ssr: false, loading: tabLoading });
const ReferencesTab = dynamic(() => import("./_components/references-tab").then((m) => ({ default: m.ReferencesTab })), { ssr: false, loading: tabLoading });
const ApiKeysTab = dynamic(() => import("./_components/api-keys-tab").then((m) => ({ default: m.ApiKeysTab })), { ssr: false, loading: tabLoading });

const DAILY_SET = new Set<string>(SETTINGS_DAILY_TAB_IDS);

function resolveInitialTab(raw: string | null, canAccess: (id: Tab) => boolean): Tab {
  if (!raw || raw === "audit-log") return FALLBACK_TAB;
  if (GHOST_TABS.has(raw)) return FALLBACK_TAB;
  if (TABS.some((t) => t.id === raw) && canAccess(raw as Tab)) return raw as Tab;
  return FALLBACK_TAB;
}

function SettingsPageInner() {
  const { user } = useAuth();
  const { currentOrg } = useOrg();
  const { hasPermission, role } = usePermissions();
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  const canEditSettings = hasPermission("settings:edit");
  const canSeeAdminTabs = canEditSettings || hasPermission("billing:view");
  const isPersonalOrg = isPersonalWorkspace(currentOrg);

  const canAccessTab = (id: Tab) => {
    if (isTeamOnlyTab(id) && isPersonalOrg) return false;
    if (id === "audit-log") return false;
    // Gateway + API keys: always readable; mutate CTAs gated inside panels.
    if (id === "gateway" || id === "api-keys") return true;
    if ((["billing", "finops", "mcp"] as Tab[]).includes(id)) return canSeeAdminTabs;
    if (
      (["scim", "pii", "retention", "exports", "autonomous", "webhooks-dlq"] as Tab[]).includes(
        id,
      )
    ) {
      return canEditSettings;
    }
    return true;
  };

  const urlTabParam = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    resolveInitialTab(urlTabParam, canAccessTab),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    const initial = resolveInitialTab(urlTabParam, canAccessTab);
    return !DAILY_SET.has(initial);
  });
  const [ghostNotice, setGhostNotice] = useState<"roles" | "sso" | null>(null);
  const deniedTabNotified = useRef<string | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    if (!urlTabParam) return;

    if (urlTabParam === "audit-log") {
      const params = new URLSearchParams(window.location.search);
      params.delete("tab");
      if (!params.get("segment")) params.set("segment", "events");
      const qs = params.toString();
      router.replace(
        qs ? `${SETTINGS_AUDIT_LOG_REDIRECT_HREF}?${qs}` : SETTINGS_AUDIT_LOG_REDIRECT_HREF,
      );
      return;
    }

    if (GHOST_TABS.has(urlTabParam)) {
      setGhostNotice(urlTabParam as "roles" | "sso");
      setActiveTab(FALLBACK_TAB);
      const params = new URLSearchParams(window.location.search);
      if (params.get("tab") !== FALLBACK_TAB) {
        params.set("tab", FALLBACK_TAB);
        router.replace(`/settings?${params.toString()}`, { scroll: false });
      }
      return;
    }

    if (!TABS.some((t) => t.id === urlTabParam)) return;
    if (!role) return;
    if (!canAccessTab(urlTabParam as Tab)) {
      setActiveTab((prev) => (prev === FALLBACK_TAB ? prev : FALLBACK_TAB));
      if (deniedTabNotified.current !== urlTabParam) {
        deniedTabNotified.current = urlTabParam;
        if (isPersonalOrg && isTeamOnlyTab(urlTabParam)) {
          toastRef.current.warning(
            "Team workspaces only",
            "SCIM applies to team workspaces, not personal ones. Create a team workspace to use it.",
          );
        } else {
          toastRef.current.warning(
            "Admin only",
            "That settings tab requires a workspace admin.",
          );
        }
      }
      const params = new URLSearchParams(window.location.search);
      if (params.get("tab") !== FALLBACK_TAB) {
        params.set("tab", FALLBACK_TAB);
        router.replace(`/settings?${params.toString()}`, { scroll: false });
      }
      return;
    }
    deniedTabNotified.current = null;
    setGhostNotice(null);
    setActiveTab((prev) => (prev === urlTabParam ? prev : (urlTabParam as Tab)));
    if (!DAILY_SET.has(urlTabParam)) setAdvancedOpen(true);
  }, [urlTabParam, canSeeAdminTabs, canEditSettings, isPersonalOrg, role, router]);

  const handleTabChange = (tabId: string) => {
    if (!canAccessTab(tabId as Tab)) return;
    setGhostNotice(null);
    setActiveTab(tabId as Tab);
    if (!DAILY_SET.has(tabId)) setAdvancedOpen(true);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tabId);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  const normalisedQuery = searchQuery.trim().toLowerCase();
  const isSearching = Boolean(normalisedQuery);

  const accessibleTabs = useMemo(
    () => TABS.filter((t) => isRailTab(t) && canAccessTab(t.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- permission flags drive access
    [canEditSettings, canSeeAdminTabs, isPersonalOrg],
  );

  const dailyTabs = useMemo(() => {
    const byId = new Map(accessibleTabs.map((t) => [t.id, t]));
    return SETTINGS_DAILY_TAB_IDS.map((id) => byId.get(id)).filter(
      (t): t is TabDef => Boolean(t),
    );
  }, [accessibleTabs]);

  const advancedTabs = useMemo(
    () => accessibleTabs.filter((t) => !DAILY_SET.has(t.id)),
    [accessibleTabs],
  );

  const searchableTabCount = accessibleTabs.length;

  const visibleTabs = isSearching
    ? accessibleTabs.filter((t) => tabMatchesQuery(t, normalisedQuery))
    : advancedOpen
      ? [...dailyTabs, ...advancedTabs]
      : dailyTabs;

  const defaultVisibleCount = dailyTabs.length;

  if (!user) return null;

  const panelTab = urlTabParam === "audit-log" ? null : activeTab;

  return (
    <div
      className="min-h-[calc(100dvh-4rem)] pb-[env(safe-area-inset-bottom)]"
      data-ws1-settings-shell
      data-ws1-shell-completed={WS1_SETTINGS_SHELL_COMPLETED ? "true" : "false"}
      data-wave9-settings={WAVE9_SETTINGS_COMPLETED ? "completed" : undefined}
      data-default-visible-tabs={defaultVisibleCount}
      data-wave9-daily-tab-cap={WAVE9_DAILY_TAB_CAP}
      data-settings-advanced={advancedOpen ? "open" : "closed"}
    >
      <PageContent>
        <div data-ws2-settings-header>
          <PageHeader
            title="Settings"
            subtitle="Workspace, API keys, security, and compliance."
          />
        </div>

        <div className="space-y-space-4">
          <SettingsSearch
            value={searchQuery}
            onChange={setSearchQuery}
            totalLabel={
              isSearching
                ? `Showing ${visibleTabs.length} of ${searchableTabCount} settings`
                : undefined
            }
            className="max-w-md"
          />

          <nav
            className="flex flex-row gap-1 overflow-x-auto border-b border-[var(--border-default)] pb-px -mx-space-1 px-space-1"
            role="tablist"
            aria-label="Settings sections"
            data-settings-daily-tabs
          >
            {isSearching && visibleTabs.length === 0 ? (
              <p className="px-space-2 py-space-3 text-sm text-[var(--text-muted)]" role="status">
                No settings match “{searchQuery.trim()}”. Try “api”, “billing”, or “pii”.
              </p>
            ) : null}
            {(isSearching ? visibleTabs : dailyTabs).map((tab: TabDef) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                data-tab-id={tab.id}
                data-testid={tab.id}
                data-default-visible={tab.defaultVisible ? "true" : "false"}
                aria-selected={activeTab === tab.id}
                id={`settings-tab-${tab.id}`}
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  FOCUS_RING_CLASS,
                  "flex-shrink-0 min-h-11 max-w-[12rem] px-space-3 py-space-2 -mb-px border-b-2 text-sm font-medium flex items-center gap-space-2 transition-colors",
                  activeTab === tab.id
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
                title={tab.label}
                aria-label={`${tab.label} settings`}
              >
                <tab.icon className="w-4 h-4 flex-shrink-0" aria-hidden />
                <span className="truncate">{tab.label}</span>
              </button>
            ))}

            {!isSearching ? (
              <button
                type="button"
                id="settings-advanced"
                data-settings-group="advanced"
                aria-expanded={advancedOpen}
                aria-controls="settings-advanced-tabs"
                onClick={() => setAdvancedOpen((v) => !v)}
                className={cn(
                  FOCUS_RING_CLASS,
                  "flex-shrink-0 min-h-11 px-space-3 py-space-2 -mb-px border-b-2 text-sm font-medium transition-colors",
                  advancedOpen
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent border-dashed text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
              >
                Advanced{advancedOpen ? " ▴" : " ▾"}
              </button>
            ) : null}
          </nav>

          {!isSearching && advancedOpen ? (
            <nav
              id="settings-advanced-tabs"
              className="flex flex-row gap-1 overflow-x-auto -mx-space-1 px-space-1"
              role="tablist"
              aria-label="Advanced settings"
              data-settings-advanced-tabs
            >
              {advancedTabs.map((tab: TabDef) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  data-tab-id={tab.id}
                  data-testid={tab.id}
                  aria-selected={activeTab === tab.id}
                  id={`settings-tab-${tab.id}`}
                  onClick={() => handleTabChange(tab.id)}
                  className={cn(
                    FOCUS_RING_CLASS,
                    "flex-shrink-0 min-h-11 max-w-[12rem] px-space-3 py-space-2 rounded-md text-sm font-medium flex items-center gap-space-2 transition-colors",
                    activeTab === tab.id
                      ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]",
                  )}
                  title={tab.label}
                  aria-label={`${tab.label} settings`}
                >
                  <tab.icon className="w-4 h-4 flex-shrink-0" aria-hidden />
                  <span className="truncate">{tab.label}</span>
                </button>
              ))}
            </nav>
          ) : null}

          {isSearching ? (
            <nav
              className="flex flex-row flex-wrap gap-1"
              role="tablist"
              aria-label="Search results"
            >
              {visibleTabs.map((tab: TabDef) => (
                <button
                  key={`search-${tab.id}`}
                  type="button"
                  role="tab"
                  data-tab-id={tab.id}
                  aria-selected={activeTab === tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={cn(
                    FOCUS_RING_CLASS,
                    "min-h-11 px-space-3 py-space-2 rounded-md text-sm",
                    activeTab === tab.id
                      ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          ) : null}

          {ghostNotice ? (
            <div
              className="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-default)] p-4 text-sm text-[var(--text-secondary)]"
              role="status"
              data-ws1-ghost-notice={ghostNotice}
            >
              <p className="font-medium text-[var(--text-primary)] mb-1">
                {ghostNotice === "sso" ? "SSO not available yet" : "Custom roles not available yet"}
              </p>
              <p>
                {ghostNotice === "sso"
                  ? "Enterprise SSO is deferred for public beta. Use SCIM under Advanced for directory provisioning."
                  : "Custom role CRUD is not enforced on routes yet. Use built-in Owner / Admin / Member / Viewer roles."}
              </p>
            </div>
          ) : null}

          <div
            role="tabpanel"
            aria-labelledby={panelTab ? `settings-tab-${panelTab}` : undefined}
          >
            {panelTab === "overview" && <OverviewPanel org={currentOrg} />}
            {panelTab === "org" && <OrgTab org={currentOrg} />}
            {panelTab === "account" && <AccountPanel />}
            {panelTab === "members" && <MembersTab org={currentOrg} />}
            {panelTab === "references" && <ReferencesTab org={currentOrg} />}
            {panelTab === "api-keys" && <ApiKeysTab org={currentOrg} />}
            {panelTab === "mcp" && canSeeAdminTabs && <McpTab org={currentOrg} />}
            {panelTab === "security" && <SecurityTab />}
            {panelTab === "scim" && canEditSettings && <ScimTab org={currentOrg} />}
            {panelTab === "gateway" && <GatewayTab org={currentOrg} />}
            {panelTab === "pii" && canEditSettings && <PiiPolicyTab />}
            {panelTab === "retention" && canEditSettings && <RetentionPolicyTab />}
            {panelTab === "analytics" && <AnalyticsTab />}
            {panelTab === "billing" && canSeeAdminTabs && <BillingTab />}
            {panelTab === "finops" && canSeeAdminTabs && <FinOpsKillsTab />}
            {panelTab === "autonomous" && canEditSettings && <AutonomousTab />}
            {panelTab === "exports" && canEditSettings && (
              <ExportsTab orgId={currentOrg?.id || ""} canManage={canEditSettings} />
            )}
            {panelTab === "webhooks-dlq" && canEditSettings && <WebhooksDlqTab />}
            {panelTab === "sidebar" && <SidebarSettingsTab />}
            {panelTab === "status" && <StatusTab />}
          </div>
        </div>
      </PageContent>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsLoading />}>
      <SettingsPageInner />
    </Suspense>
  );
}

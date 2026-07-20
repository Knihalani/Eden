"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { Building2, Users, User, Code, Key, FileText, Shield, ShieldCheck, CreditCard, KeyRound, Lock, BarChart2, Server, EyeOff, Database, FileArchive, Settings2, Bot, Terminal, Activity, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

// Heavy tabs — code-split via next/dynamic so the initial settings bundle
// doesn't ship recharts / @xyflow / 2FA crypto / SCIM flows. Each lazy
// import keeps a LoadingSkeleton fallback so the tab-rail layout
// doesn't jump when the user clicks the tab. (June 2026 perf pass.)
const tabLoading = () => <Skeleton className="h-64 w-full" />;
const AnalyticsTab = dynamic(() => import("./_components/analytics-tab").then(m => ({
  default: m.AnalyticsTab
})), {
  ssr: false,
  loading: tabLoading
});
const AutonomousTab = dynamic(() => import("./_components/autonomous-tab").then(m => ({
  default: m.default
})), {
  ssr: false,
  loading: tabLoading
});
const AuditLogTab = dynamic(() => import("./_components/audit-log-tab").then(m => ({
  default: m.AuditLogTab
})), {
  ssr: false,
  loading: tabLoading
});
const BillingTab = dynamic(() => import("./_components/billing-tab").then(m => ({
  default: m.BillingTab
})), {
  ssr: false,
  loading: tabLoading
});
const ExportsTab = dynamic(() => import("./_components/exports-tab").then(m => ({
  default: m.ExportsTab
})), {
  ssr: false,
  loading: tabLoading
});
const GatewayTab = dynamic(() => import("./_components/gateway-tab").then(m => ({
  default: m.GatewayTab
})), {
  ssr: false,
  loading: tabLoading
});
const PiiPolicyTab = dynamic(() => import("./_components/pii-policy-tab").then(m => ({
  default: m.PiiPolicyTab
})), {
  ssr: false,
  loading: tabLoading
});
const RetentionPolicyTab = dynamic(() => import("./_components/retention-policy-tab").then(m => ({
  default: m.RetentionPolicyTab
})), {
  ssr: false,
  loading: tabLoading
});
const ScimTab = dynamic(() => import("./_components/scim-tab").then(m => ({
  default: m.ScimTab
})), {
  ssr: false,
  loading: tabLoading
});
const SecurityTab = dynamic(() => import("./_components/security-tab").then(m => ({
  default: m.SecurityTab
})), {
  ssr: false,
  loading: tabLoading
});
const SidebarSettingsTab = dynamic(() => import("./_components/sidebar-settings-tab").then(m => ({
  default: m.SidebarSettingsTab
})), {
  ssr: false,
  loading: tabLoading
});
const McpTab = dynamic(() => import("./_components/mcp-tab").then(m => ({
  default: m.McpTab
})), {
  ssr: false,
  loading: tabLoading
});
const StatusTab = dynamic(() => import("./_components/status-tab").then(m => ({
  default: m.StatusTab
})), {
  ssr: false,
  loading: tabLoading
});
const FinOpsKillsTab = dynamic(() => import("./_components/finops-kills-tab").then(m => ({
  default: m.FinOpsKillsTab
})), {
  ssr: false,
  loading: tabLoading
});
const AccountTab = dynamic(() => import("@/app/(portal)/profile/page"), {
  ssr: false,
  loading: tabLoading
});
// W17 load pass — also split formerly-eager tabs so Settings shell
// doesn't pull members/API-keys/roles into the first paint graph.
const OrgTab = dynamic(() => import("./_components/org-tab").then(m => ({
  default: m.OrgTab
})), {
  ssr: false,
  loading: tabLoading
});
const MembersTab = dynamic(() => import("./_components/members-tab").then(m => ({
  default: m.MembersTab
})), {
  ssr: false,
  loading: tabLoading
});
const ReferencesTab = dynamic(() => import("./_components/references-tab").then(m => ({
  default: m.ReferencesTab
})), {
  ssr: false,
  loading: tabLoading
});
const ApiKeysTab = dynamic(() => import("./_components/api-keys-tab").then(m => ({
  default: m.ApiKeysTab
})), {
  ssr: false,
  loading: tabLoading
});
const RolesTab = dynamic(() => import("./_components/roles-tab"), {
  ssr: false,
  loading: tabLoading
});
import SettingsLoading from "./loading";
import { useSearchParams, useRouter } from "next/navigation";
import { SettingsSearch } from "@/components/settings/settings-search";
import { SettingsCategoryGroup } from "@/components/settings/settings-category-group";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
type Tab = "org" | "members" | "references" | "api-keys" | "mcp" | "security" | "scim" | "sso" | "audit-log" | "analytics" | "billing" | "gateway" | "pii" | "retention" | "exports" | "sidebar" | "autonomous" | "roles" | "account" | "status" | "finops";
type SettingsCategory = "Org" | "Members" | "Security" | "Compliance" | "Billing" | "Advanced";
const TABS: ReadonlyArray<{
  id: Tab;
  label: string;
  icon: typeof Building2;
  category: SettingsCategory;
  hidden?: boolean;
  keywords?: string[];
}> = [{
  id: "org",
  label: "Organization",
  icon: Building2,
  category: "Org",
  keywords: ["workspace", "team", "slug", "archive", "delete", "transfer"],
}, {
  id: "account",
  label: "Account",
  icon: User,
  category: "Org",
  keywords: ["profile", "user", "me"],
}, {
  id: "api-keys",
  label: "API Keys",
  icon: Key,
  category: "Org",
  keywords: ["token", "credentials", "sdk", "secret", "revoke"],
}, {
  id: "members",
  label: "Members",
  icon: Users,
  category: "Members",
  keywords: ["invite", "people", "team", "remove"],
}, {
  id: "roles",
  label: "Custom Roles",
  icon: ShieldCheck,
  category: "Members",
  // Soft-launch: custom roles CRUD exists but is not enforced on routes.
  hidden: true,
  keywords: ["permissions", "rbac"],
}, {
  id: "references",
  label: "Code References",
  icon: Code,
  category: "Members",
  keywords: ["github", "repo", "source"],
}, {
  id: "mcp",
  label: "MCP",
  icon: Terminal,
  category: "Security",
  keywords: ["model context", "tools", "server"],
}, {
  id: "security",
  label: "Security",
  icon: Shield,
  category: "Security",
  keywords: ["2fa", "mfa", "totp", "password", "enforcement"],
}, {
  id: "scim",
  label: "SCIM",
  icon: KeyRound,
  category: "Security",
  keywords: ["provisioning", "directory", "okta", "entra", "users"],
}, {
  // Soft-launch: SSO deferred (requires Clerk Enterprise or Eden-native
  // SAML SP). Tab kept out of the rail; deep-link ?tab=sso shows a notice.
  id: "sso",
  label: "SSO",
  icon: Lock,
  category: "Security",
  hidden: true,
  keywords: ["saml", "oidc", "login", "identity"],
}, {
  id: "gateway",
  label: "AI Gateway",
  icon: Server,
  category: "Compliance",
  keywords: ["models", "llm", "proxy", "routing"],
}, {
  id: "pii",
  label: "PII Policy",
  icon: EyeOff,
  category: "Compliance",
  keywords: ["privacy", "redact", "scrub", "gdpr", "phi"],
}, {
  id: "retention",
  label: "Retention",
  icon: Database,
  category: "Compliance",
  keywords: ["delete", "lifecycle", "storage", "ttl"],
}, {
  id: "exports",
  label: "Exports",
  icon: FileArchive,
  category: "Compliance",
  keywords: ["download", "gdpr", "data", "zip"],
}, {
  id: "audit-log",
  label: "Audit Log",
  icon: FileText,
  category: "Compliance",
  keywords: ["audit", "trail", "compliance", "events"],
}, {
  id: "status",
  label: "Platform status",
  icon: Activity,
  category: "Advanced",
  keywords: ["health", "uptime", "incidents"],
}, {
  id: "analytics",
  label: "Analytics",
  icon: BarChart2,
  category: "Advanced",
  keywords: ["metrics", "usage", "charts"],
}, {
  id: "billing",
  label: "Billing",
  icon: CreditCard,
  category: "Billing",
  keywords: ["plan", "stripe", "invoice", "subscription", "payment"],
}, {
  id: "finops",
  label: "FinOps kills",
  icon: Wallet,
  category: "Billing",
  keywords: ["finops", "kill", "kills", "cost", "feature kill", "switch"],
}, {
  id: "autonomous",
  label: "Autonomous",
  icon: Bot,
  category: "Advanced",
  keywords: ["heal", "intelligence", "agent", "cron", "destructive"],
}, {
  id: "sidebar",
  label: "Sidebar",
  icon: Settings2,
  category: "Advanced",
  keywords: ["navigation", "nav", "pin", "layout"],
}];

// Order categories for the rail. The order is fixed — Org first
// (most used), Billing last (least used).
const CATEGORY_ORDER: SettingsCategory[] = ["Org", "Members", "Security", "Compliance", "Billing", "Advanced"];
function SettingsPageInner() {
  const {
    user
  } = useAuth();
  const {
    currentOrg,
  } = useOrg();
  const { hasPermission, role } = usePermissions();
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Billing / FinOps / MCP: admin+ (settings:edit or billing:view).
  // SCIM / gateway / PII / retention / exports / API keys / roles /
  // autonomous: settings:edit only — members/viewers must not see them
  // in the rail (deep-links fall back to org with an Admin-only toast).
  // Audit Log: audit:view (owner/admin) — hide from rail for members/viewers.
  const canEditSettings = hasPermission("settings:edit");
  const canSeeAdminTabs =
    canEditSettings || hasPermission("billing:view");
  const canViewAudit = hasPermission("audit:view");
  const isPersonalOrg = Boolean(currentOrg?.is_personal);
  const isBillingAdminTab = (id: Tab) =>
    id === "billing" || id === "finops" || id === "mcp";
  const isSettingsEditTab = (id: Tab) =>
    id === "scim" ||
    id === "gateway" ||
    id === "pii" ||
    id === "retention" ||
    id === "exports" ||
    id === "api-keys" ||
    id === "roles" ||
    id === "autonomous";
  const canAccessTab = (id: Tab) => {
    // Soft-hide team-provisioning admin surfaces for personal (solo) workspaces.
    if (isPersonalOrg && (id === "scim" || id === "sso")) return false;
    if (id === "audit-log") return canViewAudit;
    if (isBillingAdminTab(id)) return canSeeAdminTabs;
    if (isSettingsEditTab(id)) return canEditSettings;
    return true;
  };
  const initialTab = searchParams.get("tab") as Tab || "org";
  const [activeTab, setActiveTab] = useState<Tab>(
    TABS.some(t => t.id === initialTab) && canAccessTab(initialTab)
      ? initialTab
      : "org",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const deniedTabNotified = useRef<string | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // URL → state only. Functional setState avoids update loops when
  // searchParams identity churns but the tab string is unchanged.
  const urlTabParam = searchParams.get("tab");
  useEffect(() => {
    if (!urlTabParam || !TABS.some((t) => t.id === urlTabParam)) return;
    // Wait for role so we do not toast "Admin only" while permissions
    // are still resolving for an actual admin.
    if (!role) return;
    if (!canAccessTab(urlTabParam as Tab)) {
      setActiveTab((prev) => (prev === "org" ? prev : "org"));
      if (deniedTabNotified.current !== urlTabParam) {
        deniedTabNotified.current = urlTabParam;
        // Personal orgs soft-hide SCIM/SSO — do not mislabel as "Admin only".
        if (
          isPersonalOrg &&
          (urlTabParam === "scim" || urlTabParam === "sso")
        ) {
          toastRef.current.warning(
            "Team organizations only",
            "SCIM and SSO apply to team workspaces, not personal ones. Create a team organization to use them.",
          );
        } else {
          toastRef.current.warning(
            "Admin only",
            "That settings tab requires an organization admin.",
          );
        }
      }
      const params = new URLSearchParams(window.location.search);
      if (params.get("tab") !== "org") {
        params.set("tab", "org");
        router.replace(`/settings?${params.toString()}`, { scroll: false });
      }
      return;
    }
    deniedTabNotified.current = null;
    setActiveTab((prev) => (prev === urlTabParam ? prev : (urlTabParam as Tab)));
  }, [urlTabParam, canSeeAdminTabs, canEditSettings, canViewAudit, isPersonalOrg, role, router]);
  const handleTabChange = (tabId: string) => {
    if (!canAccessTab(tabId as Tab)) return;
    setActiveTab(tabId as Tab);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tabId);
    router.replace(`/settings?${params.toString()}`, {
      scroll: false
    });
  };

  // Filter tabs by search query. Substring match on label (case
  // insensitive). When a query is set, hide empty category groups
  // so the rail doesn't render blanks. Permission-gated tabs stay
  // hidden from members/viewers.
  const normalisedQuery = searchQuery.trim().toLowerCase();
  const visibleTabs = (normalisedQuery
    ? TABS.filter((t) => {
        if (t.hidden || !canAccessTab(t.id)) return false;
        const hay = `${t.label} ${(t.keywords ?? []).join(" ")}`.toLowerCase();
        return hay.includes(normalisedQuery);
      })
    : TABS.filter((t) => !t.hidden && canAccessTab(t.id)));
  const tabsByCategory: Record<SettingsCategory, typeof TABS[number][]> = {
    Org: [],
    Members: [],
    Security: [],
    Compliance: [],
    Billing: [],
    Advanced: []
  };
  for (const tab of visibleTabs) tabsByCategory[tab.category].push(tab);
  const visibleCategories = CATEGORY_ORDER.filter(cat => tabsByCategory[cat].length > 0);

  // Cmd/Ctrl+1..6 jumps to the first tab in each visible category.
  // Only fires when no input is focused (otherwise typing "1" in
  // a search box would jump tabs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < visibleCategories.length) {
        const cat = visibleCategories[idx];
        const first = tabsByCategory[cat]?.[0];
        if (first) {
          e.preventDefault();
          handleTabChange(first.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleCategories.length]);
  if (!user) return null;

  // FIX-A: document scrolls natively; settings no longer needs a
  // fixed viewport height. Use `min-h-[calc(100dvh-4rem)]` so the
  // tab rail and content fill the visible area on first paint but
  // grow with content instead of clipping. The dvh unit + iOS
  // safe-area inset keep mobile (375x667) looking right without
  // the "double scroll" the previous h-[calc(100vh-4rem)] caused.
  const searchableTabCount = TABS.filter((t) => !t.hidden && canAccessTab(t.id)).length;
  const isSearching = Boolean(normalisedQuery);

  return <div className="flex flex-col lg:flex-row min-h-[calc(100dvh-4rem)] pb-[env(safe-area-inset-bottom)]">
      {/* Tab rail: search-first (Stripe/Linear), horizontal on mobile */}
      <div className="w-full lg:w-[240px] flex-shrink-0 bg-[var(--bg-primary)] border-b lg:border-b-0 lg:border-r border-[var(--border-default)]">
        <div className="p-space-3 lg:p-space-4 space-y-space-3">
          <SettingsSearch
            value={searchQuery}
            onChange={setSearchQuery}
            totalLabel={
              isSearching
                ? `Showing ${visibleTabs.length} of ${searchableTabCount} settings`
                : undefined
            }
          />
          <nav
            className="flex flex-row lg:flex-col gap-space-3 overflow-x-auto lg:overflow-visible pb-space-1 lg:pb-0 -mx-space-1 px-space-1 lg:mx-0 lg:px-0"
            role="tablist"
            aria-label="Settings sections"
          >
            {isSearching && visibleTabs.length === 0 ? (
              <p className="px-space-2 py-space-3 text-sm text-[var(--text-muted)]" role="status">
                No settings match “{searchQuery.trim()}”.
              </p>
            ) : null}
            {visibleCategories.map((category) => (
              <SettingsCategoryGroup
                key={category}
                category={category}
                count={tabsByCategory[category].length}
                forceExpanded={isSearching}
              >
                {tabsByCategory[category].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    data-tab-id={tab.id}
                    data-tour-id={tab.id}
                    aria-selected={activeTab === tab.id}
                    id={`settings-tab-${tab.id}`}
                    onClick={() => handleTabChange(tab.id)}
                    className={cn(
                      "flex-shrink-0 lg:w-full min-h-11 min-w-0 max-w-[12rem] lg:max-w-none px-space-3 py-space-2 rounded-lg text-sm font-medium flex items-center gap-space-2 lg:gap-space-3 transition-colors",
                      activeTab === tab.id
                        ? "bg-[var(--accent-faint)] text-[var(--accent)] lg:border-l-2 lg:border-[var(--accent)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]",
                    )}
                    title={tab.label}
                  >
                    <tab.icon className="w-4 h-4 flex-shrink-0" aria-hidden />
                    <span className="truncate">{tab.label}</span>
                  </button>
                ))}
              </SettingsCategoryGroup>
            ))}
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-w-0">
        <PageContent>
          <PageHeader
            title="Settings"
            subtitle="Organization, API keys, security, and compliance."
          />

          {/* Tab Content */}
          <div role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
            {activeTab === "org" && <OrgTab org={currentOrg} />}
            {activeTab === "account" && (
              <EmbeddedSurface>
                <AccountTab />
              </EmbeddedSurface>
            )}
            {activeTab === "members" && <MembersTab org={currentOrg} />}
            {activeTab === "roles" && canEditSettings && <RolesTab />}
            {activeTab === "references" && <ReferencesTab org={currentOrg} />}
            {activeTab === "api-keys" && canEditSettings && <ApiKeysTab org={currentOrg} />}
            {activeTab === "mcp" && canSeeAdminTabs && <McpTab org={currentOrg} />}
            {activeTab === "security" && <SecurityTab />}
            {activeTab === "scim" && canEditSettings && <ScimTab org={currentOrg} />}
            {activeTab === "sso" && (
              <div className="rounded-lg bg-[var(--bg-secondary)] p-6 text-sm text-[var(--text-secondary)]">
                <p className="font-medium text-[var(--text-primary)] mb-2">SSO deferred for soft launch</p>
                <p>
                  Enterprise SSO requires Clerk Enterprise Connections or a completed
                  Eden-native SAML/OIDC callback. Use SCIM for automated membership
                  provisioning in the meantime.
                </p>
              </div>
            )}
            {activeTab === "gateway" && canEditSettings && <GatewayTab org={currentOrg} />}
            {activeTab === "pii" && canEditSettings && <PiiPolicyTab />}
            {activeTab === "retention" && canEditSettings && <RetentionPolicyTab />}
            {activeTab === "audit-log" && <AuditLogTab org={currentOrg} />}
            {activeTab === "analytics" && <AnalyticsTab />}
            {activeTab === "billing" && canSeeAdminTabs && <BillingTab />}
            {activeTab === "finops" && canSeeAdminTabs && <FinOpsKillsTab />}
            {activeTab === "autonomous" && canEditSettings && <AutonomousTab />}
            {activeTab === "exports" && canEditSettings && (
              <ExportsTab
                orgId={currentOrg?.id || ""}
                canManage={canEditSettings}
              />
            )}
            {activeTab === "sidebar" && <SidebarSettingsTab />}
            {activeTab === "status" && <StatusTab />}
          </div>
        </PageContent>
      </div>
    </div>;
}


// Wrap SettingsPageInner in a Suspense boundary because it reads
// ``useSearchParams()``. Without the boundary Next.js cannot
// statically optimise the page and the RSC prefetch
// (``?._rsc=...``) returns a partial / erroring payload, which
// surfaces in the browser console as a 404.
export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsLoading />}>
      <SettingsPageInner />
    </Suspense>
  );
}

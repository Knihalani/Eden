"use client";

import { useState, useEffect , Suspense} from "react";
import dynamic from "next/dynamic";
import { useOrganizationList } from "@clerk/nextjs";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { Building2, Users, User, Code, Key, FileText, Shield, ShieldCheck, CreditCard, KeyRound, Lock, BarChart2, Server, EyeOff, Database, FileArchive, Settings2, Bot, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

// Heavy tabs — code-split via next/dynamic so the initial settings bundle
// doesn't ship recharts / @xyflow / 2FA crypto / SCIM flows. Each lazy
// import keeps a LoadingSkeleton fallback so the tab-rail layout
// doesn't jump when the user clicks the tab. (June 2026 perf pass.)
const AnalyticsTab = dynamic(() => import("./_components/analytics-tab").then(m => ({
  default: m.AnalyticsTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const AutonomousTab = dynamic(() => import("./_components/autonomous-tab").then(m => ({
  default: m.default
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const AuditLogTab = dynamic(() => import("./_components/audit-log-tab").then(m => ({
  default: m.AuditLogTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const BillingTab = dynamic(() => import("./_components/billing-tab").then(m => ({
  default: m.BillingTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const ExportsTab = dynamic(() => import("./_components/exports-tab").then(m => ({
  default: m.ExportsTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const GatewayTab = dynamic(() => import("./_components/gateway-tab").then(m => ({
  default: m.GatewayTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const PiiPolicyTab = dynamic(() => import("./_components/pii-policy-tab").then(m => ({
  default: m.PiiPolicyTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const RetentionPolicyTab = dynamic(() => import("./_components/retention-policy-tab").then(m => ({
  default: m.RetentionPolicyTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const ScimTab = dynamic(() => import("./_components/scim-tab").then(m => ({
  default: m.ScimTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const SecurityTab = dynamic(() => import("./_components/security-tab").then(m => ({
  default: m.SecurityTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const SidebarSettingsTab = dynamic(() => import("./_components/sidebar-settings-tab").then(m => ({
  default: m.SidebarSettingsTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const McpTab = dynamic(() => import("./_components/mcp-tab").then(m => ({
  default: m.McpTab
})), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
const AccountTab = dynamic(() => import("@/app/(portal)/profile/page"), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />
});
import { OrgTab } from "./_components/org-tab";
import { MembersTab } from "./_components/members-tab";
import { ReferencesTab } from "./_components/references-tab";
import { ApiKeysTab } from "./_components/api-keys-tab";
import RolesTab from "./_components/roles-tab";
import { Skeleton } from "@/components/ui/skeleton";
import { useSearchParams, useRouter } from "next/navigation";
import { SettingsSearch } from "@/components/settings/settings-search";
import { SettingsCategoryGroup } from "@/components/settings/settings-category-group";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
type Tab = "org" | "members" | "references" | "api-keys" | "mcp" | "security" | "scim" | "sso" | "audit-log" | "analytics" | "billing" | "gateway" | "pii" | "retention" | "exports" | "sidebar" | "autonomous" | "roles" | "account";
type SettingsCategory = "Org" | "Members" | "Security" | "Compliance" | "Billing" | "Advanced";
const TABS: ReadonlyArray<{
  id: Tab;
  label: string;
  icon: typeof Building2;
  category: SettingsCategory;
  hidden?: boolean;
}> = [{
  id: "org",
  label: "Organization",
  icon: Building2,
  category: "Org"
}, {
  id: "account",
  label: "Account",
  icon: User,
  category: "Org"
}, {
  id: "api-keys",
  label: "API Keys",
  icon: Key,
  category: "Org"
}, {
  id: "members",
  label: "Members",
  icon: Users,
  category: "Members"
}, {
  id: "roles",
  label: "Custom Roles",
  icon: ShieldCheck,
  category: "Members",
  // Soft-launch: custom roles CRUD exists but is not enforced on routes.
  hidden: true,
}, {
  id: "references",
  label: "Code References",
  icon: Code,
  category: "Members"
}, {
  id: "mcp",
  label: "MCP",
  icon: Terminal,
  category: "Security"
}, {
  id: "security",
  label: "Security",
  icon: Shield,
  category: "Security"
}, {
  id: "scim",
  label: "SCIM",
  icon: KeyRound,
  category: "Security"
}, {
  // Soft-launch: SSO deferred (requires Clerk Enterprise or Eden-native
  // SAML SP). Tab kept out of the rail; deep-link ?tab=sso shows a notice.
  id: "sso",
  label: "SSO",
  icon: Lock,
  category: "Security",
  hidden: true,
}, {
  id: "gateway",
  label: "AI Gateway",
  icon: Server,
  category: "Compliance"
}, {
  id: "pii",
  label: "PII Policy",
  icon: EyeOff,
  category: "Compliance"
}, {
  id: "retention",
  label: "Retention",
  icon: Database,
  category: "Compliance"
}, {
  id: "exports",
  label: "Exports",
  icon: FileArchive,
  category: "Compliance"
}, {
  id: "audit-log",
  label: "Audit Log",
  icon: FileText,
  category: "Compliance"
}, {
  id: "analytics",
  label: "Analytics",
  icon: BarChart2,
  category: "Advanced"
}, {
  id: "billing",
  label: "Billing",
  icon: CreditCard,
  category: "Billing"
}, {
  id: "autonomous",
  label: "Autonomous",
  icon: Bot,
  category: "Advanced"
}, {
  id: "sidebar",
  label: "Sidebar",
  icon: Settings2,
  category: "Advanced"
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
    organizations,
    setCurrentOrg
  } = useOrg();
  const {
    setActive: setActiveOrg
  } = useOrganizationList();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") as Tab || "org";
  const [activeTab, setActiveTab] = useState<Tab>(TABS.some(t => t.id === initialTab) ? initialTab : "org");
  const [searchQuery, setSearchQuery] = useState("");

  // Keep the URL in sync with the active tab so deep links work and
  // refreshes don't drop the user back to the first tab. We split the
  // effect: this one handles URL → state, the one below handles
  // state → URL (handleTabChange) — both are explicit about deps.
  useEffect(() => {
    const urlTab = searchParams.get("tab");
    if (urlTab && urlTab !== activeTab && TABS.some(t => t.id === urlTab)) {
      setActiveTab(urlTab as Tab);
    }
  }, [searchParams, activeTab]);
  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId as Tab);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tabId);
    router.replace(`/settings?${params.toString()}`, {
      scroll: false
    });
  };

  // Filter tabs by search query. Substring match on label (case
  // insensitive). When a query is set, hide empty category groups
  // so the rail doesn't render blanks.
  const normalisedQuery = searchQuery.trim().toLowerCase();
  const visibleTabs = (normalisedQuery
    ? TABS.filter((t) => !t.hidden && t.label.toLowerCase().includes(normalisedQuery))
    : TABS.filter((t) => !t.hidden));
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
  return <div className="flex flex-col lg:flex-row min-h-[calc(100dvh-4rem)] pb-[env(safe-area-inset-bottom)]">
      {/* Tab rail: horizontal scroll on mobile, vertical on lg */}
      <div className="w-full lg:w-[240px] flex-shrink-0 bg-[var(--bg-primary)] border-b lg:border-b-0 lg:border-r border-[var(--border-default)]">
        <div className="p-3 lg:p-4 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] px-2">Settings</h2>
          <SettingsSearch value={searchQuery} onChange={setSearchQuery} totalLabel={normalisedQuery ? `Showing ${visibleTabs.length} of ${TABS.length} settings` : undefined} />
          <nav className="flex flex-row lg:flex-col gap-3 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0 -mx-1 px-1 lg:mx-0 lg:px-0" role="tablist" aria-label="Settings sections">
            {visibleCategories.map(category => <SettingsCategoryGroup key={category} category={category} count={tabsByCategory[category].length}>
                {tabsByCategory[category].map(tab => <button key={tab.id} type="button" role="tab" data-tab-id={tab.id} data-tour-id={tab.id} aria-selected={activeTab === tab.id} id={`settings-tab-${tab.id}`} onClick={() => handleTabChange(tab.id)} className={cn("flex-shrink-0 lg:w-full px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 lg:gap-3 transition-colors whitespace-nowrap", activeTab === tab.id ? "bg-[var(--accent-faint)] text-[var(--accent)] lg:border-l-2 lg:border-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]")}>
                    <tab.icon className="w-4 h-4 flex-shrink-0" aria-hidden />
                    <span>{tab.label}</span>
                  </button>)}
              </SettingsCategoryGroup>)}
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-w-0">
        <PageContent>
          <PageHeader title="Settings" icon={Settings2} />

          {/* Org Switcher */}
          {organizations.length > 0 && <Card padding="md" className="mb-6">
              <div className="flex items-center gap-3 mb-3">
                <Building2 className="w-5 h-5 text-[var(--text-muted)]" />
                <span className="text-sm font-medium text-[var(--text-primary)]">Current Organization</span>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <label htmlFor="settings-org-select" className="sr-only">
                  Current organization
                </label>
                <Select
                  value={currentOrg?.id || ""}
                  onValueChange={(value) => {
                    const org = organizations.find((o) => o.id === value);
                    if (org) {
                      setCurrentOrg(org);
                      const clerkOrgId = (org as { clerk_org_id?: string }).clerk_org_id;
                      if (clerkOrgId && setActiveOrg) {
                        void setActiveOrg({ organization: clerkOrgId });
                      }
                    }
                  }}
                >
                  <SelectTrigger id="settings-org-select" className="flex-1 min-w-0">
                    <SelectValue placeholder="Select organization" />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.name} ({org.role})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </Card>}

          {/* Tab Content */}
          <div role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
            {activeTab === "org" && <OrgTab org={currentOrg} />}
            {activeTab === "account" && (
              <EmbeddedSurface>
                <AccountTab />
              </EmbeddedSurface>
            )}
            {activeTab === "members" && <MembersTab org={currentOrg} />}
            {activeTab === "roles" && <RolesTab />}
            {activeTab === "references" && <ReferencesTab org={currentOrg} />}
            {activeTab === "api-keys" && <ApiKeysTab org={currentOrg} />}
            {activeTab === "mcp" && <McpTab org={currentOrg} />}
            {activeTab === "security" && <SecurityTab />}
            {activeTab === "scim" && <ScimTab org={currentOrg} />}
            {activeTab === "sso" && (
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-6 text-sm text-[var(--text-secondary)]">
                <p className="font-medium text-[var(--text-primary)] mb-2">SSO deferred for soft launch</p>
                <p>
                  Enterprise SSO requires Clerk Enterprise Connections or a completed
                  Eden-native SAML/OIDC callback. Use SCIM for automated membership
                  provisioning in the meantime.
                </p>
              </div>
            )}
            {activeTab === "gateway" && <GatewayTab org={currentOrg} />}
            {activeTab === "pii" && <PiiPolicyTab />}
            {activeTab === "retention" && <RetentionPolicyTab />}
            {activeTab === "audit-log" && <AuditLogTab org={currentOrg} />}
            {activeTab === "analytics" && <AnalyticsTab />}
            {activeTab === "billing" && <BillingTab />}
            {activeTab === "autonomous" && <AutonomousTab />}
            {activeTab === "exports" && <ExportsTab orgId={currentOrg?.id || ""} canManage={currentOrg?.role === "owner" || currentOrg?.role === "admin"} />}
            {activeTab === "sidebar" && <SidebarSettingsTab />}
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
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

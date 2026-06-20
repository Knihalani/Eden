"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useOrganizationList } from "@clerk/nextjs";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { Loader2, Plus, Trash2, Building2, Users, Code, Copy, Check, Archive, RefreshCw, Key, FileText, Shield, CreditCard, KeyRound, Lock, BarChart2, Server, EyeOff, Database, Globe, FileArchive, Settings2, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { DeleteOrgDialog } from "./_components/delete-org-dialog";
import { TransferOwnershipDialog } from "./_components/transfer-ownership-dialog";
import { InvitePanel } from "./_components/invite-panel";

// Heavy tabs — code-split via next/dynamic so the initial settings bundle
// doesn't ship recharts / @xyflow / 2FA crypto / SCIM flows. Each lazy
// import keeps a LoadingSkeleton fallback so the tab-rail layout
// doesn't jump when the user clicks the tab. (June 2026 perf pass.)
const AnalyticsTab = dynamic(
  () => import("./_components/analytics-tab").then((m) => ({ default: m.AnalyticsTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const AutonomousTab = dynamic(
  () => import("./_components/autonomous-tab").then((m) => ({ default: m.default })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const AuditLogTab = dynamic(
  () => import("./_components/audit-log-tab").then((m) => ({ default: m.AuditLogTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const BillingTab = dynamic(
  () => import("./_components/billing-tab").then((m) => ({ default: m.BillingTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const ExportsTab = dynamic(
  () => import("./_components/exports-tab").then((m) => ({ default: m.ExportsTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const GatewayTab = dynamic(
  () => import("./_components/gateway-tab").then((m) => ({ default: m.GatewayTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const PiiPolicyTab = dynamic(
  () => import("./_components/pii-policy-tab").then((m) => ({ default: m.PiiPolicyTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const RegionTab = dynamic(
  () => import("./_components/region-tab").then((m) => ({ default: m.RegionTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const RetentionPolicyTab = dynamic(
  () => import("./_components/retention-policy-tab").then((m) => ({ default: m.RetentionPolicyTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const ScimTab = dynamic(
  () => import("./_components/scim-tab").then((m) => ({ default: m.ScimTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const SecurityTab = dynamic(
  () => import("./_components/security-tab").then((m) => ({ default: m.SecurityTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const SSOTab = dynamic(
  () => import("./_components/sso-tab").then((m) => ({ default: m.SSOTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);
const SidebarSettingsTab = dynamic(
  () => import("./_components/sidebar-settings-tab").then((m) => ({ default: m.SidebarSettingsTab })),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> }
);

import { DataExportPanel } from "./_components/data-export-panel";

// Phase 5 (June 2026) — extracted from the inlined functions below
// so each tab can be developed / tested / lazy-loaded independently.
import { OrgTab } from "./_components/org-tab";
import { MembersTab } from "./_components/members-tab";
import { ReferencesTab } from "./_components/references-tab";
import { ApiKeysTab } from "./_components/api-keys-tab";

import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { Skeleton } from "@/components/ui/skeleton";
import { useSearchParams } from "next/navigation";

type Tab = "org" | "members" | "references" | "api-keys" | "security" | "scim" | "sso" | "audit-log" | "analytics" | "billing" | "gateway" | "pii" | "retention" | "region" | "exports" | "sidebar" | "autonomous";

const TABS = [
  { id: "org", label: "Organization", icon: Building2 },
  { id: "members", label: "Members", icon: Users },
  { id: "references", label: "Code References", icon: Code },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "security", label: "Security", icon: Shield },
  { id: "scim", label: "SCIM", icon: KeyRound },
  { id: "sso", label: "SSO", icon: Lock },
  { id: "gateway", label: "AI Gateway", icon: Server },
  { id: "pii", label: "PII Policy", icon: EyeOff },
  { id: "retention", label: "Retention", icon: Database },
  { id: "region", label: "Region", icon: Globe },
  { id: "exports", label: "Exports", icon: FileArchive },
  { id: "audit-log", label: "Audit Log", icon: FileText },
  { id: "analytics", label: "Analytics", icon: BarChart2 },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "autonomous", label: "Autonomous", icon: Bot },
  { id: "sidebar", label: "Sidebar", icon: Settings2 },
] as const;

export default function SettingsPage() {
  const { user } = useAuth();
  const { currentOrg, organizations, setCurrentOrg, refreshOrgs } = useOrg();
  const { setActive: setActiveOrg } = useOrganizationList();
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get("tab") as Tab) || "org";
  const [activeTab, setActiveTab] = useState<Tab>(
    TABS.some((t) => t.id === initialTab) ? initialTab : "org"
  );
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});
  const navRef = useRef<HTMLDivElement>(null);

  // Update sliding indicator position
  useEffect(() => {
    const updateIndicator = () => {
      const nav = navRef.current;
      if (!nav) return;
      const activeButton = nav.querySelector(`[data-tab-id="${activeTab}"]`) as HTMLButtonElement;
      if (!activeButton) return;
      const navRect = nav.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      const top = buttonRect.top - navRect.top + 4; // 4px padding adjustment
      const height = buttonRect.height - 8; // 8px total padding adjustment
      setIndicatorStyle({
        transform: `translateY(${top}px)`,
        height: `${height}px`,
        width: 'calc(100% - var(--space-4))',
        left: 'var(--space-2)',
      });
    };

    updateIndicator();
    // Use ResizeObserver to handle responsive layout changes
    const resizeObserver = new ResizeObserver(updateIndicator);
    if (navRef.current) {
      resizeObserver.observe(navRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [activeTab]);

  if (!user) return null;

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-4rem)]">
      {/* Tab rail: horizontal scroll on mobile, vertical on lg */}
      <div className="w-full lg:w-[200px] flex-shrink-0 bg-[var(--bg-primary)] border-b lg:border-b-0 lg:border-r border-[var(--border-default)]">
        <div className="p-3 lg:p-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2 lg:mb-4 px-2">Settings</h2>
          <nav ref={navRef} className="flex flex-row lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0 -mx-1 px-1 lg:mx-0 lg:px-0 relative" role="tablist" aria-label="Settings sections">
            {/* Sliding frosted glass indicator */}
            <div
              className="absolute hidden lg:block rounded-lg border border-[var(--indicator-border)] bg-[var(--indicator-bg)] backdrop-blur-[var(--indicator-blur)] pointer-events-none transition-all duration-300 ease-out z-0"
              style={indicatorStyle}
              aria-hidden="true"
            />
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                data-tab-id={tab.id}
                aria-selected={activeTab === tab.id}
                id={`settings-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id as Tab)}
                className={cn(
                  "flex-shrink-0 lg:w-full px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 lg:gap-3 transition-colors whitespace-nowrap relative z-10",
                  activeTab === tab.id
                    ? "text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                )}
              >
                <tab.icon className="w-4 h-4 flex-shrink-0" aria-hidden />
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className="p-4 sm:p-6 max-w-4xl mx-auto">
          {/* Org Switcher */}
          {organizations.length > 0 && (
            <div className="mb-6 p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
              <div className="flex items-center gap-3 mb-3">
                <Building2 className="w-5 h-5 text-[var(--text-muted)]" />
                <span className="text-sm font-medium text-[var(--text-primary)]">Current Organization</span>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <label htmlFor="settings-org-select" className="sr-only">
                  Current organization
                </label>
                <select
                  id="settings-org-select"
                  value={currentOrg?.id || ""}
                  onChange={(e) => {
                    const org = organizations.find((o) => o.id === e.target.value);
                    if (org) {
                      setCurrentOrg(org);
                      // Sync Clerk's active org so useOrganization() returns
                      // the same org everywhere (sidebar, top nav, etc).
                      // June 2026 UI overhaul — without this, switching
                      // orgs from settings updated local state only.
                      const clerkOrgId = (org as { clerk_org_id?: string }).clerk_org_id;
                      if (clerkOrgId && setActiveOrg) {
                        void setActiveOrg({ organization: clerkOrgId });
                      }
                    }
                  }}
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                >
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name} ({org.role})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Tab Content */}
          <div className="page-enter" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
            {activeTab === "org" && <OrgTab org={currentOrg} />}
            {activeTab === "members" && <MembersTab org={currentOrg} />}
            {activeTab === "references" && <ReferencesTab org={currentOrg} />}
            {activeTab === "api-keys" && <ApiKeysTab org={currentOrg} />}
            {activeTab === "security" && <SecurityTab />}
            {activeTab === "scim" && <ScimTab org={currentOrg} />}
            {activeTab === "sso" && <SSOTab orgId={currentOrg?.id || ""} />}
            {activeTab === "gateway" && <GatewayTab org={currentOrg} />}
            {activeTab === "pii" && <PiiPolicyTab />}
            {activeTab === "retention" && <RetentionPolicyTab />}
            {activeTab === "region" && <RegionTab />}
            {activeTab === "audit-log" && <AuditLogTab org={currentOrg} />}
            {activeTab === "analytics" && <AnalyticsTab />}
            {activeTab === "billing" && <BillingTab />}
            {activeTab === "autonomous" && <AutonomousTab />}
            {activeTab === "exports" && (
              <ExportsTab
                orgId={currentOrg?.id || ""}
                canManage={currentOrg?.role === "owner" || currentOrg?.role === "admin"}
              />
            )}
            {activeTab === "sidebar" && <SidebarSettingsTab />}
          </div>
        </div>
      </div>
    </div>
  );
}


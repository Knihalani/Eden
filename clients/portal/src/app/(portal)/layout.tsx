"use client";

import { useAuth } from "@/hooks/use-auth";
import { useOrg } from "@/hooks/use-org";
import { useNotifications } from "@/hooks/use-notifications";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";
import {
  Loader2,
  LayoutDashboard,
  PlusCircle,
  FileText,
  LogOut,
  Layers,
  Menu,
  X,
  Home,
  User,
  ChevronLeft,
  Settings,
  CreditCard,
  Building2,
  Search,
  Bell,
  ChevronRight,
  Check,
  BarChart3,
  Sparkles,
  GitPullRequestArrow,
  Activity,
  Brain,
  AlertOctagon,
  Wand2,
  Bot,
  Wrench,
  Cog,
  Shield,
  FlaskConical,
  TrendingUp,
  Compass,
  Users,
  Inbox,
  Box,
  Server,
  Network,
} from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CommandPalette } from "@/components/ui/command-palette";
import { ChatSidebar } from "@/components/ai-insights/ChatSidebar";

const SIDEBAR_EXPANDED_WIDTH = 260;
const SIDEBAR_COLLAPSED_WIDTH = 64;

async function handleLogout(router: ReturnType<typeof useRouter>, closeDropdown: () => void) {
  closeDropdown();
  await fetch("/api/auth/logout", { method: "POST" });
  router.push("/login");
}

function buildBreadcrumbs(pathname: string): { label: string; href: string }[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: { label: string; href: string }[] = [];

  const labelMap: Record<string, string> = {
    dashboard: "Dashboard",
    jobs: "Eval Harnesses",
    "eval-harnesses": "Eval Harnesses",
    analytics: "Analytics",
    optimization: "Optimization",
    settings: "Settings",
    billing: "Billing",
    docs: "Documentation",
    profile: "Profile",
    new: "New",
    observability: "Observability",
    incidents: "Incidents",
    insights: "Insights",
    inspector: "Inspector",
    alerts: "Alerts",
    llmops: "LLMOps",
    agents: "Agents",
    builder: "Builder",
    marketplace: "Marketplace",
    "multi-agent": "Multi-Agent",
    sandbox: "Sandbox",
    users: "Users",
    guardrails: "Guardrails",
    autonomous: "Autonomous",
    studio: "Custom Metrics",
    "pr-suggestions": "PR Suggestions",
    retrieval: "Retrieval",
    memory: "Memory",
    time: "Time-Travel",
    "time-travel": "Time-Travel",
    apm: "APM",
    decisions: "Decisions",
    outcomes: "Outcomes",
    predict: "Predictive",
    tools: "Tools",
    query: "Query",
    cohorts: "Cohorts",
    governance: "Governance",
    eval: "Eval",
  };

  let path = "";
  for (const segment of segments) {
    path += `/${segment}`;
    const label = labelMap[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1);
    crumbs.push({ label, href: path });
  }

  return crumbs;
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { currentOrg, organizations, setCurrentOrg } = useOrg();
  const { flags } = useFeatureFlags();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [orgSwitcherOpen, setOrgSwitcherOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);
  const orgDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userDropdownRef.current && !userDropdownRef.current.contains(event.target as Node)) {
        setUserDropdownOpen(false);
      }
      if (orgDropdownRef.current && !orgDropdownRef.current.contains(event.target as Node)) {
        setOrgSwitcherOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Keyboard shortcut for command palette
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
          <p className="text-sm text-[var(--text-muted)]">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const breadcrumbs = buildBreadcrumbs(pathname);

  return (
    <div className="flex min-h-screen bg-[var(--bg-secondary)]">
      {/* Skip-to-content link — visually hidden until focused, allows keyboard users to bypass the sidebar nav */}
      <a href="#main-content" className="skip-to-content">
        Skip to main content
      </a>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 bg-[var(--bg-base)]/50 z-40 lg:hidden cursor-default border-0 p-0"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar: fixed drawer on mobile, in-flow on lg */}
      <aside
        className={cn(
          "sidebar flex flex-col relative bg-[var(--bg-primary)] border-r border-[var(--border-default)] z-50",
          "fixed inset-y-0 left-0 lg:static lg:inset-auto lg:flex-shrink-0",
          collapsed ? "collapsed" : "",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          "transition-[transform,width] duration-300 ease-out lg:transition-[width]"
        )}
        style={{
          width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
        }}
      >
        {/* Gradient overlay */}
        <div className="absolute inset-0 sidebar-gradient pointer-events-none" />

        {/* Logo & Org */}
        <div className="relative p-4 border-b border-[var(--border-default)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 bg-[var(--accent)] rounded-xl flex items-center justify-center flex-shrink-0">
                <Layers className="w-5 h-5 text-[var(--bg-primary)]" />
              </div>
              {!collapsed && (
                <div className="min-w-0">
                  <span className="text-xl font-bold text-[var(--text-primary)] block truncate">Eden</span>
                  {currentOrg && (
                    <span className="text-xs text-[var(--text-muted)] block truncate">{currentOrg.name}</span>
                  )}
                </div>
              )}
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Collapse button */}
        <button
          onClick={handleCollapse}
          className="hidden md:flex absolute -right-3 top-24 w-6 h-6 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-full items-center justify-center shadow-sm hover:shadow-md transition-all sidebar-collapse-btn z-10"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronLeft className={cn("w-3.5 h-3.5 text-[var(--text-secondary)] transition-transform duration-300", collapsed && "rotate-180")} />
        </button>

        {/* Organization Switcher */}
        {organizations.length > 0 && (
          <div className="relative px-3 py-3">
            {!collapsed ? (
              <div ref={orgDropdownRef} className="relative">
                <button
                  onClick={() => setOrgSwitcherOpen(!orgSwitcherOpen)}
                  className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                  aria-expanded={orgSwitcherOpen}
                  aria-haspopup="listbox"
                >
                  <Building2 className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
                  <span className="flex-1 text-sm font-medium text-left truncate">
                    {currentOrg?.name || "Select org"}
                  </span>
                  <ChevronLeft className={cn("w-3 h-3 transition-transform duration-200", orgSwitcherOpen ? "rotate-90" : "")} />
                </button>

                {orgSwitcherOpen && (
                  <div className="absolute left-0 right-0 mt-1 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-lg z-50" role="listbox" aria-label="Select organization">
                    {organizations.map((org) => (
                      <button
                        key={org.id}
                        onClick={() => {
                          setCurrentOrg(org);
                          setOrgSwitcherOpen(false);
                        }}
                        role="option"
                        aria-selected={org.id === currentOrg?.id}
                        className={cn(
                          "w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-tertiary)] flex items-center justify-between",
                          org.id === currentOrg?.id && "bg-[var(--accent-light)] text-[var(--accent)]"
                        )}
                      >
                        <span className="truncate">{org.name}</span>
                        <span className="text-xs text-[var(--text-muted)]">{org.role}</span>
                      </button>
                    ))}
                    <div className="border-t border-[var(--border-default)] mt-1 pt-1">
                      <Link
                        href="/settings"
                        className="w-full px-3 py-2 text-left text-sm text-[var(--accent)] hover:bg-[var(--accent-light)] flex items-center gap-2"
                        onClick={() => setOrgSwitcherOpen(false)}
                      >
                        <Settings className="w-3.5 h-3.5" />
                        Manage Organizations
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Link
                href="/settings"
                className="flex items-center justify-center p-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                title="Switch Organization"
              >
                <Building2 className="w-5 h-5 text-[var(--text-muted)]" />
              </Link>
            )}
          </div>
        )}

        {/* Navigation */}
        <nav className="relative flex-1 p-3 space-y-4 overflow-y-auto" aria-label="Main navigation">
          <NavGroup label="Workspace" collapsed={collapsed}>
            <NavItem href="/dashboard" icon={LayoutDashboard} label="Dashboard" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/agents" icon={Bot} label="Agents" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/builder" icon={Wand2} label="Builder" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/marketplace" icon={Box} label="Marketplace" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/multi-agent" icon={Network} label="Multi-Agent" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/sandbox" icon={Server} label="Sandbox" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
          </NavGroup>

          <NavGroup label="Observe" collapsed={collapsed}>
            <NavItem href="/observability" icon={Activity} label="Observability" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/incidents" icon={AlertOctagon} label="Incidents" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/insights" icon={Brain} label="Insights" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/inspector" icon={Compass} label="Inspector" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/alerts" icon={Bell} label="Alerts" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/llmops" icon={Cog} label="LLMOps" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
          </NavGroup>

          <NavGroup label="Optimize" collapsed={collapsed}>
            <NavItem href="/optimization" icon={Sparkles} label="Cost" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/studio" icon={FlaskConical} label="Custom Metrics" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
          </NavGroup>

          <NavGroup label="Protect" collapsed={collapsed}>
            <NavItem href="/guardrails" icon={Shield} label="Guardrails" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
          </NavGroup>

          <NavGroup label="Automate" collapsed={collapsed}>
            <NavItem href="/autonomous" icon={Wand2} label="Autonomous" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/closed-loop" icon={Inbox} label="Closed-Loop" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/pr-suggestions" icon={GitPullRequestArrow} label="PR Suggestions" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/analytics" icon={BarChart3} label="Analytics" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
          </NavGroup>

          <NavGroup label="Account" collapsed={collapsed}>
            <NavItem href="/settings" icon={Settings} label="Settings" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/billing" icon={CreditCard} label="Billing" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/docs" icon={FileText} label="Docs" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
            <NavItem href="/profile" icon={User} label="Profile" collapsed={collapsed} onClick={() => setSidebarOpen(false)} />
          </NavGroup>
        </nav>

        {/* User section */}
        <div className="relative p-3 border-t border-[var(--border-default)]">
          <div ref={userDropdownRef} className="relative">
            {/* User button */}
            <button
              onClick={() => setUserDropdownOpen(!userDropdownOpen)}
              className={cn(
                "w-full flex items-center gap-3 p-2 rounded-lg transition-colors",
                userDropdownOpen
                  ? "bg-[var(--accent-light)]"
                  : "hover:bg-[var(--bg-tertiary)]"
              )}
              aria-expanded={userDropdownOpen}
              aria-haspopup="true"
              aria-label="User menu"
            >
              <div className="user-avatar user-avatar-online w-9 h-9 rounded-full flex items-center justify-center text-sm flex-shrink-0">
                {user.name.charAt(0).toUpperCase()}
              </div>
              {!collapsed && (
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {user.name}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] truncate">{user.email}</p>
                </div>
              )}
            </button>

            {/* Dropdown */}
            <div className={cn("user-dropdown", userDropdownOpen ? "open" : "")} role="menu" aria-label="User menu">
              <Link
                href="/settings"
                className="user-dropdown-item"
                onClick={() => setUserDropdownOpen(false)}
              >
                <Settings className="w-4 h-4" />
                Settings
              </Link>
              <Link
                href="/billing"
                className="user-dropdown-item"
                onClick={() => setUserDropdownOpen(false)}
              >
                <CreditCard className="w-4 h-4" />
                Billing
              </Link>
              <button
                onClick={() => handleLogout(router, () => setUserDropdownOpen(false))}
                className="user-dropdown-item danger w-full"
                role="menuitem"
              >
                <LogOut className="w-4 h-4" />
                Log out
              </button>
            </div>
          </div>

          {/* Logout button when collapsed */}
          {collapsed && (
            <button
              onClick={() => handleLogout(router, () => {})}
              className="w-full mt-2 p-2 text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-bg)] rounded-lg transition-colors flex items-center justify-center"
              aria-label="Log out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main id="main-content" className="flex-1 overflow-auto pb-20 lg:pb-0" tabIndex={-1}>
        {/* Top bar */}
        <header className="sticky top-0 z-30 bg-[var(--bg-primary)] border-b border-[var(--border-default)]">
          <div className="flex items-center justify-between px-4 lg:px-6 py-3">
            {/* Left: Mobile logo + hamburger */}
            <div className="flex items-center gap-3 lg:hidden">
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-2.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg active:bg-[var(--border-default)]"
                aria-label="Open menu"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="w-8 h-8 bg-[var(--accent)] rounded-lg flex items-center justify-center">
                <Layers className="w-4 h-4 text-[var(--bg-primary)]" />
              </div>
            </div>

            {/* Breadcrumb */}
            <nav className="flex items-center gap-1.5 text-sm min-w-0 flex-1 lg:flex-initial" aria-label="Breadcrumb">
              <Link
                href="/dashboard"
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
                aria-label="Dashboard"
              >
                <Home className="w-4 h-4" />
              </Link>
              {breadcrumbs.map((crumb, index) => (
                <span key={crumb.href} className="flex items-center gap-1.5">
                  <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />
                  {index === breadcrumbs.length - 1 ? (
                    <span className="font-medium text-[var(--text-primary)]">{crumb.label}</span>
                  ) : (
                    <Link href={crumb.href} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                      {crumb.label}
                    </Link>
                  )}
                </span>
              ))}
            </nav>

            {/* Right: Search + Notifications */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCommandPaletteOpen(true)}
                className="hidden lg:flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-muted)] bg-[var(--bg-tertiary)] hover:bg-[var(--border-default)] rounded-lg transition-colors"
                title="Search (⌘K)"
              >
                <Search className="w-4 h-4" />
                <span className="text-xs">Search...</span>
                <kbd className="ml-2 px-1.5 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[var(--text-muted)] font-mono text-xs">⌘K</kbd>
              </button>
              <button
                onClick={() => setCommandPaletteOpen(true)}
                className="lg:hidden p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg active:bg-[var(--border-default)]"
                aria-label="Search"
              >
                <Search className="w-5 h-5" />
              </button>
              <NotificationsDropdown />
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="page-enter">
          {children}
        </div>

        {/* Mobile bottom navigation */}
        <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-[var(--bg-primary)] border-t border-[var(--border-default)] z-40" aria-label="Mobile navigation">
          <div className="flex items-center justify-around h-16 px-1">
            <BottomNavItem href="/dashboard" icon={Home} label="Home" />
            {flags.enable_eval_pipeline && (
              <>
                <BottomNavItem href="/eval-harnesses" icon={Layers} label="Harnesses" />
                <BottomNavItem href="/eval-harnesses/new" icon={PlusCircle} label="New" isCenter />
              </>
            )}
            <BottomNavItem href="/settings" icon={Settings} label="Settings" />
            <BottomNavItem href="/profile" icon={User} label="Profile" />
          </div>
        </nav>

        {/* Command Palette (Cmd+K) */}
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      </main>

      {/* AI Insights chat sidebar — persistent across the portal.
          Renders its own floating toggle button so it can be opened
          from any page. */}
      <ChatSidebar />
    </div>
  );
}

function NotificationsDropdown() {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { notifications, unreadCount, loading, markAsRead, markAllAsRead, deleteNotification } = useNotifications();

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const formatRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "job_completed":
        return <Check className="w-4 h-4 text-[var(--terminal)]" />;
      case "job_failed":
        return <X className="w-4 h-4 text-[var(--error)]" />;
      default:
        return <Bell className="w-4 h-4 text-[var(--text-muted)]" />;
    }
  };

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "p-2 rounded-lg transition-colors relative",
          open
            ? "bg-[var(--accent-light)] text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
        )}
        aria-label="Notifications"
        aria-expanded={open}
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-[var(--error)] text-[var(--bg-primary)] text-[10px] font-bold rounded-full px-1">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-lg z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
            <h3 className="font-semibold text-sm text-[var(--text-primary)]">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={() => markAllAsRead()}
                className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] font-medium"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-[320px] overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
              </div>
            ) : notifications.length === 0 ? (
              <div className="text-center py-8">
                <Bell className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] stroke-1 opacity-50" />
                <p className="text-sm text-[var(--text-muted)]">No notifications</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)]">
                {notifications.map((notification) => (
                  <div
                    key={notification.id}
                    className={cn(
                      "px-4 py-3 hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer",
                      !notification.is_read && "bg-[var(--accent-light)]/30"
                    )}
                    onClick={() => {
                      if (!notification.is_read) {
                        markAsRead(notification.id);
                      }
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 p-1.5 rounded bg-[var(--bg-tertiary)] shrink-0">
                        {getNotificationIcon(notification.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className={cn(
                            "text-sm font-medium truncate",
                            notification.is_read ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]"
                          )}>
                            {notification.title}
                          </p>
                          {notification.is_read && (
                            <Check className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">
                          {notification.message}
                        </p>
                        <p className="text-xs text-[var(--text-muted)] mt-1">
                          {formatRelativeTime(notification.created_at)}
                        </p>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteNotification(notification.id);
                        }}
                        className="p-1 text-[var(--text-muted)] hover:text-[var(--error)] transition-colors shrink-0"
                        aria-label="Delete notification"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
}

function NavItem({
  href,
  icon: Icon,
  label,
  collapsed,
  onClick,
}: {
  href: string;
  icon: typeof LayoutDashboard;
  label: string;
  collapsed: boolean;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const active = isActivePath(pathname, href);

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-label={label}
      className={cn(
        "nav-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors relative",
        active
          ? "active"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      )}
    >
      <Icon
        className={cn(
          "flex-shrink-0 nav-icon transition-all duration-200",
          active ? "w-5 h-5 text-[var(--accent)]" : "w-4 h-4 text-[var(--text-muted)]"
        )}
      />
      {!collapsed && <span className="truncate">{label}</span>}
      {collapsed && <span className="nav-tooltip">{label}</span>}
    </Link>
  );
}

function BottomNavItem({
  href,
  icon: Icon,
  label,
  isCenter,
}: {
  href: string;
  icon: typeof Home;
  label: string;
  isCenter?: boolean;
}) {
  const pathname = usePathname();
  const active = isActivePath(pathname, href);

  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center justify-center min-w-[44px] min-h-[44px] gap-1 transition-colors",
        isCenter
          ? "text-[var(--accent)] hover:text-[var(--accent-hover)]"
          : active
            ? "text-[var(--accent)]"
            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      )}
    >
      <Icon className={cn("w-5 h-5", isCenter && "w-6 h-6")} />
      <span className="text-[10px] font-medium">{label}</span>
    </Link>
  );
}

function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: React.ReactNode;
}) {
  if (collapsed) {
    // When collapsed, show items directly with a thin divider above
    return <div className="space-y-0.5 border-t border-[var(--border-subtle)] pt-2 first:border-t-0 first:pt-0">{children}</div>;
  }
  return (
    <div className="space-y-0.5">
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] opacity-70">
        {label}
      </div>
      {children}
    </div>
  );
}
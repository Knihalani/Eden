"use client";

import { useAuth } from "@/hooks/use-auth";
import { useNotifications } from "@/hooks/use-notifications";
import { useSidebarPrefs, applySidebarPrefs } from "@/hooks/use-sidebar-prefs";
import { useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";
import { Pin } from "lucide-react";
import {
  Loader2,
  LayoutDashboard,
  PlusCircle,
  PlayCircle,
  FileText,
  LogOut,
  Layers,
  Menu,
  X,
  Home,
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
import { Logo } from "@/components/brand/logo";

const SIDEBAR_EXPANDED_WIDTH = 260;
const SIDEBAR_COLLAPSED_WIDTH = 64;

// Logout delegates to Clerk (which terminates the session, clears the
// __session cookie, and signs out across all tabs). We follow with a
// router push to /login so the user lands back on the auth flow.
async function handleLogout(
  router: ReturnType<typeof useRouter>,
  closeDropdown: () => void,
  signOut: () => Promise<void>,
) {
  closeDropdown();
  await signOut();
  router.push("/login");
}

function buildBreadcrumbs(pathname: string): { label: string; href: string }[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: { label: string; href: string }[] = [];

  const labelMap: Record<string, string> = {
    dashboard: "Dashboard",
    analytics: "Analytics",
    optimization: "Cost",
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
    users: "Members",
    guardrails: "Guardrails",
    autonomous: "Autonomous",
    studio: "Custom Metrics",
    "pr-suggestions": "PR Suggestions",
    retrieval: "Retrieval",
    memory: "Memory",
    time: "Time-Travel",
    "time-travel": "Time-Travel",
    apm: "APM Tracing",
    decisions: "Decisions",
    outcomes: "Outcomes",
    predict: "Predictive",
    tools: "Tools",
    query: "Query",
    cohorts: "Columnar Engine",
    governance: "Governance",
    eval: "Eval",
    traces: "Trace Explorer",
    onboarding: "Onboarding",
    connect: "Connect Agent",
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
  const { signOut } = useClerk();
  const { prefs, togglePin } = useSidebarPrefs();
  const { pinnedItems, groups } = applySidebarPrefs(prefs);
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userDropdownRef.current && !userDropdownRef.current.contains(event.target as Node)) {
        setUserDropdownOpen(false);
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
    // ponytail: h-screen + overflow-clip on the row, min-h-0 on main —
    // this is what makes the sidebar scroll internally instead of pushing
    // the whole page past the viewport. overflow-clip (vs overflow-hidden)
    // keeps `position: sticky` working on the top header inside <main>;
    // overflow-hidden breaks sticky on Firefox because it creates a new
    // containing block. June 2026 UI overhaul.
    <div className="flex h-screen overflow-clip bg-[var(--bg-secondary)]">
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
          "sidebar flex flex-col relative bg-[var(--bg-primary)] border-r border-[var(--border-default)] z-50 h-full",
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

        {/* Brand header: real Eden logo + wordmark.
            No competing "Eden wordmark + tiny Clerk org avatar" stack —
            the active org is reached via Settings → Organization, never
            surfaced in the chrome. */}
        <div className="relative flex items-center justify-between gap-2 px-4 h-14 border-b border-[var(--border-default)] shrink-0">
          <Logo size="md" showWordmark priority className="min-w-0" />
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Collapse button (desktop only) */}
        <button
          onClick={handleCollapse}
          className="hidden md:flex absolute -right-3 top-[68px] w-6 h-6 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-full items-center justify-center shadow-sm hover:shadow-md transition-all sidebar-collapse-btn z-10"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronLeft className={cn("w-3.5 h-3.5 text-[var(--text-secondary)] transition-transform duration-300", collapsed && "rotate-180")} />
        </button>

        {/* Organization switcher REMOVED — June 2026 UI overhaul.
            The active org still flows through Clerk + useOrg(), but
            the sidebar no longer surfaces an org logo/avatar (which
            looked like a second brand mark next to the Eden logo).
            Users reach org controls via Settings → Organization. */}

        {/* Navigation — data-driven from DEFAULT_SIDEBAR + user prefs
            (pinned / hidden / reordered). The aside scrolls internally
            (flex-1 min-h-0 + overflow-y-auto + max-h to be doubly sure
            the sidebar NEVER pushes the page height past the viewport).
            The outer row is h-screen + overflow-clip so the user
            section is pinned to the bottom of the aside via mt-auto. */}
        <nav
          className="relative flex-1 min-h-0 max-h-full p-3 space-y-5 overflow-y-auto overscroll-contain"
          aria-label="Main navigation"
        >
          {pinnedItems.length > 0 && (
            <NavGroup label="Pinned" collapsed={collapsed}>
              {pinnedItems.map((item) => (
                <NavItem
                  key={item.id}
                  href={item.href}
                  icon={item.icon}
                  label={item.label}
                  collapsed={collapsed}
                  onClick={() => setSidebarOpen(false)}
                  pinned
                  onTogglePin={() => togglePin(item.id)}
                />
              ))}
            </NavGroup>
          )}

          {groups.map((group) => (
            <NavGroup key={group.id} label={group.label} collapsed={collapsed}>
              {group.items.map((item) => {
                const isPinned = prefs.pinned.includes(item.id);
                return (
                  <NavItem
                    key={item.id}
                    href={item.href}
                    icon={item.icon}
                    label={item.label}
                    badge={item.badge}
                    collapsed={collapsed}
                    onClick={() => setSidebarOpen(false)}
                    pinned={isPinned}
                    onTogglePin={() => togglePin(item.id)}
                  >
                    {item.children?.map((child) => (
                      <NavSubItem
                        key={child.id}
                        href={child.href}
                        label={child.label}
                        onClick={() => setSidebarOpen(false)}
                      />
                    ))}
                  </NavItem>
                );
              })}
            </NavGroup>
          ))}

          {!collapsed && (
            <Link
              href="/settings?tab=sidebar"
              className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
            >
              Customize sidebar
            </Link>
          )}
        </nav>

        {/* User section — shrink-0 + mt-auto keeps it pinned to the
            bottom of the aside even when the nav is short on items. */}
        <div className="relative mt-auto p-3 border-t border-[var(--border-default)] shrink-0">
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
                href="/settings?tab=org"
                className="user-dropdown-item"
                onClick={() => setUserDropdownOpen(false)}
              >
                <Building2 className="w-4 h-4" />
                Organization
              </Link>
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
                onClick={() => handleLogout(router, () => setUserDropdownOpen(false), signOut)}
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
              onClick={() => handleLogout(router, () => {}, signOut)}
              className="w-full mt-2 p-2 text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-bg)] rounded-lg transition-colors flex items-center justify-center"
              aria-label="Log out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </aside>

      {/* Main content — min-h-0 lets the flex item actually shrink so
          its overflow-auto can scroll instead of pushing the row. */}
      <main id="main-content" className="flex-1 min-w-0 min-h-0 overflow-auto pb-20 lg:pb-0 flex flex-col" tabIndex={-1}>
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
              <Logo size="sm" showWordmark={false} priority />
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
              {(() => {
                // For deep paths (≥3 crumbs), collapse the middle and
                // show only the immediate parent + current. This keeps
                // the breadcrumb header tight without losing "you are
                // here under X" context.
                const visible = breadcrumbs.length > 2
                  ? [breadcrumbs[breadcrumbs.length - 2], breadcrumbs[breadcrumbs.length - 1]]
                  : breadcrumbs;
                return visible.map((crumb, index) => {
                  const isLast = index === visible.length - 1;
                  // When collapsed, prefix the parent crumb with "…" to
                  // signal that the chain is shortened.
                  const showEllipsis = breadcrumbs.length > 2 && index === 0;
                  return (
                    <span key={crumb.href} className="flex items-center gap-1.5 min-w-0">
                      {showEllipsis && (
                        <>
                          <span className="text-[var(--text-muted)]">…</span>
                          <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />
                        </>
                      )}
                      {!showEllipsis && (
                        <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />
                      )}
                      {isLast ? (
                        <span className="font-medium text-[var(--text-primary)] truncate">{crumb.label}</span>
                      ) : (
                        <Link
                          href={crumb.href}
                          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors truncate"
                        >
                          {crumb.label}
                        </Link>
                      )}
                    </span>
                  );
                });
              })()}
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

        {/* Page content — flex-1 + min-h-0 lets the wrapper shrink
            with the parent <main> so pages with `min-h-screen` or
            `h-screen` don't push the whole flex row past the viewport.
            June 2026 UI overhaul. */}
        <div className="page-enter flex-1 min-h-0 flex flex-col">
          {children}
        </div>

        {/* Mobile bottom navigation. Centered "Observe" item is the
            raised/pill style via `isCenter`; pb-safe gives the bar
            enough breathing room for notched phones. */}
        <nav
          className="lg:hidden fixed bottom-0 left-0 right-0 bg-[var(--bg-primary)] border-t border-[var(--border-default)] z-40 pb-safe"
          aria-label="Mobile navigation"
        >
          <div className="flex items-center justify-around h-16 px-1">
            <BottomNavItem href="/dashboard" icon={Home} label="Home" />
            <BottomNavItem href="/traces" icon={Layers} label="Traces" />
            <BottomNavItem href="/observability" icon={Activity} label="Observe" isCenter />
            <BottomNavItem href="/alerts" icon={Bell} label="Alerts" />
            <BottomNavItem href="/settings" icon={Settings} label="Settings" />
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
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(href + "/") || href === pathname);
}

function NavSubItem({
  href,
  label,
  onClick,
}: {
  href: string;
  label: string;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const active = isActivePath(pathname, href);
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "nav-subitem block pl-9 pr-3 py-1.5 rounded-md text-xs font-medium transition-colors relative",
        active
          ? "text-[var(--accent)] bg-[var(--accent-light)]/60"
          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-[var(--accent)]"
        />
      )}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function NavItem({
  href,
  icon: Icon,
  label,
  collapsed,
  onClick,
  children,
  badge,
  pinned,
  onTogglePin,
}: {
  href: string;
  icon: typeof LayoutDashboard;
  label: string;
  collapsed: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  /** Optional badge shown next to the label (e.g. "new", "beta"). */
  badge?: string;
  /** Whether this item is currently in the "Pinned" section. */
  pinned?: boolean;
  /** Toggle the pinned state. When provided, a pin button appears on hover. */
  onTogglePin?: () => void;
}) {
  const pathname = usePathname();
  const active = isActivePath(pathname, href);
  const hasChildren = !collapsed && children;

  return (
    <div className="group/navitem relative">
      <Link
        href={href}
        onClick={onClick}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "nav-item flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 relative",
          active
            ? "bg-[var(--accent-light)] text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
        )}
      >
        {/* Left-edge accent bar for active items — gives a stronger
            visual "you are here" cue than just icon color. */}
        {active && (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--accent)]"
          />
        )}
        <Icon
          className={cn(
            "flex-shrink-0 nav-icon transition-all duration-200",
            active ? "w-4 h-4 text-[var(--accent)]" : "w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]"
          )}
        />
        {!collapsed && (
          <>
            <span className="truncate flex-1">{label}</span>
            {badge && (
              <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded bg-[var(--accent-faint)] text-[var(--accent)]">
                {badge}
              </span>
            )}
            {onTogglePin && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onTogglePin();
                }}
                aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
                aria-pressed={pinned}
                className={cn(
                  "p-1 rounded transition-all",
                  pinned
                    ? "text-[var(--accent)] opacity-100"
                    : "text-[var(--text-muted)] opacity-0 group-hover/navitem:opacity-100 hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
                )}
                title={pinned ? "Unpin from sidebar" : "Pin to top of sidebar"}
              >
                <Pin className={cn("w-3.5 h-3.5", pinned && "fill-current")} />
              </button>
            )}
          </>
        )}
        {collapsed && <span className="nav-tooltip">{label}</span>}
      </Link>
      {hasChildren && (
        <div className="mt-0.5 space-y-0.5">{children}</div>
      )}
    </div>
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
        isCenter && "relative -mt-3",
        active ? "text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      )}
    >
      {isCenter ? (
        <span className="flex items-center justify-center w-12 h-12 rounded-full bg-[var(--accent)] text-[var(--accent-foreground)] shadow-lg shadow-[var(--accent)]/30">
          <Icon className="w-6 h-6" />
        </span>
      ) : (
        <Icon className="w-5 h-5" />
      )}
      <span className={cn("text-[10px] font-medium", isCenter && "sr-only")}>{label}</span>
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
    <div className="space-y-1">
      <div className="px-3 pt-1 pb-0.5 text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]/80">
        {label}
      </div>
      {children}
    </div>
  );
}
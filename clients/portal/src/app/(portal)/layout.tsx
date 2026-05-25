"use client";

import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

const SIDEBAR_EXPANDED_WIDTH = 240;
const SIDEBAR_COLLAPSED_WIDTH = 64;

async function handleLogout(router: ReturnType<typeof useRouter>, closeDropdown: () => void) {
  closeDropdown();
  await fetch("/api/auth/logout", { method: "POST" });
  router.push("/login");
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <p className="text-sm text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="flex min-h-screen bg-[var(--background)]">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "sidebar flex flex-col bg-[var(--surface)] border-r border-[var(--border)] relative z-50",
          // Desktop collapse
          "hidden lg:flex",
          collapsed ? "collapsed" : "",
          // Mobile slide-in
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          "lg:translate-x-0",
          "transition-[transform,width] duration-300 lg:transition-[width]"
        )}
        style={{
          width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
        }}
      >
        {/* Gradient overlay */}
        <div className="absolute inset-0 sidebar-gradient pointer-events-none" />

        {/* Logo */}
        <div className="relative p-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-[#0ea5e9] rounded-xl flex items-center justify-center flex-shrink-0">
                <Layers className="w-5 h-5 text-white" />
              </div>
              {!collapsed && (
                <span className="text-xl font-bold text-[var(--text-primary)]">Eden</span>
              )}
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-stone-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Collapse button (desktop + tablet) */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden md:flex absolute -right-3 top-20 w-6 h-6 bg-[var(--surface)] border border-[var(--border)] rounded-full items-center justify-center shadow-sm hover:shadow-md transition-all sidebar-collapse-btn"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronLeft className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
        </button>

        {/* Navigation */}
        <nav className="relative flex-1 p-3 space-y-1">
          <NavItem href="/dashboard" icon={LayoutDashboard} label="Dashboard" collapsed={collapsed} onClick={() => setSidebarOpen(false)} iconSize="large" />
          <NavItem href="/jobs" icon={Layers} label="Jobs" collapsed={collapsed} onClick={() => setSidebarOpen(false)} iconSize="small" />
          <NavItem href="/jobs/new" icon={PlusCircle} label="New Job" collapsed={collapsed} onClick={() => setSidebarOpen(false)} iconSize="large" />
          <NavItem href="/docs" icon={FileText} label="Documentation" collapsed={collapsed} onClick={() => setSidebarOpen(false)} iconSize="small" />
        </nav>

        {/* User section */}
        <div className="relative p-3 border-t border-[var(--border)]">
          <div ref={userDropdownRef} className="relative">
            {/* User button */}
            <button
              onClick={() => setUserDropdownOpen(!userDropdownOpen)}
              className={cn(
                "w-full flex items-center gap-3 p-2 rounded-lg transition-colors",
                userDropdownOpen
                  ? "bg-[var(--accent-bg)]"
                  : "hover:bg-stone-100"
              )}
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
            <div className={cn("user-dropdown", userDropdownOpen ? "open" : "")}>
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
              title="Log out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto pb-20 lg:pb-0">
        {/* Mobile header with hamburger */}
        <header className="lg:hidden sticky top-0 z-30 bg-[var(--surface)] border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#0ea5e9] rounded-lg flex items-center justify-center">
              <Layers className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold text-[var(--text-primary)]">Eden</span>
          </div>
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2.5 text-[var(--text-secondary)] hover:bg-stone-100 rounded-lg active:bg-stone-200"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
        </header>

        {children}

        {/* Mobile bottom navigation */}
        <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-[var(--surface)] border-t border-[var(--border)] z-40">
          <div className="flex items-center justify-around h-16">
            <BottomNavItem href="/dashboard" icon={Home} label="Home" />
            <BottomNavItem href="/jobs" icon={Layers} label="Jobs" />
            <BottomNavItem href="/jobs/new" icon={PlusCircle} label="New" isCenter />
            <BottomNavItem href="/profile" icon={User} label="Profile" />
          </div>
        </nav>
      </main>
    </div>
  );
}

function NavItem({
  href,
  icon: Icon,
  label,
  collapsed,
  onClick,
  iconSize = "default",
}: {
  href: string;
  icon: typeof LayoutDashboard;
  label: string;
  collapsed: boolean;
  onClick?: () => void;
  iconSize?: "default" | "large" | "small";
}) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + "/");

  const sizeClasses = {
    default: isActive ? "w-4 h-4" : "w-4 h-4",
    large: isActive ? "w-5 h-5" : "w-4 h-4",
    small: isActive ? "w-4 h-4" : "w-3.5 h-3.5",
  };

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-label={label}
      className={cn(
        "nav-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
        isActive ? "active" : "text-[var(--text-secondary)]"
      )}
    >
      <Icon
        className={cn(
          "flex-shrink-0 nav-icon transition-all duration-200",
          sizeClasses[iconSize],
          isActive
            ? "text-[var(--accent)]"
            : "text-[var(--text-muted)]"
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
  const isActive = pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      className={cn(
        "flex flex-col items-center justify-center min-w-[44px] min-h-[44px] gap-1 transition-colors",
        isCenter
          ? "text-blue-600 hover:text-blue-700"
          : isActive
            ? "text-blue-600"
            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      )}
    >
      <Icon className={cn("w-5 h-5", isCenter && "w-6 h-6")} />
      <span className="text-[10px] font-medium">{label}</span>
    </Link>
  );
}
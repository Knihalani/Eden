"use client";

import { useAuth } from "@/hooks/use-auth";
import { useNotifications } from "@/hooks/use-notifications";
import { useOrg } from "@/hooks/use-org";
import {
  useSidebarPrefs,
  applySidebarPrefs,
  readAdvancedCollapsed,
  writeAdvancedCollapsed } from "@/hooks/use-sidebar-prefs";
import { useClerk } from "@clerk/nextjs";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef, useCallback, Suspense } from "react";
import { Pin, PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";
import {
  Loader2,
  LayoutDashboard,
  
  
  
  LogOut,
  Layers,
  Menu,
  X,
  Home,
  
  Settings,
  CreditCard,
  Building2,
  Search,
  Bell,
  ChevronRight,
  Check,
  
  
  
  Activity,
  
  
  AlertTriangle,
  ArrowRight } from "lucide-react";
import { cn, isExternalHref } from "@/lib/utils";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { CommandPalette } from "@/components/ui/command-palette";
import { ChatSidebar } from "@/components/ai-insights/ChatSidebar";
import { Logo } from "@/components/brand/logo";
import { PortalNavLink } from "@/components/layout/portal-nav-link";
import { buildBreadcrumbs } from "@/lib/breadcrumbs";
import { PageHelpHint } from "@/components/layout/page-help-hint";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { OnboardingBanner } from "@/components/onboarding-banner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";
import { isKnownPortalPath } from "@/lib/portal-routes";

const SIDEBAR_EXPANDED_WIDTH = 260;
const SIDEBAR_COLLAPSED_WIDTH = 64;
const COLLAPSE_STORAGE_KEY = "eden:sidebar:collapsed";

/** ponytail: read collapsed state from localStorage once on mount.
 *  Defaults to `false` (expanded). SSR-safe — returns false on the
 *  server so the hydration markup matches the first client paint. */
function readCollapsedPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

// Logout fans out two responsibilities in parallel:
//
//   1. Clerk: ``useClerk().signOut()`` terminates the Clerk session,
//      clears the ``__session`` cookie, and broadcasts the sign-out
//      to other tabs. (F34 fix: previously the only step here.)
//   2. FastAPI: ``api.logout()`` hits ``POST /api/auth/logout``,
//      which bumps ``users.token_version`` and clears the
//      httponly Eden ``authorization`` cookie via Set-Cookie.
//      Without step 2 the Eden cookie remains valid against
//      FastAPI until natural expiry, and every other tab stays
//      authenticated against FastAPI — a real cookie-session
//      invalidation bug because httponly cookies can't be cleared
//      from JavaScript. (F34 fix, July 2026.)
//
// We fire both in parallel; whichever resolves first unblocks the
// ``router.push("/login")``. We swallow ``api.logout()`` errors
// because the Clerk-side cleanup is the user-visible one — a
// network blip on the backend logout must not leave the user
// staring at an error toast after they've already signed out of
// Clerk. The proxy's logout route (F34) translates backend 401s
// (stale cookie) into 200s so this rarely throws anyway.
async function handleLogout(
  router: ReturnType<typeof useRouter>,
  closeDropdown: () => void,
  signOut: () => Promise<void>,
) {
  closeDropdown();
  await Promise.allSettled([
    signOut(),
    api.logout().catch((err) => {
      if (process.env.NODE_ENV !== "production") {
        console.warn("Backend logout failed (continuing):", err);
      }
    }),
  ]);
  router.push("/login");
}

// buildBreadcrumbs is imported from @/lib/breadcrumbs.
// Extracted in June 2026 cleanup — keeps the layout file focused on
// chrome and makes breadcrumb labels discoverable in one place.

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] bg-[var(--bg-base)] flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" aria-hidden />
        </div>
      }
    >
      <PortalLayoutContent>{children}</PortalLayoutContent>
    </Suspense>
  );
}

function PortalLayoutContent({ children }: { children: React.ReactNode }) {
  const { user, loading, refreshUserWithRetry } = useAuth();
  const { signOut } = useClerk();
  const { prefs, togglePin } = useSidebarPrefs();
  const { authError, clearAuthError, refreshOrgs, currentOrg, orgSyncing } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [advancedCollapsed, setAdvancedCollapsed] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);
  // ponytail: hydrated after mount so the first client paint matches the
  // SSR markup (collapsed=false). Without the gate the sidebar would
  // jump from expanded → collapsed on every reload, which is jarring.
  const [collapseHydrated, setCollapseHydrated] = useState(false);

  // Hydrate collapse preference from localStorage on mount.
  useEffect(() => {
    setCollapsed(readCollapsedPreference());
    setAdvancedCollapsed(readAdvancedCollapsed());
    setCollapseHydrated(true);
  }, []);

  const toggleAdvanced = useCallback(() => {
    setAdvancedCollapsed((prev) => {
      const next = !prev;
      writeAdvancedCollapsed(next);
      return next;
    });
  }, []);

  // Persist collapse preference on change.
  useEffect(() => {
    if (!collapseHydrated) return;
    try {
      window.localStorage.setItem(
        COLLAPSE_STORAGE_KEY,
        collapsed ? "1" : "0",
      );
    } catch {
      // localStorage may be disabled — non-fatal.
    }
  }, [collapsed, collapseHydrated]);

  // Close dropdown when clicking outside.
  //
  // The first click after hydration used to be eaten: the toggle
  // button opens the dropdown, then the outside-click handler fires
  // in the same tick before the ref is attached and immediately
  // closes it again. Gate behind ``userDropdownOpen`` so the
  // handler only attaches when there's something to close, and
  // skip the very first event (the click that opened the dropdown
  // itself) by checking ``target`` against the toggle button.
  useEffect(() => {
    if (!userDropdownOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const root = userDropdownRef.current;
      if (root && !root.contains(event.target as Node)) {
        setUserDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [userDropdownOpen]);

  // ponytail: built-in PerformanceObserver for the three Core Web
  // Vitals (LCP, INP, CLS) — no new dep, real-user data without
  // shipping web-vitals. Production builds could forward these via
  // the existing observability/sse ingest.
  useEffect(() => {
    if (typeof window === "undefined" || !("PerformanceObserver" in window)) {
      return;
    }
    const log = (metric: string, value: number) => {
      // ponytail: console.debug instead of console.log so it doesn't
      // pollute prod output unless explicitly enabled.
      if (typeof console !== "undefined") console.debug(`[web-vitals] ${metric}=${value.toFixed(0)}`);
    };
    try {
      const lcp = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) log("LCP", last.startTime);
      });
      lcp.observe({ type: "largest-contentful-paint", buffered: true });

      const cls = new PerformanceObserver((list) => {
        let total = 0;
        for (const e of list.getEntries()) {
          const entry = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (!entry.hadRecentInput) total += entry.value ?? 0;
        }
        log("CLS", total * 1000);
      });
      cls.observe({ type: "layout-shift", buffered: true });

      const inp = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const entry = e as PerformanceEntry & { duration?: number };
          log("INP", entry.duration ?? 0);
        }
      });
      // Audit 2026-07-02 — ``durationThreshold`` is not in the
      // ``PerformanceObserverInit`` lib.dom types under Next 16
      // (it lives on the event-timing spec but the TypeScript
      // built-in doesn't expose it). Cast through ``unknown``
      // so the runtime call is correct without breaking the
      // typecheck.
      inp.observe({
        type: "event",
        buffered: true,
        // @ts-expect-error lib.dom typing gap in Next 16.
        durationThreshold: 16,
      });

      return () => {
        lcp.disconnect();
        cls.disconnect();
        inp.disconnect();
      };
    } catch {
      // Some browsers throw on unsupported observer types — non-fatal.
      return;
    }
  }, []);

  // Keyboard shortcuts: command palette + sidebar toggle + Escape close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip when the user is typing in a form field — otherwise typing
      // "b" in a search box would collapse the sidebar.
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }
      // Escape closes the mobile sidebar overlay. Don't intercept
      // Escape while typing — that's owned by the form field itself.
      if (e.key === "Escape" && sidebarOpen && !isFormField) {
        e.preventDefault();
        setSidebarOpen(false);
        return;
      }
      // Cmd/Ctrl+B (or just `\` outside inputs) toggles the sidebar.
      if (
        (e.key === "b" && (e.metaKey || e.ctrlKey)) ||
        (e.key === "\\" && !isFormField && !e.metaKey && !e.ctrlKey)
      ) {
        e.preventDefault();
        setCollapsed((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOpen]);

  const handleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  // Authed user with no org: send them through the onboarding wizard
  // instead of letting them land on /dashboard and stare at a
  // NoOrgState card. Only redirect on routes that REQUIRE an org —
  // /onboarding/* and the auth-bound flows (invite, settings/profile)
  // are valid even for org-less users. The list is intentionally
  // small: the wizard is the productive path for a brand-new user,
  // and adding more prefixes dilutes the safety of this gate.
  useEffect(() => {
    if (loading || !user || currentOrg) return;
    // Clerk may have an active org while Eden syncs — don't bounce
    // the user away from dashboard during the brief sync window.
    if (orgSyncing) return;
    const path = pathname || "";
    const isOrglessFriendly =
      path === "/" ||
      path.startsWith("/onboarding") ||
      path.startsWith("/invite") ||
      path.startsWith("/settings/profile") ||
      path.startsWith("/settings/account") ||
      path.startsWith("/login") ||
      path.startsWith("/sign-in") ||
      path.startsWith("/sign-up");
    if (!isOrglessFriendly) {
      router.replace("/onboarding");
    }
  }, [loading, user, currentOrg, orgSyncing, pathname, router]);

  // Unknown portal URL (e.g. a typo): bypass the auth gate entirely
  // so the catch-all's notFound() can render the 404 immediately.
  // Without this, Clerk auth hangs (or fails on a non-allowed
  // domain during local dev) and the user sees a permanent "Loading…"
  // skeleton instead of the 404. July 2026 ui-audit fix.
  if (loading && !isKnownPortalPath(pathname)) {
    return <>{children}</>;
  }
  if (loading) {
    // Show a chrome skeleton instead of a blank centred spinner so
    // the user can see the portal is rendering while Clerk and the
    // /auth/me call resolve. The skeleton has no clickable targets
    // (no nav, no buttons) so it doesn't conflict with the eventual
    // real chrome once Clerk loads. Replaces a prior "blank centred
    // spinner" that left the page feeling dead and unclickable.
    return (
      <div
        className="min-h-screen flex flex-col lg:flex-row bg-[var(--bg-secondary)]"
        aria-busy="true"
        aria-live="polite"
      >
        {/* Sidebar skeleton — visible structure while auth resolves. */}
        <aside
          className="sidebar flex flex-col relative bg-[var(--bg-primary)] border-r border-[var(--border-default)] z-50 h-full"
          style={{ width: SIDEBAR_EXPANDED_WIDTH }}
          aria-hidden="true"
        >
          <div className="flex items-center border-b border-[var(--border-default)] shrink-0 h-14 px-4 gap-2">
            <div className="w-9 h-9 bg-[var(--bg-tertiary)] rounded-lg relative overflow-hidden after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-[var(--shimmer)] after:to-transparent after:animate-[skeleton-shimmer_1.6s_infinite]" />
            <div className="h-3 w-20 bg-[var(--bg-tertiary)] rounded-md relative overflow-hidden after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-[var(--shimmer)] after:to-transparent after:animate-[skeleton-shimmer_1.6s_infinite]" />
          </div>
          <div className="flex-1 p-3 space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-8 bg-[var(--bg-tertiary)] rounded-md relative overflow-hidden after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-[var(--shimmer)] after:to-transparent after:animate-[skeleton-shimmer_1.6s_infinite]"
                style={{ width: `${70 + (i % 3) * 10}%` }}
              />
            ))}
          </div>
        </aside>

        {/* Main pane skeleton with status copy so the user knows
            the portal is loading their session, not stuck. */}
        <main className="flex-1 min-w-0 flex flex-col">
          <header className="h-14 border-b border-[var(--border-default)] bg-[var(--bg-primary)] flex items-center justify-between px-6">
            <div className="h-4 w-40 bg-[var(--bg-tertiary)] rounded-md relative overflow-hidden after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-[var(--shimmer)] after:to-transparent after:animate-[skeleton-shimmer_1.6s_infinite]" />
            <div className="h-8 w-8 bg-[var(--bg-tertiary)] rounded-lg relative overflow-hidden after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-[var(--shimmer)] after:to-transparent after:animate-[skeleton-shimmer_1.6s_infinite]" />
          </header>
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
              <p className="text-sm text-[var(--text-muted)]">Loading…</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  // Show a session-expired banner above the page if the Clerk session
  // is valid but the portal's /api/proxy/auth/me call failed (401).
  // Without this, every page stays in its loading skeleton because
  // `currentOrg` never resolves. June 2026 fix.
  const showAuthBanner = !loading && user && authError;
  const showOrgSyncingBanner = !loading && user && orgSyncing && !authError;

  const breadcrumbs = buildBreadcrumbs(pathname);
  const { pinnedItems, groups } = applySidebarPrefs(prefs, advancedCollapsed);

  return (
    // FIX-A: scroll the document natively instead of trapping content
    // in an internal overflow container. The previous `h-screen +
    // overflow-clip` row + `overflow-auto` on <main> was fragile —
    // any flex-sizing bug surfaced as "the page is unscrollable
    // and nothing is clickable" (the scroll wheel hit the trapped
    // container instead of the document, and clicks on the overlay
    // pseudo-elements were absorbed). Switching to a native
    // document scroll with `min-h-dvh` + row flex gives the
    // user the standard browser-scroll affordance everywhere, on
    // every viewport, with no special-casing for mobile bottom nav.
    // FIX-D: must be flex-row on lg+ so the sidebar sits beside
    // <main>, not stacked above it. flex-col on mobile so the
    // sidebar becomes the mobile drawer.
    // FIX-E: ``lg:items-start`` on the row — NOT the default
    // ``items-stretch``. With ``stretch``, both <aside> and <main>
    // resolve to the row's cross-axis size (``min-h-dvh``), and
    // content that's taller than the viewport OVERFLOWS <main> but
    // never grows the row. The document element stays at viewport
    // height, the html scroll container has nothing to scroll, and
    // users see a frozen page. With ``items-start``, the row's
    // cross-axis = max(child intrinsic sizes) = the tallest item's
    // natural height. <main>'s content grows the row, the body
    // grows, the html element scrolls. Sidebar keeps its own
    // ``lg:h-dvh`` so the chrome still fills the viewport on
    // short pages.
    <div className="min-h-dvh flex flex-col lg:flex-row lg:items-start bg-[var(--bg-secondary)]">
      {/* Skip-to-content link — visually hidden until focused, allows keyboard users to bypass the sidebar nav */}
      <a href="#main-content" className="skip-to-content">
        Skip to main content
      </a>
      {/* Mobile sidebar overlay — div (not button) so keyboard tab
       * skips it. aria-hidden + the existing CSS rule at globals.css:419-423
       * kill pointer-events for non-interactive overlays. */}
      {sidebarOpen && (
        <div
          role="presentation"
          aria-hidden="true"
          className="fixed inset-0 bg-[var(--bg-base)]/50 z-40 lg:hidden cursor-default"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar: fixed drawer on mobile, sticky in-flow on lg.
          Sticky (instead of fixed/h-full) lets the document scroll
          natively while the sidebar follows. The sidebar's own
          internal scroll handles the case where there are more
          nav items than fit in the viewport. */}
      <aside
        aria-label="Main sidebar navigation"
        className={cn(
          "sidebar flex flex-col relative bg-[var(--bg-primary)] border-r border-[var(--border-default)] z-40",
          "fixed inset-y-0 left-0 lg:sticky lg:top-0 lg:self-start lg:h-dvh lg:flex-shrink-0",
          collapsed ? "collapsed" : "",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          "transition-[transform,width] duration-300 ease-out lg:transition-[width]"
        )}
        style={{
          width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH }}
      >
        {/* Gradient overlay */}
        <div className="absolute inset-0 sidebar-gradient pointer-events-none" />

        {/* Brand header: real Eden logo + wordmark. FIX-H: collapse
            toggle is now a single, consistent icon button in the
            header row — same color, same position regardless of
            collapsed/expanded state. The previous version had THREE
            different collapse affordances (bottom-right "Collapse"
            text + gutter chevron + corner pill) with different colors
            and positions, which the user reported as confusing. */}
        <div
          className={cn(
            "relative flex items-center border-b border-[var(--border-default)] shrink-0 h-14",
            collapsed ? "justify-center px-0" : "justify-between gap-2 px-4",
          )}
        >
          <Link
            href="/dashboard"
            className="min-w-0 flex items-center hover:opacity-80 transition-opacity"
            aria-label="Eden home"
          >
            <Logo size="md" showWordmark={!collapsed} priority className="min-w-0" />
          </Link>
          {/* Single, consistent collapse/expand toggle. Always rendered
              on lg+; visible icon + ⌘B hint keeps the affordance
              discoverable without conflicting copy. */}
          <button
            onClick={handleCollapse}
            className={cn(
              "hidden md:flex items-center gap-1.5 px-2 py-1 rounded-md text-xs",
              "text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)]",
              "transition-colors",
            )}
            aria-label={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
            title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
          >
            {collapsed ? (
              <PanelLeftOpen className="w-3.5 h-3.5" />
            ) : (
              <PanelLeftClose className="w-3.5 h-3.5" />
            )}
            {!collapsed && <span>Collapse</span>}
            <kbd className="ml-1 px-1 py-0.5 bg-[var(--bg-base)] border border-[var(--border-default)] rounded text-[10px] font-mono text-[var(--text-muted)]">
              ⌘B
            </kbd>
          </button>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Organization switcher REMOVED — June 2026 UI overhaul.
            The active org still flows through Clerk + useOrg(), but
            the sidebar no longer surfaces an org logo/avatar (which
            looked like a second brand mark next to the Eden logo).
            Users reach org controls via Settings → Organization. */}

        {/* Navigation — data-driven from DEFAULT_SIDEBAR + user prefs
            (pinned / hidden / reordered). FIX-I: bounded max-height
            + internal scroll. The sidebar is `lg:sticky lg:h-screen`,
            so this nav gets `flex-1 min-h-0 overflow-y-auto` to take
            exactly the remaining viewport height (header + user
            section) and scroll internally. Without `min-h-0` the
            flex child refuses to shrink and the sidebar expands
            past the viewport. `overscroll-contain` keeps the
            wheel-chained scroll inside the sidebar from scrolling
            the document under it. Route discovery is via Cmd+K
            (header search / command palette) — no inline sidebar
            search. */}

        <nav
          className="relative flex-1 min-h-0 p-3 space-y-5 overflow-y-auto overscroll-contain"
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
                  description={item.description}
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
                    description={item.description}
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
                        description={child.description}
                        onClick={() => setSidebarOpen(false)}
                      />
                    ))}
                  </NavItem>
                );
              })}
            </NavGroup>
          ))}

          {!collapsed && (
            <>
              <Link
                href="/settings?tab=sidebar"
                className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
              >
                Customize sidebar
              </Link>
              <button
                onClick={toggleAdvanced}
                aria-pressed={!advancedCollapsed}
                className="flex items-center justify-between gap-2 px-3 py-1.5 mt-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                title={advancedCollapsed ? "Show advanced surfaces" : "Hide advanced surfaces"}
              >
                <span>{advancedCollapsed ? "Show advanced" : "Hide advanced"}</span>
                <span
                  className={cn(
                    "w-7 h-3.5 rounded-full p-0.5 transition-colors",
                    advancedCollapsed ? "bg-[var(--bg-tertiary)]" : "bg-[var(--accent)]"
                  )}
                >
                  <span
                    className={cn(
                      "block w-2.5 h-2.5 rounded-full bg-white transition-transform",
                      advancedCollapsed ? "translate-x-0" : "translate-x-3.5"
                    )}
                  />
                </span>
              </button>
            </>
          )}
        </nav>

        {/* User section — shrink-0 + mt-auto keeps it pinned to the
            bottom of the aside even when the nav is short on items.
            When collapsed, the avatar is centred so it sits under the
            centered logo (visual symmetry). The dropdown is the same
            either way — width is independent of collapse. */}
        <div className="relative mt-auto p-3 border-t border-[var(--border-default)] shrink-0">
          <div ref={userDropdownRef} className="relative">
            <button
              onClick={() => setUserDropdownOpen(!userDropdownOpen)}
              className={cn(
                "w-full flex items-center gap-3 p-2 rounded-lg transition-colors",
                collapsed && "justify-center",
                userDropdownOpen
                  ? "bg-[var(--accent-light)]"
                  : "hover:bg-[var(--bg-tertiary)]"
              )}
              aria-expanded={userDropdownOpen}
              aria-haspopup="true"
              aria-label="User menu"
              title={collapsed ? `${user.name} · ${user.email}` : undefined}
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

      {/* Main content — flex-1 takes remaining width; document scrolls
          natively (no internal overflow). The mobile bottom nav
          reserves bottom padding (pb-20) on small screens. ``min-h-0``
          is required on a flex-col child so the flex algorithm lets
          it shrink below its content height — without it the child
          grows to fit the page content and pushes the body past
          100dvh, breaking the document-scroll affordance. June 2026
          scroll-pass fix. */}
      <main id="main-content" className="flex-1 min-w-0 pb-20 lg:pb-0 flex flex-col" tabIndex={-1}>
        {/* Top bar */}
        <header className="sticky top-0 z-30 bg-[var(--bg-primary)] border-b border-[var(--border-default)]">
          <div className="flex items-center justify-between h-14 px-4 lg:px-6">
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
                  // Category prefix (e.g. "Observe · APM Tracing") on
                  // the last crumb — gives a stronger "you are here
                  // under X" cue than just the segment name.
                  const categoryPrefix =
                    isLast && crumb.category
                      ? `${crumb.category.charAt(0).toUpperCase()}${crumb.category.slice(1)} · `
                      : "";
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
                        <span className="font-medium text-[var(--text-primary)] truncate" title={categoryPrefix + crumb.label}>
                          {categoryPrefix && (
                            <span className="text-[var(--text-muted)] font-normal">{categoryPrefix}</span>
                          )}
                          {crumb.label}
                        </span>
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

            {/* Page-help hint — auto-renders an info chip on every
             *  portal page with a one-line "what is this for"
             *  tooltip. With ~30 routes the sidebar isn't enough
             *  context for a new user; this gives them an in-page
             *  way to learn the IA without clicking around. The
             *  component itself is a no-op for paths without a
             *  description in page-descriptions.ts. */}
            <div className="shrink-0 ml-2">
              <PageHelpHint />
            </div>

            {/* Right: Search + Notifications */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setCommandPaletteOpen(true)}
                className="hidden lg:flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--text-muted)] bg-[var(--bg-tertiary)] hover:bg-[var(--border-default)] rounded-lg transition-colors"
                title="Search (⌘K)"
              >
                <Search className="w-4 h-4" />
                <span className="text-xs">Search...</span>
                <kbd className="ml-2 px-1.5 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[var(--text-muted)] font-mono text-xs">⌘K</kbd>
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setCommandPaletteOpen(true)}
                    className="lg:hidden p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg active:bg-[var(--border-default)]"
                    aria-label="Search (⌘K)"
                  >
                    <Search className="w-5 h-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Search · <kbd className="font-mono">⌘K</kbd>
                </TooltipContent>
              </Tooltip>
              <NotificationsDropdown />
            </div>
          </div>
        </header>

        {/* Page content — content-sized wrapper. The previous
            ``flex-1 min-h-0`` here was the silent scroll killer:
            ``flex-1`` is ``flex: 1 1 0%`` — flex-basis 0% forces the
            wrapper's main-axis (height) to 0 inside a content-sized
            column (main is content-sized because the row uses
            ``lg:items-start``). Wrapper stays 0px tall, page content
            overflows but never grows main, main never grows the row,
            the document never grows past the viewport, and the user
            reports "scrolling doesn't work anywhere". Drop ``flex-1``
            so the wrapper sizes to its content; main then grows,
            the row grows, body grows, html scrolls natively.
            ``flex flex-col`` is retained because some pages
            (auth banner, error boundary) render multi-row stacks
            that benefit from a column flex parent. */}
        <div className="page-enter flex flex-col">
          {/* D.14 cold-start UX banner — renders nothing for legacy
              orgs (created before 2026-07-01) or once onboarding is
              complete. Best-effort: an API failure just hides it. */}
          <OnboardingBanner />
          {/* ErrorBoundary isolates render-time failures inside the
              page so a single bad component doesn't crash the entire
              portal chrome (sidebar + header stay usable, the user
              can navigate to a working page). Without this, an
              unhandled error in any nested component unmounts the
              whole <main> — including the retry banner that would
              otherwise let the user escape the broken state. */}
          <ErrorBoundary
            fallback={
              <div className="flex-1 flex items-center justify-center p-8 text-center">
                <div className="max-w-md space-y-3">
                  <p className="text-sm text-[var(--text-secondary)]">
                    This page hit an unexpected error. The rest of the
                    portal is still usable — try a different section
                    from the sidebar, or reload the page.
                  </p>
                </div>
              </div>
            }
          >
          {showOrgSyncingBanner && (
            <div
              role="status"
              className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 bg-[var(--bg-primary)] border-b border-[var(--border-default)] text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Loader2 className="w-4 h-4 text-[var(--accent)] shrink-0 animate-spin" />
                <span className="text-[var(--text-secondary)] truncate">
                  Syncing your workspace from Clerk…
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Link
                  href="/onboarding"
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:underline"
                >
                  Setup wizard
                </Link>
                <button
                  onClick={() => void refreshOrgs()}
                  aria-label="Refresh workspace sync"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[var(--border-default)] text-[var(--text-secondary)] rounded-md text-xs font-medium hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  Refresh
                </button>
              </div>
            </div>
          )}
          {showAuthBanner && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 bg-[var(--error-dim)] border-b border-[var(--error)]/30 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle className="w-4 h-4 text-[var(--error)] shrink-0" />
                <span className="text-[var(--error)] truncate">
                  {authError ?? "Session expired. Please sign in again."}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => {
                    void (async () => {
                      clearAuthError();
                      await refreshUserWithRetry();
                      await refreshOrgs();
                    })();
                  }}
                  aria-label="Retry loading session"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[var(--error)]/40 text-[var(--error)] rounded-md text-xs font-medium hover:bg-[var(--error)]/10 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  Retry
                </button>
                <button
                  onClick={() => {
                    router.push("/sign-in");
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--error)] text-[var(--bg-base)] rounded-md text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  Sign in
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
          {children}
          </ErrorBoundary>
        </div>

        {/* Mobile bottom navigation. Centered "Observe" item is the
            raised/pill style via `isCenter`; pb-safe gives the bar
            enough breathing room for notched phones. */}
        <nav
          className="lg:hidden fixed bottom-0 left-0 right-0 bg-[var(--bg-primary)] border-t border-[var(--border-default)] z-40 pb-[env(safe-area-inset-bottom)]"
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { notifications, unreadCount, error, markAsRead, markAllAsRead, deleteNotification, refresh: refreshNotifications } = useNotifications();

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

  // Escape closes; returns focus to the bell so keyboard users land
  // somewhere predictable.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
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
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "p-2 rounded-lg transition-colors relative",
          open
            ? "bg-[var(--accent-light)] text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
        )}
        aria-label="Notifications"
        aria-haspopup="menu"
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
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-80 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-lg z-50 overflow-hidden"
        >
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
            {error && notifications.length === 0 ? (
              <div className="text-center py-8 px-4 space-y-3">
                <p className="text-sm text-[var(--error)]">{error}</p>
                <button
                  type="button"
                  onClick={() => void refreshNotifications()}
                  className="text-xs text-[var(--accent)] hover:underline font-medium"
                >
                  Retry
                </button>
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

function isActivePath(pathname: string, href: string, search?: string): boolean {
  if (!pathname || !href) return false;
  const [pathOnly, queryPart] = href.split("?", 2);
  // Dashboard is treated as the root — only matches the exact path,
  // never its sub-pages (otherwise /dashboard would stay highlighted
  // while you're on /dashboard/something).
  if (pathOnly === "/dashboard") return pathname === "/dashboard";
  const pathMatch =
    pathname === pathOnly || pathname.startsWith(pathOnly + "/");
  if (!pathMatch) return false;
  if (!queryPart) return true;
  const expectedTab = new URLSearchParams(queryPart).get("tab");
  if (!expectedTab) return true;
  return new URLSearchParams(search || "").get("tab") === expectedTab;
}

function NavSubItem({
  href,
  label,
  description,
  onClick }: {
  href: string;
  label: string;
  /** One-line "what is this" hint shown in the hover tooltip.
   *  Sub-items in the sidebar are advanced surfaces (APM tracing,
   *  Retrieval, Decisions) that most users don't recognise from
   *  the icon alone. */
  description?: string;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = !isExternalHref(href) && isActivePath(pathname, href, searchParams.toString());
  const link = (
    <PortalNavLink
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
    </PortalNavLink>
  );
  if (!description) return link;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={6} className="max-w-[240px]">
        <div className="font-medium text-[var(--text-primary)]">{label}</div>
        <div className="mt-0.5 text-xs text-[var(--text-secondary)] leading-snug">
          {description}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function NavItem({
  href,
  icon: Icon,
  label,
  description,
  collapsed,
  onClick,
  children,
  badge,
  pinned,
  onTogglePin }: {
  href: string;
  icon: typeof LayoutDashboard;
  label: string;
  /** One-line "what is this" hint shown in the tooltip on hover.
   *  Critical for navigation clarity — the sidebar has ~30 routes
   *  and many icons look identical at small sizes (Brain, Sparkles,
   *  Compass). A short hover hint tells the user which is which. */
  description?: string;
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
  const searchParams = useSearchParams();
  const external = isExternalHref(href);
  const active = !external && isActivePath(pathname, href, searchParams.toString());
  const hasChildren = !collapsed && children;

  return (
    <div className="group/navitem relative">
      {(() => {
        const link = (
          <PortalNavLink
            href={href}
            onClick={onClick}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            showExternalIcon={external && !collapsed}
            className={cn(
              "nav-item flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-150 relative",
              active
                ? "font-semibold text-[var(--accent)] bg-[var(--accent-light)] opacity-100"
                : "font-medium text-[var(--text-secondary)] opacity-60 hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] hover:opacity-100"
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
                      "pin-button p-1 rounded transition-all",
                      pinned
                        ? "text-[var(--accent)] opacity-100"
                        : "text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
                    )}
                    title={pinned ? "Unpin from sidebar" : "Pin to top of sidebar"}
                  >
                    <Pin className={cn("w-3.5 h-3.5", pinned && "fill-current")} />
                  </button>
                )}
              </>
            )}
          </PortalNavLink>
        );
        // Tooltip with description is shown even when the sidebar is
        // expanded — the label alone ("Traces", "Insights", "Tools")
        // doesn't tell the user what the page does. The description
        // keeps the same one-line voice as the IA comments in
        // sidebar-config.ts so the user can scan the whole nav
        // without clicking into each page. Collapsed and expanded
        // both get the rich tooltip; expanded just renders the
        // label inline as well so the user can scan the rail fast.
        const richTooltip = description ? (
          <TooltipContent side="right" sideOffset={8} className="max-w-[260px]">
            <div className="font-medium text-[var(--text-primary)]">{label}</div>
            <div className="mt-0.5 text-xs text-[var(--text-secondary)] leading-snug">
              {description}
            </div>
          </TooltipContent>
        ) : (
          <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
        );
        const tooltipNode = (
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            {richTooltip}
          </Tooltip>
        );
        if (collapsed) return tooltipNode;
        return tooltipNode;
      })()}
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
  isCenter }: {
  href: string;
  icon: typeof Home;
  label: string;
  isCenter?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = isActivePath(pathname, href, searchParams.toString());

  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center justify-center min-w-[44px] min-h-[44px] gap-1 transition-colors relative",
        isCenter && "relative -mt-3",
        active ? "text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      )}
    >
      {active && !isCenter && (
        <span
          aria-hidden="true"
          className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-[var(--accent)]"
        />
      )}
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
  children }: {
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
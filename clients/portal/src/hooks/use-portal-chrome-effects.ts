"use client";

/**
 * Portal chrome side-effects extracted from portal-chrome.tsx (Wave 11.10).
 * Keeps the orchestrator ≤400 LOC — keyboard, tour, drawer trap, orgless gate.
 */

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  COLLAPSE_STORAGE_KEY,
  readCollapsedPreference,
} from "@/components/portal-chrome";
import {
  readAdvancedCollapsed,
  writeAdvancedCollapsed,
} from "@/hooks/use-sidebar-prefs";
import { CHROME_BANNER_ATTR } from "@/lib/overlay-defer";

export function usePortalChromeCollapse() {
  const [collapsed, setCollapsed] = useState(false);
  const [advancedCollapsed, setAdvancedCollapsed] = useState(true);
  const [collapseHydrated, setCollapseHydrated] = useState(false);

  useEffect(() => {
    setCollapsed(readCollapsedPreference());
    setAdvancedCollapsed(readAdvancedCollapsed());
    setCollapseHydrated(true);
  }, []);

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

  const toggleAdvanced = useCallback(() => {
    setAdvancedCollapsed((prev) => {
      const next = !prev;
      writeAdvancedCollapsed(next);
      return next;
    });
  }, []);

  const handleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  return {
    collapsed,
    setCollapsed,
    advancedCollapsed,
    setAdvancedCollapsed,
    toggleAdvanced,
    handleCollapse,
  };
}

export function usePortalChromeNarrowViewport() {
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const sync = () => setIsNarrowViewport(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return isNarrowViewport;
}

export function usePortalChromeTour(opts: {
  setCollapsed: Dispatch<SetStateAction<boolean>>;
  setAdvancedCollapsed: Dispatch<SetStateAction<boolean>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const [tourSpotlightActive, setTourSpotlightActive] = useState(false);
  const { setCollapsed, setAdvancedCollapsed, setSidebarOpen } = opts;

  useEffect(() => {
    function onTourOpen() {
      setCollapsed(false);
      setAdvancedCollapsed(false);
      setSidebarOpen(true);
      setTourSpotlightActive(true);
    }
    function onTourEnd() {
      setTourSpotlightActive(false);
    }
    window.addEventListener("eden:product-tour", onTourOpen);
    window.addEventListener("eden:product-tour-end", onTourEnd);
    return () => {
      window.removeEventListener("eden:product-tour", onTourOpen);
      window.removeEventListener("eden:product-tour-end", onTourEnd);
    };
  }, [setCollapsed, setAdvancedCollapsed, setSidebarOpen]);

  return tourSpotlightActive;
}

export function usePortalChromeShortcuts(opts: {
  sidebarOpen: boolean;
  closeMobileDrawer: () => void;
  setCollapsed: Dispatch<SetStateAction<boolean>>;
  setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const {
    sidebarOpen,
    closeMobileDrawer,
    setCollapsed,
    setCommandPaletteOpen,
  } = opts;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (e.key === "j" && (e.metaKey || e.ctrlKey) && !isFormField) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("eden:toggle-ai-chat"));
        return;
      }
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }
      if (e.key === "Escape" && sidebarOpen && !isFormField) {
        e.preventDefault();
        closeMobileDrawer();
        return;
      }
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
  }, [sidebarOpen, closeMobileDrawer, setCollapsed, setCommandPaletteOpen]);
}

export function usePortalChromeMobileDrawerTrap(opts: {
  mobileDrawerOpen: boolean;
  sidebarAsideRef: RefObject<HTMLElement | null>;
  sidebarCloseRef: RefObject<HTMLButtonElement | null>;
}) {
  const { mobileDrawerOpen, sidebarAsideRef, sidebarCloseRef } = opts;

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    sidebarCloseRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const root = sidebarAsideRef.current;
    function onTabTrap(e: KeyboardEvent) {
      if (e.key !== "Tab" || !root) return;
      const nodes = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onTabTrap);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onTabTrap);
    };
  }, [mobileDrawerOpen, sidebarAsideRef, sidebarCloseRef]);
}

export function usePortalChromeAuthGate(opts: {
  user: unknown;
  loading: boolean;
  orgLoading: boolean;
  currentOrg: unknown;
  orgSyncing: boolean;
  authErrorKind: string | null | undefined;
  userOrgCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    user,
    loading,
    orgLoading,
    currentOrg,
    orgSyncing,
    authErrorKind,
    userOrgCount,
  } = opts;

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/sign-in");
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (loading || orgLoading || !user || currentOrg) return;
    if (orgSyncing || authErrorKind === "session") return;
    if (userOrgCount > 0) return;
    const path = pathname || "";
    const isOrglessFriendly =
      path.startsWith("/invite") ||
      path === "/settings" ||
      path.startsWith("/settings/") ||
      path.startsWith("/login") ||
      path.startsWith("/sign-in") ||
      path.startsWith("/sign-up");
    if (!isOrglessFriendly) {
      router.replace("/settings?tab=org");
    }
  }, [
    loading,
    orgLoading,
    user,
    currentOrg,
    orgSyncing,
    authErrorKind,
    pathname,
    router,
    userOrgCount,
  ]);
}

export function usePortalChromeBannerAttr(blockingChromeBanner: boolean) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (blockingChromeBanner) {
      document.documentElement.setAttribute(CHROME_BANNER_ATTR, "1");
    } else {
      document.documentElement.removeAttribute(CHROME_BANNER_ATTR);
    }
    return () => {
      document.documentElement.removeAttribute(CHROME_BANNER_ATTR);
    };
  }, [blockingChromeBanner]);
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type SidebarCtx = {
  collapsed: boolean;
  setCollapsed: (v: boolean | ((c: boolean) => boolean)) => void;
  toggle: () => void;
  /** True only after stored width is applied — safe to animate width changes. */
  animate: boolean;
  ready: boolean;
};

const SidebarContext = createContext<SidebarCtx | null>(null);

function readBool(key: string, fallback: boolean) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  // Server and first client paint always match (expanded default).
  // Stored preference is applied in useLayoutEffect before paint — no hydration mismatch,
  // and animate stays false so the restore never plays a close animation.
  const [collapsed, setCollapsedState] = useState(false);
  const [ready, setReady] = useState(false);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    setCollapsedState(readBool("eden.nav.collapsed", false));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setAnimate(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [ready]);

  const setCollapsed = useCallback((v: boolean | ((c: boolean) => boolean)) => {
    setCollapsedState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try {
        localStorage.setItem("eden.nav.collapsed", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const toggle = useCallback(() => setCollapsed((c) => !c), [setCollapsed]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = useMemo(
    () => ({ collapsed, setCollapsed, toggle, animate, ready }),
    [collapsed, setCollapsed, toggle, animate, ready],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
  return ctx;
}

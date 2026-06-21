"use client";

/**
 * useSidebarPrefs — per-user sidebar customisations.
 *
 * The customisations live in three buckets:
 *   1. **pinned**     — item ids that should appear in a "📌 Pinned" section
 *                       above the groups
 *   2. **hidden**     — item ids that should be removed entirely
 *   3. **groupOrder** — the order of the 5 top-level groups
 *
 * The data is loaded from the FastAPI backend (per-user, per-org) and
 * cached in `sessionStorage` for instant render on hard reload. Writes
 * are debounced 1 second so rapid drag/drop doesn't spam the API.
 *
 * If the backend is unreachable we fall back to defaults — the sidebar
 * still works, the user just doesn't see their customisations until the
 * API recovers. (Customisations are non-critical UI state.)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { DEFAULT_SIDEBAR, type SidebarGroup } from "@/lib/sidebar-config";

export type Density = "comfortable" | "compact";

export interface SidebarPrefs {
  pinned: string[];
  hidden: string[];
  groupOrder: SidebarGroup["id"][];
  density: Density;
}

export const DEFAULT_PREFS: SidebarPrefs = {
  pinned: [],
  hidden: [],
  groupOrder: ["build", "observe", "optimize", "automate", "admin"],
  density: "comfortable",
};

// ponytail: Advanced-collapse is a UI-only toggle (localStorage). Not
// persisted to the backend because it's a "show less" affordance, not
// a real per-org preference — most users want the same default everywhere.
const ADVANCED_KEY = "eden:sidebar:advanced-collapsed";

export function readAdvancedCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAdvancedCollapsed(v: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ADVANCED_KEY, v ? "1" : "0");
  } catch {
    // non-fatal
  }
}

const STORAGE_PREFIX = "eden:sidebar-prefs:";
const SAVE_DEBOUNCE_MS = 1000;

/** Wire format used by the FastAPI backend. */
interface ApiSidebarPrefs {
  pinned: string[];
  hidden: string[];
  group_order: string[];
  density: "comfortable" | "compact";
}

function toApiPrefs(p: SidebarPrefs): ApiSidebarPrefs {
  return {
    pinned: p.pinned,
    hidden: p.hidden,
    group_order: p.groupOrder,
    density: p.density,
  };
}

function fromApiPrefs(p: ApiSidebarPrefs | null): SidebarPrefs {
  if (!p) return DEFAULT_PREFS;
  return {
    pinned: Array.isArray(p.pinned) ? p.pinned : [],
    hidden: Array.isArray(p.hidden) ? p.hidden : [],
    groupOrder: Array.isArray(p.group_order) && p.group_order.length === 5
      ? (p.group_order as SidebarGroup["id"][])
      : DEFAULT_PREFS.groupOrder,
    density: p.density === "compact" ? "compact" : "comfortable",
  };
}

function readCached(orgId: string | null | undefined): SidebarPrefs | null {
  if (!orgId) return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + orgId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    return {
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned : DEFAULT_PREFS.pinned,
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : DEFAULT_PREFS.hidden,
      groupOrder: Array.isArray(parsed.groupOrder) && parsed.groupOrder.length === 5
        ? (parsed.groupOrder as SidebarGroup["id"][])
        : DEFAULT_PREFS.groupOrder,
      density: parsed.density === "compact" ? "compact" : "comfortable",
    };
  } catch {
    return null;
  }
}

function writeCached(orgId: string, prefs: SidebarPrefs) {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + orgId, JSON.stringify(prefs));
  } catch {
    // sessionStorage may be full or disabled — non-fatal.
  }
}

export interface UseSidebarPrefs {
  prefs: SidebarPrefs;
  ready: boolean;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  togglePin: (id: string) => void;
  hide: (id: string) => void;
  show: (id: string) => void;
  reorderGroups: (from: number, to: number) => void;
  reset: () => void;
  setDensity: (d: Density) => void;
  /** True while a server write is in flight. */
  saving: boolean;
}

export function useSidebarPrefs(): UseSidebarPrefs {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;

  // Hydrate from sessionStorage on mount, then from server.
  const [prefs, setPrefs] = useState<SidebarPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!orgId) {
      setPrefs(DEFAULT_PREFS);
      setReady(true);
      return;
    }
    const cached = readCached(orgId);
    if (cached) setPrefs(cached);
    setReady(false);
    (async () => {
      try {
        const res = await api.getSidebarPrefs(orgId);
        if (cancelled) return;
        if (res) setPrefs(fromApiPrefs(res));
        writeCached(orgId, fromApiPrefs(res));
      } catch {
        // tolerate — fall back to cached or defaults.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Debounced write back to the API + sessionStorage.
  const queueSave = useCallback(
    (next: SidebarPrefs) => {
      if (!orgId) return;
      writeCached(orgId, next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaving(true);
        try {
          await api.setSidebarPrefs(orgId, toApiPrefs(next));
        } catch {
          // tolerate — sessionStorage still has the latest.
        } finally {
          setSaving(false);
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [orgId]
  );

  const update = useCallback(
    (updater: (prev: SidebarPrefs) => SidebarPrefs) => {
      setPrefs((prev) => {
        const next = updater(prev);
        queueSave(next);
        return next;
      });
    },
    [queueSave]
  );

  return useMemo(
    () => ({
      prefs,
      ready,
      saving,
      pin: (id) => update((p) => ({ ...p, pinned: Array.from(new Set([...p.pinned, id])) })),
      unpin: (id) => update((p) => ({ ...p, pinned: p.pinned.filter((x) => x !== id) })),
      togglePin: (id) =>
        update((p) => ({
          ...p,
          pinned: p.pinned.includes(id) ? p.pinned.filter((x) => x !== id) : [...p.pinned, id],
        })),
      hide: (id) => update((p) => ({ ...p, hidden: Array.from(new Set([...p.hidden, id])) })),
      show: (id) => update((p) => ({ ...p, hidden: p.hidden.filter((x) => x !== id) })),
      reorderGroups: (from, to) =>
        update((p) => {
          const next = [...p.groupOrder];
          const [moved] = next.splice(from, 1);
          if (moved) next.splice(to, 0, moved);
          return { ...p, groupOrder: next };
        }),
      setDensity: (d) => update((p) => ({ ...p, density: d })),
      reset: () => update(() => DEFAULT_PREFS),
    }),
    [prefs, ready, saving, update]
  );
}

/**
 * Apply prefs to the default sidebar config. Returns the ordered groups
 * with hidden items removed, ready to render. Items flagged
 * `category: "advanced"` in the config are filtered out when
 * `advancedCollapsed` is true — they reappear when expanded.
 */
export function applySidebarPrefs(
  prefs: SidebarPrefs,
  advancedCollapsed = false
): { pinnedItems: SidebarGroup["items"][number][]; groups: SidebarGroup[] } {
  const byId = new Map<string, SidebarItemWithGroup>();
  for (const group of DEFAULT_SIDEBAR) {
    for (const item of group.items) {
      byId.set(item.id, { ...item, _groupId: group.id });
      if (item.children) {
        for (const child of item.children) byId.set(child.id, { ...child, _groupId: group.id });
      }
    }
  }

  const isHidden = (id: string) => prefs.hidden.includes(id);
  const isAdvancedHidden = (id: string) => {
    if (!advancedCollapsed) return false;
    const item = byId.get(id);
    return item?.category === "advanced";
  };
  const keepItem = (id: string) => !isHidden(id) && !isAdvancedHidden(id);

  const filtered = DEFAULT_SIDEBAR.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => keepItem(item.id))
      .map((item) =>
        item.children
          ? {
              ...item,
              children: item.children.filter((c) => keepItem(c.id)),
              // If every child is hidden, drop the parent too.
            }
          : item
      )
      // Parent items with all children hidden: hide the parent.
      .filter((item) => {
        if (item.children && item.children.length === 0) return false;
        return true;
      }),
  }));

  const ordered: SidebarGroup[] = prefs.groupOrder
    .map((id) => filtered.find((g) => g.id === id))
    .filter((g): g is SidebarGroup => Boolean(g));

  const pinnedItems = prefs.pinned
    .map((id) => byId.get(id))
    .filter(
      (item): item is SidebarItemWithGroup =>
        Boolean(item) && keepItem(item!.id)
    );

  return { pinnedItems, groups: ordered };
}

type SidebarItemWithGroup = SidebarGroup["items"][number] & { _groupId: string };

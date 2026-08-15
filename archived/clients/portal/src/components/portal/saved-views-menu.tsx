"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, ChevronDown, Trash2 } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import {
  savedSearchesApi,
  type SavedSearch,
} from "@/lib/api/resources";
import { cn } from "@/lib/utils";

// F58 — Saved table views. Backed by the real saved-searches CRUD API
// (`/orgs/{org}/saved-searches`, sharing.py). A "view" is the current
// filter + column URL query-string, stored as query_type "text" with the
// owning page recorded in `params.path` + a `tags` entry so the org-wide
// saved-search list can be filtered back down to just this surface.
// Per-user by default; `is_shared` opts a view into the org-shared list.

type ViewScope = "personal" | "shared";

/** Views whose `params.path` (or tag) matches this page. */
function viewsForPath(views: SavedSearch[], path: string): SavedSearch[] {
  return views.filter((v) => {
    const p = (v.params as { path?: unknown })?.path;
    if (typeof p === "string") return p === path;
    return v.tags.includes(path);
  });
}

export function SavedViewsMenu({
  className,
  label = "Views",
}: {
  className?: string;
  label?: string;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const currentQuery = searchParams.toString();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const personalKey = useMemo(
    () => ["portal", "savedSearches", orgId, "personal"] as const,
    [orgId],
  );
  const sharedKey = useMemo(
    () => ["portal", "savedSearches", orgId, "shared"] as const,
    [orgId],
  );

  const personalQuery = useOrgQuery(
    personalKey,
    orgId,
    () => savedSearchesApi.list(orgId!, "personal"),
    { enabled: open },
  );
  const sharedQuery = useOrgQuery(
    sharedKey,
    orgId,
    () => savedSearchesApi.list(orgId!, "shared"),
    { enabled: open },
  );

  const personalViews = useMemo(
    () => viewsForPath(personalQuery.data?.searches ?? [], pathname),
    [personalQuery.data, pathname],
  );
  const sharedViews = useMemo(
    () => viewsForPath(sharedQuery.data?.searches ?? [], pathname),
    [sharedQuery.data, pathname],
  );

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: personalKey }),
      queryClient.invalidateQueries({ queryKey: sharedKey }),
    ]);
  }, [queryClient, personalKey, sharedKey]);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const applyView = useCallback(
    (view: SavedSearch) => {
      router.replace(view.query ? `${pathname}?${view.query}` : pathname, {
        scroll: false,
      });
      setOpen(false);
      if (orgId) void savedSearchesApi.recordUse(orgId, view.id).catch(() => {});
    },
    [router, pathname, orgId],
  );

  const saveCurrent = useCallback(async () => {
    if (!orgId || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await savedSearchesApi.create(orgId, {
        name: name.trim(),
        query_type: "text",
        query: currentQuery,
        params: { path: pathname },
        is_shared: shared,
        tags: [pathname],
      });
      setName("");
      setShared(false);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save view.");
    } finally {
      setBusy(false);
    }
  }, [orgId, name, currentQuery, pathname, shared, invalidate]);

  const removeView = useCallback(
    async (view: SavedSearch) => {
      if (!orgId) return;
      try {
        await savedSearchesApi.remove(orgId, view.id);
        await invalidate();
      } catch {
        /* keep menu open; surfaced via list not refreshing */
      }
    },
    [orgId, invalidate],
  );

  if (!orgId) return null;

  const renderList = (views: SavedSearch[], scope: ViewScope) => {
    if (views.length === 0) {
      return (
        <p className="type-meta px-3 py-2 text-[var(--text-faint)]">
          {scope === "shared" ? "No shared views." : "No saved views yet."}
        </p>
      );
    }
    return (
      <ul role="list" aria-label={`${scope} views`}>
        {views.map((view) => {
          const active = view.query === currentQuery;
          return (
            <li key={view.id} className="flex items-center gap-1 px-1">
              <button
                type="button"
                onClick={() => applyView(view)}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-[var(--radius)] px-2 py-1.5 text-left type-ui hover:bg-[var(--accent-muted)]",
                  active && "text-[var(--accent)]",
                )}
                title={view.query || "(no filters)"}
              >
                {view.name}
              </button>
              {scope === "personal" ? (
                <button
                  type="button"
                  onClick={() => void removeView(view)}
                  className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
                  aria-label={`Delete view ${view.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <BookmarkPlus className="h-3.5 w-3.5" />
        {label}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-[60] mt-1 w-72 rounded-[var(--radius-lg)] bg-[var(--bg)] p-2 shadow-[0_0_0_1px_var(--line),0_12px_32px_-12px_var(--scrim)]"
        >
          <p className="type-label px-3 pt-1 pb-1.5">Saved</p>
          {renderList(personalViews, "personal")}
          {sharedViews.length > 0 ? (
            <>
              <p className="type-label px-3 pt-2 pb-1.5">Shared</p>
              {renderList(sharedViews, "shared")}
            </>
          ) : null}

          <div className="mt-2 border-t border-[var(--line)] pt-2">
            <div className="flex items-center gap-2 px-1">
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveCurrent();
                  }
                }}
                placeholder="Save current view…"
                aria-label="Save current view name"
                className="ds-input h-8 min-w-0 flex-1 !text-[0.8125rem]"
              />
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm shrink-0"
                disabled={busy || !name.trim()}
                onClick={() => void saveCurrent()}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
            <label className="mt-1.5 flex items-center gap-2 px-2 type-meta text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              Share with workspace
            </label>
            {error ? (
              <p className="type-meta px-2 pt-1 text-[var(--error)]" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

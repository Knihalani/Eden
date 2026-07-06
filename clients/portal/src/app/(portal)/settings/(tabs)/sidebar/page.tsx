"use client";

/**
 * /settings?tab=sidebar — Sidebar customisation editor.
 *
 * Lets the user:
 *   • Pin / unpin any item (pinned items appear in a top "📌 Pinned" section)
 *   • Show / hide any item (hidden items are removed from the sidebar)
 *   • Reorder the 5 top-level groups
 *   • Toggle density (comfortable / compact)
 *   • Reset to default
 *
 * Phase 1 of the June 2026 UI overhaul. Drag-to-reorder and right-click
 * context menus are deferred to a follow-up — the pin/unpin + show/hide
 * + reset affordances are enough for the first ship.
 */

import Link from "next/link";
import { useState } from "react";
import { Eye, EyeOff, Pin, PinOff, RotateCcw, Settings2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { useSidebarPrefs, applySidebarPrefs, DEFAULT_PREFS } from "@/hooks/use-sidebar-prefs";
import { ALL_ITEM_IDS, DEFAULT_SIDEBAR, type SidebarGroup } from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { NoOrgState } from "@/components/ui/no-org-state";

export default function SidebarSettingsPage() {
  const { currentOrg } = useOrg();
  const { prefs, pin, unpin, hide, show, reorderGroups, setDensity, reset, saving } = useSidebarPrefs();
  const { pinnedItems, groups } = applySidebarPrefs(prefs);

  // Local "reorder groups" buffer (commit on Save).
  const [draftOrder, setDraftOrder] = useState<SidebarGroup["id"][]>(prefs.groupOrder);
  const [reordering, setReordering] = useState(false);

  if (!currentOrg) return <NoOrgState feature="Sidebar settings" />;

  const isPinned = (id: string) => prefs.pinned.includes(id);
  const isHidden = (id: string) => prefs.hidden.includes(id);

  function moveGroup(from: number, to: number) {
    if (to < 0 || to >= draftOrder.length) return;
    const next = [...draftOrder];
    const [m] = next.splice(from, 1);
    if (m) next.splice(to, 0, m);
    setDraftOrder(next);
    setReordering(true);
  }

  function commitReorder() {
    // ponytail: reorderGroups(idx, idx) doesn't work because the array
    // is mutated atomically; we instead emit a single update with the
    // new order.
    // (useSidebarPrefs.reorderGroups is for one swap at a time; for a
    //  full reorder we mutate the prefs directly via the hook's
    //  update fn — but we don't have that exposed. So we use a
    //  small loop of swaps here.)
    let order = [...prefs.groupOrder];
    for (let i = 0; i < draftOrder.length; i++) {
      if (order[i] !== draftOrder[i]) {
        const fromIdx = order.indexOf(draftOrder[i]);
        reorderGroups(fromIdx, i);
        order = [...order];
        order.splice(fromIdx, 1);
        order.splice(i, 0, draftOrder[i]);
      }
    }
    setReordering(false);
  }

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Sidebar"
        subtitle="Customize the left nav — pin items you use often, hide what you don't, reorder groups"
        icon={Settings2}
        actions={
          <button
            onClick={() => {
              reset();
              setDraftOrder(DEFAULT_PREFS.groupOrder);
            }}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-muted)] bg-[var(--bg-tertiary)] hover:bg-[var(--border-default)] rounded-lg transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to default
          </button>
        }
      />
      <div className="px-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-8">
        {/* Density */}
        <section className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Density</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Make the sidebar more compact by reducing the item height and gap.
          </p>
          <div className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1">
            {(["comfortable", "compact"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDensity(d)}
                aria-pressed={prefs.density === d}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-md transition-colors",
                  prefs.density === d
                    ? "bg-[var(--bg-primary)] font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                )}
              >
                {d === "comfortable" ? "Comfortable" : "Compact"}
              </button>
            ))}
          </div>
        </section>

        {/* Pinned items */}
        <section className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Pinned items <span className="text-[var(--text-muted)] font-normal">({pinnedItems.length})</span>
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Pinned items appear in a &ldquo;📌 Pinned&rdquo; section above the groups.
          </p>
          {pinnedItems.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)] py-2">
              Nothing pinned yet. Use the pin button on any item below to add it.
            </p>
          ) : (
            <ul className="space-y-1">
              {pinnedItems.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between p-2 rounded-lg bg-[var(--bg-secondary)]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <item.icon className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                    <span className="text-sm text-[var(--text-primary)] truncate">{item.label}</span>
                  </div>
                  <button
                    onClick={() => unpin(item.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] rounded transition-colors"
                  >
                    <PinOff className="w-3.5 h-3.5" />
                    Unpin
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Group order */}
        <section className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Group order</h2>
            {reordering && (
              <button
                onClick={commitReorder}
                className="px-3 py-1 text-xs font-medium bg-[var(--accent)] text-[var(--accent-foreground)] rounded-md hover:bg-[var(--accent-hover)]"
              >
                Save order
              </button>
            )}
          </div>
          <ol className="space-y-1">
            {draftOrder.map((groupId, idx) => {
              const group = groups.find((g) => g.id === groupId);
              if (!group) return null;
              return (
                <li
                  key={groupId}
                  className="flex items-center justify-between p-2 rounded-lg bg-[var(--bg-secondary)]"
                >
                  <span className="text-sm text-[var(--text-primary)]">
                    <span className="text-[var(--text-muted)] mr-2">{idx + 1}.</span>
                    {group.label}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => moveGroup(idx, idx - 1)}
                      disabled={idx === 0}
                      aria-disabled={idx === 0}
                      className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30"
                      aria-label={`Move ${group.label} up`}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveGroup(idx, idx + 1)}
                      disabled={idx === draftOrder.length - 1}
                      aria-disabled={idx === draftOrder.length - 1}
                      className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30"
                      aria-label={`Move ${group.label} down`}
                    >
                      ↓
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        {/* All items — pin / hide toggles */}
        <section className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">All items</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Pin items to surface them at the top of the sidebar, or hide them entirely.
          </p>
          <ul className="space-y-1">
            {DEFAULT_SIDEBAR.flatMap((group) =>
              group.items.map((item) => {
                const pinned = isPinned(item.id);
                const hidden = isHidden(item.id);
                return (
                  <li
                    key={item.id}
                    className={cn(
                      "flex items-center justify-between p-2 rounded-lg border",
                      hidden
                        ? "bg-[var(--bg-secondary)]/40 border-[var(--border-subtle)] opacity-60"
                        : "bg-[var(--bg-secondary)] border-[var(--border-subtle)]"
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <item.icon className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm text-[var(--text-primary)] truncate">
                          {item.label}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                          {group.label}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => (pinned ? unpin(item.id) : pin(item.id))}
                        aria-pressed={pinned}
                        className={cn(
                          "p-1.5 rounded transition-colors",
                          pinned
                            ? "text-[var(--accent)] bg-[var(--accent-faint)]"
                            : "text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
                        )}
                        title={pinned ? "Unpin" : "Pin to top"}
                        aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
                      >
                        <Pin className={cn("w-3.5 h-3.5", pinned && "fill-current")} />
                      </button>
                      <button
                        onClick={() => (hidden ? show(item.id) : hide(item.id))}
                        aria-pressed={hidden}
                        className={cn(
                          "p-1.5 rounded transition-colors",
                          hidden
                            ? "text-[var(--error)] bg-[var(--error-dim)]"
                            : "text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-tertiary)]"
                        )}
                        title={hidden ? "Show in sidebar" : "Hide from sidebar"}
                        aria-label={hidden ? `Show ${item.label}` : `Hide ${item.label}`}
                      >
                        {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </section>

        {/* Live preview */}
        <section className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Live preview</h2>
          <p className="text-xs text-[var(--text-muted)]">
            This is what your sidebar will look like.
          </p>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg p-3 w-64 max-w-full">
            {pinnedItems.length > 0 && (
              <SidebarPreviewGroup label="Pinned" items={pinnedItems} />
            )}
            {groups.map((g) => (
              <SidebarPreviewGroup key={g.id} label={g.label} items={g.items} />
            ))}
          </div>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] hover:underline"
          >
            Open the dashboard to see your custom sidebar in action →
          </Link>
        </section>

        <p className="text-xs text-[var(--text-muted)] text-center">
          {saving ? "Saving…" : "Changes save automatically"}{" "}
          · {ALL_ITEM_IDS.length} total items
        </p>
      </div>
    </>
  );
}

function SidebarPreviewGroup({ label, items }: { label: string; items: { id: string; label: string; icon: typeof Settings2 }[] }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-[9px] font-mono uppercase tracking-[0.14em] text-[var(--text-muted)] px-2 mb-1">
        {label}
      </div>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-[var(--text-secondary)]"
          >
            <item.icon className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

"use client";

/**
 * /settings?tab=sidebar — Sidebar customisation editor.
 *
 * Pin / unpin, show / hide, reorder groups, density, reset.
 * Matches Wave 4 tonal-rail preview (no second Settings sidebar).
 */
import Link from "next/link";
import { useState, type ComponentType } from "react";
import { Eye, EyeOff, Pin, PinOff, RotateCcw, Settings2, AlertTriangle, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useSidebarPrefs, applySidebarPrefs, DEFAULT_PREFS } from "@/hooks/use-sidebar-prefs";
import { ALL_ITEM_IDS, DEFAULT_SIDEBAR, SIDEBAR_GROUP_LABELS, SIDEBAR_ITEM_LABELS, type SidebarGroup } from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface SidebarSettingsPageProps {
  /** When true, render body only (embedded in Settings tab rail). */
  embedded?: boolean;
}

export function SidebarSettingsView({ embedded = false }: SidebarSettingsPageProps) {
  const {
    currentOrg
  } = useOrg();
  const {
    prefs,
    pin,
    unpin,
    hide,
    show,
    reorderGroups,
    setDensity,
    reset,
    saving,
    saveError,
    retrySave,
  } = useSidebarPrefs();
  const {
    pinnedItems,
    groups
  } = applySidebarPrefs(prefs);

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
  const resetButton = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => {
        reset();
        setDraftOrder(DEFAULT_PREFS.groupOrder);
      }}
    >
      <RotateCcw className="w-3.5 h-3.5" />
      Reset to default
    </Button>
  );

  const body = <div className="space-y-8">
        <Card padding="lg" as="section" className="space-y-space-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Density</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Compact reduces item height and gap on the tonal rail.
          </p>
          <div
            className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1"
            role="group"
            aria-label="Density"
            data-testid="density-toggle"
            data-wave11-density="toggle"
          >
            {(["comfortable", "compact"] as const).map(d => (
              <Button
                key={d}
                type="button"
                variant={prefs.density === d ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setDensity(d)}
                aria-pressed={prefs.density === d}
                className="min-h-11"
              >
                {d === "comfortable" ? "Comfortable" : "Compact"}
              </Button>
            ))}
          </div>
        </Card>

        <Card padding="lg" as="section" className="space-y-space-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Pinned items <span className="text-[var(--text-muted)] font-normal">({pinnedItems.length})</span>
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Pinned items appear in a quiet section above the groups.
          </p>
          {pinnedItems.length === 0 ? <p className="text-sm text-[var(--text-muted)] py-2">
              Nothing pinned yet. Use the pin control on any item below.
            </p> : <ul className="space-y-1">
              {pinnedItems.map(item => <li key={item.id} className="flex items-center justify-between p-2 rounded-md bg-[var(--bg-secondary)]">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <item.icon className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                    <span className="text-sm text-[var(--text-primary)] truncate">{SIDEBAR_ITEM_LABELS[item.id] ?? item.id}</span>
                  </div>
                  <button type="button" onClick={() => unpin(item.id)} className="inline-flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] rounded transition-colors">
                    <PinOff className="w-3.5 h-3.5" />
                    Unpin
                  </button>
                </li>)}
            </ul>}
        </Card>

        <Card padding="lg" as="section" className="space-y-space-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Group order</h2>
            {reordering && (
              <Button variant="default" size="sm" onClick={commitReorder}>
                Save order
              </Button>
            )}
          </div>
          <ol className="space-y-1">
            {draftOrder.map((groupId, idx) => {
            const group = groups.find(g => g.id === groupId);
            if (!group) return null;
            return <li key={groupId} className="flex items-center justify-between p-2 rounded-md bg-[var(--bg-secondary)]">
                  <span className="text-sm text-[var(--text-primary)]">
                    <span className="text-[var(--text-muted)] mr-2">{idx + 1}.</span>
                    {SIDEBAR_GROUP_LABELS[group.id]}
                  </span>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => moveGroup(idx, idx - 1)} disabled={idx === 0} aria-disabled={idx === 0} className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30" aria-label={`Move ${SIDEBAR_GROUP_LABELS[group.id]} up`}>
                      ↑
                    </button>
                    <button type="button" onClick={() => moveGroup(idx, idx + 1)} disabled={idx === draftOrder.length - 1} aria-disabled={idx === draftOrder.length - 1} className="px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30" aria-label={`Move ${SIDEBAR_GROUP_LABELS[group.id]} down`}>
                      ↓
                    </button>
                  </div>
                </li>;
          })}
          </ol>
        </Card>

        <Card padding="lg" as="section" className="space-y-space-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">All items</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Pin items to the top of the rail, or hide them entirely.
          </p>
          <ul className="space-y-1">
            {DEFAULT_SIDEBAR.flatMap(group => group.items.map(item => {
            const pinned = isPinned(item.id);
            const hidden = isHidden(item.id);
            return <li key={item.id} className={cn("flex items-center justify-between p-2 rounded-md border", hidden ? "bg-[var(--bg-secondary)]/40 border-[var(--border-subtle)] opacity-60" : "bg-[var(--bg-secondary)] border-[var(--border-subtle)]")}>
                    <div className="flex items-center gap-2.5 min-w-0">
                      <item.icon className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm text-[var(--text-primary)] truncate">
                          {SIDEBAR_ITEM_LABELS[item.id] ?? item.id}
                          {item.category === "advanced" && (
                            <span className="ml-1.5 text-2xs text-[var(--text-muted)]/70 font-normal">Advanced</span>
                          )}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                          {SIDEBAR_GROUP_LABELS[group.id]}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => pinned ? unpin(item.id) : pin(item.id)} aria-pressed={pinned} className={cn("p-1.5 rounded transition-colors", pinned ? "text-[var(--text-secondary)] bg-[var(--bg-tertiary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]")} title={pinned ? "Unpin" : "Pin to top"} aria-label={pinned ? `Unpin ${SIDEBAR_ITEM_LABELS[item.id] ?? item.id}` : `Pin ${SIDEBAR_ITEM_LABELS[item.id] ?? item.id}`}>
                        <Pin className={cn("w-3.5 h-3.5", pinned && "fill-current")} />
                      </button>
                      <button type="button" onClick={() => hidden ? show(item.id) : hide(item.id)} aria-pressed={hidden} className={cn("p-1.5 rounded transition-colors", hidden ? "text-[var(--error)] bg-[var(--error-dim)]" : "text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-tertiary)]")} title={hidden ? "Show in sidebar" : "Hide from sidebar"} aria-label={hidden ? `Show ${SIDEBAR_ITEM_LABELS[item.id] ?? item.id}` : `Hide ${SIDEBAR_ITEM_LABELS[item.id] ?? item.id}`}>
                        {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </li>;
          }))}
          </ul>
        </Card>

        <Card padding="lg" as="section" className="space-y-space-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Live preview</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Tonal rail preview (240px) — matches the portal sidebar.
          </p>
          <div
            data-home-shell-sidebar-preview="tonal-rail"
            className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-md p-2.5 w-60 max-w-full"
          >
            {pinnedItems.length > 0 && (
              <SidebarPreviewGroup
                label="Pinned"
                items={pinnedItems.map((i) => ({
                  id: i.id,
                  label: SIDEBAR_ITEM_LABELS[i.id] ?? i.id,
                  icon: i.icon,
                }))}
                quiet
              />
            )}
            {groups.map((g) => (
              <SidebarPreviewGroup
                key={g.id}
                label={SIDEBAR_GROUP_LABELS[g.id]}
                items={g.items.map((i) => ({
                  id: i.id,
                  label: SIDEBAR_ITEM_LABELS[i.id] ?? i.id,
                  icon: i.icon,
                }))}
              />
            ))}
          </div>
          <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline">
            Open the dashboard to see your custom sidebar →
          </Link>
        </Card>

        <p className="text-xs text-[var(--text-muted)] text-center">
          {saveError ? (
            <span className="inline-flex flex-col items-center gap-2 text-[var(--error)]" role="alert">
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                Could not save sidebar preferences — changes are local only until retry succeeds.
              </span>
              <Button type="button" variant="outline" size="sm" onClick={retrySave} disabled={saving}>
                <RefreshCw className={cn("w-3.5 h-3.5", saving && "animate-spin")} aria-hidden />
                Retry save
              </Button>
            </span>
          ) : saving ? (
            "Saving…"
          ) : (
            "Changes save automatically"
          )}{" "}
          · {ALL_ITEM_IDS.length} total items
        </p>
      </div>;

  if (embedded) {
    return <div className="space-y-space-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Sidebar</h2>
          </div>
          {resetButton}
        </div>
        {body}
      </div>;
  }

  return <PageContent>
      <PageHeader title="Sidebar" subtitle="Customize the left nav — pin items you use often, hide what you don't, reorder groups" icon={Settings2} actions={resetButton} />
      {body}
    </PageContent>;
}
function SidebarPreviewGroup({
  label,
  items,
  quiet,
}: {
  label: string;
  items: {
    id: string;
    label: string;
    icon: ComponentType<{ className?: string }>;
  }[];
  quiet?: boolean;
}) {
  return <div className="mb-2.5 last:mb-0">
      <div
        className={cn(
          "text-[9px] font-mono uppercase tracking-[0.12em] px-2 mb-0.5",
          quiet ? "text-[var(--text-muted)]/55" : "text-[var(--text-muted)]/75",
        )}
      >
        {label}
      </div>
      <ul className="space-y-0.5">
        {items.map(item => <li key={item.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-[var(--text-secondary)]">
            <item.icon className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            {item.label}
          </li>)}
      </ul>
    </div>;
}

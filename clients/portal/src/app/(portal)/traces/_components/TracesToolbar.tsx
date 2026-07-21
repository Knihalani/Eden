"use client";

/**
 * Observe V3 Wave 2 — Traces hub first-paint toolbar.
 * Primary: Tabs · Search+≤3 filters · Views · Display · Overflow (≤8).
 * Display owns columns / density / LIVE opt-in / time range.
 * Refresh / Legacy tools / Facets stay in More.
 */

import Link from "next/link";
import { ChevronDown, Radio, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  QueryFilterBar,
  ViewsMenu,
  type FilterMode,
  type ViewPreset,
} from "@/components/portal-os";
import type { ViewState } from "@/components/portal-os/useSavedViews";
import type { SavedViewRecord } from "@/lib/api";
import { useSidebarPrefs } from "@/hooks/use-sidebar-prefs";
import type { TraceFilter } from "../../observability/_lib/types";
import {
  TRACES_OPTIONAL_COLUMNS,
} from "../../observability/_components/TracesTab";

export const HUB_VIEWS = ["traces", "spans", "sessions"] as const;
export type HubView = (typeof HUB_VIEWS)[number];

export const FACET_VIEWS = ["mcp", "decisions", "memory", "retrieval"] as const;

export const LEGACY_TOOL_LINKS = [
  { href: "/traces?view=inspect", label: "Inspector" },
  { href: "/traces?view=replay", label: "Replay" },
  { href: "/traces?view=debug", label: "Debugger" },
  { href: "/traces?view=time-travel", label: "Time-Travel" },
  { href: "/traces?view=query", label: "Query" },
] as const;

export const FACET_LINKS = FACET_VIEWS.map((facet) => ({
  href: `/traces?facet=${facet}`,
  label: facet.charAt(0).toUpperCase() + facet.slice(1),
  facet,
}));

/** Compact time-range presets for Display (pastHours values). */
export const TRACES_TIME_RANGE_OPTIONS = [
  { hours: "6", label: "6h" },
  { hours: "24", label: "24h" },
  { hours: "168", label: "7d" },
] as const;

/** First-paint primary control budget (Wave 3 exit: ≤8). */
export const TRACES_PRIMARY_CONTROL_BUDGET = 8;

export interface TracesToolbarProps {
  hubView: string;
  onHubViewChange: (next: HubView) => void;
  filterMode: FilterMode;
  onFilterModeChange: (mode: FilterMode) => void;
  filter: TraceFilter;
  activeFacet: string | null;
  onFiltersChange: (next: {
    realm: string;
    outcome: string;
    agent_id: string;
  }) => void;
  query: string;
  onQueryChange: (q: string) => void;
  onCreateAlert: () => void;
  views: Array<SavedViewRecord & { state: ViewState }>;
  /** Built-in Errors / High latency / Unreviewed presets. */
  viewPresets?: ViewPreset[];
  savedViewId?: string;
  filterDirty: boolean;
  onSelectView: (viewId: string) => void;
  onSaveView: (name: string, isShared?: boolean) => Promise<void>;
  onSaveChanges?: () => Promise<void>;
  onDiscardView: () => void;
  onDeleteView: (id: string) => Promise<void>;
  liveOn: boolean;
  onLiveChange: (on: boolean) => void;
  refreshing: boolean;
  onRefresh: () => void;
  visibleColumns: string[];
  onVisibleColumnsChange: (next: string[]) => void;
  pastHours: string;
  onPastHoursChange: (hours: string) => void;
}

export function TracesToolbar({
  hubView,
  onHubViewChange,
  filterMode,
  onFilterModeChange,
  filter,
  activeFacet,
  onFiltersChange,
  query,
  onQueryChange,
  onCreateAlert,
  views,
  viewPresets = [],
  savedViewId,
  filterDirty,
  onSelectView,
  onSaveView,
  onSaveChanges,
  onDiscardView,
  onDeleteView,
  liveOn,
  onLiveChange,
  refreshing,
  onRefresh,
  visibleColumns,
  onVisibleColumnsChange,
  pastHours,
  onPastHoursChange,
}: TracesToolbarProps) {
  const { prefs, setDensity } = useSidebarPrefs();
  const density = prefs.density;

  return (
    <div
      className="flex flex-wrap items-end gap-2"
      data-testid="traces-toolbar"
      data-chrome-band="toolbar"
      data-primary-control-budget={TRACES_PRIMARY_CONTROL_BUDGET}
    >
      <Tabs
        value={(HUB_VIEWS as readonly string[]).includes(hubView) ? hubView : "traces"}
        onValueChange={(v) => onHubViewChange(v as HubView)}
        className="min-w-0"
        data-primary-control="hub-tabs"
      >
        <TabsList
          variant="underline"
          aria-label="Observe hub"
          className="h-auto flex-wrap justify-start gap-1 bg-transparent"
        >
          {HUB_VIEWS.map((v) => (
            <TabsTrigger
              key={v}
              variant="underline"
              value={v}
              title={v}
              className="min-h-11 capitalize"
            >
              {v}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="min-w-[20rem] flex-1" data-primary-control="filters">
        <QueryFilterBar
          mode={filterMode}
          onModeChange={onFilterModeChange}
          filters={{
            realm: filter.realm ?? "",
            outcome: filter.outcome ?? "",
            agent_id: filter.agent_id ?? "",
          }}
          onFiltersChange={(next) => {
            onFiltersChange({
              realm: next.realm ?? "",
              outcome: next.outcome ?? "",
              agent_id: next.agent_id ?? "",
            });
          }}
          query={query}
          onQueryChange={onQueryChange}
          selects={[
            {
              key: "realm",
              label: "All realms",
              value: filter.realm ?? "",
              options: [
                { value: "environment", label: "Environment" },
                { value: "production", label: "Production" },
              ],
            },
            {
              key: "outcome",
              label: "All outcomes",
              value: filter.outcome ?? "",
              options: [
                { value: "success", label: "success" },
                { value: "failure", label: "failure" },
                { value: "partial", label: "partial" },
                { value: "timeout", label: "timeout" },
              ],
            },
          ]}
          onCreateAlert={onCreateAlert}
        />
      </div>

      <div data-primary-control="views">
        <ViewsMenu
          views={views}
          presets={viewPresets}
          activeViewId={savedViewId}
          dirty={filterDirty}
          onSelect={onSelectView}
          onSave={onSaveView}
          onSaveChanges={onSaveChanges}
          onDiscard={onDiscardView}
          onDelete={onDeleteView}
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="default"
            className="min-h-11"
            aria-label="Display options"
            data-primary-control="display"
            data-testid="traces-display"
          >
            Display
            <ChevronDown className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          <DropdownMenuLabel>Time range</DropdownMenuLabel>
          {TRACES_TIME_RANGE_OPTIONS.map((opt) => {
            const checked = pastHours === opt.hours;
            return (
              <DropdownMenuItem
                key={opt.hours}
                onSelect={(e) => {
                  e.preventDefault();
                  onPastHoursChange(opt.hours);
                }}
                aria-checked={checked}
                data-testid={`display-range-${opt.hours}`}
              >
                {checked ? "✓ " : ""}
                {opt.label}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Columns</DropdownMenuLabel>
          {TRACES_OPTIONAL_COLUMNS.map((col) => {
            const checked = visibleColumns.includes(col.id);
            return (
              <DropdownMenuItem
                key={col.id}
                onSelect={(e) => {
                  e.preventDefault();
                  const next = checked
                    ? visibleColumns.filter((id) => id !== col.id)
                    : [...visibleColumns, col.id];
                  onVisibleColumnsChange(next);
                }}
                aria-checked={checked}
                data-testid={`display-col-${col.id}`}
              >
                {checked ? "✓ " : ""}
                {col.label}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Density</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setDensity("comfortable");
            }}
            aria-checked={density === "comfortable"}
            data-testid="display-density-comfortable"
          >
            {density === "comfortable" ? "✓ " : ""}
            Comfortable
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setDensity("compact");
            }}
            aria-checked={density === "compact"}
            data-testid="display-density-compact"
          >
            {density === "compact" ? "✓ " : ""}
            Compact
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Live</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onLiveChange(!liveOn);
            }}
            aria-checked={liveOn}
            data-testid="traces-live-toggle"
          >
            <Radio className="mr-2 h-3.5 w-3.5" aria-hidden />
            {liveOn ? "Turn off live tail" : "Turn on live tail"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="default"
            className="min-h-11"
            aria-label="More tools"
            data-primary-control="overflow"
            data-testid="traces-overflow"
          >
            More
            <ChevronDown className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          <DropdownMenuLabel>Refresh</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onRefresh();
            }}
            disabled={refreshing}
            data-testid="traces-refresh"
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden />
            Refresh
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Facets</DropdownMenuLabel>
          {FACET_LINKS.map((item) => (
            <DropdownMenuItem key={item.href} asChild>
              <Link
                href={item.href}
                data-testid={`facet-link-${item.facet}`}
                aria-current={activeFacet === item.facet ? "page" : undefined}
              >
                {activeFacet === item.facet ? "✓ " : ""}
                {item.label}
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Tools</DropdownMenuLabel>
          {LEGACY_TOOL_LINKS.map((item) => (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href}>{item.label}</Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Count first-paint primary controls via data-primary-control markers. */
export function countTracesPrimaryControls(toolbarRoot: ParentNode): number {
  return toolbarRoot.querySelectorAll("[data-primary-control]").length;
}

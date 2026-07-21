import type { ViewState } from "@/components/portal-os";

/** Built-in status views — status lives in ViewState, not one-off chrome. */
export const ISSUE_STATUS_VIEW_PRESETS: Array<{
  id: string;
  name: string;
  state: ViewState;
}> = [
  { id: "preset:open", name: "Open", state: { filter: { status: "open" } } },
  { id: "preset:triaged", name: "Triaged", state: { filter: { status: "triaged" } } },
  {
    id: "preset:fix_pending",
    name: "Fix pending",
    state: { filter: { status: "fix_pending" } },
  },
  {
    id: "preset:verifying",
    name: "Verifying",
    state: { filter: { status: "verifying" } },
  },
  {
    id: "preset:resolved",
    name: "Resolved",
    state: { filter: { status: "resolved" } },
  },
  {
    id: "preset:regressed",
    name: "Regressed",
    state: { filter: { status: "regressed" } },
  },
];

export const ISSUE_STATUS_FILTERS = [
  "all",
  "open",
  "triaged",
  "fix_pending",
  "verifying",
  "resolved",
  "regressed",
] as const;

export function resolveIssueStatusPreset(
  viewId: string | undefined,
): ViewState | null {
  if (!viewId) return null;
  return ISSUE_STATUS_VIEW_PRESETS.find((p) => p.id === viewId)?.state ?? null;
}

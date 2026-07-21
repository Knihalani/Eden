import type { ViewPreset } from "@/components/portal-os";
import type { ViewState } from "@/components/portal-os/useSavedViews";

/**
 * Wave 2 built-in Traces views.
 * `builtin:errors` uses outcome=failure (API equivalent of “error”).
 * `builtin:unreviewed` is soft until list rows expose score/reviewed.
 */
export const TRACES_BUILTIN_VIEW_PRESETS: ViewPreset[] = [
  {
    id: "builtin:errors",
    name: "Errors",
    state: {
      filter: { outcome: "failure" },
      sort: { key: "duration_ms", direction: "desc" },
    },
  },
  {
    id: "builtin:high-latency",
    name: "High latency",
    state: {
      sort: { key: "duration_ms", direction: "desc" },
    },
  },
  {
    id: "builtin:unreviewed",
    name: "Unreviewed",
    state: {
      // Soft placeholder — no unscored/reviewed field on list rows yet.
      sort: { key: "duration_ms", direction: "desc" },
    },
  },
];

export function resolveTracesBuiltinView(
  viewId: string | undefined,
): ViewState | null {
  if (!viewId) return null;
  return TRACES_BUILTIN_VIEW_PRESETS.find((p) => p.id === viewId)?.state ?? null;
}

export function isTracesUnreviewedSoftView(viewId: string | undefined): boolean {
  return viewId === "builtin:unreviewed";
}

"use client";

/**
 * Code-split helpers for legacy traces hub list (not used by Phase 3 page).
 * Facet/inspector embeds removed — kill-list zombies deleted; use redirects.
 */

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

export function ViewLoading() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

export const SpansTab = dynamic(
  () =>
    import("@/components/traces/SpansTab").then((m) => ({ default: m.SpansTab })),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const SessionsTab = dynamic(
  () =>
    import("@/components/traces/SessionsTab").then((m) => ({
      default: m.SessionsTab,
    })),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const TraceViewer = dynamic(
  () =>
    import("@/components/trace-viewer").then((m) => ({
      default: m.TraceViewer,
    })),
  { ssr: false, loading: () => <ViewLoading /> },
);

/** Legacy tools → Debugger (IA §3.4). */
export const ReplayView = dynamic(
  () =>
    import("@/app/(portal)/debugger/page").then((m) => ({
      default: m.default,
    })),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const DebugView = dynamic(() => import("@/app/(portal)/debugger/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});

export const LiveTailPanel = dynamic(
  () =>
    import("./LiveTailPanel").then((m) => ({
      default: m.LiveTailPanel,
    })),
  { ssr: false },
);

export const TraceExportModal = dynamic(
  () =>
    import("../../observability/_components/TraceExportModal").then((m) => ({
      default: m.TraceExportModal,
    })),
  { ssr: false },
);

export const AnnotateTraceDialog = dynamic(
  () =>
    import("../../observability/_components/AnnotateTraceDialog").then((m) => ({
      default: m.AnnotateTraceDialog,
    })),
  { ssr: false },
);

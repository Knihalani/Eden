"use client";

/**
 * Code-split hub tabs, detail, legacy tools, and facet embeds.
 * Keeps first paint light — Wave 3 shell stays under 400 LOC.
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

export const TraceDetailPanel = dynamic(
  () =>
    import("@/components/traces/TraceDetailPanel").then((m) => ({
      default: m.TraceDetailPanel,
    })),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const InspectView = dynamic(() => import("@/app/(portal)/inspector/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});

export const ReplayView = dynamic(() => import("@/app/(portal)/replay/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});

export const DebugView = dynamic(() => import("@/app/(portal)/debugger/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});

export const QueryView = dynamic(
  () => import("@/app/(portal)/observability/query/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const TimeTravelView = dynamic(
  () => import("@/app/(portal)/observability/time-travel/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const McpFacetView = dynamic(
  () => import("@/app/(portal)/observability/mcp/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const DecisionsFacetView = dynamic(
  () => import("@/app/(portal)/observability/decisions/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const MemoryFacetView = dynamic(
  () => import("@/app/(portal)/observability/memory/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);

export const RetrievalFacetView = dynamic(
  () => import("@/app/(portal)/observability/retrieval/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);

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

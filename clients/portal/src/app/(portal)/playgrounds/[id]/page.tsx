"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useOrg } from "@/hooks/use-org";

const editorFallback = (
  <div className="ds-page">
    <PageHeader title="Playground" />
    <div className="flex min-h-[12rem] flex-1 items-center justify-center px-5">
      <p className="type-meta">Loading…</p>
    </div>
  </div>
);

/** Editor is heavy (diff + matrix + SSE consumer) — mount lazily. */
const PlaygroundEditor = dynamic(
  () =>
    import("@/lab/playgrounds/playground-editor").then((m) => ({
      default: m.PlaygroundEditor,
    })),
  { loading: () => editorFallback },
);

export default function PlaygroundDetailPage() {
  const params = useParams<{ id: string }>();
  const playgroundId = params?.id ?? "";
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Playground"
        message="Select a workspace to open this playground."
      />
    );
  }

  return <PlaygroundEditor orgId={orgId} playgroundId={playgroundId} />;
}

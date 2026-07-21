"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { errorFromCaught } from "@/lib/safe-error-message";
import { DetailPanelShell, ResourcePageShell } from "@/components/portal-os";
import { FileText, Loader2, Plus } from "lucide-react";
import { promptHref } from "@/lib/portal-cross-links";
import { PromptsEditor } from "./_components/prompts-editor";
import { PromptsCreateForm } from "./_components/prompts-create-form";
import { PromptsListTable } from "./_components/prompts-list-table";
import { usePromptsVersions } from "./_components/use-prompts-versions";

/** Mirror of prompts list empty gate — keep in sync with page render. */
function showPromptsEmpty(opts: {
  isLoading: boolean;
  isError: boolean;
  promptCount: number;
}): boolean {
  return !opts.isLoading && !opts.isError && opts.promptCount === 0;
}

interface PromptEntry {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  auto_eval_on_save: boolean;
  created_at: string;
}

function PromptsPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedName = searchParams.get("prompt");

  const [showNewPrompt, setShowNewPrompt] = useState(false);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptDesc, setNewPromptDesc] = useState("");
  const [newPromptAutoEval, setNewPromptAutoEval] = useState(false);

  const {
    prepareSelect,
    versions,
    versionsLoading,
    versionsError,
    draftTemplate,
    draftModel,
    draftNote,
    versionDirty,
    savingVersion,
    envPinCount,
    rollbackBusy,
    expandedDiff,
    setDraftTemplate,
    setDraftModel,
    setDraftNote,
    setVersionDirty,
    setEnvPinCount,
    setExpandedDiff,
    fetchVersions,
    saveVersion,
    rollbackPin,
  } = usePromptsVersions(orgId, selectedName);

  const promptsQuery = useOrgQuery(
    queryKeys.prompts.list(orgId),
    orgId,
    () => api.get<{ data: { prompts: PromptEntry[] } }>(`/orgs/${orgId}/prompts?limit=100`),
  );
  const prompts = promptsQuery.data?.data?.prompts ?? [];

  const createMutation = useOrgMutation(
    (payload: {
      name: string;
      description: string | null;
      tags: string[];
      auto_eval_on_save: boolean;
    }) => api.post(`/orgs/${orgId}/prompts`, payload),
    { invalidateKeys: [queryKeys.prompts.list(orgId)] },
  );

  const selectedPrompt = useMemo(
    () => (selectedName ? prompts.find((p) => p.name === selectedName) ?? null : null),
    [prompts, selectedName],
  );

  const selectPrompt = useCallback(
    (name: string | null) => {
      if (name === selectedName) return;
      if (!prepareSelect(name)) return;
      router.replace(name ? promptHref(name) : "/prompts", { scroll: false });
    },
    [selectedName, prepareSelect, router],
  );

  const handleCreate = useCallback(async () => {
    if (!orgId || !newPromptName.trim()) {
      toast.error("Name required", "Prompt name cannot be empty.");
      return;
    }
    try {
      await createMutation.mutateAsync({
        name: newPromptName.trim(),
        description: newPromptDesc || null,
        tags: [],
        auto_eval_on_save: newPromptAutoEval,
      });
      toast.success("Prompt created");
      setShowNewPrompt(false);
      const created = newPromptName.trim();
      setNewPromptName("");
      setNewPromptDesc("");
      setNewPromptAutoEval(false);
      router.replace(promptHref(created), { scroll: false });
    } catch (err) {
      toast.error("Create failed", errorFromCaught(err, "Please try again."));
    }
  }, [
    orgId,
    newPromptName,
    newPromptDesc,
    newPromptAutoEval,
    toast,
    createMutation,
    router,
  ]);

  if (!currentOrg) return <NoOrgState icon={FileText} feature="Prompt Versions" />;

  const selectedIndex = selectedPrompt
    ? prompts.findIndex((p) => p.id === selectedPrompt.id)
    : -1;

  return (
    <PageContent size="wide">
      <div
        data-wave5-improve-prompts="completed"
        data-wave9-prompts="completed"
        data-wave10-prompts="split"
        data-testid="prompts-master-detail"
      >
        <ResourcePageShell
          header={
            <PageHeader
              title="Prompts"
              subtitle="Version registry with draft → playground → publish → env pin."
              description="Core Improve destination. Iterate in Evaluate playground; do not merge with Studio."
              actions={
                <div className="flex flex-wrap items-center gap-x-space-3 gap-y-2">
                  <nav
                    data-testid="prompts-related-strip"
                    aria-label="Related"
                    className="flex flex-wrap items-center gap-x-space-3 gap-y-1 text-xs text-[var(--text-muted)]"
                  >
                    <Link href="/issues" className="text-[var(--accent)] hover:underline">
                      Issues
                    </Link>
                    <Link href="/improve" className="text-[var(--accent)] hover:underline">
                      Improve
                    </Link>
                    <Link href="/artifacts" className="text-[var(--accent)] hover:underline">
                      Artifacts
                    </Link>
                    <Link href="/ledger" className="text-[var(--accent)] hover:underline">
                      Ledger
                    </Link>
                  </nav>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setShowNewPrompt(!showNewPrompt)}
                  >
                    <Plus className="h-4 w-4" />
                    New prompt
                  </Button>
                </div>
              }
            />
          }
          toolbar={
            showNewPrompt ? (
              <PromptsCreateForm
                name={newPromptName}
                description={newPromptDesc}
                autoEval={newPromptAutoEval}
                pending={createMutation.isPending}
                onName={setNewPromptName}
                onDescription={setNewPromptDesc}
                onAutoEval={setNewPromptAutoEval}
                onCancel={() => setShowNewPrompt(false)}
                onCreate={() => void handleCreate()}
              />
            ) : null
          }
          table={
            promptsQuery.isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
              </div>
            ) : promptsQuery.isError ? (
              <ErrorState
                message={promptsQuery.error?.message}
                action={
                  <Button size="sm" variant="outline" onClick={() => promptsQuery.refetch()}>
                    Try again
                  </Button>
                }
              />
            ) : (
              <PromptsListTable
                prompts={
                  showPromptsEmpty({
                    isLoading: promptsQuery.isLoading,
                    isError: promptsQuery.isError,
                    promptCount: prompts.length,
                  })
                    ? []
                    : prompts
                }
                selectedName={selectedName}
                onSelect={(name) => selectPrompt(name)}
                onCreate={() => setShowNewPrompt(true)}
              />
            )
          }
          detail={
            selectedName ? (
              <DetailPanelShell
                open
                onClose={() => selectPrompt(null)}
                title={selectedPrompt?.name ?? selectedName}
                onPrev={
                  selectedIndex > 0
                    ? () => selectPrompt(prompts[selectedIndex - 1]!.name)
                    : undefined
                }
                onNext={
                  selectedIndex >= 0 && selectedIndex < prompts.length - 1
                    ? () => selectPrompt(prompts[selectedIndex + 1]!.name)
                    : undefined
                }
              >
                <PromptsEditor
                  orgId={orgId}
                  prompt={selectedPrompt}
                  versions={versions[selectedName] || []}
                  versionsLoading={versionsLoading === selectedName}
                  versionsError={versionsError}
                  expandedDiff={expandedDiff}
                  onExpandedDiff={setExpandedDiff}
                  draftTemplate={draftTemplate}
                  draftModel={draftModel}
                  draftNote={draftNote}
                  versionDirty={versionDirty}
                  savingVersion={savingVersion}
                  envPinCount={envPinCount}
                  onEnvPinsChange={setEnvPinCount}
                  onDraftTemplate={setDraftTemplate}
                  onDraftModel={setDraftModel}
                  onDraftNote={setDraftNote}
                  onMarkDirty={() => setVersionDirty(true)}
                  onClose={() => selectPrompt(null)}
                  onRetryVersions={() => void fetchVersions(selectedName)}
                  onSaveVersion={() => void saveVersion(toast)}
                  onRollbackPin={(ver) => void rollbackPin(ver, toast)}
                  rollbackBusy={rollbackBusy}
                />
              </DetailPanelShell>
            ) : null
          }
        />
      </div>
    </PageContent>
  );
}

export default function PromptsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <PromptsPageInner />
    </Suspense>
  );
}

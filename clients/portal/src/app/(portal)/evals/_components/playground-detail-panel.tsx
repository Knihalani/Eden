"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { PlaygroundEditor } from "@/components/evals/playground-editor";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { PlaygroundsTabState } from "../_hooks/use-playgrounds-tab";

export type PlaygroundDetailPanelProps = {
  open: boolean;
  onClose: () => void;
  canMutate: boolean;
  tab: PlaygroundsTabState;
  mobileDrawer?: boolean;
};

export function PlaygroundDetailPanel({
  open,
  onClose,
  canMutate,
  tab,
  mobileDrawer = true,
}: PlaygroundDetailPanelProps) {
  const t = useTranslations("evals");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);

  const {
    selected,
    draft,
    setDraft,
    dirty,
    detailQuery,
    runPersisted,
    promoteExperiment,
    saveDraft,
    runMutation,
    promoteMutation,
    patchMutation,
  } = tab;

  useEffect(() => {
    if (!dirty) setLeaveOpen(false);
  }, [dirty]);

  function requestClose() {
    if (dirty && canMutate) {
      setPendingClose(true);
      setLeaveOpen(true);
      return;
    }
    onClose();
  }

  function confirmLeave() {
    setLeaveOpen(false);
    setPendingClose(false);
    onClose();
  }

  async function saveAndStay() {
    await saveDraft();
    setLeaveOpen(false);
    setPendingClose(false);
  }

  const title = selected?.name ?? t("playgrounds.detail.panelTitle");

  let body: ReactNode;
  if ((detailQuery.isLoading || tab.listQuery.isLoading) && !selected) {
    body = (
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else if (!selected) {
    body = (
      <div className="p-4 text-sm text-[var(--text-muted)]">
        {t("playgrounds.detail.selectPrompt")}
      </div>
    );
  } else {
    body = (
      <div className="space-y-4 p-4" data-testid="playground-detail-body">
        <PlaygroundEditor
          value={draft}
          onChange={setDraft}
          dirty={dirty}
          canMutate={canMutate}
          running={runMutation.isPending || patchMutation.isPending}
          promoting={promoteMutation.isPending}
          onRun={() => void runPersisted()}
          onPromote={() => void promoteExperiment()}
          runDisabled={!draft.user.trim() && !draft.system.trim()}
          promoteDisabled={
            typeof selected.config?.dataset_id !== "string" ||
            !selected.config.dataset_id
          }
        />
        {tab.lastRun ? (
          <Panel tone="flat" padding="md" data-testid="playground-last-run">
            <p className="m-0 text-xs font-medium text-[var(--text-secondary)]">
              {t("playgrounds.detail.lastRun")}
            </p>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-[var(--text-muted)]">
              {JSON.stringify(tab.lastRun, null, 2)}
            </pre>
          </Panel>
        ) : null}
        {canMutate && dirty ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-h-11"
            loading={patchMutation.isPending}
            onClick={() => void saveDraft()}
          >
            {t("playgrounds.detail.save")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <DetailPanelShell
        open={open}
        onClose={requestClose}
        title={title}
        mobileDrawer={mobileDrawer}
      >
        {body}
      </DetailPanelShell>

      <Dialog
        open={leaveOpen && pendingClose}
        onOpenChange={(next) => {
          if (!next) {
            setLeaveOpen(false);
            setPendingClose(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("playgrounds.leave.title")}</DialogTitle>
            <DialogDescription>
              {t("playgrounds.leave.body")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setLeaveOpen(false);
                setPendingClose(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="secondary" onClick={confirmLeave}>
              {t("playgrounds.leave.discard")}
            </Button>
            <Button
              type="button"
              loading={patchMutation.isPending}
              onClick={() => void saveAndStay()}
            >
              {t("playgrounds.leave.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

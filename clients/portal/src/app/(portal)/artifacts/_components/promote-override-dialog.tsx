"use client";

import { deriveArtifactGate } from "@/components/artifacts/ArtifactDetailPanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { ArtifactRow } from "./use-artifacts-page";

type PromoteOverrideDialogProps = {
  open: boolean;
  promoteTarget: ArtifactRow | null;
  promoteBusy: boolean;
  onClose: () => void;
  onForcePromote: (target: ArtifactRow) => void;
};

export function PromoteOverrideDialog({
  open,
  promoteTarget,
  promoteBusy,
  onClose,
  onForcePromote,
}: PromoteOverrideDialogProps) {
  const lowValue =
    !!promoteTarget &&
    deriveArtifactGate({
      evidence: promoteTarget.evidence,
      cost: promoteTarget.cost,
    }).lowValue;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent data-testid="artifact-promote-override-dialog">
        <DialogHeader>
          <DialogTitle>{lowValue ? "Low value score" : "Review gate"}</DialogTitle>
          <DialogDescription>
            {lowValue
              ? "This Artifact may cost more in tokens than lift it provides. Promote only if you accept the tradeoff."
              : "Evidence gates are not fully green. Promote only if you accept a possible hold from the server gate."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!promoteTarget || promoteBusy}
            onClick={() => {
              if (promoteTarget) onForcePromote(promoteTarget);
            }}
          >
            Promote anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

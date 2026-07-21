"use client";

import { CheckCircle2, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { LabelingItem } from "@/lib/api";

type Props = {
  reviewItem: LabelingItem | null;
  label: string;
  notes: string;
  submitting: boolean;
  onLabelChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onClose: () => void;
  onAnnotate: (label: string) => void;
  onSkip: (item: LabelingItem) => void;
};

export function LabelingReviewDialog({
  reviewItem,
  label,
  notes,
  submitting,
  onLabelChange,
  onNotesChange,
  onClose,
  onAnnotate,
  onSkip,
}: Props) {
  return (
    <Dialog open={Boolean(reviewItem)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Review labeling item</DialogTitle>
          <DialogDescription>
            Submit a label for the eval pipeline. Approve when the prompt looks correct, or choose
            another label with optional notes.
          </DialogDescription>
        </DialogHeader>
        {reviewItem && (
          <div className="space-y-4">
            <pre className="max-h-40 overflow-auto rounded-md bg-[var(--bg-secondary)] p-3 text-xs font-mono text-[var(--text-primary)]">
              {reviewItem.prompt}
            </pre>
            {reviewItem.context && (
              <p className="text-xs text-[var(--text-muted)]">{reviewItem.context}</p>
            )}
            <div className="space-y-2">
              <label htmlFor="labeling-label" className="text-xs font-medium text-[var(--text-secondary)]">
                Label
              </label>
              <Select value={label} onValueChange={onLabelChange}>
                <SelectTrigger id="labeling-label" className="bg-[var(--bg-secondary)]">
                  <SelectValue placeholder="Select label" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approved">approved</SelectItem>
                  <SelectItem value="rejected">rejected</SelectItem>
                  <SelectItem value="needs_review">needs_review</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="labeling-notes" className="text-xs font-medium text-[var(--text-secondary)]">
                Notes (optional)
              </label>
              <Textarea
                id="labeling-notes"
                value={notes}
                onChange={(e) => onNotesChange(e.target.value)}
                rows={3}
                placeholder="Why this label?"
                className="bg-[var(--bg-secondary)]"
              />
            </div>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            className="h-8 max-md:min-h-11"
            onClick={() => reviewItem && void onSkip(reviewItem)}
            disabled={submitting || !reviewItem}
          >
            <SkipForward className="h-3.5 w-3.5" />
            Skip
          </Button>
          <Button
            className="h-8 max-md:min-h-11"
            onClick={() => void onAnnotate(label)}
            disabled={submitting || !reviewItem}
            loading={submitting}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Submit label
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

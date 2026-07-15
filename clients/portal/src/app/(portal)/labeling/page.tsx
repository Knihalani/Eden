"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tag, RefreshCw, Plus, Tag as TagIcon, CheckCircle2, SkipForward } from "lucide-react";
import { labelingApi, type LabelingItem } from "@/lib/api";

export default function LabelingPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [items, setItems] = useState<LabelingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [reviewItem, setReviewItem] = useState<LabelingItem | null>(null);
  const [label, setLabel] = useState("approved");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await labelingApi.listItems(currentOrg.id);
      setItems(res.items || []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load labeling queue";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const openReview = (item: LabelingItem) => {
    setReviewItem(item);
    setLabel("approved");
    setNotes("");
  };

  const closeReview = () => {
    if (submitting) return;
    setReviewItem(null);
  };

  const handleAnnotate = async (nextLabel: string) => {
    if (!currentOrg?.id || !reviewItem) return;
    setSubmitting(true);
    try {
      await labelingApi.annotate(currentOrg.id, {
        item_id: reviewItem.id,
        label: nextLabel,
        notes: notes.trim() || undefined,
      });
      toast.success(nextLabel === "approved" ? "Item approved" : "Annotation saved");
      setReviewItem(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to submit annotation");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = async (item: LabelingItem) => {
    if (!currentOrg?.id) return;
    setSubmitting(true);
    try {
      await labelingApi.skip(currentOrg.id, { item_id: item.id });
      toast.success("Item skipped");
      if (reviewItem?.id === item.id) setReviewItem(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to skip item");
    } finally {
      setSubmitting(false);
    }
  };

  if (!currentOrg) return <NoOrgState feature="Labeling queue" />;

  const filtered = items.filter((i) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return i.prompt.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q));
  });

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Eval"
        title="Labeling queue"
        subtitle="Items waiting for human labels. Approve or skip — annotations feed the eval pipeline."
        icon={TagIcon}
        actions={
          <>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter by prompt or tag" />
            <Button
              onClick={load}
              variant="outline"
              size="sm"
              disabled={loading}
              loading={loading}
              aria-label="Refresh labeling queue"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                const prompt = window.prompt("Seed item prompt:");
                if (!prompt?.trim() || !currentOrg?.id) return;
                try {
                  await labelingApi.seedItem(currentOrg.id, { prompt: prompt.trim() });
                  toast.success("Item seeded");
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed to seed item");
                }
              }}
              aria-label="Seed labeling item"
            >
              <Plus className="h-3.5 w-3.5" /> Seed item
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState
          title="Could not load labeling queue"
          message={error}
          action={
            <Button onClick={load} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : (
        <Card className="p-2">
          <DataTable
            loading={loading}
            rows={filtered}
            rowKey={(r) => r.id}
            emptyTitle="No items in queue"
            emptyDescription="When the eval pipeline flags low-confidence items, they appear here for human review."
            emptyIcon={TagIcon}
            columns={[
              {
                key: "prompt",
                header: "Prompt",
                sortable: true,
                cell: (r) => (
                  <button
                    type="button"
                    onClick={() => openReview(r)}
                    className="text-left font-mono text-xs hover:text-[var(--accent)] transition-colors"
                  >
                    {r.prompt.slice(0, 120)}
                    {r.prompt.length > 120 ? "…" : ""}
                  </button>
                ),
              },
              {
                key: "tags",
                header: "Tags",
                cell: (r) => (
                  <span className="flex flex-wrap gap-1">
                    {r.tags.map((t) => (
                      <Tag key={t} className="text-[10px]">
                        {t}
                      </Tag>
                    ))}
                  </span>
                ),
              },
              { key: "source", header: "Source", sortable: true },
              { key: "annotations_count", header: "Annotations", sortable: true, align: "right" },
              {
                key: "created_at",
                header: "Created",
                sortable: true,
                cell: (r) => new Date(r.created_at).toLocaleString(),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                cell: (r) => (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openReview(r)}
                      aria-label={`Review ${r.id}`}
                    >
                      Review
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleSkip(r)}
                      disabled={submitting}
                      aria-label={`Skip ${r.id}`}
                    >
                      <SkipForward className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Dialog open={Boolean(reviewItem)} onOpenChange={(open) => !open && closeReview()}>
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
                <select
                  id="labeling-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm"
                >
                  <option value="approved">approved</option>
                  <option value="rejected">rejected</option>
                  <option value="needs_review">needs_review</option>
                </select>
              </div>
              <div className="space-y-2">
                <label htmlFor="labeling-notes" className="text-xs font-medium text-[var(--text-secondary)]">
                  Notes (optional)
                </label>
                <textarea
                  id="labeling-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Why this label?"
                  className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => reviewItem && void handleSkip(reviewItem)}
              disabled={submitting || !reviewItem}
            >
              <SkipForward className="h-3.5 w-3.5" />
              Skip
            </Button>
            <Button
              onClick={() => void handleAnnotate(label)}
              disabled={submitting || !reviewItem}
              loading={submitting}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Submit label
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContent>
  );
}

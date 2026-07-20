"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tag as TagIcon, RefreshCw, Plus, CheckCircle2, SkipForward, Columns3, ChevronDown } from "lucide-react";
import { Tag } from "@/components/ui/tag";
import { labelingApi, labelingQueuesApi, type LabelingItem } from "@/lib/api";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type QueueRow = {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  created_at?: string;
};

export default function LabelingPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [reviewItem, setReviewItem] = useState<LabelingItem | null>(null);
  const [label, setLabel] = useState("approved");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [creatingQueue, setCreatingQueue] = useState(false);

  const itemsQuery = useOrgQuery(
    queryKeys.labeling.items(orgId),
    orgId,
    async () => {
      // B12: request a bounded page from the API (A7 owns server default).
      const { fetchApi } = await import("@/lib/api/core");
      const res = await fetchApi<{ items: LabelingItem[]; total: number }>(
        `/orgs/${orgId}/labeling/items?limit=100`,
        { headers: { "X-Org-Id": orgId! } },
      );
      return res.items || [];
    },
  );
  const items = itemsQuery.data ?? [];
  const loading = itemsQuery.isLoading;
  const error = itemsQuery.error?.message ?? null;
  const load = () => void itemsQuery.refetch();

  const queuesQuery = useOrgQuery(
    queryKeys.labeling.queues(orgId),
    orgId,
    async () => {
      const res = await labelingQueuesApi.list(orgId!);
      return (res.queues || []) as QueueRow[];
    },
  );
  const queues = queuesQuery.data ?? [];
  const queuesError = queuesQuery.error?.message ?? null;
  const queuesLoading = queuesQuery.isLoading;

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
      load();
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
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to skip item");
    } finally {
      setSubmitting(false);
    }
  };

  const seedItem = async () => {
    const prompt = window.prompt("Seed item prompt:");
    if (!prompt?.trim() || !currentOrg?.id) return;
    try {
      await labelingApi.seedItem(currentOrg.id, { prompt: prompt.trim() });
      toast.success("Item seeded");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to seed item");
    }
  };

  const createQueue = async () => {
    if (!currentOrg?.id) return;
    const name = window.prompt("New labeling queue name:");
    if (!name?.trim()) return;
    setCreatingQueue(true);
    try {
      const res = await labelingQueuesApi.create(currentOrg.id, { name: name.trim() });
      const qid = String(res.queue?.id || "");
      toast.success("Queue created");
      void queuesQuery.refetch();
      if (qid) router.push(`/labeling/queues/${qid}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create queue");
    } finally {
      setCreatingQueue(false);
    }
  };

  if (!currentOrg) return <NoOrgState feature="Labeling queue" />;

  const filtered = items.filter((i) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    const tags = i.tags ?? [];
    return (
      (i.prompt ?? "").toLowerCase().includes(q) ||
      tags.some((t) => t.toLowerCase().includes(q))
    );
  });
  const filterActive = Boolean(filter.trim());
  const filterMiss =
    filterActive && !loading && !error && items.length > 0 && filtered.length === 0;

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Eval"
        title="Labeling queue"
        subtitle="Approve or skip items — annotations feed datasets."
        icon={TagIcon}
        actions={
          <>
            <div className="hidden min-w-[12rem] sm:block">
              <DataTableSearch
                value={filter}
                onChange={setFilter}
                placeholder="Filter by prompt or tag"
              />
            </div>
            <Button
              onClick={load}
              variant="outline"
              className="min-h-11"
              disabled={loading}
              loading={loading}
              aria-label="Refresh labeling queue"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="min-h-11" aria-label="More labeling actions">
                  More
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void seedItem()}>
                  <Plus className="h-3.5 w-3.5" /> Seed item
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/evals?tab=datasets">Open datasets</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <details className="mb-space-4 group border-b border-[var(--border-subtle)] pb-space-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-space-2 text-sm font-medium text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
          <span>
            Annotation queues
            {queues.length > 0 ? (
              <span className="ml-2 font-normal text-[var(--text-muted)]">({queues.length})</span>
            ) : null}
          </span>
          <ChevronDown className="h-4 w-4 text-[var(--text-muted)] transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-space-3 pt-space-2">
          <p className="text-xs text-[var(--text-muted)]">
            Kanban workstations with hotkeys — export done items to a dataset.
          </p>
          <Button
            className="min-h-11"
            variant="outline"
            onClick={() => void createQueue()}
            disabled={creatingQueue}
            loading={creatingQueue}
            data-testid="labeling-create-queue"
          >
            <Columns3 className="h-3.5 w-3.5" /> New queue
          </Button>
          <QueryState
            loading={queuesLoading && queues.length === 0}
            error={queuesError ? new Error(queuesError) : null}
            data={queues}
            onRetry={() => void queuesQuery.refetch()}
            errorTitle="Could not load labeling queues"
            isEmpty={(q) => q.length === 0}
            emptySlot={
              <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
                <span>No queues yet.</span>
                <Button className="min-h-11" onClick={() => void createQueue()} disabled={creatingQueue}>
                  <Plus className="h-3.5 w-3.5" /> Create queue
                </Button>
              </div>
            }
          >
            {(qRows) => (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {qRows.map((q) => (
                  <li key={q.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      <Link
                        href={`/labeling/queues/${q.id}`}
                        className="font-medium text-[var(--accent)] hover:underline"
                      >
                        {q.name || q.id}
                      </Link>
                      {q.description ? (
                        <p className="truncate text-xs text-[var(--text-muted)]">{q.description}</p>
                      ) : null}
                    </div>
                    <Button asChild className="min-h-11" variant="ghost">
                      <Link href={`/labeling/queues/${q.id}`}>Open board</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      </details>

      <div className="mb-space-3 sm:hidden">
        <DataTableSearch
          value={filter}
          onChange={setFilter}
          placeholder="Filter by prompt or tag"
        />
      </div>

      <QueryState
        loading={loading && items.length === 0}
        error={error ? new Error(error) : null}
        data={items}
        onRetry={load}
        errorTitle="Could not load labeling queue"
        isEmpty={() => filtered.length === 0}
        filtersActive={filterActive}
        emptyKind={filterMiss ? "filter-empty" : "zero-data"}
        filterEmptySlot={
          <EmptyState
            icon={TagIcon}
            title="No matching items"
            description={`Nothing matches “${filter.trim()}”. Clear the filter or seed a new item.`}
            variant="plain"
            action={
              <Button
                className="min-h-11"
                variant="outline"
                data-testid="labeling-clear-filter"
                onClick={() => setFilter("")}
              >
                Clear filter
              </Button>
            }
          />
        }
        emptySlot={
          <EmptyState
            icon={TagIcon}
            title="No items in queue"
            description="When the eval pipeline flags low-confidence items, they appear here — or seed one now."
            variant="plain"
            action={
              <Button className="min-h-11" data-testid="labeling-empty-seed" onClick={() => void seedItem()}>
                <Plus className="h-3.5 w-3.5" /> Seed item
              </Button>
            }
          />
        }
      >
        {() => (
          <div className="border-y border-[var(--border-subtle)] py-space-2">
            <DataTable
              loading={loading}
              rows={filtered}
              rowKey={(r) => r.id}
              emptyTitle="No items in queue"
              emptyDescription="Queue is empty."
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
                      {(r.prompt ?? "").slice(0, 120)}
                      {(r.prompt ?? "").length > 120 ? "…" : ""}
                    </button>
                  ),
                },
                {
                  key: "tags",
                  header: "Tags",
                  cell: (r) => (
                    <span className="flex flex-wrap gap-1">
                      {(r.tags ?? []).map((t) => (
                        <Tag key={t} className="text-[length:var(--font-size-2xs)]">
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
                        className="min-h-11"
                        variant="outline"
                        onClick={() => openReview(r)}
                        aria-label={`Review ${r.id}`}
                      >
                        Review
                      </Button>
                      <Button
                        className="min-h-11"
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
          </div>
        )}
      </QueryState>

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
                <Select value={label} onValueChange={setLabel}>
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
                  onChange={(e) => setNotes(e.target.value)}
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
              className="min-h-11"
              onClick={() => reviewItem && void handleSkip(reviewItem)}
              disabled={submitting || !reviewItem}
            >
              <SkipForward className="h-3.5 w-3.5" />
              Skip
            </Button>
            <Button
              className="min-h-11"
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

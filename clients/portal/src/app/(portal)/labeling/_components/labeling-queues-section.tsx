"use client";

import Link from "next/link";
import { Columns3, Plus, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import type { QueueRow } from "./use-labeling-page";

type Props = {
  queues: QueueRow[];
  queuesLoading: boolean;
  queuesError: string | null;
  onRetry: () => void;
  creatingQueue: boolean;
  pushingQueueId: string | null;
  onCreateQueue: () => void;
  onPushToDataset: (queue: QueueRow) => void;
};

export function LabelingQueuesSection({
  queues,
  queuesLoading,
  queuesError,
  onRetry,
  creatingQueue,
  pushingQueueId,
  onCreateQueue,
  onPushToDataset,
}: Props) {
  return (
    <details className="mb-space-4 group border-b border-[var(--border-subtle)] pb-space-3" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-space-2 text-sm font-medium text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
        <span>
          Annotation queues
          {queues.length > 0 ? (
            <span className="ml-2 font-normal text-[var(--text-muted)]">({queues.length})</span>
          ) : null}
        </span>
        <Columns3 className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
      </summary>
      <div className="space-y-space-3 pt-space-2">
        <p className="text-xs text-[var(--text-muted)]">
          Kanban workstations with hotkeys — push done items to a dataset.
        </p>
        <Button
          className="h-8 max-md:min-h-11"
          variant="outline"
          onClick={() => void onCreateQueue()}
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
          onRetry={onRetry}
          errorTitle="Could not load labeling queues"
          isEmpty={(q) => q.length === 0}
          emptySlot={
            <EmptyState
              icon={Columns3}
              title="No labeling queues"
              description="Create a queue, seed items from traces, or add a sample item — then open the board."
              variant="plain"
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    className="h-8 max-md:min-h-11"
                    onClick={() => void onCreateQueue()}
                    disabled={creatingQueue}
                  >
                    <Plus className="h-3.5 w-3.5" /> Create queue
                  </Button>
                  <Button asChild className="h-8 max-md:min-h-11" variant="outline">
                    <Link href="/traces">From traces</Link>
                  </Button>
                </div>
              }
            />
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
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      className="h-8 max-md:min-h-11"
                      variant="outline"
                      data-wave-e5-labeling="push-to-dataset"
                      disabled={pushingQueueId === q.id}
                      loading={pushingQueueId === q.id}
                      onClick={() => void onPushToDataset(q)}
                    >
                      <Database className="h-3.5 w-3.5" />
                      Push to dataset
                    </Button>
                    <Button asChild className="h-8 max-md:min-h-11" variant="ghost">
                      <Link href={`/labeling/queues/${q.id}`}>Open board</Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </div>
    </details>
  );
}

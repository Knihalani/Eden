import { StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { formatRelativeTime } from "@/lib/format";
import type { LabelingQueue } from "@/lib/api/labeling";

/** API queue status → display label ("active" → "Active"). */
const QUEUE_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

function queueStatusLabel(status: string): string {
  return QUEUE_STATUS_LABEL[status] ?? status;
}

/**
 * F50 kanban queue table for `/labeling` (FEAT-82). Selecting a row
 * opens the kanban board at `/labeling/queues/[queueId]`.
 */
export function LabelingQueueTable({
  queues,
  onSelect,
}: {
  queues: readonly LabelingQueue[];
  onSelect: (queueId: string) => void;
}) {
  if (queues.length === 0) {
    return (
      <EmptyState
        title="No labeling queues yet"
        body="Queues group items for review — create one from the labeling API to get started."
        compact
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" role="table" aria-label="Labeling queues">
      <div
        role="row"
        className="grid grid-cols-[1fr_6rem_9rem] gap-3 border-b border-[var(--line)] px-4 py-2 sm:px-5"
      >
        <span role="columnheader" className="type-meta">
          Queue
        </span>
        <span role="columnheader" className="type-meta">
          Status
        </span>
        <span role="columnheader" className="type-meta">
          Created
        </span>
      </div>
      {queues.map((q) => (
        <button
          key={q.id}
          type="button"
          role="row"
          onClick={() => onSelect(q.id)}
          className="grid w-full grid-cols-[1fr_6rem_9rem] items-center gap-3 border-b border-[var(--line)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--bg-inset)] sm:px-5"
        >
          <span role="cell" className="min-w-0">
            <span className="type-ui block truncate text-[var(--text)]">{q.name}</span>
            {q.description ? (
              <span className="type-meta block truncate">{q.description}</span>
            ) : null}
          </span>
          <span role="cell">
            <StatusChip tone={q.status === "active" ? "live" : "neutral"}>
              {queueStatusLabel(q.status)}
            </StatusChip>
          </span>
          <span role="cell" className="type-meta">
            {q.created_at ? formatRelativeTime(q.created_at) : "—"}
          </span>
        </button>
      ))}
    </div>
  );
}

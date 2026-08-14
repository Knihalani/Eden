/**
 * Typed client for ``/orgs/{org}/labeling/*`` — human-in-the-loop
 * annotation queues. Backs the `/labeling` queue-list page (FEAT-82)
 * and the `/labeling/annotate` keyboard-driven work surface
 * (FEAT-83). See ``src/eden/api/routes/labeling.py`` /
 * ``src/eden/evaluation/labeling.py`` for the backend contract.
 */
import { fetchApi } from "@/lib/api/core";

export const LABELING_LIST_LIMIT = 100;

export function clampLabelingLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) return LABELING_LIST_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), LABELING_LIST_LIMIT);
}

function labelingPath(orgId: string, suffix: string): string {
  return `/orgs/${orgId}/labeling/${suffix.replace(/^\//, "")}`;
}

// ── F50 kanban queues ───────────────────────────────────────────

export type LabelingQueue = {
  id: string;
  org_id: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  status: string;
  created_at: string;
};

export type LabelingQueuesResponse = {
  queues: LabelingQueue[];
  total: number;
};

// ── Items (basic queue) ─────────────────────────────────────────

export type LabelingItemListEntry = {
  id: string;
  prompt: string;
  context: string | null;
  tags: string[];
  source: string;
  created_at: string;
  annotations_count: number;
};

export type LabelingItemsListResponse = {
  items: LabelingItemListEntry[];
  total: number;
};

/** Full item shape returned by `pop` — includes payload/label_schema/source refs. */
export type LabelingItem = {
  id: string;
  org_id: string;
  payload: Record<string, unknown>;
  label_schema: Record<string, unknown>;
  prompt: string | null;
  status: string;
  tags: string[];
  annotations_required: number;
  required_skills: string[];
  source_trace_id: string | null;
  source_span_id: string | null;
  source_dataset_id: string | null;
  source_synthetic_qa_id: string | null;
  assigned_to: string | null;
};

export type LabelingPopResponse = {
  items: LabelingItem[];
};

export type AnnotateRequestBody = {
  item_id: string;
  label: unknown;
  confidence?: number;
  notes?: string | null;
  time_spent_ms?: number | null;
  skills_exercised?: string[];
};

export type AnnotationResponse = {
  id: string;
  org_id: string;
  item_id: string;
  annotator_id: string;
  label: unknown;
  confidence: number;
  notes: string | null;
  time_spent_ms: number | null;
  skills_exercised: string[];
  created_at: string;
  updated_at: string;
};

export type SkipRequestBody = {
  item_id: string;
  reason?: string | null;
};

export type BulkSkipRequestBody = {
  item_ids: string[];
  reason?: string | null;
};

export type LabelingKanbanStatus = "todo" | "in_progress" | "done" | "skipped";

export type LabelingKanbanItem = {
  id: string;
  prompt: string | null;
  payload: Record<string, unknown>;
  kanban_status: LabelingKanbanStatus;
  tags: string[];
  created_at: string;
};

export type LabelingKanbanBoard = Record<LabelingKanbanStatus, LabelingKanbanItem[]>;

export type LabelingQueueAgreement = {
  kappa?: number;
  n?: number;
  agreement_rate?: number;
};

export type LabelingQueueBoardResponse = {
  queue_id: string;
  board: LabelingKanbanBoard;
};

export type LabelingQueueAgreementResponse = {
  queue_id: string;
  iaa: LabelingQueueAgreement;
};

/** Per-item agreement entry — 2 annotators gives `kappa` + `agreement`; N>2 gives `agreement` only. */
export type LabelingPerItemAgreement = {
  kappa?: number;
  agreement?: number;
  annotations_count?: number;
  annotations_required?: number;
};

export type LabelingAgreementReport = {
  kappa: number;
  alpha: number;
  overall_agreement: number;
  item_count: number;
  annotation_count: number;
  per_item: Record<string, LabelingPerItemAgreement>;
  per_pair: Record<string, { kappa: number; agreement: number; n: number }>;
};

export const labelingApi = {
  /** `GET /queues` — F50 kanban queues for the queue-list table. */
  listQueues: (orgId: string) =>
    fetchApi<LabelingQueuesResponse>(labelingPath(orgId, "queues")),

  /** `GET /queues/{id}/agreement` — Cohen's kappa from dual-labeled items in a queue. */
  queueAgreement: (orgId: string, queueId: string) =>
    fetchApi<LabelingQueueAgreementResponse>(
      labelingPath(orgId, `queues/${encodeURIComponent(queueId)}/agreement`),
    ),

  /** `GET /queues/{id}/board` — F50 kanban columns for a queue. */
  queueBoard: (orgId: string, queueId: string) =>
    fetchApi<LabelingQueueBoardResponse>(
      labelingPath(orgId, `queues/${encodeURIComponent(queueId)}/board`),
    ),

  /** `POST /queues/{id}/move` — move a kanban card to another column. */
  moveItem: (
    orgId: string,
    queueId: string,
    itemId: string,
    status: LabelingKanbanStatus,
  ) =>
    fetchApi<{ moved: boolean; item_id: string; status: string }>(
      labelingPath(orgId, `queues/${encodeURIComponent(queueId)}/move`),
      {
        method: "POST",
        body: JSON.stringify({ item_id: itemId, status }),
      },
    ),

  /** `GET /items` — org-wide item list with annotation counts (the "Unassigned items" panel source). */
  listItems: (orgId: string, params?: { limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set("limit", String(clampLabelingLimit(params.limit)));
    if (params?.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return fetchApi<LabelingItemsListResponse>(
      labelingPath(orgId, "items") + (qs ? `?${qs}` : ""),
    );
  },

  /**
   * `GET /agreement` — org-wide inter-annotator-agreement report. `per_item[id].agreement`
   * only exists for items with 2+ annotations; drives the disagreement-first sort.
   */
  agreement: (orgId: string, itemIds?: string[]) => {
    const q = new URLSearchParams();
    for (const id of itemIds ?? []) q.append("item_ids", id);
    const qs = q.toString();
    return fetchApi<LabelingAgreementReport>(
      labelingPath(orgId, "agreement") + (qs ? `?${qs}` : ""),
    );
  },

  /** `GET /queue/{user_id}` — pop (and lease) the next N pending items for an annotator. */
  popQueue: (
    orgId: string,
    userId: string,
    limit = 5,
    strategy: "fifo" | "active_learning" = "fifo",
  ) => {
    const q = new URLSearchParams({ limit: String(limit), strategy });
    return fetchApi<LabelingPopResponse>(
      labelingPath(orgId, `queue/${encodeURIComponent(userId)}?${q.toString()}`),
    );
  },

  /** `POST /annotate` — submit (or revise) an annotation; releases the item's lease. */
  annotate: (orgId: string, body: AnnotateRequestBody) =>
    fetchApi<AnnotationResponse>(labelingPath(orgId, "annotate"), {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** `POST /skip` — mark an item un-labelable and release the lease. */
  skip: (orgId: string, body: SkipRequestBody) =>
    fetchApi<{ skipped: boolean }>(labelingPath(orgId, "skip"), {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** `POST /skip/bulk` — mark multiple items un-labelable in one request. */
  skipBulk: (orgId: string, body: BulkSkipRequestBody) =>
    fetchApi<{ skipped: boolean; skipped_count: number }>(
      labelingPath(orgId, "skip/bulk"),
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  /** `POST /items/{id}/escalate` — bump annotations_required and re-queue (FEAT-119). */
  escalate: (orgId: string, itemId: string) =>
    fetchApi<LabelingItem>(
      labelingPath(orgId, `items/${encodeURIComponent(itemId)}/escalate`),
      { method: "POST" },
    ),

  /**
   * `GET /export` — approved annotations as JSONL (plain text).
   * Uses ``stream: true`` so fetchApi returns a Blob instead of JSON.
   */
  exportJsonl: async (
    orgId: string,
    params?: {
      status?: "pending" | "in_progress" | "completed" | "skipped";
      limit?: number;
    },
  ): Promise<string> => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.limit != null) q.set("limit", String(params.limit));
    const qs = q.toString();
    const blob = await fetchApi<Blob>(
      labelingPath(orgId, "export") + (qs ? `?${qs}` : ""),
      { stream: true },
    );
    return blob.text();
  },
};

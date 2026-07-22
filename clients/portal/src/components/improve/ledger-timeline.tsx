"use client";

import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type LedgerEntryRow = {
  id: string;
  kind: string;
  title: string;
  agentId?: string | null;
  actor?: string | null;
  status?: string | null;
  createdAt?: string | null;
  refs?: Record<string, unknown>;
  raw?: unknown;
};

export type LedgerTimelineProps = {
  rows: LedgerEntryRow[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  className?: string;
};

export function LedgerTimeline({
  rows,
  selectedId,
  onSelect,
  className,
}: LedgerTimelineProps) {
  const columns: DataTableColumn<LedgerEntryRow>[] = [
    {
      key: "when",
      header: "When",
      cell: (row) =>
        row.createdAt ? (
          <span title={new Date(row.createdAt).toISOString()}>
            {formatRelativeTime(row.createdAt)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "kind",
      header: "Kind",
      cell: (row) => <StatusBadge status={row.kind} />,
    },
    {
      key: "title",
      header: "Title",
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-[var(--text-primary)]">
            {row.title}
          </div>
          <div className="font-mono text-xs text-[var(--text-muted)]">
            {row.id}
          </div>
        </div>
      ),
    },
    {
      key: "agent",
      header: "Agent",
      cell: (row) => row.agentId ?? "—",
    },
    {
      key: "status",
      header: "Status",
      cell: (row) =>
        row.status ? <StatusBadge status={row.status} /> : <span>—</span>,
    },
  ];

  return (
    <div className={cn(className)} data-testid="ledger-timeline">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        highlightRowId={selectedId}
        onRowClick={(row) => onSelect?.(row.id)}
      />
    </div>
  );
}

/** Normalize learnApi ledger payloads into timeline rows. */
export function normalizeLedgerEntries(
  data: unknown,
  lockedAgentId?: string,
): LedgerEntryRow[] {
  if (data == null) return [];

  if (Array.isArray(data)) {
    return data.map((item, i) => entryFromUnknown(item, i, lockedAgentId));
  }

  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.entries)) {
      return obj.entries.map((item, i) =>
        entryFromUnknown(item, i, lockedAgentId),
      );
    }
    if (Array.isArray(obj.ledgers)) {
      return obj.ledgers.flatMap((ledger, i) => {
        const L = ledger as Record<string, unknown>;
        const agentId =
          (typeof L.agent_id === "string" && L.agent_id) ||
          (typeof L.agentId === "string" && L.agentId) ||
          lockedAgentId;
        if (L.entries && Array.isArray(L.entries)) {
          return L.entries.map((item, j) =>
            entryFromUnknown(item, i * 1000 + j, agentId),
          );
        }
        return [entryFromUnknown(ledger, i, agentId)];
      });
    }
    // Agent getLedger: { ledger: { key: value } } or nested entries
    const ledger = obj.ledger ?? obj;
    if (ledger && typeof ledger === "object" && !Array.isArray(ledger)) {
      const L = ledger as Record<string, unknown>;
      if (Array.isArray(L.entries)) {
        return L.entries.map((item, i) =>
          entryFromUnknown(item, i, lockedAgentId),
        );
      }
      return Object.entries(L).map(([key, value], i) => {
        if (value && typeof value === "object") {
          return entryFromUnknown(
            { id: key, ...(value as object) },
            i,
            lockedAgentId,
          );
        }
        return {
          id: key,
          kind: "note",
          title: typeof value === "string" ? value : key,
          agentId: lockedAgentId,
          raw: value,
        };
      });
    }
  }

  return [];
}

function entryFromUnknown(
  item: unknown,
  index: number,
  agentId?: string,
): LedgerEntryRow {
  if (item == null || typeof item !== "object") {
    return {
      id: `entry_${index}`,
      kind: "note",
      title: String(item ?? "Entry"),
      agentId,
      raw: item,
    };
  }
  const o = item as Record<string, unknown>;
  const id = String(
    o.id ?? o.entry_id ?? o.entryId ?? o.key ?? `entry_${index}`,
  );
  const kind = String(o.kind ?? o.type ?? o.event ?? "note");
  const title = String(
    o.title ?? o.summary ?? o.message ?? o.description ?? id,
  );
  return {
    id,
    kind,
    title,
    agentId:
      (typeof o.agent_id === "string" && o.agent_id) ||
      (typeof o.agentId === "string" && o.agentId) ||
      agentId,
    actor:
      (typeof o.actor === "string" && o.actor) ||
      (typeof o.created_by === "string" && o.created_by) ||
      null,
    status:
      (typeof o.status === "string" && o.status) ||
      (typeof o.state === "string" && o.state) ||
      null,
    createdAt:
      (typeof o.created_at === "string" && o.created_at) ||
      (typeof o.createdAt === "string" && o.createdAt) ||
      (typeof o.ts === "string" && o.ts) ||
      null,
    refs:
      o.refs && typeof o.refs === "object"
        ? (o.refs as Record<string, unknown>)
        : undefined,
    raw: item,
  };
}

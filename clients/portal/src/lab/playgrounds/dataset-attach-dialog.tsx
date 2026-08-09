"use client";

import Link from "next/link";
import { Panel } from "@/components/ds/primitives";
import { useOrgQuery } from "@/hooks/use-api-query";
import { SHELL_QUERY } from "@/lib/portal-query";
import { datasetsApi, type Dataset } from "@/lib/api/resources";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { EmptyState } from "@/lab/lab-ui";

export function DatasetAttachDialog({
  orgId,
  onClose,
  onSelect,
}: {
  orgId: string;
  onClose: () => void;
  onSelect: (dataset: Dataset) => void;
}) {
  const listQuery = useOrgQuery(
    ["datasets", "list", orgId] as const,
    orgId,
    () => datasetsApi.list(orgId),
    SHELL_QUERY,
  );

  const datasets = listQuery.data?.datasets ?? [];

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Attach dataset"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Panel className="flex max-h-[min(32rem,85vh)] w-full max-w-lg flex-col !p-0">
        <div className="space-y-1 border-b border-[var(--line)] px-5 py-4">
          <p className="type-ui text-[var(--text)]">Attach dataset</p>
          <p className="type-meta">
            Choose a Dataset Hub dataset to load rows into this playground run.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {listQuery.isError ? (
            <div className="px-3 py-2">
              <QueryErrorPanel
                error={listQuery.error}
                onRetry={() => void listQuery.refetch()}
              />
            </div>
          ) : listQuery.isLoading ? (
            <QueryLoadingPanel label="Loading datasets…" />
          ) : datasets.length === 0 ? (
            <EmptyState
              compact
              title="No datasets yet"
              body="Create a dataset in Evals, then attach it here to run the matrix across labeled rows."
              action={
                <Link href="/evals?mode=datasets" className="ds-btn ds-btn-primary ds-btn-sm">
                  Open Datasets
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {datasets.map((ds) => (
                <li key={ds.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    onClick={() => onSelect(ds)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="type-ui truncate text-[var(--text)]">{ds.name}</p>
                      {ds.description ? (
                        <p className="type-meta mt-0.5 truncate">{ds.description}</p>
                      ) : null}
                    </div>
                    <span className="type-meta shrink-0 tabular-nums">
                      {ds.row_count} row{ds.row_count === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </Panel>
    </div>
  );
}

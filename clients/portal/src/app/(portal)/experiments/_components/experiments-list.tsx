"use client";

import Link from "next/link";
import { ExternalLink, FlaskConical, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/error-state";
import { InfiniteDataTable } from "@/components/portal-os";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import type { ExperimentRow } from "./types";

type ExperimentsListProps = {
  rows: ExperimentRow[];
  loading: boolean;
  loadError: string | null;
  runError: string | null;
  selected: Set<string>;
  runningId: string | null;
  onLoad: () => void;
  onDismissRunError: () => void;
  onToggleSelect: (id: string) => void;
  onRun: (id: string) => void;
  onOpen: (id: string) => void;
};

export function ExperimentsList({
  rows,
  loading,
  loadError,
  runError,
  selected,
  runningId,
  onLoad,
  onDismissRunError,
  onToggleSelect,
  onRun,
  onOpen,
}: ExperimentsListProps) {
  return (
    <div
      className="min-w-0 border-y border-[var(--border-subtle)] py-space-2"
      data-wave-e4-list="table"
      data-wave11-mobile="cards"
      data-wave-e6-keyboard="experiments"
    >
      {runError && !loading ? (
        <ErrorState
          title="Could not start run"
          message={runError}
          className="mb-2"
          action={
            <Button
              onClick={onDismissRunError}
              variant="outline"
              className="h-8 min-h-11 md:min-h-8"
            >
              Dismiss
            </Button>
          }
        />
      ) : null}
      {loadError && !loading ? (
        <ErrorState
          title="Could not load experiments"
          message={loadError}
          action={
            <Button
              onClick={onLoad}
              variant="outline"
              className="h-8 min-h-11 md:min-h-8"
            >
              Try again
            </Button>
          }
        />
      ) : (
        <InfiniteDataTable
          loading={loading}
          rows={rows}
          rowKey={(r) => r.id}
          emptyTitle="No experiments yet"
          emptyDescription={U20_EMPTY_COPY.experiments}
          emptyIcon={FlaskConical}
          emptyAction={
            <div
              className="flex flex-wrap items-center justify-center gap-2"
              data-wave-e1-empty="experiments"
              data-wave-e4-empty="experiments"
            >
              <Button asChild className="h-8 min-h-11 md:min-h-8">
                <Link href="/evals?tab=datasets">Create dataset</Link>
              </Button>
              <Button
                asChild
                className="h-8 min-h-11 md:min-h-8"
                variant="outline"
              >
                <Link href="/traces">From traces</Link>
              </Button>
              <Button
                asChild
                className="h-8 min-h-11 md:min-h-8"
                variant="ghost"
              >
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Docs <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            </div>
          }
          columns={[
            {
              key: "select",
              header: "",
              className: "max-md:hidden",
              cell: (r) => (
                <span data-wave-e6-mobile="hide-bulk">
                  <Checkbox
                    checked={selected.has(r.id)}
                    onCheckedChange={() => onToggleSelect(r.id)}
                    aria-label={`Select ${r.name}`}
                    data-wave-e4-select={r.id}
                  />
                </span>
              ),
            },
            { key: "name", header: "Name", cell: (r) => r.name },
            { key: "status", header: "Status", cell: (r) => r.status },
            {
              key: "dataset",
              header: "Dataset",
              cell: (r) => (
                <Link
                  href={`/datasets/${r.dataset_id}`}
                  className="text-[var(--accent)] hover:underline"
                >
                  {r.dataset_id.slice(0, 8)}…
                </Link>
              ),
            },
            {
              key: "actions",
              header: "",
              align: "right",
              cell: (r) => (
                <div className="flex justify-end gap-1">
                  <Button
                    className="h-8 min-h-11 md:min-h-8"
                    variant="outline"
                    disabled={Boolean(runningId)}
                    loading={runningId === r.id}
                    onClick={() => onRun(r.id)}
                    data-wave-e4-run={r.id}
                  >
                    <Play className="h-3 w-3" />{" "}
                    {runningId === r.id ? "Running…" : "Run"}
                  </Button>
                  <Button
                    className="h-8 min-h-11 md:min-h-8"
                    variant="ghost"
                    onClick={() => onOpen(r.id)}
                    data-wave-e4-open={r.id}
                  >
                    Compare
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

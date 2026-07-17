"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import {
  ArrowLeft,
  Database,
  RefreshCw,
  Plus,
  Camera,
  Upload,
  FlaskConical,
} from "lucide-react";
import { datasetsApi, offlineExperimentsApi, type DatasetRow, type DatasetColumn } from "@/lib/api";
import { VirtualizedList } from "@/components/portal-os/VirtualizedList";

interface DatasetDetail {
  id: string;
  name: string;
  description?: string;
  columns: DatasetColumn[];
  rows: DatasetRow[];
  snapshots?: Array<{ id: string; version: number; row_count: number; created_at: string }>;
}

export default function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<DatasetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newRow, setNewRow] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rowId: string; key: string } | null>(null);
  const [editValue, setEditValue] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg?.id || !id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await datasetsApi.get(currentOrg.id, id);
      setData(res as DatasetDetail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load dataset";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Dataset" />;

  const addRow = async () => {
    if (!newRow.trim() || !currentOrg?.id || !id) return;
    setSubmitting(true);
    try {
      let values: Record<string, unknown> = {};
      try {
        values = JSON.parse(newRow);
      } catch {
        values = { value: newRow.trim() };
      }
      await datasetsApi.addRow(currentOrg.id, id, values);
      toast.success("Row added");
      setNewRow("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add row");
    } finally {
      setSubmitting(false);
    }
  };

  const saveCell = async (row: DatasetRow, key: string, value: string) => {
    if (!currentOrg?.id || !id) return;
    try {
      await datasetsApi.updateRow(currentOrg.id, id, row.id, {
        values: { ...(row.values || {}), [key]: value },
      });
      setEditing(null);
      toast.success("Cell saved");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  const snapshot = async () => {
    if (!currentOrg?.id || !id) return;
    try {
      await datasetsApi.createSnapshot(currentOrg.id, id);
      toast.success("Snapshot created");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Snapshot failed");
    }
  };

  const runExperiment = async () => {
    if (!currentOrg?.id || !id || !data) return;
    try {
      const res = await offlineExperimentsApi.create(currentOrg.id, {
        name: `Exp · ${data.name}`,
        dataset_id: id,
      });
      const expId = String(res.experiment?.id || "");
      toast.success("Experiment created from dataset");
      window.location.href = expId
        ? `/evals?tab=experiments&experimentId=${expId}`
        : "/evals?tab=experiments";
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create experiment failed");
    }
  };

  const onImportFile = async (file: File) => {
    if (!currentOrg?.id || !id) return;
    setImportProgress("Reading file…");
    try {
      const text = await file.text();
      setImportProgress("Parsing…");
      let rows: Record<string, unknown>[] = [];
      const columnMap: Record<string, string> = {};
      if (file.name.endsWith(".jsonl") || file.name.endsWith(".json")) {
        if (text.trim().startsWith("[")) {
          rows = JSON.parse(text) as Record<string, unknown>[];
        } else {
          rows = text
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        }
      } else {
        // CSV: header row + values
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        const headers = (lines[0] || "").split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
        headers.forEach((h) => {
          columnMap[h] = h;
        });
        rows = lines.slice(1).map((line) => {
          const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
          const obj: Record<string, unknown> = {};
          headers.forEach((h, i) => {
            obj[h] = cols[i] ?? "";
          });
          return obj;
        });
      }
      setImportProgress(`Importing ${rows.length} rows…`);
      const res = await datasetsApi.importRows(currentOrg.id, id, {
        rows,
        column_map: Object.keys(columnMap).length ? columnMap : undefined,
      });
      setImportProgress(null);
      toast.success(`Imported ${res.inserted} rows`);
      load();
    } catch (e) {
      setImportProgress(null);
      toast.error(e instanceof Error ? e.message : "Import failed");
    }
  };

  const colKeys =
    data?.columns?.length
      ? data.columns.map((c) => c.id || (c as { name?: string }).name || "col")
      : data?.rows?.[0]?.values
        ? Object.keys(data.rows[0].values)
        : ["input", "expected_output"];

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Data · Dataset"
        title={data?.name || "Dataset"}
        subtitle={data?.description || (loading ? "Loading…" : "Spreadsheet edit · import · snapshots.")}
        icon={Database}
        actions={
          <>
            <Link
              href="/evals?tab=datasets"
              aria-label="Back to datasets list"
              className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Link>
            <Button onClick={snapshot} variant="outline" size="sm">
              <Camera className="h-3.5 w-3.5" /> Snapshot
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" /> Import
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.json,.jsonl,text/csv,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImportFile(f);
                e.target.value = "";
              }}
            />
            <Button onClick={runExperiment} variant="outline" size="sm">
              <FlaskConical className="h-3.5 w-3.5" /> New experiment
            </Button>
            <Button onClick={load} variant="outline" size="sm" disabled={loading} loading={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />

      {importProgress ? (
        <p className="mb-3 text-sm text-[var(--accent)]">{importProgress}</p>
      ) : null}

      {error && !loading ? (
        <ErrorState
          title="Could not load dataset"
          message={error}
          action={
            <Button onClick={load} variant="outline" size="sm">
              Try again
            </Button>
          }
        />
      ) : null}

      {!error ? (
        <>
          {(data?.snapshots?.length ?? 0) > 0 ? (
            <Card className="mb-3 p-3">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Snapshots
              </div>
              <ul className="flex flex-wrap gap-2 text-xs">
                {data!.snapshots!.map((s) => (
                  <li
                    key={s.id}
                    className="rounded border border-[var(--border-default)] px-2 py-1"
                  >
                    v{s.version} · {s.row_count} rows ·{" "}
                    {s.created_at ? new Date(s.created_at).toLocaleString() : "—"}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="mb-3 space-y-3 p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Add row
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder='{"input": "…", "expected_output": "…"}'
                value={newRow}
                onChange={(e) => setNewRow(e.target.value)}
                className="flex-1 font-mono text-xs"
                disabled={submitting}
              />
              <Button onClick={addRow} disabled={!newRow.trim() || submitting} loading={submitting}>
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Click any cell to edit inline. Promote traces from the traces hub with{" "}
              <code className="text-[var(--accent)]">?promote_trace=</code>.
            </p>
          </Card>

          <Card className="overflow-x-auto p-2">
            <div className="mb-2 flex items-center justify-between gap-2 px-2 text-xs text-[var(--text-muted)]">
              <span>
                {(data?.rows?.length ?? 0).toLocaleString()} rows
                {(data?.rows?.length ?? 0) > 40 ? " · virtualized" : ""}
              </span>
              <div className="hidden min-w-0 flex-1 gap-2 overflow-hidden sm:flex">
                {colKeys.map((k) => (
                  <span key={k} className="truncate font-medium">
                    {k}
                  </span>
                ))}
              </div>
            </div>
            {(data?.rows?.length ?? 0) > 0 ? (
              <VirtualizedList
                items={data!.rows}
                rowKey={(r) => r.id}
                rowHeight={44}
                className="min-w-[480px]"
              >
                {(r) => (
                  <div className="flex items-stretch gap-1 border-b border-[var(--border-subtle)] px-1 py-0.5 text-sm">
                    {colKeys.map((k) => {
                      const isEdit = editing?.rowId === r.id && editing.key === k;
                      const val = String(r.values?.[k] ?? "");
                      return (
                        <div key={k} className="min-w-0 flex-1 p-0.5">
                          {isEdit ? (
                            <Input
                              autoFocus
                              className="h-8 font-mono text-xs"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={() => void saveCell(r, k, editValue)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveCell(r, k, editValue);
                                if (e.key === "Escape") setEditing(null);
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="w-full truncate rounded px-1 py-1 text-left font-mono text-xs hover:bg-[var(--surface-raised)]"
                              onClick={() => {
                                setEditing({ rowId: r.id, key: k });
                                setEditValue(val);
                              }}
                            >
                              {val || "—"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <div className="w-28 shrink-0 p-2 text-xs text-[var(--text-muted)]">
                      {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                    </div>
                  </div>
                )}
              </VirtualizedList>
            ) : null}
            {!loading && !(data?.rows?.length) ? (
              <p className="p-4 text-sm text-[var(--text-muted)]">
                No rows yet. Import CSV/JSONL or add a row above.
              </p>
            ) : null}
          </Card>
        </>
      ) : null}
    </PageContent>
  );
}

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { datasetsApi, offlineExperimentsApi, type DatasetRow } from "@/lib/api";
import { resolveColumns, type DatasetDetail } from "./dataset-cells";

export function useDatasetDetail(id: string | undefined) {
  const { currentOrg } = useOrg();
  const router = useRouter();
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
  const [selectedRowId, setSelectedRowId] = useState<string | undefined>();

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
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, id]);

  useEffect(() => {
    load();
  }, [load]);

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
      if (key === "input") {
        await datasetsApi.updateRow(currentOrg.id, id, row.id, {
          input: value,
          values: { ...(row.values || {}) },
        });
      } else if (key === "expected_output") {
        await datasetsApi.updateRow(currentOrg.id, id, row.id, {
          expected_output: value,
          values: { ...(row.values || {}) },
        });
      } else {
        await datasetsApi.updateRow(currentOrg.id, id, row.id, {
          values: { ...(row.values || {}), [key]: value },
        });
      }
      setEditing(null);
      toast.success("Cell saved");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  const snapshot = async () => {
    if (!currentOrg?.id || !id || error) return;
    try {
      await datasetsApi.createSnapshot(currentOrg.id, id);
      toast.success("Snapshot created");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Snapshot failed");
    }
  };

  const startExperiment = async () => {
    if (!currentOrg?.id || !id || !data || error) return;
    try {
      const res = await offlineExperimentsApi.create(currentOrg.id, {
        name: `Exp · ${data.name}`,
        dataset_id: id,
      });
      const expId = String(res.experiment?.id || "");
      toast.success("Experiment created from dataset");
      router.push(
        expId
          ? `/evals?tab=experiments&experimentId=${expId}`
          : "/evals?tab=experiments",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create experiment failed");
    }
  };

  const onImportFile = async (file: File) => {
    if (!currentOrg?.id || !id || error) return;
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

  const columns = resolveColumns(data);
  const canMutate = !error && !loading && Boolean(data);
  const selectedRow = data?.rows.find((r) => r.id === selectedRowId) ?? null;

  return {
    currentOrg,
    fileRef,
    data,
    loading,
    error,
    newRow,
    setNewRow,
    submitting,
    importProgress,
    editing,
    setEditing,
    editValue,
    setEditValue,
    selectedRowId,
    setSelectedRowId,
    selectedRow,
    columns,
    canMutate,
    load,
    addRow,
    saveCell,
    snapshot,
    startExperiment,
    onImportFile,
  };
}

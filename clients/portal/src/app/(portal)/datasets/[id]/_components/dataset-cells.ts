import type { DatasetRow, DatasetColumn } from "@/lib/api";

export interface DatasetDetail {
  id: string;
  name: string;
  description?: string;
  columns: DatasetColumn[];
  rows: DatasetRow[];
  snapshots?: Array<{ id: string; version: number; row_count: number; created_at: string }>;
}

export type ColDef = { key: string; label: string };

export function cellValue(row: DatasetRow, key: string): string {
  if (key === "input" && row.input != null && String(row.input).length > 0) {
    return String(row.input);
  }
  if (
    key === "expected_output" &&
    row.expected_output != null &&
    String(row.expected_output).length > 0
  ) {
    return String(row.expected_output);
  }
  const fromValues = row.values?.[key];
  if (fromValues != null && String(fromValues).length > 0) return String(fromValues);
  if (key === "input") return String(row.input ?? "");
  if (key === "expected_output") return String(row.expected_output ?? "");
  return "";
}

export function resolveColumns(data: DatasetDetail | null): ColDef[] {
  if (data?.columns?.length) {
    return data.columns.map((c) => ({
      key: c.id || c.name || "col",
      label: c.name || c.id || "col",
    }));
  }
  const first = data?.rows?.[0];
  if (first?.values && Object.keys(first.values).length > 0) {
    const keys = Object.keys(first.values);
    const hasTopLevel =
      (first.input != null && String(first.input).length > 0) ||
      (first.expected_output != null && String(first.expected_output).length > 0);
    if (hasTopLevel) {
      return [
        { key: "input", label: "input" },
        { key: "expected_output", label: "expected_output" },
        ...keys
          .filter((k) => k !== "input" && k !== "expected_output")
          .map((k) => ({ key: k, label: k })),
      ];
    }
    return keys.map((k) => ({ key: k, label: k }));
  }
  return [
    { key: "input", label: "input" },
    { key: "expected_output", label: "expected_output" },
  ];
}

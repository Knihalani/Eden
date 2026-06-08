/**
 * CSV / JSONL / PNG export helpers (Phase 7.2 C8).
 *
 * Used by every table in the observability page: traces,
 * judge scores, audit log, etc. The download is triggered by
 * a hidden anchor with a data: URL — works in any modern browser
 * without server round trips.
 */

export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns?: Array<keyof T>,
): string {
  if (rows.length === 0) return "";
  const cols = (columns ?? Object.keys(rows[0])) as Array<keyof T>;
  const header = cols.map(escapeCsvCell).join(",");
  const body = rows
    .map((row) =>
      cols.map((c) => escapeCsvCell(row[c])).join(","),
    )
    .join("\n");
  return `${header}\n${body}`;
}

function escapeCsvCell(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  // Quote if it contains comma, quote, newline, or starts/ends with whitespace
  if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toJsonl<T>(rows: T[]): string {
  return rows.map((r) => JSON.stringify(r, defaultReplacer)).join("\n");
}

function defaultReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function downloadFile(
  filename: string,
  content: string | Blob,
  mimeType: string = "text/plain;charset=utf-8",
): void {
  if (typeof window === "undefined") return;
  const blob = content instanceof Blob
    ? content
    : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns?: Array<keyof T>,
): void {
  const csv = toCsv(rows, columns);
  downloadFile(filename.endsWith(".csv") ? filename : `${filename}.csv`, csv, "text/csv");
}

export function downloadJsonl<T>(filename: string, rows: T[]): void {
  const body = toJsonl(rows);
  const fn = filename.endsWith(".jsonl") ? filename : `${filename}.jsonl`;
  downloadFile(fn, body, "application/x-ndjson");
}

/**
 * Export a DOM element to PNG using html-to-image. Lazy-loads
 * the library to keep the bundle slim; callers must install it
 * via `npm install html-to-image`.
 */
export async function downloadPng(
  filename: string,
  element: HTMLElement,
): Promise<void> {
  // html-to-image is a soft dependency — silently no-op if not
  // installed. We use a string-based dynamic import so TypeScript
  // doesn't require the module's types.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await (Function("m", "return import(m)") as any)("html-to-image");
    const dataUrl = await mod.toPng(element, {
      backgroundColor: "#03060A",  // var(--bg-base)
      pixelRatio: 2,
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename.endsWith(".png") ? filename : `${filename}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    console.warn("PNG export failed (html-to-image not installed?)", err);
  }
}

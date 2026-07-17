/**
 * CSV / JSONL / PNG / XLSX export helpers (Phase 7.2 C8 + W22).
 *
 * Used by every table in the observability page: traces,
 * judge scores, audit log, etc. The download is triggered by
 * a hidden anchor with a data: URL — works in any modern browser
 * without server round trips.
 */

import { strToU8, zipSync } from "fflate";

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

/** Escape XML text for SpreadsheetML / OOXML shared strings. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a minimal XLSX (Office Open XML) blob via fflate.
 * One sheet; shared strings for cell text.
 */
export function toXlsxBlob<T extends Record<string, unknown>>(
  rows: T[],
  columns?: Array<keyof T>,
): Blob {
  if (rows.length === 0) {
    return new Blob([], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }
  const cols = (columns ?? (Object.keys(rows[0]!) as Array<keyof T>));
  const shared: string[] = [];
  const indexOf = (s: string) => {
    const i = shared.indexOf(s);
    if (i >= 0) return i;
    shared.push(s);
    return shared.length - 1;
  };

  const cellRef = (r: number, c: number) => {
    let col = "";
    let n = c;
    while (n >= 0) {
      col = String.fromCharCode((n % 26) + 65) + col;
      n = Math.floor(n / 26) - 1;
    }
    return `${col}${r}`;
  };

  const sheetRows: string[] = [];
  // Header
  sheetRows.push(
    `<row r="1">${cols
      .map((c, i) => {
        const si = indexOf(String(c));
        return `<c r="${cellRef(1, i)}" t="s"><v>${si}</v></c>`;
      })
      .join("")}</row>`,
  );
  rows.forEach((row, ri) => {
    const r = ri + 2;
    sheetRows.push(
      `<row r="${r}">${cols
        .map((c, i) => {
          const raw = row[c];
          if (raw == null) return `<c r="${cellRef(r, i)}"/>`;
          if (typeof raw === "number" && Number.isFinite(raw)) {
            return `<c r="${cellRef(r, i)}"><v>${raw}</v></c>`;
          }
          const si = indexOf(
            typeof raw === "string" ? raw : JSON.stringify(raw),
          );
          return `<c r="${cellRef(r, i)}" t="s"><v>${si}</v></c>`;
        })
        .join("")}</row>`,
    );
  });

  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">
${shared.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join("")}
</sst>`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${sheetRows.join("")}</sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const zipped = zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(wbRels),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    "xl/sharedStrings.xml": strToU8(sharedXml),
  });
  // Copy into a fresh ArrayBuffer-backed Uint8Array for BlobPart typing.
  const copy = new Uint8Array(zipped.byteLength);
  copy.set(zipped);
  return new Blob([copy], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function downloadXlsx<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns?: Array<keyof T>,
): void {
  const blob = toXlsxBlob(rows, columns);
  const fn = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  downloadFile(fn, blob, blob.type);
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
      backgroundColor: "#03060A",  // var(--bg-base — hardcoded: html-to-image can't read CSS vars
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

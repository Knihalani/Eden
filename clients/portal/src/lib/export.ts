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
 * Export a DOM element to PNG using html-to-image when available,
 * otherwise rasterize an inner SVG with inlined computed styles
 * (required for Recharts — naive clones produce blank/shifted PNGs).
 */
export async function downloadPng(
  filename: string,
  element: HTMLElement,
  opts?: { backgroundColor?: string },
): Promise<void> {
  const bg = opts?.backgroundColor ?? "#0a0a0a";
  const fn = filename.endsWith(".png") ? filename : `${filename}.png`;

  try {
    const mod = await import("html-to-image");
    const dataUrl = await mod.toPng(element, {
      backgroundColor: bg,
      pixelRatio: 2,
      cacheBust: true,
      skipFonts: true,
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = fn;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  } catch {
    // Soft dependency / capture failure — SVG fallback.
  }

  await downloadSvgAsPng(fn, element, bg);
}

const SVG_STYLE_PROPS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
] as const;

function inlineSvgStyles(source: Element, target: Element) {
  if (source instanceof SVGElement && target instanceof SVGElement) {
    const cs = getComputedStyle(source);
    for (const prop of SVG_STYLE_PROPS) {
      const val = cs.getPropertyValue(prop);
      if (!val || val === "none" || val.includes("var(")) continue;
      target.setAttribute(prop, val);
    }
  }
  const sKids = Array.from(source.children);
  const tKids = Array.from(target.children);
  for (let i = 0; i < Math.min(sKids.length, tKids.length); i++) {
    inlineSvgStyles(sKids[i]!, tKids[i]!);
  }
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load SVG for PNG export"));
    img.src = src;
  });
}

/** Rasterize the primary SVG under `element` to a PNG download. */
export async function downloadSvgAsPng(
  filename: string,
  element: HTMLElement,
  backgroundColor = "#0a0a0a",
): Promise<void> {
  if (typeof window === "undefined") return;
  const svg =
    (element.querySelector("svg.recharts-surface") as SVGSVGElement | null) ??
    (element.querySelector(".recharts-wrapper svg") as SVGSVGElement | null) ??
    (element.querySelector("svg") as SVGSVGElement | null);
  if (!svg) {
    console.warn("PNG export failed: no SVG found in element");
    return;
  }

  const rect = svg.getBoundingClientRect();
  const width = Math.max(
    1,
    Math.ceil(rect.width || Number(svg.getAttribute("width")) || 640),
  );
  const height = Math.max(
    1,
    Math.ceil(rect.height || Number(svg.getAttribute("height")) || 280),
  );

  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineSvgStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;

  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = await loadImageEl(url);
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unsupported");
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(img, 0, 0, width, height);
    const pngUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = pngUrl;
    a.download = filename.endsWith(".png") ? filename : `${filename}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

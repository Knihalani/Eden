/**
 * CSV / JSONL / PNG export helpers (Phase 7.2 C8 — XLSX lives in export-xlsx.ts).
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

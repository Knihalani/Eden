import { createHash } from "node:crypto";
import { canonicalize, redact } from "@eden/ir";
import {
  GENESIS,
  hashesEqual,
  neutralizeCsvField,
  restoreCsvField,
  sanitizeJson,
  type VerifyResult,
} from "./audit-export";
import { Store } from "./store";

/**
 * Access-review columns. Sibling of AUDIT_COLUMNS — do not feed these into
 * hashPayload / the full dump. Old audit files must still verify.
 */
export const REVIEW_COLUMNS = [
  "seq",
  "who",
  "tool_id",
  "name",
  "version",
  "at",
  "workspace_id",
  "prev",
  "sha256",
] as const;

export type AccessReviewPayload = {
  seq: number;
  who: string;
  tool_id: string;
  name: string;
  version: string;
  at: number;
  workspace_id: string;
};

export type AccessReviewRecord = AccessReviewPayload & {
  prev: string;
  sha256: string;
};

const MAX_FIELD = 500;

function clip(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const cut = raw.length > MAX_FIELD ? raw.slice(0, MAX_FIELD) : raw;
  const redacted = redact(cut);
  return typeof redacted === "string" ? redacted.replace(/[\r\n]+/g, " ") : String(redacted ?? "").replace(/[\r\n]+/g, " ");
}

/** Who Approved: the org header if present, else the unbound operator. Never invent a person. */
export function actorOf(raw: string | null | undefined): string {
  const who = (raw ?? "").trim();
  return who ? clip(who) : "operator";
}

function payloadOf(row: AccessReviewRecord): AccessReviewPayload {
  return {
    seq: row.seq,
    who: row.who,
    tool_id: row.tool_id,
    name: row.name,
    version: row.version,
    at: row.at,
    workspace_id: row.workspace_id,
  };
}

/** Same algorithm as hashPayload: sha256(canonicalize(payload) + newline + prev). Own type. */
export function hashReviewPayload(payload: AccessReviewPayload, prev: string): string {
  return createHash("sha256")
    .update(canonicalize(payload) + "\n" + prev, "utf8")
    .digest("hex");
}

function collectRows(store: Store): Omit<AccessReviewPayload, "seq">[] {
  const rows: Omit<AccessReviewPayload, "seq">[] = [];
  const workspace = Store.WORKSPACE_ID;
  for (const t of store.tools()) {
    try {
      rows.push({
        who: actorOf(t.approved_by),
        tool_id: clip(t.id),
        name: clip(t.name),
        version: clip(t.version),
        at: Number(t.approved_at) || Number(t.created_at) || 0,
        workspace_id: workspace,
      });
    } catch {
      /* one bad tool must not sink the export */
    }
  }
  rows.sort((a, b) => a.at - b.at || a.tool_id.localeCompare(b.tool_id) || a.version.localeCompare(b.version));
  return rows;
}

export function chainReviewRecords(rows: Omit<AccessReviewPayload, "seq">[]): AccessReviewRecord[] {
  const out: AccessReviewRecord[] = [];
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const seq = i + 1;
    const payload: AccessReviewPayload = { ...rows[i]!, seq };
    const sha256 = hashReviewPayload(payload, prev);
    out.push({ ...payload, prev, sha256 });
    prev = sha256;
  }
  return out;
}

export function reviewRecordsFromStore(store: Store): AccessReviewRecord[] {
  return chainReviewRecords(collectRows(store));
}

function csvEscape(value: string): string {
  const safe = neutralizeCsvField(value);
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function payloadLine(r: AccessReviewRecord): Record<string, string | number> {
  return {
    seq: r.seq,
    who: r.who,
    tool_id: r.tool_id,
    name: r.name,
    version: r.version,
    at: r.at,
    workspace_id: r.workspace_id,
    prev: r.prev,
    sha256: r.sha256,
  };
}

export function serializeAccessReview(records: AccessReviewRecord[], format: "jsonl" | "csv"): string {
  if (format === "csv") {
    const header = REVIEW_COLUMNS.join(",");
    const lines = records.map((r) =>
      [
        String(r.seq),
        csvEscape(r.who),
        csvEscape(r.tool_id),
        csvEscape(r.name),
        csvEscape(r.version),
        String(r.at),
        csvEscape(r.workspace_id),
        r.prev,
        r.sha256,
      ].join(","),
    );
    return [header, ...lines].join("\n") + (records.length || header ? "\n" : "");
  }
  return records.map((r) => JSON.stringify(payloadLine(r))).join("\n") + (records.length ? "\n" : "");
}

/**
 * Tenant-bound export. A workspace id that is not this install's
 * (`Store.WORKSPACE_ID`) yields zero records — never another tenant's rows.
 */
export function exportAccessReview(store: Store, format: "jsonl" | "csv", workspace?: string | null): string {
  if (typeof workspace === "string" && workspace !== Store.WORKSPACE_ID) {
    return serializeAccessReview([], format);
  }
  return serializeAccessReview(reviewRecordsFromStore(store), format);
}

function recordFromUnknown(raw: unknown): AccessReviewRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const seq = Number(o.seq);
  const at = Number(o.at);
  if (!Number.isInteger(seq) || seq < 1) return null;
  if (!Number.isFinite(at)) return null;
  const prev = String(o.prev ?? "");
  const sha256 = String(o.sha256 ?? "");
  return {
    seq,
    who: String(o.who ?? ""),
    tool_id: String(o.tool_id ?? ""),
    name: String(o.name ?? ""),
    version: String(o.version ?? ""),
    at,
    workspace_id: String(o.workspace_id ?? ""),
    prev,
    sha256,
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let quoted = false;
  while (i < line.length) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): AccessReviewRecord[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]!).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const col = {
    seq: idx("seq"),
    who: idx("who"),
    tool_id: idx("tool_id"),
    name: idx("name"),
    version: idx("version"),
    at: idx("at"),
    workspace_id: idx("workspace_id"),
    prev: idx("prev"),
    sha256: idx("sha256"),
  };
  if (col.seq < 0 || col.who < 0 || col.prev < 0 || col.sha256 < 0) {
    throw new Error("csv header missing seq, who, prev, or sha256");
  }
  const cell = (row: string[], i: number) => restoreCsvField(i >= 0 ? (row[i] ?? "") : "");
  const records: AccessReviewRecord[] = [];
  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    const rec = recordFromUnknown({
      seq: cell(row, col.seq),
      who: cell(row, col.who),
      tool_id: cell(row, col.tool_id),
      name: cell(row, col.name),
      version: cell(row, col.version),
      at: cell(row, col.at),
      workspace_id: cell(row, col.workspace_id),
      prev: cell(row, col.prev),
      sha256: cell(row, col.sha256),
    });
    if (!rec) throw new Error("csv row is not an access-review record");
    records.push(rec);
  }
  return records;
}

function parseJsonl(text: string): AccessReviewRecord[] {
  const records: AccessReviewRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = sanitizeJson(JSON.parse(line));
    } catch {
      throw new Error("jsonl line is not JSON");
    }
    const rec = recordFromUnknown(parsed);
    if (!rec) throw new Error("jsonl line is not an access-review record");
    records.push(rec);
  }
  return records;
}

export function detectAccessReviewFormat(text: string): "jsonl" | "csv" {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return first.startsWith("seq,") || first.startsWith("seq,who") ? "csv" : "jsonl";
}

/** True when this text is the sibling review chain, not the full audit dump. */
export function isAccessReviewExport(text: string): boolean {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  if (!first) return false;
  if (first.startsWith("seq,")) {
    const cols = first.split(",").map((h) => h.trim());
    return cols.includes("who") && cols.includes("workspace_id");
  }
  try {
    const o = JSON.parse(first) as { who?: unknown; workspace_id?: unknown; kind?: unknown };
    return typeof o?.who === "string" && o.workspace_id != null && o.kind == null;
  } catch {
    return false;
  }
}

export function parseAccessReview(text: string, format?: "jsonl" | "csv"): AccessReviewRecord[] {
  const kind = format ?? detectAccessReviewFormat(text);
  return kind === "csv" ? parseCsv(text) : parseJsonl(text);
}

export function verifyAccessReview(text: string, format?: "jsonl" | "csv"): VerifyResult {
  let records: AccessReviewRecord[];
  try {
    records = parseAccessReview(text, format);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unreadable export" };
  }
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (!rec.prev || !rec.sha256) return { ok: false, reason: "missing prev" };
    if (rec.seq !== i + 1) return { ok: false, reason: `seq gap at ${rec.seq}` };
    if (!hashesEqual(rec.prev, prev)) return { ok: false, reason: `chain break at seq ${rec.seq}` };
    const expected = hashReviewPayload(payloadOf(rec), rec.prev);
    if (!hashesEqual(rec.sha256, expected)) return { ok: false, reason: `hash mismatch at seq ${rec.seq}` };
    prev = rec.sha256;
  }
  return { ok: true, n: records.length };
}

import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalize, redact } from "@eden/ir";
import type { Store } from "./store";

export const AUDIT_KINDS = ["approval", "version", "execution", "refusal"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** First record's `prev`. 64 hex zeros — not a real sha256 of a payload. */
export const GENESIS = "0".repeat(64);

export const AUDIT_COLUMNS = [
  "seq",
  "kind",
  "id",
  "at",
  "tool_id",
  "name",
  "version",
  "state",
  "verdict",
  "reason",
  "ok",
  "prev",
  "sha256",
] as const;

const KIND_ORDER: Record<AuditKind, number> = {
  approval: 0,
  version: 1,
  execution: 2,
  refusal: 3,
};

export type AuditPayload = {
  seq: number;
  kind: AuditKind;
  id: string;
  at: number;
  tool_id: string;
  name: string;
  version: string;
  state: string;
  verdict: string;
  reason: string;
  ok: string;
};

export type AuditRecord = AuditPayload & {
  prev: string;
  sha256: string;
};

export type VerifyOk = { ok: true; n: number };
export type VerifyFail = { ok: false; reason: string };
export type VerifyResult = VerifyOk | VerifyFail;

const MAX_FIELD = 500;

function clip(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const cut = raw.length > MAX_FIELD ? raw.slice(0, MAX_FIELD) : raw;
  const redacted = redact(cut);
  return typeof redacted === "string"
    ? redacted.replace(/[\r\n]+/g, " ")
    : String(redacted ?? "").replace(/[\r\n]+/g, " ");
}

function asKind(value: unknown): AuditKind | null {
  return AUDIT_KINDS.includes(value as AuditKind) ? (value as AuditKind) : null;
}

function payloadOf(row: AuditRecord): AuditPayload {
  return {
    seq: row.seq,
    kind: row.kind,
    id: row.id,
    at: row.at,
    tool_id: row.tool_id,
    name: row.name,
    version: row.version,
    state: row.state,
    verdict: row.verdict,
    reason: row.reason,
    ok: row.ok,
  };
}

export function hashPayload(payload: AuditPayload, prev: string): string {
  return createHash("sha256")
    .update(canonicalize(payload) + "\n" + prev, "utf8")
    .digest("hex");
}

export function hashesEqual(a: string, b: string): boolean {
  try {
    const left = Buffer.from(String(a), "hex");
    const right = Buffer.from(String(b), "hex");
    if (left.length !== 32 || right.length !== 32) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function collectRows(store: Store): Omit<AuditPayload, "seq">[] {
  const rows: Omit<AuditPayload, "seq">[] = [];
  const tools = store.tools();
  const names = new Map(tools.map((t) => [t.id, t.name]));

  for (const t of tools) {
    try {
      rows.push({
        kind: "approval",
        id: `approval:${t.id}:${t.version}`,
        at: Number(t.updated_at) || Number(t.created_at) || 0,
        tool_id: clip(t.id),
        name: clip(t.name),
        version: clip(t.version),
        state: clip(t.state),
        verdict: "",
        reason: "",
        ok: "",
      });
    } catch {
      /* one bad tool must not sink the export */
    }
    try {
      for (const v of store.programVersions(t.id)) {
        rows.push({
          kind: "version",
          id: `version:${v.tool_id}:${v.version}`,
          at: Number(v.created_at) || 0,
          tool_id: clip(v.tool_id),
          name: clip(names.get(v.tool_id) ?? t.name),
          version: clip(v.version),
          state: "",
          verdict: "",
          reason: "",
          ok: "",
        });
      }
    } catch {
      /* history is best-effort */
    }
  }

  for (const r of store.receipts()) {
    try {
      rows.push({
        kind: "execution",
        id: `execution:${r.id}`,
        at: Number(r.created_at) || 0,
        tool_id: clip(r.tool_id),
        name: clip(names.get(r.tool_id) ?? ""),
        version: clip(r.version),
        state: "",
        verdict: "",
        reason: "",
        ok: r.ok ? "1" : "0",
      });
    } catch {
      /* skip */
    }
  }

  for (const c of store.candidates()) {
    if (!c.refusal) continue;
    try {
      rows.push({
        kind: "refusal",
        id: `refusal:${c.id}`,
        at: Number(c.created_at) || 0,
        tool_id: clip(c.id),
        name: clip((c.sequence ?? []).join(" ")),
        version: "",
        state: "",
        verdict: clip(c.verdict),
        reason: clip(c.refusal.reason),
        ok: "",
      });
    } catch {
      /* skip */
    }
  }

  rows.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));
  return rows;
}

export function chainRecords(rows: Omit<AuditPayload, "seq">[]): AuditRecord[] {
  const out: AuditRecord[] = [];
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const seq = i + 1;
    const payload: AuditPayload = { ...rows[i]!, seq };
    const sha256 = hashPayload(payload, prev);
    out.push({ ...payload, prev, sha256 });
    prev = sha256;
  }
  return out;
}

export function recordsFromStore(store: Store): AuditRecord[] {
  return chainRecords(collectRows(store));
}

/** Prefix formula-shaped cells so a spreadsheet will not execute them. */
export function neutralizeCsvField(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

export function restoreCsvField(value: string): string {
  if (/^'[=+\-@\t\r]/.test(value)) return value.slice(1);
  return value;
}

function csvEscape(value: string): string {
  const safe = neutralizeCsvField(value);
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function serializeAudit(records: AuditRecord[], format: "jsonl" | "csv"): string {
  if (format === "csv") {
    const header = AUDIT_COLUMNS.join(",");
    const lines = records.map((r) =>
      [
        String(r.seq),
        r.kind,
        csvEscape(r.id),
        String(r.at),
        csvEscape(r.tool_id),
        csvEscape(r.name),
        csvEscape(r.version),
        csvEscape(r.state),
        csvEscape(r.verdict),
        csvEscape(r.reason),
        csvEscape(r.ok),
        r.prev,
        r.sha256,
      ].join(","),
    );
    return [header, ...lines].join("\n") + (records.length || header ? "\n" : "");
  }
  return records.map((r) => JSON.stringify(payloadLine(r))).join("\n") + (records.length ? "\n" : "");
}

function payloadLine(r: AuditRecord): Record<string, string | number> {
  return {
    seq: r.seq,
    kind: r.kind,
    id: r.id,
    at: r.at,
    tool_id: r.tool_id,
    name: r.name,
    version: r.version,
    state: r.state,
    verdict: r.verdict,
    reason: r.reason,
    ok: r.ok,
    prev: r.prev,
    sha256: r.sha256,
  };
}

export function exportAudit(store: Store, format: "jsonl" | "csv"): string {
  return serializeAudit(recordsFromStore(store), format);
}

/**
 * Copy JSON onto a null-prototype object so a `__proto__` key stays data.
 * Never assign through a setter that could pollute Object.prototype.
 */
export function sanitizeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeJson);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as object)) {
    out[key] = sanitizeJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

function recordFromUnknown(raw: unknown): AuditRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = asKind(o.kind);
  if (!kind) return null;
  const seq = Number(o.seq);
  const at = Number(o.at);
  if (!Number.isInteger(seq) || seq < 1) return null;
  if (!Number.isFinite(at)) return null;
  const prev = String(o.prev ?? "");
  const sha256 = String(o.sha256 ?? "");
  return {
    seq,
    kind,
    id: String(o.id ?? ""),
    at,
    tool_id: String(o.tool_id ?? ""),
    name: String(o.name ?? ""),
    version: String(o.version ?? ""),
    state: String(o.state ?? ""),
    verdict: String(o.verdict ?? ""),
    reason: String(o.reason ?? ""),
    ok: String(o.ok ?? ""),
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

function parseCsv(text: string): AuditRecord[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]!).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const col = {
    seq: idx("seq"),
    kind: idx("kind"),
    id: idx("id"),
    at: idx("at"),
    tool_id: idx("tool_id"),
    name: idx("name"),
    version: idx("version"),
    state: idx("state"),
    verdict: idx("verdict"),
    reason: idx("reason"),
    ok: idx("ok"),
    prev: idx("prev"),
    sha256: idx("sha256"),
  };
  if (col.seq < 0 || col.kind < 0 || col.prev < 0 || col.sha256 < 0) {
    throw new Error("csv header missing seq, kind, prev, or sha256");
  }
  const cell = (row: string[], i: number) => restoreCsvField(i >= 0 ? (row[i] ?? "") : "");
  const records: AuditRecord[] = [];
  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    const rec = recordFromUnknown({
      seq: cell(row, col.seq),
      kind: cell(row, col.kind),
      id: cell(row, col.id),
      at: cell(row, col.at),
      tool_id: cell(row, col.tool_id),
      name: cell(row, col.name),
      version: cell(row, col.version),
      state: cell(row, col.state),
      verdict: cell(row, col.verdict),
      reason: cell(row, col.reason),
      ok: cell(row, col.ok),
      prev: cell(row, col.prev),
      sha256: cell(row, col.sha256),
    });
    if (!rec) throw new Error("csv row is not an audit record");
    records.push(rec);
  }
  return records;
}

function parseJsonl(text: string): AuditRecord[] {
  const records: AuditRecord[] = [];
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
    if (!rec) throw new Error("jsonl line is not an audit record");
    records.push(rec);
  }
  return records;
}

export function detectAuditFormat(text: string): "jsonl" | "csv" {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return first.startsWith("seq,") || first.startsWith("seq,kind") ? "csv" : "jsonl";
}

export function parseAudit(text: string, format?: "jsonl" | "csv"): AuditRecord[] {
  const kind = format ?? detectAuditFormat(text);
  return kind === "csv" ? parseCsv(text) : parseJsonl(text);
}

export function verifyAudit(text: string, format?: "jsonl" | "csv"): VerifyResult {
  let records: AuditRecord[];
  try {
    records = parseAudit(text, format);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unreadable export" };
  }
  let prev = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (!rec.prev || !rec.sha256) return { ok: false, reason: "missing prev" };
    if (rec.seq !== i + 1) return { ok: false, reason: `seq gap at ${rec.seq}` };
    if (!hashesEqual(rec.prev, prev)) return { ok: false, reason: `chain break at seq ${rec.seq}` };
    const expected = hashPayload(payloadOf(rec), rec.prev);
    if (!hashesEqual(rec.sha256, expected)) return { ok: false, reason: `hash mismatch at seq ${rec.seq}` };
    prev = rec.sha256;
  }
  return { ok: true, n: records.length };
}

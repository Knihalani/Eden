/**
 * Structured tool traces beside hippocampal prose.
 * `{memoryDir}/traces.jsonl` lives next to memories.jsonl (session subdir when
 * session_id is a safe name; otherwise the memory root). Lock+atomic like SemanticStore.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../packages/ir/src/redact";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { memoryConsent } from "./memory-consent";
import { scrubMemoryText, scrubMemoryValue } from "./memory-scrub";

export type ToolTrace = {
  name: string;
  args: Record<string, unknown>;
  files?: string[];
  exit?: number;
  t: number;
  order: number;
};

export type ToolTraceDraft = Omit<ToolTrace, "order"> & { order?: number };

const NAME_MAX = 64;
const FILES_MAX = 32;
const ARG_STR_MAX = 2000;

const EXIT_IN_TEXT = /\bexit(?:\s+code)?[:\s]+(-?\d+)\b/i;
const FILE_TOKEN = /(?:^|[^A-Za-z0-9_./-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9.]*)/g;
const FILE_KEYS = new Set(["path", "file", "files", "file_path", "filePath", "filename", "filepath", "target_file", "targetFile", "target"]);

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Same sanitizer as AgentMemory session subdirs. */
export function safeMemorySession(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s.includes("\0") || s.includes("/") || s.includes("\\") || s.includes("..")) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === ".") return undefined;
  return s;
}

/** Directory that holds memories.jsonl / traces.jsonl for this openMemory. */
export function memoryTracesDir(root: string, session?: unknown): string {
  const safe = safeMemorySession(session);
  return safe ? join(root, safe) : root;
}

export function tracesPath(dir: string): string {
  return join(dir, "traces.jsonl");
}

function toolName(o: Record<string, unknown>, allowName = false): string {
  const keys = allowName ? [o.tool_name, o.toolName, o.tool, o.name] : [o.tool_name, o.toolName, o.tool];
  const n = keys.find((x) => typeof x === "string" && String(x).trim());
  return n ? String(n).trim().slice(0, NAME_MAX) : "";
}

function capArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > ARG_STR_MAX ? v.slice(0, ARG_STR_MAX) : v;
  }
  return out;
}

/** Parse tool args JSON / object. Redacts secrets. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  let v: unknown = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return {};
    try {
      const p = JSON.parse(t);
      if (p && typeof p === "object" && !Array.isArray(p)) v = p;
      else {
        const s = redact(t);
        return { value: typeof s === "string" ? s.slice(0, ARG_STR_MAX) : t.slice(0, ARG_STR_MAX) };
      }
    } catch {
      const s = redact(t);
      return { value: typeof s === "string" ? s.slice(0, ARG_STR_MAX) : t.slice(0, ARG_STR_MAX) };
    }
  }
  try {
    const redacted = redact(v);
    if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
      return capArgs(redacted as Record<string, unknown>);
    }
  } catch {}
  return {};
}

function resultText(v: unknown): string {
  if (v == null) return "";
  try {
    const redacted = redact(v);
    if (typeof redacted === "string") return redacted;
    if (typeof redacted === "number" || typeof redacted === "boolean") return String(redacted);
    if (redacted && typeof redacted === "object") {
      const o = asRec(redacted);
      const parts = [o.stdout, o.stderr, o.text, o.content, o.output, o.message, o.error]
        .filter((x): x is string => typeof x === "string" && x.length > 0);
      if (parts.length) return parts.join("\n");
      try { return JSON.stringify(redacted); } catch { return ""; }
    }
  } catch {}
  return "";
}

function numericExit(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function exitFromFields(o: Record<string, unknown>): number | undefined {
  for (const k of ["exit", "exit_code", "exitCode", "returncode", "return_code", "status"]) {
    const n = numericExit(o[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/**
 * Numeric exit from result fields or `exit N` in text.
 * `isError === true` → 1 only when no numeric exit was found.
 */
export function exitFromResult(result: unknown, text: string, isError?: boolean): number | undefined {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const fromRes = exitFromFields(asRec(result));
    if (fromRes !== undefined) return fromRes;
  }
  const m = String(text || "").match(EXIT_IN_TEXT);
  if (m) return Number(m[1]);
  if (isError === true) return 1;
  return undefined;
}

/** Path tokens from args (command/path/file) and result text (`auth.ts`, slashed paths). */
export function filesFromTool(args: Record<string, unknown>, resultBlob: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim();
    if (!t || t.length < 3 || seen.has(t) || /^https?:/i.test(t)) return;
    seen.add(t);
    out.push(t);
  };
  const scan = (s: string) => {
    const re = new RegExp(FILE_TOKEN.source, "g");
    for (const m of s.matchAll(re)) add(m[1]!);
  };
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") {
      if (key && FILE_KEYS.has(key)) add(v);
      scan(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, k);
    }
  };
  walk(args);
  scan(resultBlob);
  return out.slice(0, FILES_MAX);
}

function hasToolPayload(o: Record<string, unknown>): boolean {
  if (toolName(o)) return true;
  if (o.tool_input != null || o.args != null || o.parameters != null) return true;
  const result = o.tool_response ?? o.tool_output ?? o.result ?? o.output;
  if (result == null) return false;
  if (typeof result === "string") return result.trim().length > 0;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === "object") return Object.keys(result as object).length > 0;
  return true;
}

function parseItem(item: Record<string, unknown>, fallback: Record<string, unknown>, t: number): ToolTraceDraft | null {
  const name = toolName(item, true) || toolName(fallback) || "subagent";
  const argsRaw = item.tool_input ?? item.args ?? item.parameters ?? item.input
    ?? fallback.tool_input ?? fallback.args ?? fallback.parameters;
  const result = item.tool_response ?? item.tool_output ?? item.result ?? item.output ?? item.content
    ?? fallback.tool_response ?? fallback.tool_output ?? fallback.result ?? fallback.output;
  const args = parseToolArgs(argsRaw);
  const blob = resultText(result);
  if (!toolName(item, true) && !toolName(fallback) && !Object.keys(args).length && !blob) return null;
  const isError = item.is_error === true || item.isError === true || fallback.is_error === true || fallback.isError === true;
  const exit = exitFromResult({ ...asRec(result), ...item, ...fallback }, blob, isError);
  const files = filesFromTool(args, blob);
  const rec: ToolTraceDraft = { name, args, t };
  if (files.length) rec.files = files;
  if (exit !== undefined) rec.exit = exit;
  return rec;
}

/** Hook PostToolUse / SubagentStop → drafts. Chat-only / empty payload → []. Never throws. */
export function parseHookToolTraces(raw: Record<string, unknown>): ToolTraceDraft[] {
  try {
    const r = asRec(raw);
    const batch = [r.tools, r.tool_calls, r.tool_results].find((x) => Array.isArray(x) && (x as unknown[]).length) as unknown[] | undefined;
    const items = batch ? batch.map((x) => asRec(x)) : hasToolPayload(r) ? [r] : [];
    if (!items.length) return [];
    const t = Date.now();
    const out: ToolTraceDraft[] = [];
    for (const item of items) {
      const rec = parseItem(item, r, t);
      if (rec) out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

function readTracesFile(path: string): ToolTrace[] {
  if (!existsSync(path)) return [];
  const out: ToolTrace[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as Partial<ToolTrace>;
        if (!rec || typeof rec !== "object") continue;
        if (typeof rec.name !== "string") continue;
        if (typeof rec.t !== "number" || !Number.isFinite(rec.t)) continue;
        if (typeof rec.order !== "number" || !Number.isFinite(rec.order)) continue;
        const args = rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
          ? rec.args as Record<string, unknown>
          : {};
        const row: ToolTrace = { name: rec.name, args, t: rec.t, order: rec.order };
        if (Array.isArray(rec.files)) row.files = rec.files.filter((x): x is string => typeof x === "string");
        if (typeof rec.exit === "number" && Number.isFinite(rec.exit)) row.exit = rec.exit;
        out.push(row);
      } catch {
        // Torn or invalid line — skip.
      }
    }
  } catch {}
  return out;
}

export function loadToolTraces(dir: string): ToolTrace[] {
  try {
    return readTracesFile(tracesPath(dir));
  } catch {
    return [];
  }
}

/**
 * Append drafts; order continues from max existing + 1 (empty store starts at 0).
 * Incoming relative order is kept. Fail-open.
 */
export function persistToolTraces(dir: string, drafts: Array<ToolTrace | ToolTraceDraft>): void {
  try { if (memoryConsent() !== "on") return; } catch { return; }
  if (!drafts.length || !dir) return;
  const path = tracesPath(dir);
  const lockPath = `${path}.lock`;
  try {
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch {}
    withFileLock(lockPath, () => {
      const rows = readTracesFile(path);
      let next = -1;
      for (const r of rows) if (typeof r.order === "number" && Number.isFinite(r.order) && r.order > next) next = r.order;
      for (const d of drafts) {
        next += 1;
        const parsed = parseToolArgs(d.args && typeof d.args === "object" && !Array.isArray(d.args) ? d.args : {});
        const scrubbed = scrubMemoryValue(parsed);
        const rec: ToolTrace = {
          name: String(d.name || "subagent").slice(0, NAME_MAX),
          args: scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed) ? (scrubbed as Record<string, unknown>) : parsed,
          t: typeof d.t === "number" && Number.isFinite(d.t) ? d.t : Date.now(),
          order: next,
        };
        if (d.files?.length) rec.files = d.files.filter((x) => typeof x === "string").map((x) => scrubMemoryText(x)).slice(0, FILES_MAX);
        if (typeof d.exit === "number" && Number.isFinite(d.exit)) rec.exit = d.exit;
        rows.push(rec);
      }
      writeFileAtomic(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
      try { chmodSync(path, 0o600); } catch {}
    });
  } catch {
    // Fail-open: lock/disk/parse faults must not throw into wrap/hook.
  }
}

/** Parse + persist hook tool payload beside memories.jsonl. Fail-open. */
export function persistHookToolTraces(memoryRoot: string, session: unknown, raw: Record<string, unknown>): void {
  try {
    const traces = parseHookToolTraces(raw);
    if (!traces.length) return;
    persistToolTraces(memoryTracesDir(memoryRoot, session), traces);
  } catch {
    // Fail-open: still return from memoryHookResponse.
  }
}

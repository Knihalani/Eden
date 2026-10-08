/**
 * What memory stores of a text: D13's secret gate (`sanitizeForStore`), then identifiers scrubbed. Every store
 * writer passes its text here, so it is the one gate A6 §2.2 asks for. It does not eat ordinary words like
 * "session" in chat, and does not change the IR redactor.
 */
import { createHash } from "node:crypto";
import { sanitizeForStore } from "./memory-secrets";

export type MemoryScrubCtx = { session?: string; cwd?: string };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const OPAQUE_LEN = 16;
/** Skip tiny tokens so grouping keys like "default" are not eaten from prose. */
const MIN_SESSION = 8;
const MIN_PATH = 3;

/** Stable sha256 hex slice — gist session / project isolation without the raw id. */
export function opaqueId(raw: string): string {
  return createHash("sha256").update(String(raw), "utf8").digest("hex").slice(0, OPAQUE_LEN);
}

/** Hash cwd/path-shaped project keys; leave short names (EDEN_MEMORY_PROJECT) as-is. */
export function opaqueProject(raw?: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  let cwd = "";
  try {
    cwd = process.cwd();
  } catch {}
  if ((cwd && s === cwd) || s.includes("/") || s.includes("\\") || /^[A-Za-z]:/.test(s)) return opaqueId(s);
  return s;
}

function cut(hay: string, needle: string, token: string): string {
  if (!needle || hay.indexOf(needle) < 0) return hay;
  return hay.split(needle).join(token);
}

function pathNeedles(p: string): string[] {
  const s = String(p ?? "").trim();
  if (s.length < MIN_PATH) return [];
  const out = new Set<string>([s]);
  if (s.endsWith("/") || s.endsWith("\\")) out.add(s.replace(/[/\\]+$/, ""));
  else {
    out.add(`${s}/`);
    out.add(`${s}\\`);
  }
  return [...out];
}

/**
 * Memory text as a store may keep it: secrets redacted (D13), then identifiers stripped. Emails → `[email]`.
 * Provided session / cwd / `process.cwd()` → placeholders.
 */
export function scrubMemoryText(text: string, ctx?: MemoryScrubCtx): string {
  let s = String(text ?? "");
  if (!s) return s;
  s = sanitizeForStore(s).replace(EMAIL_RE, "[email]");
  const session = typeof ctx?.session === "string" ? ctx.session.trim() : "";
  if (session.length >= MIN_SESSION) s = cut(s, session, "[session]");
  const paths: string[] = [];
  if (typeof ctx?.cwd === "string" && ctx.cwd.trim()) paths.push(ctx.cwd);
  try {
    const cwd = process.cwd();
    if (cwd) paths.push(cwd);
  } catch {}
  const seen = new Set<string>();
  const needles: string[] = [];
  for (const p of paths) {
    for (const n of pathNeedles(p)) {
      if (seen.has(n)) continue;
      seen.add(n);
      needles.push(n);
    }
  }
  needles.sort((a, b) => b.length - a.length);
  for (const n of needles) s = cut(s, n, "[cwd]");
  return s;
}

/** Walk strings in args / files / nested tool payloads. */
export function scrubMemoryValue(value: unknown, ctx?: MemoryScrubCtx): unknown {
  if (typeof value === "string") return scrubMemoryText(value, ctx);
  if (Array.isArray(value)) return value.map((x) => scrubMemoryValue(x, ctx));
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      o[k] = scrubMemoryValue(v, ctx);
    }
    return o;
  }
  return value;
}

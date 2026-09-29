/**
 * Ids omitted on later inject. Independent of session JSONL so sleep cannot
 * resurrect them. Ids only — never note text, cwd, email, or session.
 * Missing, torn, or unreadable file → empty omit set. Never throws into inject.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { memoryConsent, memoryWritesAllowed } from "./memory-consent";
import { scrubMemoryText } from "./memory-scrub";

const FILE = "harmed.jsonl";

type HarmedRow = { id: string; at: number };

function writesAllowed(): boolean {
  try {
    if (typeof memoryWritesAllowed === "function") return memoryWritesAllowed();
    return memoryConsent() === "on";
  } catch {
    return false;
  }
}

/** Trim, strip identifiers, drop empty / placeholder-only ids. */
function cleanId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let id = raw.replace(/\s+/g, " ").trim();
  if (!id || id.includes("\n") || id.includes("\r")) return "";
  try {
    const scrubbed = scrubMemoryText(id);
    if (typeof scrubbed === "string") id = scrubbed.trim();
  } catch {}
  if (!id || id === "[email]" || id === "[cwd]" || id === "[session]") return "";
  if (/\[(?:email|cwd|session)\]/.test(id)) return "";
  return id;
}

export function harmedPath(dir: string): string {
  return join(dir, FILE);
}

function readRows(path: string): HarmedRow[] {
  if (!existsSync(path)) return [];
  const out: HarmedRow[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let row: { id?: unknown; at?: unknown } | null = null;
    try { row = JSON.parse(line) as { id?: unknown; at?: unknown }; } catch { continue; }
    const id = cleanId(row?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const at = Number(row?.at);
    out.push({ id, at: Number.isFinite(at) ? at : 0 });
  }
  return out;
}

/** Fail-open: missing, torn, or unreadable → empty set. Dedupe on load. */
export function loadHarmedIds(dir: string): Set<string> {
  try {
    const ids = new Set<string>();
    if (typeof dir !== "string" || !dir.trim()) return ids;
    for (const row of readRows(harmedPath(dir))) ids.add(row.id);
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Persist harmed ids on `dir` (memory root). Write: no-op unless consent is on
 * (`EDEN_MEMORY=0` and readonly do not create or append). Lock + atomic rewrite.
 */
export function markHarmed(dir: string, ids: Iterable<string>): void {
  try {
    if (!writesAllowed()) return;
    if (typeof dir !== "string" || !dir.trim()) return;
    if (ids == null || typeof (ids as Iterable<string>)[Symbol.iterator] !== "function") return;
    const fresh: string[] = [];
    const seen = new Set<string>();
    for (const raw of ids) {
      const id = cleanId(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fresh.push(id);
    }
    if (!fresh.length) return;
    const path = harmedPath(dir);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    try { chmodSync(dir, 0o700); } catch {}
    withFileLock(`${path}.lock`, () => {
      const rows = readRows(path);
      const have = new Set(rows.map((r) => r.id));
      const at = Date.now();
      let added = false;
      for (const id of fresh) {
        if (have.has(id)) continue;
        rows.push({ id, at });
        have.add(id);
        added = true;
      }
      if (!added) return;
      const body = rows.map((r) => JSON.stringify({ id: r.id, at: r.at })).join("\n") + "\n";
      writeFileAtomic(path, body);
      try { chmodSync(path, 0o600); } catch {}
    });
  } catch {
    // Fail-open: lock/disk faults must not throw into the host.
  }
}

/** Drop records whose id is harmed. Throw or torn store → `recs` unchanged. */
export function dropHarmed<T extends { id?: string }>(dir: string, recs: T[]): T[] {
  try {
    if (!Array.isArray(recs)) return recs;
    const ids = loadHarmedIds(dir);
    if (!ids.size) return recs;
    return recs.filter((r) => {
      try {
        const id = r && typeof r.id === "string" ? r.id : "";
        return !id || !ids.has(id);
      } catch {
        return true;
      }
    });
  } catch {
    return recs;
  }
}

/**
 * M40.3 debug log. Optional `EDEN_MEMORY_LOG=1` prints note ids + relative ages
 * to stderr. Default off. Never a memory UI. Fail-open.
 *
 * Distinct from `EDEN_MEMORY_INJECT_LOG` (file JSONL metric, M32/M38).
 */
import { relativeMemoryAge } from "./memory-provenance";

const ON = new Set(["1", "true", "yes", "on"]);

export function memoryLogEnabled(raw = process.env.EDEN_MEMORY_LOG): boolean {
  try {
    return ON.has(
      String(raw ?? "")
        .trim()
        .toLowerCase(),
    );
  } catch {
    return false;
  }
}

function scrubLogPart(s: string): string {
  return String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "")
    .replace(/(?:\/[^\s]+)+/g, "")
    .slice(0, 80)
    .trim();
}

/** Stderr only. Swallows throws. Does not mutate the inject packet. */
export function logMemoryNotes(notes: Array<{ id?: string; at?: number; text?: string }>): void {
  try {
    if (!memoryLogEnabled()) return;
    if (!Array.isArray(notes) || !notes.length) return;
    const parts: string[] = [];
    for (const n of notes) {
      if (!n || typeof n !== "object") continue;
      const id = scrubLogPart(String(n.id ?? ""));
      if (!id) continue;
      const at = typeof n.at === "number" && Number.isFinite(n.at) ? n.at : Date.now();
      parts.push(`${id}:${relativeMemoryAge(at)}`);
    }
    if (!parts.length) return;
    process.stderr.write(`eden-memory ${parts.join(" ")}\n`);
  } catch {
    /* log fail-open */
  }
}

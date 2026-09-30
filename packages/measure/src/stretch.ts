/**
 * Whole-stretch words for Home, canvas, and digest (Wave 8.1 leftover 4).
 *
 * A stretch is every receipt for one tool in the window — not the latest
 * row. Order is always Served, then Skipped, then Degraded when present, so
 * a host-drop cannot hide behind a later remainder skip.
 */
export const STRETCH_WORDS = ["Served", "Skipped", "Degraded"] as const;
export type StretchWord = (typeof STRETCH_WORDS)[number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function reasonOf(row: Record<string, unknown>): string {
  return (
    (typeof row.reason === "string" && row.reason) ||
    (typeof row.deoptReason === "string" && row.deoptReason) ||
    ""
  );
}

function tokenClassOf(row: Record<string, unknown>): string {
  return typeof row.tokenClass === "string" ? row.tokenClass : "";
}

function skippedOf(row: Record<string, unknown>): string[] {
  return Array.isArray(row.skipped) ? row.skipped.filter((n): n is string => typeof n === "string") : [];
}

function lastOk(row: Record<string, unknown>): 0 | 1 | null {
  if (row.ok === 1 || row.ok === true) return 1;
  if (row.ok === 0 || row.ok === false) return 0;
  return null;
}

/** Host kept the original tool output (R1 drop). */
export function isHostDrop(receipt: unknown): boolean {
  const row = asRecord(receipt);
  if (!row) return false;
  const reason = reasonOf(row);
  return (
    /host kept the original/i.test(reason) ||
    /dropped the rewrite/i.test(reason) ||
    /silent.?drop/i.test(reason) ||
    /updatedToolOutput was dropped/i.test(reason)
  );
}

/** Remainder deny / wrap skipRest — tails already served. */
export function isRemainderSkip(receipt: unknown): boolean {
  const row = asRecord(receipt);
  if (!row) return false;
  if (isHostDrop(row)) {
    return skippedOf(row).length > 0 || tokenClassOf(row) === "steered-skip";
  }
  const reason = reasonOf(row);
  const tokenClass = tokenClassOf(row);
  const skipped = skippedOf(row);
  if (tokenClass === "steered-skip" || (skipped.length > 0 && lastOk(row) === 1)) return true;
  if (/already served by/i.test(reason) || /remaining steps of this routine/i.test(reason)) return true;
  const shared = Number(row.sharedAcross);
  if (Number.isFinite(shared) && shared >= 2) return true;
  if (/shared across \d+ agents/.test(reason)) return true;
  return false;
}

/** Compiled or transparent head that actually served the stretch. */
export function isServedHead(receipt: unknown): boolean {
  const row = asRecord(receipt);
  if (!row) return false;
  const tokenClass = tokenClassOf(row);
  if (tokenClass === "transparent" || tokenClass === "compiled" || tokenClass === "memoized") return true;
  if (isHostDrop(row) || isRemainderSkip(row)) return false;
  return lastOk(row) === 1 && tokenClass !== "frontier";
}

export function stretchWords(receipts: unknown[]): StretchWord[] {
  let served = false;
  let skipped = false;
  let degraded = false;
  for (const raw of receipts) {
    if (isHostDrop(raw)) degraded = true;
    if (isRemainderSkip(raw)) skipped = true;
    if (isServedHead(raw)) served = true;
  }
  const out: StretchWord[] = [];
  if (served) out.push("Served");
  if (skipped) out.push("Skipped");
  if (degraded) out.push("Degraded");
  return out;
}

/** Paused wins. Canary serving is Canary, not Live. */
export function stretchHead(state: string | undefined, rollout?: string | null): "paused" | "canary" | "live" {
  if (state === "paused") return "paused";
  if (rollout === "canary") return "canary";
  return "live";
}

export function stretchLine(state: string, words: StretchWord[], extra: Array<string | null | undefined> = []): string {
  const live = state === "paused" ? "Paused" : state === "canary" ? "Canary" : "Live";
  const tail = extra.filter((s): s is string => typeof s === "string" && s.length > 0);
  return [live, ...words, ...tail].join(" · ");
}

export function toolIdOf(receipt: unknown): string {
  const row = asRecord(receipt);
  if (!row) return "";
  if (typeof row.tool_id === "string" && row.tool_id) return row.tool_id;
  if (typeof row.toolId === "string" && row.toolId) return row.toolId;
  return "";
}

/** Group receipts by tool and name each stretch. */
export function stretchWordsByTool(receipts: unknown[]): Map<string, StretchWord[]> {
  const byId = new Map<string, unknown[]>();
  for (const raw of receipts) {
    const id = toolIdOf(raw);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(raw);
    byId.set(id, list);
  }
  const out = new Map<string, StretchWord[]>();
  for (const [id, rows] of byId) {
    const words = stretchWords(rows);
    if (words.length) out.set(id, words);
  }
  return out;
}

export function stretchSentence(words: StretchWord[]): string {
  if (!words.length) return "";
  const bits: string[] = [];
  if (words.includes("Served")) bits.push("The remaining steps of this routine were already served");
  if (words.includes("Skipped")) bits.push("tails skipped");
  if (words.includes("Degraded")) bits.push("the host dropped the rewrite");
  if (bits.length === 1) return `${bits[0]}.`;
  if (bits.length === 2) return `${bits[0]}; ${bits[1]}.`;
  return `${bits[0]}; ${bits[1]}; ${bits[2]}.`;
}

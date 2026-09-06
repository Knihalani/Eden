/**
 * On-read DC% window for this control-plane workspace.
 *
 * Receipts without tokenClasses do not invent a day — that day is 0 / unmeasured.
 */
import { emptyTokenClasses, type TokenClasses } from "@eden/ir";
import { aggregateDc, asTokenClasses, utcDay, utcDaysEnding, type DcRun } from "@eden/measure";
import { Store, type StoredReceipt } from "./store";

export type DcDayOut = {
  day: string;
  classes: TokenClasses;
  dcPct: number;
  measured: boolean;
};

export type DcWindow = {
  days: DcDayOut[];
  current: { dcPct: number; measured: boolean };
};

function extras(row: StoredReceipt): Record<string, unknown> {
  if (!row.payload) return {};
  try {
    const parsed = JSON.parse(String(row.payload)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function receiptTokenClasses(row: StoredReceipt): TokenClasses | null {
  const extra = extras(row);
  return asTokenClasses(extra.tokenClasses) ?? asTokenClasses(extra.classes);
}

export function dcWindowFromReceipts(receipts: StoredReceipt[], days: number, now = Date.now(), workspace = Store.WORKSPACE_ID): DcWindow {
  const dayList = utcDaysEnding(now, days);
  const allowed = new Set(dayList);
  const runs: DcRun[] = [];
  for (const row of receipts) {
    const classes = receiptTokenClasses(row);
    if (!classes) continue;
    const day = utcDay(row.created_at);
    if (!allowed.has(day)) continue;
    runs.push({ workspace, day, classes, at: row.created_at });
  }
  const byDay = new Map(aggregateDc(runs).map((r) => [r.day, r]));
  const out: DcDayOut[] = dayList.map((day) => {
    const hit = byDay.get(day);
    if (!hit) return { day, classes: emptyTokenClasses(), dcPct: 0, measured: false };
    return { day, classes: hit.classes, dcPct: hit.dcPct, measured: true };
  });
  const last = out[out.length - 1] ?? { day: utcDay(now), classes: emptyTokenClasses(), dcPct: 0, measured: false };
  return { days: out, current: { dcPct: last.dcPct, measured: last.measured } };
}

export function parseDayCount(raw: string | null, fallback = 7): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

/**
 * Named-object create + alert compile guards (R021–R027, R032).
 */

export function normalizeObjectName(raw: string): string {
  return raw.trim();
}

export function isUsableObjectName(raw: string): boolean {
  return normalizeObjectName(raw).length > 0;
}

const CATCH_ALL_EQL = /\bwhere\s+1\s*=\s*1\b/i;
const INTERNAL_WARNING =
  /auto-injecting|strict mode|pydantic|traceback|returning 400/i;

export function isCatchAllEql(eql: string | null | undefined): boolean {
  if (!eql) return true;
  const t = eql.trim();
  if (!t) return true;
  return CATCH_ALL_EQL.test(t);
}

export const CATCH_ALL_EQL_MESSAGE =
  "That description did not produce a real condition. Try naming a metric, status, or threshold.";

export function sanitizeCompileWarnings(warnings: string[] | undefined): string[] {
  return (warnings ?? []).filter((w) => w.trim() && !INTERNAL_WARNING.test(w));
}

export function parseAlertIntervalMinutes(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

export function countEventRows(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== "object") return 0;
  const o = data as Record<string, unknown>;
  if (Array.isArray(o.items)) return o.items.length;
  if (Array.isArray(o.traces)) return o.traces.length;
  if (Array.isArray(o.events)) return o.events.length;
  if (typeof o.total === "number" && Number.isFinite(o.total)) return o.total;
  return 0;
}

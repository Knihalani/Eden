/**
 * Customer-facing copy helpers — one grammar for counts, actors, and plan.
 * Portal-only; do not invent backend fields.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLERK_USER_RE = /^user_[A-Za-z0-9]+$/;

export function isUuidLike(value: string | null | undefined): boolean {
  const s = (value ?? "").trim();
  if (!s) return false;
  return UUID_RE.test(s) || CLERK_USER_RE.test(s);
}

/** `1 key` / `2 keys`. Irregular plurals via explicit plural form. */
export function plural(
  n: number,
  singular: string,
  pluralForm?: string,
): string {
  const count = Number.isFinite(n) ? n : 0;
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${count} ${word}`;
}

/**
 * Never dump a raw UUID / Clerk user id into the UI.
 * Current-user match → "You"; other machine ids → "A teammate".
 */
export function displayActor(
  raw: string | null | undefined,
  currentUserId?: string | null,
): string {
  const value = (raw ?? "").trim();
  if (!value) return "Unknown";
  if (currentUserId && value === currentUserId) return "You";
  if (value === "You" || value === "you") return "You";
  if (isUuidLike(value)) return "A teammate";
  return value;
}

/** Empty / unknown plan → "Free". Never a bare word "plan". */
export function formatPlanLabel(label: string | null | undefined): string {
  const value = (label ?? "").trim();
  return value || "Free";
}

export function formatPlanMeta(label: string | null | undefined): string {
  return `${formatPlanLabel(label)} plan`;
}

/** Demo / system A/B rows the user never created (0 runs + generator name). */
export function isPhantomAbExperiment(row: {
  name?: string | null;
  id?: string | null;
  arms?: Array<{ nTraces?: number | null } | null> | null;
  sourceEvalBaselineId?: string | null;
  sourceDebuggerSessionId?: string | null;
}): boolean {
  const runs = (row.arms ?? []).reduce(
    (sum, arm) => sum + (Number(arm?.nTraces) || 0),
    0,
  );
  if (runs > 0) return false;
  if (row.sourceEvalBaselineId || row.sourceDebuggerSessionId) return false;
  const hay = `${row.name ?? ""} ${row.id ?? ""}`.toLowerCase();
  return (
    hay.includes("spec_generator") ||
    hay.includes("prompt_v2") ||
    hay.includes("demo_experiment")
  );
}

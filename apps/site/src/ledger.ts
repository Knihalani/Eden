import type { EdenDb } from "./db";

/**
 * Honest Savings Ledger.
 *
 * One rule governs every number here: it appears only where evidence backs
 * it. A savings figure with no measurement behind it is reported as
 * `null` + `measured:false` — "not measured" — never as zero, and never
 * padded with an estimate wearing a measurement's clothes. Estimated token
 * figures are reported separately under their own flag, the same policy the
 * shadow ship gate applies (`tokensMeasured && !tokensEstimated`).
 *
 * Evidence sources, per workspace:
 *   - tool_run rows joined through tool — runs, failures. These columns are
 *     written by playback from real executions.
 *   - tool.manifest JSON — the ShadowManifest a tool earned at approval time
 *     (tokensSaved/timeSavedMs/tokensMeasured/timeMeasured/tokensEstimated,
 *     per packages/shadow). The column does not exist in db.ts's baseline
 *     schema, so this module adds it additively below; a failed ALTER only
 *     means no manifest evidence yet, which the ledger reports honestly.
 *
 * Time figures come solely from manifests that set timeMeasured. server_ms on
 * tool_run is wall-clock of a single execution against whatever clock ran it —
 * mixing it into a "time saved" mean would be exactly the synthetic-clock
 * blend this ledger exists to refuse.
 */

export type LedgerFigure = {
  /** null when nothing measured. Never zero-by-default. */
  value: number | null;
  measured: boolean;
};

export type TokenFigure = LedgerFigure & {
  /** True when estimated-only evidence exists for this figure. */
  estimated: boolean;
};

export type ToolLedgerEntry = {
  id: string;
  name: string;
  state: string;
  runs: number;
  fail: number;
  tokens: TokenFigure;
  time: LedgerFigure;
};

export type SavingsLedger = {
  runs: number;
  fail: number;
  live: number;
  tokens_saved_mean: TokenFigure;
  /** Mean over estimated-only manifests; null where none exist. Reported separately so an estimate can never masquerade as the measured figure above. */
  tokens_saved_estimated_mean: { value: number | null };
  time_saved_ms_mean: LedgerFigure;
  per_tool: ToolLedgerEntry[];
};

/** A manifest as stored: parsed defensively, fields read as unknown. */
type StoredManifest = {
  tokensSaved?: unknown;
  timeSavedMs?: unknown;
  tokensMeasured?: unknown;
  timeMeasured?: unknown;
  tokensEstimated?: unknown;
};

const ensured = new WeakSet<object>();

/**
 * Additively provides the `tool.manifest` column this ledger reads. Mirrors
 * db.ts's best-effort migration style: a failure must not stop serving — it
 * just means the ledger reports not-measured until it succeeds.
 *
 * Only success is memoized: a transient Neon hiccup must be retryable on the
 * next call, so a failed ALTER is logged to stderr and left un-cached. A
 * duplicate-column error is the steady state of an already-migrated database,
 * and counts as success.
 */
export async function ensureLedgerSchema(db: EdenDb): Promise<void> {
  if (ensured.has(db)) return;
  try {
    await db.exec(`ALTER TABLE tool ADD COLUMN manifest TEXT`);
    ensured.add(db);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/already exists|duplicate column/i.test(msg)) {
      ensured.add(db);
      return;
    }
    console.error("[eden-ledger] could not add tool.manifest column; will retry next call:", err);
  }
}

/**
 * The ShadowManifest shape the approve route persists onto tool.manifest —
 * exactly the fields packages/shadow's Manifest reports for savings evidence
 * and nothing else. Unknown keys are rejected rather than dropped: a ledger
 * number nobody can trace back to a field definition is how synthetic
 * evidence starts.
 */
export type ShadowManifestRecord = {
  tokensSaved?: number;
  timeSavedMs?: number;
  tokensMeasured?: boolean;
  timeMeasured?: boolean;
  tokensEstimated?: boolean;
};

export function sanitizeManifest(v: unknown): { ok: true; value: ShadowManifestRecord } | { ok: false; error: string } {
  if (v === null || v === undefined) return { ok: false, error: "manifest is absent" };
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "manifest must be a json object" };
  const rec = v as Record<string, unknown>;
  const out: ShadowManifestRecord = {};
  for (const key of ["tokensSaved", "timeSavedMs"] as const) {
    if (rec[key] === undefined) continue;
    if (typeof rec[key] !== "number" || !Number.isFinite(rec[key])) return { ok: false, error: `manifest.${key} must be a finite number` };
    out[key] = rec[key];
  }
  for (const key of ["tokensMeasured", "timeMeasured", "tokensEstimated"] as const) {
    if (rec[key] === undefined) continue;
    if (typeof rec[key] !== "boolean") return { ok: false, error: `manifest.${key} must be a boolean` };
    out[key] = rec[key];
  }
  const known = new Set(["tokensSaved", "timeSavedMs", "tokensMeasured", "timeMeasured", "tokensEstimated"]);
  for (const key of Object.keys(rec)) {
    if (!known.has(key)) return { ok: false, error: `manifest.${key} is not a recognized field` };
  }
  return { ok: true, value: out };
}

function parseManifest(raw: string | null | undefined): StoredManifest | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as StoredManifest) : null;
  } catch {
    return null;
  }
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Aggregate one workspace's savings evidence. Every aggregate is scoped by a
 * join back to `tool.workspace_id` — tool_run carries no workspace of its
 * own, so an unscoped join would be the cross-tenant leak.
 */
export async function buildLedger(db: EdenDb, wsId: string): Promise<SavingsLedger> {
  await ensureLedgerSchema(db);

  const tools = await db.all<{ id: string; name: string; state: string; manifest: string | null }>(
    `SELECT id, name, state, manifest FROM tool WHERE workspace_id = ? ORDER BY name`,
    [wsId],
  );

  // Run counts are grouped per tool of *this* workspace only; the join is what
  // keeps another tenant's tool_run rows out even if ids ever collided.
  const runRows = await db.all<{ tid: string; runs: number; fails: number }>(
    `SELECT r.tool_id AS tid,
            COUNT(*) AS runs,
            COALESCE(SUM(CASE WHEN r.steps_ok < r.steps_attempted THEN 1 ELSE 0 END), 0) AS fails
       FROM tool_run r JOIN tool t ON t.id = r.tool_id
      WHERE t.workspace_id = ?
      GROUP BY r.tool_id`,
    [wsId],
  );
  const runsByTool = new Map(runRows.map((r) => [r.tid, { runs: Number(r.runs), fail: Number(r.fails) }]));

  const perTool: ToolLedgerEntry[] = [];
  const measuredTokens: number[] = [];
  const estimatedTokens: number[] = [];
  const measuredTime: number[] = [];

  let totalRuns = 0;
  let totalFails = 0;

  for (const t of tools) {
    const counts = runsByTool.get(t.id) ?? { runs: 0, fail: 0 };
    totalRuns += counts.runs;
    totalFails += counts.fail;

    const m = parseManifest(t.manifest);
    // Measured tokens: the ship gate's own bar — provider-backed usage,
    // explicitly flagged measured, explicitly NOT extrapolated across the
    // island step. Everything else is either absent or an estimate.
    const tokMeasured = m?.tokensMeasured === true && m?.tokensEstimated !== true && finite(m?.tokensSaved);
    const tokEstimated = m?.tokensEstimated === true && finite(m?.tokensSaved);
    const timeMeasured = m?.timeMeasured === true && finite(m?.timeSavedMs);
    if (tokMeasured) measuredTokens.push(m!.tokensSaved as number);
    if (tokEstimated) estimatedTokens.push(m!.tokensSaved as number);
    if (timeMeasured) measuredTime.push(m!.timeSavedMs as number);

    perTool.push({
      id: t.id,
      name: t.name,
      state: t.state,
      runs: counts.runs,
      fail: counts.fail,
      tokens: {
        value: tokMeasured ? (m!.tokensSaved as number) : null,
        measured: tokMeasured,
        estimated: tokEstimated,
      },
      time: {
        value: timeMeasured ? (m!.timeSavedMs as number) : null,
        measured: timeMeasured,
      },
    });
  }

  const measuredMean = mean(measuredTokens);
  return {
    runs: totalRuns,
    fail: totalFails,
    live: tools.filter((t) => t.state === "on").length,
    tokens_saved_mean: { value: measuredMean, measured: measuredTokens.length > 0, estimated: estimatedTokens.length > 0 },
    tokens_saved_estimated_mean: { value: mean(estimatedTokens) },
    time_saved_ms_mean: { value: mean(measuredTime), measured: measuredTime.length > 0 },
    per_tool: perTool,
  };
}

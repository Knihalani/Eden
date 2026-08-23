import type { EdenDb } from "./db";
import { countDeopts } from "./db";

/**
 * Drift canary & auto-recompile.
 *
 * A live compiled tool that deopts used to just fail one run and nothing
 * learned. This closes the loop: enough deopts inside a window → gather fresh
 * traces for the tool's source stretch → recompile → run the candidate through
 * the same shadow gate every other candidate passes → on PASS, queue a NEW
 * draft tool row plus a knock against the OLD version so the workshop shows
 * old-vs-new. Approval stays human-only: this module only ever writes
 * `state = 'draft'` and never flips anything On — that invariant is the one
 * the workshop page states outright.
 *
 * Why dependency injection instead of imports: apps/site links only
 * @eden/core, and neither @eden/compile (compileTraces) nor @eden/shadow
 * (shadowProgram, with its registry/sandbox wiring) is reachable from these
 * modules without new package edges. So both arrive as structurally-typed
 * parameters — `compileTracesFn` and a `shadowProgram`-shaped
 * `shadowProgramFn`. A caller with the real wiring (the control app's store)
 * passes them straight through; a caller without one gets an honest
 * "cannot check" outcome rather than a silent pass.
 */

export type CanaryVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/** Structural subset of @eden/shadow's ShadowResult this module consumes. */
export type CanaryShadowResult = {
  verdict: CanaryVerdict;
  reasons?: string[];
};

/** Structural subset of @eden/compile's CompileResult. */
export type CanaryCompileResult = {
  programs: unknown[];
  refusals?: Array<{ reason: string }>;
};

export type CompileTracesFn = (traces: unknown[]) => CanaryCompileResult;

export type ShadowProgramFn = (
  program: unknown,
  traces: unknown[],
  opts: Record<string, unknown>,
) => Promise<CanaryShadowResult>;

export type GatherTracesFn = (
  db: EdenDb,
  workspaceId: string,
  fingerprint: string,
  limit: number,
) => Promise<unknown[]>;

export type MaybeRecompileInput = {
  workspace_id: string;
  tool_id: string;
  compileTracesFn?: CompileTracesFn;
  shadowProgramFn?: ShadowProgramFn;
  gatherTracesFn?: GatherTracesFn;
  /** Passed through to shadowProgramFn as sandbox wiring when supplied. */
  registry?: unknown;
  island?: unknown;
  windowMs?: number;
  threshold?: number;
  traceLimit?: number;
};

export type RecompileOutcome =
  | { action: "below-threshold"; deopts: number }
  | { action: "no-tool" }
  | { action: "pending-recompile-exists" }
  | { action: "no-compiler" }
  | { action: "no-shadow-gate" }
  | { action: "recompile-refused"; reasons: string[] }
  | { action: "skipped"; verdict: CanaryVerdict; reasons: string[] }
  | { action: "queued"; draft_id: string; knock_id: string; verdict: CanaryVerdict };

/** Marks a recompiled draft's lineage in its fingerprint. */
const RC_MARK = "@rc";

/** Escape LIKE wildcards so a fingerprint containing `_` or `%` matches only itself. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Default trace gathering from what the site database actually stores: the
 * stretch observations recorded for this fingerprint during ingest. They carry
 * each step's name/args/ok but not results, so they are honest about being
 * thin — enough to re-mine sequence structure, not enough for the shadow gate
 * to score output quality. A caller holding full traces overrides this.
 */
const defaultGatherTraces: GatherTracesFn = async (db, workspaceId, fingerprint, limit) => {
  const rows = await db.all<{ steps: string }>(
    `SELECT steps FROM stretch WHERE workspace_id = ? AND fingerprint = ? ORDER BY created_at DESC LIMIT ?`,
    [workspaceId, fingerprint, limit],
  );
  return rows.map((r, i) => {
    const steps = parseJson<Array<{ name?: string; args?: Record<string, unknown>; ok?: boolean }>>(r.steps, []);
    return {
      id: `stretch-${i}`,
      input: {} as Record<string, unknown>,
      events: steps.map((s) => ({ name: String(s.name ?? ""), args: s.args ?? {}, ok: s.ok !== false })),
      output: undefined,
    };
  });
};

/**
 * Run the drift canary for one tool.
 *
 * Returns what happened instead of throwing — every failure mode is an
 * outcome, because callers invoke this fire-and-forget after ingest where a
 * rejection would be an unhandled one.
 */
export async function maybeRecompile(db: EdenDb, input: MaybeRecompileInput): Promise<RecompileOutcome> {
  const windowMs = input.windowMs ?? 24 * 60 * 60_000;
  const threshold = input.threshold ?? 2;

  // 1. Threshold. Fewer than N deopts in the window is noise, not drift.
  const deopts = await countDeopts(db, input.workspace_id, input.tool_id, windowMs);
  if (deopts < threshold) return { action: "below-threshold", deopts };

  // 2. The drifted tool itself. Tenant-scoped: an id alone proves nothing.
  const tool = await db.get<{ id: string; name: string; state: string; steps: string; fingerprint: string }>(
    `SELECT id, name, state, steps, fingerprint FROM tool WHERE id = ? AND workspace_id = ?`,
    [input.tool_id, input.workspace_id],
  );
  if (!tool?.fingerprint) return { action: "no-tool" };

  // 3. Churn dampening — one pending recompile per tool at a time. A draft
  // descendant (fingerprint `${fp}@rc<n>`) means a recompiled candidate is
  // already awaiting human review; piling a second one behind it would churn
  // drafts faster than any human approves them. LIKE is escaped and scoped by
  // workspace_id, so one tenant's descendants never dampen another's.
  const descendant = await db.get(
    `SELECT 1 as ok FROM tool
      WHERE workspace_id = ? AND state = 'draft' AND fingerprint LIKE ? ESCAPE '\\'`,
    [input.workspace_id, `${escapeLike(tool.fingerprint)}${RC_MARK}%`],
  );
  if (descendant) return { action: "pending-recompile-exists" };

  // Wiring is checked before any data is read: a missing compiler is a
  // permanent misconfiguration and must be reported as such, not masked by
  // whatever the local stretch table happens to hold today.
  const compile = input.compileTracesFn;
  if (!compile) {
    console.error(`[eden-canary] ${tool.name}: drift detected (${deopts} deopts/${windowMs / 3600_000}h) but no compileTracesFn wired — cannot recompile`);
    return { action: "no-compiler" };
  }

  // 4. Re-mine from fresh traces gathered for the drifted fingerprint only —
  // scoping happens at the input of compilation, not by filtering programs
  // afterwards.
  const gather = input.gatherTracesFn ?? defaultGatherTraces;
  const traces = await gather(db, input.workspace_id, tool.fingerprint, input.traceLimit ?? 20);
  if (!traces.length) return { action: "recompile-refused", reasons: ["no traces available for the drifted stretch"] };
  let compiled: CanaryCompileResult;
  try {
    compiled = compile(traces);
  } catch (err) {
    console.error(`[eden-canary] ${tool.name}: recompilation threw:`, err);
    return { action: "recompile-refused", reasons: [`compileTracesFn threw: ${(err as Error).message}`] };
  }
  const program = compiled.programs[0];
  if (!program) {
    console.error(
      `[eden-canary] ${tool.name}: recompilation refused: ${compiled.refusals?.map((r) => r.reason).join("; ") || "no candidates"}`,
    );
    return { action: "recompile-refused", reasons: compiled.refusals?.map((r) => r.reason) ?? ["no candidates"] };
  }

  // 5. The SAME gate every other candidate passes before a human sees it. No
  // gate wired → say so and stop; a drift must never lower the bar.
  const shadow = input.shadowProgramFn;
  if (!shadow) {
    console.error(`[eden-canary] ${tool.name}: no shadowProgramFn wired — refusing to queue an unchecked recompile`);
    return { action: "no-shadow-gate" };
  }
  let verdict: CanaryShadowResult;
  try {
    verdict = await shadow(program, traces, {
      ...(input.registry !== undefined ? { registry: input.registry } : {}),
      ...(input.island !== undefined ? { island: input.island } : {}),
    });
  } catch (err) {
    console.error(`[eden-canary] ${tool.name}: shadow gate threw:`, err);
    return { action: "skipped", verdict: "INCONCLUSIVE", reasons: [`shadow gate threw: ${(err as Error).message}`] };
  }

  // FAIL or INCONCLUSIVE changes nothing: the original keeps serving and the
  // next deopt re-runs this whole flow once fresh evidence exists.
  if (verdict.verdict !== "PASS") {
    console.error(
      `[eden-canary] ${tool.name}: recompiled candidate ${verdict.verdict}: ${(verdict.reasons ?? []).join("; ")}`,
    );
    return { action: "skipped", verdict: verdict.verdict, reasons: verdict.reasons ?? [] };
  }

  // 6. PASS → queue a NEW draft beside the old version. The old row is left
  // exactly as it is (still On, still serving) until a human approves the new
  // one in the workshop; the knock points at the OLD id so the workshop pairs
  // them. `state` is hardcoded to 'draft' below — nothing in the canary path
  // may turn a tool On, whatever EDEN_AUTO_APPROVE says about mined drafts.
  const suffixN =
    (
      await db.get<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM tool WHERE workspace_id = ? AND fingerprint LIKE ? ESCAPE '\\'`,
        [input.workspace_id, `${escapeLike(tool.fingerprint)}${RC_MARK}%`],
      )
    )?.n ?? 0;
  const rcFingerprint = `${tool.fingerprint}${RC_MARK}${Number(suffixN) + 1}`;
  let name = `${tool.name}_v2`;
  let n = 3;
  while (await db.get(`SELECT 1 as ok FROM tool WHERE workspace_id = ? AND name = ?`, [input.workspace_id, name])) {
    name = `${tool.name.slice(0, 44)}_v${n++}`;
  }
  const draftId = crypto.randomUUID();
  const rawSeq = (program as { sequence?: unknown }).sequence;
  const seq = Array.isArray(rawSeq) ? rawSeq.map(String) : [];
  await db.run(
    `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 2)`,
    [
      draftId,
      input.workspace_id,
      name,
      `Recompiled replacement for ${tool.name} after ${deopts} deopts in the last ${Math.round(windowMs / 3600_000)}h. Old version stays live until you approve this one.`,
      JSON.stringify(program),
      JSON.stringify(seq),
      rcFingerprint,
    ],
  );
  const knockId = crypto.randomUUID();
  const attemptRow = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM knock WHERE workspace_id = ? AND tool_id = ?`,
    [input.workspace_id, tool.id],
  );
  await db.run(`INSERT INTO knock (id, workspace_id, tool_id, attempt, resolution) VALUES (?, ?, ?, ?, NULL)`, [
    knockId,
    input.workspace_id,
    tool.id,
    Number(attemptRow?.n ?? 0) + 1,
  ]);
  return { action: "queued", draft_id: draftId, knock_id: knockId, verdict: "PASS" };
}

/**
 * Post-ingest hook: sweep the workspace's recent deopt ledger and run the
 * canary for each affected tool. Ingest calls this fire-and-forget — it awaits
 * nothing and swallows everything, so ingest latency is untouched even when
 * the ledger is hot.
 */
export async function maybeRecompileWorkspace(
  db: EdenDb,
  workspaceId: string,
  deps: Omit<MaybeRecompileInput, "workspace_id" | "tool_id"> = {},
): Promise<void> {
  const windowMs = deps.windowMs ?? 24 * 60 * 60_000;
  const rows = await db
    .all<{ tool_id: string }>(
      `SELECT DISTINCT tool_id FROM deopt_event WHERE workspace_id = ? AND created_at >= ? LIMIT 5`,
      [workspaceId, Date.now() - windowMs],
    )
    .catch(() => [] as Array<{ tool_id: string }>);
  for (const row of rows) {
    try {
      await maybeRecompile(db, { ...deps, workspace_id: workspaceId, tool_id: row.tool_id });
    } catch (err) {
      console.error(`[eden-canary] unhandled error for tool ${row.tool_id}:`, err);
    }
  }
}

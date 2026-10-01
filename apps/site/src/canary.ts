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
 * Why dependency injection instead of imports: the library stays stubbable
 * for tests. Production ingest (cluster.ts) must pass the real
 * `compileTraces` / `shadowProgram` adapters from canary-bind.ts — omitting
 * them is the `no-compiler` hole. A caller without wiring gets an honest
 * "cannot check" outcome rather than a silent pass.
 */

/** Queued replacement copy. Same words as Home/canvas. Canary never Approves. */
export const REFRESH_WAITING_COPY =
  "The outside world renamed a field. A replacement is waiting. The live tool is unchanged until you Approve.";

/** The only state this module writes onto a tool row. Never `on`. */
const QUEUED_STATE = "draft" as const;

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
  /** Draft `when_to_use`. Drift keeps the field-rename sentence; webhook passes its own. */
  waitingCopy?: string;
};

export type RecompileOutcome =
  | { action: "below-threshold"; deopts: number }
  | { action: "no-tool" }
  | { action: "pending-recompile-exists" }
  | { action: "no-compiler" }
  | { action: "no-shadow-gate" }
  | { action: "recompile-refused"; reasons: string[] }
  | { action: "unplayable-refused"; reasons: string[] }
  | { action: "skipped"; verdict: CanaryVerdict; reasons: string[] }
  | { action: "queued"; draft_id: string; knock_id: string; verdict: CanaryVerdict };

/**
 * The step shape every other writer stores into tool.steps (cluster.ts's
 * stepsToCompiled, server.ts's seed): playback's parse + buildDag path
 * consumes exactly this — an ARRAY of steps keyed by id/name/url.
 */
type CompiledStepLike = {
  id: string;
  kind: string;
  name: string;
  commute?: boolean;
  url?: string;
  command?: string;
  method?: string;
  /** Template bindings playback's resolveBound applies before URL expansion. */
  bind?: Record<string, string>;
  /** IR readOnly flag, carried through so prefetch never guesses. */
  readOnly?: boolean;
};

/**
 * Project a recompiled StretchProgram onto the CompiledStep[] shape playback
 * can actually run, using the drifted tool's own compiled steps as the URL
 * source of truth: an IR tool step names a recorded call (`step.tool`), and
 * the matching prior CompiledStep carries that call's url/kind/commute. The
 * prior step's bind map is carried over verbatim, and the IR step's readOnly
 * flag is projected onto the copy, so playback resolves bound templates and
 * prefetch-guards exactly as it would for a hand-compiled tool.
 *
 * This is deliberately strict. Playback has no semantics for island/loop/
 * assert steps, and a tool step with no recorded URL cannot be replayed — so
 * where conversion is not lossless we refuse to queue rather than store
 * something that would 500 /v1/play the moment a human approved it.
 *
 * The full StretchProgram is intentionally not persisted: every existing
 * consumer of the JSON columns expects their established shape (`steps` an
 * array of CompiledStep, `seen` a string[] of names), and no free column can
 * hold the artifact honestly. The projection below preserves what is
 * replayable; the gate's own record remains with its caller.
 */
export function programToCompiledSteps(
  program: unknown,
  priorStepsRaw: string | null | undefined,
): { ok: true; steps: CompiledStepLike[] } | { ok: false; reasons: string[] } {
  let prior: unknown;
  try {
    prior = JSON.parse(priorStepsRaw || "[]");
  } catch {
    return { ok: false, reasons: ["drifted tool's stored steps are not valid JSON"] };
  }
  if (!Array.isArray(prior)) return { ok: false, reasons: ["drifted tool's stored steps are not an array"] };
  const byName = new Map<string, CompiledStepLike>();
  for (const s of prior as Array<Record<string, unknown>>) {
    if (s && typeof s === "object" && typeof s.name === "string") byName.set(s.name, s as CompiledStepLike);
  }

  const steps = (program as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return { ok: false, reasons: ["recompiled program carries no step list"] };

  const reasons: string[] = [];
  const projected: CompiledStepLike[] = [];
  for (const s of steps) {
    const rec = s as { id?: unknown; kind?: unknown; tool?: unknown; readOnly?: unknown } | null;
    if (!rec || typeof rec !== "object") {
      reasons.push("a recompiled step is not an object");
      continue;
    }
    if (rec.kind !== "tool") {
      reasons.push(`step ${String(rec.id ?? "?")} is ${String(rec.kind)}: playback has no runtime for it`);
      continue;
    }
    const name = typeof rec.tool === "string" ? rec.tool : "";
    const match = name ? byName.get(name) : undefined;
    if (!match?.url) {
      reasons.push(`step "${name || "?"}" has no recorded URL in the drifted tool to replay`);
      continue;
    }
    projected.push({
      id: `s${projected.length + 1}`,
      kind: String(match.kind ?? "cloud_http"),
      name: match.name,
      ...(match.commute !== undefined ? { commute: match.commute } : {}),
      url: match.url,
      ...(match.command !== undefined ? { command: match.command } : {}),
      ...(match.method !== undefined ? { method: match.method } : {}),
      // Copied verbatim from the matched prior step: the recorded call's bind
      // map is what lets playback's resolveBound fill template URLs like
      // {{s1.head.sha}}. Dropping it made such drafts replay the unresolved
      // template and fail at play time.
      ...(match.bind !== undefined ? { bind: match.bind } : {}),
      // Projected from the IR step (packages/ir ToolStep.readOnly), not from
      // the prior compiled copy — the recompile may carry a fresher hint.
      // Without this, playback's stepIsReadOnly falls back to "cloud_http GET
      // ⇒ read-only" and an explicitly writable GET could be speculatively
      // prefetched, firing its side effect unwatched.
      ...(typeof rec.readOnly === "boolean" ? { readOnly: rec.readOnly } : {}),
    });
  }
  if (reasons.length || !projected.length) {
    if (!reasons.length && !projected.length) reasons.push("recompiled program contains no replayable steps");
    return { ok: false, reasons };
  }
  return { ok: true, steps: projected };
}

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
    console.error(
      `[eden-canary] ${tool.name}: drift detected (${deopts} deopts/${windowMs / 3600_000}h) but no compileTracesFn wired — cannot recompile`,
    );
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

  // 6. PASS → project the program onto what playback can actually run, and
  // refuse to queue anything that would 500 /v1/play once a human approved it.
  // Every consumer of tool.steps expects a CompiledStep[] array — storing the
  // raw StretchProgram object here made the draft dead on arrival: playback
  // buildDag calls steps.map and throws, the workshop renders zero steps.
  const projection = programToCompiledSteps(program, tool.steps);
  if (!projection.ok) {
    console.error(
      `[eden-canary] ${tool.name}: refusing to queue unplayable recompile: ${projection.reasons.join("; ")}`,
    );
    return { action: "unplayable-refused", reasons: projection.reasons };
  }
  const compiledSteps = JSON.stringify(projection.steps);
  const seq = Array.isArray((program as { sequence?: unknown }).sequence)
    ? (program as { sequence: unknown[] }).sequence.map(String)
    : [];

  // OR IGNORE + re-read convergence, same as cluster.ts's draft insert: the
  // suffix count below races concurrent ingests of the same fingerprint — two
  // writers can both compute the same @rc<n> — and the (workspace_id,
  // fingerprint) unique index is what actually enforces one row. A loser here
  // used to throw and lose the whole knock until the next deopt; now it
  // converges on whichever row survived.
  const suffixN =
    (
      await db.get<{ c: number | string }>(
        `SELECT COUNT(*) AS c FROM tool WHERE workspace_id = ? AND fingerprint LIKE ? ESCAPE '\\'`,
        [input.workspace_id, `${escapeLike(tool.fingerprint)}${RC_MARK}%`],
      )
    )?.c ?? 0;
  const rcFingerprint = `${tool.fingerprint}${RC_MARK}${Number(suffixN) + 1}`;
  let name = `${tool.name}_v2`;
  let n = 3;
  while (await db.get(`SELECT 1 as ok FROM tool WHERE workspace_id = ? AND name = ?`, [input.workspace_id, name])) {
    name = `${tool.name.slice(0, 44)}_v${n++}`;
  }
  const draftId = crypto.randomUUID();
  await db.run(
    `INSERT OR IGNORE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2)`,
    [
      draftId,
      input.workspace_id,
      name,
      input.waitingCopy ?? REFRESH_WAITING_COPY,
      QUEUED_STATE,
      compiledSteps,
      JSON.stringify(seq),
      rcFingerprint,
    ],
  );
  // The surviving row wins even if a concurrent ingest landed first.
  const queued = (
    await db.get<{ id: string }>(`SELECT id FROM tool WHERE workspace_id = ? AND fingerprint = ?`, [
      input.workspace_id,
      rcFingerprint,
    ])
  )?.id;
  const finalDraftId = queued || draftId;
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
  return { action: "queued", draft_id: finalDraftId, knock_id: knockId, verdict: "PASS" };
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
    .all<{ tool_id: string; last_deopt: number }>(
      // Newest first: LIMIT without ORDER BY leaves the set to the planner's
      // mood, so a hot ledger could starve the tools a human most needs told
      // about. Grouped rather than DISTINCT-ordered: Postgres requires every
      // DISTINCT ORDER BY expression in the select list, and this shape is
      // portable across both drivers.
      `SELECT tool_id, MAX(created_at) AS last_deopt FROM deopt_event
        WHERE workspace_id = ? AND created_at >= ?
        GROUP BY tool_id ORDER BY last_deopt DESC LIMIT 5`,
      [workspaceId, Date.now() - windowMs],
    )
    .catch((err: unknown) => {
      // Swallowed by contract (ingest must not wait on the canary), but a
      // silently dead sweep looks exactly like no drift anywhere.
      console.error("[eden-canary] deopt ledger sweep failed:", err);
      return [] as Array<{ tool_id: string; last_deopt: number }>;
    });
  for (const row of rows) {
    try {
      await maybeRecompile(db, { ...deps, workspace_id: workspaceId, tool_id: row.tool_id });
    } catch (err) {
      console.error(`[eden-canary] unhandled error for tool ${row.tool_id}:`, err);
    }
  }
}

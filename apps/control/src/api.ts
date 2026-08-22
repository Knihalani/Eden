import { timingSafeEqual } from "node:crypto";
import type { Binding, IslandCaller, Refusal, StretchProgram, StretchTrace, ToolRegistry } from "@eden/ir";
import { withVersion, isCheckName, validateProgram, canonicalize, minLlmReductionOf, hashStretch, liveTimeSavedMs } from "@eden/ir";
import { isDeopt, isReplaySafe, runProgram } from "@eden/runtime";
import { wrapTimeoutMs, attachChatUsage, peekChatUsage, resetUsage, type WrapState } from "@eden/wrap";
import { compileTraces } from "@eden/compile";
import { canApprove, registryCovers, replayRegistry, shadowProgram, uncoveredTools } from "@eden/shadow";
import { pushPrev, type Candidate, type Store } from "./store";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export type ApiCtx = {
  store: Store;
  registry?: ToolRegistry;
  island?: IslandCaller;
  /** Absent means nothing is authorised, not that everything is. */
  token?: string;
  /**
   * A throwaway world to shadow a write-performing candidate against.
   *
   * Called once per held-out trace and expected to return a registry whose
   * effects nobody will see. Without it, a candidate containing a mutating
   * step is refused rather than validated by actually performing the mutation
   * — see the comment at the shadowProgram call below. `replayRegistry` is a
   * ready-made implementation for the case where the recorded trace answers
   * every call the program makes.
   */
  sandboxFor?: (t: StretchTrace) => ToolRegistry;
  /** Shared with the chat proxy so scraped `usage` lands on the next posted trace. */
  wrapState?: WrapState;
};

/**
 * Is this request allowed to drive the control plane?
 *
 * This used to return true when `ctx.token` was empty, which is failing open
 * on the one input an embedder is most likely to leave unset — and handleApi
 * is a public export, so `handleApi(req, url, { token: "" })` was a wide-open
 * API. No token configured now means nothing is authorised; the server
 * refuses to start without one.
 */
function auth(req: Request, ctx: ApiCtx): boolean {
  if (!ctx.token) return false;
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.*)$/i.exec(h);
  if (!m) return false;
  return timingSafeEqualStr(m[1]!, ctx.token);
}

/** Compare without letting the response time reveal a prefix match. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Echo the caller's origin only when it is local.
 *
 * Every response used to carry `access-control-allow-origin: *`, so any page
 * on the internet could read the control plane's replies.
 */
function corsFor(req?: Request): Record<string, string> {
  const origin = req?.headers.get("origin") || "";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return { vary: "origin" };
  return { "access-control-allow-origin": origin, vary: "origin" };
}

function json(data: unknown, status = 200, req?: Request): Response {
  return Response.json(data, { status, headers: { ...corsFor(req), "cache-control": "private, no-store" } });
}

function receiptExtras(row: { payload?: string | null }): Record<string, unknown> {
  if (!row.payload) return {};
  try {
    const parsed = JSON.parse(String(row.payload)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function expandReceipt(row: { payload?: string | null } & Record<string, unknown>): Record<string, unknown> {
  const extra = receiptExtras(row);
  const { payload: _payload, ...rest } = row;
  return { ...rest, ...extra };
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return { ok: false, res: json({ error: "invalid json" }, 400) };
  }
}

function syncLiveTools(store: Store): void {
  try {
    const dir = process.env.EDEN_HOME || join(homedir(), ".eden");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "live-tools.json"),
      JSON.stringify(
        store.livePrograms().map((p) => ({
          name: p.name,
          sequence: p.sequence ?? [],
          id: p.id,
          envelope: p.contract.envelope ?? null,
        })),
      ),
    );
  } catch {
    /* fail-open */
  }
}

/**
 * Every shadow run in this file goes through here.
 *
 * Shadowing replays a candidate once per held-out trace, so handing it the
 * live registry means validating a stretch that updates an issue and notifies
 * by performing n real updates and n real notifications — in order to decide
 * whether the program should be allowed to perform them. There were four call
 * sites and the decision has to be the same at all of them, so it is made
 * once, here: with a sandbox, a write-performing candidate is validated
 * against the sandbox; without one, shadowProgram refuses it and says why.
 */
function shadowCandidate(ctx: ApiCtx, program: StretchProgram) {
  return shadowProgram(program, ctx.store.traces(), {
    registry: ctx.registry ?? { execute: async () => undefined, has: () => false },
    registryFor: ctx.sandboxFor,
    island: ctx.island,
    allowSideEffects: Boolean(ctx.sandboxFor),
  });
}

async function runCompile(ctx: ApiCtx): Promise<{ programs: number; refusals: number }> {
  ctx.store.clearCandidates();
  const compiled = compileTraces(ctx.store.traces(), { minLlmReduction: minLlmReductionOf(Number(process.env.EDEN_MIN_LLM_REDUCTION)) });
  for (const program of compiled.programs) {
    let verdict: "PASS" | "FAIL" | "INCONCLUSIVE" | "pending" = "pending";
    let manifest = program.manifest;
    let refusal: Refusal | null = null;
    const missing = uncoveredTools(ctx.registry, program);
    if (ctx.registry && missing.length) {
      refusal = { sequence: program.sequence ?? [], reason: `uncovered: ${missing.join(", ")}` };
    } else if (ctx.registry || ctx.sandboxFor) {
      const sh = await shadowCandidate(ctx, program);
      verdict = sh.verdict;
      manifest = sh.manifest;
      if (manifest) program.manifest = manifest;
      if (sh.verdict !== "PASS" && sh.reasons.length) {
        refusal = { sequence: program.sequence ?? [], reason: sh.reasons[0]! };
      }
    } else {
      refusal = { sequence: program.sequence ?? [], reason: "no wrap registry — start eden wrap to replay this stretch" };
    }
    ctx.store.putCandidate({
      id: program.id,
      sequence: program.sequence ?? [],
      program,
      refusal,
      verdict,
      manifest,
      created_at: Date.now(),
    });
  }
  for (const refusal of compiled.refusals) {
    ctx.store.putCandidate({
      id: `ref_${createHash("sha256").update(canonicalize({ sequence: refusal.sequence, reason: refusal.reason })).digest("hex").slice(0, 12)}`,
      sequence: refusal.sequence,
      program: null,
      refusal,
      verdict: "FAIL",
      manifest: null,
      created_at: Date.now(),
    });
  }
  return { programs: compiled.programs.length, refusals: compiled.refusals.length };
}

type BindEdit = { step: string; field: string; path?: string; from?: string };
type Edits = { name?: string; forceIsland?: string[]; drop?: string[]; pinAssert?: string[]; bind?: BindEdit[] };

function patchBinding(b: Binding, edit: BindEdit, known: Set<string>): Binding | { error: string } {
  if (b.kind === "from") {
    const from = edit.from ?? b.step;
    const path = edit.path ?? b.path;
    if (edit.from && !known.has(edit.from)) return { error: `unknown step ${edit.from}` };
    if (edit.path !== undefined && !edit.path.trim()) return { error: "missing path" };
    return { kind: "from", step: from, path };
  }
  if (b.kind === "input" && edit.path !== undefined) {
    if (!edit.path.trim()) return { error: "missing path" };
    return { kind: "input", path: edit.path };
  }
  if (b.kind === "transform") {
    const of = patchBinding(b.of, edit, known);
    if ("error" in of) return of;
    return { ...b, of };
  }
  return b;
}

function applyBindEdits(program: StretchProgram, binds: BindEdit[]): StretchProgram | { error: string } {
  const known = new Set(program.steps.map((s) => s.id));
  let steps = program.steps;
  for (const edit of binds) {
    const i = steps.findIndex((s) => s.id === edit.step);
    if (i < 0) return { error: `unknown step ${edit.step}` };
    const s = steps[i]!;
    const apply = (b: Binding) => patchBinding(b, edit, known);
    if (s.kind === "tool") {
      const cur = s.args[edit.field];
      if (!cur) return { error: `unknown field ${edit.field}` };
      const next = apply(cur);
      if ("error" in next) return next;
      steps = steps.map((row, j) => (j === i ? { ...s, args: { ...s.args, [edit.field]: next } } : row));
    } else if (s.kind === "island" && edit.field === "input") {
      const next = apply(s.input);
      if ("error" in next) return next;
      steps = steps.map((row, j) => (j === i ? { ...s, input: next } : row));
    } else if (s.kind === "loop" && edit.field === "over") {
      const next = apply(s.over);
      if ("error" in next) return next;
      steps = steps.map((row, j) => (j === i ? { ...s, over: next } : row));
    } else {
      return { error: `unknown field ${edit.field}` };
    }
  }
  return { ...program, steps };
}

async function shipCandidate(
  ctx: ApiCtx,
  c: Candidate,
  edits?: Edits,
): Promise<{ ok: true; program: StretchProgram } | { ok: false; status: number; error: string; extra?: Record<string, unknown> }> {
  if (!c.program) return { ok: false, status: 409, error: c.refusal?.reason || "refused" };
  if (c.verdict !== "PASS") {
    const error =
      c.verdict === "pending"
        ? c.refusal?.reason || "shadow pending"
        : c.verdict === "FAIL"
          ? c.refusal?.reason || "shadow failed"
          : `${c.verdict} does not ship`;
    return { ok: false, status: 409, error, extra: { verdict: c.verdict } };
  }
  if (
    !canApprove({
      verdict: "PASS",
      manifest: c.manifest,
      reasons: [],
      n: c.manifest?.nShadow ?? 0,
      minLlmReduction: c.program.contract?.minLlmReduction,
    })
  ) {
    return { ok: false, status: 409, error: "shadow did not pass" };
  }
  let program = c.program;
  const next: Edits = {};
  if (edits?.name && edits.name !== program.name) next.name = edits.name;
  if (edits?.drop?.length) next.drop = edits.drop;
  if (edits?.forceIsland?.length) next.forceIsland = edits.forceIsland;
  if (edits?.pinAssert?.length) next.pinAssert = edits.pinAssert;
  if (edits?.bind?.length) next.bind = edits.bind;
  const structural = Boolean(next.drop?.length || next.forceIsland?.length || next.pinAssert?.length || next.bind?.length);
  edits = next.name || structural ? next : undefined;
  if (edits?.name) program = { ...program, name: edits.name };
  if (edits?.bind?.length) {
    const bound = applyBindEdits(program, edits.bind);
    if ("error" in bound) return { ok: false, status: 409, error: bound.error };
    program = bound;
  }
  if (edits?.drop?.length) {
    const drop = new Set(edits.drop);
    const dropped = program.steps.filter((s) => drop.has(s.id));
    if (dropped.some((s) => s.kind === "assert" || (s.kind === "tool" && isCheckName(s.tool)))) {
      return { ok: false, status: 409, error: "cannot drop a pinned check" };
    }
    const nextSteps = program.steps
      .filter((s) => !drop.has(s.id))
      .map((s) => (s.kind === "loop" ? { ...s, body: s.body.filter((id) => !drop.has(id)) } : s));
    if (nextSteps.some((s) => s.kind === "loop" && s.body.length === 0)) {
      return { ok: false, status: 409, error: "drop emptied a loop" };
    }
    if (program.returns && program.returns.kind === "from" && drop.has(program.returns.step)) {
      return { ok: false, status: 409, error: "cannot drop the return step" };
    }
    program = { ...program, steps: nextSteps };
    const issues = validateProgram(program);
    if (issues.length) return { ok: false, status: 409, error: issues[0]!.message, extra: { issues } };
  }
  if (edits?.forceIsland?.length) {
    const force = new Set(edits.forceIsland);
    program = {
      ...program,
      steps: program.steps.map((s) =>
        s.kind === "tool" && force.has(s.id)
          ? {
              id: s.id,
              kind: "island" as const,
              input: Object.values(s.args)[0] ?? { kind: "input" as const, path: "" },
              system: `Perform ${s.tool}. Return JSON.`,
              outputSchema: { type: "object" },
            }
          : s,
      ),
    };
  }
  if (edits?.pinAssert?.length) {
    program = {
      ...program,
      steps: [
        ...program.steps,
        ...edits.pinAssert.map((expr, i) => ({
          id: `pin_${i}`,
          kind: "assert" as const,
          expr,
          onFail: "error" as const,
        })),
      ],
    };
  }
  if (structural && !ctx.registry && !ctx.sandboxFor) {
    return { ok: false, status: 409, error: "dropping or rewriting a step needs the wrap agent connected so Eden can re-check the stretch" };
  }
  if (structural && (ctx.registry || ctx.sandboxFor)) {
    program = withVersion({ ...program, version: undefined });
    const sh = await shadowCandidate(ctx, program);
    if (sh.verdict !== "PASS") return { ok: false, status: 409, error: "re-shadow after edit did not pass", extra: { shadow: sh } };
    program = { ...program, manifest: sh.manifest };
  } else if (ctx.registry && registryCovers(ctx.registry, program) && ctx.store.tracesCount() >= 3) {
    const sh = await shadowCandidate(ctx, program);
    if (sh.verdict !== "PASS") return { ok: false, status: 409, error: "re-shadow on approve did not pass", extra: { shadow: sh } };
    program = { ...program, manifest: sh.manifest };
  }
  const existing = ctx.store.tool(program.id);
  ctx.store.putTool({
    id: program.id,
    name: program.name,
    version: program.version,
    program,
    state: "live",
    prev: pushPrev(existing),
    created_at: existing?.created_at ?? Date.now(),
    updated_at: Date.now(),
  });
  syncLiveTools(ctx.store);
  ctx.store.deleteCandidate(c.id);
  return { ok: true, program };
}

async function maybeAutoApprove(ctx: ApiCtx): Promise<number> {
  if (process.env.EDEN_AUTO_APPROVE !== "1") return 0;
  let n = 0;
  for (const c of ctx.store.candidates()) {
    const r = await shipCandidate(ctx, c);
    if (r.ok) n++;
  }
  return n;
}

export async function handleApi(req: Request, url: URL, ctx: ApiCtx): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/health" && req.method === "GET") {
    ctx.store.heartbeat();
    return json({
      ok: true,
      heartbeat: ctx.store.lastHeartbeat(),
      traces: ctx.store.tracesCount(),
      live: ctx.store.liveCount(),
      candidates: ctx.store.candidatesCount(),
      receipts: ctx.store.receiptsCount(),
      fails: ctx.store.failsCount(),
      savings: ctx.store.savings(),
      minLlmReduction: minLlmReductionOf(Number(process.env.EDEN_MIN_LLM_REDUCTION)),
      registry: Boolean(ctx.registry),
      island: Boolean(ctx.island),
    });
  }
  // No exemptions. /v1/inbox was exempt while /v1/candidates and /v1/tools —
  // both strict subsets of what it returns — required a key, so it was a
  // straight authorization bypass over the whole store: every compiled program
  // with the literal arguments mined from real traces, readable with no
  // credential at all.
  if (p.startsWith("/v1/") && !auth(req, ctx)) {
    return json({ error: "unauthorized" }, 401, req);
  }
  if (p === "/v1/stats" && req.method === "GET") {
    return json({
      traces: ctx.store.tracesCount(),
      live: ctx.store.liveCount(),
      candidates: ctx.store.candidatesCount(),
      receipts: ctx.store.receiptsCount(),
      fails: ctx.store.failsCount(),
      savings: ctx.store.savings(),
    });
  }

  if (p === "/v1/savings" && req.method === "GET") {
    return json(ctx.store.savings());
  }

  if (p === "/v1/traces" && req.method === "POST") {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as StretchTrace | { traces?: StretchTrace[] };
    const list = Array.isArray((body as { traces?: StretchTrace[] }).traces)
      ? (body as { traces: StretchTrace[] }).traces
      : [body as StretchTrace];
    return ctx.store.enqueue(async () => {
      let accepted = 0;
      let duplicates = 0;
      const usage = ctx.wrapState ? peekChatUsage(ctx.wrapState) : null;
      let consumed = false;
      for (const t of list) {
        if (!t || !Array.isArray(t.events) || !t.events.length) continue;
        const sealed = !consumed ? attachChatUsage(t, usage) : t;
        if (ctx.store.putTrace(sealed)) {
          accepted++;
          if (!consumed && usage && ctx.wrapState && sealed !== t) {
            resetUsage(ctx.wrapState.run);
            consumed = true;
          }
        } else {
          duplicates++;
          if (!consumed && usage && ctx.wrapState && sealed !== t && ctx.store.sealUnmeasured(sealed)) {
            resetUsage(ctx.wrapState.run);
            consumed = true;
          }
        }
      }
      ctx.store.heartbeat();
      const n = ctx.store.tracesCount();
      if (n >= 3 && n !== ctx.store.compiledCount()) {
        await runCompile(ctx);
        ctx.store.setCompiledCount(n);
        await maybeAutoApprove(ctx);
      }
      return json({ ok: true, n: list.length, accepted, duplicates });
    });
  }

  if (p === "/v1/compile" && req.method === "POST") {
    return ctx.store.enqueue(async () => {
      const out = await runCompile(ctx);
      ctx.store.setCompiledCount(ctx.store.tracesCount());
      const shipped = await maybeAutoApprove(ctx);
      return json({ ok: true, ...out, shipped });
    });
  }

  if (p === "/v1/traces" && req.method === "GET") {
    return json({ traces: ctx.store.traces() });
  }

  if (p === "/v1/candidates" && req.method === "GET") {
    return json({ candidates: ctx.store.candidates() });
  }

  if (p === "/v1/inbox" && req.method === "GET") {
    return json({
      heartbeat: ctx.store.lastHeartbeat(),
      connected: Date.now() - ctx.store.lastHeartbeat() < 30_000,
      sig: ctx.store.inboxSig(),
      candidates: ctx.store.candidates(),
      live: ctx.store.tools()
        .filter((t) => t.state === "live" || t.state === "paused")
        .map((t) => {
          const stats = ctx.store.receiptStats(t.id);
          const last = ctx.store.receiptsFor(t.id)[0];
          const stack = Array.isArray(t.prev) ? t.prev : t.prev ? [t.prev] : [];
          return {
            id: t.id,
            name: t.name,
            version: t.version,
            program: t.program,
            state: t.state,
            created_at: t.created_at,
            updated_at: t.updated_at,
            stats,
            last: last
              ? {
                  ok: last.ok,
                  ms: last.ms,
                  llm_calls: last.llm_calls,
                  created_at: last.created_at,
                  ...receiptExtras(last),
                }
              : null,
            canRollback: stack.length > 0,
          };
        }),
      savings: ctx.store.savings(),
    });
  }

  const shadowMatch = p.match(/^\/v1\/candidates\/([^/]+)\/shadow$/);
  if (shadowMatch && req.method === "POST") {
    const c = ctx.store.candidate(shadowMatch[1]!);
    if (!c) return json({ error: "not found" }, 404);
    if (!c.program) return json({ error: "refused" }, 409);
    if (!ctx.registry && !ctx.sandboxFor) return json({ error: "no registry for shadow" }, 409);
    const missing = uncoveredTools(ctx.registry, c.program);
    if (ctx.registry && missing.length) return json({ error: `uncovered: ${missing.join(", ")}` }, 409);
    const sh = await shadowCandidate(ctx, c.program);
    c.verdict = sh.verdict;
    c.manifest = sh.manifest;
    c.program = { ...c.program, manifest: sh.manifest };
    c.refusal =
      sh.verdict === "PASS" ? null : sh.reasons[0] ? { sequence: c.sequence, reason: sh.reasons[0] } : c.refusal;
    ctx.store.putCandidate(c);
    return json({ ok: true, verdict: sh.verdict, manifest: sh.manifest, reasons: sh.reasons, n: sh.n });
  }

  if (p === "/v1/wrap-run" && req.method === "POST") {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as {
      toolId?: string;
      program?: StretchProgram;
      input?: Record<string, unknown>;
      timeoutMs?: number;
      timeout?: number;
    };
    if (body.input != null && (typeof body.input !== "object" || Array.isArray(body.input))) {
      return json({ error: "input must be an object" }, 400);
    }
    const found =
      (body.toolId ? ctx.store.tool(body.toolId) : undefined) ??
      ctx.store.tools().find(
        (t) => t.id === body.program?.id || t.name === body.program?.name || t.program.name === body.program?.name,
      );
    if (!found) return json({ error: "not live" }, 404);
    if (found.state === "paused") return json({ error: "paused", program: found.name }, 409);
    if (found.state !== "live") return json({ error: "not live", state: found.state }, 409);
    const live = found;
    if (!ctx.registry) return json({ error: "no registry" }, 409);
    const q = Number(url.searchParams.get("timeout"));
    const timeoutMs = wrapTimeoutMs(Number.isFinite(q) && q > 0 ? q : body.timeoutMs ?? body.timeout);
    try {
      const run = await runProgram(live.program, body.input ?? {}, {
        registry: ctx.registry,
        island: ctx.island,
        timeoutMs,
      });
      ctx.store.putReceipt({
        tool_id: live.id,
        version: live.version,
        ms: run.stats.ms,
        llm_calls: run.stats.llmCalls,
        cents: run.stats.cents,
        ok: 1,
        payload: JSON.stringify({
          outcome: "ok",
          stepsRun: run.stats.stepsRun,
          early: false,
          skipped: run.stats.skipped,
          fingerprint: hashStretch(live.program),
          timeSavedMs: liveTimeSavedMs(live.program, run.stats.ms, true),
        }),
      });
      return json({ ok: true, value: run.value, stats: run.stats });
    } catch (err) {
      if (isDeopt(err)) {
        ctx.store.putReceipt({
          tool_id: live.id,
          version: live.version,
          ms: err.ms,
          llm_calls: err.llmCalls,
          cents: err.cents,
          ok: 0,
          payload: JSON.stringify({
            outcome: "deopt",
            deoptReason: err.reason,
            early: isReplaySafe(err),
            stepsRun: err.stepsRun,
            fingerprint: hashStretch(live.program),
          }),
        });
        return json(
          { error: "deopt", reason: err.reason, deopt: true, early: isReplaySafe(err), stepsRun: err.stepsRun, program: live.name },
          409,
        );
      }
      return json({ error: String(err) }, 500);
    }
  }

  const approve = p.match(/^\/v1\/tools\/([^/]+)\/approve$/);
  if (approve && req.method === "POST") {
    const c = ctx.store.candidate(approve[1]!);
    if (!c) return json({ error: "not found" }, 404);
    const body = (await req.json().catch(() => ({}))) as { edits?: Edits };
    const shipped = await shipCandidate(ctx, c, body.edits);
    if (!shipped.ok) return json({ error: shipped.error, ...shipped.extra }, shipped.status);
    return json({ ok: true, id: shipped.program.id, name: shipped.program.name, program: shipped.program });
  }

  const pause = p.match(/^\/v1\/tools\/([^/]+)\/(pause|rollback|resume)$/);
  if (pause && req.method === "POST") {
    const t = ctx.store.tool(pause[1]!);
    if (!t) return json({ error: "not found" }, 404);
    if (pause[2] === "pause") t.state = "paused";
    else if (pause[2] === "resume") {
      if (t.state !== "paused" && t.state !== "rolled_back") return json({ error: "not paused" }, 409);
      t.state = "live";
    } else {
      const stack = Array.isArray(t.prev) ? t.prev : t.prev ? [t.prev] : [];
      const top = stack[0];
      if (!top) return json({ error: "nothing to rollback" }, 409);
      t.state = "rolled_back";
      t.program = top;
      t.version = top.version;
      t.prev = stack.slice(1);
    }
    t.updated_at = Date.now();
    ctx.store.putTool(t);
    syncLiveTools(ctx.store);
    return json({ ok: true, state: t.state });
  }

  const prog = p.match(/^\/v1\/tools\/([^/]+)\/program$/);
  if (prog && req.method === "GET") {
    const t = ctx.store.tool(prog[1]!);
    if (!t || t.state !== "live") return json({ error: "not found" }, 404);
    return json(t.program);
  }

  const one = p.match(/^\/v1\/tools\/([^/]+)$/);
  if (one && req.method === "GET") {
    const t = ctx.store.tool(one[1]!);
    if (!t) return json({ error: "not found" }, 404);
    return json(t);
  }

  if (p === "/v1/tools" && req.method === "GET") {
    const state = url.searchParams.get("state");
    const tools = state ? ctx.store.tools().filter((t) => t.state === state) : ctx.store.tools();
    return json({ tools });
  }

  if (p === "/v1/receipts" && req.method === "GET") {
    const toolId = url.searchParams.get("tool");
    const rows = toolId ? ctx.store.receiptsFor(toolId) : ctx.store.receipts();
    return json({ receipts: rows.map(expandReceipt) });
  }

  const delCand = p.match(/^\/v1\/candidates\/([^/]+)$/);
  if (delCand && req.method === "GET") {
    const c = ctx.store.candidate(delCand[1]!);
    if (!c) return json({ error: "not found" }, 404);
    return json(c);
  }
  if (delCand && req.method === "DELETE") {
    if (!ctx.store.deleteCandidate(delCand[1]!)) return json({ error: "not found" }, 404);
    return json({ ok: true });
  }

  if (p === "/v1/receipts" && req.method === "POST") {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const b = parsed.value as {
      toolId?: string;
      version?: string;
      ms?: number;
      llmCalls?: number;
      cents?: number;
      ok?: boolean;
      early?: boolean;
      deoptReason?: string;
      stepsRun?: number;
      skipped?: string[];
      outcome?: string;
      tokens?: number;
      tokensSaved?: number | null;
      timeSavedMs?: number | null;
      fingerprint?: string;
    };
    if (!b.toolId) return json({ error: "toolId required" }, 400);
    ctx.store.putReceipt({
      tool_id: b.toolId,
      version: b.version ?? "",
      ms: Number(b.ms) || 0,
      llm_calls: Number(b.llmCalls) || 0,
      cents: Number(b.cents) || 0,
      ok: b.ok ? 1 : 0,
      payload: JSON.stringify({
        early: b.early,
        deoptReason: b.deoptReason,
        stepsRun: b.stepsRun,
        skipped: b.skipped,
        outcome: b.outcome,
        tokens: b.tokens,
        tokensSaved: b.tokensSaved,
        timeSavedMs: b.timeSavedMs,
        fingerprint: b.fingerprint,
      }),
    });
    return json({ ok: true });
  }

  return null;
}

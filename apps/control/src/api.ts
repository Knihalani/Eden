import { timingSafeEqual } from "node:crypto";
import type { Binding, IslandCaller, ProgramDiff, Refusal, StretchProgram, StretchTrace, TraceEvent, ToolRegistry } from "@eden/ir";
import { withVersion, isCheckName, validateProgram, canonicalize, minLlmReductionOf, diffPrograms, redact, dropEnvelopeValue, whenToUseOf, EDEN_PROTOCOL_VERSION, PROTOCOL_HEADER } from "@eden/ir";
import { wrapTimeoutMs, attachChatUsage, peekChatUsage, resetUsage, dispatchPrograms, dispatchMessages, compiledSchema, extractInput, type WrapState } from "@eden/wrap";
import { compileTraces } from "@eden/compile";
import { inheritLiveTool } from "./inherit-live";
import { canApprove, registryCovers, replayRegistry, shadowProgram, uncoveredTools } from "@eden/shadow";
import { pushPrev, Store, type Candidate, type LiveTool } from "./store";
import { exportAudit } from "./audit-export";
import { actorOf, exportAccessReview } from "./access-review";
import { EMPTY_DIGEST, renderDigestText, type DigestInput } from "@eden/measure";
import { cacheHitPctFromReceipts } from "../../../packages/cli/src/digest";
import { dcWindowFromReceipts, parseDayCount } from "./dc-window";
import { isRefreshCandidate, maybeQueueRefresh, refreshCandidateId } from "./refresh";
import {
  executeLiveRun,
  parseCron,
  parseNow,
  parseScheduleInput,
  tickDueSchedules,
} from "./schedule";
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

/**
 * Shared page size for the list endpoints (`/v1/traces`, `/v1/receipts`).
 * These used to return everything, unbounded — a long-running deployment
 * could grow both tables without limit and the GETs would happily serialise
 * all of it on every poll.
 */
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

/**
 * Parse the `limit` query param: integer page size, default 100, hard cap
 * 1000. Garbage falls back to the default rather than erroring, matching how
 * /v1/tools/run treats a bogus `timeout`.
 */
function listLimitOf(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.trim() === "") return DEFAULT_LIST_LIMIT;
  const q = Number(raw);
  if (!Number.isFinite(q)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(q)));
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
  return Response.json(data, {
    status,
    headers: {
      ...corsFor(req),
      "cache-control": "private, no-store",
      [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION),
    },
  });
}

/**
 * Which Clerk org is this request acting for? The web plane sends it on every
 * call after its Clerk gate; a bearer token alone says nothing about tenancy,
 * because every org of a deployment shares one control-plane key.
 */
const ORG_HEADER = "x-eden-org";

/**
 * Whether this process serves a real deployment rather than a laptop. Mirrors
 * apps/site's managed-install check (DATABASE_URL / VERCEL, EDEN_DEV override)
 * so both planes agree on when permissive dev behaviour is allowed.
 */
export function isManagedDeployment(): boolean {
  return Boolean(process.env.DATABASE_URL) || Boolean(process.env.VERCEL);
}

function devFallbackAllowed(): boolean {
  return isManagedDeployment() ? process.env.EDEN_DEV === "1" : process.env.EDEN_DEV !== "0";
}

/** Warn once per store: legacy unbound workspaces keep working only in dev. */
const warnedStores = new WeakSet<object>();

/**
 * Tenant gate for state-changing routes.
 *
 * A bound workspace only accepts its own org — any other (or absent) org id is
 * refused, so one tenant can never approve, pause or dismiss another's tools.
 * A workspace with no binding at all is legacy: dev installs keep working with
 * a stderr warning, while managed deployments must refuse an unmapped org —
 * that is the whole point of the binding. Read-only routes stay key-gated and
 * skip this check entirely.
 */
function orgGate(req: Request, ctx: ApiCtx): Response | null {
  const org = (req.headers.get(ORG_HEADER) || "").trim();
  const bound = ctx.store.orgsFor(Store.WORKSPACE_ID);
  if (!bound.length) {
    if (devFallbackAllowed()) {
      if (!warnedStores.has(ctx.store)) {
        warnedStores.add(ctx.store);
        console.error(
          "[eden] workspace has no org binding; allowing unscoped state change only because this install is unmanaged — bind via POST /v1/workspace/orgs",
        );
      }
      return null;
    }
    return json({ error: "workspace not bound to this org" }, 403, req);
  }
  if (!org || !bound.includes(org)) return json({ error: "workspace not bound to this org" }, 403, req);
  return null;
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

/**
 * What a candidate changes relative to the program it would replace.
 *
 * The prior side is the live/pinned tool for the same stretch id; a candidate
 * for a stretch with nothing live yet is brand-new and diffs to null — there
 * is nothing to review it against. Structured output from diffPrograms, so
 * reviewers see "step b added, field id now a hardcoded literal" instead of
 * reading two JSON blobs.
 */
function candidateDiff(store: Store, program: StretchProgram | null): ProgramDiff | null {
  if (!program) return null;
  const live = store.tool(program.id);
  if (!live) return null;
  return diffPrograms(live.program, program);
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
        store
          .tools()
          .filter((t) => t.state === "live")
          .map((t) => {
            const seq = t.program.sequence ?? [];
            const write = seq.includes("Write");
            return {
              name: t.program.name,
              sequence: seq,
              id: t.id,
              envelope: t.program.contract.envelope ?? null,
              read_only: !write,
              when_to_use: whenToUseOf(t.program),
              ...(t.transparent_writes ? { transparent_writes: true } : {}),
              ...(t.rollout === "canary" || t.rollout === "live" ? { rollout: t.rollout } : {}),
            };
          }),
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
  const keepRefresh = ctx.store.candidates().filter((c) => isRefreshCandidate(c.id));
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
  for (const c of keepRefresh) ctx.store.putCandidate(c);
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

type DropValue = { path: string; value: unknown };

async function shipCandidate(
  ctx: ApiCtx,
  c: Candidate,
  edits?: Edits,
  opts?: {
    transparentWrites?: boolean;
    rollout?: "canary" | "live";
    dropValues?: DropValue[];
    pinIslands?: boolean;
    /** Org id from x-eden-org, or omitted → "operator". Never a person name. */
    approvedBy?: string;
  },
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
  const drops = Array.isArray(opts?.dropValues) ? opts.dropValues : [];
  if (drops.length) {
    let envelope = program.contract.envelope;
    if (!envelope?.inputs) return { ok: false, status: 409, error: "no envelope to tighten" };
    for (const row of drops) {
      if (!row || typeof row.path !== "string" || !row.path) {
        return { ok: false, status: 409, error: "dropValues need a path" };
      }
      const next = dropEnvelopeValue(envelope, row.path, row.value);
      if (!next.ok) return { ok: false, status: 409, error: next.error };
      envelope = next.envelope;
    }
    program = { ...program, contract: { ...program.contract, envelope } };
  }
  if (opts?.pinIslands === true) {
    program = {
      ...program,
      steps: program.steps.map((s) => (s.kind === "island" ? { ...s, pinned: true } : s)),
    };
  }
  if (drops.length || opts?.pinIslands === true) {
    program = withVersion({ ...program, version: undefined });
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
    ...(opts?.transparentWrites === true || (opts?.transparentWrites !== false && existing?.transparent_writes)
      ? { transparent_writes: true }
      : {}),
    rollout: opts?.rollout === "live" ? "live" : "canary",
    approved_by: actorOf(opts?.approvedBy),
    approved_at: Date.now(),
  });
  syncLiveTools(ctx.store);
  ctx.store.deleteCandidate(c.id);
  return { ok: true, program };
}

async function maybeAutoApprove(ctx: ApiCtx): Promise<number> {
  // Same predicate as apps/site's handleFetch: auto-approve must be impossible
  // anywhere credentials are actually required, not only on Vercel. The env
  // var used to survive onto managed installs, where a single posted trace
  // batch that crosses the compile threshold shipped every PASS candidate with
  // no review at all.
  if (isManagedDeployment() && process.env.EDEN_DEV !== "1") delete process.env.EDEN_AUTO_APPROVE;
  if (process.env.EDEN_AUTO_APPROVE !== "1") return 0;
  let n = 0;
  for (const c of ctx.store.candidates()) {
    // Drift replacements stay human-only even when auto-approve is on.
    if (isRefreshCandidate(c.id)) continue;
    const r = await shipCandidate(ctx, c);
    if (r.ok) n++;
  }
  return n;
}

/** Same seed ids Home drops so digest tiles cannot count demo fixtures. */
const SEED_IDS = new Set(["cand_resolve", "cand_pending", "cand_refused", "live_notify", "live_paused"]);

function digestFromStore(store: Store): DigestInput {
  const live = store.tools().filter((t) => t.state === "live" && !SEED_IDS.has(t.id));
  const compiled = live.length;
  const canary = live.filter((t) => t.rollout === "canary").length;
  const runs = live.reduce((sum, t) => sum + store.receiptStats(t.id).n, 0);
  const receiptFails = live.reduce((sum, t) => sum + store.receiptStats(t.id).fail, 0);
  const candidates = store.candidates().filter((c) => !SEED_IDS.has(c.id));
  const waiting = candidates.filter((c) => !c.refusal && c.verdict !== "FAIL").length;
  const requestFails = candidates.filter((c) => Boolean(c.refusal) || c.verdict === "FAIL").length;
  const receipts = store.receipts().filter((r) => !SEED_IDS.has(r.tool_id));
  const dc = dcWindowFromReceipts(receipts, 7);
  const cacheHitPct = cacheHitPctFromReceipts(receipts.map(expandReceipt));
  let tok = 0;
  let withTok = 0;
  for (const t of live) {
    const m = t.program.manifest;
    if (m?.tokensMeasured && m.tokensSaved != null && Number.isFinite(m.tokensSaved)) {
      tok += m.tokensSaved;
      withTok++;
    }
  }
  return {
    ...EMPTY_DIGEST,
    compiled,
    runs,
    waiting,
    fails: requestFails + receiptFails,
    tokensSaved: withTok ? Math.max(0, Math.round(tok / withTok)) : 0,
    dcPct: dc.current.measured ? dc.current.dcPct : null,
    cacheHitPct,
    ...(canary ? { canary } : {}),
  };
}

/**
 * Persist traces and compile when the ≥3 threshold is crossed.
 * Shared by POST /v1/traces and POST /v1/ingest so ingest cannot skip compile
 * or Approve on its own — maybeAutoApprove still requires EDEN_AUTO_APPROVE=1.
 */
async function commitTraces(
  ctx: ApiCtx,
  list: StretchTrace[],
): Promise<{ accepted: number; duplicates: number }> {
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
    return { accepted, duplicates };
  });
}

const INGEST_RUN_CAP = 256;
const INGEST_EVENT_CAP = 500;

type BufferedRun = { events: TraceEvent[]; agentId?: string; at: number };
const ingestByStore = new WeakMap<object, Map<string, BufferedRun>>();

function ingestRuns(store: object): Map<string, BufferedRun> {
  let m = ingestByStore.get(store);
  if (!m) {
    m = new Map();
    ingestByStore.set(store, m);
  }
  return m;
}

function bufferIngest(store: object, runId: string, events: TraceEvent[], agentId?: string): BufferedRun {
  const buf = ingestRuns(store);
  let row = buf.get(runId);
  if (!row) {
    if (buf.size >= INGEST_RUN_CAP) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, r] of buf) {
        if (r.at < oldestAt) {
          oldestAt = r.at;
          oldestId = id;
        }
      }
      if (oldestId) buf.delete(oldestId);
    }
    row = { events: [], at: Date.now(), agentId };
    buf.set(runId, row);
  }
  if (agentId) row.agentId = agentId;
  if (events.length) {
    row.events.push(...events);
    if (row.events.length > INGEST_EVENT_CAP) row.events = row.events.slice(-INGEST_EVENT_CAP);
  }
  row.at = Date.now();
  return row;
}

function takeIngest(store: object, runId: string): BufferedRun | undefined {
  const buf = ingestRuns(store);
  const row = buf.get(runId);
  buf.delete(runId);
  return row;
}

function asTraceEvent(raw: Record<string, unknown>): TraceEvent {
  const name =
    typeof raw.name === "string" && raw.name
      ? raw.name
      : typeof raw.event_id === "string"
        ? raw.event_id
        : "";
  const args =
    raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)
      ? (redact(raw.args) as Record<string, unknown>)
      : {};
  const duration = Number(raw.duration_ms);
  return {
    name,
    args,
    ...(raw.result !== undefined ? { result: redact(raw.result) } : {}),
    ok: raw.ok !== false,
    ...(Number.isFinite(duration) ? { duration_ms: duration } : {}),
  };
}

function stretchFromBuffer(runId: string, row: BufferedRun): StretchTrace | null {
  if (!row.events.length) return null;
  const duration = row.events.reduce((s, e) => s + (Number.isFinite(e.duration_ms) ? (e.duration_ms as number) : 0), 0);
  return {
    id: runId,
    events: row.events,
    ...(row.agentId ? { agentId: row.agentId } : {}),
    llmCalls: Number.isFinite(row.events.length) ? row.events.length : 0,
    duration_ms: Number.isFinite(duration) ? duration : 0,
    cost_cents: 0,
    complete: true,
  };
}

function findToolByName(store: Store, name: string): LiveTool | undefined {
  return (
    store.tool(name) ??
    store.tools().find((t) => t.id === name || t.name === name || t.program.name === name)
  );
}

/**
 * Wrap matches the compiled name (what Approve shipped) and the first original
 * tool in the sequence (what the SDK posts). Ambiguous first-tool hits fail
 * open rather than playing the wrong program.
 */
function findWrapTool(store: Store, name: string): LiveTool | undefined {
  const exact = findToolByName(store, name);
  if (exact) return exact;
  const hits = store.tools().filter((t) => (t.program.sequence ?? [])[0] === name);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    hits.sort((a, b) => (b.program.sequence?.length ?? 0) - (a.program.sequence?.length ?? 0));
    const top = hits[0]!.program.sequence?.length ?? 0;
    const next = hits[1]!.program.sequence?.length ?? 0;
    if (top !== next) return hits[0];
  }
  return undefined;
}

function objectArgs(value: unknown, field: string): Record<string, unknown> | { error: string } {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { error: `${field} must be an object` };
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return { error: `${field} must be an object` };
  return value as Record<string, unknown>;
}

async function runNamedLive(
  ctx: ApiCtx,
  live: LiveTool,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof executeLiveRun>>> {
  const input = extractInput(live.program, args);
  const ran = await executeLiveRun({
    store: ctx.store,
    tool: live,
    input,
    registry: ctx.registry!,
    island: ctx.island,
    timeoutMs: wrapTimeoutMs(),
  });
  if (ran.status === "ok") inheritLiveTool(ctx.store, live.id);
  if (ran.status === "deopt") void maybeQueueRefresh(ctx, live.id).catch(() => undefined);
  return ran;
}

/** Chat without a model key: play the compiled tool or fail-open. */
export async function playCompiled(
  ctx: ApiCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const found = findWrapTool(ctx.store, name);
  if (!found || !ctx.registry) return null;
  const ran = await runNamedLive(ctx, found, args);
  if (ran.status === "ok") return ran.value;
  return null;
}

const AGENT_OPENAPI = {
  openapi: "3.0.0",
  info: { title: "Eden wrap", version: String(EDEN_PROTOCOL_VERSION) },
  paths: {
    "/health": { get: { summary: "Wrap facts (ok, traces, live). No auth." } },
    "/v1/wrap": {
      post: {
        summary: "Ask if a compiled tool answers",
        responses: { "200": { description: "{action:play,facts} or {action:original}" } },
      },
    },
    "/v1/ingest": { post: { summary: "Record tool events; stretch_end compiles at ≥3 traces. 202 {ok,accepted}." } },
    "/v1/dispatch": { post: { summary: "JIT: at most one compiled schema for this transcript. {tools}." } },
    "/v1/play": { post: { summary: "Execute a live compiled tool by name. Miss is 404, not fail-open." } },
    "/v1/wrap-run": { post: { summary: "Execute a live compiled tool by toolId/input." } },
    "/v1/traces": { post: { summary: "Post StretchTrace(s); compiles at ≥3." }, get: { summary: "List traces." } },
    "/v1/compile": { post: { summary: "Compile stored traces. Does not Approve." } },
    "/v1/chat/completions": { post: { summary: "OpenAI-compatible chat; set OPENAI_BASE_URL here." } },
    "/v1/messages": { post: { summary: "Anthropic Messages dialect." } },
  },
};

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

  if ((p === "/v1" || p === "/v1/" || p === "/v1/openapi.json") && req.method === "GET") {
    return json(AGENT_OPENAPI);
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

  /**
   * Provisioning: register the caller's Clerk org against this workspace.
   * Key-gated like every /v1 route. The write goes through the store's atomic
   * claim, so an already-bound workspace only ever accepts its own org
   * (idempotent re-bind) — a second org gets 409, and so does a racing
   * process that lost a first-bind race it could previously have both "won".
   * The web plane calls this when it onboards an org ("with keys").
   */
  if (p === "/v1/workspace/orgs" && req.method === "POST") {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const b = parsed.value as { org_id?: string; orgId?: string };
    const org = (b.org_id || b.orgId || req.headers.get(ORG_HEADER) || "").trim();
    if (!org) return json({ error: "org_id required" }, 400);
    const claimed = ctx.store.bindOrg(Store.WORKSPACE_ID, org);
    // No read-then-write here: the pre-check that used to sit in front of
    // bindOrg was itself a TOCTOU window across processes sharing one DB.
    if (claimed === "conflict") return json({ error: "workspace not bound to this org" }, 409, req);
    return json({ ok: true, orgs: ctx.store.orgsFor(Store.WORKSPACE_ID) });
  }

  if (p === "/v1/traces" && req.method === "POST") {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as StretchTrace | { traces?: StretchTrace[] };
    const list = Array.isArray((body as { traces?: StretchTrace[] }).traces)
      ? (body as { traces: StretchTrace[] }).traces
      : [body as StretchTrace];
    // Redact credential-shaped values at the boundary. Clients vary — the
    // CLI redacts before posting, SDKs may not — so the plane itself is the
    // guarantee that secrets never persist.
    const cleanList = list.map((t) =>
      t && Array.isArray(t.events)
        ? {
            ...t,
            events: t.events.map((e) => ({
              ...e,
              ...(e.args !== undefined ? { args: redact(e.args) as Record<string, unknown> } : {}),
              ...(e.result !== undefined ? { result: redact(e.result) } : {}),
            })),
          }
        : t,
    );
    const { accepted, duplicates } = await commitTraces(ctx, cleanList);
    return json({ ok: true, n: list.length, accepted, duplicates });
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
    return json({ traces: ctx.store.traces().slice(0, listLimitOf(url)) });
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
            ...(t.rollout === "canary" || t.rollout === "live" ? { rollout: t.rollout } : {}),
          };
        }),
      savings: ctx.store.savings(),
    });
  }

  /**
   * Weekly digest payload. Auth same as /v1/inbox. Opt-in (EDEN_DIGEST=1).
   * Returns 404 `{off:true}` when not opted in. Never sends mail.
   * Compiled/runs follow Home: live tools minus seed ids, not savings.live.
   */
  if (p === "/v1/digest" && req.method === "GET") {
    if (process.env.EDEN_DIGEST !== "1") return json({ off: true }, 404, req);
    const input = digestFromStore(ctx.store);
    const empty =
      input.compiled === 0 &&
      input.runs === 0 &&
      input.waiting === 0 &&
      input.fails === 0 &&
      input.tokensSaved === 0 &&
      input.dcPct == null &&
      input.cacheHitPct == null;
    const letter = empty ? EMPTY_DIGEST : input;
    return json({
      off: false,
      mailed: false,
      compiled: letter.compiled,
      runs: letter.runs,
      waiting: letter.waiting,
      fails: letter.fails,
      tokensSaved: letter.tokensSaved,
      dcPct: letter.dcPct,
      cacheHitPct: letter.cacheHitPct ?? null,
      text: renderDigestText(letter),
    });
  }

  const shadowMatch = p.match(/^\/v1\/candidates\/([^/]+)\/shadow$/);
  if (shadowMatch && req.method === "POST") {
    // Re-shadowing overwrites the review state (verdict, manifest, refusal),
    // so it is a tenant write like approve/pause, not a read — without the
    // gate any key-holder could rewrite or clear another org's refusal.
    const denied = orgGate(req, ctx);
    if (denied) return denied;
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
    // Running a program performs its tool calls against third-party APIs —
    // state-changing, and cross-tenant if ungated. Same gate as approve/pause.
    const denied = orgGate(req, ctx);
    if (denied) return denied;
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
        (t) =>
          t.id === body.toolId ||
          t.name === body.toolId ||
          t.program.name === body.toolId ||
          t.id === body.program?.id ||
          t.name === body.program?.name ||
          t.program.name === body.program?.name,
      );
    if (!found) return json({ error: "not live" }, 404);
    if (found.state === "paused") return json({ error: "paused", program: found.name }, 409);
    if (found.state !== "live") return json({ error: "not live", state: found.state }, 409);
    const live = found;
    const registry = ctx.registry;
    if (!registry) return json({ error: "no registry" }, 409);
    const q = Number(url.searchParams.get("timeout"));
    const timeoutMs = wrapTimeoutMs(Number.isFinite(q) && q > 0 ? q : body.timeoutMs ?? body.timeout);
    const ran = await executeLiveRun({
      store: ctx.store,
      tool: live,
      input: body.input,
      registry,
      island: ctx.island,
      timeoutMs,
    });
    if (ran.status === "ok") {
      inheritLiveTool(ctx.store, live.id);
      return json({ ok: true, value: ran.value, stats: ran.stats });
    }
    if (ran.status === "deopt") {
      void maybeQueueRefresh(ctx, live.id).catch(() => undefined);
      return json(
        { error: "deopt", reason: ran.reason, deopt: true, early: ran.early, stepsRun: ran.stepsRun, program: live.name },
        409,
      );
    }
    return json({ error: ran.error }, 500);
  }

  if (p === "/v1/wrap" && req.method === "POST") {
    // Same tenant gate as wrap-run: playing a program hits third-party APIs.
    // A miss or any Eden fault is {action:original} — never 404/500 — so the
    // SDK keeps the agent working. Org deny stays 403 (SDK treats non-ok as fallback).
    const denied = orgGate(req, ctx);
    if (denied) return denied;
    try {
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.res;
      const body = parsed.value;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "body must be an object" }, 400);
      }
      const b = body as { name?: unknown; args?: unknown; input?: unknown; arguments?: unknown; run_id?: unknown };
      if (typeof b.name !== "string" || !b.name) {
        return json({ error: "name must be a non-empty string" }, 400);
      }
      const args = objectArgs(b.args ?? b.input ?? b.arguments, "args");
      if ("error" in args) return json({ error: args.error }, 400);
      if (b.run_id != null && typeof b.run_id !== "string") {
        return json({ error: "run_id must be a string" }, 400);
      }
      const found = findWrapTool(ctx.store, b.name);
      if (!found || found.state !== "live") return json({ action: "original" });
      if (!ctx.registry) return json({ action: "original" });
      const ran = await runNamedLive(ctx, found, args);
      if (ran.status === "ok") return json({ action: "play", facts: ran.value });
      return json({ action: "original" });
    } catch {
      return json({ action: "original" });
    }
  }

  if (p === "/v1/play" && req.method === "POST") {
    // Explicit execute — not fail-open. Live miss is 404 so a caller that
    // asked to play knows the tool is not on.
    const denied = orgGate(req, ctx);
    if (denied) return denied;
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "body must be an object" }, 400);
    }
    const b = body as { name?: unknown; args?: unknown; input?: unknown; arguments?: unknown };
    if (typeof b.name !== "string" || !b.name) {
      return json({ error: "name must be a non-empty string" }, 400);
    }
    const args = objectArgs(b.args ?? b.input ?? b.arguments, "args");
    if ("error" in args) return json({ error: args.error }, 400);
    const found = findToolByName(ctx.store, b.name);
    if (!found) return json({ error: "not live" }, 404);
    if (found.state === "paused") return json({ error: "paused", program: found.name }, 409);
    if (found.state !== "live") return json({ error: "not live", state: found.state }, 409);
    if (!ctx.registry) return json({ error: "no registry" }, 409);
    const ran = await runNamedLive(ctx, found, args);
    if (ran.status === "ok") return json({ ok: true, value: ran.value, stats: ran.stats });
    if (ran.status === "deopt") {
      return json(
        { error: "deopt", reason: ran.reason, deopt: true, early: ran.early, stepsRun: ran.stepsRun, program: found.name },
        409,
      );
    }
    return json({ error: ran.error }, 500);
  }

  if (p === "/v1/ingest" && req.method === "POST") {
    // Auth-only, same as traces. Recording must never Approve unless the
    // existing maybeAutoApprove env is on.
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "body must be an object" }, 400);
    }
    const b = body as { run_id?: unknown; events?: unknown; stretch_end?: unknown; agent_id?: unknown };
    if (typeof b.run_id !== "string" || !b.run_id) {
      return json({ error: "run_id must be a non-empty string" }, 400);
    }
    if (!Array.isArray(b.events)) {
      return json({ error: "events must be an array" }, 400);
    }
    const bad = b.events.findIndex((e) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) return true;
      const rec = e as Record<string, unknown>;
      return typeof rec.event_id !== "string" && typeof rec.name !== "string";
    });
    if (bad >= 0) {
      return json({ error: `events[${bad}] must be an object with a string event_id` }, 400);
    }
    const clean = (b.events as Record<string, unknown>[]).map(asTraceEvent);
    const agentId = typeof b.agent_id === "string" && b.agent_id ? b.agent_id : undefined;
    const stretchEnd = b.stretch_end === true;
    const hadRun = ingestRuns(ctx.store).has(b.run_id);
    const oneShot = !stretchEnd && clean.length >= 2 && !hadRun;
    const row = bufferIngest(ctx.store, b.run_id, clean, agentId);
    if (!stretchEnd && !oneShot) return json({ ok: true, accepted: 0 }, 202);
    const sealed = takeIngest(ctx.store, b.run_id) ?? row;
    const trace = stretchFromBuffer(b.run_id, sealed);
    if (!trace) return json({ ok: true, accepted: 0 }, 202);
    const { accepted } = await commitTraces(ctx, [trace]);
    return json({ ok: true, accepted }, 202);
  }

  if (p === "/v1/dispatch" && req.method === "POST") {
    try {
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.res;
      const body = parsed.value;
      const params =
        body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const picked = dispatchPrograms(dispatchMessages(params), ctx.store.livePrograms()).slice(0, 1);
      const tools = picked.map(compiledSchema).slice(0, 1);
      return json({ tools });
    } catch {
      return json({ tools: [] });
    }
  }

  if ((p === "/v1/openapi.json" || p === "/v1" || p === "/v1/") && req.method === "GET") {
    return json(AGENT_OPENAPI);
  }

  const sched = p.match(/^\/v1\/tools\/([^/]+)\/schedule$/);
  if (sched && req.method === "GET") {
    const t = ctx.store.tool(sched[1]!);
    if (!t) return json({ error: "not found" }, 404);
    const row = ctx.store.scheduleFor(t.id);
    return json({
      schedule: row
        ? {
            id: row.id,
            tool_id: row.tool_id,
            cron: row.cron,
            input: parseScheduleInput(row.input) ?? null,
            last_tick: row.last_tick,
            created_at: row.created_at,
          }
        : null,
    });
  }
  if (sched && req.method === "POST") {
    const denied = orgGate(req, ctx);
    if (denied) return denied;
    const t = ctx.store.tool(sched[1]!);
    if (!t) return json({ error: "not live" }, 409);
    if (t.state === "paused") return json({ error: "paused", program: t.name }, 409);
    if (t.state !== "live") return json({ error: "not live", state: t.state }, 409);
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { cron?: string; input?: unknown };
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    if (!parseCron(cron)) return json({ error: "bad cron" }, 400);
    if (body.input != null && (typeof body.input !== "object" || Array.isArray(body.input))) {
      return json({ error: "input must be an object" }, 400);
    }
    const existing = ctx.store.scheduleFor(t.id);
    const inputJson =
      body.input && typeof body.input === "object" && !Array.isArray(body.input) ? JSON.stringify(body.input) : existing?.input ?? null;
    ctx.store.putSchedule({
      id: existing?.id ?? crypto.randomUUID(),
      tool_id: t.id,
      cron,
      input: body.input === undefined ? (existing?.input ?? null) : inputJson,
      last_tick: existing?.last_tick ?? null,
      created_at: existing?.created_at ?? Date.now(),
    });
    const row = ctx.store.scheduleFor(t.id)!;
    return json({
      ok: true,
      id: row.id,
      tool_id: row.tool_id,
      cron: row.cron,
      input: parseScheduleInput(row.input) ?? null,
      state: t.state,
    });
  }
  if (sched && req.method === "DELETE") {
    const denied = orgGate(req, ctx);
    if (denied) return denied;
    if (!ctx.store.deleteSchedule(sched[1]!)) return json({ error: "not found" }, 404);
    return json({ ok: true });
  }

  if (p === "/v1/schedule/tick" && req.method === "POST") {
    const denied = orgGate(req, ctx);
    if (denied) return denied;
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { now?: unknown; toolId?: string; timeoutMs?: number; timeout?: number };
    const now = parseNow(body.now ?? Date.now());
    if (!now) return json({ error: "bad now" }, 400);
    const registry = ctx.registry;
    if (!registry) return json({ error: "no registry" }, 409);
    const timeoutMs = wrapTimeoutMs(body.timeoutMs ?? body.timeout);
    return ctx.store.enqueue(async () => {
      const out = await tickDueSchedules({
        store: ctx.store,
        registry,
        island: ctx.island,
        timeoutMs,
        now,
        toolId: typeof body.toolId === "string" ? body.toolId : undefined,
        onOk: (id) => inheritLiveTool(ctx.store, id),
        onDeopt: (id) => {
          void maybeQueueRefresh(ctx, id).catch(() => undefined);
        },
      });
      return json({ ok: true, fired: out.fired, paused: out.paused, skipped: out.skipped, now: now.toISOString() });
    });
  }

  const approve = p.match(/^\/v1\/tools\/([^/]+)\/approve$/);
  if (approve && req.method === "POST") {
    const denied = orgGate(req, ctx);
    if (denied) return denied;
    const c = ctx.store.candidate(approve[1]!);
    if (!c) return json({ error: "not found" }, 404);
    // Computed before the ship so the response records exactly what the
    // approver was able to see — live vs candidate, not live vs edited.
    const diff = candidateDiff(ctx.store, c.program);
    const body = (await req.json().catch(() => ({}))) as {
      edits?: Edits;
      transparent_writes?: boolean;
      rollout?: string;
      dropValues?: DropValue[];
      pinIslands?: boolean;
    };
    const shipped = await shipCandidate(ctx, c, body.edits, {
      transparentWrites: body.transparent_writes === true,
      rollout: body.rollout === "live" ? "live" : "canary",
      dropValues: Array.isArray(body.dropValues) ? body.dropValues : undefined,
      pinIslands: body.pinIslands === true,
      approvedBy: req.headers.get(ORG_HEADER),
    });
    if (!shipped.ok) return json({ error: shipped.error, ...shipped.extra }, shipped.status);
    return json({
      ok: true,
      id: shipped.program.id,
      name: shipped.program.name,
      program: shipped.program,
      diff,
      rollout: body.rollout === "live" ? "live" : "canary",
    });
  }

  const promote = p.match(/^\/v1\/tools\/([^/]+)\/promote$/);
  if (promote && req.method === "POST") {
    const denied = orgGate(req, ctx);
    if (denied) return denied;
    const t = ctx.store.tool(promote[1]!);
    if (!t) return json({ error: "not found" }, 404);
    t.rollout = "live";
    t.updated_at = Date.now();
    ctx.store.putTool(t);
    syncLiveTools(ctx.store);
    return json({ ok: true, id: t.id, rollout: t.rollout });
  }

  const pause = p.match(/^\/v1\/tools\/([^/]+)\/(pause|rollback|resume)$/);
  if (pause && req.method === "POST") {
    const denied = orgGate(req, ctx);
    if (denied) return denied;
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
    // Review surface: the queued candidate for this stretch (if any) diffed
    // against what is live, plus the superseded compilations this tool still
    // remembers. Both are null/empty for a stretch that was never replaced.
    const candidate =
      ctx.store.candidate(refreshCandidateId(t.id)) ??
      ctx.store.candidates().find((c) => c.program?.id === t.id) ??
      null;
    return json({
      ...t,
      versions: ctx.store.programVersions(t.id).map((v) => ({ version: v.version, created_at: v.created_at })),
      candidate: candidate ? { id: candidate.id, verdict: candidate.verdict } : null,
      candidate_diff: candidateDiff(ctx.store, candidate?.program ?? null),
    });
  }

  if (p === "/v1/tools" && req.method === "GET") {
    const state = url.searchParams.get("state");
    const tools = state ? ctx.store.tools().filter((t) => t.state === state) : ctx.store.tools();
    return json({ tools });
  }

  if (p === "/v1/receipts" && req.method === "GET") {
    const toolId = url.searchParams.get("tool");
    const limit = listLimitOf(url);
    const rows = toolId ? ctx.store.receiptsFor(toolId) : ctx.store.receipts();
    return json({ receipts: rows.slice(0, limit).map(expandReceipt) });
  }

  if (p === "/v1/dc" && req.method === "GET") {
    const days = parseDayCount(url.searchParams.get("days"), 7);
    return json(dcWindowFromReceipts(ctx.store.receipts(), days));
  }

  /**
   * Access-review export: who approved what, when, which version.
   * Org-gated (unlike the full dump). Wrong org → 403. A workspace query
   * that is not this install yields 0 records. A throw is 500 JSON, never wrap.
   */
  if (p === "/v1/audit/review" && req.method === "GET") {
    try {
      const denied = orgGate(req, ctx);
      if (denied) return denied;
      const format = (url.searchParams.get("format") || "jsonl").toLowerCase();
      if (format !== "jsonl" && format !== "csv") return json({ error: "format must be jsonl or csv" }, 400, req);
      const body = exportAccessReview(ctx.store, format, url.searchParams.get("workspace"));
      const filename = format === "csv" ? "eden-access-review.csv" : "eden-access-review.jsonl";
      const type = format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8";
      return new Response(body, {
        status: 200,
        headers: {
          ...corsFor(req),
          "cache-control": "private, no-store",
          "content-type": type,
          "content-disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch {
      return json({ error: "export failed" }, 500, req);
    }
  }

  /**
   * Tamper-evident audit export. Key-gated like the other reads. A throw here
   * must not take down wrap — catch and 500, never unhandled.
   */
  if (p === "/v1/audit" && req.method === "GET") {
    try {
      const format = (url.searchParams.get("format") || "jsonl").toLowerCase();
      if (format !== "jsonl" && format !== "csv") return json({ error: "format must be jsonl or csv" }, 400, req);
      const body = exportAudit(ctx.store, format);
      const filename = format === "csv" ? "eden-audit.csv" : "eden-audit.jsonl";
      const type = format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8";
      return new Response(body, {
        status: 200,
        headers: {
          ...corsFor(req),
          "cache-control": "private, no-store",
          "content-type": type,
          "content-disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch {
      return json({ error: "export failed" }, 500, req);
    }
  }

  const delCand = p.match(/^\/v1\/candidates\/([^/]+)$/);
  if (delCand && req.method === "GET") {
    const c = ctx.store.candidate(delCand[1]!);
    if (!c) return json({ error: "not found" }, 404);
    return json({ ...c, diff: candidateDiff(ctx.store, c.program) });
  }
  if (delCand && req.method === "DELETE") {
    const denied = orgGate(req, ctx);
    if (denied) return denied;
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
      reason?: string;
      stepsRun?: number;
      skipped?: string[];
      outcome?: string;
      tokens?: number;
      tokensSaved?: number | null;
      timeSavedMs?: number | null;
      fingerprint?: string;
      tokenClass?: string;
      tokenClasses?: unknown;
      prompt_tokens?: number;
      completion_tokens?: number;
      cached_tokens?: number;
      cache_write_tokens?: number;
      cache_input_tokens?: number;
      certified?: boolean;
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
        reason: b.reason,
        stepsRun: b.stepsRun,
        skipped: b.skipped,
        outcome: b.outcome,
        tokens: b.tokens,
        tokensSaved: b.tokensSaved,
        timeSavedMs: b.timeSavedMs,
        fingerprint: b.fingerprint,
        tokenClass: b.tokenClass,
        tokenClasses: b.tokenClasses,
        prompt_tokens: b.prompt_tokens,
        completion_tokens: b.completion_tokens,
        cached_tokens: b.cached_tokens,
        cache_write_tokens: b.cache_write_tokens,
        cache_input_tokens: b.cache_input_tokens,
        certified: b.certified,
      }),
    });
    return json({ ok: true });
  }

  return null;
}

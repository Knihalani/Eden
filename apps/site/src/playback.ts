import type { EdenDb } from "./db";
import {
  billableMs,
  buildDag,
  densifyPayload,
  issuesFromParams,
  layers,
  modelFacing,
  prRowFromFacts,
  prRowsFromFacts,
  receiptTableLine,
  resolveTemplate,
  type CompiledStep,
  type DagNode,
  type Receipt,
} from "@eden/core";
import { handleForge } from "./forge";
import { safeFetch } from "./ssrf";
import { recordDeopt } from "./db";
import {
  joinInflight,
  prefetchCounters,
  readResult,
  resultCacheKey,
  singleFlight,
  trackPrefetch,
  writeResult,
} from "./cache";

type ToolRef = { id: string; steps: string; name: string; workspace_id?: string };

/**
 * Ceiling on speculative prefetch fan-out per run. A compiled run's waves are
 * already bounded by DAG width through Promise.all; prefetch reuses that shape
 * but gets its own tighter cap, because it is best-effort work racing the
 * response path — losing that race must never cost more than eight extra
 * in-flight requests.
 */
const MAX_PREFETCH_PER_RUN = 8;

/**
 * Provably read-only, in the playback sense. The IR marks steps readOnly at
 * compile time; CompiledStep carries that flag through verbatim when present.
 * Where it is absent, a plain cloud_http GET is read-only by HTTP semantics —
 * the same property the exact-result cache has always leaned on. Everything
 * else (POSTs, runner steps, oauth handshakes) is treated as mutating:
 * prefetching a write would be a side effect fired while nobody is watching.
 */
function stepIsReadOnly(step: CompiledStep): boolean {
  const flag = (step as { readOnly?: boolean }).readOnly;
  if (typeof flag === "boolean") return flag === true;
  return step.kind === "cloud_http" && (step.method || "GET") === "GET";
}

/** Bind resolution shared by the hot path and prefetch, so both see one answer. */
function resolveBound(
  step: CompiledStep,
  params: Record<string, string>,
  results: Record<string, unknown>,
): Record<string, string> {
  const bound = { ...params };
  for (const [k, v] of Object.entries(step.bind ?? {})) {
    bound[k] = resolveTemplate(String(v), bound, results);
  }
  return bound;
}

/**
 * One live fetch, plus its cache fill. Used by the hot path and by prefetch
 * alike — wrapped in singleFlight by the callers, so whichever arrives first
 * pays the request and everyone with the same key rides along.
 */
function liveLoad(
  ctx: { db: EdenDb },
  cacheKey: string,
  step: CompiledStep,
  url: string,
): () => Promise<{ parsed: unknown; ok: boolean }> {
  return async (): Promise<{ parsed: unknown; ok: boolean }> => {
    const parsedUrl = new URL(url);
    // The forge is an in-process fixture: it never leaves the process, so
    // it is exempt from the egress rules rather than checked against them.
    const res = handleForge(parsedUrl) || (await fetchWithRetry(url, { method: step.method || "GET" }));
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if ((step.method || "GET") === "GET" && res.ok) {
      await writeResult(ctx.db, cacheKey, parsed);
    }
    return { parsed, ok: res.ok };
  };
}

type StepOutcome = { id: string; value: unknown; fail: boolean };

/**
 * The cache key is tenant-scoped (see cache.ts), so every read and write needs
 * the workspace. It rides on the tool row; resolving it here — once per run,
 * not per step — keeps playTool's signature untouched for existing callers.
 */
async function resolveWorkspaceId(db: EdenDb, tool: ToolRef): Promise<string> {
  if (tool.workspace_id) return tool.workspace_id;
  try {
    const row = await db.get<{ workspace_id: string }>(`SELECT workspace_id FROM tool WHERE id = ?`, [tool.id]);
    return row?.workspace_id ?? "";
  } catch {
    return "";
  }
}

/**
 * Ceiling on how many ids one call may fan out over. `issues` is a caller-supplied
 * CSV, and playTool replays every id it names concurrently — so an unbounded list
 * (a 100k-element CSV, whether hostile or accidental) turned into 100k parallel
 * fetches against the target host from a single request. Real batches are PR
 * loops; 100 covers them and bounds the amplification.
 */
const MAX_BATCH_ISSUES = 100;


function requestHeaders(url: string): Record<string, string> {
  try {
    const host = new URL(url).host;
    if (host === "api.github.com") {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "eden-playback",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      return headers;
    }
  } catch {
    /* ignore */
  }
  return {};
}

async function fetchWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: Response | undefined;
  const headers = { ...requestHeaders(url), ...(init.headers as Record<string, string> | undefined) };
  for (let i = 0; i < tries; i++) {
    // safeFetch re-validates every redirect hop. Plain fetch() follows them
    // silently, which would let an allowed host redirect us into the private
    // network the egress check exists to protect.
    last = await safeFetch(url, { ...init, headers });
    if (last.status !== 429 && last.status < 500) return last;
    await new Promise((r) => setTimeout(r, 50 * (i + 1)));
  }
  return last!;
}

async function playOne(
  db: EdenDb,
  tool: ToolRef,
  params: Record<string, string>,
  opts: { dryRun?: boolean } = {},
): Promise<Receipt> {
  const t0 = Date.now();
  let steps: CompiledStep[];
  try {
    steps = JSON.parse(tool.steps) as CompiledStep[];
  } catch {
    throw new Error("corrupt tool steps");
  }
  // Server-pinned values are applied *after* the caller's, not before. Spread
  // the other way round, an MCP caller could pass {owner, repo} of its choosing
  // and redirect a request that carries the server's GITHUB_TOKEN at any
  // repository — or, with the right template, any api.github.com path.
  const pinnedOwner = process.env.EDEN_GH_OWNER;
  const pinnedRepo = process.env.EDEN_GH_REPO;
  params = {
    ...params,
    ...(pinnedOwner ? { owner: pinnedOwner } : { owner: String(params.owner ?? "") }),
    ...(pinnedRepo ? { repo: pinnedRepo } : { repo: String(params.repo ?? "") }),
    issue: params.issue || params.id || params.pr || params.number || "",
    id: params.id || params.issue || params.pr || params.number || "",
  };
  const dag = buildDag(steps);
  const waves = layers(dag);
  const workspaceId = await resolveWorkspaceId(db, tool);
  const results: Record<string, unknown> = {};
  let attempted = 0;
  let ok = 0;
  let cacheHits = 0;
  let runnerMs = 0;
  let failed: number | undefined;
  // Keys already handed to prefetch this run, so two waves can never double-
  // fire the same speculative load.
  const prefetched = new Set<string>();

  /**
   * Speculative execution of an all-read-only next wave, kicked the moment the
   * current wave completes. Fire-and-forget by contract: nothing here is ever
   * awaited on the response path. When prefetch wins the race, the wave's own
   * execution joins the in-flight single-flight promise — a counted cache hit
   * with no network wait; when it loses, the wave simply fetches as before.
   */
  const maybePrefetch = (nextLayer: DagNode[]): void => {
    if (!nextLayer.every(stepIsReadOnly)) return;
    for (const step of nextLayer.slice(0, MAX_PREFETCH_PER_RUN)) {
      void (async () => {
        try {
          const bound = resolveBound(step, params, results);
          const url = resolveTemplate(step.url || "", bound, results);
          if (!url) return;
          const cacheKey = resultCacheKey({ workspaceId, toolId: tool.id, step, url, bound });
          if (prefetched.has(cacheKey)) return;
          prefetched.add(cacheKey);
          // Already cached from an earlier run or prefetch: nothing to warm.
          if ((await readResult(db, cacheKey)) !== undefined) return;
          trackPrefetch(() => singleFlight(cacheKey, liveLoad({ db }, cacheKey, step, url)));
        } catch {
          // Synchronous setup failures count exactly like async ones:
          // swallowed, tallied, invisible to the run.
          prefetchCounters.errors++;
        }
      })();
    }
  };

  for (let wi = 0; wi < waves.length; wi++) {
    const layer = waves[wi]!;
    const layerOut = await Promise.all(
      layer.map(async (step): Promise<StepOutcome> => {
        attempted++;
        if (step.kind === "runner") {
          runnerMs += 1;
          return { id: step.id, value: { skipped: "runner_unbound", name: step.name }, fail: true };
        }
        const bound = resolveBound(step, params, results);
        const url = resolveTemplate(step.url || "", bound, results);
        if (!url) return { id: step.id, value: { error: "no_url" }, fail: true };
        // Dry-run (G9): mutating steps report what they WOULD call and touch
        // nothing. Reads still execute, so the rehearsal exercises the real
        // data flow — templates, binds, cache — without performing writes.
        if (opts.dryRun && !stepIsReadOnly(step)) {
          return { id: step.id, value: { skipped: "dry_run", method: step.method || "GET", url }, fail: false };
        }
        const isGet = (step.method || "GET") === "GET";
        const cacheKey = resultCacheKey({ workspaceId, toolId: tool.id, step, url, bound });
        if (isGet) {
          // A prefetch already fetching this exact resource: ride along rather
          // than duplicate the request. A rejected speculative load surfaces
          // here as undefined — a miss we fall through from.
          const joined = await joinInflight<unknown>(cacheKey);
          if (joined !== undefined) {
            cacheHits++;
            return { id: step.id, value: joined, fail: false };
          }
          const hit = await readResult<unknown>(db, cacheKey);
          if (hit !== undefined) {
            cacheHits++;
            return { id: step.id, value: hit, fail: false };
          }
        }
        let parsed: unknown;
        let stepOk = false;
        try {
          const load = liveLoad({ db }, cacheKey, step, url);
          // GETs dedupe through singleFlight so prefetch and hot path share one
          // request; mutating methods must each execute, so they never do.
          const out = isGet ? await singleFlight(cacheKey, load) : await load();
          parsed = out.parsed;
          stepOk = out.ok;
        } catch (err) {
          return { id: step.id, value: { error: String(err) }, fail: true };
        }
        return { id: step.id, value: parsed, fail: !stepOk };
      }),
    );
    for (const r of layerOut) {
      results[r.id] = r.value;
    }
    for (const r of layerOut) {
      if (r.fail) {
        failed = attempted;
        break;
      }
      ok++;
    }
    if (!failed && wi + 1 < waves.length) maybePrefetch(waves[wi + 1]!);
    if (failed) break;
  }

  const packed = densifyPayload(results);
  const facing = modelFacing(results);
  const server_ms = Date.now() - t0;
  const receipt: Receipt = {
    ok: failed === undefined,
    ...(opts.dryRun ? { dryRun: true } : {}),
    steps_ok: ok,
    steps_attempted: attempted,
    server_ms,
    runner_ms: runnerMs,
    raw_bytes: packed.raw_bytes,
    densified_bytes: packed.densified_bytes,
    billable_ms: billableMs({ server_ms, steps_attempted: attempted, densified_bytes: packed.densified_bytes }),
    cache_hits: cacheHits,
    result: packed.densified,
    facts: facing.facts,
    failed_step: failed,
    table: receiptTableLine(params.issue || "", facing.facts),
    rows: (() => {
      const row = prRowFromFacts(facing.facts, params.issue);
      return row ? [row] : [];
    })(),
  };
  await db.run(
    `INSERT INTO tool_run (id, tool_id, steps_attempted, steps_ok, server_ms, runner_ms, raw_bytes, densified_bytes, billable_ms, cache_hits, receipt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      tool.id,
      receipt.steps_attempted,
      receipt.steps_ok,
      receipt.server_ms,
      receipt.runner_ms,
      receipt.raw_bytes,
      receipt.densified_bytes,
      receipt.billable_ms,
      receipt.cache_hits,
      JSON.stringify(receipt),
      Date.now(),
    ],
  );
  // Rehearsals are not usage: counting them inflated the dashboard's uses
  // and the savings ledger described work that never executed.
  if (!opts.dryRun) {
    await db.run(`UPDATE tool SET uses_count = uses_count + 1 WHERE id = ?`, [tool.id]);
  }
  // tool_run is the lifetime ledger the dashboard sums, so its rows are never
  // deleted — but the receipt JSON they carry is only read for recent runs.
  // Sampled sweep nulls receipts older than 90 days, keeping the totals
  // honest while bounding the table's size.
  if (Math.random() < 0.02) {
    void db
      .run(`UPDATE tool_run SET receipt = NULL WHERE created_at < ? AND receipt IS NOT NULL`, [
        Date.now() - 90 * 24 * 60 * 60_000,
      ])
      .catch(() => undefined);
  }
  return receipt;
}

/**
 * Structural DeoptError recognition, without a hard dependency on the runtime
 * package: isDeopt() in @eden/runtime answers exactly this shape (the `deopt`
 * marker plus the name), and playback cannot import that package — apps/site
 * only links @eden/core. If the runtime ever changes its duck-type, this
 * mirrors it; anything unknown is simply not a deopt.
 */
function asDeopt(err: unknown): { reason: string; stepsRun: number } | null {
  if (!err || typeof err !== "object") return null;
  const rec = err as { deopt?: boolean; name?: string; reason?: unknown; stepsRun?: unknown };
  if (rec.deopt !== true || rec.name !== "DeoptError") return null;
  const n = Number(rec.stepsRun);
  return {
    reason: typeof rec.reason === "string" ? rec.reason : String(rec.reason ?? ""),
    stepsRun: Number.isFinite(n) ? n : 0,
  };
}

export async function playTool(
  db: EdenDb,
  tool: ToolRef,
  params: Record<string, string>,
  opts: { dryRun?: boolean } = {},
): Promise<Receipt> {
  try {
    return await playOne0(db, tool, params, opts);
  } catch (err) {
    const deopt = asDeopt(err);
    if (deopt) {
      // Drift ledger, best-effort and strictly off the response path's error
      // contract: the caller already gets the deopt thrown back regardless of
      // whether the ledger row landed. The workspace comes from the tool row —
      // playTool's signature never carried it.
      try {
        const row = await db.get<{ workspace_id: string }>(`SELECT workspace_id FROM tool WHERE id = ?`, [tool.id]);
        if (row) await recordDeopt(db, row.workspace_id, tool.id, { reason: deopt.reason, steps_run: deopt.stepsRun });
      } catch {
        /* the deopt itself must still propagate untouched */
      }
    }
    throw err;
  }
}

async function playOne0(
  db: EdenDb,
  tool: ToolRef,
  params: Record<string, string>,
  opts: { dryRun?: boolean } = {},
): Promise<Receipt> {
  const issues = issuesFromParams(params);
  if (issues.length <= 1) {
    return playOne(db, tool, {
      ...params,
      issue: issues[0] || params.issue || params.pr || params.number || params.id || "",
      id: issues[0] || params.id || params.issue || params.pr || params.number || "",
    }, opts);
  }
  const t0 = Date.now();
  // Bounded, not trusted: see MAX_BATCH_ISSUES. The cap is silent by design —
  // the receipt reports what it actually played.
  const batch = issues.slice(0, MAX_BATCH_ISSUES);
  const receipts = await Promise.all(
    batch.map((issue) => playOne(db, tool, { ...params, issue, id: issue, number: issue }, opts)),
  );
  // `batch[i]` is index-parallel to `receipts` by construction (receipts came
  // from batch.map), so the fallback never fires; it is there to satisfy the
  // index signature rather than to describe a reachable state.
  const table = receipts.map((r, i) => r.table || receiptTableLine(batch[i] ?? "", r.facts)).join("\n");
  const rows = receipts.flatMap((r, i) => (r.rows?.length ? r.rows : prRowsFromFacts(r.facts, [batch[i] ?? ""])));
  return {
    ok: receipts.every((r) => r.ok),
    ...(opts.dryRun ? { dryRun: true } : {}),
    steps_ok: receipts.reduce((a, r) => a + r.steps_ok, 0),
    steps_attempted: receipts.reduce((a, r) => a + r.steps_attempted, 0),
    server_ms: Date.now() - t0,
    runner_ms: receipts.reduce((a, r) => a + r.runner_ms, 0),
    raw_bytes: receipts.reduce((a, r) => a + r.raw_bytes, 0),
    densified_bytes: receipts.reduce((a, r) => a + r.densified_bytes, 0),
    billable_ms: receipts.reduce((a, r) => a + r.billable_ms, 0),
    cache_hits: receipts.reduce((a, r) => a + r.cache_hits, 0),
    result: table,
    facts: { rows: receipts.map((r) => r.facts) },
    table,
    rows,
  };
}

const warming = new Map<string, number>();

/** Fill result_cache from ids Eden already watched. Does not edit compiled tools. */
export async function warmWorkspaceBundle(
  db: EdenDb,
  workspaceId: string,
  origin = process.env.EDEN_PUBLIC_URL || "",
): Promise<void> {
  const prev = warming.get(workspaceId) || 0;
  if (Date.now() - prev < 8_000) return;
  warming.set(workspaceId, Date.now());
  const tools = await db.all<{ id: string; name: string; steps: string }>(
    // The most-used tools only: warming exists to pre-fill the cache the next
    // calls will hit, and initialize triggered this — replaying every live
    // tool against sixteen ids each was a self-inflicted request storm on
    // every MCP handshake.
    `SELECT id, name, steps FROM tool WHERE workspace_id = ? AND state = 'on' ORDER BY uses_count DESC LIMIT 3`,
    [workspaceId],
  );
  if (!tools.length) return;
  const ids = await db.all<{ issue: string }>(
    `SELECT issue FROM watched_issue WHERE workspace_id = ? ORDER BY seen_at DESC LIMIT 6`,
    [workspaceId],
  );
  if (!ids.length) return;
  const csv = ids.map((r) => r.issue).join(",");
  for (const tool of tools) {
    const steps = (() => {
      try {
        // Guarded here rather than only around JSON.parse: valid JSON that is
        // not an array (`5`, `{}`, `null`) would throw on .some() below.
        const parsed = JSON.parse(tool.steps || "[]") as unknown;
        return Array.isArray(parsed) ? (parsed as Array<{ url?: string }>) : [];
      } catch {
        return [];
      }
    })();
    if (!steps.some((s) => s.url && /\{(id|issue|run_id)\}/.test(s.url))) continue;
    // workspace_id rides along so the run's cache keys are tenant-scoped from
    // the start instead of costing a tool-row lookup per playOne.
    // Warming is cache pre-fill: reads only, by force. Without dryRun this
    // replayed a write-performing tool's POSTs unattended — on every MCP
    // handshake — which is exactly the "side effect fired while nobody is
    // watching" the prefetch gate exists to prevent.
    await playTool(db, { ...tool, workspace_id: workspaceId }, { issues: csv, ids: csv, origin }, { dryRun: true });
  }
}

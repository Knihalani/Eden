import type { EdenDb } from "./db";
import {
  billableMs,
  buildDag,
  densifyPayload,
  issuesFromParams,
  jsonBytes,
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
  readEntry,
  publicResultKey,
  readResult,
  readStaleEntry,
  resultCacheKey,
  singleFlight,
  trackPrefetch,
  writeResult,
  RESULT_CACHE_TTL_MS,
} from "./cache";

type ToolRef = { id: string; steps: string; name: string; workspace_id?: string };

/**
 * Wave schedules are a pure function of the immutable steps blob, so they are
 * computed once per distinct blob and reused — including across the up-to-100
 * concurrent playOne calls one batched request fans out into, which used to
 * each rebuild the identical DAG. Bounded; on any computation error nothing
 * is cached and the (meaningful) throw propagates exactly as before.
 */
const WAVE_MEMO_CAP = 64;
const waveMemo = new Map<string, DagNode[][]>();

function wavesFor(stepsJson: string, steps: CompiledStep[]): DagNode[][] {
  const hit = waveMemo.get(stepsJson);
  if (hit) return hit;
  const waves = layers(buildDag(steps));
  if (waveMemo.size >= WAVE_MEMO_CAP) waveMemo.clear();
  waveMemo.set(stepsJson, waves);
  return waves;
}

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
  publicKey: string | undefined,
  step: CompiledStep,
  url: string,
): () => Promise<{ parsed: unknown; ok: boolean; rawBytes: number }> {
  return async (): Promise<{ parsed: unknown; ok: boolean; rawBytes: number }> => {
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
      // Fire-and-forget fill: the response does not need the write to be
      // durable — the next caller needs it *eventually*, and writeResult is
      // already best-effort by contract (a failed fill is a miss next time).
      // Awaiting it here put one database round trip on the critical path of
      // every uncached step.
      const etag = res.headers.get("etag") ?? undefined;
      void writeResult(ctx.db, cacheKey, parsed, RESULT_CACHE_TTL_MS, etag);
      // Public-host, credential-free responses are byte-identical for every
      // workspace, so they land in the shared public pool too. Anything that
      // carried credentials — or any host not on the allowlist — stays
      // tenant-scoped only.
      if (publicKey && !requestHeaders(url).Authorization && isPublicPoolCandidate(url)) {
        void writeResult(ctx.db, publicKey, parsed, RESULT_CACHE_TTL_MS, etag);
      }
    }
    return { parsed, ok: res.ok, rawBytes: Buffer.byteLength(text, "utf8") };
  };
}

/**
 * Hosts whose unauthenticated responses are byte-identical for every caller.
 * Credential-free alone is NOT enough — an internal no-auth API still serves
 * per-tenant bytes — so sharing requires both no credentials AND this
 * allowlist.
 */
const PUBLIC_POOL_HOSTS = new Set(["api.github.com"]);

export function isPublicPoolCandidate(url: string): boolean {
  try {
    return PUBLIC_POOL_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * One conditional round trip proving an expired entry still current. A 304
 * refreshes the stored TTL at ~zero cost; anything else falls through to a
 * normal full fetch. Best-effort by contract like everything cache-side.
 */
async function tryRevalidate(
  db: EdenDb,
  key: string,
  url: string,
): Promise<unknown | undefined> {
  const stale = await readStaleEntry(db, key);
  if (!stale?.etag) return undefined;
  try {
    const res = await safeFetch(url, {
      method: "GET",
      headers: { ...requestHeaders(url), "if-none-match": stale.etag },
    });
    if (res.status === 304) {
      void writeResult(db, key, stale.value, RESULT_CACHE_TTL_MS, stale.etag);
      return stale.value;
    }
  } catch {
    /* fall through to a full fetch */
  }
  return undefined;
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
  // Opt-in execution mode: dependency-driven scheduling without wave barriers.
  if (process.env.EDEN_SCHED === "ready") return playOneReady(db, tool, params, opts);
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
  // Wave schedule is memoized per steps blob (pure function; see wavesFor).
  const waves = wavesFor(tool.steps, steps);
  const workspaceId = await resolveWorkspaceId(db, tool);
  const results: Record<string, unknown> = {};
  let attempted = 0;
  let ok = 0;
  let cacheHits = 0;
  let runnerMs = 0;
  let failed: number | undefined;
  // raw_bytes accounting: bytes actually received from upstream this run,
  // plus (for served-from-cache steps) the measured size of what the cache
  // answered — measured once per hit value instead of re-serializing the
  // whole combined result tree at the end.
  let liveBytes = 0;
  const hitValues: unknown[] = [];
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
          const pubKey = publicResultKey({ toolId: tool.id, step, url, bound });
          if (prefetched.has(cacheKey)) return;
          prefetched.add(cacheKey);
          // Already cached (either pool) from an earlier run or prefetch: nothing to warm.
          if ((await readEntry(db, cacheKey)) !== undefined) return;
          if ((await readEntry(db, pubKey)) !== undefined) return;
          trackPrefetch(() => singleFlight(cacheKey, liveLoad({ db }, cacheKey, pubKey, step, url)));
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
        const pubKey = isGet
          ? publicResultKey({ toolId: tool.id, step, url, bound })
          : undefined;
        if (isGet) {
          // A prefetch already fetching this exact resource: ride along rather
          // than duplicate the request. A rejected speculative load surfaces
          // here as undefined — a miss we fall through from.
          const joined = await joinInflight<unknown>(cacheKey);
          if (joined !== undefined) {
            cacheHits++;
            hitValues.push(joined);
            return { id: step.id, value: joined, fail: false };
          }
          // Tenant pool first (strict isolation), then the shared public
          // pool (credential-free GETs only ever land there).
          const tenantHit = await readEntry(db, cacheKey);
          if (tenantHit !== undefined) {
            cacheHits++;
            hitValues.push(tenantHit.value);
            return { id: step.id, value: tenantHit.value, fail: false };
          }
          const pubHit = pubKey !== undefined ? await readEntry(db, pubKey) : undefined;
          if (pubHit !== undefined) {
            cacheHits++;
            hitValues.push(pubHit.value);
            return { id: step.id, value: pubHit.value, fail: false };
          }
          // Expired-but-tagged entries: one conditional round trip either
          // proves them current (~free hit) or we fall through to a full fetch.
          const revalidated = await tryRevalidate(db, cacheKey, url).catch(() => undefined);
          if (revalidated !== undefined) {
            cacheHits++;
            hitValues.push(revalidated);
            return { id: step.id, value: revalidated, fail: false };
          }
          if (pubKey !== undefined) {
            const revalidatedPub = await tryRevalidate(db, pubKey, url).catch(() => undefined);
            if (revalidatedPub !== undefined) {
              cacheHits++;
              hitValues.push(revalidatedPub);
              return { id: step.id, value: revalidatedPub, fail: false };
            }
          }
        }
        let parsed: unknown;
        let stepOk = false;
        let stepRawBytes = 0;
        try {
          const load = liveLoad({ db }, cacheKey, pubKey, step, url);
          // GETs dedupe through singleFlight so prefetch and hot path share one
          // request; mutating methods must each execute, so they never do.
          const out = isGet ? await singleFlight(cacheKey, load) : await load();
          parsed = out.parsed;
          stepOk = out.ok;
          stepRawBytes = out.rawBytes;
        } catch (err) {
          return { id: step.id, value: { error: String(err) }, fail: true };
        }
        liveBytes += stepRawBytes;
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

  const rawKnown = liveBytes + (hitValues.length ? jsonBytes(hitValues) : 0);
  const packed = densifyPayload(results, { rawBytes: rawKnown > 0 ? rawKnown : undefined });
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

/**
 * Ready-node execution mode (EDEN_SCHED=ready).
 *
 * The default wave executor runs Kahn layers through Promise.all, so every
 * wave waits for its slowest member and the next-wave prefetch usually cannot
 * fire (its templates reference same-wave results). This mode schedules any
 * node the moment its DAG dependencies have resolved — same edges, same
 * safety, no barriers:
 *
 *   - data deps and the non-commuting sequential chain are respected exactly
 *     as buildDag encodes them, so two writes can never overlap;
 *   - mutating steps still honor dry-run;
 *   - the first failed step stops NEW launches; in-flight steps settle and
 *     the receipt reports the failure like the wave path does;
 *   - at most READY_MAX_INFLIGHT steps run concurrently.
 *
 * Escape hatch: EDEN_SCHED=waves selects the previous behavior verbatim.
 */
const READY_MAX_INFLIGHT = 8;

export async function playOneReady(
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
  const workspaceId = await resolveWorkspaceId(db, tool);

  interface Node extends DagNode { waitingOn: Set<string> }
  const nodes = new Map<string, Node>();
  for (const n of dag) nodes.set(n.id, { ...n, waitingOn: new Set(n.deps) });
  // deps may reference ids not in this set — those never resolve, matching
  // the wave path's completeness check via unresolvable throw below.
  const byOrder = [...nodes.values()];
  const results: Record<string, unknown> = {};
  const outcomes = new Map<string, StepOutcome>();
  const inflight = new Set<Promise<void>>();
  let attempted = 0;
  let okCount = 0;
  let cacheHits = 0;
  let runnerMs = 0;
  let liveBytes = 0;
  const hitValues: unknown[] = [];
  let stopLaunching = false;

  const readyToRun = (): Node | undefined => {
    // Writes first (they gate their own successors), then reads in declared order.
    return (
      byOrder.find((n) => !outcomes.has(n.id) && !isInflight(n.id) && !stepIsReadOnly(n) && n.waitingOn.size === 0) ??
      byOrder.find((n) => !outcomes.has(n.id) && !isInflight(n.id) && n.waitingOn.size === 0)
    );
  };
  const inflightIds = new Set<string>();
  const isInflight = (id: string) => inflightIds.has(id);

  const launch = (node: Node): void => {
    attempted++;
    inflightIds.add(node.id);
    const step = node as CompiledStep;
    const p = (async () => {
      if (step.kind === "runner") {
        runnerMs += 1;
        return { id: step.id, value: { skipped: "runner_unbound", name: step.name }, fail: true } as StepOutcome;
      }
      const bound = resolveBound(step, params, results);
      const url = resolveTemplate(step.url || "", bound, results);
      if (!url) return { id: step.id, value: { error: "no_url" }, fail: true } as StepOutcome;
      if (opts.dryRun && !stepIsReadOnly(step)) {
        return { id: step.id, value: { skipped: "dry_run", method: step.method || "GET", url }, fail: false } as StepOutcome;
      }
      const isGet = (step.method || "GET") === "GET";
      const cacheKey = resultCacheKey({ workspaceId, toolId: tool.id, step, url, bound });
      const pubKey = isGet ? publicResultKey({ toolId: tool.id, step, url, bound }) : undefined;
      if (isGet) {
        const joined = await joinInflight<unknown>(cacheKey);
        if (joined !== undefined) {
          cacheHits++;
          hitValues.push(joined);
          return { id: step.id, value: joined, fail: false } as StepOutcome;
        }
        const tenantHit = await readEntry(db, cacheKey);
        if (tenantHit !== undefined) {
          cacheHits++;
          hitValues.push(tenantHit.value);
          return { id: step.id, value: tenantHit.value, fail: false } as StepOutcome;
        }
        const pubHit = pubKey !== undefined ? await readEntry(db, pubKey) : undefined;
        if (pubHit !== undefined) {
          cacheHits++;
          hitValues.push(pubHit.value);
          return { id: step.id, value: pubHit.value, fail: false } as StepOutcome;
        }
        const revalidated = await tryRevalidate(db, cacheKey, url).catch(() => undefined);
        if (revalidated !== undefined) {
          cacheHits++;
          hitValues.push(revalidated);
          return { id: step.id, value: revalidated, fail: false } as StepOutcome;
        }
        if (pubKey !== undefined) {
          const revalidatedPub = await tryRevalidate(db, pubKey, url).catch(() => undefined);
          if (revalidatedPub !== undefined) {
            cacheHits++;
            hitValues.push(revalidatedPub);
            return { id: step.id, value: revalidatedPub, fail: false } as StepOutcome;
          }
        }
      }
      let parsed: unknown;
      let stepOk = false;
      let stepRawBytes = 0;
      try {
        const load = liveLoad({ db }, cacheKey, pubKey, step, url);
        const out = isGet ? await singleFlight(cacheKey, load) : await load();
        parsed = out.parsed;
        stepOk = out.ok;
        stepRawBytes = out.rawBytes;
      } catch (err) {
        return { id: step.id, value: { error: String(err) }, fail: true } as StepOutcome;
      }
      liveBytes += stepRawBytes;
      return { id: step.id, value: parsed, fail: !stepOk } as StepOutcome;
    })();
    const tracked = p.then(
      (outcome) => {
        outcomes.set(outcome.id, outcome);
        results[outcome.id] = outcome.value;
        if (!outcome.fail) okCount += 1;
        // Resolved: every dependent loses one outstanding edge. Deps naming
        // ids outside this set never resolve — the stuck check below turns
        // that into the same unresolvable-deps throw the wave path produces.
        for (const n of nodes.values()) n.waitingOn.delete(outcome.id);
        inflightIds.delete(outcome.id);
      },
      () => {
        // The async body catches its own errors; this is belt-and-braces.
        inflightIds.delete(node.id);
      },
    );
    // Remove settled promises or Promise.race(inflight) resolves instantly
    // forever and the scheduler spin-loops.
    tracked.then(
      () => inflight.delete(tracked),
      () => inflight.delete(tracked),
    );
    inflight.add(tracked);
  };

  while (outcomes.size < nodes.size) {
    if (stopLaunching) break;
    while (!stopLaunching && inflight.size < READY_MAX_INFLIGHT) {
      const next = readyToRun();
      if (!next) break;
      launch(next);
    }
    if (inflight.size === 0) break;
    await Promise.race([...inflight]);
    // First failure stops new launches; settled work still lands in results.
    if ([...outcomes.values()].some((o) => o.fail)) stopLaunching = true;
    // Unresolvable deps would spin forever here; detect and throw like the
    // wave path does.
    if (inflight.size === 0 && outcomes.size < nodes.size) {
      const progressPossible = byOrder.some((n) => !outcomes.has(n.id) && !inflightIds.has(n.id) && n.waitingOn.size === 0);
      if (!progressPossible) {
        const stuck = byOrder.filter((n) => !outcomes.has(n.id)).map((n) => n.id);
        throw new Error(`unresolvable step deps: ${stuck.join(",")}`);
      }
    }
  }

  // First failure stops new launches; let in-flight work settle so writes
  // that already started land and results stay consistent.
  if (inflight.size > 0) await Promise.all([...inflight]).catch(() => undefined);

  const failedOutcome = [...outcomes.values()].find((o) => o.fail);
  const knownBytes = liveBytes + (hitValues.length ? jsonBytes(hitValues) : 0);
  const packed = densifyPayload(results, { rawBytes: knownBytes > 0 ? knownBytes : undefined });
  const facing = modelFacing(results);
  const server_ms = Date.now() - t0;
  const receipt: Receipt = {
    ok: failedOutcome === undefined && outcomes.size === nodes.size,
    ...(opts.dryRun ? { dryRun: true } : {}),
    steps_ok: okCount,
    steps_attempted: attempted,
    server_ms,
    runner_ms: runnerMs,
    raw_bytes: packed.raw_bytes,
    densified_bytes: packed.densified_bytes,
    billable_ms: billableMs({ server_ms, steps_attempted: attempted, densified_bytes: packed.densified_bytes }),
    cache_hits: cacheHits,
    result: packed.densified,
    facts: facing.facts,
    ...(failedOutcome !== undefined ? { failed_step: attempted } : {}),
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
  if (!opts.dryRun) {
    await db.run(`UPDATE tool SET uses_count = uses_count + 1 WHERE id = ?`, [tool.id]);
  }
  return receipt;
}

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
  // Scored, not blind-recency: warming the ids that were *just* accessed is
  // pure waste (their entries were refreshed by the access itself). A
  // recency×frequency score over a wider window picks the ids most likely to
  // be called again after the current TTL window has passed them out.
  const watched = await db.all<{ issue: string; seen_count: number; last_seen: number }>(
    `SELECT issue, COUNT(*) AS seen_count, MAX(seen_at) AS last_seen
     FROM watched_issue WHERE workspace_id = ? AND seen_at > ?
     GROUP BY issue ORDER BY last_seen DESC LIMIT 60`,
    [workspaceId, Date.now() - 24 * 60 * 60_000],
  );
  if (!watched.length) return;
  const now = Date.now();
  const maxCount = Math.max(...watched.map((w) => w.seen_count), 1);
  const scored = watched
    .map((w) => {
      const ageMs = Math.max(0, now - w.last_seen);
      const recency = Math.exp(-ageMs / (45 * 60_000)); // ~half-life 30 min
      const frequency = Math.log1p(w.seen_count) / Math.log1p(maxCount);
      return { issue: w.issue, score: 0.65 * recency + 0.35 * frequency };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const csv = scored.map((s) => s.issue).join(",");
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

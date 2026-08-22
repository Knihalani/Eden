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
  type Receipt,
} from "@eden/core";
import { handleForge } from "./forge";
import { safeFetch } from "./ssrf";

const CACHE_TTL_MS = 30 * 60_000;

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
  tool: { id: string; steps: string; name: string },
  params: Record<string, string>,
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
  const results: Record<string, unknown> = {};
  let attempted = 0;
  let ok = 0;
  let cacheHits = 0;
  let runnerMs = 0;
  let failed: number | undefined;

  for (const layer of layers(dag)) {
    const layerOut = await Promise.all(
      layer.map(async (step) => {
        attempted++;
        if (step.kind === "runner") {
          runnerMs += 1;
          return { id: step.id, value: { skipped: "runner_unbound", name: step.name }, fail: true };
        }
        const bound = { ...params };
        for (const [k, v] of Object.entries(step.bind ?? {})) {
          bound[k] = resolveTemplate(String(v), bound, results);
        }
        const url = resolveTemplate(step.url || "", bound, results);
        if (!url) return { id: step.id, value: { error: "no_url" }, fail: true };
        const cacheKey = `${tool.id}:${step.method || "GET"}:${url}`;
        if ((step.method || "GET") === "GET") {
          const hit = await db.get<{ body: string; expires_at: number }>(
            `SELECT body, expires_at FROM result_cache WHERE cache_key = ?`,
            [cacheKey],
          );
          if (hit && hit.expires_at > Date.now()) {
            // A corrupt cached body (older writer, truncated write) is a miss,
            // not a crash: refetch and overwrite below.
            try {
              const value = JSON.parse(hit.body);
              cacheHits++;
              return { id: step.id, value, fail: false };
            } catch {
              /* fall through to a live fetch */
            }
          }
        }
        let parsed: unknown;
        let stepOk = false;
        try {
          const parsedUrl = new URL(url);
          // The forge is an in-process fixture: it never leaves the process, so
          // it is exempt from the egress rules rather than checked against them.
          const local = handleForge(parsedUrl);
          const res = local || (await fetchWithRetry(url, { method: step.method || "GET" }));
          const text = await res.text();
          stepOk = res.ok;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        } catch (err) {
          return { id: step.id, value: { error: String(err) }, fail: true };
        }
        if ((step.method || "GET") === "GET" && stepOk) {
          await db.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
            cacheKey,
            JSON.stringify(parsed),
            Date.now() + CACHE_TTL_MS,
          ]);
          // Expired rows are never read again but were never deleted, so the
          // table grew without bound on long-lived installs. A full sweep on
          // every write would tax the hot path; sampling keeps it bounded at
          // ~2% overhead while still converging.
          if (Math.random() < 0.02) {
            void db.run(`DELETE FROM result_cache WHERE expires_at < ?`, [Date.now() - CACHE_TTL_MS]).catch(() => undefined);
          }
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
    if (failed) break;
  }

  const packed = densifyPayload(results);
  const facing = modelFacing(results);
  const server_ms = Date.now() - t0;
  const receipt: Receipt = {
    ok: failed === undefined,
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
  await db.run(`UPDATE tool SET uses_count = uses_count + 1 WHERE id = ?`, [tool.id]);
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

export async function playTool(
  db: EdenDb,
  tool: { id: string; steps: string; name: string },
  params: Record<string, string>,
): Promise<Receipt> {
  const issues = issuesFromParams(params);
  if (issues.length <= 1) {
    return playOne(db, tool, {
      ...params,
      issue: issues[0] || params.issue || params.pr || params.number || params.id || "",
      id: issues[0] || params.id || params.issue || params.pr || params.number || "",
    });
  }
  const t0 = Date.now();
  // Bounded, not trusted: see MAX_BATCH_ISSUES. The cap is silent by design —
  // the receipt reports what it actually played.
  const batch = issues.slice(0, MAX_BATCH_ISSUES);
  const receipts = await Promise.all(
    batch.map((issue) => playOne(db, tool, { ...params, issue, id: issue, number: issue })),
  );
  // `batch[i]` is index-parallel to `receipts` by construction (receipts came
  // from batch.map), so the fallback never fires; it is there to satisfy the
  // index signature rather than to describe a reachable state.
  const table = receipts.map((r, i) => r.table || receiptTableLine(batch[i] ?? "", r.facts)).join("\n");
  const rows = receipts.flatMap((r, i) => (r.rows?.length ? r.rows : prRowsFromFacts(r.facts, [batch[i] ?? ""])));
  return {
    ok: receipts.every((r) => r.ok),
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
    await playTool(db, tool, { issues: csv, ids: csv, origin });
  }
}

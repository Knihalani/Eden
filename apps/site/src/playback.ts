import type { EdenDb } from "./db";
import {
  billableMs,
  buildDag,
  densifyPayload,
  issuesFromParams,
  layers,
  modelFacing,
  receiptTableLine,
  resolveTemplate,
  type CompiledStep,
  type Receipt,
} from "@eden/core";
import { handleForge } from "./forge";

const CACHE_TTL_MS = 60_000;

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
    last = await fetch(url, { ...init, headers });
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
  const steps = JSON.parse(tool.steps) as CompiledStep[];
  params = {
    owner: process.env.EDEN_GH_OWNER || "",
    repo: process.env.EDEN_GH_REPO || "",
    ...params,
    issue: params.issue || params.pr || params.number || "",
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
        const cacheKey = `${step.method || "GET"}:${url}`;
        if ((step.method || "GET") === "GET") {
          const hit = await db.get<{ body: string; expires_at: number }>(
            `SELECT body, expires_at FROM result_cache WHERE cache_key = ?`,
            [cacheKey],
          );
          if (hit && hit.expires_at > Date.now()) {
            cacheHits++;
            return { id: step.id, value: JSON.parse(hit.body), fail: false };
          }
        }
        let parsed: unknown;
        let stepOk = false;
        try {
          const parsedUrl = new URL(url);
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
        }
        return { id: step.id, value: parsed, fail: !stepOk };
      }),
    );
    for (const r of layerOut) {
      results[r.id] = r.value;
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
  };
  await db.run(
    `INSERT INTO tool_run (id, tool_id, steps_attempted, steps_ok, server_ms, runner_ms, raw_bytes, densified_bytes, billable_ms, cache_hits, receipt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
  await db.run(`UPDATE tool SET uses_count = uses_count + 1 WHERE id = ?`, [tool.id]);
  return receipt;
}

export async function playTool(
  db: EdenDb,
  tool: { id: string; steps: string; name: string },
  params: Record<string, string>,
): Promise<Receipt> {
  const issues = issuesFromParams(params);
  if (issues.length <= 1) {
    return playOne(db, tool, { ...params, issue: issues[0] || params.issue || params.pr || params.number || "" });
  }
  const t0 = Date.now();
  const receipts = await Promise.all(issues.map((issue) => playOne(db, tool, { ...params, issue })));
  const table = receipts.map((r, i) => r.table || receiptTableLine(issues[i], r.facts)).join("\n");
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
  };
}

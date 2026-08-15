import type { EdenDb } from "./db";
import { billableMs, buildDag, densifyPayload, layers, modelFacing, resolveTemplate, type CompiledStep, type Receipt } from "@eden/core";
import { handleForge } from "./forge";

const CACHE_TTL_MS = 60_000;

async function fetchWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: Response | undefined;
  for (let i = 0; i < tries; i++) {
    last = await fetch(url, init);
    if (last.status !== 429 && last.status < 500) return last;
    await new Promise((r) => setTimeout(r, 50 * (i + 1)));
  }
  return last!;
}

export async function playTool(
  db: EdenDb,
  tool: { id: string; steps: string; name: string },
  params: Record<string, string>,
): Promise<Receipt> {
  const t0 = Date.now();
  const steps = JSON.parse(tool.steps) as CompiledStep[];
  const dag = buildDag(steps);
  const results: Record<string, unknown> = {};
  let attempted = 0;
  let ok = 0;
  let raw = 0;
  let densified = 0;
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
        const url = resolveTemplate(step.url || "", params, results);
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
        let ok = false;
        try {
          const parsedUrl = new URL(url);
          const local = handleForge(parsedUrl);
          const res = local || (await fetchWithRetry(url, { method: step.method || "GET" }));
          const text = await res.text();
          ok = res.ok;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        } catch (err) {
          return { id: step.id, value: { error: String(err) }, fail: true };
        }
        if ((step.method || "GET") === "GET" && ok) {
          await db.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
            cacheKey,
            JSON.stringify(parsed),
            Date.now() + CACHE_TTL_MS,
          ]);
        }
        return { id: step.id, value: parsed, fail: !ok };
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
  raw = packed.raw_bytes;
  densified = packed.densified_bytes;
  const facing = modelFacing(results);
  const server_ms = Date.now() - t0;
  const receipt: Receipt = {
    ok: failed === undefined,
    steps_ok: ok,
    steps_attempted: attempted,
    server_ms,
    runner_ms: runnerMs,
    raw_bytes: raw,
    densified_bytes: densified,
    billable_ms: billableMs({ server_ms, steps_attempted: attempted, densified_bytes: densified }),
    cache_hits: cacheHits,
    result: packed.densified,
    facts: facing.facts,
    failed_step: failed,
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

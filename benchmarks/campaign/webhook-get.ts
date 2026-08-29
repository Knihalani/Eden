/**
 * Wave 15.3 rotation world: webhook-invalidated GET.
 *
 * Upstream says a named GET changed. POST /v1/webhook with HMAC of the raw
 * body (`x-eden-webhook-signature` / `x-hub-signature-256`) drops that
 * result_cache key (and the public-pool twin when it is the same URL
 * identity). The next read is a miss, then a fresh fetch. The live tool stays
 * On — webhook is not pause and does not rewrite the live program. A
 * replacement draft is queued only if recompile+shadow PASSes; a cache drop
 * without traces does not clone live steps.
 *
 * This is not a retune of `upstream-rename` (that fixture is a field rename
 * state→conclusion that queues a draft+knock). Here the envelope is the GET
 * cache; the program is unchanged until Approve.
 *
 *   bun test benchmarks/campaign/webhook-get.test.ts
 *
 * Pre-registered expect (ROADMAP §4.9) is `EXPECT` below.
 */
import { openDb } from "../../apps/site/src/db";
import {
  publicResultKey,
  readResult,
  resultCacheKey,
  writeResult,
} from "../../apps/site/src/cache";
import { playTool } from "../../apps/site/src/playback";
import { handleWebhook, webhookHmacHex } from "../../apps/site/src/webhook";

/**
 * Pre-registered Wave 15 rotation verdict. Recorded before the run.
 * expect: webhook-invalidated GET misses after drop; live stays On; not a field rename.
 */
export const EXPECT =
  "webhook-invalidated GET: named GET hits then miss after invalidate; live stays On";

export const GET_URL = "https://x.test/forge/1/comments";
export const STEP = { id: "s1", name: "get_comments", method: "GET" } as const;

export type WebhookGetRun = {
  expect: typeof EXPECT;
  hitsBefore: number;
  hitsAfter: number;
  dropped: string[];
  liveState: string | null;
  message: string;
  publicDropped: boolean;
  playHitsAfter: number;
};

export async function runWebhookGet(opts?: { tag?: string; secret?: string }): Promise<WebhookGetRun> {
  const tag = opts?.tag ?? "wg";
  const secret = opts?.secret ?? "whsec_campaign_get";
  const db = await openDb(`/tmp/eden-webhook-get-${tag}-${Date.now()}.db`);
  const ws = `ws_${tag}`;
  const toolId = `t_get_${tag}`;
  const steps = [{ id: STEP.id, kind: "cloud_http", name: STEP.name, method: STEP.method, commute: true, url: GET_URL }];
  await db.run(
    `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k)
     VALUES (?, ?, 'get_comments', ?, 'on', ?, '[]', ?, 2)`,
    [toolId, ws, "named GET for webhook invalidation", JSON.stringify(steps), `fp/${tag}/get`],
  );

  const ident = { workspaceId: ws, toolId, step: STEP, url: GET_URL, bound: {} };
  const tenantKey = resultCacheKey(ident);
  const publicKey = publicResultKey(ident);
  await writeResult(db, tenantKey, { comments: [{ id: 1, body: "cached" }] }, 60_000, undefined, {
    method: "GET",
    force: true,
  });
  await writeResult(db, publicKey, { comments: [{ id: 1, body: "cached" }] }, 60_000, undefined, {
    method: "GET",
    force: true,
  });

  const hit = await readResult(db, tenantKey);
  const hitsBefore = hit === undefined ? 0 : 1;

  const prev = process.env.EDEN_WEBHOOK_SECRET;
  process.env.EDEN_WEBHOOK_SECRET = secret;
  let dropped: string[] = [];
  let liveState: string | null = null;
  let message = "";
  try {
    const body = JSON.stringify({
      keys: [tenantKey],
      url: GET_URL,
      toolId,
      workspaceId: ws,
      step: STEP,
    });
    const res = await handleWebhook(
      db,
      new Request("http://127.0.0.1:8787/v1/webhook", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8787",
          "content-type": "application/json",
          "x-eden-webhook-signature": `sha256=${webhookHmacHex(secret, body)}`,
        },
        body,
      }),
    );
    const j = (await res.json()) as { dropped?: string[]; live?: string | null; message?: string };
    dropped = j.dropped ?? [];
    liveState = j.live ?? null;
    message = j.message ?? "";
  } finally {
    if (prev === undefined) delete process.env.EDEN_WEBHOOK_SECRET;
    else process.env.EDEN_WEBHOOK_SECRET = prev;
  }

  const miss = await readResult(db, tenantKey);
  const hitsAfter = miss === undefined ? 0 : 1;
  const row = await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = ?`, [toolId]);
  const live = row?.state ?? liveState;

  const played = await playTool(db, { id: toolId, name: "get_comments", steps: JSON.stringify(steps), workspace_id: ws }, {});

  return {
    expect: EXPECT,
    hitsBefore,
    hitsAfter,
    dropped,
    liveState: live,
    message,
    publicDropped: !(await readResult(db, publicKey)),
    playHitsAfter: played.cache_hits ?? 0,
  };
}

export { WEBHOOK_DROPPED_COPY, WEBHOOK_WAITING_COPY } from "../../apps/site/src/webhook";

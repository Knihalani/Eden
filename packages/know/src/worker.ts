#!/usr/bin/env bun
/**
 * Always-on ingest: health HTTP + tick loop that compact-publishes to S3.
 * Northflank (and similar) probe GET /health. Crawl state lives in EDEN_KNOW_DIR.
 */
import { DEFAULT_CC, DEFAULT_INTERVAL_SEC, DEFAULT_LIVE, DEFAULT_NEWS, DEFAULT_WET_EVERY, envNum, shardCount, shardIndex } from "./defaults";
import { runLoop, type TickStats } from "./loop";
import { s3Configured } from "./s3";

const port = envNum("PORT", 8080);
const intervalSec = envNum("EDEN_KNOW_INTERVAL", DEFAULT_INTERVAL_SEC);
const cc = envNum("EDEN_KNOW_CC", DEFAULT_CC);
const live = envNum("EDEN_KNOW_LIVE", DEFAULT_LIVE);
const news = envNum("EDEN_KNOW_NEWS", DEFAULT_NEWS);
const caps = {
  cc,
  live,
  news,
  intervalSec,
  shard: shardIndex(),
  shards: shardCount(),
  wetEvery: envNum("EDEN_KNOW_WET_EVERY", DEFAULT_WET_EVERY),
};
let last: Record<string, unknown> = { ok: true, starting: true, s3: s3Configured(), caps };

const server = Bun.serve({
  port,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health" || path === "/" || path === "/ready") {
      return Response.json({ ok: true, ...last });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    listen: `:${server.port}`,
    dir: process.env.EDEN_KNOW_DIR || "",
    s3: s3Configured(),
  }),
);

await new Promise((r) => setTimeout(r, 3_000));

setInterval(() => {
  const started = typeof last.tick_started === "string" ? Date.parse(String(last.tick_started)) : 0;
  const elapsed = started > 1e12 && last.ms == null ? Date.now() - started : undefined;
  last = {
    ...last,
    starting: false,
    pulse: new Date().toISOString(),
    ...(elapsed != null ? { ms: elapsed } : {}),
  };
}, 5_000).unref();

function remember(s: TickStats & { ms?: number; err?: string; counts?: { pack?: number; wal_nodes?: number; frontier?: number } }) {
  last = {
    ok: !s.err,
    s3: s3Configured(),
    caps,
    at: new Date().toISOString(),
    cc: s.cc,
    live: s.live,
    news: s.news,
    cdx: s.cdx,
    nodes: s.nodes,
    skipped: s.skipped,
    pack: s.counts?.pack,
    wal: s.counts?.wal_nodes,
    frontier: s.counts?.frontier,
    ms: s.ms,
    err: s.err,
    tick_started: last.tick_started,
  };
}

async function loop() {
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    orig(...args);
    const line = args[0];
    if (typeof line === "string" && line.startsWith("{")) {
      try {
        const j = JSON.parse(line) as TickStats & { ms?: number; err?: string; counts?: { pack?: number; wal_nodes?: number; frontier?: number } };
        if ("cc" in j || "err" in j) remember(j);
      } catch {
        /* not tick JSON */
      }
    }
  };
  await runLoop({
    intervalSec,
    cc,
    live,
    news,
    onStart: () => {
      last = { ...last, starting: false, tick_started: new Date().toISOString(), ms: undefined };
    },
  });
}

loop().catch((e) => {
  last = { ok: false, err: String(e).slice(0, 200), at: new Date().toISOString() };
  console.log(JSON.stringify({ at: new Date().toISOString(), err: String(e).slice(0, 200) }));
  process.exit(1);
});

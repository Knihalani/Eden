#!/usr/bin/env bun
/**
 * Always-on ingest: health HTTP on the parent, tick loop in a child.
 * GET /health stays answerable while WET gunzip/parse owns the child's CPU.
 * Crawl state lives in EDEN_KNOW_DIR.
 */
import { DEFAULT_CC, DEFAULT_INTERVAL_SEC, DEFAULT_LIVE, DEFAULT_NEWS, DEFAULT_WET_EVERY, compactLeader, envNum, shardCount, shardIndex, wetByteCap } from "./defaults";
import { runLoop, type TickStats } from "./loop";
import { s3Configured } from "./s3";
import { fileURLToPath } from "node:url";

const ingestChild = process.env.EDEN_KNOW_INGEST_CHILD === "1";
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
  wetScan: envNum("EDEN_KNOW_WET_SCAN", 0),
  wetBytes: wetByteCap(),
  compactLeader: compactLeader(),
};
let last: Record<string, unknown> = { ok: true, starting: true, s3: s3Configured(), caps };

type TickLine = TickStats & {
  ms?: number;
  err?: string;
  starting?: boolean;
  tick_started?: string;
  counts?: { pack?: number; wal_nodes?: number; frontier?: number };
};

function remember(s: TickLine) {
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
    tick_started: s.tick_started ?? last.tick_started,
    starting: s.starting === false ? false : last.starting,
  };
}

function applyLine(line: string) {
  if (!line.startsWith("{")) return;
  try {
    const j = JSON.parse(line) as TickLine;
    if (typeof j.tick_started === "string") {
      last = { ...last, starting: false, tick_started: j.tick_started, ms: undefined };
    }
    if ("cc" in j || "err" in j) remember(j);
  } catch {
    /* not tick JSON */
  }
}

async function ingestLoop() {
  await new Promise((r) => setTimeout(r, 3_000));
  await runLoop({
    intervalSec,
    cc,
    live,
    news,
    onStart: () => {
      console.log(JSON.stringify({ tick_started: new Date().toISOString(), starting: false }));
    },
  });
}

if (ingestChild) {
  ingestLoop().catch((e) => {
    console.log(JSON.stringify({ at: new Date().toISOString(), err: String(e).slice(0, 200) }));
    process.exit(1);
  });
} else {
  const listenHost = process.env.EDEN_KNOW_LISTEN;
  const server = Bun.serve({
    port,
    ...(listenHost ? { hostname: listenHost } : {}),
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
      ingest: "child",
    }),
  );
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

  const self = import.meta.path.startsWith("file:") ? fileURLToPath(import.meta.path) : import.meta.path;
  const child = Bun.spawn([process.execPath, self], {
    env: { ...process.env, EDEN_KNOW_INGEST_CHILD: "1" },
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  const stop = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        buf += dec.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          process.stdout.write(line + "\n");
          applyLine(line);
          nl = buf.indexOf("\n");
        }
      }
      if (done) break;
    }
    const code = await child.exited;
    process.exit(code || 1);
  })().catch((e) => {
    last = { ok: false, err: String(e).slice(0, 200), at: new Date().toISOString() };
    process.exit(1);
  });
}

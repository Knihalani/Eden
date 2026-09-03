#!/usr/bin/env bun
import { knowDir, openStore } from "./store";
import { runLoop } from "./loop";
import { knowQuery } from "./query";
import { latestCrawlId } from "./cc";
import { DEFAULT_CC, DEFAULT_INTERVAL_SEC, DEFAULT_LIVE, DEFAULT_NEWS } from "./defaults";
import { compactAndPublish, PUBLIC_DUMP_URL, s3Configured, s3PublicUrl } from "./s3";

function binName(): string {
  return import.meta.main ? "eden-know" : "eden know";
}

function flagNum(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return fallback;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function knowCli(argv: string[]): Promise<number> {
  const cmd = argv[0] || "help";
  const bin = binName();
  if (cmd === "run") {
    const once = argv.includes("--once");
    const interval = flagNum(argv, "--interval", DEFAULT_INTERVAL_SEC);
    const cc = flagNum(argv, "--cc", DEFAULT_CC);
    const live = flagNum(argv, "--live", DEFAULT_LIVE);
    const news = flagNum(argv, "--news", DEFAULT_NEWS);
    await runLoop({ intervalSec: interval, once, cc, live, news });
    return 0;
  }
  if (cmd === "status") {
    const { statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const store = openStore();
    const id = store.getMeta("cc_crawl") || (await latestCrawlId().catch((e) => String(e)));
    const c = store.count();
    const ver = store.schemaVersion();
    const sqlite = join(knowDir(), "graph.sqlite");
    const pack = join(knowDir(), "graph.kpk");
    let bytes = 0;
    let pack_bytes = 0;
    try {
      bytes = statSync(sqlite).size;
    } catch {
      /* */
    }
    try {
      pack_bytes = statSync(pack).size;
      bytes += pack_bytes;
    } catch {
      /* */
    }
    store.close();
    console.log(JSON.stringify({ dir: knowDir(), crawl: id, ver, bytes, pack_bytes, ...c }, null, 2));
    return 0;
  }
  if (cmd === "compact") {
    const store = openStore();
    const pub = await compactAndPublish(store);
    const c = store.count();
    store.close();
    console.log(JSON.stringify({ dir: knowDir(), publish: pub, ...c }, null, 2));
    return pub.compacted ? 0 : 1;
  }
  if (cmd === "dump") {
    const { createHash } = await import("node:crypto");
    const { statSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const store = openStore();
    const pub = await compactAndPublish(store);
    store.close();
    const pack = join(knowDir(), "graph.kpk");
    try {
      const bytes = statSync(pack).size;
      const sha256 = pub.sha256 || createHash("sha256").update(readFileSync(pack)).digest("hex");
      console.log(
        JSON.stringify(
          {
            pack,
            bytes,
            sha256,
            uploaded: pub.uploaded,
            replica: pub.url || (s3Configured() ? s3PublicUrl() : undefined),
            url: PUBLIC_DUMP_URL,
            skipped: pub.skipped,
            note: "query reads this pack only. WAL ingest is invisible until compact. source stays private.",
          },
          null,
          2,
        ),
      );
      return 0;
    } catch {
      console.log(JSON.stringify({ error: "no pack; ingest then compact" }, null, 2));
      return 1;
    }
  }
  if (cmd === "query") {
    const q = argv.slice(1).join(" ").trim();
    if (!q) {
      console.log(JSON.stringify({ unknown: true }, null, 2));
      console.error(`usage: ${bin} query <text>`);
      return 1;
    }
    console.log(JSON.stringify(knowQuery(q), null, 2));
    return 0;
  }
  console.log(`${bin} — robots-ok public ingest onto a graph (paywalls skipped)

  ${bin} run [--once] [--interval ${DEFAULT_INTERVAL_SEC}] [--cc ${DEFAULT_CC}] [--live ${DEFAULT_LIVE}] [--news ${DEFAULT_NEWS}]
  ${bin} status
  ${bin} compact
  ${bin} dump
  ${bin} query <question>

query reads ~/.eden/know/graph.kpk only (or EDEN_KNOW_DIR). Ingest writes an
overlay journal (graph.jnl) plus crawl.bin; those facts do not appear in query
or wrap until compact. compact is a full in-RAM rewrite: fetch the published
object, merge WAL, write, upload (If-Match).
dump does that and prints path, bytes, SHA-256, public URL.

Volume: Common Crawl WET over HTTPS plus a wide live frontier after RFC 9309
robots.txt. Wikipedia and other robots-ok hosts are in. Listed paywalls are
out. No Playwright, no paid render API.
`);
  return cmd === "help" || !cmd ? 0 : 1;
}

if (import.meta.main) process.exit(await knowCli(process.argv.slice(2)));

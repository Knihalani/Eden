#!/usr/bin/env bun
import { knowDir, openStore } from "./store";
import { runLoop } from "./loop";
import { knowQuery } from "./query";
import { latestCrawlId } from "./cc";
import { DEFAULT_CC, DEFAULT_INTERVAL_SEC, DEFAULT_LIVE } from "./defaults";

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
    await runLoop({ intervalSec: interval, once, cc, live });
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
    store.compact();
    const c = store.count();
    store.close();
    console.log(JSON.stringify({ dir: knowDir(), compacted: true, ...c }, null, 2));
    return 0;
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
  console.log(`${bin} — continuous public ingest onto a graph (robots-honoring, no Wikipedia)

  ${bin} run [--once] [--interval ${DEFAULT_INTERVAL_SEC}] [--cc ${DEFAULT_CC}] [--live ${DEFAULT_LIVE}]
  ${bin} status
  ${bin} compact
  ${bin} query <question>

Volume: newest Common Crawl WET over HTTPS (no key). Delta: live fetch of
frontier URLs after RFC 9309 robots.txt. JS-heavy pages: JSON-LD / Open Graph /
noscript in the first HTML — no Playwright, no paid render API.
`);
  return cmd === "help" || !cmd ? 0 : 1;
}

if (import.meta.main) process.exit(await knowCli(process.argv.slice(2)));

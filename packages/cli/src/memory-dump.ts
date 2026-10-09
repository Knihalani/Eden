/**
 * `eden memory dump --json`: every row of the memory store and every ledger record, as a user inspects a store
 * (the `spawn-writers` arm's contract, A5 §4):
 *
 *   {"rows": [{"id", "text", "store", "kind", "seq"?, "t"?, "invalid_at"?, "invalid_by"?, "valid_until"?,
 *              "pending"?}…],
 *    "ledger": [{"window", "k", …the record}…]}
 *
 * A row's `store` is the directory it lives in, relative to the memory root: `repos/<repo>` for a repo's store (D1),
 * and a session directory or `""` (the root) for rows written in the layout before P0.5. Rows still waiting in a
 * `pending.jsonl` for their `seq` are listed with `pending: true`. Read-only: nothing is written.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { storeRows, type MemoryRecord } from "../../../src/index";
import { pendingRows, type DiskRow } from "../../../src/memory-ids";
import { windowRecords } from "../../../src/memory-window";
import { memoryRoot } from "./memory-hook";

export interface MemoryDump {
  rows: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** A row under A4 §1's names. */
function dumpRow(r: MemoryRecord, store: string): Record<string, unknown> {
  return {
    id: r.id,
    text: r.text,
    store,
    kind: r.kind,
    seq: r.seq,
    t: r.at,
    invalid_at: r.invalidAt,
    invalid_by: r.invalidBy,
    valid_until: r.validUntil,
  };
}

/**
 * The rows under one seq domain (`memory-ids.ts`): its stores, then the rows still pending in it. A row is listed
 * once: from its store when a sleep has stored it (its taken pending file stays until `done`, or after a crash), else
 * as its last pending copy (a row superseded after it was left pending is left again).
 */
function domainRows(root: string, domain: string, stores: readonly string[]): Record<string, unknown>[] {
  const named = (store: string) => [domain, store].filter(Boolean).join("/");
  const rows = stores.flatMap((store) => {
    const path = join(root, domain, store, "memories.jsonl");
    return existsSync(path) ? storeRows(path).map((r) => dumpRow(r, named(store))) : [];
  });
  const stored = new Set(rows.map((row) => row.id));
  const waiting = new Map<string, Record<string, unknown>>();
  for (const { store, row } of pendingRows(join(root, domain)))
    if (!stored.has(row.id)) waiting.set(row.id, { ...(row as DiskRow), store: named(store), pending: true });
  return [...rows, ...waiting.values()];
}

export function memoryDump(root: string): MemoryDump {
  const sessions = subdirs(root).filter((name) => name !== "windows" && name !== "repos");
  const rows = [
    ...subdirs(join(root, "repos")).flatMap((repo) => domainRows(root, `repos/${repo}`, [""])),
    ...domainRows(root, "", ["", ...sessions]),
  ];
  const windows = join(root, "windows");
  const ledger = subdirs(windows).flatMap((window) =>
    windowRecords(join(windows, window), "delivery.log").map((record) => ({ window, ...record })),
  );
  return { rows, ledger };
}

export function memoryDumpCli(args: string[]): number {
  const dump = memoryDump(memoryRoot());
  if (args.includes("--json")) {
    console.log(JSON.stringify(dump));
    return 0;
  }
  const pending = dump.rows.filter((row) => row.pending).length;
  console.log(`${dump.rows.length} rows (${pending} waiting for a seq) · ${dump.ledger.length} ledger records`);
  return 0;
}

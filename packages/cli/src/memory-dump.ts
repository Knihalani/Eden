/**
 * `eden memory dump --json`: every row of the memory store and every ledger record, as a user inspects a store
 * (the `spawn-writers` arm's contract, A5 §4):
 *
 *   {"rows": [{"id", "text", "store", "kind", "seq"?, "t"?, "invalid_at"?, "invalid_by"?, "valid_until"?,
 *              "pending"?}…],
 *    "ledger": [{"window", "k", …the record}…]}
 *
 * A row's `store` is the session directory it lives in (`""` for the root) until P0.5 keys stores by repo. Rows still
 * waiting in `pending.jsonl` for their `seq` are listed with `pending: true`. Read-only: nothing is written.
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

export function memoryDump(root: string): MemoryDump {
  const stores = ["", ...subdirs(root).filter((name) => name !== "windows")];
  const rows = stores.flatMap((store) => {
    const path = join(root, store, "memories.jsonl");
    return existsSync(path) ? storeRows(path).map((r) => dumpRow(r, store)) : [];
  });
  for (const { store, row } of pendingRows(root)) rows.push({ ...(row as DiskRow), store, pending: true });
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

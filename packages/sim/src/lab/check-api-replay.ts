/**
 * The push check's recorded API replies, seeded into the queue transport's replay store (F9, D1104). LAB ONLY.
 *
 *   bun packages/sim/src/lab/check-api-replay.ts DUMP.jsonl[.gz] QUEUE_DIR [--half tune|test|all]
 *
 * DUMP is `--check-dump` rows (hidden-funnel; e.g. F2's base-dumps-4142.jsonl.gz: Haiku 5.5 on Anthropic's API):
 * each row's request, day and pool as the check read them, and the API's raw `reply`. For each answered row the
 * script rebuilds the exact Messages API body the shipped check sends through `labModel` (`checkMessages`, 500
 * tokens, JSON, thinking off), keys it as the queue transport does (role `eden.check`), and writes the API's reply to
 * `QUEUE_DIR/done/<key>.json`. A run on that queue then gets the API's own answer wherever its check prompt is one the
 * API answered, and goes to the subagents only for the rest (`calls.jsonl` says which: `hit`). So an arm that leaves
 * the check's prompt alone reads the API exactly on those prompts; an arm that changes the check's prompt or rule
 * misses them all (D1104: no subagent recipe reads such arms faithfully; they need the API).
 *
 * `--half` keeps the rows of one half of a fixed split (by the row's `key`): the recipe is tuned on `tune` and
 * measured on `test`, so a measurement never reads the replies it was tuned on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { anthropicBody } from "@eden/llm";
import { checkMessages, type PushCheckInput } from "@eden/engine";
import { ensureQueue, keyOf, queueDirs, writeAtomic } from "./queue-transport";

/** The push check's reply cap (`COMPARE_MAX_TOKENS` in @eden/engine's push-check.ts, not exported). */
export const CHECK_MAX_TOKENS = 500;
export const CHECK_MODEL = "claude-haiku-5-5";

export interface DumpRow {
  suite: string;
  seed: number;
  variant: string;
  template: string;
  planted: string;
  key: string;
  request: string;
  today: string;
  items: (Omit<PushCheckInput["items"][number], "hash"> & { full?: string })[];
  yes: string[] | null;
  reply: string | null;
}

export function readDump(path: string): DumpRow[] {
  const raw = path.endsWith(".gz") ? gunzipSync(readFileSync(path)).toString("utf8") : readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DumpRow);
}

/** The fixed split: a row is in `tune` when its key's hash is even. */
export const halfOf = (row: DumpRow): "tune" | "test" =>
  createHash("md5").update(`${row.suite}|${row.seed}|${row.variant}|${row.template}|${row.request}`).digest()[0]! % 2
    ? "test"
    : "tune";

/** The shipped check's request for a dumped row, as `PushCheck.check` builds it. */
export function checkRequest(row: DumpRow) {
  const items = row.items.map(({ full: _full, ...it }) => ({ ...it, hash: "" }));
  return {
    messages: checkMessages({ request: row.request, today: row.today, items }),
    maxTokens: CHECK_MAX_TOKENS,
    json: true,
  };
}

/** The queue transport's key for a dumped row's check call. */
export function checkQueueKey(row: DumpRow): string {
  const body = anthropicBody({ apiKey: "", model: CHECK_MODEL }, checkRequest(row), true);
  return keyOf("eden.check", body);
}

/** Writes every answered row's API reply into `dir`'s replay store; returns how many were written. */
export function seedApiReplay(rows: DumpRow[], dir: string): number {
  ensureQueue(dir);
  const { done } = queueDirs(dir);
  let n = 0;
  for (const row of rows) {
    if (row.reply === null || row.yes === null) continue;
    const id = checkQueueKey(row);
    writeAtomic(join(done, `${id}.json`), {
      id,
      role: "eden.check",
      model: CHECK_MODEL,
      answer: { text: row.reply },
      transport: "api-recorded",
      source: { suite: row.suite, seed: row.seed, variant: row.variant, template: row.template },
    });
    n++;
  }
  return n;
}

if (import.meta.main) {
  const [dump, dir] = process.argv.slice(2);
  const i = process.argv.indexOf("--half");
  const half = i >= 0 ? process.argv[i + 1] : "all";
  if (!dump || !dir || !["tune", "test", "all"].includes(half ?? "")) {
    console.error("usage: check-api-replay.ts DUMP.jsonl[.gz] QUEUE_DIR [--half tune|test|all]");
    process.exit(2);
  }
  const rows = readDump(dump).filter((r) => half === "all" || halfOf(r) === half);
  console.log(JSON.stringify({ rows: rows.length, seeded: seedApiReplay(rows, dir), half }));
}

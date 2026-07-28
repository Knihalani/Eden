/**
 * Durable offline queue — JSONL file spill (Node). Browser IndexedDB omitted.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface OfflineEvent {
  sourceFormat: string;
  payload: Record<string, unknown>;
}

/**
 * A row returned by {@link OfflineQueue.peek}. ``raw`` is the exact
 * JSONL line the row was parsed from -- {@link OfflineQueue.ack}
 * uses it (rather than a numeric offset) to identify exactly which
 * physical lines to delete, so an `enqueue()` that lands between a
 * `peek()` and its matching `ack()` is never clobbered.
 */
export interface OfflineRow extends OfflineEvent {
  raw: string;
}

export class OfflineQueue {
  path: string;
  maxRows: number;
  dropped = 0;

  constructor(path?: string, maxRows = 10_000) {
    this.path =
      path ??
      join(homedir(), ".eden", "offline_queue.jsonl");
    this.maxRows = maxRows;
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      writeFileSync(this.path, "", "utf8");
    }
  }

  enqueue(sourceFormat: string, payload: Record<string, unknown>): void {
    appendFileSync(
      this.path,
      JSON.stringify({ sourceFormat, payload }) + "\n",
      "utf8",
    );
    this._trim();
  }

  drain(limit = 100): OfflineEvent[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const take = lines.slice(0, limit);
    const rest = lines.slice(limit);
    writeFileSync(this.path, rest.length ? rest.join("\n") + "\n" : "", "utf8");
    const out: OfflineEvent[] = [];
    for (const line of take) {
      try {
        const parsed = JSON.parse(line) as OfflineEvent;
        out.push(parsed);
      } catch {
        this.dropped += 1;
      }
    }
    return out;
  }

  /**
   * Non-destructive read of up to ``limit`` rows from the front of
   * the queue. Unlike {@link drain}, rows are NOT removed from disk
   * -- callers that need "ack only on confirmed delivery success"
   * semantics (e.g. `EdenSDK.flushOffline()`) should read via
   * `peek()`, attempt delivery, and only call {@link ack} for the
   * rows that actually succeeded. A crash (or timeout) between
   * `peek()` and `ack()` leaves the rows durably on disk for a
   * later replay, instead of silently losing them the way an
   * eager `drain()`-then-send would.
   */
  peek(limit = 100): OfflineRow[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const take = lines.slice(0, limit);
    const out: OfflineRow[] = [];
    for (const line of take) {
      try {
        const parsed = JSON.parse(line) as OfflineEvent;
        out.push({ ...parsed, raw: line });
      } catch {
        this.dropped += 1;
      }
    }
    return out;
  }

  /**
   * Delete exactly the rows in ``rows`` (matched by their raw JSONL
   * line, as returned by {@link peek}) from the queue file. Rows
   * that were appended to the file after the matching `peek()` call
   * (e.g. a concurrent `enqueue()` while a replay was in flight) are
   * left untouched -- ack only removes what the caller actually
   * confirmed was delivered.
   */
  ack(rows: OfflineRow[]): void {
    if (rows.length === 0 || !existsSync(this.path)) return;
    // Count occurrences so duplicate lines (identical JSON content)
    // are removed exactly as many times as they were acked, not
    // more.
    const toRemove = new Map<string, number>();
    for (const row of rows) {
      toRemove.set(row.raw, (toRemove.get(row.raw) ?? 0) + 1);
    }
    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const remaining: string[] = [];
    for (const line of lines) {
      const pending = toRemove.get(line);
      if (pending && pending > 0) {
        toRemove.set(line, pending - 1);
        continue;
      }
      remaining.push(line);
    }
    writeFileSync(
      this.path,
      remaining.length ? remaining.join("\n") + "\n" : "",
      "utf8",
    );
  }

  size(): number {
    if (!existsSync(this.path)) return 0;
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  }

  private _trim(): void {
    const n = this.size();
    if (n <= this.maxRows) return;
    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const overflow = n - this.maxRows;
    this.dropped += overflow;
    writeFileSync(
      this.path,
      lines.slice(overflow).join("\n") + (lines.length > overflow ? "\n" : ""),
      "utf8",
    );
  }
}

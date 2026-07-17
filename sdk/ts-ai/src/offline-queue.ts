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

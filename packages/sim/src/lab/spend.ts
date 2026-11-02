/**
 * The lab's hard cap on Anthropic spend, shared by every process of a campaign through one append-only ledger file
 * (JSON lines, one per request). LAB ONLY.
 *
 * Before each request `reserve` re-reads what other processes appended, adds the requests in flight in this process
 * at their worst case, and refuses (throws `SpendCapReached`) when the total would pass the cap. After each request
 * `book` appends the real cost, computed from the API's reported usage (uncached input, cache writes, cache reads,
 * output). Processes running at once cannot see each other's in-flight worst cases, so callers give each process a
 * `headroomUsd` it keeps clear of the cap.
 *
 * Every line also carries the run's labels (`role`: agent, grader, eden.judge, eden.cards, ...), so the ledger is the
 * per-request record the benchmark reports from: tokens, cache share, latency and time to first token.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AnthropicCallRecord, AnthropicMeter } from "@eden/llm";

export class SpendCapReached extends Error {
  override name = "SpendCapReached";
}

export interface LedgerLine extends AnthropicCallRecord {
  at: string;
  run: string;
  role: string;
}

export class SpendLedger {
  /** Spend booked in the file, as last read. */
  private fileUsd = 0;
  private readOffset = 0;
  private partial = "";
  /** Worst cases reserved in this process and not yet booked. */
  private inFlightUsd = 0;
  /** Spend this process booked. */
  bookedUsd = 0;
  calls = 0;

  constructor(
    readonly path: string,
    readonly capUsd: number,
    readonly run: string,
    readonly headroomUsd = 0.5,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.refresh();
  }

  /** Reads lines appended since the last read (by any process). */
  private refresh(): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size <= this.readOffset) return;
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(size - this.readOffset);
      readSync(fd, buf, 0, buf.length, this.readOffset);
      this.readOffset = size;
      const text = this.partial + buf.toString("utf8");
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.fileUsd += Number((JSON.parse(line) as LedgerLine).costUsd) || 0;
        } catch {
          // A torn line from a crashed writer: skipped (its cost is lost to the tally, so headroom covers it).
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Total spend in the ledger plus this process's in-flight worst cases. */
  get committedUsd(): number {
    this.refresh();
    return this.fileUsd + this.inFlightUsd;
  }

  /** A meter for one role of the run (agent, grader, eden.judge, ...). */
  meter(role: string): AnthropicMeter & { release(estimateUsd: number): void } {
    let pending: number[] = [];
    return {
      reserve: (estimateUsd: number) => {
        if (this.committedUsd + estimateUsd + this.headroomUsd > this.capUsd) {
          throw new SpendCapReached(
            `spend cap $${this.capUsd} reached: $${this.committedUsd.toFixed(4)} committed, call needs ` +
              `$${estimateUsd.toFixed(4)} + $${this.headroomUsd} headroom`,
          );
        }
        this.inFlightUsd += estimateUsd;
        pending.push(estimateUsd);
      },
      book: (record: AnthropicCallRecord) => {
        const reserved = pending.shift() ?? 0;
        this.inFlightUsd = Math.max(0, this.inFlightUsd - reserved);
        this.write(role, record);
      },
      release: (estimateUsd: number) => {
        const i = pending.indexOf(estimateUsd);
        if (i >= 0) pending = pending.filter((_, j) => j !== i);
        this.inFlightUsd = Math.max(0, this.inFlightUsd - estimateUsd);
      },
    };
  }

  /** Books a call made outside `AnthropicModel` (pi-ai's agent requests), from its reported usage. */
  write(role: string, record: AnthropicCallRecord): void {
    const line: LedgerLine = { at: new Date().toISOString(), run: this.run, role, ...record };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    this.bookedUsd += record.costUsd;
    this.calls++;
  }
}

/** Sums a ledger: spend and tokens by run and role, and the share of prompt tokens read from the cache. */
export function summarizeLedger(lines: LedgerLine[]) {
  const by = new Map<string, { calls: number; usd: number; input: number; cacheRead: number; cacheWrite: number }>();
  for (const l of lines) {
    const key = `${l.run}\t${l.role}`;
    const t = by.get(key) ?? { calls: 0, usd: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
    t.calls++;
    t.usd += l.costUsd;
    t.input += l.usage.inputTokens;
    t.cacheRead += l.usage.cachedInputTokens;
    t.cacheWrite += l.usage.cacheWriteTokens;
    by.set(key, t);
  }
  return [...by].map(([key, t]) => {
    const [run, role] = key.split("\t");
    return { run, role, ...t, cacheReadShare: t.input ? t.cacheRead / t.input : 0 };
  });
}

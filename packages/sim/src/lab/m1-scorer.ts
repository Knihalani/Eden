/**
 * M1 (D894, docs/research/m1-student.md): the lab's scorer for `pushCheckLocal`, a distilled student served by
 * `packages/sim/modal/m1_serve.py` (POST `<url>/score`, bearer key). Lab only: nothing in a product package imports it.
 *
 * Every answer is kept in a JSONL cache keyed by what the student read (the request, the day, each item's title and
 * text), so a rerun replays at $0 (`--checker-cache F`, appended to). A cache miss with no URL fails, and the checker
 * fails open to the default's candidates, so a replay-only run says how many it missed (`misses`). The key is read
 * from `EDEN_LAB_CHECKER_KEY`, never a flag, and never printed.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { LocalCheckInput, PushCheckScorer } from "@eden/engine";

export function scoreKey(input: LocalCheckInput): string {
  const h = createHash("sha256").update(`${input.today}\n${input.request}\n`);
  for (const it of input.items) h.update(`${it.title}\u0000${it.text}\u0001`);
  return h.digest("hex").slice(0, 32);
}

export class HttpScorer implements PushCheckScorer {
  readonly cache = new Map<string, number[]>();
  calls = 0;
  hits = 0;
  misses = 0;
  failures = 0;
  /** Each live call's round trip, ms (the client's view: network and the endpoint's queue included). */
  readonly ms: number[] = [];

  constructor(
    private readonly opts: { url?: string; key?: string; cacheFile?: string; timeoutMs?: number; logFile?: string },
  ) {
    if (opts.cacheFile && existsSync(opts.cacheFile)) {
      for (const line of readFileSync(opts.cacheFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as { k: string; s: number[] };
        this.cache.set(r.k, r.s);
      }
    }
  }

  async score(input: LocalCheckInput, signal: AbortSignal): Promise<number[]> {
    const k = scoreKey(input);
    const kept = this.cache.get(k);
    if (kept) {
      this.hits++;
      this.log(input, kept);
      return kept;
    }
    if (!this.opts.url) {
      this.misses++;
      throw new Error("m1 scorer: not in the cache and no --checker-url");
    }
    this.calls++;
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(`${this.opts.url.replace(/\/$/, "")}/score`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.key ?? ""}` },
        body: JSON.stringify({
          request: input.request,
          today: input.today,
          items: input.items.map((it) => ({ title: it.title, text: it.text })),
        }),
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!res.ok) throw new Error(`m1 scorer: HTTP ${res.status}`);
      const body = (await res.json()) as { scores: number[] };
      this.ms.push(performance.now() - t0);
      this.cache.set(k, body.scores);
      this.log(input, body.scores);
      if (this.opts.cacheFile) appendFileSync(this.opts.cacheFile, `${JSON.stringify({ k, s: body.scores })}\n`);
      return body.scores;
    } catch (err) {
      this.failures++;
      throw err;
    }
  }

  /** `--checker-log F`: each check's request and its items' ids, titles and scores (sim data only). */
  private log(input: LocalCheckInput, scores: number[]): void {
    if (!this.opts.logFile) return;
    const items = input.items.map((it, i) => ({ id: it.id, title: it.title, s: scores[i] }));
    appendFileSync(this.opts.logFile, `${JSON.stringify({ request: input.request, today: input.today, items })}\n`);
  }

  summary(): string {
    const s = [...this.ms].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!) : 0);
    return (
      `m1 scorer: ${this.calls} live calls (p50 ${q(0.5)} ms, p90 ${q(0.9)} ms), ${this.hits} replayed, ` +
      `${this.misses} missed, ${this.failures} failed`
    );
  }
}

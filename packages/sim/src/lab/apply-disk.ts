/**
 * Applicability records (`readAtIngest`, D233, `applicability.ts`) from a disk cache (lab only), as `cards-disk.ts`
 * keeps cards: each record the model made for a simulated item is kept under `applyKey` (the prompt's version and the
 * item's content hash), so funnel and Pi reruns replay them at no cost. The worlds are generated, so nothing here is
 * user data; the engine itself never writes a record to disk (D8).
 *
 * An item the cache holds no record for is uncovered (null), as an item the background never reached would be, unless
 * a live maker is given: its records are appended to the file (or to `out`). An uncovered item is "ambiguous" to the
 * matcher, so a partial cache only sends more pools to the reader; it never decides one wrongly.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { applyKey, cardKey, type Applicability, type ApplyBatch, type ApplyMaker } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";

interface Line {
  k: string;
  a: Applicability | null;
}

const readText = (file: string) =>
  file.endsWith(".gz") ? gunzipSync(readFileSync(file)).toString("utf8") : readFileSync(file, "utf8");

export function loadApplies(...files: string[]): Map<string, Applicability | null> {
  const out = new Map<string, Applicability | null>();
  for (const file of files) {
    if (!file || !existsSync(file)) continue;
    for (const line of readText(file).split("\n")) {
      if (!line.trim()) continue;
      const l = JSON.parse(line) as Line;
      out.set(l.k, l.a);
    }
  }
  return out;
}

export class DiskApplyMaker implements ApplyMaker {
  readonly applies: Map<string, Applicability | null>;
  private readonly inflight = new Map<string, Promise<Applicability | null>>();
  hits = 0;
  misses = 0;
  sent = 0;
  costUsd = 0;
  private readonly out: string;

  /** `files`: replayed (the first is also where new records go unless `out` is given; `.gz` is read only). */
  constructor(
    files: string[],
    private readonly live?: ApplyMaker,
    out?: string,
    /** Content hashes (`cardKey`) a live call may make: others stay uncovered (a top-up limited to pooled items). */
    private readonly only?: ReadonlySet<string>,
  ) {
    this.applies = loadApplies(...files, ...(out ? [out] : []));
    this.out = out ?? files[0] ?? "";
    if (live && (!this.out || this.out.endsWith(".gz"))) throw new Error("--apply live needs a plain output file");
  }

  async make(items: ContextItem[], today: string, signal: AbortSignal): Promise<ApplyBatch> {
    const out: (Applicability | null)[] = items.map(() => null);
    const missing: number[] = [];
    const waiting: [number, Promise<Applicability | null>][] = [];
    const settle = new Map<string, (a: Applicability | null) => void>();
    items.forEach((it, i) => {
      const k = applyKey(it);
      const pending = this.inflight.get(k);
      if (this.applies.has(k)) {
        this.hits++;
        out[i] = this.applies.get(k) ?? null;
      } else if (pending) {
        this.hits++;
        waiting.push([i, pending]);
      } else {
        this.misses++;
        if (!this.live || (this.only && !this.only.has(cardKey(it)))) return;
        missing.push(i);
        const p = new Promise<Applicability | null>((done) => settle.set(k, done));
        this.inflight.set(k, p);
        waiting.push([i, p]);
      }
    });
    let costUsd = 0;
    if (this.live && missing.length > 0) {
      const made = new Map<string, Applicability>();
      try {
        const got = await this.live.make(
          missing.map((i) => items[i]!),
          today,
          signal,
        );
        costUsd = got.costUsd;
        this.sent += missing.length;
        this.costUsd += costUsd;
        missing.forEach((i, j) => {
          const a = got.applies[j];
          if (!a) return; // Unread: uncovered, asked again by a later run.
          const k = applyKey(items[i]!);
          made.set(k, a);
          this.applies.set(k, a);
          appendFileSync(this.out, `${JSON.stringify({ k, a } satisfies Line)}\n`);
        });
      } finally {
        for (const [k, done] of settle) {
          this.inflight.delete(k);
          done(made.get(k) ?? null);
        }
      }
    }
    for (const [i, p] of waiting) out[i] = await p;
    return { applies: out, costUsd };
  }
}

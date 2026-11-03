/**
 * Readers with no model for `bun run eval --reader stub|oracle`: the eval's own copy of the lab's semantics
 * (`packages/sim/src/lab/reader-stub.ts`; eval does not import the sim). They stand in for the model behind the real
 * `AskReader`, so the engine builds and gates the reader's pool exactly as it would with a model:
 *
 * - `StubReader` (`--reader stub`): counts the calls and says nothing binds. What it measures is the pool (was the
 *   expected item among what the reader would have read), not delivery: with a reader that never binds, the NEW
 *   family's delivery falls back toward its rule paths.
 * - `OracleReader` (`--reader oracle`): a ground-truth proxy. It flags as bearing exactly the items the current turn
 *   or ask expects (the harness sets `bearing` before each), and rejects every other item it is given. It reads the
 *   gold labels, so its scores are circular: they bound what a perfect reader could add over this pool, and are
 *   reported apart from the headline metrics, labelled as a proxy.
 */
import type { ReaderInput, ReaderMaker } from "@eden/engine";

/** What a reader with no model returns. */
type Verdict = Awaited<ReturnType<ReaderMaker["read"]>>;

export type ReaderKindOption = "stub" | "oracle";

export function parseReaderOption(value: string | undefined): ReaderKindOption {
  if (value === "stub" || value === "oracle") return value;
  throw new Error(`--reader ${value ?? ""}: expected stub or oracle (a live reader is not wired into the eval)`);
}

/** The reader with no model: counts the calls the engine makes and says nothing binds. */
export class StubReader implements ReaderMaker {
  calls = 0;
  async read(input: ReaderInput): Promise<Verdict> {
    this.calls++;
    return this.verdict(input);
  }
  protected verdict(_input: ReaderInput): Verdict {
    return { bears: [], rejected: [], costUsd: 0 };
  }
}

/** The ground-truth proxy: flags the ids in `bearing` (set by the harness per turn and per ask), rejects the rest. */
export class OracleReader extends StubReader {
  bearing: ReadonlySet<string> = new Set();
  protected override verdict(input: ReaderInput): Verdict {
    const bears: { i: number; kind: "blocks"; why: string }[] = [];
    const rejected: number[] = [];
    for (const [i, it] of input.items.entries()) {
      if (this.bearing.has(it.id)) bears.push({ i, kind: "blocks", why: "oracle proxy" });
      else rejected.push(i);
    }
    return { bears, rejected, costUsd: 0 };
  }
}

export function readerFor(kind: ReaderKindOption): StubReader {
  return kind === "oracle" ? new OracleReader() : new StubReader();
}

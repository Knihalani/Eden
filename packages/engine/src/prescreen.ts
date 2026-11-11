/**
 * The push check's pre-screen (`pushPrescreen`, M7, D930; docs/research/m7-prescreen.md): a no-model reading of the
 * check's own input that settles the clear pools before the paid call (`push-check.ts`). It answers like the check
 * (the pool's items that change the action; none: the push stays silent) or abstains, and an abstention is the call.
 *
 * What it reads is exactly what the check would be sent (the redacted request head, the day, the pool's items as
 * `readerItem` renders them) plus the push gate's constraint flags, so the lab records its training rows from the same
 * hook the product calls (`PrescreenInput`). It holds no user state: a pure function of its input and shared weights.
 */
import type { ReaderItem } from "./reader";

/** What the pre-screen reads: the check's input as it would be sent, and the gate's per-item constraint test. */
export interface PrescreenInput {
  request: string;
  today: string;
  items: readonly ReaderItem[];
  /** Per item, the push gate's constraint test (`constraintLike`, after any tag veto). */
  like: readonly boolean[];
}

/** A settled pool: the ids the check would name (empty: silent). */
export interface PrescreenVerdict {
  yes: readonly string[];
}

/** A pre-screen: settles a pool (`PrescreenVerdict`) or abstains (null), and never throws into the push. */
export interface PushPrescreen {
  decide(input: PrescreenInput): PrescreenVerdict | null;
}

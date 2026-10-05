/**
 * The silence set (A5 §2 `silence` (c), §3.7; D17, D35): prompts that need no memory, as cues to ask through the
 * hooks. Three sources, reported apart, as A5 §4 reports R8's negatives apart from R1's:
 * - `r1`: R1's 150 negatives (chat, math, off-topic, hard lexical traps), from the CueBench fixture;
 * - `r8`: R8's 98 vocabulary-rich `nim-neg` negatives, harder than R1's;
 * - `real`: the user's frozen real-negative set (EXECUTION §8), named by `EDEN_EVAL_NEGATIVES` and checked against
 *   its `.sha256` by the product's reader. It is a holdout (X5): its text never leaves the replay, and reports
 *   carry aggregates and the ids of false fires only. CI has no such file.
 */
import { readFrozenNegatives } from "../../../packages/cli/src/eval-negatives";
import { isNegative, nimCues, r1Cues, type BenchCue } from "./cuebench";

export type SilenceSource = "r1" | "r8" | "real";

export interface NegativeSet {
  source: SilenceSource;
  cues: BenchCue[];
}

/** What a run without the private set says in its place (EXECUTION §8). */
export const PRIVATE_SET_ABSENT = "skipped: private set absent";

export type RealNegatives = { status: "absent" } | { status: "loaded"; path: string; sha256: string; set: NegativeSet };

export function fixtureNegatives(): NegativeSet[] {
  return [
    { source: "r1", cues: r1Cues().filter(isNegative) },
    { source: "r8", cues: nimCues().filter((cue) => cue.cat === "nim-neg") },
  ];
}

/** The frozen set `EDEN_EVAL_NEGATIVES` names; throws when its bytes do not match its sha256. */
export function realNegatives(env: Record<string, string | undefined> = process.env): RealNegatives {
  const path = env.EDEN_EVAL_NEGATIVES;
  if (!path) return { status: "absent" };
  const { sha256, negatives } = readFrozenNegatives(path);
  const cues = negatives.map((row) => askable(row.id, "neg-real", row.text));
  return { status: "loaded", path, sha256, set: { source: "real", cues } };
}

/** A prompt to ask as the first turn of a fresh session: no previous turn, no paths, no gold. */
export function askable(id: string, cat: string, text: string, scope = ""): BenchCue {
  return { id, cat, scope, gold: [], cue: text, last_paths: [], prev_turn: "", split: cat };
}

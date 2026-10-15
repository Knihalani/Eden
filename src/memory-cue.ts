/**
 * The situation cue (A7 §3, D16). Red-first stub (P4.1): the signatures the tests drive, with no situation read yet.
 */
import type { CueParts } from "./memory-gate";
import type { TurnMode } from "./memory-turn";

export type CuePart = "prompt" | "turn" | "path" | "prev";
export type CueWeights = Readonly<Record<CuePart, number>>;

const DEFAULT_WEIGHTS: CueWeights = { prompt: 0.55, turn: 0.15, path: 0.15, prev: 0.15 };

export function weightsFor(_mode: TurnMode): CueWeights {
  return DEFAULT_WEIGHTS;
}

export function cueTokens(text: string): Set<string> {
  return new Set(String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

export function singular(word: string): string {
  return word;
}

export function pathCue(_paths: readonly string[], _top?: string): string {
  return "";
}

export interface Situation {
  turn?: string;
  path?: string;
  prev?: string;
  delivered?: readonly string[];
}

export interface SituationCue {
  mode: TurnMode;
  weights: CueWeights;
  parts: Readonly<Record<"turn" | "path" | "prev", ReadonlySet<string>>>;
  strong: ReadonlySet<string>;
  proposal: string;
}

export function situationCue(_situation: Situation, mode: TurnMode): SituationCue {
  return { mode, weights: DEFAULT_WEIGHTS, parts: { turn: new Set(), path: new Set(), prev: new Set() }, strong: new Set(), proposal: "" };
}

export function gateParts(prompt: string, turn: string, _cue: SituationCue): CueParts {
  return { prompt, turn };
}

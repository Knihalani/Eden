import type { StretchProgram } from "@eden/ir";
import type { WrapState } from "./wrap-tools";

export type SpeculateHint = {
  input?: Record<string, unknown>;
  program?: StretchProgram | string;
  lastTool?: string;
  lastArgs?: Record<string, unknown>;
};

export type SpeculateHandle = {
  programId: string;
};

export type SpeculateTake = { hit: true; value: unknown } | { hit: false };

type SpeculateRunner = {
  live: () => StretchProgram[];
  run: (program: StretchProgram, input: Record<string, unknown>) => Promise<unknown>;
};

export function speculateEnabled(): boolean {
  return false;
}

export function bindSpeculateRunner(_state: WrapState, _runner: SpeculateRunner): void {}

export function discardSpeculation(_state: WrapState): void {}

export function markStretchServed(
  _state: WrapState,
  _program: StretchProgram,
  _input: Record<string, unknown>,
): void {}

export function turnBoundary(_state: WrapState, _hint: SpeculateHint = {}): SpeculateHandle | null {
  return null;
}

export async function takeSpeculation(
  _state: WrapState,
  _program: StretchProgram,
  _input: Record<string, unknown>,
): Promise<SpeculateTake> {
  return { hit: false };
}

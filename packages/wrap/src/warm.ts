import type { StretchProgram } from "@eden/ir";
import type { WrapState } from "./wrap-tools";

export type WarmHint = {
  input?: Record<string, unknown>;
  program?: StretchProgram | string;
};

export type WarmHandle = {
  programId: string;
  tools: string[];
};

export type WarmTake = { hit: true; value: unknown } | { hit: false };

export type WarmRunner = {
  live: () => StretchProgram[];
  execute: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
};

export function watchWarmEnabled(): boolean {
  return false;
}

export function bindWarmRunner(_state: WrapState, _runner: WarmRunner): void {}

export function firstWaveReads(
  _program: StretchProgram,
  _input: Record<string, unknown>,
): Array<{ tool: string; args: Record<string, unknown> }> {
  return [];
}

export function claimWarm(_state: WrapState, _program: StretchProgram, _input: Record<string, unknown>): void {}

export function discardWarm(_state: WrapState): void {}

export async function takeWarm(
  _state: WrapState,
  _program: StretchProgram,
  _tool: string,
  _args: Record<string, unknown>,
): Promise<WarmTake> {
  return { hit: false };
}

export function watchWarm(
  _state: WrapState,
  _current: StretchProgram,
  _hint: WarmHint = {},
): WarmHandle | null {
  return null;
}

/** The PreToolUse policy guard's answer (D19, A4 §5.4, A6 §2.5, A7 §5). Red first: a stub that finds nothing. */
export interface GuardCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface GuardAnswer {
  cls: string;
  rules: string[];
  due: boolean;
  ask: boolean;
  bypassed: boolean;
  reason: string;
  context: string;
}

export function subcommandsOf(_command: string): string[] {
  return [];
}

export function callClasses(_call: GuardCall): string[] {
  return [];
}

export function guardAnswer(_store: string, _call: GuardCall, _mode: string, _now?: number): GuardAnswer | undefined {
  return undefined;
}

export function intentsDoneBy(_store: string, _call: GuardCall, _now?: number): string[] {
  return [];
}

export function intentsReleasedBy(_store: string, _prompt: string, _now?: number): string[] {
  return [];
}

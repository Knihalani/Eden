/** The PreToolUse policy guard's hook (D19, A4 §5.4). Red first: a stub that answers nothing. */
export function guardHookResponse(
  _raw: Record<string, unknown>,
  _cls: string | undefined,
): Record<string, unknown> | null {
  return null;
}

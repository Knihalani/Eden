/**
 * Dismiss permanently deletes a candidate, so it is a two-step control:
 * "Dismiss" arms into "Confirm dismiss" for DISMISS_CONFIRM_MS, then reverts.
 * Kept pure so the arm window and labels are testable without a renderer.
 */
export const DISMISS_CONFIRM_MS = 4000;

export function confirmExpired(armedAt: number, now: number): boolean {
  return now - armedAt >= DISMISS_CONFIRM_MS;
}

export function dismissButtonLabel(confirming: boolean): string {
  return confirming ? "Confirm dismiss" : "Dismiss";
}

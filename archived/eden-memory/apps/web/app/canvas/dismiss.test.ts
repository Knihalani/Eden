import { describe, expect, test } from "bun:test";
import { DISMISS_CONFIRM_MS, confirmExpired, dismissButtonLabel } from "./dismiss";

describe("dismiss two-step confirm", () => {
  test("confirm window is four seconds", () => {
    expect(DISMISS_CONFIRM_MS).toBe(4000);
  });

  test("the armed button reverts after the window elapses", () => {
    const armedAt = 1000;
    expect(confirmExpired(armedAt, armedAt)).toBe(false);
    expect(confirmExpired(armedAt, armedAt + DISMISS_CONFIRM_MS - 1)).toBe(false);
    expect(confirmExpired(armedAt, armedAt + DISMISS_CONFIRM_MS)).toBe(true);
  });

  test("labels name the destructive step before delete fires", () => {
    expect(dismissButtonLabel(false)).toBe("Dismiss");
    expect(dismissButtonLabel(true)).toBe("Confirm dismiss");
  });
});

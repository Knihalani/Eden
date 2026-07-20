import { describe, expect, it } from "vitest";
import { toUserFacingError } from "@/lib/safe-error-message";
import { REPO_NOT_CONNECTED_MESSAGE } from "@/lib/improve-feature";

describe("toUserFacingError", () => {
  it("does not map generic 422 to GitHub reconnect copy", () => {
    const msg = toUserFacingError({
      status: 422,
      message: "Validation error",
    });
    expect(msg).toBe("Invalid request — check the form and try again.");
    expect(msg.toLowerCase()).not.toContain("github");
  });

  it("still maps GitHub-flavoured 422 to reconnect copy", () => {
    const msg = toUserFacingError({
      status: 422,
      message: "Connect GitHub App to continue",
    });
    expect(msg).toContain("GitHub");
  });

  it("maps repo_not_connected detail regardless of status", () => {
    expect(
      toUserFacingError({ status: 503, message: "repo_not_connected" }),
    ).toBe(REPO_NOT_CONNECTED_MESSAGE);
  });

  it("maps 5xx to the server unreachable banner", () => {
    expect(toUserFacingError({ status: 500, message: "boom" })).toBe(
      "Eden is having trouble reaching the server. Please try again in a moment.",
    );
  });
});

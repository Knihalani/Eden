import { describe, expect, it } from "vitest";
import { toUserFacingError } from "@/lib/safe-error-message";
import { REPO_NOT_CONNECTED_MESSAGE } from "@/lib/improve-feature";

describe("toUserFacingError", () => {
  it("does not map generic 422 to GitHub reconnect copy", () => {
    const msg = toUserFacingError({
      status: 422,
      message: "Validation error",
    });
    expect(msg.toLowerCase()).not.toContain("github");
    expect(msg).toMatch(/^Invalid request/);
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

  it("summarizes FastAPI validation detail arrays on 422", () => {
    const msg = toUserFacingError({
      status: 422,
      message: JSON.stringify([
        {
          type: "missing",
          loc: ["body", "scopes"],
          msg: "Field required",
        },
      ]),
    });
    expect(msg).toBe("Invalid request — scopes: Field required");
  });

  it("passes through short plain-string 422 details", () => {
    const msg = toUserFacingError({
      status: 422,
      message: "Invalid JSON body: Expecting value",
    });
    expect(msg).toBe("Invalid request — Invalid JSON body: Expecting value");
  });
});

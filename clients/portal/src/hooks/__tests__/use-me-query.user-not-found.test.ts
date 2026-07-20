/**
 * Wave 4 — /auth/me 404 sanitize race: retries must key off status +
 * raw ApiError.detail, not the sanitized Error.message.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/core";
import { isUserNotFoundRace } from "@/hooks/use-me-query";

describe("isUserNotFoundRace", () => {
  it("matches 404 + raw User not found detail even when message is sanitized", () => {
    const err = new ApiError(
      404,
      "We couldn't find what you're looking for.",
      "User not found",
    );
    expect(err.message).toBe("We couldn't find what you're looking for.");
    expect(err.detail).toBe("User not found");
    expect(isUserNotFoundRace(err)).toBe(true);
  });

  it("rejects other 404s and non-404 auth failures", () => {
    expect(
      isUserNotFoundRace(
        new ApiError(404, "We couldn't find what you're looking for.", "Not Found"),
      ),
    ).toBe(false);
    expect(
      isUserNotFoundRace(new ApiError(401, "Session expired. Please sign in again.", "Unauthorized")),
    ).toBe(false);
    expect(isUserNotFoundRace(new Error("User not found"))).toBe(false);
  });
});

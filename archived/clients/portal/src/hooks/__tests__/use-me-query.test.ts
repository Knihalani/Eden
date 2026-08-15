// @vitest-environment jsdom
/**
 * Regression tests for F41-3 (retry-layer de-duplication), the
 * ``useMeQuery`` slice: this hook used to add its own React-Query
 * -level retry on top of ``fetchApi``'s one-shot Clerk-token-
 * refresh-then-retry for 401s (core.ts), so a persistent 401 could
 * fire up to 2 fetchApi attempts × up to 3 RQ attempts = 6 physical
 * requests instead of 2. ``fetchApi`` now exclusively owns 401
 * transport retry; ``useMeQuery`` keeps only the auto-provision
 * "user not found" 404 business-level retry, which fetchApi has no
 * opinion on.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/core";
import { meQueryRetry } from "../use-me-query";

describe("meQueryRetry (F41-3)", () => {
  it("never retries a persistent 401 — fetchApi already owns 401 transport retry", () => {
    const err = new ApiError(401, "Unauthorized", "Unauthorized");
    expect(meQueryRetry(0, err)).toBe(false);
    expect(meQueryRetry(1, err)).toBe(false);
  });

  it("does not retry generic 5xx errors — fetchApi already owns 5xx backoff", () => {
    const err = new ApiError(503, "Service unavailable", "Service unavailable");
    expect(meQueryRetry(0, err)).toBe(false);
  });

  it("retries the auto-provision 'user not found' 404 race up to the failure-count cap", () => {
    const err = new ApiError(404, "Not found", "User not found");
    expect(meQueryRetry(0, err)).toBe(true);
    expect(meQueryRetry(1, err)).toBe(true);
    // Capped at 2 attempts regardless of error kind.
    expect(meQueryRetry(2, err)).toBe(false);
  });

  it("does not retry an ordinary 404 that isn't the user-not-found race", () => {
    const err = new ApiError(404, "Not found", "Org not found");
    expect(meQueryRetry(0, err)).toBe(false);
  });

  it("does not retry non-ApiError failures (e.g. network/parse errors)", () => {
    expect(meQueryRetry(0, new Error("boom"))).toBe(false);
  });
});

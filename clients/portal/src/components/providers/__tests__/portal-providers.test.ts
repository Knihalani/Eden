// @vitest-environment jsdom
/**
 * Regression test for F41-3 (retry-layer de-duplication), the
 * QueryClient-default slice: this default used to retry once more
 * on ANY non-4xx failure — duplicating ``fetchApi``'s own internal
 * 5xx/429 backoff (core.ts) for every one of the ~58
 * ``useApiQuery``/``useOrgQuery`` call sites in the app that don't
 * specify their own ``retry``. ``fetchApi`` now exclusively owns
 * transport-level retry; the QueryClient default must not retry at
 * all (individual hooks, e.g. ``useMeQuery``, can still opt into
 * their own business-level retry via a per-query ``retry`` option,
 * which overrides this default).
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/core";
import { makeQueryClient } from "../portal-providers";

describe("makeQueryClient default retry (F41-3)", () => {
  it("does not retry a 5xx failure by default", () => {
    const client = makeQueryClient();
    const { retry } = client.getDefaultOptions().queries ?? {};
    expect(typeof retry === "function" ? retry(0, new ApiError(503, "x", "x")) : retry).toBe(
      false,
    );
  });

  it("does not retry a 4xx failure by default", () => {
    const client = makeQueryClient();
    const { retry } = client.getDefaultOptions().queries ?? {};
    expect(typeof retry === "function" ? retry(0, new ApiError(404, "x", "x")) : retry).toBe(
      false,
    );
  });

  it("mutations never retry by default", () => {
    const client = makeQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(0);
  });
});
